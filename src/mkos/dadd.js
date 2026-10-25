// DADD-AI (the Department of Advancing the Development of Deterministic AI, a USAP governance agency; MKOS is its highest governance
// priority): confidence triage of AI-made educational assets, owner review, learner reports, event procedures and the daily health
// report. Owner decision 2026-10-25 (specs/uepd_app_contract.md, USAP src/procedures.js): "Monitor everything, review exceptions."
// Rules only: no AI is asked how sure it is, and nothing here calls an AI.
//
// Confidence domains (0..1 each; weights from the owner, renormalized over the domains MKOS measured for the asset):
//   source .15            the cited sources are current editions (checkCitations); no citation = 0.5 (unknown)
//   evidence .20          the topic's current recommendations and guideline families the asset was grounded on (basis.recs / families)
//   objective_mapping .15 objectives that teach or assess the topic's concepts (basis.objs) plus an explicit blueprint objective; the
//                         MKOS Constitution maps nothing to only one objective, so one objective scores lower than two
//   ontology .15          the topic resolves to concepts in the graph (the concepts the asset teaches)
//   extraction .10        how the grounding recommendations were extracted (validated, rule-parsed or AI-extracted); measured only
//                         when the asset has grounding recommendations
//   generation .10        the app's independent accuracy review over the whole asset (validated, flagged segments, unreviewed)
//   review .15            past owner decisions on this content kind (accepted share, smoothed; 0.5 with no decisions yet)
// Everything MKOS stores is clinical, so it is the critical class. MKOS bands (fallback when USAP cannot be reached):
//   >= 0.95 green live · 0.90-0.95 yellow live_flagged (published, monitored) · 0.80-0.90 orange review_hold · < 0.80 red review_hold
//   (escalated, severity high, first in the owner's queue). Hard failures (a superseded citation, a rewrite of an owner-reviewed asset)
//   always go to review_hold whatever the score.
import { nowIso, J, getSetting, setSetting } from './db.js';

export const APP = 'doctor_companion_app';
const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, '0')).join('');
export const h12 = async (s) => (await sha(s)).slice(0, 12);
const r3 = (x) => Math.round(x * 1000) / 1000;

export const WEIGHTS = { source: 0.15, evidence: 0.20, objective_mapping: 0.15, ontology: 0.15, extraction: 0.10, generation: 0.10, review: 0.15 };
export const DEFAULT_BANDS = { critical: [{ min: 0.95, action: 'live' }, { min: 0.9, action: 'live_flagged' }, { min: 0.8, action: 'review_hold' }, { min: 0, action: 'review_hold' }],
  standard: [{ min: 0.95, action: 'live' }, { min: 0.85, action: 'live_flagged' }, { min: 0.7, action: 'live_review_later' }, { min: 0, action: 'review_hold' }], sampling_rate: 0.02 };
export const HELD = new Set(['review_hold', 'review', 'drop']);
/* An asset DADD-AI holds for review (or that a learner reported): needs ['review'] only, so it is served to no other learner. */
export const heldByTriage = (o) => !!(o && o.triage && (o.triage.queue === 'held' || o.triage.reported) && (o.needs || []).length && (o.needs || []).every((n) => n === 'review'));
const FAILURE = { source: 'source_currency', evidence: 'evidence_linkage', objective_mapping: 'objective_mapping', ontology: 'ontology_classification',
  extraction: 'recommendation_extraction', generation: 'generation_quality', review: 'validation' };

// ---- Hooks: the worker binds the node kit (emitEvent) once; tests bind a recorder. Emitting never throws and never blocks.
const H = { emit: null };
export function bindDadd({ emit } = {}) { H.emit = typeof emit === 'function' ? emit : null; }
export function emit(type, ev) { try { if (H.emit) H.emit(type, { surface: 'system', user_id: null, ...ev }); } catch { /* never throw */ } }

/* Pure: the domain scores MKOS can measure for one asset. x: { cited, cited_current, recs: [{validated, method}], families, objectives,
   concepts, review_status, flagged, history: { n, accept, edit }, owner_edited }. */
export function domains(x) {
  const s = {};
  s.source = x.cited ? x.cited_current / x.cited : 0.5;
  const nr = (x.recs || []).length;
  s.evidence = nr >= 3 ? 1 : nr === 2 ? 0.9 : nr === 1 ? 0.8 : x.families ? 0.65 : 0.35;
  const no = Number(x.objectives) || 0;
  s.objective_mapping = no >= 2 ? 1 : no === 1 ? 0.75 : 0.3;
  const nc = Number(x.concepts) || 0;
  s.ontology = nc >= 2 ? 1 : nc === 1 ? 0.85 : 0.3;
  if (nr) s.extraction = x.recs.reduce((a, r) => a + (r.validated ? 1 : r.method === 'ai_extraction' ? 0.7 : 0.9), 0) / nr;
  s.generation = x.owner_edited ? 1 : x.review_status === 'validated' ? Math.max(0.6, 1 - 0.08 * (Number(x.flagged) || 0)) : x.review_status === 'unreviewed' ? 0.4 : 0.2;
  const h = x.history || {};
  s.review = h.n ? ((h.accept || 0) + 0.5 * (h.edit || 0) + 1) / (h.n + 2) : 0.5;
  for (const k of Object.keys(s)) s[k] = r3(Math.max(0, Math.min(1, s[k])));
  return s;
}
export function composite(scores) {
  let w = 0, v = 0; for (const [k, s] of Object.entries(scores)) if (WEIGHTS[k] != null) { w += WEIGHTS[k]; v += WEIGHTS[k] * s; }
  return w ? r3(v / w) : 0;
}
/* Pure: route a confidence through a policy's bands (first band, highest min first, whose min <= confidence). Returns the action and
   the colour: the top band green, the bottom red, a live band in between yellow, a held one orange. */
export function routeBands(bands, c) {
  const list = [...(bands || [])].map((b) => ({ min: Number(b.min) || 0, action: String(b.action || 'review_hold') })).sort((a, b) => b.min - a.min);
  if (!list.length) return { action: 'review_hold', band: 'red' };
  let i = list.findIndex((b) => c >= b.min); if (i < 0) i = list.length - 1;
  let action = list[i].action;
  if (action === 'drop' || action === 'review') action = 'review_hold';   // DADD-AI 2026-10-25: MKOS content is held for review, never dropped
  const band = i === 0 ? 'green' : i === list.length - 1 ? 'red' : /^live/.test(action) ? 'yellow' : 'orange';
  return { action, band };
}
/* Pure: the whole assessment. hard: null | 'source_currency' | 'validation' (a superseded citation; a rewrite of an owner-reviewed asset). */
export function assess(scores, policy, { hard = null, critical = true, random = Math.random } = {}) {
  const confidence = composite(scores), P = policy || DEFAULT_BANDS;
  let { action, band } = routeBands(critical ? P.critical : P.standard, confidence);
  if (hard) { action = 'review_hold'; band = 'red'; }
  const keyOf = (k) => k === 'generation' && scores.generation < 0.5 ? 'validation' : FAILURE[k] || k;
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  const failure_mode = band === 'green' ? null : hard || (weakest ? keyOf(weakest[0]) : null);
  const contributing = [...new Set(Object.entries(scores).filter(([k, s]) => s < 0.85 && keyOf(k) !== failure_mode).map(([k]) => keyOf(k)))];
  const severity = band === 'red' ? 'high' : band === 'orange' ? 'moderate' : 'low';
  const sampled = action === 'live_flagged' || action === 'live_review_later' ? random() < (Number(P.sampling_rate) || 0) : false;
  const queue = HELD.has(action) ? 'held' : action === 'live' ? null : 'monitor';
  return { confidence, scores, band, action, failure_mode, contributing, severity, critical: !!critical, sampled, queue, hard_fail: hard || null };
}

// ---- The review policy from USAP (GET /api/v1/governance/review/policy?kind=, x-usap-app), cached an hour per kind; the defaults
// above when USAP cannot be reached (never blocks: 3 s, and a failure is cached for 5 minutes).
const PCACHE = new Map();
export const _resetPolicyCache = () => PCACHE.clear();
export async function policyFor(env, kind) {
  const k = String(kind || 'content'), hit = PCACHE.get(k), now = Date.now();
  if (hit && now < hit.until) return hit.p;
  let p = null;
  try {
    const b = env && env.USAP_UGF;
    if (b && typeof b.fetch === 'function') {
      const r = await b.fetch('https://usap.internal/api/v1/governance/review/policy?kind=' + encodeURIComponent(k), { headers: { 'x-usap-app': APP }, signal: AbortSignal.timeout(3000) });
      if (r && r.ok) { const j = await r.json(); if (j && Array.isArray(j.critical) && j.critical.length) p = { critical: j.critical, standard: Array.isArray(j.standard) && j.standard.length ? j.standard : DEFAULT_BANDS.standard,
        sampling_rate: Number.isFinite(Number(j.sampling_rate)) ? Number(j.sampling_rate) : DEFAULT_BANDS.sampling_rate, floor_delta: Number(j.floor_delta) || 0, from: 'usap' }; }
    }
  } catch { p = null; }
  const out = p || { ...DEFAULT_BANDS, floor_delta: 0, from: 'default' };
  PCACHE.set(k, { p: out, until: now + (p ? 3600e3 : 300e3) });
  return out;
}

/* Past owner decisions on this content kind (stored on the assets themselves: triage.review.decision). */
export async function historyFor(env, kind) {
  try {
    const rows = (await env.DB.prepare("SELECT json_extract(body, '$.triage.review.decision') AS d, COUNT(*) AS n FROM mk_objects WHERE type IN ('EducationalAsset','EducationalObject') AND json_extract(body, '$.triage.kind') = ? AND json_extract(body, '$.triage.review.decision') IS NOT NULL GROUP BY d").bind(String(kind)).all()).results;
    const h = { n: 0, accept: 0, edit: 0, reject: 0 }; for (const r of rows) { if (h[r.d] != null) h[r.d] += r.n; h.n += r.n; } return h;
  } catch { return { n: 0, accept: 0, edit: 0, reject: 0 }; }
}

// ---- Events (system scope: no user_id, no email, no learner content). Central labels only.
export async function contentAssessed(o, t, label) {
  emit('ContentAssessed', { node_id: o.id, idempotency_key: `${APP}:${o.id}:${String(o.content_sha || '').slice(0, 12)}:ContentAssessed`,
    metadata: { kind: t.kind, asset_id: o.id, label: String(label || '').slice(0, 120), confidence: t.confidence, scores: t.scores, band: t.band, action: t.action,
      failure_mode: t.failure_mode, contributing: t.contributing, severity: t.severity, critical: t.critical } });
}

/* SourceIngested (sop.source_ingestion): a new or changed library source; the trigger key is kept on its lifecycle record. */
export async function sourceTriggerKey(src) { return `${APP}:${src.id}:${String(src.md5 || '').slice(0, 12) || await h12(src.id + '|' + (src.drive_modified || ''))}:SourceIngested`; }
export function sourceIngested(key, src) { emit('SourceIngested', { node_id: src.id, idempotency_key: key, metadata: { label: String(src.name || '').slice(0, 120) } }); }
export async function procedureCompleted(trigger, { procedure = 'sop.source_ingestion', steps = 0, ai_calls = 0, queued_review = 0, written = 0, outcome = 'ok', label = '' } = {}) {
  emit('ProcedureCompleted', { idempotency_key: `${APP}:${(await sha(trigger)).slice(0, 16)}:ProcedureCompleted`,
    metadata: { procedure, trigger, steps, ai_calls, queued_review, written, outcome, label: String(label || '').slice(0, 120) } });
}
/* AI calls the extraction spent on one source in its current cycle (the extraction budget's own count, per source). */
export async function noteSourceAI(env, sid) { try { const k = 'uepd_ai:' + sid, n = Number(await getSetting(env, k)) || 0; await setSetting(env, k, String(n + 1)); } catch { /* counting never fails extraction */ } }
export async function takeSourceAI(env, sid) { try { const k = 'uepd_ai:' + sid, n = Number(await getSetting(env, k)) || 0; if (n) await setSetting(env, k, null); return n; } catch { return 0; } }

/* Coverage gaps: an objective with exam weight and no lesson (mk_gaps kind 'lesson', kept open/resolved by coverage.js). */
export async function coverageGap(type, g, at) {
  emit(type, { node_id: g.gap_id, idempotency_key: `${APP}:${g.gap_id}:${await h12(g.gap_id + '|' + at)}:${type}`,
    metadata: { area_id: g.gap_id, area: String((g.detail && g.detail.name) || g.key || '').slice(0, 120), measure: 'lessons_for_objective', value: type === 'CoverageGapClosed' ? 1 : 0, target: 1, queue: 'recommended_lesson' } });
}

// ---- The daily DADD-AI health report (node kit metrics, once a day). Each figure is optional: a table or measure that is not there
// yet sends nothing. emit(key, value).
export async function healthReport(env, M, now = Date.now()) {
  const one = async (sql, ...a) => { try { return await env.DB.prepare(sql).bind(...a).first(); } catch { return null; } };
  const ratio = (r, a = 'num', b = 'den') => r && Number(r[b]) > 0 ? r3(Number(r[a] || 0) / Number(r[b])) : null;
  const since30 = new Date(now - 30 * 864e5).toISOString(), since7 = new Date(now - 7 * 864e5).toISOString(), today = new Date(now).toISOString().slice(0, 10);
  const as = await one("SELECT COUNT(*) AS den, AVG(json_extract(body, '$.triage.confidence')) AS mean, SUM(CASE WHEN json_extract(body, '$.triage.band') IN ('orange','red') THEN 1 ELSE 0 END) AS num FROM mk_objects WHERE type = 'EducationalAsset' AND json_extract(body, '$.triage.assessed_at') >= ?", since30);
  if (as && as.den) { M('dadd_ai_overall_confidence', r3(Number(as.mean) || 0)); M('dadd_ai_failure_rate', ratio(as)); }
  // Curriculum topics: the current blueprints' topics with at least one current shared lesson (the coverage engine's lesson rows).
  const day = await one('SELECT MAX(day) AS d FROM mk_coverage');
  if (day && day.d) {
    const les = await one("SELECT SUM(num) AS num, SUM(den) AS den FROM mk_coverage WHERE day = ? AND dimension = 'lesson' AND key != 'objectives'", day.d); const v = ratio(les); if (v != null) M('dadd_ai_educational_coverage', v);
    const pop = await one("SELECT num, den FROM mk_coverage WHERE day = ? AND dimension = 'objective' AND key = 'supported'", day.d); const p = ratio(pop); if (p != null) M('dadd_ai_knowledge_population', p);
  }
  const bo = await one(`SELECT COUNT(DISTINCT bo.objective_id) AS den, COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM mk_asset_links l JOIN mk_objects a ON a.id = l.asset_id AND a.status = 'current'
      WHERE l.rel = 'teaches_objective' AND l.object_id = bo.objective_id AND l.asset_id LIKE 'ea.s.%') THEN bo.objective_id END) AS num
    FROM mk_blueprint_objectives bo JOIN mk_blueprint_registries r ON r.blueprint_id = bo.blueprint_id AND r.current_status = 'current'`);
  const ob = ratio(bo); if (ob != null) M('dadd_ai_objective_coverage', ob);
  const ev = await one(`SELECT COUNT(*) AS den, SUM(CASE WHEN EXISTS (SELECT 1 FROM mk_asset_links l WHERE l.asset_id = o.id AND l.rel = 'cites') THEN 1 ELSE 0 END) AS num
    FROM mk_objects o WHERE o.type = 'EducationalAsset' AND o.id LIKE 'ea.s.%' AND o.status = 'current'`);
  const el = ratio(ev); if (el != null) M('dadd_ai_evidence_linkage', el);
  // Ontology integrity: concepts that something links to (the daily reconciliation's orphan count), and that passed the schema.
  const rec = J((await one("SELECT v FROM mk_settings WHERE k = 'reconcile_report'") || {}).v, null), cn = await one("SELECT COUNT(*) AS n, SUM(CASE WHEN gov = 'stopped' THEN 1 ELSE 0 END) AS bad FROM mk_objects WHERE type = 'Concept'");
  if (rec && rec.orphans && typeof rec.orphans.unlinked_concepts === 'number' && cn && cn.n) M('dadd_ai_ontology_integrity', r3(Math.max(0, 1 - (rec.orphans.unlinked_concepts + (Number(cn.bad) || 0)) / cn.n)));
  const gc = await one(`SELECT COUNT(*) AS den, SUM(CASE WHEN status IN ('current','modified') AND COALESCE(json_extract(body, '$.source_metadata.review_date'), '9999') >= ? THEN 1 ELSE 0 END) AS num
    FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified','superseded')`, today);
  const g = ratio(gc); if (g != null) M('dadd_ai_guideline_currency', g);
  const pv = await one("SELECT COUNT(*) AS n FROM mk_objects WHERE type IN ('Recommendation','Claim','EvidenceObject','EducationalObject','Concept') AND created >= ?", since7);
  if (pv) M('dadd_ai_population_velocity', Number(pv.n) || 0);
}
