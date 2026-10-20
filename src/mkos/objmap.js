// OBJECTIVE MAPPING (owner directive, 10/20/2026): as many knowledge objects as possible are mapped to the dynamic board exam objectives
// (ABIM CERT and LKA BlueprintTopics), so they live in the Dynamic Board Objective Curriculum (curstore.js); whatever cannot be mapped
// with confidence stays under the original ontology only. Deterministic, no AI. Every mapping is a `mapped_to_blueprint` edge with its
// confidence and provenance (method objective_mapping), so it is versioned with the graph, mirrored to Drive, and reversible.
//
//   Concepts already mapped by the blueprint import (blueprint topic concepts)  ─┐
//   Recommendation   <- the concepts that are recommended_by it                    │  through shared concepts (the strong path)
//   Claim / teaching point / objective / pearl  <- the recommendation it derives   │
//   Educational object / source section  <- the concepts it covers                 │
//   Objective        <- the concepts it teaches or assesses                        │
//   Concept          <- a mapped concept it treats, evaluates or is associated with┘
//   Unmapped concepts and source sections  <- the objective whose name matches closely (trigram similarity), when nothing else maps them
//
// A concept that maps to more than FANOUT objectives (a broad concept such as "hypertension" across many objectives) is not used as a
// bridge, so a narrow recommendation is never spread across a whole discipline.
import { J, nowIso, getSetting, setSetting } from './db.js';

const FANOUT = 6, CONC_SIM = 0.82, SECT_SIM = 0.8;
const grams = (s) => { const t = ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ', g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
const sim = (A, B) => { let n = 0; for (const g of A) if (B.has(g)) n++; return A.size + B.size ? (2 * n) / (A.size + B.size) : 0; };

const BRIDGE = `SELECT src AS c, dst AS t FROM mk_edges WHERE rel = 'mapped_to_blueprint' AND status = 'current' AND src LIKE 'c.%' AND dst LIKE 'bpt.%'
  AND src IN (SELECT src FROM mk_edges WHERE rel = 'mapped_to_blueprint' AND status = 'current' AND dst LIKE 'bpt.%' GROUP BY src HAVING COUNT(*) <= ${FANOUT})`;
const INS = (conf, why) => `INSERT INTO mk_edges (src, rel, dst, status, conf, prov, created, updated) SELECT DISTINCT x.s, 'mapped_to_blueprint', x.t, 'current', ${conf},
  '[{"method":"objective_mapping","via":"${why}","at":"' || ?1 || '"}]', ?1, ?1 FROM (`;
const TAIL = `) x WHERE x.s IS NOT NULL AND x.t IS NOT NULL AND x.s != x.t AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = x.s AND e.rel = 'mapped_to_blueprint' AND e.dst = x.t)`;

// The concept-path passes, in order (each builds on the ones before it).
const PASSES = [
  ['concept_neighbor', 55, `SELECT n.src AS s, b.t FROM mk_edges n JOIN (${BRIDGE}) b ON b.c = n.dst WHERE n.status = 'current' AND n.rel IN ('treats','evaluates','associated_with','contributes_to','complication_of','causes','diagnoses')
     AND n.src LIKE 'c.%' AND NOT EXISTS (SELECT 1 FROM mk_edges z WHERE z.src = n.src AND z.rel = 'mapped_to_blueprint')`],
  ['recommendation_concept', 80, `SELECT r.dst AS s, b.t FROM mk_edges r JOIN (${BRIDGE}) b ON b.c = r.src WHERE r.rel = 'recommended_by' AND r.status = 'current' AND r.dst LIKE 'rec.%'`],
  ['objective_concept', 80, `SELECT r.src AS s, b.t FROM mk_edges r JOIN (${BRIDGE}) b ON b.c = r.dst WHERE r.rel IN ('teaches','assesses') AND r.status = 'current' AND r.src LIKE 'obj.%'`],
  ['covers_concept', 70, `SELECT r.src AS s, b.t FROM mk_edges r JOIN (${BRIDGE}) b ON b.c = r.dst WHERE r.rel = 'covers' AND r.status = 'current' AND (r.src LIKE 'eo.%' OR r.src LIKE 'ss.%')`],
  ['derived_from_recommendation', 75, `SELECT d.src AS s, m.dst AS t FROM mk_edges d JOIN mk_edges m ON m.src = d.dst AND m.rel = 'mapped_to_blueprint' AND m.status = 'current' AND m.dst LIKE 'bpt.%'
     WHERE d.rel = 'derived_from' AND d.status = 'current' AND d.dst LIKE 'rec.%' AND (d.src LIKE 'clai%' OR d.src LIKE 'eo.%' OR d.src LIKE 'obj.%')
     AND d.dst IN (SELECT src FROM mk_edges WHERE rel = 'mapped_to_blueprint' AND status = 'current' GROUP BY src HAVING COUNT(*) <= ${FANOUT * 2})`],
];

/* One run. The concept passes run once a day (cheap grouped SQL); the name pass walks unmapped concepts and source sections in slices. */
export async function mapObjectives(env, { slice = 400 } = {}) {
  const prog = J(await getSetting(env, 'objmap_prog'), {}) || {}, day = nowIso().slice(0, 10), out = { passes: {}, names: null };
  if (prog.day !== day) {
    const at = nowIso();
    for (const [why, conf, sql] of PASSES) {
      try { const r = await env.DB.prepare(INS(conf, why) + sql + TAIL).bind(at).run(); out.passes[why] = r.meta ? r.meta.changes : 0; }
      catch (e) { out.passes[why] = 'error: ' + String(e.message || e).slice(0, 160); }
    }
    prog.day = day; prog.last_passes = out.passes; prog.name_after = { Concept: '', SourceSection: '' };
  }
  // Name pass: objects nothing else could map, matched to an objective by name.
  const after = prog.name_after || (prog.name_after = { Concept: '', SourceSection: '' });
  const kind = after.Concept !== null ? 'Concept' : after.SourceSection !== null ? 'SourceSection' : null;
  if (kind) {
    const objs = (await env.DB.prepare(`SELECT id, name FROM mk_objects WHERE type = ? AND status IN ('current','modified') AND id > ? AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = mk_objects.id AND e.rel = 'mapped_to_blueprint') ORDER BY id LIMIT ?`).bind(kind, after[kind], slice).all()).results;
    const bpts = (await env.DB.prepare("SELECT id, name, json_extract(body, '$.subcategory') AS sub FROM mk_objects WHERE type = 'BlueprintTopic' AND status = 'current'").all()).results
      .filter((b) => !/^(general|other|miscellaneous)\b/i.test(String(b.name || '').trim())).map((b) => ({ id: b.id, g: grams(b.name) }));
    const edges = [], at = nowIso(), min = kind === 'Concept' ? CONC_SIM : SECT_SIM;
    for (const o of objs) {
      const g = grams(o.name); if (g.size < 6) continue;
      const hits = bpts.map((b) => ({ b, s: sim(g, b.g) })).filter((x) => x.s >= min).sort((x, y) => y.s - x.s);
      const top = hits.length ? hits[0].s : 0;
      for (const h of hits.filter((x) => x.s >= top - 0.02).slice(0, 2)) edges.push(env.DB.prepare(`INSERT OR IGNORE INTO mk_edges (src, rel, dst, status, conf, prov, created, updated) VALUES (?, 'mapped_to_blueprint', ?, 'current', ?, ?, ?, ?)`)
        .bind(o.id, h.b.id, Math.round(h.s * 70), JSON.stringify([{ method: 'objective_mapping', via: 'name', score: Math.round(h.s * 100) / 100, at }]), at, at));
    }
    for (let i = 0; i < edges.length; i += 80) await env.DB.batch(edges.slice(i, i + 80));
    out.names = { kind, checked: objs.length, mapped: edges.length };
    after[kind] = objs.length < slice ? null : objs[objs.length - 1].id;
  }
  await setSetting(env, 'objmap_prog', JSON.stringify(prog));
  return out;
}

/* objective_mapping_status: how much of the knowledge base maps to a board objective, by type. */
export async function mappingStatus(env) {
  const by = (await env.DB.prepare(`SELECT o.type, COUNT(*) AS total, SUM(CASE WHEN EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = o.id AND e.rel = 'mapped_to_blueprint' AND e.status = 'current') THEN 1 ELSE 0 END) AS mapped
    FROM mk_objects o WHERE o.status IN ('current','modified') AND o.type IN ('Recommendation','Claim','Objective','EducationalObject','Concept','SourceSection') GROUP BY o.type`).all()).results;
  return { by_type: by.map((r) => ({ ...r, pct: r.total ? Math.round(1000 * r.mapped / r.total) / 10 : 0 })), progress: J(await getSetting(env, 'objmap_prog'), null) };
}
