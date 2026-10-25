// AUTOMATIC IMPACT ANALYSIS and LEARNER STATE RECONCILIATION: from a changed object, find exactly what it touches, and update only that.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObjects, putObject } from './kb.js';
import { reach } from './graph.js';
import { bandOf } from './relevance.js';

const KIND = { Concept: 'concepts', Recommendation: 'recommendations', Guideline: 'guidelines', EducationalAsset: 'educational_assets', EducationalObject: 'educational_objects',
  CurriculumNode: 'curricula', BlueprintTopic: 'blueprint', Objective: 'objectives', EvidenceObject: 'evidence', Source: 'sources', Claim: 'claims' };

/* Determine impact of a change to `subject` for change event `eventId`. Writes the impact onto the event, flags affected assets
   (needs: review|regenerate), opens learner reconciliation rows, and returns the summary. Bounded: depth 2, 2000 objects. */
export async function analyzeImpact(env, eventId, subject, { actor = 'impact' } = {}) {
  const ev = await env.DB.prepare('SELECT * FROM mk_events WHERE id = ?').bind(eventId).first();
  const hit = await reach(env, [subject], { depth: 2, seedAll: true });
  const ids = [...hit.keys()];
  const objs = await getObjects(env, ids);
  const by = {}; for (const o of Object.values(objs)) (by[KIND[o.type] || o.type] = by[KIND[o.type] || o.type] || []).push(o.id);
  const subj = objs[subject];
  const superseded = subj && (subj.status === 'superseded' || subj.status === 'retired');
  // Assets stored outside MKOS (learner record documents) that cite or teach anything affected.
  const assets = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80), { results } = await env.DB.prepare(`SELECT DISTINCT asset_id, user_id, path, item, rel FROM mk_asset_links WHERE object_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    assets.push(...results);
  }
  for (const a of [...new Set(assets.map((x) => x.asset_id))]) {
    const cur = (await getObjects(env, [a]))[a]; if (!cur) continue;
    const need = superseded && assets.some((x) => x.asset_id === a && x.rel === 'cites') ? 'regenerate' : 'review';
    if (!(cur.needs || []).includes(need)) await putObject(env, { ...cur, needs: [...new Set([...(cur.needs || []), need])], review_status: 'needs_' + need }, { actor, event_id: eventId, summary: `flagged ${need}: ${subject} changed`, audited: false });
  }
  // Learner states on affected concepts / blueprint topics / curriculum nodes.
  const learnerObjs = [...(by.concepts || []), ...(by.blueprint || []), ...(by.curricula || [])];
  let learners = 0;
  for (let i = 0; i < learnerObjs.length; i += 80) {
    const part = learnerObjs.slice(i, i + 80), { results } = await env.DB.prepare(`SELECT user_id, object_id FROM mk_learner WHERE object_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results) { await env.DB.prepare('INSERT OR IGNORE INTO mk_reconcile (user_id, object_id, event_id, reason, state, at) VALUES (?, ?, ?, ?, \'open\', ?)').bind(r.user_id, r.object_id, eventId, (ev && ev.kind) || 'knowledge_changed', nowIso()).run(); learners++; }
  }
  const impact = {
    what_changed: [subject], what_did_not_change: ['everything outside the depth-2 neighborhood of ' + subject],
    superseded: superseded ? [subject] : [], recalculate: [...(by.recommendations || []), ...(by.concepts || [])].slice(0, 500),
    regenerate: assets.filter((x) => x.rel === 'cites' && superseded).map((x) => x.asset_id), review: [...new Set(assets.map((x) => x.asset_id))],
    republish: ['snapshot', 'compat_registry'], counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), learner_states: learners,
    affected_competencies: [...new Set(Object.values(objs).flatMap((o) => o.competencies || []))],
  };
  // Lesson and curriculum penetration of the change (stage 5): what the subject reaches, with scores, from the relevance graph.
  try { impact.penetration = (await computePenetration(env, subject)).summary; } catch (e) { impact.penetration = { error: String(e.message || e).slice(0, 200) }; }
  if (ev) await env.DB.prepare("UPDATE mk_events SET stage = 'impact_determined', impact = ?, updated = ? WHERE id = ?").bind(JSON.stringify(impact).slice(0, 60000), nowIso(), eventId).run();
  return impact;
}

/* ---------- LESSON AND CURRICULUM PENETRATION (lifecycle stage 5; lifecycle.json "penetration") ----------
   What a changed knowledge object (or a source, over its recommendations and what derives from them) reaches: objectives, lessons,
   curriculum nodes, board curriculum (blueprint topics) and exams, each with a score 0..1 and its band. Rules only, from mk_relevance,
   mk_asset_links, curriculum nodes and the blueprint tables. Stored in mk_penetration (derived), rewritten only where a score changed. */
const PEN = FRAMEWORK.frameworks.lifecycle.penetration;
const SETJ = '(SELECT value FROM json_each(?1))';
const r4 = (x) => Math.round(x * 10000) / 10000;
async function subjectObjects(env, subject) {
  const src = await env.DB.prepare("SELECT 1 AS x FROM mk_objects WHERE id = ? AND type = 'Source'").bind(subject).first();
  if (!src) return { source: false, sql: `SELECT ?1 AS id` };
  // Any edge status: a superseded or retired source still reaches what it touched.
  return { source: true, sql: `SELECT src AS id FROM mk_edges WHERE dst = ?1 AND rel IN ('derived_from','part_of')
    UNION SELECT c.src FROM mk_edges d JOIN mk_edges c ON c.dst = d.src AND c.rel = 'derived_from' WHERE d.dst = ?1 AND d.rel = 'derived_from' AND d.src LIKE 'rec.%'` };
}
/* Pure: penetration rows from objective scores and the target links. links: {lesson: [[target, objective]], curriculum: [...],
   board_curriculum: [...]}, exams: [[topic, blueprint family, priority]]. */
export function penetrationRows(objScores, links, exams = []) {
  const min = Number(PEN.min_score), cap = Number(PEN.max_per_kind) || 200, rows = [];
  const push = (kind, best) => rows.push(...[...best].filter(([, x]) => x.s >= min - 1e-9).sort((a, b) => b[1].s - a[1].s || a[0].localeCompare(b[0])).slice(0, cap)
    .map(([t, x]) => ({ target_kind: kind, target_id: t, score: r4(x.s), band: bandOf(x.s), basis: x.basis })));
  push('objective', new Map([...objScores].map(([o, s]) => [o, { s, basis: { via: 'relevance' } }])));
  for (const kind of ['lesson', 'curriculum', 'board_curriculum']) {
    const best = new Map();
    for (const [t, o] of links[kind] || []) { const s = objScores.get(o); if (s == null) continue; const c = best.get(t); if (!c || c.s < s) best.set(t, { s, basis: { objective: o } }); }
    push(kind, best);
  }
  const ex = new Map();
  for (const [topic, fam, pri, o] of exams) { const s = (objScores.get(o) || 0) * (Number(pri) || 0) / 100; const c = ex.get(fam); if (!c || c.s < s) ex.set(fam, { s, basis: { topic, objective: o, priority: pri } }); }
  push('exam', ex);
  return rows;
}
export async function computePenetration(env, subject, { store = true } = {}) {
  const so = await subjectObjects(env, subject);
  const objRows = (await env.DB.prepare(`SELECT r.objective_id AS o, MAX(r.score) AS s FROM mk_relevance r WHERE r.object_id IN (${so.sql}) GROUP BY r.objective_id`).bind(subject).all()).results;
  const objScores = new Map(objRows.filter((r) => r.s >= Number(PEN.min_score) - 1e-9).map((r) => [r.o, r.s]));
  const ids = JSON.stringify([...objScores.keys()]), links = { lesson: [], curriculum: [], board_curriculum: [] }, exams = [];
  if (objScores.size) {
    links.lesson = (await env.DB.prepare(`SELECT l.asset_id AS t, 'obj.c.' || substr(l.object_id, 3) AS o FROM mk_asset_links l JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current'
        WHERE l.rel = 'teaches' AND l.asset_id LIKE 'ea.s.les.%' AND l.object_id IN (SELECT 'c.' || substr(value, 7) FROM json_each(?1))
      UNION SELECT l.asset_id, p.dst FROM mk_asset_links l JOIN mk_edges p ON p.src = l.object_id AND p.rel = 'projects_objective' AND p.status = 'current' JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current'
        WHERE l.rel = 'teaches_objective' AND l.asset_id LIKE 'ea.s.%' AND p.dst IN ${SETJ}`).bind(ids).all()).results.map((r) => [r.t, r.o]);
    links.curriculum = (await env.DB.prepare(`SELECT e.src AS t, 'obj.c.' || substr(e.dst, 3) AS o FROM mk_edges e WHERE e.rel = 'covers' AND e.status = 'current' AND e.src LIKE 'cn.%'
      AND e.dst IN (SELECT 'c.' || substr(value, 7) FROM json_each(?1))`).bind(ids).all()).results.map((r) => [r.t, r.o]);
    links.board_curriculum = (await env.DB.prepare(`SELECT p.src AS t, p.dst AS o FROM mk_edges p WHERE p.rel = 'projects_objective' AND p.status = 'current' AND p.dst IN ${SETJ}`).bind(ids).all()).results.map((r) => [r.t, r.o]);
    const topicObj = new Map(); for (const [t, o] of links.board_curriculum) { const s = objScores.get(o); if (!topicObj.has(t) || objScores.get(topicObj.get(t)) < s) topicObj.set(t, o); }
    if (topicObj.size) for (const r of (await env.DB.prepare(`SELECT bo.objective_id AS t, r.blueprint_family AS f, bo.priority_score AS p FROM mk_blueprint_objectives bo JOIN mk_blueprint_registries r ON r.blueprint_id = bo.blueprint_id AND r.current_status = 'current'
      WHERE bo.objective_id IN ${SETJ}`).bind(JSON.stringify([...topicObj.keys()])).all()).results) exams.push([r.t, r.f, r.p, topicObj.get(r.t)]);
  }
  const rows = penetrationRows(objScores, links, exams);
  const summary = { subject, source: so.source, at: nowIso(), counts: {}, top: {} };
  for (const r of rows) { summary.counts[r.target_kind] = (summary.counts[r.target_kind] || 0) + 1; const t = summary.top[r.target_kind] = summary.top[r.target_kind] || []; if (t.length < 5) t.push([r.target_id, r.score]); }
  summary.exams = Object.fromEntries(rows.filter((r) => r.target_kind === 'exam').map((r) => [r.target_id, r.score]));
  if (store) summary.writes = await storePenetration(env, subject, rows);
  return { rows, summary };
}
async function storePenetration(env, subject, rows) {
  const stored = new Map((await env.DB.prepare('SELECT target_kind, target_id, score, band, basis_json FROM mk_penetration WHERE subject_id = ?').bind(subject).all()).results.map((r) => [r.target_kind + '|' + r.target_id, r]));
  const at = nowIso(), keep = new Set(), st = [];
  for (const r of rows) { const k = r.target_kind + '|' + r.target_id, b = JSON.stringify(r.basis), o = stored.get(k); keep.add(k);
    if (o && o.score === r.score && o.band === r.band && o.basis_json === b) continue;
    st.push(env.DB.prepare(`INSERT INTO mk_penetration (subject_id, target_kind, target_id, score, band, basis_json, computed_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (subject_id, target_kind, target_id) DO UPDATE SET score = excluded.score, band = excluded.band, basis_json = excluded.basis_json, computed_at = excluded.computed_at`).bind(subject, r.target_kind, r.target_id, r.score, r.band, b, at)); }
  for (const [k] of stored) if (!keep.has(k)) { const [kind, ...t] = k.split('|'); st.push(env.DB.prepare('DELETE FROM mk_penetration WHERE subject_id = ? AND target_kind = ? AND target_id = ?').bind(subject, kind, t.join('|'))); }
  for (let i = 0; i < st.length; i += 40) await env.DB.batch(st.slice(i, i + 40));
  return st.length;
}
/* Read: what a subject reaches (stored), or, with target, the subjects that reach one lesson / objective / curriculum node. */
export async function penetrationOf(env, { subject = null, target = null, limit = 50 } = {}) {
  if (target) return { target, subjects: (await env.DB.prepare('SELECT subject_id, target_kind, score, band, computed_at FROM mk_penetration WHERE target_id = ? ORDER BY score DESC LIMIT ?').bind(target, Math.min(500, limit)).all()).results };
  const rows = (await env.DB.prepare('SELECT target_kind, target_id, score, band, basis_json, computed_at FROM mk_penetration WHERE subject_id = ? ORDER BY target_kind, score DESC').bind(subject).all()).results;
  const by = {}; for (const r of rows) { const l = by[r.target_kind] = by[r.target_kind] || []; if (l.length < limit) l.push({ id: r.target_id, score: r.score, band: r.band, basis: J(r.basis_json, {}) }); }
  return { subject, targets: by, computed_at: rows.length ? rows[0].computed_at : null };
}

// Re-score objects whose inputs changed (Update Affected Nodes). Only what impact analysis listed.
export async function rescore(env, ids, { actor = 'rescore', event_id = null } = {}) {
  const objs = await getObjects(env, ids); let n = 0;
  const srcIds = [...new Set(Object.values(objs).map((o) => o.source_id).filter(Boolean))], srcs = await getObjects(env, srcIds);
  for (const o of Object.values(objs)) {
    const src = o.source_id ? srcs[o.source_id] : null;
    // A recommendation from a superseded or retired source follows its source (Preserve Supersession).
    const status = src && (src.status === 'superseded' || src.status === 'retired') && o.status === 'current' ? 'superseded' : o.status;
    const r = await putObject(env, { ...o, status, replaced_by: status !== o.status ? src.replaced_by || null : o.replaced_by }, { actor, event_id, srcScores: src ? src.scores : null, summary: 'rescored after upstream change', audited: false, rescore: true });
    if (r.changed || r.rescored) n++;
  }
  return n;
}
