// RELEVANCE DIRTY FLAGS (lifecycle.json relevance.dirty): "determine once, store the result, update only when reality changes".
// The relevance graph (mk_relevance) is recomputed only for what a change touched. The write paths that change what relevance is built
// from (kb.js putObject, graph.js addEdges, canonical objectives) mark the changed object here with one small insert; the engine
// (relevance.js processDirty, run from the metered lifecycle step) expands the marks over the rule table's hop radius and recomputes
// just those objects, writing only rows whose score, band or basis differ.
//
// mk_relevance_dirty (object_id, radius, reason, marked_at) is both the work queue and the frontier of the expansion:
//   radius >= 0  a seed: its neighbours within `radius` more hops (concepts: hop relations; others: what is derived from it) are marked
//                with radius - 1, then the seed itself becomes radius -1;
//   radius = -1  recompute this object's rows, then clear the flag.
// A mark only ever raises the radius (one write; an equal or lower mark is a no-op). The table is derived run state: after a restore
// the relevance graph is empty and the backfill marks everything (lifecycle.js), so it is not mirrored to Drive.
import { FRAMEWORK } from './framework.js';
import { nowIso } from './db.js';

const LC = FRAMEWORK.frameworks.lifecycle, R = LC.relevance;
export const MAX_HOPS = Number(R.max_hops) || 1;
export const HOP_RELS = new Set(Object.keys(R.hops));
export const REL_TYPES = new Set(R.object_types);
const GOV_OUT = new Set(R.excluded_governance);
const OBJ_PREFIX = LC.objectives.id_prefix;
// Ids that never carry relevance rows of their own (sources, curriculum nodes, blueprint topics, assets, class nodes, canonical objectives).
const NO_ROWS = /^(src\.|cn\.|bpt\.|bp\.|ea\.|cls\.|obj\.c\.)/;

const SQL = `INSERT INTO mk_relevance_dirty (object_id, radius, reason, marked_at) VALUES %V
  ON CONFLICT (object_id) DO UPDATE SET radius = excluded.radius, reason = excluded.reason, marked_at = excluded.marked_at WHERE excluded.radius > mk_relevance_dirty.radius`;

/* Statements that mark `list` [{id, radius, reason}] (deduplicated, the highest radius kept), 20 rows (80 bound parameters) each. */
export function dirtyStmts(env, list) {
  const best = new Map();
  for (const m of list) if (m && m.id) { const r = Math.max(-1, Math.min(MAX_HOPS + 1, Number(m.radius) || 0)); const c = best.get(m.id); if (!c || c.radius < r) best.set(m.id, { id: m.id, radius: r, reason: String(m.reason || 'changed').slice(0, 60) }); }
  const rows = [...best.values()], at = nowIso(), out = [];
  for (let i = 0; i < rows.length; i += 20) { const part = rows.slice(i, i + 20);
    out.push(env.DB.prepare(SQL.replace('%V', part.map(() => '(?,?,?,?)').join(','))).bind(...part.flatMap((m) => [m.id, m.radius, m.reason, at]))); }
  return out;
}
export async function markDirty(env, list) {
  const st = dirtyStmts(env, list);
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return st.length;
}

/* What a put of `o` (previous version `prev`) marks: only a creation, a status change, a type change or a governance change across the
   excluded set alters relevance (scores and versions do not). Concepts and sources are seeds over the hop radius; a recommendation also
   marks what is derived from it; a canonical objective marks its anchor concept's neighbourhood (the objective set changed). */
export function seedsForObject(prev, o) {
  if (!o || !o.id) return [];
  const relevant = REL_TYPES.has(o.type) || o.type === 'Source';
  if (!relevant) return [];
  const changed = !prev || prev.status !== o.status || prev.type !== o.type || GOV_OUT.has(prev.governance_status) !== GOV_OUT.has(o.governance_status);
  if (!changed) return [];
  const why = !prev ? 'created' : prev.status !== o.status ? 'status_' + o.status : 'changed';
  if (o.type === 'Objective' && String(o.id).startsWith(OBJ_PREFIX)) return o.anchor_concept ? [{ id: o.anchor_concept, radius: MAX_HOPS, reason: 'objective_' + why }] : [];
  if (o.type === 'Concept') return [{ id: o.id, radius: MAX_HOPS, reason: 'concept_' + why }];
  if (o.type === 'Source') return [{ id: o.id, radius: 2, reason: 'source_' + why }];
  return [{ id: o.id, radius: o.type === 'Recommendation' ? 1 : -1, reason: why }];
}

/* What a set of written edges marks: a hop edge changes the rows of the concepts within one hop of either end (paths are at most
   MAX_HOPS long); an attachment changes the attached object's rows; a derived_from edge to a recommendation changes the derived object. */
const ATTACH_SIDE = Object.fromEntries(R.attachments.map((a) => [a.rel, a.object_is]));
export function seedsForEdges(edges) {
  const out = [];
  for (const e of edges) {
    if (!e || !e.src || !e.dst) continue;
    if (HOP_RELS.has(e.rel)) { if (String(e.src).startsWith('c.') && String(e.dst).startsWith('c.')) out.push({ id: e.src, radius: MAX_HOPS - 1, reason: 'edge_' + e.rel }, { id: e.dst, radius: MAX_HOPS - 1, reason: 'edge_' + e.rel }); continue; }
    if (ATTACH_SIDE[e.rel]) { const id = ATTACH_SIDE[e.rel] === 'dst' ? e.dst : e.src; if (!NO_ROWS.test(id) && !String(id).startsWith('c.')) out.push({ id, radius: e.rel === 'recommended_by' ? 1 : -1, reason: 'edge_' + e.rel }); continue; }
    if (e.rel === R.via_recommendation.rel && String(e.dst).startsWith('rec.') && !NO_ROWS.test(e.src)) out.push({ id: e.src, radius: -1, reason: 'edge_derived_from' });
  }
  return out;
}
