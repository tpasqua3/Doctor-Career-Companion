// The Knowledge Graph Layer: typed edges between objects. Relationship keys come from the ontology (the spec's 16 KNOWLEDGE GRAPH
// RELATIONSHIPS plus the structural ones that connect the layers); an undeclared relationship is refused.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { seedsForEdges, dirtyStmts } from './dirty.js';

const O = FRAMEWORK.frameworks.ontology;
export const RELS = Object.fromEntries([...O.relationships, ...O.structural_relationships].map((r) => [r.key, r]));
export const inverseOf = (rel) => RELS[rel]?.inverse || rel;
// Relationships impact reach never follows (lifecycle.json non_propagating_relations): a class node such as "disease" joins thousands
// of concepts, so following it would make every change touch everything.
export const NON_PROPAGATING = (FRAMEWORK.frameworks.lifecycle && FRAMEWORK.frameworks.lifecycle.non_propagating_relations) || [];

// Add or refresh edges. edges: [{src, rel, dst, conf, prov}] where prov is one provenance step.
export async function addEdges(env, edges) {
  const now = nowIso(), ok = [], bad = [];
  for (const e of edges) (RELS[e.rel] && e.src && e.dst && e.src !== e.dst ? ok : bad).push(e);
  for (let i = 0; i < ok.length; i += 80) {
    await env.DB.batch(ok.slice(i, i + 80).map((e) => env.DB.prepare(`INSERT INTO mk_edges (src, rel, dst, status, conf, prov, created, updated) VALUES (?, ?, ?, 'current', ?, ?, ?, ?)
      ON CONFLICT (src, rel, dst) DO UPDATE SET conf = MAX(mk_edges.conf, excluded.conf), updated = excluded.updated,
      prov = CASE WHEN instr(mk_edges.prov, ?) > 0 THEN mk_edges.prov ELSE substr(mk_edges.prov, 1, length(mk_edges.prov) - 1) || ',' || substr(excluded.prov, 2) END`)
      .bind(e.src, e.rel, e.dst, e.conf ?? 50, JSON.stringify([e.prov || { method: 'derived', at: now }]), now, now, (e.prov && e.prov.source_id) || '"method":"derived"'))
      // Relevance dirty flags for the hop, attachment and derived_from edges among them (dirty.js), in the same batch.
      .concat(dirtyStmts(env, seedsForEdges(ok.slice(i, i + 80)))));
  }
  return { added: ok.length, refused: bad.map((e) => `${e.src} -${e.rel}-> ${e.dst}`) };
}

// Neighbors of an object in both directions, with the inverse label on incoming edges.
export async function neighbors(env, id, { rels, include_history = false, limit = 400 } = {}) {
  const st = include_history ? '' : " AND status = 'current'";
  const relq = rels && rels.length ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';
  const a = rels && rels.length ? rels : [];
  const out = (await env.DB.prepare(`SELECT src, rel, dst, conf, status FROM mk_edges WHERE src = ?${st}${relq} LIMIT ?`).bind(id, ...a, limit).all()).results;
  const inc = (await env.DB.prepare(`SELECT src, rel, dst, conf, status FROM mk_edges WHERE dst = ?${st}${relq} LIMIT ?`).bind(id, ...a, limit).all()).results;
  return [...out.map((e) => ({ rel: e.rel, id: e.dst, dir: 'out', conf: e.conf, status: e.status })), ...inc.map((e) => ({ rel: inverseOf(e.rel), id: e.src, dir: 'in', via: e.rel, conf: e.conf, status: e.status }))];
}

// Breadth-first reach from a set of ids, following any edge (used by impact analysis). Returns id -> depth.
// seedAll: the first step from the start set follows edges of any status (a retired or superseded subject still reaches what it touched).
export async function reach(env, start, { depth = 2, rels = null, cap = 2000, seedAll = false } = {}) {
  const seen = new Map(start.map((s) => [s, 0])); let frontier = [...start];
  for (let d = 1; d <= depth && frontier.length && seen.size < cap; d++) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 40) {     // 2 x 40 ids + rels stays under D1's 100 bound parameters
      const part = frontier.slice(i, i + 40), ph = part.map(() => '?').join(',');
      const relq = rels ? ` AND rel IN (${rels.slice(0, 15).map(() => '?').join(',')})` : NON_PROPAGATING.length ? ` AND rel NOT IN (${NON_PROPAGATING.map((r) => `'${r.replace(/[^a-z_]/g, '')}'`).join(',')})` : '';
      const st = seedAll && d === 1 ? '' : "status = 'current' AND ";
      const { results } = await env.DB.prepare(`SELECT src, dst FROM mk_edges WHERE ${st}(src IN (${ph}) OR dst IN (${ph}))${relq}`).bind(...part, ...part, ...(rels || []).slice(0, 15)).all();
      for (const r of results) for (const x of [r.src, r.dst]) if (!seen.has(x)) { seen.set(x, d); next.push(x); }
    }
    frontier = next;
  }
  return seen;
}

export async function edgeCounts(env) {
  return (await env.DB.prepare('SELECT rel, status, COUNT(*) AS n FROM mk_edges GROUP BY rel, status ORDER BY n DESC').all()).results;
}
export const provOf = (row) => J(row.prov, []);
