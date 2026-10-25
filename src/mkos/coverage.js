// THE COVERAGE ENGINE AND GAP DETECTION (lifecycle stages 9-10; mkos/ontology/lifecycle.json "coverage", "gaps"). Corpus
// self-awareness: what MKOS knows, partly knows and does not know. A snapshot per day (mk_coverage: dimension, key, numerator,
// denominator, pct) of specialty, objective, exam, evidence, source, lesson and knowledge-penetration coverage, then deterministic gap
// rules over coverage and confidence, each gap with its recommended action (acquisition, guideline, trial, update, lesson). Both tables
// are derived (recomputed from objects, edges, blueprints and the relevance graph) and rewritten only where a value changed.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';

const F = FRAMEWORK.frameworks, LC = F.lifecycle, CV = LC.coverage, G = LC.gaps, OBJP = LC.objectives.id_prefix;
const SET = '(SELECT value FROM json_each(?1))';
const pct = (n, d) => d ? Math.round(10000 * n / d) / 100 : 0;
const KNOW = ['Recommendation', 'Claim', 'EvidenceObject', 'EducationalObject'];
const all = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;

/* The sets every dimension and rule needs, from a handful of grouped queries. */
async function facts(env) {
  const sup = Number(CV.supporting_min) || 0.7, evm = Number(CV.evidence_min) || 0.5;
  const canon = (await all(env, `SELECT id, name, json_extract(body, '$.anchor_concept') AS c, specialty FROM mk_objects WHERE type = 'Objective' AND id LIKE ? AND status IN ('current','modified')`, OBJP + '%'));
  const supported = new Set((await all(env, `SELECT DISTINCT r.objective_id AS o FROM mk_relevance r JOIN mk_objects x ON x.id = r.object_id AND x.type != 'Concept' WHERE r.score >= ?`, sup - 1e-9)).map((r) => r.o));
  const recObj = new Set((await all(env, `SELECT DISTINCT objective_id AS o FROM mk_relevance WHERE object_id LIKE 'rec.%' AND score >= ?`, sup - 1e-9)).map((r) => r.o));
  const evObj = new Set((await all(env, `SELECT DISTINCT r.objective_id AS o FROM mk_relevance r JOIN mk_objects x ON x.id = r.object_id AND x.type = 'EvidenceObject' WHERE r.score >= ?`, evm - 1e-9)).map((r) => r.o));
  const lessonObj = new Set((await all(env, `SELECT DISTINCT '${OBJP}' || substr(l.object_id, 3) AS o FROM mk_asset_links l JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current'
      WHERE l.rel = 'teaches' AND l.asset_id LIKE 'ea.s.les.%' AND l.object_id LIKE 'c.%'
    UNION SELECT p.dst FROM mk_asset_links l JOIN mk_edges p ON p.src = l.object_id AND p.rel = 'projects_objective' AND p.status = 'current' JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current'
      WHERE l.rel = 'teaches_objective' AND l.asset_id LIKE 'ea.s.%'`)).map((r) => r.o));
  const curObj = new Set((await all(env, `SELECT DISTINCT '${OBJP}' || substr(dst, 3) AS o FROM mk_edges WHERE rel = 'covers' AND status = 'current' AND src LIKE 'cn.%' AND dst LIKE 'c.%'`)).map((r) => r.o));
  const topics = await all(env, `SELECT bo.objective_id AS t, bo.blueprint_id AS b, r.blueprint_family AS f, bo.priority_score AS p, bo.objective_text AS name FROM mk_blueprint_objectives bo
    JOIN mk_blueprint_registries r ON r.blueprint_id = bo.blueprint_id AND r.current_status = 'current'`);
  const proj = await all(env, `SELECT src AS t, dst AS o FROM mk_edges WHERE rel = 'projects_objective' AND status = 'current'`);
  const objPri = new Map(), topicObjs = new Map(), pri = new Map(topics.map((t) => [t.t, t.p]));
  for (const p of proj) { (topicObjs.get(p.t) || topicObjs.set(p.t, []).get(p.t)).push(p.o); const w = pri.get(p.t); if (w != null && (objPri.get(p.o) || 0) < w) objPri.set(p.o, w); }
  const topicLessons = new Set((await all(env, `SELECT DISTINCT l.object_id AS t FROM mk_asset_links l JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current' WHERE l.rel = 'teaches_objective' AND l.asset_id LIKE 'ea.s.%'`)).map((r) => r.t));
  return { canon, supported, recObj, evObj, lessonObj, curObj, topics, topicObjs, objPri, topicLessons };
}

/* Pure: the coverage rows from the facts. */
export function coverageRows(x, { specialties = [], lifecycle = [], knowledge = { num: 0, den: 0 } } = {}) {
  const rows = [], add = (dimension, key, num, den) => rows.push({ dimension, key, num, den, pct: pct(num, den) });
  const ids = new Set(x.canon.map((o) => o.id)), inC = (s) => [...s].filter((o) => ids.has(o)).length;
  for (const s of specialties) add('specialty', s.key, s.num, s.den);
  add('objective', 'supported', inC(x.supported), ids.size);
  const byBp = {}; for (const t of x.topics) { const b = byBp[t.f] = byBp[t.f] || { num: 0, den: 0, les: 0 }; b.den++; if ((x.topicObjs.get(t.t) || []).some((o) => x.supported.has(o))) b.num++; if (x.topicLessons.has(t.t) || (x.topicObjs.get(t.t) || []).some((o) => x.lessonObj.has(o))) b.les++; }
  for (const [f, b] of Object.entries(byBp)) { add('exam', f, b.num, b.den); add('lesson', f, b.les, b.den); }
  add('evidence', 'objectives_with_recommendations', [...x.recObj].filter((o) => x.evObj.has(o) && ids.has(o)).length, inC(x.recObj));
  const live = lifecycle.filter((r) => r.status !== 'retired');
  add('source', 'lifecycle_complete', live.filter((r) => r.status === 'complete').length, live.length);
  add('source', 'relevance_mapped', live.filter((r) => ((J(r.stages_json, {}) || {}).stages || {}).relevance_mapped?.state === 'done').length, live.length);
  add('lesson', 'objectives', inC(x.lessonObj), ids.size);
  add('penetration', 'knowledge', knowledge.num, knowledge.den);
  return rows;
}

/* The day's snapshot (or a refresh of today's rows). Returns { day, writes, rows }. */
export async function coverageSnapshot(env, x = null) {
  x = x || await facts(env);
  const day = nowIso().slice(0, 10), sup = Number(CV.supporting_min) || 0.7;
  const spc = await all(env, `SELECT o.specialty AS k, COUNT(*) AS den, SUM(CASE WHEN EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = o.id AND e.rel = 'recommended_by' AND e.status = 'current') THEN 1 ELSE 0 END) AS num
    FROM mk_objects o WHERE o.type = 'Concept' AND o.status IN ('current','modified') AND o.specialty IS NOT NULL GROUP BY o.specialty`);
  const by = new Map(spc.map((r) => [r.k, r]));
  const specialties = (await all(env, "SELECT id FROM mk_objects WHERE type = 'Specialty' AND status = 'current'")).map((r) => ({ key: r.id, num: (by.get(r.id) || {}).num || 0, den: (by.get(r.id) || {}).den || 0 }));
  const lifecycle = await all(env, 'SELECT status, stages_json FROM mk_lifecycle');
  const reached = JSON.stringify([...new Set([...x.lessonObj, ...x.curObj])]);
  const kden = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM mk_objects WHERE type IN (${KNOW.map((t) => `'${t}'`).join(',')}) AND status IN ('current','modified') AND id NOT LIKE 'ea.%'`).first()) || {}).n || 0;
  const knum = ((await env.DB.prepare(`SELECT COUNT(DISTINCT r.object_id) AS n FROM mk_relevance r JOIN mk_objects o ON o.id = r.object_id AND o.type IN (${KNOW.map((t) => `'${t}'`).join(',')})
    WHERE r.objective_id IN ${SET} AND r.score >= ?2`).bind(reached, sup - 1e-9).first()) || {}).n || 0;
  const rows = coverageRows(x, { specialties, lifecycle, knowledge: { num: knum, den: kden } });
  const stored = new Map((await all(env, 'SELECT dimension, key, num, den FROM mk_coverage WHERE day = ?', day)).map((r) => [r.dimension + '|' + r.key, r]));
  const st = [];
  for (const r of rows) { const o = stored.get(r.dimension + '|' + r.key); if (o && o.num === r.num && o.den === r.den) continue;
    st.push(env.DB.prepare('INSERT INTO mk_coverage (day, dimension, key, num, den, pct) VALUES (?,?,?,?,?,?) ON CONFLICT (day, dimension, key) DO UPDATE SET num = excluded.num, den = excluded.den, pct = excluded.pct').bind(day, r.dimension, r.key, r.num, r.den, r.pct)); }
  const keep = new Date(Date.now() - (Number(CV.keep_days) || 30) * 864e5).toISOString().slice(0, 10);
  st.push(env.DB.prepare('DELETE FROM mk_coverage WHERE day < ?').bind(keep));
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return { day, writes: st.length - 1, rows, facts: x };
}

/* Pure: gap records from the facts and the extra lists. Each: {gap_id, kind, key, severity, detail, action}. */
export function gapRules(x, { specialtyRows = [], sources = [], citedSuperseded = [], lowLessons = [], orgsBySpecialty = {}, today = nowIso().slice(0, 10) } = {}) {
  const out = [], push = (kind, key, severity, detail, action) => out.push({ gap_id: kind + ':' + key, kind, key, severity: Math.round(Math.max(0, Math.min(1, severity)) * 1000) / 1000, detail, action });
  const acq = (specialty) => ({ type: 'recommended_acquisition', guideline_class: G.acquisition_class, specialty: specialty || null, organizations: (orgsBySpecialty[specialty] || []).slice(0, 4) });
  const w = (o) => x.objPri.has(o) ? x.objPri.get(o) / 100 : null;
  for (const o of x.canon) {
    const ew = w(o.id);
    if (!x.supported.has(o.id)) push('objective', o.id, ew ?? 0.3, { name: o.name, concept: o.c, exam_weight: ew }, acq(o.specialty));
    else if (ew != null && !x.lessonObj.has(o.id)) push('lesson', o.id, ew, { name: o.name, exam_weight: ew }, { type: 'recommended_lesson', objective: o.id });
    if (x.recObj.has(o.id) && !x.evObj.has(o.id)) push('evidence', o.id, 0.5 + (ew || 0) / 2, { name: o.name, exam_weight: ew }, { type: 'recommended_trial', objective: o.id, concept: o.c, note: 'add the landmark trials, systematic reviews or meta-analyses behind these recommendations' });
  }
  for (const t of x.topics) if (!(x.topicObjs.get(t.t) || []).some((o) => x.supported.has(o))) push('exam', t.t, (t.p || 0) / 100, { name: t.name, blueprint: t.b, family: t.f, priority: t.p, projected: (x.topicObjs.get(t.t) || []).length }, { ...acq(null), blueprint_topic: t.t });
  for (const s of specialtyRows) { const p = s.den ? s.num / s.den : 0;
    if (!s.sources || p * 100 < Number(G.specialty_min_pct)) push('specialty', s.key, 1 - p, { coverage_pct: Math.round(p * 10000) / 100, sources: s.sources, concepts: s.den }, acq(s.key)); }
  const stale = Number(G.stale_years) || 8, cutoff = String(Number(today.slice(0, 4)) - stale);
  for (const s of sources) {
    const md = s.md || {};
    if (md.review_date && md.review_date < today) push('update', s.id, 0.6, { name: s.name, review_date: md.review_date }, { type: 'recommended_update', source: s.id, reason: 'past its review date' });
    else if (s.spec === 'Guidelines' && (md.version_date || String(s.year || '')) && (md.version_date || String(s.year)) < cutoff) push('update', s.id, 0.4, { name: s.name, version_date: md.version_date || s.year }, { type: 'recommended_update', source: s.id, reason: `older than ${stale} years` });
  }
  for (const c of citedSuperseded) push('update', c.id, 0.8, { name: c.name, lessons: c.n, replaced_by: c.replaced_by || null }, { type: 'recommended_update', source: c.id, reason: 'superseded but still cited by current lessons', replaced_by: c.replaced_by || null });
  for (const l of lowLessons) push('confidence', l.id, 1 - l.score, { name: l.name, lesson_confidence: l.score }, { type: 'recommended_update', asset: l.id, reason: 'low lesson confidence: enrich or rewrite' });
  const cap = Number(G.max_per_kind) || 300, by = {};
  for (const g of out.sort((a, b) => b.severity - a.severity || a.gap_id.localeCompare(b.gap_id))) (by[g.kind] = by[g.kind] || []).push(g);
  return Object.values(by).flatMap((l) => l.slice(0, cap));
}

/* Detect gaps from the latest facts; open new ones, refresh changed ones, resolve the ones no longer produced. Returns counts. */
export async function detectGaps(env, x) {
  const today = nowIso().slice(0, 10);
  const spc = (await all(env, "SELECT dimension, key, num, den FROM mk_coverage WHERE day = ? AND dimension = 'specialty'", today));
  const srcBySpec = new Map((await all(env, "SELECT specialty AS k, COUNT(*) AS n FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified') GROUP BY specialty")).map((r) => [r.k, r.n]));
  const sources = (await all(env, `SELECT id, name, specialty, json_extract(body, '$.source_metadata') AS md, json_extract(body, '$.spec_source_type') AS spec, json_extract(body, '$.year') AS year, json_extract(body, '$.responsible_orgs') AS orgs
    FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified')`)).map((r) => ({ ...r, md: J(r.md, {}) || {}, orgs: J(r.orgs, []) || [] }));
  const orgsBySpecialty = {}; for (const s of sources) if (s.specialty) { const m = orgsBySpecialty[s.specialty] = orgsBySpecialty[s.specialty] || {}; for (const o of s.orgs) m[o] = (m[o] || 0) + 1; }
  for (const k of Object.keys(orgsBySpecialty)) orgsBySpecialty[k] = Object.entries(orgsBySpecialty[k]).sort((a, b) => b[1] - a[1]).map(([o]) => o);
  const citedSuperseded = await all(env, `SELECT s.id, s.name, json_extract(s.body, '$.replaced_by') AS replaced_by, COUNT(DISTINCT l.asset_id) AS n FROM mk_asset_links l JOIN mk_objects s ON s.id = l.object_id AND s.type = 'Source' AND s.status = 'superseded'
    JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current' WHERE l.rel = 'cites' GROUP BY s.id`);
  const lowLessons = await all(env, `SELECT c.object_id AS id, c.score, o.name FROM mk_confidence c JOIN mk_objects o ON o.id = c.object_id AND o.status = 'current' WHERE c.domain = 'lesson' AND c.score < ?`, Number(G.lesson_confidence_min) || 0.5);
  const gaps = gapRules(x, { specialtyRows: spc.map((r) => ({ key: r.key, num: r.num, den: r.den, sources: srcBySpec.get(r.key) || 0 })), sources, citedSuperseded, lowLessons, orgsBySpecialty, today });
  const stored = new Map((await all(env, 'SELECT gap_id, severity, detail_json, action_json, status FROM mk_gaps')).map((r) => [r.gap_id, r]));
  const at = nowIso(), st = [], seen = new Set(); let opened = 0, resolved = 0;
  for (const g of gaps) { seen.add(g.gap_id); const o = stored.get(g.gap_id), dj = JSON.stringify(g.detail), aj = JSON.stringify(g.action);
    if (o && o.status === 'open' && o.severity === g.severity && o.detail_json === dj && o.action_json === aj) continue;
    if (!o || o.status !== 'open') opened++;
    st.push(env.DB.prepare(`INSERT INTO mk_gaps (gap_id, kind, key, severity, detail_json, action_json, status, first_seen, last_seen) VALUES (?,?,?,?,?,?, 'open', ?, ?)
      ON CONFLICT (gap_id) DO UPDATE SET severity = excluded.severity, detail_json = excluded.detail_json, action_json = excluded.action_json, status = 'open', last_seen = excluded.last_seen`).bind(g.gap_id, g.kind, g.key, g.severity, dj, aj, at, at)); }
  for (const [id, o] of stored) if (o.status === 'open' && !seen.has(id)) { resolved++; st.push(env.DB.prepare("UPDATE mk_gaps SET status = 'resolved', last_seen = ? WHERE gap_id = ?").bind(at, id)); }
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return { gaps: gaps.length, opened, resolved, writes: st.length };
}

/* One coverage + gaps run (lifecycle.js schedules it daily and when sources wait at the gaps stage). */
export async function coverageAndGaps(env) {
  const snap = await coverageSnapshot(env);
  const g = await detectGaps(env, snap.facts);
  return { day: snap.day, coverage_writes: snap.writes, ...g };
}

/* Reads for the status operation and the page. */
export async function coverageLatest(env) {
  const d = await env.DB.prepare('SELECT MAX(day) AS d FROM mk_coverage').first(); if (!d || !d.d) return { day: null, dimensions: {} };
  const rows = await all(env, 'SELECT dimension, key, num, den, pct FROM mk_coverage WHERE day = ? ORDER BY dimension, key', d.d), dims = {};
  for (const r of rows) (dims[r.dimension] = dims[r.dimension] || []).push({ key: r.key, num: r.num, den: r.den, pct: r.pct });
  return { day: d.d, dimensions: dims };
}
export async function gapsList(env, { kind = null, limit = 50, status = 'open' } = {}) {
  const rows = await all(env, `SELECT gap_id, kind, key, severity, detail_json, action_json, status, first_seen, last_seen FROM mk_gaps WHERE status = ? ${kind ? 'AND kind = ?' : ''} ORDER BY severity DESC LIMIT ?`, status, ...(kind ? [kind] : []), Math.min(500, Number(limit) || 50));
  const counts = Object.fromEntries((await all(env, "SELECT kind, COUNT(*) AS n FROM mk_gaps WHERE status = 'open' GROUP BY kind")).map((r) => [r.kind, r.n]));
  return { counts, gaps: rows.map((r) => ({ id: r.gap_id, kind: r.kind, key: r.key, severity: r.severity, detail: J(r.detail_json, {}), action: J(r.action_json, {}), first_seen: r.first_seen })) };
}
