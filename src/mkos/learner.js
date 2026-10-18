// Learner Intelligence Layer: the digital twin. One state per learner per object at every granularity level (concept, blueprint
// topic, curriculum node, domain, specialty, competency), each with Mastery + Confidence + Interaction Count + Evidence Density +
// Signal Stability + Recency, retention and calibration. Mastery and confidence are tracked separately (Confidence Model).
// Inputs are the learner's own record (deterministic derivation from med/state, question history, card ratings) and live events.
import { J, nowIso, fwGet, overrides } from './db.js';
import { getObjects } from './kb.js';
import { nodeForTopic } from './education.js';

const DAY = 864e5, clamp = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));
const MODEL = 'learner-1';

// Core estimators.
export function estimate(sig, L) {
  // sig: {n, c, rating (1-5|0), last (ms), cards: {n, conf}, lessons}
  const w = L.prior_weight, prior = L.mastery_prior / 100;
  const n = sig.n || 0, c = sig.c || 0;
  let acc = (c + prior * w) / (n + w);                                      // smoothed accuracy
  if (sig.cards && sig.cards.n) acc = (acc * (n + w) + (sig.cards.conf / 5) * sig.cards.n * 0.5) / (n + w + sig.cards.n * 0.5);
  if (sig.rating) acc = acc * 0.85 + ((sig.rating - 1) / 4) * 0.15;          // self-rating nudges, never dominates
  if (sig.lessons && !n) acc = Math.max(acc, 0.35 + 0.05 * Math.min(3, sig.lessons));
  const days = sig.last ? (Date.now() - sig.last) / DAY : 365, hl = L.half_life_days;
  const recency = Math.pow(0.5, days / hl);                                  // 1 = today
  const retention = sig.last ? acc * (0.5 + 0.5 * recency) : 0;
  const evidence = n + (sig.cards?.n || 0) * 0.5 + (sig.lessons || 0) * 0.5 + (sig.rating ? 0.5 : 0);
  const density = evidence / (evidence + L.saturation_n / 3);
  const stability = n >= 3 ? 1 - Math.min(1, Math.abs(acc - (c / n))) : 0.3;
  const confidence = clamp(100 * density * (0.6 + 0.4 * recency) * (0.7 + 0.3 * stability));
  return { mastery: clamp(100 * acc * (0.75 + 0.25 * recency)), confidence, interactions: n + (sig.cards?.n || 0) + (sig.lessons || 0), evidence_density: clamp(100 * density),
    stability: clamp(100 * stability), recency: clamp(100 * recency),
    retention: { estimate: clamp(100 * retention), confidence: clamp(confidence * 0.9), strength: clamp(100 * acc), forgetting_risk: clamp(100 * (1 - recency) * (sig.last ? 1 : 0)), next_review: sig.last ? new Date(sig.last + hl * DAY * Math.max(0.2, acc)).toISOString().slice(0, 10) : null } };
}
export const knowledgeState = (m, conf) => m >= 90 && conf >= 70 ? 'Mastery' : m >= 80 ? 'Clinical Reasoning' : m >= 70 ? 'Application' : m >= 60 ? 'Understanding' : m >= 45 ? 'Recall' : 'Recognition';

async function L(env) {
  const o = await overrides(env), S = fwGet('scoring', o);
  return { prior_weight: S.learner.prior_weight, mastery_prior: S.learner.mastery_prior, saturation_n: S.learner.confidence_saturation_n, half_life_days: S.decay.learner_half_life_days,
    confident: S.learner.calibration_confident_rating, w: S.learner.curriculum_priority_weights, low: S.low_confidence.threshold };
}
async function writeStates(env, uid, rows) {
  for (let i = 0; i < rows.length; i += 60) await env.DB.batch(rows.slice(i, i + 60).map((r) => env.DB.prepare(`INSERT INTO mk_learner (user_id, object_id, level, mastery, conf, priority, body, updated) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (user_id, object_id) DO UPDATE SET level=excluded.level, mastery=excluded.mastery, conf=excluded.conf, priority=excluded.priority, body=excluded.body, updated=excluded.updated`)
    .bind(uid, r.object_id, r.level, r.mastery, r.confidence, r.priority || 0, JSON.stringify(r), r.updated)));
}

/* Derive the whole twin from the learner's record. docs: {'med/state': {...}, 'med/bank_*': {...}, 'med/cards_*': {...}}.
   Topic signals -> curriculum node + its concepts + blueprint topics; then roll up to domain, specialty and competency. */
export async function deriveFromRecord(env, uid, docs, { actor = 'learner' } = {}) {
  const P = await L(env), st = docs['med/state'] || {}, topics = st.topics || {}, now = nowIso();
  const sig = {};                     // topic id -> signals
  const get = (tid) => (sig[tid] = sig[tid] || { n: 0, c: 0, rating: 0, last: 0, lessons: 0, cards: { n: 0, conf: 0 }, cal: { correct_confident: 0, correct_uncertain: 0, incorrect_confident: 0, incorrect_uncertain: 0 }, wrong: [] });
  for (const [tid, t] of Object.entries(topics)) { const s = get(tid); s.n = t.n || 0; s.c = t.c || 0; s.rating = t.rate || 0; s.last = Math.max(t.last || 0, t.rated || 0, t.asked || 0); s.lessons = t.les || 0; }
  for (const [path, d] of Object.entries(docs)) {
    if (/^med\/bank_/.test(path)) for (const q of d.qs || []) for (const h of q.hist || []) {
      const s = get(q.tid), conf = (topics[q.tid] || {}).rate >= P.confident;
      s.cal[(h.ok ? 'correct_' : 'incorrect_') + (conf ? 'confident' : 'uncertain')]++; s.last = Math.max(s.last, h.t || 0);
      if (!h.ok && conf) s.wrong.push({ q: q.id, t: h.t, path });
    }
    if (/^med\/cards_/.test(path)) for (const c of d.cards || []) if (c.n) { const s = get(c.tid); s.cards.conf = (s.cards.conf * s.cards.n + (c.conf || 0) * c.n) / (s.cards.n + c.n); s.cards.n += c.n; }
  }
  const nodeIds = Object.keys(sig).map(nodeForTopic), nodes = await getObjects(env, nodeIds);
  const conceptIds = [...new Set(Object.values(nodes).flatMap((n) => n.concepts || []))], concepts = await getObjects(env, conceptIds);
  const rows = [], agg = {};             // object id -> {level, list of [state, weight]}
  const add = (id, level, s, w = 1) => { (agg[id] = agg[id] || { level, parts: [] }).parts.push([s, w]); };
  for (const [tid, s] of Object.entries(sig)) {
    const e = estimate(s, P), node = nodes[nodeForTopic(tid)];
    const row = { object_id: node ? node.id : 'topic:' + tid, level: 'curriculum_node', ...e, calibration: s.cal, knowledge_state: knowledgeState(e.mastery, e.confidence), legacy_topic_id: tid, updated: now, model_version: MODEL };
    rows.push(row);
    if (node) for (const c of node.concepts || []) add(c, 'concept', row);
    if (node) for (const b of node.blueprint_topics || []) add(b, 'blueprint_topic', row);
  }
  const roll = (parts) => {
    const W = parts.reduce((a, [, w]) => a + w, 0) || 1, f = (k) => parts.reduce((a, [s, w]) => a + (s[k] || 0) * w, 0) / W;
    // Confidence may not increase upward without new evidence: the rollup's confidence is no higher than its best-supported part.
    return { mastery: clamp(f('mastery')), confidence: clamp(Math.min(f('confidence'), Math.max(...parts.map(([s]) => s.confidence)))), interactions: parts.reduce((a, [s]) => a + (s.interactions || 0), 0),
      evidence_density: clamp(f('evidence_density')), stability: clamp(f('stability')), recency: clamp(Math.max(...parts.map(([s]) => s.recency || 0))) };
  };
  for (const [id, a] of Object.entries(agg)) { const r = roll(a.parts); rows.push({ object_id: id, level: a.level, ...r, knowledge_state: knowledgeState(r.mastery, r.confidence), updated: now, model_version: MODEL }); }
  // Domains and specialties from concepts; competencies from blueprint topics' develops edges.
  const up = {};
  for (const id of Object.keys(agg).filter((x) => agg[x].level === 'concept')) {
    const c = concepts[id], s = rows.find((r) => r.object_id === id); if (!c || !s) continue;
    for (const d of c.domains || []) (up[d] = up[d] || { level: 'domain', parts: [] }).parts.push([s, 1]);
    for (const sp of c.specialty || []) (up[sp] = up[sp] || { level: 'specialty', parts: [] }).parts.push([s, 1]);
  }
  const bpts = Object.keys(agg).filter((x) => agg[x].level === 'blueprint_topic');
  for (let i = 0; i < bpts.length; i += 80) {
    const part = bpts.slice(i, i + 80), { results } = await env.DB.prepare(`SELECT src, dst, conf FROM mk_edges WHERE rel = 'develops' AND src IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const e of results) { const s = rows.find((r) => r.object_id === e.src); if (s) (up[e.dst] = up[e.dst] || { level: 'competency', parts: [] }).parts.push([s, e.conf / 100]); }
  }
  for (const [id, a] of Object.entries(up)) { const r = roll(a.parts); rows.push({ object_id: id, level: a.level, ...r, knowledge_state: knowledgeState(r.mastery, r.confidence), updated: now, model_version: MODEL }); }
  // Priority (Confidence Aware Curriculum Rule) on concept and blueprint-topic rows.
  const bps = await getObjects(env, bpts);
  for (const r of rows) {
    const rel = r.level === 'blueprint_topic' ? (bps[r.object_id]?.est_pct || 0) : r.level === 'concept' ? (concepts[r.object_id]?.board?.lka_weight || concepts[r.object_id]?.board?.abim_weight || 0) : 0;
    r.board_relevance = clamp(Math.min(100, rel * 40));
    r.priority = clamp(P.w.knowledge_deficit * (100 - r.mastery) + P.w.retention_risk * (r.retention?.forgetting_risk || (100 - r.recency)) + P.w.board_relevance * r.board_relevance + P.w.competency_importance * 50 + P.w.low_confidence * (100 - r.confidence));
  }
  await writeStates(env, uid, rows);
  // Incorrect + Confident -> misconception records (Misconception Detection, Reasoning Review, Targeted Remediation).
  let mis = 0;
  for (const [tid, s] of Object.entries(sig)) if (s.wrong.length) {
    const node = nodes[nodeForTopic(tid)], target = node ? ((node.concepts || [])[0] || node.id) : 'topic:' + tid;
    const at = new Date(Math.max(...s.wrong.map((w) => w.t || 0))).toISOString();
    await env.DB.prepare(`INSERT INTO mk_misconceptions (user_id, object_id, kind, status, n, body, first_seen, last_seen) VALUES (?, ?, 'reasoning_error', 'open', ?, ?, ?, ?)
      ON CONFLICT (user_id, object_id, kind) DO UPDATE SET n = excluded.n, body = excluded.body, last_seen = excluded.last_seen, status = CASE WHEN mk_misconceptions.status = 'resolved' THEN 'open' ELSE mk_misconceptions.status END`)
      .bind(uid, target, s.wrong.length, JSON.stringify({ evidence: s.wrong.slice(-10), topic: tid }), at, at).run();
    mis++;
  }
  await env.DB.prepare('INSERT INTO mk_learner_events (user_id, at, kind, object_ids, detail) VALUES (?, ?, ?, ?, ?)').bind(uid, now, 'derived_from_record', '[]', JSON.stringify({ topics: Object.keys(sig).length, states: rows.length, misconceptions: mis, by: actor })).run();
  return { topics: Object.keys(sig).length, states: rows.length, misconceptions: mis };
}

export async function learnerSummary(env, uid, { level = null, limit = 50 } = {}) {
  const q = level ? 'SELECT object_id, level, mastery, conf, priority, body FROM mk_learner WHERE user_id = ? AND level = ? ORDER BY priority DESC LIMIT ?' : 'SELECT object_id, level, mastery, conf, priority, body FROM mk_learner WHERE user_id = ? ORDER BY priority DESC LIMIT ?';
  const { results } = await env.DB.prepare(q).bind(...(level ? [uid, level, limit] : [uid, limit])).all();
  return results.map((r) => ({ ...J(r.body, {}), object_id: r.object_id, level: r.level }));
}
