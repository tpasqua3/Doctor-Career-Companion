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

const LC = FRAMEWORK.frameworks.lifecycle, R = LC.relevance, OBJ = LC.objectives;
export const RULES_V = 'r' + R.version + '.' + LC.version;
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
const UPSERT = `ON CONFLICT (object_id, objective_id) DO UPDATE SET
  score = CASE WHEN mk_relevance.computed_v != excluded.computed_v OR excluded.score > mk_relevance.score THEN excluded.score ELSE mk_relevance.score END,
  band = CASE WHEN mk_relevance.computed_v != excluded.computed_v OR excluded.score > mk_relevance.score THEN excluded.band ELSE mk_relevance.band END,
  basis_json = CASE WHEN mk_relevance.computed_v != excluded.computed_v OR excluded.score > mk_relevance.score THEN excluded.basis_json ELSE mk_relevance.basis_json END,
  computed_v = excluded.computed_v, updated = excluded.updated`;

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

/* Compute and store the concept rows of `concepts` at tag (rules version + sweep). Returns rows written. */
export async function computeConceptRows(env, concepts, tag, objectives) {
  if (!concepts.length) return 0;
  const e1 = await hopEdges(env, concepts), n1 = new Set();
  for (const e of e1) for (const x of [e.src, e.dst]) if (!concepts.includes(x)) n1.add(x);
  const edges = (Number(R.max_hops) || 1) >= 2 ? [...e1, ...(await hopEdges(env, [...n1]))] : e1;
  const adj = adjacency(edges), at = nowIso(), rows = [];
  for (const a of concepts) rows.push(...conceptRows(a, adj, objectives));
  await writeRows(env, rows, tag, at);
  const counts = {}; for (const r of rows) counts[r.object_id] = (counts[r.object_id] || 0) + 1;
  await mark(env, concepts.map((c) => [c, counts[c] || 0]), tag);
  return rows.length;
}
async function writeRows(env, rows, tag, at) {
  const per = 14, stmts = [];   // 7 columns x 14 rows = 98 bound parameters
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    stmts.push(env.DB.prepare(`INSERT INTO mk_relevance (object_id, objective_id, score, band, basis_json, computed_v, updated) VALUES ${part.map(() => '(?,?,?,?,?,?,?)').join(',')} ${UPSERT}`)
      .bind(...part.flatMap((r) => [r.object_id, r.objective_id, r.score, r.band, JSON.stringify(r.basis), tag, at])));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
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

/* Object rows for every knowledge object attached to `concepts` (one INSERT ... SELECT per attachment rule, on the server). The concept
   rows of these concepts must be written at the same tag first. */
const TYPES = R.object_types.map(lit).join(','), GOV = R.excluded_governance.map(lit).join(',');
function attachSql(rule, ph) {
  if (rule.via) return `SELECT d.src AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e JOIN mk_edges d ON d.dst = e.dst AND d.rel = ${lit(rule.via)} AND d.status = 'current'
    WHERE e.rel = 'recommended_by' AND e.status = 'current' AND e.src IN (${ph})`;
  return rule.object_is === 'dst'
    ? `SELECT e.dst AS obj, e.src AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.src IN (${ph})`
    : `SELECT e.src AS obj, e.dst AS c, ${Number(rule.factor)} AS f, '${rule.rel}' AS a FROM mk_edges e WHERE e.rel = ${lit(rule.rel)} AND e.status = 'current' AND e.dst IN (${ph})`;
}
export const ATTACH = [...R.attachments, { rel: 'via_recommendation', via: R.via_recommendation.rel, factor: R.via_recommendation.factor }];
export async function computeObjectRows(env, concepts, tag) {
  if (!concepts.length) return 0;
  const at = nowIso(), stmts = [];
  for (let i = 0; i < concepts.length; i += 40) {
    const part = concepts.slice(i, i + 40), ph = part.map(() => '?').join(',');
    for (const rule of ATTACH) stmts.push(env.DB.prepare(`INSERT INTO mk_relevance (object_id, objective_id, score, band, basis_json, computed_v, updated)
      SELECT obj, objective_id, ROUND(s, 4), ${BAND_SQL}, json_object('attach', a, 'factor', f, 'via', c, 'path', p), ?, ? FROM (
        SELECT x.obj AS obj, r.objective_id AS objective_id, MAX(x.f * r.score) AS s, x.a AS a, x.f AS f, x.c AS c, json_extract(r.basis_json, '$.path') AS p
        FROM (${attachSql(rule, ph)}) x JOIN mk_relevance r ON r.object_id = x.c AND r.computed_v = ? JOIN mk_objects o ON o.id = x.obj
        WHERE o.type IN (${TYPES}) AND o.type != 'Concept' AND o.status IN ('current','modified') AND o.gov NOT IN (${GOV}) AND o.id NOT LIKE '${OBJ.id_prefix}%' AND o.id NOT LIKE 'ea.%'
        GROUP BY x.obj, r.objective_id HAVING s >= ${MIN - 1e-9}) WHERE 1 ${UPSERT}`).bind(tag, at, ...part, tag));
  }
  let n = 0;
  for (let i = 0; i < stmts.length; i += 20) for (const r of await env.DB.batch(stmts.slice(i, i + 20))) n += (r.meta && r.meta.changes) || 0;
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
