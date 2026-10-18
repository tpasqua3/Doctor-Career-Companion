// Governance Layer: validation and approval records, stop-the-line checks, integrity (knowledge graph validation) and status.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, audit } from './db.js';
import { getObject, putObject, counts } from './kb.js';
import { RELS, edgeCounts } from './graph.js';

const STOP = Object.fromEntries(FRAMEWORK.frameworks.ontology.stop_the_line_conditions.map((s) => [s.key, s.name]));

// STOP-THE-LINE checks for one object. Returns a list of {condition, detail}.
export async function stopChecks(env, o) {
  const out = [];
  if (!o.provenance || !o.provenance.length) out.push({ condition: 'missing_provenance' });
  if (o.type === 'Recommendation') {
    const src = o.source_id ? await getObject(env, o.source_id) : null;
    if (!src) out.push({ condition: 'missing_provenance', detail: 'source ' + o.source_id + ' not found' });
    else {
      if (!src.citation && !src.doi && !src.title) out.push({ condition: 'missing_citation' });
      if (src.status === 'superseded' && o.status === 'current') out.push({ condition: 'superseded_guideline_usage', detail: src.id + ' is superseded by ' + src.replaced_by });
    }
    if (!o.strength || !o.evidence_level) out.push({ condition: 'invalid_recommendation' });
    if (!o.loe_original && o.evidence_level !== 'C-EO') out.push({ condition: 'missing_evidence', detail: 'level normalized without a stated grade' });
  }
  if (o.type === 'EducationalAsset' && (o.needs || []).includes('regenerate')) out.push({ condition: 'superseded_guideline_usage', detail: 'cites superseded knowledge' });
  return out.map((x) => ({ ...x, name: STOP[x.condition] }));
}

/* Record a review (validation or approval) and move governance status. result: 'validated' | 'approved' | 'rejected'. */
export async function review(env, id, result, { actor, note = '' } = {}) {
  const o = await getObject(env, id); if (!o) return { ok: false, error: 'not found' };
  if (!['validated', 'approved', 'rejected'].includes(result)) return { ok: false, error: 'bad result' };
  const stops = result === 'rejected' ? [] : await stopChecks(env, o);
  if (stops.length) return { ok: false, error: 'stop-the-line', stops };
  await env.DB.prepare('INSERT OR REPLACE INTO mk_reviews (object_id, version, kind, result, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, o.version, result === 'approved' ? 'approval' : 'validation', result, actor, note.slice(0, 2000), nowIso()).run();
  const r = await putObject(env, { ...o, governance_status: result }, { actor, summary: `${result}${note ? ': ' + note.slice(0, 120) : ''}`, part: 'minor' });
  return { ok: true, ...r };
}

// KNOWLEDGE GRAPH VALIDATION: dangling edges, undeclared relationships, supersession cycles, orphans, unprovenanced objects.
export async function graphValidation(env, { sample = 20 } = {}) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const declared = Object.keys(RELS);
  const undeclared = await q(`SELECT rel, COUNT(*) AS n FROM mk_edges WHERE rel NOT IN (${declared.map(() => '?').join(',')}) GROUP BY rel`, ...declared);
  const danglingSrc = await q("SELECT e.src, e.rel, e.dst FROM mk_edges e LEFT JOIN mk_objects o ON o.id = e.src WHERE o.id IS NULL LIMIT ?", sample);
  const danglingDst = await q("SELECT e.src, e.rel, e.dst FROM mk_edges e LEFT JOIN mk_objects o ON o.id = e.dst WHERE o.id IS NULL LIMIT ?", sample);
  const nDangling = (await q("SELECT (SELECT COUNT(*) FROM mk_edges e LEFT JOIN mk_objects o ON o.id = e.src WHERE o.id IS NULL) + (SELECT COUNT(*) FROM mk_edges e LEFT JOIN mk_objects o ON o.id = e.dst WHERE o.id IS NULL) AS n"))[0].n;
  const recNoSource = await q("SELECT r.id FROM mk_objects r WHERE r.type = 'Recommendation' AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = r.id AND e.rel = 'derived_from') LIMIT ?", sample);
  const topicNoConcept = await q("SELECT t.id FROM mk_objects t WHERE t.type = 'BlueprintTopic' AND t.status = 'current' AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.dst = t.id AND e.rel = 'mapped_to_blueprint') LIMIT ?", sample);
  const noProv = await q("SELECT id FROM mk_objects WHERE json_array_length(json_extract(body, '$.provenance')) = 0 OR json_extract(body, '$.provenance') IS NULL LIMIT ?", sample);
  const badStatus = await q("SELECT id, status, json_extract(body, '$.replaced_by') AS rb FROM mk_objects WHERE (status = 'current' AND json_extract(body, '$.replaced_by') IS NOT NULL AND json_extract(body, '$.replaced_by') != '') OR (status = 'superseded' AND (json_extract(body, '$.replaced_by') IS NULL OR json_extract(body, '$.replaced_by') = '') AND type != 'Recommendation') LIMIT ?", sample);
  // Supersession cycles: follow replaced_by from every superseded object.
  const chain = await q("SELECT id, json_extract(body, '$.replaced_by') AS rb FROM mk_objects WHERE json_extract(body, '$.replaced_by') IS NOT NULL AND json_extract(body, '$.replaced_by') != ''");
  const next = Object.fromEntries(chain.map((r) => [r.id, r.rb])), cycles = [];
  for (const start of Object.keys(next)) { const seen = new Set([start]); let cur = next[start]; for (let i = 0; i < 50 && cur; i++) { if (seen.has(cur)) { cycles.push(start); break; } seen.add(cur); cur = next[cur]; } }
  const checks = {
    undeclared_relationships: { pass: !undeclared.length, detail: undeclared },
    dangling_edges: { pass: nDangling === 0, count: nDangling, sample: [...danglingSrc, ...danglingDst].slice(0, sample) },
    recommendations_without_source: { pass: !recNoSource.length, sample: recNoSource },
    blueprint_topics_without_concept: { pass: !topicNoConcept.length, sample: topicNoConcept },
    objects_without_provenance: { pass: !noProv.length, sample: noProv },
    status_replaced_by_consistency: { pass: !badStatus.length, sample: badStatus },
    supersession_cycles: { pass: !cycles.length, sample: cycles.slice(0, sample) },
  };
  return { pass: Object.values(checks).every((c) => c.pass), checks, edges: await edgeCounts(env) };
}

export async function status(env) {
  const q = async (sql) => (await env.DB.prepare(sql).all()).results;
  return {
    objects: await counts(env),
    files: await q('SELECT state, COUNT(*) AS n FROM mk_files GROUP BY state'),
    ingest: await q("SELECT json_extract(body, '$.ingest_state') AS state, json_extract(body, '$.source_class') AS class, COUNT(*) AS n FROM mk_objects WHERE type = 'Source' GROUP BY state, class"),
    jobs: await q('SELECT kind, state, COUNT(*) AS n FROM mk_jobs GROUP BY kind, state'),
    events: await q('SELECT kind, stage, COUNT(*) AS n FROM mk_events GROUP BY kind, stage'),
    edges: (await q('SELECT COUNT(*) AS n FROM mk_edges'))[0].n,
    settings: Object.fromEntries((await q("SELECT k, v FROM mk_settings WHERE k IN ('framework_hash','scan_last_complete','ai_budget','tick','cutover','legacy_registry_check')")).map((r) => [r.k, J(r.v, r.v)])),
  };
}
