// THE CONFIDENCE ENGINE (lifecycle stage 8; mkos/ontology/lifecycle.json "confidence"). Three separate domains, each 0..1 with the
// factors that made it, in mk_confidence (derived; rewritten only where a score or factor changed):
//   evidence   (Recommendation, Claim, EvidenceObject): evidence level or study design, source class authority, agreement (distinct
//              current sources recommending on the same concepts), recency of the source;
//   relevance  (any object with relevance rows): strongest relevance, number of strong paths, and whether any objective is on an exam;
//   lesson     (shared lessons): source count, coverage of current recommendations, evidence support, objective support, recency.
// It never reads into or writes mk_objects.conf or trust (the Universal Confidence Model's own scores keep their meaning).
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { sourceClass, ageYears } from './scoring.js';

const F = FRAMEWORK.frameworks, C = F.lifecycle.confidence, OBJP = F.lifecycle.objectives.id_prefix;
const LEVEL = Object.fromEntries(F.ontology.evidence_model.levels.map((l) => [l.key, l.evidence_score]));
const P = Number(C.precision) || 3, rd = (x) => Math.round(Math.max(0, Math.min(1, x)) * 10 ** P) / 10 ** P;
const SET = '(SELECT value FROM json_each(?1))';
const half = (age, hl) => age == null ? 0.5 : Math.pow(0.5, age / hl);
const sum = (w, f) => Object.entries(w).reduce((a, [k, v]) => a + v * (f[k] ?? 0), 0);

/* Pure factor rules (tests use these directly). */
export function evidenceFactors({ type, evidence_level, design, evidence_kind }, src, agreeing) {
  const E = C.evidence, ds = E.design_scores;
  let level;
  if (type === 'EvidenceObject') { const d = String(design || evidence_kind || '').toLowerCase().replace(/[^a-z]+/g, '_'); level = ds[d] ?? ds[evidence_kind] ?? ds.default; }
  else level = (LEVEL[evidence_level] ?? 45) / 100;
  const authority = src ? (sourceClass(src.source_class).base_authority || 50) / 100 : 0.5;
  const agreement = Math.min(1, Math.max(0, agreeing) / (Number(E.agreement_full_at) || 3));
  const recency = src ? half(ageYears(src.published_online || src.issue_date || src.year), Number(E.recency_half_life_years) || 8) : 0.5;
  const f = { evidence_level: rd(level), authority: rd(authority), agreement: rd(agreement), recency: rd(recency), agreeing_sources: agreeing };
  return { score: rd(sum(E.weights, f)), factors: f };
}
export function relevanceFactors({ max = 0, strong = 0, exam = 0 }) {
  const R = C.relevance, f = { strength: rd(max), paths: rd(Math.min(1, strong / (Number(R.paths_full_at) || 8))), exam: exam ? 1 : 0, strong_paths: strong };
  return { score: rd(sum(R.weights, f)), factors: f };
}
export function lessonFactors({ sources = 0, recs_total = 0, recs_covered = 0, evidence = 0.5, objectives = 0, objectives_supported = 0, age_days = null }) {
  const LS = C.lesson, f = { sources: rd(Math.min(1, sources / (Number(LS.sources_full_at) || 4))), coverage: rd(recs_total ? recs_covered / recs_total : 0), evidence: rd(evidence),
    objectives: rd(objectives ? objectives_supported / objectives : 0), recency: rd(age_days == null ? 0.5 : Math.pow(0.5, age_days / (Number(LS.recency_half_life_days) || 365))),
    source_count: sources, recommendations: recs_total, objectives_n: objectives };
  return { score: rd(sum(LS.weights, f)), factors: f };
}

async function write(env, rows) {
  if (!rows.length) return 0;
  const ids = [...new Set(rows.map((r) => r.object_id))];
  const stored = new Map((await env.DB.prepare(`SELECT object_id, domain, score, factors_json FROM mk_confidence WHERE object_id IN ${SET}`).bind(JSON.stringify(ids)).all()).results.map((r) => [r.object_id + '|' + r.domain, r]));
  const at = nowIso(), st = [];
  for (const r of rows) { const fj = JSON.stringify(r.factors), o = stored.get(r.object_id + '|' + r.domain);
    if (o && o.score === r.score && o.factors_json === fj) continue;
    st.push(env.DB.prepare('INSERT INTO mk_confidence (object_id, domain, score, factors_json, computed_at) VALUES (?,?,?,?,?) ON CONFLICT (object_id, domain) DO UPDATE SET score = excluded.score, factors_json = excluded.factors_json, computed_at = excluded.computed_at').bind(r.object_id, r.domain, r.score, fj, at)); }
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return st.length;
}

/* Evidence and relevance confidence for knowledge objects `ids` (any type; evidence only for its types). Returns writes. */
export async function computeObjectConfidence(env, ids) {
  if (!ids.length) return 0;
  const js = JSON.stringify(ids), rows = [];
  const objs = (await env.DB.prepare(`SELECT o.id, o.type, json_extract(o.body, '$.evidence_level') AS lvl, json_extract(o.body, '$.design') AS design, json_extract(o.body, '$.evidence_kind') AS ek,
      COALESCE(json_extract(o.body, '$.source_id'), json_extract(r.body, '$.source_id')) AS sid
    FROM mk_objects o LEFT JOIN mk_edges d ON d.src = o.id AND d.rel = 'derived_from' AND d.dst LIKE 'rec.%' LEFT JOIN mk_objects r ON r.id = d.dst
    WHERE o.id IN ${SET} AND o.status IN ('current','modified') GROUP BY o.id`).bind(js).all()).results;
  const srcIds = [...new Set(objs.map((o) => o.sid).filter(Boolean))];
  const srcs = Object.fromEntries((await env.DB.prepare(`SELECT id, body FROM mk_objects WHERE id IN ${SET}`).bind(JSON.stringify(srcIds)).all()).results.map((r) => [r.id, J(r.body, {})]));
  // Agreement: distinct current sources with current recommendations on any concept this object's recommendation is about.
  const agree = Object.fromEntries((await env.DB.prepare(`SELECT x.id AS id, COUNT(DISTINCT json_extract(r2.body, '$.source_id')) AS n FROM
      (SELECT o.id AS id, COALESCE(d.dst, o.id) AS rec FROM mk_objects o LEFT JOIN mk_edges d ON d.src = o.id AND d.rel = 'derived_from' AND d.dst LIKE 'rec.%' WHERE o.id IN ${SET}) x
      JOIN mk_edges e ON e.dst = x.rec AND e.rel = 'recommended_by' AND e.status = 'current'
      JOIN mk_edges e2 ON e2.src = e.src AND e2.rel = 'recommended_by' AND e2.status = 'current' JOIN mk_objects r2 ON r2.id = e2.dst AND r2.status IN ('current','modified')
      GROUP BY x.id`).bind(js).all()).results.map((r) => [r.id, r.n]));
  for (const o of objs) if (C.evidence.applies_to.includes(o.type)) {
    const e = evidenceFactors({ type: o.type, evidence_level: o.lvl, design: o.design, evidence_kind: o.ek }, srcs[o.sid] || null, agree[o.id] || (o.type === 'EvidenceObject' ? 0 : 1));
    rows.push({ object_id: o.id, domain: 'evidence', ...e });
  }
  const rel = (await env.DB.prepare(`SELECT r.object_id AS id, MAX(r.score) AS mx, SUM(CASE WHEN r.score >= ?2 THEN 1 ELSE 0 END) AS strong,
      MAX(CASE WHEN EXISTS (SELECT 1 FROM mk_edges p WHERE p.dst = r.objective_id AND p.rel = 'projects_objective' AND p.status = 'current') THEN 1 ELSE 0 END) AS exam
    FROM mk_relevance r WHERE r.object_id IN ${SET} GROUP BY r.object_id`).bind(js, Number(C.relevance.path_min) || 0.5).all()).results;
  for (const r of rel) rows.push({ object_id: r.id, domain: 'relevance', ...relevanceFactors({ max: r.mx, strong: r.strong, exam: r.exam }) });
  return write(env, rows);
}

/* Lesson confidence for shared lessons `assetIds`. Returns writes. */
export async function computeLessonConfidence(env, assetIds) {
  const rows = [];
  for (const id of assetIds.slice(0, 40)) {
    const a = await env.DB.prepare("SELECT body FROM mk_objects WHERE id = ? AND type = 'EducationalAsset' AND status = 'current'").bind(id).first(); if (!a) continue;
    const o = J(a.body, {}), concepts = (o.teaches || []).slice(0, 20); if (!concepts.length) continue;
    const cj = JSON.stringify(concepts);
    const recs = (await env.DB.prepare(`SELECT DISTINCT e.dst AS id, json_extract(r.body, '$.source_id') AS sid, c.score AS ec, r.conf AS oc FROM mk_edges e JOIN mk_objects r ON r.id = e.dst AND r.status IN ('current','modified')
      LEFT JOIN mk_confidence c ON c.object_id = e.dst AND c.domain = 'evidence' WHERE e.rel = 'recommended_by' AND e.status = 'current' AND e.src IN ${SET}`).bind(cj).all()).results;
    const enh = new Set((await env.DB.prepare("SELECT object_id FROM mk_enhancements WHERE asset_id = ? AND kind = 'recommendation'").bind(id).all()).results.map((r) => r.object_id));
    // Coverage: the recommendations the lesson was written with (its basis count) plus those added as enhancements, of the current ones.
    const covered = (Number((o.basis || {}).cov) || Object.keys((o.basis || {}).recs || {}).length) + enh.size;
    const obs = concepts.map((c) => OBJP + c.slice(2));
    const supported = ((await env.DB.prepare(`SELECT COUNT(DISTINCT r.objective_id) AS n FROM mk_relevance r JOIN mk_objects x ON x.id = r.object_id AND x.type != 'Concept' WHERE r.objective_id IN ${SET} AND r.score >= ?2`).bind(JSON.stringify(obs), Number(F.lifecycle.coverage.supporting_min) || 0.7).first()) || {}).n || 0;
    const ev = recs.length ? recs.reduce((s, r) => s + (r.ec != null ? r.ec : (r.oc || 0) / 100), 0) / recs.length : 0;
    const last = [o.updated, (o.enrichment || {}).last].filter(Boolean).sort().pop();
    const age = last ? Math.max(0, (Date.now() - Date.parse(last)) / 864e5) : null;
    rows.push({ object_id: id, domain: 'lesson', ...lessonFactors({ sources: new Set(recs.map((r) => r.sid).filter(Boolean)).size, recs_total: recs.length, recs_covered: Math.min(recs.length, covered), evidence: ev, objectives: obs.length, objectives_supported: supported, age_days: age }) });
  }
  return write(env, rows);
}

export async function confidenceOf(env, id) {
  const rows = (await env.DB.prepare('SELECT domain, score, factors_json, computed_at FROM mk_confidence WHERE object_id = ?').bind(id).all()).results;
  return Object.fromEntries(rows.map((r) => [r.domain, { score: r.score, factors: J(r.factors_json, {}), computed_at: r.computed_at }]));
}
