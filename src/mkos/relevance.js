// THE WEIGHTED RELEVANCE GRAPH (lifecycle stages 3 and 4; mkos/ontology/lifecycle.json "relevance", "objectives", "exam_projection").
// No binary mapping: every knowledge object relates to many exam-independent canonical objectives (obj.c.<concept>), each with a score
// 0..1 and its band, computed by deterministic rules from graph paths and relation types. Exams are projections of that graph: an
// exam's relevance for an object is max over the object's objectives of (relevance x the topic's blueprint weight), computed on read
// (examProjection, and the view mk_exam_relevance), never stored per exam, so a new exam needs only its blueprint.
//
//   concept rows (JS):    concept a -> objective of b    score = product of hop weights on the best path a..b (<= max_hops), 1.0 for a = b
//   object rows (SQL):    object o  -> objective          score = attachment factor (o to concept a) x score(a -> objective)
//
// mk_relevance is derived: rebuilt by the sweep (lifecycle.js) from objects, edges and the rule table; never mirrored to Drive.
import { FRAMEWORK } from './framework.js';
import { nowIso } from './db.js';
import { markDirty } from './dirty.js';

const LC = FRAMEWORK.frameworks.lifecycle, R = LC.relevance, OBJ = LC.objectives;
// The rules version: rows carry it as computed_v; a change marks every object dirty (a resumable backfill, lifecycle.js).
export const RULES_V = R.rules_version || ('r' + R.version + '.' + LC.version);
const HOPS = R.hops, HOP_RELS = Object.keys(HOPS);
const MIN = Number(R.min_score), CAP = Number(R.max_per_object) || 400;
const BANDS = [...R.bands].sort((a, b) => a.value - b.value);
const lit = (s) => "'" + String(s).replace(/[^A-Za-z0-9_.]/g, '') + "'";

export const objectiveOf = (conceptId) => OBJ.id_prefix + String(conceptId).replace(/^c\./, '');
export const conceptOfObjective = (objId) => 'c.' + String(objId).slice(OBJ.id_prefix.length);

// The band nearest a score (a tie goes to the lower band).
export function bandOf(score) {
  let best = BANDS[0];
  for (const b of BANDS) if (Math.abs(score - b.value) < Math.abs(score - best.value) - 1e-12) best = b;
  return best.key;
}
// The same rule as a SQL CASE over the column `s` (midpoints between neighbouring bands; strictly above a midpoint is the upper band).
const BAND_SQL = (() => {
  const parts = [];
  for (let i = BANDS.length - 1; i > 0; i--) parts.push(`WHEN s > ${((BANDS[i].value + BANDS[i - 1].value) / 2).toFixed(4)} THEN '${BANDS[i].key}'`);
  return `CASE ${parts.join(' ')} ELSE '${BANDS[0].key}' END`;
})();

/* Concept-to-concept edges of the hop relations touching `ids` (both directions), chunked under D1's 100 bound parameters. */
export async function hopEdges(env, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40), ph = part.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT src, rel, dst, conf FROM mk_edges WHERE status = 'current' AND rel IN (${HOP_RELS.map(lit).join(',')})
      AND (src IN (${ph}) OR dst IN (${ph}))`).bind(...part, ...part).all();
    for (const e of results) if (e.src !== e.dst && e.src.startsWith('c.') && e.dst.startsWith('c.')) out.push(e);
  }
  return out;
}
const adjacency = (edges) => {
  const adj = new Map(), add = (a, b, e) => { const w = HOPS[e.rel]; if (!w) return; const m = adj.get(a) || new Map(); const cur = m.get(b); if (!cur || cur.w < w) m.set(b, { w, rel: e.rel, conf: e.conf }); adj.set(a, m); };
  for (const e of edges) { add(e.src, e.dst, e); add(e.dst, e.src, e); }
  return adj;
};

/* Pure: the relevance rows of one concept from its adjacency (tests use this directly). objectives: Set of canonical objective ids. */
export function conceptRows(a, adj, objectives) {
  const best = new Map();
  const offer = (target, score, basis) => {
    const oid = objectiveOf(target); if (!objectives.has(oid) || score < MIN - 1e-12) return;
    const cur = best.get(oid); if (!cur || cur.score < score) best.set(oid, { score, basis });
  };
  offer(a, Number(R.self.factor) || 1, { path: 'self' });
  const n1 = adj.get(a) || new Map();
  for (const [b, h1] of n1) offer(b, h1.w, { path: h1.rel, via: [b], conf: h1.conf });
  if ((Number(R.max_hops) || 1) >= 2) for (const [b, h1] of n1) for (const [c, h2] of adj.get(b) || new Map()) if (c !== a) offer(c, h1.w * h2.w, { path: h1.rel + '>' + h2.rel, via: [b, c], conf: Math.min(h1.conf, h2.conf) });
  return [...best].map(([objective_id, x]) => ({ object_id: a, objective_id, score: Math.round(x.score * 10000) / 10000, band: bandOf(x.score), basis: x.basis }))
    .sort((x, y) => y.score - x.score || x.objective_id.localeCompare(y.objective_id)).slice(0, CAP);
}

// Every canonical objective id (one query; a few thousand short ids).
export async function objectiveSet(env) {
  return new Set((await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Objective' AND id LIKE ? AND status IN ('current','modified')").bind(OBJ.id_prefix + '%').all()).results.map((r) => r.id));
}

/* ---------- Recompute only what changed (dirty.js): new rows inserted, changed rows updated, stale rows deleted, unchanged rows untouched.
   Every write is checked against the stored row first (score, band, basis), and the upsert repeats the check in its WHERE, so a recompute
   of an object whose relevance did not change writes nothing. computed_v is the rules version at which the row last changed. ---------- */
const same = (a, b) => a && b && a.score === b.score && a.band === b.band && a.basis_json === b.basis_json;
const UPSERT_CHANGED = `ON CONFLICT (object_id, objective_id) DO UPDATE SET score = excluded.score, band = excluded.band, basis_json = excluded.basis_json,
  computed_v = excluded.computed_v, updated = excluded.updated
  WHERE mk_relevance.score != excluded.score OR mk_relevance.band != excluded.band OR mk_relevance.basis_json != excluded.basis_json`;
async function storedRows(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { results } = await env.DB.prepare('SELECT object_id, objective_id, score, band, basis_json FROM mk_relevance WHERE object_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids.slice(i, i + 200))).all();
    for (const r of results) out.set(r.object_id + '|' + r.objective_id, r);
  }
  return out;
}
/* Pure: the writes that bring `stored` (Map key -> row) to `want` (rows) for the objects `ids`: { put: [rows], del: [[object, objective]], changed: Set(object) }. */
export function diffRows(ids, want, stored) {
  const put = [], del = [], changed = new Set(), keep = new Set();
  for (const r of want) { const k = r.object_id + '|' + r.objective_id; keep.add(k); if (!same(r, stored.get(k))) { put.push(r); changed.add(r.object_id); } }
  const idset = new Set(ids);
  for (const [k, r] of stored) if (idset.has(r.object_id) && !keep.has(k)) { del.push([r.object_id, r.objective_id]); changed.add(r.object_id); }
  return { put, del, changed };
}
async function applyDiff(env, d, at) {
  const stmts = [];
  for (let i = 0; i < d.put.length; i += 14) {     // 7 columns x 14 rows = 98 bound parameters
    const part = d.put.slice(i, i + 14);
    stmts.push(env.DB.prepare(`INSERT INTO mk_relevance (object_id, objective_id, score, band, basis_json, computed_v, updated) VALUES ${part.map(() => '(?,?,?,?,?,?,?)').join(',')} ${UPSERT_CHANGED}`)
      .bind(...part.flatMap((r) => [r.object_id, r.objective_id, r.score, r.band, r.basis_json, RULES_V, at])));
  }
  const byObj = new Map(); for (const [o, t] of d.del) (byObj.get(o) || byObj.set(o, []).get(o)).push(t);
  for (const [o, ts] of byObj) stmts.push(env.DB.prepare('DELETE FROM mk_relevance WHERE object_id = ? AND objective_id IN (SELECT value FROM json_each(?))').bind(o, JSON.stringify(ts)));
  let n = 0;
  for (let i = 0; i < stmts.length; i += 40) for (const r of await env.DB.batch(stmts.slice(i, i + 40))) n += (r.meta && r.meta.changes) || 0;
  return n;
}
const ELIGIBLE_CONCEPT = `type = 'Concept' AND status IN ('current','modified') AND gov NOT IN (${R.excluded_governance.map(lit).join(',')})`;
/* The concept rows `concepts` should have now (an ineligible or missing concept has none). */
export async function expectedConceptRows(env, concepts, objectives) {
  if (!concepts.length) return [];
  const live = (await env.DB.prepare(`SELECT id FROM mk_objects WHERE id IN (SELECT value FROM json_each(?)) AND ${ELIGIBLE_CONCEPT}`).bind(JSON.stringify(concepts)).all()).results.map((r) => r.id);
  if (!live.length) return [];
  const e1 = await hopEdges(env, live), n1 = new Set();
  for (const e of e1) for (const x of [e.src, e.dst]) if (!live.includes(x)) n1.add(x);
  const edges = (Number(R.max_hops) || 1) >= 2 ? [...e1, ...(await hopEdges(env, [...n1]))] : e1;
  const adj = adjacency(edges), rows = [];
  for (const a of live) for (const r of conceptRows(a, adj, objectives)) rows.push({ object_id: r.object_id, objective_id: r.objective_id, score: r.score, band: r.band, basis_json: JSON.stringify(r.basis) });
  return rows;
}
/* Recompute the concept rows of `concepts`; returns { writes, changed: [concept ids whose rows changed] }. */
export async function recomputeConcepts(env, concepts, objectives) {
  if (!concepts.length) return { writes: 0, changed: [] };
  const d = diffRows(concepts, await expectedConceptRows(env, concepts, objectives), await storedRows(env, concepts));
  return { writes: await applyDiff(env, d, nowIso()), changed: [...d.changed] };
}
export async function mark(env, list, tag) {
  const at = nowIso(), stmts = [];
  for (let i = 0; i < list.length; i += 25) { const part = list.slice(i, i + 25);
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO mk_relevance_marks (object_id, computed_v, n, at) VALUES ${part.map(() => '(?,?,?,?)').join(',')}`).bind(...part.flatMap(([id, n]) => [id, tag, n, at]))); }
  if (stmts.length) await env.DB.batch(stmts);
}
// Which of `ids` are marked at `tag`.
export async function marked(env, ids, tag) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90);
    for (const r of (await env.DB.prepare(`SELECT object_id FROM mk_relevance_marks WHERE computed_v = ? AND object_id IN (${part.map(() => '?').join(',')})`).bind(tag, ...part).all()).results) out.add(r.object_id); }
  return out;
}

/* Object rows: score = attachment factor (object to concept a) x score(a -> objective), the best path over every attachment of the object.
   attachSql: the attachments of the concepts in a set (to find objects to mark); byObjSql: the attachments of the objects in a set (to
   compute their rows). The set is one JSON parameter (json_each), so any batch stays far under D1's 100 bound parameters. */
const TYPES = R.object_types.map(lit).join(','), GOV = R.excluded_governance.map(lit).join(',');
const SET = (n) => `(SELECT value FROM json_each(?${n}))`;
function attachSql(rule, set) {
  if (rule.via) return `SELECT d.src AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e JOIN mk_edges d ON d.dst = e.dst AND d.rel = ${lit(rule.via)} AND d.status = 'current'
    WHERE e.rel = 'recommended_by' AND e.status = 'current' AND e.src IN ${set}`;
  return rule.object_is === 'dst'
    ? `SELECT e.dst AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.src IN ${set}`
    : `SELECT e.src AS obj, e.dst AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.dst IN ${set}`;
}
function byObjSql(rule, set) {
  if (rule.via) return `SELECT d.src AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges d JOIN mk_edges e ON e.dst = d.dst AND e.rel = 'recommended_by' AND e.status = 'current'
    WHERE d.rel = ${lit(rule.via)} AND d.status = 'current' AND d.src IN ${set}`;
  return rule.object_is === 'dst'
    ? `SELECT e.dst AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.dst IN ${set}`
    : `SELECT e.src AS obj, e.dst AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.src IN ${set}`;
}
export const ATTACH = [...R.attachments, { rel: 'via_recommendation', via: R.via_recommendation.rel, factor: R.via_recommendation.factor }];
const ELIGIBLE_OBJECT = `o.type IN (${TYPES}) AND o.type != 'Concept' AND o.status IN ('current','modified') AND o.gov NOT IN (${GOV}) AND o.id NOT LIKE '${OBJ.id_prefix}%' AND o.id NOT LIKE 'ea.%'`;
// The rows the objects in ?1 should have now (the best path per objective; ties broken by attachment then concept, so it is deterministic).
const EXPECTED_OBJECT_SQL = `WITH x AS (${ATTACH.map((r) => byObjSql(r, SET(1))).join(' UNION ALL ')}),
  cand AS (SELECT x.obj AS obj, r.objective_id AS objective_id, x.f * r.score AS s, x.a AS a, x.f AS f, x.c AS c, json_extract(r.basis_json, '$.path') AS p
    FROM x JOIN mk_relevance r ON r.object_id = x.c JOIN mk_objects o ON o.id = x.obj WHERE ${ELIGIBLE_OBJECT}),
  best AS (SELECT obj, objective_id, s, a, f, c, p, ROW_NUMBER() OVER (PARTITION BY obj, objective_id ORDER BY s DESC, a, c) AS rn FROM cand WHERE s >= ${MIN - 1e-9})
  SELECT obj AS object_id, objective_id, ROUND(s, 4) AS score, ${BAND_SQL} AS band, json_object('attach', a, 'factor', f, 'via', c, 'path', p) AS basis_json FROM best WHERE rn = 1`;
export async function expectedObjectRows(env, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 40) out.push(...(await env.DB.prepare(EXPECTED_OBJECT_SQL).bind(JSON.stringify(ids.slice(i, i + 40))).all()).results);
  return out;
}
/* Recompute the rows of knowledge objects `ids` (not concepts; their concepts' rows must be current). Returns { writes, changed }. */
export async function recomputeObjects(env, ids) {
  if (!ids.length) return { writes: 0, changed: [] };
  const d = diffRows(ids, await expectedObjectRows(env, ids), await storedRows(env, ids));
  return { writes: await applyDiff(env, d, nowIso()), changed: [...d.changed] };
}
/* Mark dirty every knowledge object attached to `concepts` (their concept rows changed): one INSERT ... SELECT on the server. */
export async function markAttached(env, concepts, reason = 'concept_rows_changed') {
  if (!concepts.length) return 0;
  let n = 0;
  for (let i = 0; i < concepts.length; i += 200) {
    const r = await env.DB.prepare(`INSERT INTO mk_relevance_dirty (object_id, radius, reason, marked_at)
      SELECT DISTINCT x.obj, -1, ?2, ?3 FROM (${ATTACH.map((r) => attachSql(r, SET(1))).join(' UNION ALL ')}) x JOIN mk_objects o ON o.id = x.obj WHERE o.type IN (${TYPES}) AND o.type != 'Concept'
      ON CONFLICT (object_id) DO NOTHING`).bind(JSON.stringify(concepts.slice(i, i + 200)), reason, nowIso()).run();
    n += (r.meta && r.meta.changes) || 0;
  }
  return n;
}

/* PROJECTION EDGES: each current BlueprintTopic projects onto the canonical objective of every concept it names (its blueprint concept
   mapping). One statement, idempotent; only topics and objectives that exist. */
export async function ensureProjectionEdges(env) {
  const at = nowIso();
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO mk_edges (src, rel, dst, status, conf, prov, created, updated)
    SELECT DISTINCT t.id, '${OBJ.projection_relation}', o.id, 'current', 95, '[{"method":"exam_projection","via":"blueprint_concept_mapping","at":"' || ?1 || '"}]', ?1, ?1
    FROM mk_objects t, json_each(t.body, '$.concepts') j JOIN mk_objects o ON o.id = '${OBJ.id_prefix}' || substr(j.value, 3)
    WHERE t.type = 'BlueprintTopic' AND t.status = 'current' AND j.value LIKE 'c.%'`).bind(at).run();
  return (r.meta && r.meta.changes) || 0;
}

// Created once per database binding (best effort: examProjection does not depend on it).
const VIEW = new WeakSet();
export async function ensureView(env) {
  if (VIEW.has(env.DB)) return true;
  try {
    await env.DB.prepare(`CREATE VIEW IF NOT EXISTS mk_exam_relevance AS SELECT r.object_id AS object_id, bo.blueprint_id AS blueprint_id, MAX(r.score * bo.priority_score / 100.0) AS relevance
      FROM mk_relevance r JOIN mk_edges e ON e.dst = r.objective_id AND e.rel = '${OBJ.projection_relation}' AND e.status = 'current'
      JOIN mk_blueprint_objectives bo ON bo.objective_id = e.src GROUP BY r.object_id, bo.blueprint_id`).run();
    VIEW.add(env.DB); return true;
  } catch (e) { return false; }
}

async function blueprintFor(env, { blueprint_id = null, family = null } = {}) {
  if (blueprint_id) return blueprint_id;
  if (!family) return null;
  const r = await env.DB.prepare("SELECT blueprint_id FROM mk_blueprint_registries WHERE blueprint_family = ? AND current_status = 'current' ORDER BY updated_at DESC LIMIT 1").bind(family).first();
  return r ? r.blueprint_id : null;
}
/* EXAM PROJECTION: { object id: {relevance 0..1, objective_id, topic_id, score, weight} } for one blueprint (by id or family). */
export async function examProjection(env, ids, sel = {}) {
  const bp = await blueprintFor(env, sel), out = {}; if (!bp) return out;
  const list = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT r.object_id AS id, MAX(r.score * bo.priority_score / 100.0) AS relevance, r.objective_id AS objective_id, e.src AS topic_id, r.score AS score, bo.priority_score AS w
      FROM mk_relevance r JOIN mk_edges e ON e.dst = r.objective_id AND e.rel = '${OBJ.projection_relation}' AND e.status = 'current'
      JOIN mk_blueprint_objectives bo ON bo.objective_id = e.src AND bo.blueprint_id = ? WHERE r.object_id IN (${part.map(() => '?').join(',')}) GROUP BY r.object_id`).bind(bp, ...part).all();
    for (const r of results) out[r.id] = { relevance: Math.round(r.relevance * 10000) / 10000, objective_id: r.objective_id, topic_id: r.topic_id, score: r.score, weight: r.w / 100, blueprint_id: bp };
  }
  return out;
}
/* Every current blueprint's projection for these objects: { object id: { blueprint id: relevance } }. */
export async function examProjections(env, ids) {
  const bps = (await env.DB.prepare("SELECT blueprint_id, blueprint_family FROM mk_blueprint_registries WHERE current_status = 'current'").all()).results, out = {};
  for (const b of bps) for (const [id, x] of Object.entries(await examProjection(env, ids, { blueprint_id: b.blueprint_id }))) (out[id] = out[id] || {})[b.blueprint_family] = x.relevance;
  return out;
}

/* Exam weights of concepts read from the projection (BlueprintTopic records of a blueprint), for readers that used the concept's own
   board fields: { concept id: {est_pct, tier, importance, low_frequency, topic} }. bp: a blueprint id, or null for every current one. */
export async function conceptExamWeights(env, conceptIds, bp = null) {
  const out = {}, list = [...new Set(conceptIds)].filter(Boolean);
  for (let i = 0; i < list.length; i += 80) {
    const part = list.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT j.value AS c, MAX(COALESCE(json_extract(t.body, '$.est_pct'), 0)) AS est, json_extract(t.body, '$.tier') AS tier, json_extract(t.body, '$.importance') AS imp,
      json_extract(t.body, '$.low_frequency') AS lf, t.id AS topic, json_extract(t.body, '$.blueprint') AS bp
      FROM mk_objects t, json_each(t.body, '$.concepts') j WHERE t.type = 'BlueprintTopic' AND t.status = 'current' AND j.value IN (${part.map(() => '?').join(',')})
      ${bp ? "AND json_extract(t.body, '$.blueprint') = ?" : "AND json_extract(t.body, '$.blueprint') IN (SELECT blueprint_id FROM mk_blueprint_registries WHERE current_status = 'current')"} GROUP BY j.value`).bind(...part, ...(bp ? [bp] : [])).all();
    for (const r of results) out[r.c] = { est_pct: r.est || 0, tier: r.tier || '', importance: r.imp || '', low_frequency: !!r.lf, topic: r.topic, blueprint: r.bp };
  }
  return out;
}
/* The concept's board block as the concept bodies used to carry it (board.abim_weight, lka_weight, lka_tier, task_importance,
   low_frequency), built from the projection: kept for readers of the old shape. */
export async function boardFromProjection(env, conceptId) {
  const fams = FRAMEWORK.frameworks.blueprints.families, out = {};
  const bps = (await env.DB.prepare("SELECT blueprint_id, blueprint_family FROM mk_blueprint_registries WHERE current_status = 'current'").all()).results;
  for (const b of bps) {
    const w = (await conceptExamWeights(env, [conceptId], b.blueprint_id))[conceptId]; if (!w) continue;
    const f = fams.find((x) => x.id === b.blueprint_family) || {};
    out[f.legacy_concept_weight_field || b.blueprint_family + '_weight'] = w.est_pct;
    if (f.exam_key === 'lka') Object.assign(out, { lka_tier: w.tier, task_importance: w.importance, low_frequency: w.low_frequency });
    else if (!out.task_importance) out.task_importance = w.importance;
  }
  return out;
}

/* ---------- The dirty queue (dirty.js): expand seeds ring by ring, recompute concepts, then the objects attached to concepts that changed ----------
   Every unit is small and resumable: a seed's neighbours are marked with one radius less before the seed itself is lowered to -1, so an
   interrupted run simply continues. Objects wait until no concept is dirty, so they are always computed from current concept rows. */
const D = R.dirty || {};
const HOPS_LIST = HOP_RELS.map(lit).join(',');
const CHILD_RELS = "'derived_from','part_of'";
async function expandSeeds(env, seeds) {
  const cons = seeds.filter((s) => s.object_id.startsWith('c.') && s.radius > 0), other = seeds.filter((s) => !s.object_id.startsWith('c.') && s.radius > 0), marks = [];
  if (cons.length) {
    const rad = new Map(cons.map((s) => [s.object_id, s.radius]));
    // Any status: a concept just retired or superseded still reaches the neighbours whose rows pointed at it.
    const { results } = await env.DB.prepare(`SELECT src, dst FROM mk_edges WHERE rel IN (${HOPS_LIST}) AND (src IN ${SET(1)} OR dst IN ${SET(1)})`).bind(JSON.stringify([...rad.keys()])).all();
    for (const e of results) { if (!e.src.startsWith('c.') || !e.dst.startsWith('c.') || e.src === e.dst) continue;
      if (rad.has(e.src)) marks.push({ id: e.dst, radius: rad.get(e.src) - 1, reason: 'hop_radius' });
      if (rad.has(e.dst)) marks.push({ id: e.src, radius: rad.get(e.dst) - 1, reason: 'hop_radius' }); }
  }
  if (other.length) {
    const rad = new Map(other.map((s) => [s.object_id, s.radius]));
    const { results } = await env.DB.prepare(`SELECT src, dst FROM mk_edges WHERE rel IN (${CHILD_RELS}) AND dst IN ${SET(1)}`).bind(JSON.stringify([...rad.keys()])).all();
    for (const e of results) if (!/^(src\.|cn\.|bpt\.|ea\.)/.test(e.src)) marks.push({ id: e.src, radius: rad.get(e.dst) - 1, reason: 'derived_radius' });
  }
  if (marks.length) await markDirty(env, marks);
  // Lower each seed to -1 only at the radius it was expanded at (a higher mark that arrived meanwhile is expanded next time).
  const st = seeds.map((s) => env.DB.prepare('UPDATE mk_relevance_dirty SET radius = -1 WHERE object_id = ? AND radius = ?').bind(s.object_id, s.radius));
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return marks.length;
}
async function clear(env, ids) {
  for (let i = 0; i < ids.length; i += 200) await env.DB.prepare('DELETE FROM mk_relevance_dirty WHERE radius < 0 AND object_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids.slice(i, i + 200))).run();
}
/* Subjects whose relevance just changed, for penetration (impact.js): a knowledge object's source when it has one (a new guideline's
   recommendations aggregate into one subject), otherwise the object itself. */
async function queuePenetration(env, ids, reason) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 200) await env.DB.prepare(`INSERT OR IGNORE INTO mk_penetration_queue (subject_id, reason, marked_at)
    SELECT DISTINCT COALESCE(json_extract(o.body, '$.source_id'), o.id), ?2, ?3 FROM mk_objects o WHERE o.id IN ${SET(1)}`).bind(JSON.stringify(ids.slice(i, i + 200)), reason, nowIso()).run();
}
/* One slice of dirty work while room() allows. Returns counts. */
export async function processDirty(env, objectives, room, { trace = null } = {}) {
  const out = { expanded: 0, concepts: 0, objects: 0, writes: 0 };
  const cb = Number(D.concept_batch) || 30, ob = Number(D.object_batch) || 40, sb = Number(D.seed_batch) || 40;
  while (room()) {
    const seeds = (await env.DB.prepare('SELECT object_id, radius FROM mk_relevance_dirty WHERE radius >= 0 ORDER BY radius DESC LIMIT ?').bind(sb).all()).results;
    if (seeds.length) { out.expanded += seeds.length; await expandSeeds(env, seeds); continue; }
    const cons = (await env.DB.prepare("SELECT object_id FROM mk_relevance_dirty WHERE radius < 0 AND object_id LIKE 'c.%' LIMIT ?").bind(cb).all()).results.map((r) => r.object_id);
    if (cons.length) {
      if (trace) trace.concepts.push(...cons);
      const r = await recomputeConcepts(env, cons, objectives);
      await clear(env, cons);
      if (r.changed.length) await markAttached(env, r.changed);
      out.concepts += cons.length; out.writes += r.writes; continue;
    }
    const objs = (await env.DB.prepare('SELECT object_id FROM mk_relevance_dirty WHERE radius < 0 LIMIT ?').bind(ob).all()).results.map((r) => r.object_id);
    if (!objs.length) break;
    if (trace) trace.objects.push(...objs);
    const r = await recomputeObjects(env, objs);
    await clear(env, objs);
    if (r.changed.length) await queuePenetration(env, r.changed, 'relevance_changed');
    out.objects += objs.length; out.writes += r.writes;
  }
  return out;
}
export async function dirtyCount(env) { return ((await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_relevance_dirty').first()) || {}).n || 0; }

/* BACKFILL (a rules-version change, a restore, or the first run): every relevance object is marked, one id range at a time. Returns true
   when the whole store is marked. prog: {cursor}. */
export async function backfillStep(env, prog, room) {
  const at = nowIso(), per = Number(D.backfill_batch) || 500;
  while (room()) {
    const ids = (await env.DB.prepare(`SELECT id FROM mk_objects WHERE type IN (${TYPES}) AND id > ? AND id NOT LIKE '${OBJ.id_prefix}%' ORDER BY id LIMIT ?`).bind(prog.cursor || '', per).all()).results.map((r) => r.id);
    if (ids.length) await env.DB.prepare(`INSERT INTO mk_relevance_dirty (object_id, radius, reason, marked_at) SELECT value, -1, 'rules_backfill', ?2 FROM json_each(?1) WHERE 1
      ON CONFLICT (object_id) DO NOTHING`).bind(JSON.stringify(ids), at).run();
    if (ids.length < per) {
      // Rows of objects that no longer exist are marked too, so the recompute removes them.
      await markOrphans(env); prog.cursor = ''; return true;
    }
    prog.cursor = ids[ids.length - 1];
  }
  return false;
}
async function markOrphans(env) {
  const ids = (await env.DB.prepare(`SELECT DISTINCT r.object_id AS id FROM mk_relevance r LEFT JOIN mk_objects o ON o.id = r.object_id
    WHERE o.id IS NULL OR o.status NOT IN ('current','modified') OR o.gov IN (${GOV}) LIMIT 500`).all()).results.map((r) => r.id);
  if (ids.length) await markDirty(env, ids.map((id) => ({ id, radius: -1, reason: 'orphan_rows' })));
  return ids.length;
}

/* CONSISTENCY AUDIT (read only): a rotating pass that recomputes rows in memory and compares them with the stored rows; an object whose
   rows drifted (a change some write path did not mark) is marked dirty. It never rewrites a row itself. One pass, then it rests
   relevance.dirty.audit_hours. prog: {cursor, phase: concepts|objects|orphans, checked, drifted}. Returns true when the pass is done. */
export async function auditStep(env, prog, objectives, room) {
  prog.phase = prog.phase || 'concepts';
  const per = Number(D.audit_batch) || 40;
  while (room()) {
    if (prog.phase === 'orphans') { prog.drifted = (prog.drifted || 0) + await markOrphans(env); prog.phase = 'done'; return true; }
    const concept = prog.phase === 'concepts';
    const ids = (await env.DB.prepare(concept ? `SELECT id FROM mk_objects WHERE type = 'Concept' AND id > ? ORDER BY id LIMIT ?`
      : `SELECT id FROM mk_objects WHERE type IN (${TYPES}) AND type != 'Concept' AND id > ? AND id NOT LIKE '${OBJ.id_prefix}%' ORDER BY id LIMIT ?`).bind(prog.cursor || '', per).all()).results.map((r) => r.id);
    if (ids.length) {
      const want = concept ? await expectedConceptRows(env, ids, objectives) : await expectedObjectRows(env, ids);
      const d = diffRows(ids, want, await storedRows(env, ids));
      prog.checked = (prog.checked || 0) + ids.length;
      if (d.changed.size) { prog.drifted = (prog.drifted || 0) + d.changed.size; await markDirty(env, [...d.changed].map((id) => ({ id, radius: -1, reason: 'audit_drift' }))); }
    }
    if (ids.length < per) { prog.cursor = ''; prog.phase = concept ? 'objects' : 'orphans'; continue; }
    prog.cursor = ids[ids.length - 1];
  }
  return false;
}
