// LESSON CONTENT WEIGHTING (lifecycle stage 7; mkos/ontology/lifecycle.json "layers"). Every canonical objective's knowledge is
// split, by rules over relevance and confidence, into a required core, adjacent knowledge, advanced expansion and a frontier layer, so
// board preparation and deep academic learning use the same corpus. The plan per objective is derived (mk_layers, rewritten only where
// it changed); a lesson's plan is the union over its objectives. Generation prompts receive it as structure only (layeredOutline).
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';

const LC = FRAMEWORK.frameworks.lifecycle, L = LC.layers;
export const LAYERS = ['core', 'adjacent', 'advanced', 'frontier'];
const SET = '(SELECT value FROM json_each(?1))';

/* Pure: the layer of one relevance row. row: {score, conf (0..1), type, landmark, specialty}; ctx: {projected, specialty}. */
export function layerOf(row, ctx = {}) {
  const s = Number(row.score) || 0, c = row.conf == null ? 0.5 : Number(row.conf);
  if (s < Number(L.frontier.min_relevance) - 1e-9) return null;
  const crossSpecialty = row.specialty && ctx.specialty && row.specialty !== ctx.specialty;
  if (s >= Number(L.advanced.min_relevance) - 1e-9) {
    if (row.type === 'EvidenceObject') return 'advanced';                                    // landmark trials and evidence deep dives
    if (s >= Number(L.core.min_relevance) - 1e-9 && c < Number(L.advanced.emerging_below_confidence)) return 'advanced';   // emerging
  }
  if (s >= Number(L.core.min_relevance) - 1e-9 && c >= Number(L.core.min_confidence) - 1e-9 && (ctx.projected || L.core.allow_unprojected) && !crossSpecialty) return 'core';
  if (crossSpecialty && s >= Number(L.advanced.min_relevance) - 1e-9 && row.type !== 'Concept') return 'advanced';   // subspecialty knowledge
  if (s >= Number(L.adjacent.min_relevance) - 1e-9) return 'adjacent';
  return 'frontier';
}
/* Pure: the plan of one objective from its rows. Returns {layer: {n, top: [{id, name, type, score, kind}]}}. */
export function planOf(rows, ctx) {
  const out = Object.fromEntries(LAYERS.map((k) => [k, { n: 0, top: [] }])), N = Number(L.top_n) || 12;
  for (const r of [...rows].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))) {
    const k = layerOf(r, ctx); if (!k) continue;
    out[k].n++; if (out[k].top.length < N) out[k].top.push({ id: r.id, name: String(r.name || '').slice(0, 160), type: r.type, score: r.score, ...(r.landmark ? { landmark: true } : {}) });
  }
  return out;
}
async function rowsFor(env, objective) {
  return (await env.DB.prepare(`SELECT r.object_id AS id, r.score AS score, o.type AS type, o.name AS name, o.specialty AS specialty, o.conf AS oconf, c.score AS conf,
      json_extract(o.body, '$.acronym') AS acronym FROM mk_relevance r JOIN mk_objects o ON o.id = r.object_id
      LEFT JOIN mk_confidence c ON c.object_id = r.object_id AND c.domain = 'evidence'
      WHERE r.objective_id = ? AND r.object_id != ? AND o.status IN ('current','modified') ORDER BY r.score DESC LIMIT 2000`).bind(objective, 'c.' + objective.slice(LC.objectives.id_prefix.length)).all()).results
    .map((r) => ({ ...r, conf: r.conf != null ? r.conf : (r.oconf || 0) / 100, landmark: !!r.acronym }));
}
/* Recompute the plans of `objectives`; writes only layers whose count or top list changed. Returns writes. */
export async function computeLayers(env, objectives) {
  if (!objectives.length) return 0;
  const proj = new Set((await env.DB.prepare(`SELECT DISTINCT dst FROM mk_edges WHERE rel = 'projects_objective' AND status = 'current' AND dst IN ${SET}`).bind(JSON.stringify(objectives)).all()).results.map((r) => r.dst));
  const anchors = Object.fromEntries((await env.DB.prepare(`SELECT id, specialty FROM mk_objects WHERE id IN (SELECT 'c.' || substr(value, ${LC.objectives.id_prefix.length + 1}) FROM json_each(?1))`).bind(JSON.stringify(objectives)).all()).results.map((r) => [r.id, r.specialty]));
  const stored = new Map((await env.DB.prepare(`SELECT objective_id, layer, n, top_json FROM mk_layers WHERE objective_id IN ${SET}`).bind(JSON.stringify(objectives)).all()).results.map((r) => [r.objective_id + '|' + r.layer, r]));
  const at = nowIso(), st = [];
  for (const ob of objectives) {
    const plan = planOf(await rowsFor(env, ob), { projected: proj.has(ob), specialty: anchors['c.' + ob.slice(LC.objectives.id_prefix.length)] || null });
    for (const k of LAYERS) {
      const p = plan[k], top = JSON.stringify(p.top), o = stored.get(ob + '|' + k);
      if (!p.n) { if (o) st.push(env.DB.prepare('DELETE FROM mk_layers WHERE objective_id = ? AND layer = ?').bind(ob, k)); continue; }
      if (o && o.n === p.n && o.top_json === top) continue;
      st.push(env.DB.prepare('INSERT INTO mk_layers (objective_id, layer, n, top_json, computed_at) VALUES (?,?,?,?,?) ON CONFLICT (objective_id, layer) DO UPDATE SET n = excluded.n, top_json = excluded.top_json, computed_at = excluded.computed_at').bind(ob, k, p.n, top, at));
    }
  }
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return st.length;
}

/* The canonical objectives of a lesson: those of the concepts it teaches and those its blueprint objective projects onto. */
export async function lessonObjectives(env, assetId) {
  return (await env.DB.prepare(`SELECT '${LC.objectives.id_prefix}' || substr(object_id, 3) AS o FROM mk_asset_links WHERE asset_id = ?1 AND rel = 'teaches' AND object_id LIKE 'c.%'
    UNION SELECT p.dst FROM mk_asset_links l JOIN mk_edges p ON p.src = l.object_id AND p.rel = 'projects_objective' AND p.status = 'current' WHERE l.asset_id = ?1 AND l.rel = 'teaches_objective'`).bind(assetId).all()).results.map((r) => r.o);
}
/* The layer plan of a lesson (asset id), or of a list of objectives: {layers: {core: {n, top}}, objectives}. */
export async function layerPlan(env, { asset = null, objectives = null } = {}) {
  const obs = objectives || (asset ? await lessonObjectives(env, asset) : []);
  const out = Object.fromEntries(LAYERS.map((k) => [k, { n: 0, top: [] }])), N = Number(L.top_n) || 12;
  if (!obs.length) return { layers: out, objectives: [] };
  const rows = (await env.DB.prepare(`SELECT objective_id, layer, n, top_json FROM mk_layers WHERE objective_id IN ${SET}`).bind(JSON.stringify(obs.slice(0, 400))).all()).results;
  for (const r of rows) { const o = out[r.layer]; if (!o) continue; o.n += r.n; for (const t of J(r.top_json, [])) if (!o.top.some((x) => x.id === t.id)) o.top.push(t); }
  for (const k of LAYERS) out[k].top = out[k].top.sort((a, b) => b.score - a.score).slice(0, N);
  return { layers: out, objectives: obs, names: L.names };
}
/* The layered outline handed to a generation prompt: structure only (names of what belongs in each layer), never new wording rules.
   Empty when no plan exists, so a prompt without one is exactly as before. */
export function layeredOutline(plan) {
  if (!plan || !plan.layers) return '';
  const per = Number(L.outline_items_per_layer) || 6, lines = [];
  for (const k of LAYERS) { const t = (plan.layers[k] || {}).top || []; if (t.length) lines.push(`- ${L.names[k]}: ${t.slice(0, per).map((x) => x.name).join('; ')}`); }
  return lines.length ? `\n\nLAYERED OUTLINE (MKOS lesson content weighting; structure only):\n${lines.join('\n')}` : '';
}
