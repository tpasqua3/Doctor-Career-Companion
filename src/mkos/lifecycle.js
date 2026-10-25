// THE CONTINUOUS KNOWLEDGE LIFECYCLE ORCHESTRATOR (mkos/directives/mkos_constitution.md, mkos/ontology/lifecycle.json).
// No knowledge asset may stop at ingestion: every source is carried, as one workflow, through
//   ingested -> knowledge_objects -> ontology_mapped -> relevance_mapped -> exam_projected -> lesson_penetration -> curriculum_penetration
//   -> confidence -> gaps
// Step 1 implements the first five (rules only, no AI); the others are recorded as pending_engine until their engines exist.
// It runs in the engine's metered tick after the queued jobs, in small resumable units (cursors in mk_settings 'lc_*', which are run
// state, not configuration), and stops when the run's budget share is used. Global passes do the bulk once for the existing corpus:
// concept classes (stage 2), canonical objectives, projection edges, and the relevance sweep (stages 3-4); a source's own stages do
// what is still missing for that source, so a newly added source completes without waiting for a sweep.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject, getObjects, putObject, slug } from './kb.js';
import { addEdges } from './graph.js';
import { sourceClass } from './scoring.js';
import { refineClass, refines, orgsOf } from './ingest.js';
import { LC, STAGES, readRecord, writeRecord, freshStages, enterLifecycle } from './lifecycle_state.js';
import { RULES_V, objectiveOf, objectiveSet, ensureProjectionEdges, ensureView, marked, mark, examProjection, processDirty, backfillStep, auditStep, dirtyCount } from './relevance.js';
import { computePenetration } from './impact.js';
import { enrichFromPenetration } from './enrich.js';
import { computeLayers } from './layers.js';
import { computeObjectConfidence, computeLessonConfidence } from './confidence.js';
import { coverageAndGaps } from './coverage.js';

const O = LC.orchestrator, M = LC.metadata, OBJ = LC.objectives, CLASSES = LC.concept_classes;
const CLASS_V = 'class' + LC.version, META_V = String(M.version);
const DONE = new Set(O.ingest_done_states), FAILED = new Set(O.ingest_failed_states);
const rx = (l) => (l || []).map((p) => new RegExp(p, 'i'));
const CL = CLASSES.map((c) => ({ ...c, types: new Set(c.concept_types || []), names: rx(c.name_patterns) }));

/* ---------- Stage 1: the source's Metadata Object (volatile source_metadata), cites edges, reclassification ---------- */
const DATE_OF = (s) => { const m = /^(\d{4})(?:-(\d\d))?(?:-(\d\d))?/.exec(String(s || '')); return m ? m[0] : null; };
export function reviewDateOf(src) {
  const leg = (src.data && src.data.legacy) || {};
  for (const f of M.review_date_legacy_fields) if (leg[f] && DATE_OF(leg[f])) return DATE_OF(leg[f]);
  for (const p of M.review_date_title_patterns) { const m = new RegExp(p, 'i').exec(String(src.title || '')); if (m) return m[1]; }
  return null;
}
// Upper-case tokens in recommendation text that may name a trial (SPRINT, EMPA-REG, DAPA-HF), most frequent first; organizations left out.
export function trialTokens(statements) {
  const n = new Map(), re = new RegExp(M.trial_token_pattern, 'g');
  for (const s of statements) for (const m of String(s || '').match(re) || []) {
    if (m.length < (Number(M.trial_token_min_length) || 3) || /^\d/.test(m) || orgsOf(m).length) continue;
    n.set(m, (n.get(m) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t).slice(0, Number(M.trial_token_max_per_source) || 60);
}
export async function computeMetadata(env, src) {
  const recs = (await env.DB.prepare(`SELECT json_extract(o.body, '$.grading_system') AS g, json_extract(o.body, '$.statement') AS s FROM mk_edges e JOIN mk_objects o ON o.id = e.src
    WHERE e.dst = ? AND e.rel = 'derived_from' AND o.type = 'Recommendation' LIMIT 2000`).bind(src.id).all()).results;
  const sys = {}; for (const r of recs) if (r.g) sys[r.g] = (sys[r.g] || 0) + 1;
  const systems = Object.entries(sys).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([system, n]) => ({ system, recommendations: n }));
  // Referenced sources: trials named in the recommendations that MKOS already holds as evidence objects (no new objects are invented).
  const cand = trialTokens(recs.map((r) => r.s)).map((t) => 'ev.' + slug(t, 50)), found = await getObjects(env, cand);
  // Only named evidence (a trial acronym), never an object named after a study design.
  const referenced = cand.filter((id) => found[id] && found[id].type === 'EvidenceObject' && found[id].acronym);
  if (referenced.length) await addEdges(env, referenced.map((id) => ({ src: src.id, rel: 'cites', dst: id, conf: 60, prov: { source_id: src.id, method: 'derived', at: nowIso(), note: 'trial named in its recommendations' } })));
  const dates = [src.issue_date, src.published_online, src.year].map(DATE_OF).filter(Boolean).sort();
  return {
    source_organization: src.responsible_orgs || [], publication_date: dates[0] || null, version_date: dates[dates.length - 1] || null, review_date: reviewDateOf(src),
    specialty_domain: [].concat(src.specialty || []), source_type: src.spec_source_type || sourceClass(src.source_class).spec_source_type || null, source_class: src.source_class || null,
    superseded_by: src.replaced_by || null, evidence_strength_system: systems.length ? systems[0].system : null, evidence_strength_systems: systems,
    referenced_sources: referenced, v: META_V, ov: src.version || null, at: nowIso(),
  };
}
async function writeMetadata(env, id, md) { await env.DB.prepare("UPDATE mk_objects SET body = json_set(body, '$.source_metadata', json(?)) WHERE id = ?").bind(JSON.stringify(md), id).run(); }

// A more specific class for an already classified source (never for an owner-registry source); logged.
export async function maybeReclassify(env, src) {
  if (!src.source_class || src.registry_ref_id) return null;
  const to = refineClass(src.source_class, src.title, String(src.drive_path || '').split('/').filter(Boolean));
  if (to === src.source_class || !refines(src.source_class, to)) return null;
  const c = sourceClass(to);
  await putObject(env, { ...src, source_class: to, spec_source_type: c.spec_source_type }, { actor: 'lifecycle', summary: `reclassified ${src.source_class} -> ${to} (more specific rule)` });
  await audit(env, 'lifecycle', 'source_reclassified', src.id, null, null, { from: src.source_class, to, rule: 'refinement' });
  return { from: src.source_class, to };
}

/* ---------- Stage 2: the eleven mappable classes as classified_as edges to ConceptClass nodes ---------- */
export const classId = (key) => 'cls.' + key;
// Taxonomy specialties added after the store was seeded (specialties.json versions) become Specialty objects; unchanged ones are no-ops.
export async function seedSpecialties(env) {
  const SP = FRAMEWORK.frameworks.specialties, v = 'spec' + SP.version;
  if ((await getSetting(env, 'lc_spec')) === v) return 0;
  let n = 0;
  for (const s of SP.specialties) { const cur = await getObject(env, s.id);
    const r = await putObject(env, { ...(cur || {}), ...s, type: 'Specialty', status: s.status || 'current', governance_status: 'approved',
      provenance: (cur && cur.provenance && cur.provenance.length) ? cur.provenance : [{ source_id: 'src.framework', method: 'derived', at: nowIso(), note: 'mkos/ontology/specialties.json v' + SP.version }] }, { actor: 'lifecycle', summary: 'specialty taxonomy v' + SP.version, audited: false });
    if (r.changed) n++; }
  await setSetting(env, 'lc_spec', v);
  return n;
}
export async function seedClasses(env) {
  if ((await getSetting(env, 'lc_classes')) === CLASS_V) return 0;
  let n = 0;
  for (const c of CLASSES) { const r = await putObject(env, { id: classId(c.key), type: 'ConceptClass', name: c.name, class_key: c.key, concept_types: c.concept_types || [], status: 'current', governance_status: 'approved',
    provenance: [{ source_id: 'src.framework', method: 'derived', at: nowIso(), note: 'mkos/ontology/lifecycle.json concept_classes v' + LC.version }] }, { actor: 'lifecycle', summary: 'concept class', audited: false, aliases: false }); if (r.changed) n++; }
  await setSetting(env, 'lc_classes', CLASS_V);
  return n;
}
// Pure: the class keys of one concept from its type, its name and the facts the batch query found.
export function classesOf(con, facts = {}) {
  const out = [];
  for (const c of CL) {
    let hit = c.types.has(con.concept_type) ? 'concept_type' : null;
    if (!hit && c.names.some((r) => r.test(String(con.name || '')))) hit = 'name';
    if (!hit && (c.as_source_of || []).length && (facts.complicates || new Set()).has(con.id)) hit = 'relation';
    if (!hit && (c.recommended_by_source_classes || []).length && (facts.preventive || new Set()).has(con.id)) hit = 'source_class';
    if (!hit && (c.anchors || []).length && (facts.anchors || new Set()).has(con.id)) hit = 'anchor';
    if (hit) out.push({ key: c.key, why: hit });
  }
  return out;
}
const ph = (n) => Array(n).fill('?').join(',');
async function anchorsOf(env, ids) {
  const out = new Set(); if (!ids.length) return out;
  for (const r of (await env.DB.prepare(`SELECT DISTINCT dst AS c FROM mk_edges WHERE rel = 'covers' AND status = 'current' AND src LIKE 'cn.%' AND dst IN (${ph(ids.length)})`).bind(...ids).all()).results) out.add(r.c);
  for (const r of (await env.DB.prepare(`SELECT DISTINCT j.value AS c FROM mk_objects t, json_each(t.body, '$.concepts') j WHERE t.type = 'BlueprintTopic' AND t.status = 'current' AND j.value IN (${ph(ids.length)})`).bind(...ids).all()).results) out.add(r.c);
  return out;
}
export async function classifyConcepts(env, ids) {
  ids = ids.slice(0, 90); if (!ids.length) return 0;
  const cons = Object.values(await getObjects(env, ids)).filter((c) => c.type === 'Concept');
  const list = cons.map((c) => c.id); if (!list.length) return 0;
  const compRels = [...new Set(CL.flatMap((c) => c.as_source_of || []))], prevCls = [...new Set(CL.flatMap((c) => c.recommended_by_source_classes || []))];
  const complicates = new Set(compRels.length ? (await env.DB.prepare(`SELECT DISTINCT src FROM mk_edges WHERE status = 'current' AND rel IN (${ph(compRels.length)}) AND src IN (${ph(list.length)})`).bind(...compRels, ...list).all()).results.map((r) => r.src) : []);
  const preventive = new Set(prevCls.length ? (await env.DB.prepare(`SELECT DISTINCT e.src FROM mk_edges e JOIN mk_objects r ON r.id = e.dst JOIN mk_objects s ON s.id = json_extract(r.body, '$.source_id')
    WHERE e.rel = 'recommended_by' AND e.status = 'current' AND e.src IN (${ph(list.length)}) AND json_extract(s.body, '$.source_class') IN (${ph(prevCls.length)})`).bind(...list, ...prevCls).all()).results.map((r) => r.src) : []);
  const anchors = await anchorsOf(env, list), facts = { complicates, preventive, anchors };
  const have = (await env.DB.prepare(`SELECT src, dst, status FROM mk_edges WHERE rel = 'classified_as' AND src IN (${ph(list.length)})`).bind(...list).all()).results;
  const want = [], keep = new Set(), at = nowIso();
  for (const c of cons) for (const k of classesOf(c, facts)) { keep.add(c.id + '|' + classId(k.key));
    want.push({ src: c.id, rel: 'classified_as', dst: classId(k.key), conf: k.why === 'concept_type' ? LC.class_edge_confidence.concept_type : LC.class_edge_confidence.rule, prov: { source_id: 'src.framework', method: 'ontology_mapping', at, note: k.why } }); }
  if (want.length) await addEdges(env, want);
  const st = [];
  for (const e of have) { const k = e.src + '|' + e.dst;
    if (!keep.has(k) && e.status !== 'retired') st.push(env.DB.prepare("UPDATE mk_edges SET status = 'retired', updated = ? WHERE src = ? AND rel = 'classified_as' AND dst = ?").bind(at, e.src, e.dst));
    if (keep.has(k) && e.status !== 'current') st.push(env.DB.prepare("UPDATE mk_edges SET status = 'current', updated = ? WHERE src = ? AND rel = 'classified_as' AND dst = ?").bind(at, e.src, e.dst)); }
  if (st.length) await env.DB.batch(st);
  await mark(env, list.map((id) => ['class:' + id, want.filter((w) => w.src === id).length]), CLASS_V);
  return list.length;
}

/* ---------- Canonical, exam-independent objectives anchored on concepts ---------- */
export async function worthy(env, ids) {
  const out = new Set(); if (!ids.length) return out;
  const cr = OBJ.criteria;
  if (cr.blueprint_anchor || cr.curriculum_anchor) for (const c of await anchorsOf(env, ids)) out.add(c);
  const min = Number(cr.min_current_recommendations) || 0;
  if (min) for (const r of (await env.DB.prepare(`SELECT e.src AS c, COUNT(*) AS n FROM mk_edges e JOIN mk_objects r ON r.id = e.dst WHERE e.rel = 'recommended_by' AND e.status = 'current'
    AND e.src IN (${ph(ids.length)}) AND r.status IN ('current','modified') GROUP BY e.src HAVING COUNT(*) >= ?`).bind(...ids, min).all()).results) out.add(r.c);
  return out;
}
export async function ensureObjectives(env, conceptIds, objectives) {
  const ids = conceptIds.slice(0, 90), need = [...(await worthy(env, ids))].filter((c) => !objectives.has(objectiveOf(c)));
  if (!need.length) return 0;
  const cons = await getObjects(env, need), made = []; let n = 0;
  for (const c of need) {
    const con = cons[c]; if (!con || con.type !== 'Concept' || !['current', 'modified'].includes(con.status)) continue;
    const id = objectiveOf(c), at = nowIso(), prov = { source_id: 'src.framework', method: 'derived', at, agent: 'lifecycle', note: 'canonical objective anchored on ' + c };
    await putObject(env, { id, type: 'Objective', name: OBJ.name_template.replace('{name}', con.name).slice(0, 200), edu_kind: 'objective', objective_type: OBJ.objective_type, anchor_concept: c, concepts: [c],
      specialty: con.specialty || [], status: 'current', governance_status: 'validated', statement: `Know, recognise and apply what is known about ${con.name}, independent of any examination.`, provenance: [prov] },
      { actor: 'lifecycle', summary: 'canonical objective', audited: false, aliases: false });
    await addEdges(env, [{ src: id, rel: OBJ.anchor_relation, dst: c, conf: 100, prov }]);
    objectives.add(id); n++; made.push(c);
  }
  // A new objective changes the rows of every concept within max_hops of its anchor: putObject marked the anchor as a dirty seed over
  // that radius (dirty.js), so exactly those are recomputed, nothing else.
  return n;
}
/* ---------- A source's own stages ---------- */
async function sourceConcepts(env, sid) {
  const a = (await env.DB.prepare("SELECT DISTINCT dst AS c FROM mk_edges WHERE src = ? AND rel = 'covers' AND status = 'current' AND dst LIKE 'c.%' LIMIT 3000").bind(sid).all()).results.map((r) => r.c);
  const b = (await env.DB.prepare(`SELECT DISTINCT e.src AS c FROM mk_edges d JOIN mk_edges e ON e.dst = d.src AND e.rel = 'recommended_by' AND e.status = 'current'
    WHERE d.dst = ? AND d.rel = 'derived_from' AND d.src LIKE 'rec.%' LIMIT 3000`).bind(sid).all()).results.map((r) => r.c);
  return [...new Set([...a, ...b])].sort();
}
async function unmarked(env, ids, tag, prefix = '') {
  const keys = ids.map((i) => prefix + i), done = await marked(env, keys, tag);
  return ids.filter((i) => !done.has(prefix + i));
}
// Is anything this source touches still waiting in the relevance dirty queue? One query.
export async function dirtyFor(env, sid) {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM mk_relevance_dirty WHERE object_id = ?1
    OR object_id IN (SELECT src FROM mk_edges WHERE dst = ?1 AND rel IN ('derived_from','part_of'))
    OR object_id IN (SELECT dst FROM mk_edges WHERE src = ?1 AND rel = 'covers')
    OR object_id IN (SELECT e.src FROM mk_edges d JOIN mk_edges e ON e.dst = d.src AND e.rel = 'recommended_by' WHERE d.dst = ?1 AND d.rel = 'derived_from')
    OR object_id IN (SELECT c.src FROM mk_edges d JOIN mk_edges c ON c.dst = d.src AND c.rel = 'derived_from' WHERE d.dst = ?1 AND d.rel = 'derived_from') LIMIT 1`).bind(sid).first());
}
const done = (detail = {}, v = null) => ({ state: 'done', at: nowIso(), ...(v ? { v } : {}), detail });

/* Advance one source as far as this run allows. Returns 'advanced' | 'waiting' | 'continues' | 'finished'. */
export async function advanceSource(env, sid, ctx) {
  const rec = await readRecord(env, sid); if (!rec) return 'missing';
  const doc = rec.doc; doc.stages = { ...freshStages(), ...(doc.stages || {}) };
  const S = doc.stages, src = await getObject(env, sid);
  const save = () => writeRecord(env, sid, doc, { source_v: src ? src.version : rec.source_v, cycle: rec.cycle, created: rec.created_at });
  if (!src || src.status === 'retired') { if (!doc.retired) { doc.retired = nowIso(); await save(); } return 'finished'; }
  if (doc.retired) { delete doc.retired; }
  // 1. Ingested: the source has been read (or indexed, or mapped by title); then its metadata, cites edges and a refined class.
  if (S.ingested.state !== 'done') {
    if (FAILED.has(src.ingest_state)) { if (S.ingested.state !== 'blocked') { S.ingested = { state: 'blocked', at: nowIso(), detail: { ingest_state: src.ingest_state } }; await save(); } return 'waiting'; }
    if (!DONE.has(src.ingest_state)) return 'waiting';
    const re = await maybeReclassify(env, src), cur = re ? await getObject(env, sid) : src;
    const md = await computeMetadata(env, cur); await writeMetadata(env, sid, md);
    S.ingested = done({ ingest_state: cur.ingest_state, source_class: cur.source_class, ...(re ? { reclassified: re } : {}), evidence_strength_system: md.evidence_strength_system, referenced_sources: md.referenced_sources.length }, cur.version);
    await save(); return 'advanced';
  }
  // 2. Knowledge objects: what the source produced, once its decomposition has finished.
  if (S.knowledge_objects.state !== 'done') {
    const open = await env.DB.prepare("SELECT 1 AS x FROM mk_jobs WHERE subject = ? AND kind IN ('extract','decompose') AND state IN ('queued','running') LIMIT 1").bind(sid).first();
    if (open) return 'waiting';
    const by = Object.fromEntries((await env.DB.prepare("SELECT o.type AS t, COUNT(*) AS n FROM mk_edges e JOIN mk_objects o ON o.id = e.src WHERE e.dst = ? AND e.rel IN ('derived_from','part_of') GROUP BY o.type").bind(sid).all()).results.map((r) => [r.t, r.n]));
    const derived = (await env.DB.prepare("SELECT COUNT(DISTINCT d.src) AS n FROM mk_edges e JOIN mk_edges d ON d.dst = e.src AND d.rel = 'derived_from' WHERE e.dst = ? AND e.rel = 'derived_from' AND e.src LIKE 'rec.%'").bind(sid).first()).n;
    const concepts = (await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_edges WHERE src = ? AND rel = 'covers' AND dst LIKE 'c.%'").bind(sid).first()).n;
    S.knowledge_objects = done({ ...by, derived_from_recommendations: derived, concepts_covered: concepts }, src.version);
    await save(); return 'advanced';
  }
  const concepts = ctx.concepts[sid] || (ctx.concepts[sid] = await sourceConcepts(env, sid));
  // 3. Ontology mapped: every concept of the source carries its classes.
  if (S.ontology_mapped.state !== 'done') {
    const todo = await unmarked(env, concepts, CLASS_V, 'class:');
    if (todo.length) { await classifyConcepts(env, todo.slice(0, O.class_batch)); if (todo.length > O.class_batch) return 'continues'; }
    S.ontology_mapped = done({ concepts: concepts.length }, src.version); await save(); return 'advanced';
  }
  // 4. Relevance mapped: canonical objectives for its concepts (each new one marks its anchor's neighbourhood dirty), then the source is
  // mapped once nothing it touches is still dirty: its concepts, its recommendations and what was derived from them (dirty.js).
  if (S.relevance_mapped.state !== 'done') {
    if (!ctx.objectivesReady) return 'waiting';
    const pos = Number(S.relevance_mapped.pos) || 0;
    if (pos < concepts.length) {
      const part = concepts.slice(pos, pos + O.concept_batch);
      await ensureObjectives(env, part, ctx.objectives);
      S.relevance_mapped = { state: 'pending', pos: pos + part.length, at: nowIso() }; await save(); return 'continues';
    }
    if (await dirtyFor(env, sid)) return 'waiting';
    const n = (await env.DB.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT r.object_id) AS o FROM mk_relevance r JOIN mk_edges d ON d.src = r.object_id AND d.rel = 'derived_from' AND d.dst = ?`).bind(sid).first());
    S.relevance_mapped = done({ concepts: concepts.length, rows_for_recommendations: n.n, recommendations_related: n.o, rules: RULES_V }, src.version); await save(); return 'advanced';
  }
  // 5. Exam projected: the source's recommendations projected onto every current blueprint (computed, not stored per exam).
  if (S.exam_projected.state !== 'done') {
    if (!ctx.projected) { await ensureProjectionEdges(env); ctx.projected = true; }
    const recs = (await env.DB.prepare("SELECT src FROM mk_edges WHERE dst = ? AND rel = 'derived_from' AND src LIKE 'rec.%' LIMIT 400").bind(sid).all()).results.map((r) => r.src);
    const bps = (await env.DB.prepare("SELECT blueprint_id, blueprint_family FROM mk_blueprint_registries WHERE current_status = 'current'").all()).results, exams = {};
    for (const b of bps) { const p = Object.values(await examProjection(env, recs, { blueprint_id: b.blueprint_id }));
      exams[b.blueprint_family] = { recommendations: p.length, max: p.length ? Math.max(...p.map((x) => x.relevance)) : 0, mean: p.length ? Math.round(10000 * p.reduce((a, x) => a + x.relevance, 0) / p.length) / 10000 : 0 }; }
    S.exam_projected = done({ exams, recommendations: recs.length }, src.version); await save(); return 'advanced';
  }
  const room = ctx.room || (() => true);
  // 6. Lesson penetration: what the source reaches (objectives, lessons, curricula, exams, with scores), then the lessons it penetrates
  // strongly are enhanced, never regenerated (enrich.js). The change event carries the penetration as its impact.
  if (S.lesson_penetration.state !== 'done') {
    const st = S.lesson_penetration;
    if (!st.summary) {
      const p = await computePenetration(env, sid);
      st.state = 'pending'; st.summary = { counts: p.summary.counts, exams: p.summary.exams, top: p.summary.top }; st.at = nowIso();
      await env.DB.prepare('DELETE FROM mk_penetration_queue WHERE subject_id = ?').bind(sid).run();
      await env.DB.prepare("UPDATE mk_events SET impact = ?, stage = CASE WHEN stage = 'created' THEN 'impact_determined' ELSE stage END, updated = ? WHERE subject = ? AND kind IN ('source_added','source_modified') AND impact IS NULL")
        .bind(JSON.stringify({ penetration: p.summary }).slice(0, 60000), nowIso(), sid).run();
      await save(); return 'continues';
    }
    const prog = st.enrich || (st.enrich = {});
    const r = await enrichFromPenetration(env, sid, { prog, room });
    st.enriched = (st.enriched || 0) + r.enriched; st.added = (st.added || 0) + r.added;
    if (!r.finished) { await save(); return 'continues'; }
    S.lesson_penetration = done({ ...st.summary, lessons_enhanced: st.enriched, enhancements: st.added }, src.version); await save(); return 'advanced';
  }
  // 7. Curriculum penetration: the curriculum nodes and board curriculum (blueprint topics) it reaches, and the content layers of the
  // objectives it reaches are brought up to date (the Drive board curriculum follows by content hash, curstore.js).
  if (S.curriculum_penetration.state !== 'done') {
    const st = S.curriculum_penetration, B = Number(LC.layers.batch) || 20;
    const obs = (await env.DB.prepare("SELECT target_id FROM mk_penetration WHERE subject_id = ? AND target_kind = 'objective' ORDER BY score DESC, target_id LIMIT 200").bind(sid).all()).results.map((r) => r.target_id);
    const pos = Number(st.pos) || 0;
    if (pos < obs.length) { await computeLayers(env, obs.slice(pos, pos + B)); S.curriculum_penetration = { state: 'pending', pos: pos + B, at: nowIso() }; await save(); return 'continues'; }
    const c = Object.fromEntries((await env.DB.prepare("SELECT target_kind AS k, COUNT(*) AS n, MAX(score) AS mx FROM mk_penetration WHERE subject_id = ? AND target_kind IN ('curriculum','board_curriculum') GROUP BY target_kind").bind(sid).all()).results.map((r) => [r.k, { n: r.n, max: r.mx }]));
    S.curriculum_penetration = done({ ...c, objectives_layered: obs.length }, src.version); await save(); return 'advanced';
  }
  // 8. Confidence: the evidence and relevance domains of its objects, and the lesson domain of the lessons it reaches.
  if (S.confidence.state !== 'done') {
    const st = S.confidence, B = Number(LC.confidence.batch) || 40;
    const ids = (await env.DB.prepare(`SELECT src AS id FROM mk_edges WHERE dst = ?1 AND rel IN ('derived_from','part_of') AND src NOT LIKE 'sec.%'
      UNION SELECT c.src FROM mk_edges d JOIN mk_edges c ON c.dst = d.src AND c.rel = 'derived_from' WHERE d.dst = ?1 AND d.rel = 'derived_from' AND d.src LIKE 'rec.%' ORDER BY 1 LIMIT 4000`).bind(sid).all()).results.map((r) => r.id);
    const pos = Number(st.pos) || 0;
    if (pos < ids.length) { await computeObjectConfidence(env, ids.slice(pos, pos + B)); S.confidence = { state: 'pending', pos: pos + B, at: nowIso() }; await save(); return 'continues'; }
    const lessons = (await env.DB.prepare("SELECT target_id FROM mk_penetration WHERE subject_id = ? AND target_kind = 'lesson' ORDER BY score DESC LIMIT 40").bind(sid).all()).results.map((r) => r.target_id);
    if (lessons.length) await computeLessonConfidence(env, lessons);
    const m = (await env.DB.prepare(`SELECT domain, COUNT(*) AS n, AVG(score) AS a FROM mk_confidence WHERE object_id IN (SELECT value FROM json_each(?)) GROUP BY domain`).bind(JSON.stringify(ids.slice(0, 2000))).all()).results;
    S.confidence = done({ objects: ids.length, lessons: lessons.length, ...Object.fromEntries(m.map((r) => [r.domain, { n: r.n, mean: Math.round(r.a * 1000) / 1000 }])) }, src.version); await save(); return 'advanced';
  }
  // 9. Gaps: complete once a coverage and gap run has taken this source into account (the run is scheduled when sources wait here).
  if (S.gaps.state !== 'done') {
    const cov = J(await getSetting(env, 'lc_cov'), {}) || {};
    if (!cov.at || cov.at < (S.confidence.at || '')) { ctx.coverageWanted = true; return 'waiting'; }
    const g = (await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM mk_gaps WHERE status = 'open' AND (key = ? OR json_extract(action_json, '$.source') = ?) GROUP BY kind").bind(sid, sid).all()).results;
    S.gaps = done({ coverage_day: cov.day, gaps_for_source: Object.fromEntries(g.map((r) => [r.kind, r.n])) }, src.version); await save(); return 'advanced';
  }
  return 'finished';
}

/* ---------- The orchestrator: one slice per engine run ---------- */
export async function lifecycleStep(env, deps, { meter = null, cap = Infinity } = {}) {
  // A unit starts only while the run has room for it: the reserve scales with the budget, so small (free-plan) budgets still advance.
  const room = (reserve = 25) => !meter || meter.n < Math.min(cap, meter.max * (Number(O.budget_share_max) || 0.9)) - Math.min(reserve, Math.max(3, Math.floor(meter.max * 0.25)));
  const out = { entered: 0, advanced: 0, classes: 0, objectives: 0, relevance: 0 };
  await ensureView(env);
  await seedClasses(env);
  await seedSpecialties(env);
  // Every source has a record: existing sources enter once (new and changed ones enter from the scanner, ingest.js).
  const fresh = JSON.stringify({ started: nowIso(), event: 'backfill', stages: freshStages(), history: [] }), at = nowIso();
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO mk_lifecycle (source_id, stage, stages_json, status, source_v, cycle, created_at, updated_at)
    SELECT o.id, 'ingested', ?, 'waiting', o.version, 1, ?, ? FROM mk_objects o WHERE o.type = 'Source' AND o.status != 'retired' AND NOT EXISTS (SELECT 1 FROM mk_lifecycle l WHERE l.source_id = o.id) LIMIT 300`).bind(fresh, at, at).run();
  out.entered = (ins.meta && ins.meta.changes) || 0;
  const obj = J(await getSetting(env, 'lc_obj'), {}) || {}, rel = J(await getSetting(env, 'lc_rel'), {}) || {};
  // Relevance is event driven (dirty.js): there is no periodic sweep. The first run, a restore (lc_rel is run state, so it is absent) and
  // a rules-version change mark everything once (backfill); a store built by the earlier sweep keeps its rows and gets a read-only audit.
  const saveRel = () => setSetting(env, 'lc_rel', JSON.stringify(rel));
  if (rel.mode !== 'dirty') {
    // Only a finished sweep left complete rows to audit; anything else (production's first sweep never finished) is backfilled.
    const migrated = rel.v === RULES_V && rel.sweep && rel.finished && rel.phase === 'idle';
    for (const k of ['sweep', 'cursor', 'phase', 'finished']) delete rel[k];
    Object.assign(rel, { mode: 'dirty', v: RULES_V, started: nowIso() }, migrated ? { audit: { phase: 'concepts', started: nowIso() } } : { backfill: { cursor: '', started: nowIso() } });
    await saveRel();
  } else if (rel.v !== RULES_V) { rel.v = RULES_V; rel.backfill = { cursor: '', started: nowIso(), reason: 'rules_version' }; delete rel.audit; await saveRel(); }
  const ctx = { objectives: await objectiveSet(env), objectivesReady: !!obj.passes, concepts: {}, projected: false, room: () => room() };
  // 1. Sources, round robin.
  const cur = (await getSetting(env, 'lc_src')) || '';
  let list = (await env.DB.prepare("SELECT source_id FROM mk_lifecycle WHERE status IN ('waiting','in_progress','blocked','pending_engine') AND source_id > ? ORDER BY source_id LIMIT ?").bind(cur, O.sources_per_run).all()).results.map((r) => r.source_id);
  if (list.length < O.sources_per_run) list = [...list, ...(await env.DB.prepare("SELECT source_id FROM mk_lifecycle WHERE status IN ('waiting','in_progress','blocked','pending_engine') AND source_id <= ? ORDER BY source_id LIMIT ?").bind(cur, O.sources_per_run - list.length).all()).results.map((r) => r.source_id)];
  for (const sid of [...new Set(list)]) {
    if (!room()) break;
    for (let k = 0; k < STAGES.length && room(); k++) { const r = await advanceSource(env, sid, ctx); if (r === 'advanced') { out.advanced++; continue; } break; }
    await setSetting(env, 'lc_src', sid);
  }
  // 2. Metadata stays current when a source's content version moves (it is derived, so recomputing it makes no version).
  if (room()) for (const r of (await env.DB.prepare(`SELECT o.id FROM mk_objects o JOIN mk_lifecycle l ON l.source_id = o.id WHERE o.type = 'Source' AND l.stage != 'ingested'
      AND (json_extract(o.body, '$.source_metadata.ov') IS NOT o.version OR json_extract(o.body, '$.source_metadata.v') IS NOT ?) LIMIT 5`).bind(META_V).all()).results) {
    if (!room()) break; const s = await getObject(env, r.id); if (s) await writeMetadata(env, s.id, await computeMetadata(env, s));
  }
  // 3. Concept classes for the whole corpus (a pass restarts daily for concepts added since).
  const cls = J(await getSetting(env, 'lc_cls'), {}) || {}, day = nowIso().slice(0, 10);
  if (cls.done_day !== day || cls.cursor) while (room()) {
    const ids = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Concept' AND status IN ('current','modified') AND id > ? ORDER BY id LIMIT ?").bind(cls.cursor || '', O.class_batch).all()).results.map((r) => r.id);
    const todo = await unmarked(env, ids, CLASS_V, 'class:');
    if (todo.length) out.classes += await classifyConcepts(env, todo);
    if (ids.length < O.class_batch) { cls.cursor = ''; cls.done_day = day; cls.passes = (cls.passes || 0) + 1; await setSetting(env, 'lc_cls', JSON.stringify(cls)); break; }
    cls.cursor = ids[ids.length - 1]; await setSetting(env, 'lc_cls', JSON.stringify(cls));
  }
  // 4. Canonical objectives for every objective-worthy concept (a pass restarts daily).
  if (obj.done_day !== day || obj.cursor) while (room()) {
    const ids = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Concept' AND status IN ('current','modified') AND id > ? ORDER BY id LIMIT ?").bind(obj.cursor || '', O.objective_batch * 3).all()).results.map((r) => r.id);
    out.objectives += await ensureObjectives(env, ids, ctx.objectives);
    if (ids.length < O.objective_batch * 3) { obj.cursor = ''; obj.done_day = day; obj.passes = (obj.passes || 0) + 1; ctx.objectivesReady = true; await setSetting(env, 'lc_obj', JSON.stringify(obj)); await ensureProjectionEdges(env); break; }
    obj.cursor = ids[ids.length - 1]; await setSetting(env, 'lc_obj', JSON.stringify(obj));
  }
  // 4b. Exams are projections: concepts a blueprint names get their canonical objective, and every topic its projects_objective edges,
  // whenever a blueprint arrives (a new exam needs nothing but its blueprint).
  if (ctx.objectivesReady && room()) {
    const anchors = (await env.DB.prepare(`SELECT DISTINCT j.value AS c FROM mk_objects t, json_each(t.body, '$.concepts') j WHERE t.type = 'BlueprintTopic' AND t.status = 'current' AND j.value LIKE 'c.%'
      AND NOT EXISTS (SELECT 1 FROM mk_objects o WHERE o.id = '${OBJ.id_prefix}' || substr(j.value, 3)) LIMIT 60`).all()).results.map((r) => r.c);
    if (anchors.length) out.objectives += await ensureObjectives(env, anchors, ctx.objectives);
    if (room()) out.projection = await ensureProjectionEdges(env);
  }
  // 5. Relevance, event driven: mark everything once if a backfill is due, then recompute only the dirty objects (dirty.js), writing only
  // rows that changed. When nothing is dirty, a rotating read-only audit compares stored rows with the rules and marks any drift.
  if (ctx.objectivesReady && room(40)) {
    const AUD = Number((LC.relevance.dirty || {}).audit_hours) || 720;
    if (rel.backfill) { if (await backfillStep(env, rel.backfill, () => room(40))) { delete rel.backfill; rel.backfilled = nowIso(); } await saveRel(); }
    if (!rel.backfill) {
      const d = await processDirty(env, ctx.objectives, () => room(40));
      out.relevance += d.writes; out.dirty = d;
      if (room(40) && !(await dirtyCount(env))) {
        const last = Date.parse((rel.audit && rel.audit.finished) || rel.backfilled || rel.started || 0);
        if ((rel.audit && rel.audit.phase !== 'done') || Date.now() - last > AUD * 3600e3) {
          if (!rel.audit || rel.audit.phase === 'done') rel.audit = { phase: 'concepts', started: nowIso() };
          if (await auditStep(env, rel.audit, ctx.objectives, () => room(40))) rel.audit.finished = nowIso();
          await saveRel();
        }
      }
    }
  }
  // 6. Penetration from change events: subjects whose relevance rows just changed (the dirty queue recorded them). A source still in
  // its own lifecycle is left to its stages; anything else gets its penetration, lesson enhancements, confidence and layers now.
  if (room(40)) {
    const PQ = Number(LC.penetration.queue_batch) || 3;
    const subs = (await env.DB.prepare('SELECT subject_id FROM mk_penetration_queue ORDER BY marked_at LIMIT ?').bind(PQ).all()).results.map((r) => r.subject_id);
    for (const sub of subs) {
      if (!room(40)) break;
      const rec = await env.DB.prepare('SELECT stages_json FROM mk_lifecycle WHERE source_id = ?').bind(sub).first();
      const inStage = rec && ((J(rec.stages_json, {}) || {}).stages || {}).lesson_penetration?.state !== 'done';
      if (!inStage) {
        const p = await computePenetration(env, sub);
        await enrichFromPenetration(env, sub, { room: () => room(40) });
        if (!rec) await computeObjectConfidence(env, [sub]);
        const obs = (p.rows || []).filter((r) => r.target_kind === 'objective').slice(0, Number(LC.layers.batch) || 20).map((r) => r.target_id);
        if (obs.length) await computeLayers(env, obs);
        const les = (p.rows || []).filter((r) => r.target_kind === 'lesson').slice(0, 10).map((r) => r.target_id);
        if (les.length) await computeLessonConfidence(env, les);
        out.penetration = (out.penetration || 0) + 1;
      }
      await env.DB.prepare('DELETE FROM mk_penetration_queue WHERE subject_id = ?').bind(sub).run();
    }
  }
  // 7. Coverage and gaps: daily, and again (at most every coverage.refresh_hours) while sources wait at the gaps stage.
  if (room(60)) {
    const cov = J(await getSetting(env, 'lc_cov'), {}) || {}, hour = new Date().getUTCHours();
    const daily = cov.day !== day && hour >= (Number(LC.coverage.utc_hour) || 0);
    const runs = cov.day === day ? Number(cov.runs) || 0 : 0;
    const wanted = ctx.coverageWanted && runs < (Number(LC.coverage.runs_per_day_max) || 4);
    if (!cov.at || daily || wanted) {
      const r = await coverageAndGaps(env);
      await setSetting(env, 'lc_cov', JSON.stringify({ day: r.day, at: nowIso(), runs: (r.day === cov.day ? runs : 0) + 1, gaps: r.gaps, opened: r.opened, resolved: r.resolved, writes: r.coverage_writes + r.writes }));
      out.coverage = r.day;
    }
  }
  // 8. A rotating write-on-diff pass over layers and confidence, so time-dependent factors age (derived.pass_hours).
  if (room(40)) {
    const dv = J(await getSetting(env, 'lc_derived'), {}) || {};
    if (dv.phase && dv.phase !== 'done' || Date.now() - Date.parse(dv.finished || 0) > (Number((LC.derived || {}).pass_hours) || 168) * 3600e3) {
      if (!dv.phase || dv.phase === 'done') Object.assign(dv, { phase: 'layers', cursor: '', started: nowIso() });
      const B = dv.phase === 'layers' ? Number(LC.layers.batch) || 20 : Number(LC.confidence.batch) || 40;
      while (room(40) && dv.phase !== 'done') {
        const sql = dv.phase === 'layers' ? `SELECT id FROM mk_objects WHERE type = 'Objective' AND id LIKE '${OBJ.id_prefix}%' AND status IN ('current','modified') AND id > ? ORDER BY id LIMIT ?`
          : dv.phase === 'confidence' ? `SELECT id FROM mk_objects WHERE type IN ('Recommendation','Claim','EvidenceObject','EducationalObject') AND status IN ('current','modified') AND id > ? ORDER BY id LIMIT ?`
          : `SELECT id FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.%' AND status = 'current' AND id > ? ORDER BY id LIMIT ?`;
        const ids = (await env.DB.prepare(sql).bind(dv.cursor || '', B).all()).results.map((r) => r.id);
        if (dv.phase === 'layers') await computeLayers(env, ids); else if (dv.phase === 'confidence') await computeObjectConfidence(env, ids); else await computeLessonConfidence(env, ids);
        if (ids.length < B) { dv.cursor = ''; dv.phase = dv.phase === 'layers' ? 'confidence' : dv.phase === 'confidence' ? 'lessons' : 'done'; if (dv.phase === 'done') dv.finished = nowIso(); }
        else dv.cursor = ids[ids.length - 1];
        await setSetting(env, 'lc_derived', JSON.stringify(dv));
      }
    }
  }
  return out;
}

/* Lifecycle counts for the status operation. */
export async function lifecycleStatus(env, { light = false } = {}) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const rows = await q('SELECT stages_json FROM mk_lifecycle');
  const stages = Object.fromEntries(STAGES.map((k) => [k, {}]));
  for (const r of rows) { const d = J(r.stages_json, {}) || {}; for (const k of STAGES) { const s = ((d.stages || {})[k] || {}).state || 'pending'; stages[k][s] = (stages[k][s] || 0) + 1; } }
  const one = async (sql, ...a) => ((await env.DB.prepare(sql).bind(...a).first()) || {}).n || 0;
  if (light) return { sources: rows.length, by_status: Object.fromEntries((await q('SELECT status, COUNT(*) AS n FROM mk_lifecycle GROUP BY status')).map((r) => [r.status, r.n])), stages };
  return {
    sources: rows.length, by_status: Object.fromEntries((await q('SELECT status, COUNT(*) AS n FROM mk_lifecycle GROUP BY status')).map((r) => [r.status, r.n])), stages,
    pending_engine: LC.stages.filter((s) => !s.implemented).map((s) => s.key),
    concept_classes: Object.fromEntries((await q("SELECT dst, COUNT(*) AS n FROM mk_edges WHERE rel = 'classified_as' AND status = 'current' GROUP BY dst")).map((r) => [r.dst.replace(/^cls\./, ''), r.n])),
    canonical_objectives: await one("SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'Objective' AND id LIKE ?", OBJ.id_prefix + '%'),
    projection_edges: await one(`SELECT COUNT(*) AS n FROM mk_edges WHERE rel = '${OBJ.projection_relation}' AND status = 'current'`),
    relevance: { rows: await one('SELECT COUNT(*) AS n FROM mk_relevance'), objects: await one('SELECT COUNT(DISTINCT object_id) AS n FROM mk_relevance'), dirty: await one('SELECT COUNT(*) AS n FROM mk_relevance_dirty'),
      by_band: Object.fromEntries((await q('SELECT band, COUNT(*) AS n FROM mk_relevance GROUP BY band')).map((r) => [r.band, r.n])), rules: RULES_V },
    passes: { classes: J(await getSetting(env, 'lc_cls'), null), objectives: J(await getSetting(env, 'lc_obj'), null), relevance: J(await getSetting(env, 'lc_rel'), null) },
  };
}
export { enterLifecycle };
