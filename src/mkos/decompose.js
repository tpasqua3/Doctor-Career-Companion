// GUIDELINE KNOWLEDGE DECOMPOSITION (mkos/ontology/decomposition.json). Every recommendation is decomposed, by rules, into:
//   Claims        eligibility, contraindication, not_recommended, exception, monitoring and threshold criteria
//   Objectives    a learning and an assessment objective, with difficulty, competencies and subcompetencies, blueprint topics
//   Teaching      a teaching point carrying its educational targets (question, flashcard, case, review), plus high-yield and
//                 common-error objects where the class of recommendation calls for them
// and, per concept, lesson and review targets; per guideline section, a clinical pathway; per concept, clinical pearls by the free AI
// (pending validation). DELTA PROCESSING: each recommendation records the fingerprint it was decomposed at, so only new or changed
// recommendations are reprocessed, and objects a changed recommendation no longer yields are retired, never left behind.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObject, getObjects, putObject, slug } from './kb.js';
import { addEdges } from './graph.js';
import { aiBudgetLeft } from './extract.js';
import { boardRelevance, recDifficulty, classifyBatch } from './classify.js';

const F = FRAMEWORK.frameworks, D = F.decomposition.decomposition, DV = Number(F.decomposition.version.split('.')[0]) * 100 + Number(F.decomposition.version.split('.')[1]);
const AGAINST = new Set(['against_strong', 'against_moderate']);
const keyOf = (rec) => rec.id.slice(4).replace(/[^a-z0-9]/gi, '_').slice(0, 60);
const clip = (s, n = 600) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Criteria in a recommendation statement, by rules (no AI).
const THRESH = /(?:[<>≤≥]\s*=?|less than|greater than|more than|at least|above|below|under|over)\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+)?\s*(?:mm\s?hg|mg\/dl|mmol\/l|%|ml\/min(?:\/1\.73\s?m(?:2|²))?|kg\/m(?:2|²)|years?|mg|mcg|ng\/ml|g\/dl|meq\/l|bpm|units?|weeks?|months?)?/gi;
const MONITOR = /\b(monitor(?:ing|ed)?|reassess(?:ment|ed)?|re-?evaluat\w*|follow[- ]up|recheck\w*|surveillance|repeat(?:ed)? (?:testing|measurement|imaging|assessment)|(?:every|each) \d+(?:\s*(?:to|-)\s*\d+)?\s*(?:days?|weeks?|months?|years?)|annual(?:ly)?|periodic(?:ally)?)\b/i;
const EXCEPT = /\b(unless|except(?:\s+(?:for|in|when|if))?|excluding|other than|with the exception of)\b\s*([^.;]{5,220})/i;
const CONTRA = /\b(contraindicated|should not be (?:used|given|prescribed|administered|performed|started|initiated)|must not|is harmful|potentially harmful|avoid(?:ed|ance)?)\b/i;
const NOTREC = /\b(not recommended|no benefit|is not useful|not indicated|should not be routinely|is not effective)\b/i;
export function parseCriteria(rec) {
  const s = clip(rec.statement, 2000), out = [];
  const pop = rec.population || ((/^(?:in|for|among)\s+([^,]{6,220}),/i.exec(s) || [])[1] || '');
  if (pop) out.push({ kind: 'eligibility', text: clip(pop, 300) });
  const harm = rec.strength === 'against_strong' || /harm/i.test(rec.strength_original || '');
  if (harm || CONTRA.test(s)) out.push({ kind: 'contraindication', text: s });
  else if (rec.strength === 'against_moderate' || NOTREC.test(s)) out.push({ kind: 'not_recommended', text: s });
  const ex = EXCEPT.exec(s); if (ex) out.push({ kind: 'exception', text: clip(ex[1] + ' ' + ex[2], 300) });
  if (MONITOR.test(s)) out.push({ kind: 'monitoring', text: s });
  const th = [...new Set((s.match(THRESH) || []).map((x) => x.trim()))].slice(0, 8);
  if (th.length) out.push({ kind: 'threshold', text: s, values: th });
  return out;
}

const DIAG = /\b(screen\w*|test\w*|measur\w*|evaluat\w*|diagnos\w*|assess\w*|imaging|biopsy|echocardiogra\w*|electrocardiogra\w*|ecg|ekg|laborator\w*|level|monitor\w*)\b/i;
const MGMT = /\b(treat\w*|therap\w*|initiat\w*|prescri\w*|dose|dosing|start\w*|discontinu\w*|administ\w*|surger\w*|procedure|referr\w*|manag\w*|inhibitor|blocker|agonist|antagonist|anticoagula\w*|statin|insulin|vaccin\w*|counsel\w*|intensif\w*)\b/i;
export function competenciesFor(rec, board, criteria) {
  const s = rec.statement || '', c = new Set(['comp.knowledge']), sub = new Set(['knowledge']);
  if (rec.strength_original || rec.loe_original) { c.add('comp.evidence'); sub.add('evidence_based_medicine'); }
  if (DIAG.test(s)) { c.add('comp.diagnostic'); sub.add('diagnosis'); sub.add('recognition'); }
  if (criteria.some((x) => x.kind === 'threshold')) { c.add('comp.interpretation'); sub.add('interpretation'); }
  if (MGMT.test(s)) { c.add('comp.management'); sub.add('management'); }
  if (rec.strength === 'moderate' || rec.strength === 'weak' || criteria.some((x) => x.kind === 'exception')) { c.add('comp.reasoning'); sub.add('reasoning'); }
  if (criteria.some((x) => x.kind === 'eligibility')) { c.add('comp.clinical'); sub.add('independent_practice_readiness'); }
  if ((board || 0) >= D.high_yield_board) { c.add('comp.board'); sub.add('board_readiness'); }
  return { competencies: [...c], subcompetencies: [...sub] };
}

const LABEL = { strong: 'Apply in practice', moderate: 'Judge when it is reasonable', weak: 'Judge when it may be considered', against_strong: 'Recognize as harmful and avoid', against_moderate: 'Recognize as not beneficial', insufficient: 'Know the evidence is insufficient', unstated: 'Know' };
const graded = (r) => [r.strength_original ? (r.grading_system === 'ACC_AHA_COR' ? 'COR ' : 'Grade ') + r.strength_original : '', r.loe_original ? 'LOE ' + r.loe_original : ''].filter(Boolean).join(', ');

// Blueprint topics mapped to any of the concepts (either edge direction).
async function blueprintTopics(env, concepts) {
  if (!concepts.length) return [];
  const p = concepts.slice(0, 40), q = p.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT src, dst FROM mk_edges WHERE rel = 'mapped_to_blueprint' AND status = 'current' AND (src IN (${q}) OR dst IN (${q})) LIMIT 60`).bind(...p, ...p).all();
  return [...new Set(results.flatMap((r) => [r.src, r.dst]).filter((x) => /^bpt\./.test(x)))];
}

/* Decompose one recommendation. ctx: {board, srcs}. Returns the number of objects written. */
export async function decomposeRec(env, rec, ctx, { actor = 'decomposer' } = {}) {
  const k = keyOf(rec), at = nowIso(), concepts = (rec.concepts || []).slice(0, 12);
  const board = concepts.length ? Math.max(0, ...concepts.map((c) => ctx.board[c] ?? 0)) : 0;
  const prov = [{ source_id: rec.source_id || 'src.app_generation', method: 'derived', at, agent: actor, note: rec.id }];
  const status = rec.status || 'current', gov = rec.governance_status === 'validated' || rec.governance_status === 'approved' ? 'validated' : 'pending_validation';
  const spec = rec.specialty || [], src = ctx.srcs[rec.source_id], label = src ? src.short_label || src.title || '' : '';
  const keep = new Set(), edges = [], objs = [];
  const put = async (o, extraEdges = []) => {
    const full = { specialty: spec, status, governance_status: gov, provenance: prov, ...o };
    for (const key of Object.keys(full)) if (full[key] === undefined) delete full[key];
    const r = await putObject(env, full, { actor, summary: 'decomposed from ' + rec.id, audited: false, aliases: false });
    keep.add(o.id); objs.push({ ...full, version: r.version });
    edges.push({ src: o.id, rel: 'derived_from', dst: rec.id, conf: 90, prov: prov[0] }, ...extraEdges.map((e) => ({ conf: 80, prov: prov[0], ...e })));
    return r.changed ? 1 : 0;
  };
  let n = 0;
  if (rec.adult_scope !== false) {
    const crit = parseCriteria(rec), { competencies, subcompetencies } = competenciesFor(rec, board, crit), bpts = await blueprintTopics(env, concepts);
    // Criteria
    for (const [i, c] of crit.entries()) n += await put({ id: `claim.${c.kind}.${k}.${i}`, type: 'Claim', name: `${c.kind.replace('_', ' ')}: ${clip(c.text, 100)}`, statement: clip(c.text, 1000), claim_kind: c.kind,
      recommendation: rec.id, concept: concepts[0] || undefined, cites: rec.source_id ? [rec.source_id] : [], values: c.values || undefined,
      facet_group: c.kind === 'monitoring' ? 'management' : c.kind === 'threshold' ? 'laboratory' : c.kind === 'contraindication' ? 'pharmacology' : 'guideline',
      facet_key: c.kind === 'monitoring' ? 'monitoring' : c.kind === 'threshold' ? 'interpretation_rules' : c.kind === 'contraindication' ? 'contraindications' : 'recommendation_mapping' });
    // Objectives
    const diff = recDifficulty(rec), pop = (crit.find((x) => x.kind === 'eligibility') || {}).text || '';
    const common = { type: 'Objective', edu_kind: 'objective', concepts, competencies, subcompetencies, source_recommendations: [rec.id], blueprint_topics: bpts, source_id: rec.source_id, strength: rec.strength || null, evidence_level: rec.evidence_level || null };
    const objEdges = (rel) => [...concepts.map((c) => ({ src: `obj.${rel === 'teaches' ? 'l' : 'a'}.${k}`, rel, dst: c })), ...competencies.map((c) => ({ src: `obj.${rel === 'teaches' ? 'l' : 'a'}.${k}`, rel: 'develops', dst: c })), ...bpts.map((b) => ({ src: `obj.${rel === 'teaches' ? 'l' : 'a'}.${k}`, rel: 'mapped_to_blueprint', dst: b }))];
    n += await put({ ...common, id: `obj.l.${k}`, name: `${LABEL[rec.strength] || 'Know'}: ${clip(rec.statement, 110)}`, objective_type: 'learning', difficulty: diff,
      statement: `${LABEL[rec.strength] || 'Know'}: ${clip(rec.statement, 900)}${graded(rec) ? ' (' + graded(rec) + ')' : ''}` }, objEdges('teaches'));
    n += await put({ ...common, id: `obj.a.${k}`, name: `Assess: ${clip(rec.statement, 110)}`, objective_type: board >= D.high_yield_board ? 'board' : 'assessment', difficulty: Math.min(5, diff + 1),
      statement: `Given a patient${pop ? ' (' + clip(pop, 160) + ')' : ''}, choose the action this recommendation supports and justify it from its class and evidence${graded(rec) ? ' (' + graded(rec) + ')' : ''}.` }, objEdges('assesses'));
    // Teaching point and its targets
    const thresholds = crit.some((x) => x.kind === 'threshold'), against = AGAINST.has(rec.strength) || crit.some((x) => x.kind === 'contraindication' || x.kind === 'not_recommended');
    const strong = rec.strength === 'strong' || rec.strength === 'against_strong';
    const targets = [...new Set([...(strong || against || thresholds || board >= D.high_yield_board ? ['question'] : []), ...(thresholds || crit.some((x) => x.kind === 'monitoring') ? ['flashcard'] : []),
      ...(pop && competencies.includes('comp.management') ? ['case'] : []), ...(board >= D.review_target_board ? ['review'] : [])])];
    const cov = concepts.map((c) => ({ src: `eo.tp.${k}`, rel: 'covers', dst: c }));
    n += await put({ id: `eo.tp.${k}`, type: 'EducationalObject', edu_kind: 'teaching_point', name: `Teaching point: ${clip(rec.statement, 110)}`, statement: `${clip(rec.statement, 1200)}${graded(rec) || label ? ' [' + [graded(rec), label].filter(Boolean).join('; ') + ']' : ''}`,
      concepts, competencies, difficulty: diff, targets, source_recommendations: [rec.id], source_id: rec.source_id, strength: rec.strength || null, evidence_level: rec.evidence_level || null }, cov);
    if (strong && !against && (/^A/.test(rec.evidence_level || '') || board >= D.high_yield_board))
      n += await put({ id: `eo.hy.${k}`, type: 'EducationalObject', edu_kind: 'high_yield', name: `High-yield: ${clip(rec.statement, 110)}`, statement: `High-yield: ${clip(rec.statement, 1200)}${graded(rec) ? ' (' + graded(rec) + ')' : ''}`,
        concepts, competencies, difficulty: diff, targets: ['question', 'flashcard'], source_recommendations: [rec.id], source_id: rec.source_id, strength: rec.strength || null, evidence_level: rec.evidence_level || null }, concepts.map((c) => ({ src: `eo.hy.${k}`, rel: 'covers', dst: c })));
    if (against)
      n += await put({ id: `eo.ce.${k}`, type: 'EducationalObject', edu_kind: 'common_error', name: `Common error: ${clip(rec.statement, 110)}`, statement: `Common error to avoid (acting against this recommendation): ${clip(rec.statement, 1200)}${graded(rec) ? ' (' + graded(rec) + ')' : ''}`,
        concepts, competencies, difficulty: Math.min(5, diff + 1), targets: ['question'], source_recommendations: [rec.id], source_id: rec.source_id, strength: rec.strength || null, evidence_level: rec.evidence_level || null }, concepts.map((c) => ({ src: `eo.ce.${k}`, rel: 'covers', dst: c })));
  }
  // Objects this recommendation used to yield and no longer does are retired (delta processing never leaves stale knowledge behind).
  const prior = (await env.DB.prepare("SELECT src FROM mk_edges WHERE rel = 'derived_from' AND dst = ? AND (src LIKE 'claim.%' OR src LIKE 'obj.%' OR src LIKE 'eo.%')").bind(rec.id).all()).results.map((r) => r.src).filter((id) => !keep.has(id));
  for (const id of prior) { const o = await getObject(env, id); if (o && o.status !== 'retired') { await putObject(env, { ...o, status: 'retired' }, { actor, summary: 'no longer yielded by ' + rec.id, audited: false, aliases: false }); n++; } }
  if (prior.length) await env.DB.prepare(`UPDATE mk_edges SET status = 'retired', updated = ? WHERE src IN (${prior.slice(0, 90).map(() => '?').join(',')})`).bind(at, ...prior.slice(0, 90)).run();
  if (edges.length) await addEdges(env, edges);
  if (objs.length) await classifyBatch(env, objs);
  await env.DB.prepare("UPDATE mk_objects SET body = json_set(body, '$.decomposition', json(?)) WHERE id = ?").bind(JSON.stringify({ v: DV, at, ov: rec.version, objects: [...keep] }), rec.id).run();
  return n;
}

// Per-concept targets: a lesson target when enough current recommendations exist, a review target when board relevance is high.
export async function conceptTargets(env, conceptIds, { actor = 'decomposer' } = {}) {
  const list = [...new Set(conceptIds)].slice(0, 60); if (!list.length) return 0;
  const board = await boardRelevance(env, list), cons = await getObjects(env, list); let n = 0;
  for (const c of list) {
    const con = cons[c]; if (!con || con.type !== 'Concept') continue;
    const recs = (await env.DB.prepare("SELECT e.dst AS id FROM mk_edges e JOIN mk_objects o ON o.id = e.dst WHERE e.src = ? AND e.rel = 'recommended_by' AND e.status = 'current' AND o.status IN ('current','modified') LIMIT 200").bind(c).all()).results.map((r) => r.id);
    const at = nowIso(), prov = [{ source_id: 'src.framework', method: 'derived', at, agent: actor, note: c }], key = c.slice(2).replace(/[^a-z0-9]/gi, '_').slice(0, 60);
    const b = board[c] ?? 0, base = { type: 'EducationalObject', concepts: [c], specialty: con.specialty || [], governance_status: 'validated', provenance: prov, source_recommendations: recs.slice(0, 60) };
    for (const [kind, ok, extra] of [['lesson_target', recs.length >= D.lesson_target_min_recs, { targets: ['lesson'], statement: `Lesson target: ${con.name} (${recs.length} current recommendations to teach from).` }],
      ['review_target', b >= D.review_target_board, { targets: ['review'], statement: `Review target: ${con.name} (board relevance ${b}/100).` }]]) {
      const id = `eo.${kind === 'lesson_target' ? 'lt' : 'rt'}.${key}`, old = await getObject(env, id);
      if (ok) { await putObject(env, { ...base, ...extra, id, edu_kind: kind, name: `${kind === 'lesson_target' ? 'Lesson' : 'Review'} target: ${con.name}`, status: 'current' }, { actor, audited: false, aliases: false, summary: kind }); await addEdges(env, [{ src: id, rel: 'covers', dst: c, conf: 80, prov: prov[0] }]); n++; }
      else if (old && old.status === 'current') { await putObject(env, { ...old, status: 'retired' }, { actor, audited: false, aliases: false, summary: kind + ' no longer met' }); n++; }
    }
  }
  return n;
}

// Per guideline section: the recommendations of that section, in order, as a clinical pathway.
export async function pathways(env, sourceId, { actor = 'decomposer' } = {}) {
  const { results } = await env.DB.prepare("SELECT id, json_extract(body, '$.section') AS section, json_extract(body, '$.page') AS page, json_extract(body, '$.status') AS st FROM mk_objects WHERE type = 'Recommendation' AND json_extract(body, '$.source_id') = ? AND json_extract(body, '$.adult_scope') IS NOT 0").bind(sourceId).all();
  const by = {}; for (const r of results) { if (!r.section || !['current', 'modified'].includes(r.st)) continue; (by[r.section] = by[r.section] || []).push(r); }
  const src = await getObject(env, sourceId); let n = 0;
  for (const [section, rs] of Object.entries(by)) {
    if (rs.length < D.pathway_min_recs) continue;
    rs.sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0) || a.id.localeCompare(b.id));
    const id = `eo.pw.${sourceId.slice(4, 24)}.${slug(section, 40)}`, at = nowIso();
    await putObject(env, { id, type: 'EducationalObject', edu_kind: 'clinical_pathway', name: `Pathway: ${section}`.slice(0, 200), statement: `${section} (${src ? src.short_label || src.title : sourceId}): ${rs.length} recommendations in order.`,
      children: rs.map((r) => r.id), source_recommendations: rs.map((r) => r.id).slice(0, 80), source_id: sourceId, specialty: (src && src.specialty) || [], status: src && src.status === 'superseded' ? 'superseded' : 'current', governance_status: 'validated',
      provenance: [{ source_id: sourceId, method: 'derived', at, agent: actor, note: section.slice(0, 200) }] }, { actor, audited: false, aliases: false, summary: 'pathway' });
    const steps = rs.map((r, i) => ({ src: id, rel: 'covers', dst: r.id, conf: 80, prov: { source_id: sourceId, method: 'derived', at } }));
    for (let i = 0; i + 1 < rs.length; i++) steps.push({ src: rs[i].id, rel: 'precedes', dst: rs[i + 1].id, conf: 60, prov: { source_id: sourceId, method: 'derived', at } });
    await addEdges(env, steps); n++;
  }
  return n;
}

/* One batch of delta decomposition. scope: a source id, or 'all' (backfill and reconciliation). prog: {after} cursor for 'all'.
   Returns {done, recs, objects}. */
export async function decomposeStep(env, scope, { prog = {}, limit = D.batch || 12 } = {}) {
  // Delta: not yet decomposed, decomposed by an older rule version, or changed (a new object version) since it was decomposed.
  const where = "type = 'Recommendation' AND (json_extract(body, '$.decomposition.v') IS NULL OR json_extract(body, '$.decomposition.v') != ? OR json_extract(body, '$.decomposition.ov') IS NOT version)";
  const q = scope === 'all' ? env.DB.prepare(`SELECT body FROM mk_objects WHERE ${where} AND id > ? ORDER BY id LIMIT ?`).bind(DV, prog.after || '', limit)
    : env.DB.prepare(`SELECT body FROM mk_objects WHERE ${where} AND json_extract(body, '$.source_id') = ? LIMIT ?`).bind(DV, scope, limit);
  const recs = (await q.all()).results.map((r) => J(r.body)).filter(Boolean);
  if (!recs.length) return { done: true, recs: 0, objects: 0 };
  const board = await boardRelevance(env, recs.flatMap((r) => r.concepts || []));
  const srcs = await getObjects(env, [...new Set(recs.map((r) => r.source_id).filter(Boolean))]);
  let objects = 0;
  for (const rec of recs) { objects += await decomposeRec(env, rec, { board, srcs }); prog.after = rec.id; prog.n = (prog.n || 0) + 1; }
  objects += await conceptTargets(env, recs.flatMap((r) => r.concepts || []));
  if (scope !== 'all') objects += await pathways(env, scope); else for (const s of Object.keys(srcs)) objects += await pathways(env, s);
  return { done: recs.length < limit, recs: recs.length, objects };
}

// CLINICAL PEARLS by the free AI, one concept per call, within the shared daily MKOS AI budget. Pending validation, never authoritative.
export const PEARL_PROMPT = (con, recs) => `You write clinical pearls for an internal medicine knowledge base. Concept: ${con.name}.
Current guideline recommendations (the only basis you may use):
${recs.map((r, i) => `${i + 1}. ${r.statement} (${[r.strength_original, r.loe_original].filter(Boolean).join(', ')})`).join('\n')}
Write 1 to 3 clinical pearls: practical, board-relevant insights a senior physician would teach, each grounded in the recommendations above, in your own words (never copy more than 8 consecutive words), with exact numbers. Reply with JSON only: {"pearls":[{"text":"","based_on":[recommendation numbers]}]}`;
export async function pearlStep(env, deps, { actor = 'pearls' } = {}) {
  if (!deps.ai) return { done: true, note: 'no free AI service' };
  const b = await aiBudgetLeft(env); if (b.left <= 0) return { done: true, note: 'AI budget spent for today' };
  const c = await env.DB.prepare(`SELECT e.src AS id, COUNT(*) AS n FROM mk_edges e JOIN mk_objects r ON r.id = e.dst WHERE e.rel = 'recommended_by' AND e.status = 'current' AND r.status = 'current'
    AND r.gov = 'validated' AND NOT EXISTS (SELECT 1 FROM mk_objects p WHERE p.id = 'eo.pe.' || replace(substr(e.src, 3), '.', '_') || '.0') GROUP BY e.src HAVING n >= 2 ORDER BY n DESC LIMIT 1`).first();
  if (!c) return { done: true, note: 'every concept with recommendations has its pearls' };
  const con = await getObject(env, c.id), recIds = (await env.DB.prepare("SELECT dst FROM mk_edges WHERE src = ? AND rel = 'recommended_by' AND status = 'current' LIMIT 8").bind(c.id).all()).results.map((r) => r.dst);
  const recs = Object.values(await getObjects(env, recIds)).filter((r) => r.status === 'current');
  const reply = await deps.ai(PEARL_PROMPT(con, recs)); await b.spend();
  const j = J(String(reply || '').replace(/^```(?:json)?|```$/g, '').trim(), null), pearls = (j && Array.isArray(j.pearls) ? j.pearls : []).filter((p) => p && p.text).slice(0, 3);
  const key = c.id.slice(2).replace(/\./g, '_').replace(/[^a-z0-9_]/gi, '_'), at = nowIso();
  const list = pearls.length ? pearls : [{ text: '', none: true }];
  for (const [i, p] of list.entries()) {
    const based = (p.based_on || []).map((x) => recs[Number(x) - 1]).filter(Boolean).map((r) => r.id);
    await putObject(env, { id: `eo.pe.${key}.${i}`, type: 'EducationalObject', edu_kind: 'clinical_pearl', name: p.none ? `No pearl yet: ${con.name}` : `Pearl: ${clip(p.text, 110)}`, statement: p.none ? '' : clip(p.text, 800),
      concepts: [c.id], source_recommendations: based.length ? based : recIds, specialty: con.specialty || [], status: p.none ? 'retired' : 'current', governance_status: 'pending_validation',
      provenance: [{ source_id: (recs[0] && recs[0].source_id) || 'src.app_generation', method: 'ai_extraction', at, agent: 'free_ai', note: 'clinical pearl' }] }, { actor, audited: false, aliases: false, summary: 'clinical pearl (AI, pending validation)' });
    if (!p.none) await addEdges(env, [{ src: `eo.pe.${key}.${i}`, rel: 'covers', dst: c.id, conf: 55, prov: { source_id: 'src.app_generation', method: 'ai_extraction', at } }, ...based.map((r) => ({ src: `eo.pe.${key}.${i}`, rel: 'derived_from', dst: r, conf: 55, prov: { source_id: 'src.app_generation', method: 'ai_extraction', at } }))]);
  }
  return { done: false, concept: c.id, pearls: pearls.length };
}
