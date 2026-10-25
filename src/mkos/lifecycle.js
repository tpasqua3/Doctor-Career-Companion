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
import { RULES_V, objectiveOf, objectiveSet, computeConceptRows, computeObjectRows, ensureProjectionEdges, ensureView, marked, mark, examProjection, hopEdges as hopEdgesOf } from './relevance.js';

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
  // A new objective changes the rows of every concept within max_hops of its anchor: those are recomputed (catch-up), nothing else.
  if (made.length) await invalidateAround(env, made);
  return n;
}
export async function invalidateAround(env, anchors) {
  let ring = [...anchors]; const all = new Set(anchors);
  for (let h = 0; h < (Number(LC.relevance.max_hops) || 1) && ring.length; h++) {
    const next = [];
    for (const e of await hopEdgesOf(env, ring.slice(0, 400))) for (const x of [e.src, e.dst]) if (!all.has(x)) { all.add(x); next.push(x); }
    ring = next;
  }
  const list = [...all];
  for (let i = 0; i < list.length; i += 90) { const part = list.slice(i, i + 90); await env.DB.prepare(`DELETE FROM mk_relevance_marks WHERE object_id IN (${ph(part.length)})`).bind(...part).run(); }
  return list.length;
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
  // 4. Relevance mapped: canonical objectives for its concepts, then their concept rows and the rows of every object attached to them.
  if (S.relevance_mapped.state !== 'done') {
    if (!ctx.objectivesReady) return 'waiting';
    const tag = ctx.tag, todo = await unmarked(env, concepts, tag);
    if (todo.length) {
      const part = todo.slice(0, O.concept_batch);
      await ensureObjectives(env, part, ctx.objectives);
      await computeConceptRows(env, part, tag, ctx.objectives);
      if (todo.length > part.length) return 'continues';
    }
    // The rows of the source's own objects (its recommendations and what was derived from them), over every concept they attach to:
    // concepts computed earlier keep their rows, but the objects this source just added need theirs. Resumable by position.
    const pos = Number(S.relevance_mapped.pos) || 0;
    if (pos < concepts.length) {
      const part = concepts.slice(pos, pos + O.concept_batch);
      await computeObjectRows(env, part, tag);
      S.relevance_mapped = { state: 'pending', pos: pos + part.length, at: nowIso() };
      if (pos + part.length < concepts.length) { await save(); return 'continues'; }
    }
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
  return 'finished';
}

/* ---------- The orchestrator: one slice per engine run ---------- */
export async function lifecycleStep(env, deps, { meter = null, cap = Infinity } = {}) {
  // A unit starts only while the run has room for it: the reserve scales with the budget, so small (free-plan) budgets still advance.
  const room = (reserve = 25) => !meter || meter.n < Math.min(cap, meter.max * (Number(O.budget_share_max) || 0.9)) - Math.min(reserve, Math.max(3, Math.floor(meter.max * 0.25)));
  const out = { entered: 0, advanced: 0, classes: 0, objectives: 0, relevance: 0 };
  await ensureView(env);
  await seedClasses(env);
  // Every source has a record: existing sources enter once (new and changed ones enter from the scanner, ingest.js).
  const fresh = JSON.stringify({ started: nowIso(), event: 'backfill', stages: freshStages(), history: [] }), at = nowIso();
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO mk_lifecycle (source_id, stage, stages_json, status, source_v, cycle, created_at, updated_at)
    SELECT o.id, 'ingested', ?, 'waiting', o.version, 1, ?, ? FROM mk_objects o WHERE o.type = 'Source' AND o.status != 'retired' AND NOT EXISTS (SELECT 1 FROM mk_lifecycle l WHERE l.source_id = o.id) LIMIT 300`).bind(fresh, at, at).run();
  out.entered = (ins.meta && ins.meta.changes) || 0;
  const obj = J(await getSetting(env, 'lc_obj'), {}) || {}, rel = J(await getSetting(env, 'lc_rel'), {}) || {};
  if (rel.v !== RULES_V) { rel.v = RULES_V; rel.sweep = (rel.sweep || 0) + 1; rel.cursor = ''; rel.started = nowIso(); rel.phase = 'compute'; await setSetting(env, 'lc_rel', JSON.stringify(rel)); }
  const ctx = { tag: rel.v + '.' + rel.sweep, objectives: await objectiveSet(env), objectivesReady: !!obj.passes, concepts: {}, projected: false };
  // 1. Sources, round robin.
  const cur = (await getSetting(env, 'lc_src')) || '';
  let list = (await env.DB.prepare("SELECT source_id FROM mk_lifecycle WHERE status IN ('waiting','in_progress','blocked') AND source_id > ? ORDER BY source_id LIMIT ?").bind(cur, O.sources_per_run).all()).results.map((r) => r.source_id);
  if (list.length < O.sources_per_run) list = [...list, ...(await env.DB.prepare("SELECT source_id FROM mk_lifecycle WHERE status IN ('waiting','in_progress','blocked') AND source_id <= ? ORDER BY source_id LIMIT ?").bind(cur, O.sources_per_run - list.length).all()).results.map((r) => r.source_id)];
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
  // 5. The relevance sweep: every concept's rows and the rows of the objects attached to it, then the rows of the previous sweep go.
  if (ctx.objectivesReady && room(40)) {
    const due = rel.phase === 'compute' || rel.phase === 'cleanup' || (rel.phase === 'idle' && Date.now() - Date.parse(rel.started || 0) > (Number(LC.relevance.sweep_hours) || 24) * 3600e3);
    if (due && rel.phase === 'idle') { rel.sweep++; rel.cursor = ''; rel.started = nowIso(); rel.phase = 'compute'; ctx.tag = rel.v + '.' + rel.sweep; await setSetting(env, 'lc_rel', JSON.stringify(rel)); }
    while (rel.phase === 'compute' && room(40)) {
      const ids = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Concept' AND status IN ('current','modified') AND gov NOT IN ('rejected') AND id > ? ORDER BY id LIMIT ?").bind(rel.cursor || '', O.concept_batch).all()).results.map((r) => r.id);
      const todo = await unmarked(env, ids, ctx.tag);
      if (todo.length) { await computeConceptRows(env, todo, ctx.tag, ctx.objectives); out.relevance += await computeObjectRows(env, todo, ctx.tag); }
      if (ids.length < O.concept_batch) { rel.phase = 'cleanup'; rel.cursor = ''; } else rel.cursor = ids[ids.length - 1];
      await setSetting(env, 'lc_rel', JSON.stringify(rel));
    }
    // Between sweeps: concepts not computed at this sweep's tag (new, or near a new objective) catch up.
    while (rel.phase === 'idle' && room(40)) {
      const ids = (await env.DB.prepare(`SELECT o.id FROM mk_objects o WHERE o.type = 'Concept' AND o.status IN ('current','modified') AND o.gov NOT IN ('rejected')
        AND NOT EXISTS (SELECT 1 FROM mk_relevance_marks m WHERE m.object_id = o.id AND m.computed_v = ?) ORDER BY o.id LIMIT ?`).bind(ctx.tag, O.concept_batch).all()).results.map((r) => r.id);
      if (!ids.length) break;
      await computeConceptRows(env, ids, ctx.tag, ctx.objectives); out.relevance += await computeObjectRows(env, ids, ctx.tag);
      if (ids.length < O.concept_batch) break;
    }
    while (rel.phase === 'cleanup' && room(10)) {
      const a = await env.DB.prepare('DELETE FROM mk_relevance WHERE rowid IN (SELECT rowid FROM mk_relevance WHERE computed_v != ? LIMIT 2000)').bind(ctx.tag).run();
      const b = await env.DB.prepare('DELETE FROM mk_relevance_marks WHERE rowid IN (SELECT rowid FROM mk_relevance_marks WHERE computed_v != ? AND object_id NOT LIKE ? LIMIT 2000)').bind(ctx.tag, 'class:%').run();
      if (!((a.meta && a.meta.changes) || 0) && !((b.meta && b.meta.changes) || 0)) { rel.phase = 'idle'; rel.finished = nowIso(); }
      await setSetting(env, 'lc_rel', JSON.stringify(rel));
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
    relevance: { rows: await one('SELECT COUNT(*) AS n FROM mk_relevance'), objects: await one('SELECT COUNT(DISTINCT object_id) AS n FROM mk_relevance'),
      by_band: Object.fromEntries((await q('SELECT band, COUNT(*) AS n FROM mk_relevance GROUP BY band')).map((r) => [r.band, r.n])), rules: RULES_V },
    passes: { classes: J(await getSetting(env, 'lc_cls'), null), objectives: J(await getSetting(env, 'lc_obj'), null), relevance: J(await getSetting(env, 'lc_rel'), null) },
  };
}
export { enterLifecycle };
