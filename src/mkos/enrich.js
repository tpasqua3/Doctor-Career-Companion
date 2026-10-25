// DYNAMIC LESSON ENRICHMENT (lifecycle stage 6; mkos/ontology/lifecycle.json "enrichment"). Never rebuild a lesson unnecessarily:
// when new knowledge reaches an existing lesson, what is new is attached to it as enhancements (a recommendation, the evidence and
// trial lineage behind it, the citation of a guideline family it did not have, a validated clinical pearl), recorded once each in
// mk_enhancements (durable: mirrored and restored), and the lesson gets a new minor version (v1.4.0 + additions = v1.5.0) whose
// content row in mk_asset_store carries the enhancements, so the version history is preserved. The asset's basis fingerprint
// (assets.js basisNow) is never touched; an `enrichment` summary on the asset lets judge() count what was absorbed. Rules only.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObject, getObjects, putObject } from './kb.js';

const E = FRAMEWORK.frameworks.lifecycle.enrichment;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const SET = '(SELECT value FROM json_each(?1))';

/* What is new for a lesson since it was written (not yet in its basis or its enhancements). Pure over the rows the queries found. */
export function newAdditions(asset, { recs = [], evidence = [], pearls = [], sources = {}, have = new Set() } = {}) {
  const b = asset.basis || {}, fams = new Set([...Object.keys(b.families || {}), ...((asset.enrichment || {}).families || [])]), out = [];
  const add = (x) => { if (!have.has(x.object_id) && !out.some((y) => y.object_id === x.object_id)) out.push(x); };
  for (const r of recs) {
    if ((b.recs || {})[r.id]) continue;
    const s = sources[r.source_id] || {};
    add({ object_id: r.id, kind: 'recommendation', payload: { text: clip(r.statement || r.name, 600), strength: r.strength || null, evidence_level: r.evidence_level || null, grading: [r.strength_original, r.loe_original].filter(Boolean).join(', ') || null,
      source_id: r.source_id || null, source: s.title ? clip(s.short_label || s.title, 160) : null, organization: (s.responsible_orgs || []).slice(0, 3), year: s.year || null } });
    if (s.guideline_family && !fams.has(s.guideline_family)) { fams.add(s.guideline_family);
      add({ object_id: s.guideline_family, kind: 'citation', payload: { family: s.guideline_family, edition: s.id, title: clip(s.short_label || s.title, 200), organization: (s.responsible_orgs || []).slice(0, 3), year: s.year || null } }); }
  }
  for (const v of evidence) add({ object_id: v.id, kind: v.acronym ? 'trial_lineage' : 'evidence', payload: { text: clip(v.name, 200), acronym: v.acronym || null, design: v.design || null, evidence_kind: v.evidence_kind || null } });
  for (const p of pearls) add({ object_id: p.id, kind: 'pearl', payload: { text: clip(p.statement || p.name, 500) } });
  return out.slice(0, Number(E.max_additions_per_lesson) || 12);
}

/* Enrich one stored lesson. Returns { added, version } (added 0 when nothing new). */
export async function enrichLesson(env, assetId, { subject = null, score = null } = {}) {
  const o = await getObject(env, assetId);
  if (!o || o.type !== 'EducationalAsset' || o.status !== 'current' || !/^ea\.s\./.test(o.id) || (o.asset_kind && !/lesson/.test(o.asset_kind))) return { added: 0 };
  const concepts = (o.teaches || []).slice(0, 20); if (!concepts.length) return { added: 0 };
  const since = (o.generation && o.generation.generated_at) || o.created || '';
  const cj = JSON.stringify(concepts);
  const recIds = (await env.DB.prepare(`SELECT DISTINCT e.dst AS id FROM mk_edges e JOIN mk_objects r ON r.id = e.dst WHERE e.rel = 'recommended_by' AND e.status = 'current' AND e.src IN ${SET}
    AND r.status IN ('current','modified') AND r.created > ?2 ORDER BY r.trust DESC LIMIT 40`).bind(cj, since).all()).results.map((r) => r.id);
  const evIds = (await env.DB.prepare(`SELECT DISTINCT e.dst AS id FROM mk_edges e JOIN mk_objects v ON v.id = e.dst WHERE e.rel = 'supported_by' AND e.status = 'current' AND e.src IN ${SET}
    AND v.status = 'current' AND v.created > ?2 LIMIT 20`).bind(cj, since).all()).results.map((r) => r.id);
  const peIds = (await env.DB.prepare(`SELECT DISTINCT e.src AS id FROM mk_edges e JOIN mk_objects p ON p.id = e.src WHERE e.src LIKE 'eo.pe.%' AND e.status = 'current' AND e.dst IN ${SET}
    AND p.status = 'current' AND p.gov = 'validated' AND p.created > ?2 LIMIT 10`).bind(cj, since).all()).results.map((r) => r.id);
  if (!recIds.length && !evIds.length && !peIds.length) return { added: 0 };
  const objs = await getObjects(env, [...recIds, ...evIds, ...peIds]);
  const recs = recIds.map((i) => objs[i]).filter(Boolean), sources = await getObjects(env, [...new Set(recs.map((r) => r.source_id).filter(Boolean))]);
  const have = new Set((await env.DB.prepare('SELECT object_id FROM mk_enhancements WHERE asset_id = ?').bind(o.id).all()).results.map((r) => r.object_id));
  const add = newAdditions(o, { recs, evidence: evIds.map((i) => objs[i]).filter(Boolean), pearls: peIds.map((i) => objs[i]).filter(Boolean), sources, have });
  if (!add.length) return { added: 0 };
  const at = nowIso(), prevV = o.version, en = o.enrichment || {};
  const enrichment = { n: (en.n || 0) + add.length, recs: (en.recs || 0) + add.filter((x) => x.kind === 'recommendation').length,
    families: [...new Set([...(en.families || []), ...add.filter((x) => x.kind === 'citation').map((x) => x.object_id)])], last: at, last_subject: subject || null,
    by_kind: { ...(en.by_kind || {}) } };
  for (const x of add) enrichment.by_kind[x.kind] = (enrichment.by_kind[x.kind] || 0) + 1;
  const kinds = [...new Set(add.map((x) => E.kinds[x.kind] || x.kind))].join(', ');
  // A new minor version: the basis (currency fingerprint) is kept exactly as it was.
  const r = await putObject(env, { ...o, enrichment }, { actor: 'enrichment', part: E.version_part || 'minor', summary: `enhanced v${prevV}: +${add.length} (${kinds})`, audited: true });
  const st = add.map((x) => env.DB.prepare('INSERT OR IGNORE INTO mk_enhancements (asset_id, object_id, kind, asset_version, payload_json, score, at) VALUES (?,?,?,?,?,?,?)')
    .bind(o.id, x.object_id, x.kind, r.version, JSON.stringify(x.payload), score == null ? 0 : Number(score), at));
  await env.DB.batch(st);
  // The version's content row: the lesson as written plus every enhancement so far (the app shows them with the lesson).
  const last = await env.DB.prepare('SELECT content FROM mk_asset_store WHERE asset_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(o.id).first();
  const content = J(last && last.content, null);
  if (content) {
    const all = await enhancementsOf(env, o.id);
    const text = JSON.stringify({ ...content, enhancements: all.map((x) => ({ kind: x.kind, id: x.object_id, version: x.asset_version, ...x.payload })) });
    await env.DB.prepare('INSERT OR REPLACE INTO mk_asset_store (asset_id, version, content, bytes, at) VALUES (?, ?, ?, ?, ?)').bind(o.id, r.version, text, text.length, at).run();
  }
  return { added: add.length, version: r.version, from: prevV, kinds: add.map((x) => x.kind) };
}

export async function enhancementsOf(env, assetId) {
  return (await env.DB.prepare('SELECT object_id, kind, asset_version, payload_json, score, at FROM mk_enhancements WHERE asset_id = ? ORDER BY at, object_id').bind(assetId).all()).results
    .map((r) => ({ object_id: r.object_id, kind: r.kind, asset_version: r.asset_version, payload: J(r.payload_json, {}), score: r.score, at: r.at }));
}

/* Enrich the lessons a subject penetrates at min_penetration or more (from mk_penetration), at most max_lessons_per_subject, resumable
   by `prog.done` (ids already handled). Never regenerates anything. */
export async function enrichFromPenetration(env, subject, { prog = {}, room = () => true } = {}) {
  const min = Number(E.min_penetration) || 0.7, cap = Number(E.max_lessons_per_subject) || 40;
  const lessons = (await env.DB.prepare("SELECT target_id, score FROM mk_penetration WHERE subject_id = ? AND target_kind = 'lesson' AND score >= ? ORDER BY score DESC LIMIT ?").bind(subject, min - 1e-9, cap).all()).results;
  const done = new Set(prog.done || []); let added = 0, enriched = 0, finished = true;
  for (const l of lessons) {
    if (done.has(l.target_id)) continue;
    if (!room()) { finished = false; break; }
    const r = await enrichLesson(env, l.target_id, { subject, score: l.score });
    if (r.added) { added += r.added; enriched++; }
    done.add(l.target_id);
  }
  prog.done = [...done];
  return { lessons: lessons.length, enriched, added, finished };
}
