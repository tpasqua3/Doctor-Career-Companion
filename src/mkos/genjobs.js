// THE GENERATION QUEUE (mkos/ontology/assets.json "generation_queue"): lessons as jobs bound to one writing model from start to finish.
//
//   gen_add / gen_batch  ->  mk_gen row  ->  runner 'server': the server writes it part by part on the 5-minute run (and while a page
//                                            pumps it), whether or not the page is open; it continues from the step it reached after any
//                                            interruption, and waits for the next UTC day when the model's daily allowance is used.
//                                         ->  runner 'page': Claude inside the Claude app (no server key): the page writes it and
//                                            checkpoints each part here; when the page goes away the job is paused and resumes on return.
//   done -> the lesson is written to the account (med/les_<id>) for the app to file, and stored as an MKOS educational asset after its
//           accuracy review (shared, or the learner's own when personalized), with its generation metadata and confidence tier.
//
// Objective seeding: one foundational pass-1 lesson per ABIM blueprint objective, written in the background from MKOS's shared
// knowledge, paced so the owner's own study always keeps `seed.reserve_calls` of the writing model's daily allowance, and persisted in
// this queue until every objective is seeded. Quality and completion come before speed.
//
// The writing prompts below mirror genLesson(), auditLesson(), genQuestions() and genCards() in app/companion.html: a lesson written on
// the server reads exactly like one written in the page. Change them together.
import { wordingFor, defaultFamily, learnerFamily, familyOfBlueprint } from './wording.js';
import { layerPlan, layeredOutline } from './layers.js';
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject } from './kb.js';
import { putAssets } from './assets.js';
import { topicContext } from './bridge.js';
import { examFamily } from './education.js';
import { markJob, markUser, markObjectives } from './ite_marks.js';

const QP = () => FRAMEWORK.frameworks.assets.generation_queue;
const GM = () => FRAMEWORK.frameworks.assets.generation_metadata;
const LPART = 1500, LEASE = 240e3;
const uid = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const A = (x) => Array.isArray(x) ? x : [];
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const nextUtcDay = () => { const d = new Date(); d.setUTCHours(24, 6, 0, 0); return d.getTime(); };
// (06 minutes past midnight UTC: just after the allowance resets.)

let READY = false;
// Tests only: open a second database in the same process.
export const _resetGenInit = () => { READY = false; };
export async function genInit(env) {
  if (READY) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mk_gen (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, batch TEXT, kind TEXT NOT NULL, title TEXT, status TEXT NOT NULL,
      runner TEXT NOT NULL, model TEXT, spec TEXT NOT NULL, state TEXT, result TEXT, note TEXT, not_before INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0,
      tries INTEGER NOT NULL DEFAULT 0, filed INTEGER NOT NULL DEFAULT 0, prio REAL NOT NULL DEFAULT 0, objective TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS mk_gen_user ON mk_gen (user_id, status, created)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS mk_gen_run ON mk_gen (runner, status, not_before, prio)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS mk_gen_obj ON mk_gen (objective)'),
  ]);
  READY = true;
}

/* ---------- Lenient JSON (a reply may carry code fences or a sentence around the object) ---------- */
function parseJ(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { } }
  return null;
}
/* ---------- Ports of the page's helpers ---------- */
const cleanTable = (x) => { if (!x || typeof x !== 'object') return null; const c = A(x.columns).map((v) => S(v, 80)).slice(0, 8), r = A(x.rows).filter(Array.isArray).map((row) => row.slice(0, c.length || 8).map((v) => S(v ?? '', 260))).filter((row) => row.some(Boolean)).slice(0, 30); return c.length >= 2 && r.length >= 2 ? { t: S(x.title, 140), c, r } : null; };
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(with|from|that|this|other|disease|diseases|disorders|management|evaluation|approach|common|care|medicine)$/.test(w));
const figWords = (f) => { const w = words(f.title || ''); return w.length ? w : [String(f.title || '').toLowerCase()]; };
const figFits = (f, seg) => { const low = ((seg.heading || '') + ' ' + (seg.text || '')).toLowerCase(), w = figWords(f), n = w.filter((x) => low.includes(x.slice(0, Math.max(5, x.length - 2)))).length; return f.pdf ? n >= Math.min(w.length, Math.max(2, Math.ceil(w.length * 0.6))) : n === w.length; };
const figRef = (f) => f.pdf ? { pdf: 1, fid: f.fid, sz: f.sz || 0, label: f.label, title: f.title, legend: f.legend, parts: f.parts, from: f.from, cite: f.cite } : { fid: f.fid, title: f.title, legend: f.legend };
const clip = (x, n) => { x = String(x || '').trim(); if (x.length <= n) return x; const c = x.slice(0, n), e = Math.max(c.lastIndexOf('. '), c.lastIndexOf('; ')); return e > n * 0.5 ? c.slice(0, e + 1) : c.slice(0, c.lastIndexOf(' ')) + '…'; };
const headTail = (x, n) => { const w = String(x || '').trim().split(/\s+/); return w.length <= n ? w.join(' ') : w.slice(0, n).join(' ') + ' …'; };
const lessonGist = (L) => `"${L.title}". Its sections: ${L.segs.map((x) => x.h).filter(Boolean).join('; ')}. Its key points: ${L.pts.join(' ')}`;

const SEG = `{"heading":"short heading","text":"spoken paragraph(s)","flag":"one sentence naming what in this segment is uncertain, disputed or possibly out of date; empty string if nothing","table":null or {"title":"","columns":["",""],"rows":[["",""]]},"figure":null or the number of one listed figure}`;
const TAIL = `"keyPoints":["4 to 6 one-sentence take-aways"],"pitfalls":["1 to 3 common errors"],"sources":["Organization. Guideline or statement title. Year."],"uncertain":["anything the physician should verify, or empty"]`;
/* One part's task, exactly as genLesson() writes it in the page. */
function partTask(k, N, per, words, outline, segs) {
  const lastP = k === N - 1;
  if (N === 1) return `\n\nReply with JSON only: {"title":"","segments":[${SEG}],${TAIL}}\nUse 4 to 7 segments.`;
  if (k === 0) return `\n\nThis lesson is long, so it is written in ${N} parts of about ${per} words each. First plan the whole lesson as an ordered outline of ${Math.max(7, Math.min(26, Math.round(words / 300)))} or so segment headings that follows the shape above. Then write PART 1 only: the opening case and the first segments of the outline, about ${per} words, stopping at the end of a segment.\n\nReply with JSON only: {"title":"","outline":["every segment heading of the whole lesson, in order"],"segments":[${SEG}]}`;
  return `\n\nThis lesson is being written in ${N} parts of about ${per} words each.\nOUTLINE of the whole lesson: ${outline.map((h, i) => (i + 1) + '. ' + h).join(' | ')}\nALREADY WRITTEN, in brief (do not repeat or re-teach any of it, and stay consistent with it): ${segs.map((x) => '[' + x.heading + '] ' + headTail(x.text, 40)).join(' ')}\nThe text so far ends: "…${String(segs[segs.length - 1].text).slice(-500)}"\nWrite PART ${k + 1} only: carry straight on with the next segments of the outline that are not yet written${lastP ? ', through to the end of the outline: come back to the opening case, work through the decision, and finish with what to do differently in clinic' : ', stopping at the end of a segment'}, about ${per} words. Keep the outline's headings.\n\nReply with JSON only: {"segments":[${SEG}]${lastP ? ',' + TAIL : ''}}`;
}
function reviewGroups(segs) { const groups = []; let cur = [], n = 0; segs.forEach((x, i) => { const w = String(x.text || '').split(/\s+/).length; if (cur.length && n + w > 1700) { groups.push(cur); cur = []; n = 0; } cur.push(i); n += w; }); if (cur.length) groups.push(cur); return groups; }
function reviewPrompt(sp, st, g) {
  const groups = st.groups, last = g === groups.length - 1, many = groups.length > 1, r = st;
  return `${sp.rhead}\n\nYou are now the fact-checking editor for this lesson before it is read aloud to a physician. Check every factual statement against current guidelines${sp.hasRef ? ' and the reference text' : ''}: each recommendation, drug, dose, threshold, criterion, percentage, trial name and guideline attribution. Then check that the parts agree with each other: each table against the spoken text of its segment and, where key points and pitfalls are given, those against the lesson.\nFor each segment give a verdict. "ok": nothing wrong. "fix": something is wrong, outdated or inconsistent and you are confident of the correction; return the whole corrected spoken text (same voice and length, still written to be heard) and, if its table needed changing, the whole corrected table. "flag": a claim may be wrong or out of date but you are not sure of the right answer; leave the text and say what to verify. A segment may carry a figure from the reference text, given by its title and legend. For such a segment set "figureOk": true only if the segment is specifically about the exact condition or finding that the figure's title and legend name, so that the picture and the words describe the same thing, and nothing the segment says about its appearance contradicts the legend; if there is any doubt set it to false and the picture will be left out. Be strict about numbers and attributions and do not rewrite for style. Never introduce a fact you are unsure of.${many ? `\nThe lesson is long and is being reviewed in ${groups.length} parts; this is part ${g + 1}. Its sections in order: ${r.segs.map((x) => x.heading).filter(Boolean).join(' | ')}.${last ? ' The key points and pitfalls summarize the whole lesson, of which you see only the last part: change one only if it states something that is wrong under current guidelines or contradicts the segments you can see.' : ''}` : ''}\n\nLESSON:\n${JSON.stringify(Object.assign({ title: r.title, segments: groups[g].map((i) => { const x = r.segs[i]; return { i, heading: x.heading, text: x.text, table: x.table || null, figure: x.fig ? { title: x.fig.title, legend: x.fig.legend } : null }; }) }, last ? { keyPoints: A(r.pts), pitfalls: A(r.pit) } : {}))}\n\nReply with JSON only: {"segments":[{"i":${groups[g][0]},"verdict":"ok" or "fix" or "flag","text":"corrected text, only for fix","table":null or the corrected table {"title":"","columns":[],"rows":[[]]},"figureOk":true or false (only for a segment that has a figure),"note":"what was wrong and what you changed, or what to verify; empty for ok"}]${last ? ',"keyPoints":null or the full corrected list,"pitfalls":null or the full corrected list' : ''}}`;
}

/* ---------- Server-built prompts for objective seeding (no page involved). They follow rules() in the app with a neutral learner,
   because a seeded lesson is shared by every account. ---------- */
// W: the family's prompt wording (wording.js); the default family (ABIM internal medicine) gives exactly the text used before.
export function seedRules(bt, name, specialties, W = wordingFor(defaultFamily())) {
  return `You are the teaching engine of a continuing medical education app for ${W.audience}.
Learner: ${W.learner}.
Practice setting to emphasize: Mixed.
Section: ${bt.category || W.section_default} — ${bt.subcategory || ''}. Topic: ${name}.
Rules:
- Attending level. No basic-science padding. Favor the decisions that change management and the points examiners test.
- Base every clinical statement on the current guidelines of the major societies${specialties ? ' (for this section: ' + specialties + ')' : ''} and on the MKOS knowledge supplied below. Name the guideline body and year when you state a recommendation.
- Recency: for anything time-sensitive (guideline recommendations, treatment thresholds and targets, drug choices and approvals, screening intervals) the most recent authoritative source wins; where a newer guideline you are confident of differs from an older text, follow the newer guidance and say that the older text has been superseded.
- Order of authority: the current guideline or statement of the governing professional society; then landmark trials and major secondary sources. Never fill a gap with a guess.
- This is board preparation for ${W.board}, and the published blueprint decides what matters. Blueprint objective: "${name}" under ${bt.category || ''}${bt.subcategory ? ', ' + bt.subcategory : ''}${bt.est_pct ? ' (about ' + Math.round(bt.est_pct * 100) / 100 + '% of the exam)' : ''}${bt.importance ? ', importance ' + bt.importance : ''}${bt.low_frequency ? '; the blueprint marks it low frequency' : ''}. Most examination questions are set in outpatient encounters; for conditions usually managed by other specialists, test recognition rather than management.
- Never invent a citation, trial, statistic, dose or threshold. Do not state a number you are unsure of as fact. Wherever the evidence is weak, societies disagree, guidance changed recently, or you are not certain your information is current, flag it: say so in plain words at that point in the text, and fill the flag field.
- Where societies disagree, say so and name both positions.`;
}
function lessonHead(rules, block, words, focus, extra) {
  return `${rules}${block}\n\nTASK: Write a ${extra && extra.kindName ? extra.kindName : 'foundational'} audio lesson of about ${words} words on this topic${focus ? `, concentrating on: "${focus}"` : ''}.${extra && extra.basis ? '\n' + extra.basis : ''}
It will be read aloud by a speech voice while the physician drives or rests after clinic, and shown as text for reading. Write it to be heard: the voice of a senior colleague teaching at the bedside, full sentences, no bullet lists, no tables, no symbols that read badly aloud (write "greater than or equal to", "milligrams per deciliter"), and spell out an abbreviation the first time.
Shape: open with a two or three sentence patient case that makes the topic matter; teach the concept and the reasoning; come back to the case and work through the decision; finish with what to do differently in clinic. Do not repeat a point in different words. Go deeper into the reasoning, the exceptions, and the evidence behind the recommendation.
Tables: whenever a segment teaches something graded or laid out in levels (a staging or severity classification with numeric cut-offs, a risk score, diagnostic criteria, dose steps, screening intervals by group, or a side-by-side comparison of options), give that segment a table with the levels as rows. The table is a visual aid shown on screen and is never read aloud, so the spoken text must still carry the same content in fluent sentences for a listener who is not looking. Put a value in a table only if you are sure of it; if a cut-off is uncertain or differs between guidelines, say so in the flag. Use null when a segment has nothing tabular. Set "figure" to null in every segment.`;
}
export const qspec = (W = wordingFor(defaultFamily())) => `Each question: a clinical vignette (age, setting, history, examination, relevant results with units), a clear lead-in, and five options A to E that are parallel and plausible, with exactly one best answer under current guidelines. Test the next step in management, the diagnosis, or the interpretation of a result, at the difficulty of ${W.certification}. Do not test trivia. Vary which letter is correct. The explanation says why the answer is right, naming the guideline, then gives one line on why each other option is wrong. Write original questions; never reuse one from a question bank.`;
const QSPEC = qspec();
const QJSON = `{"stem":"","options":["","","","",""],"answer":"A","explanation":"","objective":"one-sentence educational objective","caveat":"empty unless the keyed answer rests on guidance that is uncertain, disputed or recently changed; then one sentence saying so","sources":["Organization. Guideline or statement title. Year."]}`;
const CSPEC = `Each card tests one high-yield fact: a threshold, a first-line choice, a next step, a classic association, a screening interval, a contraindication, a coding rule or a technique step. "front" is a short prompt or question on one line. "back" is the answer in one to three short sentences with the reason or the guideline behind it. Write both to be read aloud: plain words, no symbols, abbreviations spelled out.`;
export const boardLevel = (W = wordingFor(defaultFamily())) => `Difficulty for this set: level 3 of 5, board level. The difficulty of ${W.typical_question}. Hold every question in the set to this level. Difficulty comes from clinical reasoning, never from ambiguity, trick wording or rare facts.`;
const BOARD_LEVEL = boardLevel();

/* A question as the app stores it in an asset (qOut in the page). */
function qFromAI(q) {
  if (!q || typeof q !== 'object' || !q.stem || !Array.isArray(q.options) || q.options.length < 4) return null;
  const ans = 'ABCDE'.indexOf(String(q.answer || '').trim().toUpperCase()[0]); if (ans < 0 || ans >= q.options.length) return null;
  return { stem: String(q.stem), opts: q.options.slice(0, 5).map((o) => String(o).replace(/^\s*[A-E][.)]\s+/, '')), ans, exp: String(q.explanation || ''), obj: String(q.objective || ''), cav: String(q.caveat || '').trim(), src: A(q.sources).map(String).slice(0, 4), ref: '', d: 3 };
}

/* ---------- Jobs ---------- */
const rowOut = (r, full) => {
  const st = J(r.state, {}) || {}, sp = J(r.spec, {}) || {}, res = J(r.result, null);
  const stale = r.runner === 'page' && r.status === 'writing' && Date.now() - r.lease > 120e3;
  return { id: r.id, batch: r.batch || '', kind: r.kind, title: r.title, status: stale ? 'paused' : r.status, runner: r.runner, model: r.model, note: r.note || '',
    tid: sp.tid || '', name: sp.name || '', len: sp.len || '', focus: sp.focus || '', objective: r.objective || null, les_id: sp.les_id || (res && res.les_id) || null,
    progress: progressOf(r, st, sp), not_before: r.not_before || 0, filed: !!r.filed, created: r.created, updated: r.updated, result: res, ...(full ? { spec_size: (r.spec || '').length } : {}) };
};
function progressOf(r, st, sp) {
  if (r.runner === 'page') return st.progress || null;
  const N = st.N || sp.N || 1, ph = st.ph || 'write';
  const label = ph === 'write' ? `writing part ${Math.min((st.k || 0) + 1, N)} of ${N}` : ph === 'review' ? 'accuracy review' : ph === 'qwrite' || ph === 'qreview' ? 'check questions' : ph === 'cwrite' || ph === 'creview' ? 'flashcards' : ph === 'store' ? 'saving' : ph;
  const steps = N + 4, at = ph === 'write' ? (st.k || 0) : ph === 'review' ? N : ph.startsWith('q') ? N + 1 : ph.startsWith('c') ? N + 2 : N + 3;
  return { label, pct: r.status === 'done' ? 100 : Math.round(100 * at / steps), parts: N, written: ph === 'write' ? (st.k || 0) : N };
}
async function save(env, id, patch) {
  const keys = Object.keys(patch); if (!keys.length) return;
  await env.DB.prepare(`UPDATE mk_gen SET ${keys.map((k) => k + ' = ?').join(', ')}, updated = ? WHERE id = ?`).bind(...keys.map((k) => typeof patch[k] === 'object' && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]), nowIso(), id).run();
  // ITE pipeline trace (ite.js): a job for a blueprint objective that ends moves the traces waiting on that objective.
  if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') await markJob(env, id, 'job_' + patch.status);
}

/* The services the server can write with (its own keys), and the one it uses for a job when none is chosen. */
export async function genModels(env, deps) { return deps.genModels ? deps.genModels() : { server: [], first: null }; }

/* gen_add {spec, model, runner?}: one lesson job. spec comes from the page (its prompts already carry the learner, the reference text and
   the MKOS block) and the model is the one chosen at queue time. A model the server cannot run (Claude without a server key) is a page job. */
export async function genAdd(env, deps, u, a) {
  await genInit(env);
  const sp = a.spec && typeof a.spec === 'object' ? a.spec : null; if (!sp || !sp.tid || !sp.len) return { error: 'spec with tid and len required' };
  const M = await genModels(env, deps), model = String(a.model || M.first || '').toLowerCase();
  const runner = a.runner === 'page' || !M.server.includes(model) ? 'page' : 'server';
  if (runner === 'server' && (!sp.head || !sp.rhead)) return { error: 'a server job needs its prompts (head, rhead)' };
  const raw = JSON.stringify(sp); if (raw.length > 900000) return { error: 'that lesson request is too large' };
  const id = uid(), now = nowIso();
  await env.DB.prepare('INSERT INTO mk_gen (id, user_id, batch, kind, title, status, runner, model, spec, state, created, updated, prio, objective) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, String(u.id), S(a.batch, 60) || null, 'lesson', S(sp.title || sp.name, 160), runner === 'page' ? 'writing' : 'queued', runner, model, raw, JSON.stringify({}), now, now, Number(a.prio) || 10, sp.objective ? S(sp.objective, 80) : null).run();
  if (runner === 'page') await save(env, id, { lease: Date.now() });
  if (sp.objective) { await markUser(env, u.id, 'queued'); await markObjectives(env, [S(sp.objective, 80)], 'queued'); }
  return { job: rowOut(await env.DB.prepare('SELECT * FROM mk_gen WHERE id = ?').bind(id).first()) };
}
/* gen_list {limit, batch}: this account's jobs, newest first (done ones for the last two weeks). */
export async function genList(env, u, a) {
  await genInit(env);
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const { results } = await env.DB.prepare(`SELECT * FROM mk_gen WHERE user_id = ? AND batch IS NOT 'seed' AND (status NOT IN ('done','cancelled') OR updated >= ?) ${a.batch ? 'AND batch = ?' : ''} ORDER BY created DESC LIMIT ?`)
    .bind(String(u.id), since, ...(a.batch ? [String(a.batch)] : []), Math.min(200, Number(a.limit) || 60)).all();
  return { jobs: results.map((r) => rowOut(r)) };
}
async function own(env, u, id) { await genInit(env); const r = await env.DB.prepare('SELECT * FROM mk_gen WHERE id = ?').bind(String(id || '')).first(); return r && r.user_id === String(u.id) ? r : null; }
export async function genGet(env, u, a) { const r = await own(env, u, a.id); return r ? { job: rowOut(r, true), state: a.state ? J(r.state, {}) : undefined } : { error: 'not found' }; }
/* gen_resume {id}: a paused or waiting job goes on (a page job is reclaimed by the page that asks). */
export async function genResume(env, u, a) {
  const r = await own(env, u, a.id); if (!r) return { error: 'not found' };
  if (['done', 'cancelled'].includes(r.status)) return { job: rowOut(r) };
  if (r.runner === 'page') await save(env, r.id, { status: 'writing', lease: Date.now(), note: '' });
  else await save(env, r.id, { status: 'queued', not_before: r.status === 'waiting' && r.not_before > Date.now() && !a.force ? r.not_before : 0, lease: 0, tries: 0, note: r.status === 'failed' ? '' : r.note });
  return { job: rowOut(await env.DB.prepare('SELECT * FROM mk_gen WHERE id = ?').bind(r.id).first()) };
}
export async function genCancel(env, u, a) { const r = await own(env, u, a.id); if (!r) return { error: 'not found' }; if (r.status !== 'done') await save(env, r.id, { status: 'cancelled', lease: 0 }); return { ok: true }; }
/* gen_page {id, status: writing|paused|done|failed, progress, les_id, note}: the page writing a Claude job checkpoints it here. */
export async function genPage(env, u, a) {
  const r = await own(env, u, a.id); if (!r || r.runner !== 'page') return { error: 'not found' };
  const st = J(r.state, {}) || {}; if (a.progress && typeof a.progress === 'object') st.progress = { label: S(a.progress.label, 80), pct: Number(a.progress.pct) || 0, parts: Number(a.progress.parts) || 1, written: Number(a.progress.written) || 0 };
  const sp = J(r.spec, {}) || {}; if (a.les_id) sp.les_id = S(a.les_id, 40);
  const status = ['writing', 'paused', 'done', 'failed'].includes(a.status) ? a.status : 'writing';
  await save(env, r.id, { status, state: st, spec: sp, lease: Date.now(), note: S(a.note, 300), ...(status === 'done' ? { filed: 1, result: { les_id: sp.les_id || null, asset_id: a.asset_id || null } } : {}) });
  return { ok: true };
}
/* gen_filed {ids}: the page filed these finished lessons in the account's record. */
export async function genFiled(env, u, a) {
  await genInit(env); const ids = A(a.ids).map(String).slice(0, 100); if (!ids.length) return { ok: true };
  await env.DB.prepare(`UPDATE mk_gen SET filed = 1, updated = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(nowIso(), String(u.id), ...ids).run();
  return { ok: true };
}

/* ---------- The server runner ---------- */
async function claim(env, deps, { user = null, budgetLeft = 1e9 } = {}) {
  const now = Date.now();
  // Seeds only while the owner keeps the reserve of the writing model's allowance for his own study (quality over speed).
  const seedOk = (await getSetting(env, 'seed_paused')) !== '1';
  const { results } = await env.DB.prepare(`SELECT * FROM mk_gen WHERE runner = 'server' AND status IN ('queued','running','waiting') AND not_before <= ? AND lease < ? ${user ? 'AND user_id = ?' : ''}
    ORDER BY (batch = 'seed'), prio DESC, created LIMIT 12`).bind(now, now, ...(user ? [String(user)] : [])).all();
  for (const r of results) {
    if (r.batch === 'seed') {
      if (!seedOk) continue;
      // The reserve for the owner's own study holds until the last `release_hours` before the daily reset; then whatever he has
      // not used goes to seeding rather than to waste.
      const release = nextUtcDay() - 6 * 60e3 - (QP().seed.release_hours ?? 2) * 3600e3, late = now >= release;
      const left = deps.aiLeft ? await deps.aiLeft(r.user_id, r.model) : 999, reserve = late ? 0 : QP().seed.reserve_calls;
      if (left <= reserve) { const until = late ? nextUtcDay() : release;
        await env.DB.prepare("UPDATE mk_gen SET status = 'waiting', not_before = ?, note = ? WHERE batch = 'seed' AND status IN ('queued','running','waiting') AND runner = 'server'")
          .bind(until, late ? 'Today\'s allowance is used up; seeding continues after the daily reset from the next objective.' : 'Seeding is holding the last ' + reserve + ' calls for your own study; anything you have not used is released to seeding two hours before the daily reset.').run(); continue; }
    }
    const got = await env.DB.prepare("UPDATE mk_gen SET lease = ?, status = 'running', updated = ? WHERE id = ? AND lease = ?").bind(now + Math.min(LEASE, budgetLeft + 30e3), nowIso(), r.id, r.lease).run();
    if (got.meta && got.meta.changes) return { ...r, status: 'running' };
  }
  return null;
}
/* Run server jobs until the time budget is used. user: only this account's jobs (a page pumping its own queue). */
export async function runGen(env, deps, { budgetMs = QP().server_steps_per_run_ms, user = null, maxSteps = 40 } = {}) {
  await genInit(env);
  if (!deps.genAI) return { steps: 0, note: 'no AI on the server' };
  const t0 = Date.now(); let steps = 0, done = 0;
  while (Date.now() - t0 < budgetMs - 20e3 && steps < maxSteps) {
    const job = await claim(env, deps, { user, budgetLeft: budgetMs - (Date.now() - t0) }); if (!job) break;
    try { const r = await step(env, deps, job); steps++; if (r === 'done') done++; }
    catch (e) { console.error('gen step', job.id, e); await save(env, job.id, { lease: 0, tries: job.tries + 1, note: S('Error: ' + (e && e.message || e), 300), status: job.tries + 1 >= 6 ? 'failed' : 'queued', not_before: Date.now() + 120e3 }); }
  }
  return { steps, done, ms: Date.now() - t0 };
}

/* `gov` is the USAP AI governance action of the call (a label only; it never changes which service answers). */
async function ask(deps, job, input, aiJob, { strict = true, avoid = '', gov = '' } = {}) {
  const r = await deps.genAI(job.user_id, { input, job: aiJob, provider: job.model, strict, avoid, gov });
  if (r.status === 200) return { ok: true, text: r.text, provider: r.provider, model: r.model };
  return { ok: false, cap: r.status === 429, error: r.error || 'no answer' };
}
/* One step: one AI call (or the final store). Progress is saved after every step, so nothing is lost when a run ends. */
async function step(env, deps, job) {
  const sp = J(job.spec, {}) || {}; let st = J(job.state, {}) || {};
  // The prompt wording follows the job's blueprint family, else the learner's selected family, else the default (wording.js).
  const W = wordingFor(sp.family || await learnerFamily(env, job.user_id).catch(() => null) || defaultFamily());
  if (sp.seed && !sp.head) { Object.assign(sp, await seedSpec(env, deps, job, sp)); await save(env, job.id, { spec: sp }); }
  if (!st.ph) {
    const words = Number(sp.words) || 1300, N = words <= 1900 ? 1 : Math.ceil(words / LPART);
    st = { ph: 'write', k: 0, N, per: Math.round(words / N / 50) * 50, words, outline: [], segs: [], title: '', pts: [], pit: [], src: [], unc: [], rv: { done: false, fixed: 0, flagged: 0, dropped: 0 }, g: 0, checks: [], cards: [], by: { w: '', r: '', mv: '' }, fails: 0, started: nowIso() };
  }
  const put = async (patch = {}) => save(env, job.id, { state: st, lease: 0, tries: 0, ...patch });
  const miss = async (r, ph) => {
    if (r.cap) { await save(env, job.id, { state: st, lease: 0, status: 'waiting', not_before: nextUtcDay(), note: `${job.model} has used today's allowance; this lesson continues tomorrow from ${ph}.` }); return 'wait'; }
    st.fails = (st.fails || 0) + 1; await save(env, job.id, { state: st, lease: 0, status: 'queued', not_before: Date.now() + Math.min(30, 2 ** st.fails) * 60e3, note: S('The AI did not answer (' + r.error + '); trying again shortly.', 300) });
    return 'retry';
  };
  const tooMany = () => (st.fails || 0) >= QP().max_tries_per_step;

  if (st.ph === 'write') {
    const k = st.k, N = st.N;
    const r = await ask(deps, job, sp.head + partTask(k, N, st.per, st.words, st.outline, st.segs), sp.ljob || 'lesson', { gov: 'gen_lesson_write' });
    const x = r.ok ? parseJ(r.text) : null, got = A(x && x.segments).filter((y) => y && typeof y === 'object' && y.text);
    if (!got.length) {
      if (!r.ok && r.cap) return miss(r, `part ${k + 1}`);
      if (!tooMany()) return miss(r.ok ? { error: 'the reply was not usable' } : r, `part ${k + 1}`);
      if (k === 0) { await save(env, job.id, { state: st, lease: 0, status: 'failed', note: 'The lesson could not be started: the AI did not return a usable first part. Resume to try again.' }); return 'failed'; }
      st.short = `This lesson stopped early: part ${k + 1} of ${N} could not be written, so it covers less than planned.`; st.ph = 'review'; st.fails = 0; return put({ note: '' });
    }
    st.fails = 0; st.by.w = r.provider; st.by.mv = r.model || st.by.mv;
    if (k === 0) { st.title = String(x.title || sp.name || ''); st.outline = A(x.outline).map(String).filter(Boolean).slice(0, 30); }
    if (k === N - 1 || N === 1) { st.pts = A(x.keyPoints).map(String); st.pit = A(x.pitfalls).map(String); st.src = A(x.sources).map(String); st.unc = A(x.uncertain).map(String); }
    st.segs.push(...got.map((y) => ({ heading: String(y.heading || ''), text: String(y.text || ''), flag: String(y.flag || ''), table: y.table && typeof y.table === 'object' ? y.table : null, figure: Number.isInteger(y.figure) ? y.figure : null })));
    st.k = k + 1; if (st.k >= N) st.ph = 'review';
    return put({ note: '' });
  }
  if (st.ph === 'review') {
    if (st.g === 0 && !st.groups) {
      const figs = A(sp.figs), used = new Set();
      st.segs.forEach((sg) => { const i = sg.figure, f = figs[i]; sg.fig = f && !used.has(i) && figFits(f, sg) ? (used.add(i), f) : null; });
      st.groups = reviewGroups(st.segs);
      const lead = deps.isLead ? await deps.isLead(st.by.w) : true;
      st.doReview = !!sp.audit || !lead || !!sp.seed;
      if (!st.doReview) { st.ph = 'qwrite'; return put(); }
    }
    const g = st.g, r = await ask(deps, job, reviewPrompt(sp, { ...st, title: st.title }, g), 'review', { strict: false, avoid: st.by.w, gov: 'gen_lesson_review' });
    const a = r.ok ? parseJ(r.text) : null;
    if (!a) { if (!r.ok && r.cap) return miss(r, 'the accuracy review'); if (!tooMany()) { st.fails = (st.fails || 0) + 1; return put({ status: 'queued', not_before: Date.now() + 60e3 }); } }
    else {
      st.fails = 0; st.by.r = r.provider; st.rv.ok = (st.rv.ok || 0) + 1;
      A(a.segments).forEach((x) => { const sg = x && st.groups[g].includes(x.i) && st.segs[x.i]; if (!sg) return; const note = String(x.note || '').trim(); sg.figOk = x.figureOk === true;
        if (x.verdict === 'fix' && typeof x.text === 'string' && x.text.trim().length > 40) { sg.text = x.text; if (x.table && typeof x.table === 'object') sg.table = x.table; sg.fixed = clip(note, 700); st.rv.fixed++; }
        else if (x.verdict === 'flag' && note) { sg.flag = clip([String(sg.flag || '').trim(), note].filter(Boolean).join(' '), 1500); st.rv.flagged++; } });
      if (g === st.groups.length - 1) { if (Array.isArray(a.keyPoints) && a.keyPoints.length) { st.pts = a.keyPoints.map(String); st.rv.fixed++; } if (Array.isArray(a.pitfalls) && a.pitfalls.length) st.pit = a.pitfalls.map(String); }
    }
    st.g = g + 1; st.fails = 0;
    if (st.g >= st.groups.length) { st.rv.done = (st.rv.ok || 0) === st.groups.length; st.rv.parts = st.groups.length; st.segs.forEach((sg) => { if (sg.fig && !(st.rv.done && sg.figOk === true)) sg.fig = null; }); st.rv.figs = st.segs.filter((sg) => sg.fig).length; st.ph = 'qwrite'; st.fails = 0; }
    return put();
  }
  const L = () => ({ title: st.title || sp.name, segs: st.segs.map((x) => ({ h: x.heading })), pts: st.pts });
  if (st.ph === 'qwrite') {
    const n = sp.checks == null ? 2 : Number(sp.checks); if (!n) { st.ph = 'cwrite'; return put(); }
    const basis = `These questions follow a lesson the physician has studied: ${lessonGist(L())}\nTest whether what that lesson taught can be applied to new patients. Every question must rest on something the lesson covered, in a case the lesson did not use.`;
    const r = await ask(deps, job, `${sp.qhead || sp.rhead}\n\nTASK: Write ${n} board-style questions on this topic. ${qspec(W)}\n${basis}\n${sp.qlevel || boardLevel(W)}\n\nReply with JSON only: {"questions":[${QJSON}]}`, 'questions', { gov: 'gen_questions_write' });
    const x = r.ok ? parseJ(r.text) : null; if (!x && r.cap) return miss(r, 'the check questions');
    st.checks = A(x && x.questions).map(qFromAI).filter(Boolean).slice(0, n); st.ph = st.checks.length && (sp.audit || sp.seed) ? 'qreview' : 'cwrite'; return put();
  }
  if (st.ph === 'qreview') {
    const qs = st.checks, r = await ask(deps, job, `${sp.rhead}\n\nYou are now the item reviewer for a board examination committee. Check each question below against current guidelines${sp.hasRef ? ' and the reference text' : ''}. Reject a question if the keyed answer is not clearly the single best answer, if any stated fact, dose or threshold is wrong or outdated, or if two options are equally defensible. Be strict: when in doubt, reject.\n\nQUESTIONS:\n${JSON.stringify(qs.map((q, i) => ({ i, stem: q.stem, options: q.opts, keyed: 'ABCDE'[q.ans], explanation: q.exp })))}\n\nReply with JSON only: {"reviews":[{"i":0,"verdict":"ok" or "reject","note":"reason if rejected"}]}`, 'review', { strict: false, avoid: st.by.w, gov: 'gen_questions_review' });
    const x = r.ok ? parseJ(r.text) : null; if (!x && r.cap) return miss(r, 'the question review');
    if (x) { const bad = new Set(A(x.reviews).filter((v) => v.verdict === 'reject').map((v) => v.i)); st.checks = qs.filter((q, i) => !bad.has(i)).map((q) => ({ ...q, rev: 1 })); } else st.checks = [];
    st.ph = 'cwrite'; return put();
  }
  if (st.ph === 'cwrite') {
    const n = sp.cards == null ? 4 : Number(sp.cards); if (!n) { st.ph = 'store'; return put(); }
    const basis = `These cards follow a lesson the physician has just studied: ${lessonGist(L())}\nTake every card from what that lesson taught, on its highest-yield facts, and keep each one consistent with it.`;
    const r = await ask(deps, job, `${sp.qhead || sp.rhead}\n\nTASK: Write ${n} flashcards on this topic. ${CSPEC}\n${basis}\n Cover different facts across the topic, favoring what is tested on ${W.board_exam} and what changes management in clinic.\n\nReply with JSON only: {"cards":[{"front":"","back":"","source":"Organization and year, if a guideline backs it","caveat":"empty unless the answer is uncertain, disputed or recently changed; then one sentence"}]}`, 'cards', { gov: 'gen_cards_write' });
    const x = r.ok ? parseJ(r.text) : null; if (!x && r.cap) return miss(r, 'the flashcards');
    st.cards = A(x && x.cards).filter((c) => c && c.front && c.back).slice(0, n).map((c) => ({ f: String(c.front), b: String(c.back), src: String(c.source || ''), cav: String(c.caveat || '').trim(), ref: '', fig: null }));
    st.ph = st.cards.length ? 'creview' : 'store'; return put();
  }
  if (st.ph === 'creview') {
    const r = await ask(deps, job, `${sp.rhead}\n\nYou are checking flashcards for accuracy against current guidelines${sp.hasRef ? ' and the reference text' : ''}. Reject any card whose answer is wrong, outdated, or only sometimes true. Be strict.\n\nCARDS:\n${JSON.stringify(st.cards.map((c, i) => ({ i, front: c.f, back: c.b })))}\n\nReply with JSON only: {"reviews":[{"i":0,"verdict":"ok" or "reject"}]}`, 'review', { strict: false, avoid: st.by.w, gov: 'gen_cards_review' });
    const x = r.ok ? parseJ(r.text) : null; if (!x && r.cap) return miss(r, 'the card review');
    if (x) { const bad = new Set(A(x.reviews).filter((v) => v.verdict === 'reject').map((v) => v.i)); st.cards = st.cards.filter((c, i) => !bad.has(i)); st.cardsChecked = true; } else st.cards = [];
    st.ph = 'store'; return put();
  }
  if (st.ph === 'store') return store(env, deps, job, sp, st);
  return put();
}

/* The finished lesson: the account's copy (for the app to file), then the MKOS asset with its metadata and confidence tier. */
async function store(env, deps, job, sp, st) {
  const lesId = sp.les_id || ('s' + job.id.slice(1));
  const gen = { model: st.by.w || job.model, model_version: st.by.mv || null, prompt_version: GM().prompt_version, template_version: GM().template_version, generated_at: nowIso(),
    objective_id: sp.objective || null, blueprint_id: sp.blueprint_id || null, blueprint_source: sp.blueprint_source || null, status: st.short ? 'partial' : 'complete', runner: 'server', job_id: job.id,
    pass: sp.pass || (sp.seed ? QP().seed.pass : null), reviewed_by: st.rv.done ? st.by.r : null };
  const les = { id: lesId, tid: sp.tid, len: sp.len, min: Number(sp.min) || Math.round((Number(sp.words) || 1300) / 135), rev: st.rv, parent: sp.from || '', deeper: sp.from ? 1 : 0, focus: sp.focus || '',
    title: String(st.title || sp.name || ''), segs: st.segs.map((s) => ({ h: String(s.heading || ''), x: String(s.text || ''), f: String(s.flag || '').trim(), fx: String(s.fixed || ''), tb: cleanTable(s.table), fig: s.fig ? figRef(s.fig) : null })),
    pts: st.pts, pit: st.pit, src: st.src, unc: st.unc.filter((x) => x && !/^(none|n\/a|nothing|empty)\b/i.test(String(x).trim())), qids: [], ref: sp.ref || '', t: Date.now(), by: { w: st.by.w || '', r: st.rv.done ? st.by.r : '' },
    gen, job: job.id, srv: 1, checks: st.checks, cards: st.cards, ...(sp.objective ? { objective: sp.objective } : {}) };
  if (st.short) les.unc.unshift(st.short);
  if (!sp.seed && deps.putDoc) await deps.putDoc(job.user_id, 'med/les_' + lesId, les);
  let stored = null;
  if (!st.short) {
    const user = { id: job.user_id, email: '' };
    const content = { title: les.title, len: les.len, min: les.min, rev: les.rev, segs: les.segs, pts: les.pts, pit: les.pit, src: les.src, unc: les.unc, ref: les.ref, by: les.by, gen, checks: les.checks, cards: les.cards, ...(sp.objective ? { objective: sp.objective } : {}) };
    try {
      const r = await putAssets(env, user, { kind: 'lesson', tid: sp.tid, name: sp.name || '', len: sp.len, personal: !sp.share, local_id: lesId, validated: !!st.rv.done, generated_by: st.by.w || job.model, reviewed_by: st.rv.done ? st.by.r : '',
        sources: les.src, title: les.title, content, objective: sp.objective || null, blueprint_id: sp.blueprint_id || null, generation: gen, review: { fixed: st.rv.fixed, flagged: st.rv.flagged } });
      stored = (r.stored || [])[0] || null;
    } catch (e) { console.error('gen store asset', e); }
  }
  const result = { les_id: lesId, asset_id: stored && stored.id || null, tier: stored && stored.tier || null, confidence: stored && stored.confidence || null, review_status: stored && stored.review_status || null, short: !!st.short };
  await save(env, job.id, { state: { ...st, ph: 'done' }, result, status: 'done', lease: 0, note: st.short ? st.short : '', filed: sp.seed ? 1 : 0 });
  if (sp.seed) await audit(env, 'mkos-seed', 'seed_lesson', result.asset_id, null, null, { objective: sp.objective, tier: result.tier, confidence: result.confidence }).catch(() => { });
  return 'done';
}

/* ---------- Batches ---------- */
/* gen_batch {items:[{spec}], model, label}: many lessons at once, each its own job, all under one batch id. */
export async function genBatch(env, deps, u, a) {
  const items = A(a.items).slice(0, 60); if (!items.length) return { error: 'items required' };
  const batch = 'b' + Date.now().toString(36), out = [];
  for (let i = 0; i < items.length; i++) { const r = await genAdd(env, deps, u, { spec: items[i].spec || items[i], model: a.model, runner: a.runner, batch, prio: 9 - i / 100 }); out.push(r.job ? r.job : { error: r.error }); }
  return { batch, label: S(a.label, 120), jobs: out };
}

/* ---------- Objective seeding (owner) ---------- */
async function seedSpec(env, deps, job, sp) {
  const bt = await getObject(env, sp.objective) || {};
  const owner = { id: job.user_id, email: '' };
  const ctx = await topicContext(env, owner, sp.tid, { name: sp.name }).catch(() => null);
  const block = ctx && ctx.prompt_block_shared != null ? '\n\n' + ctx.prompt_block_shared : ctx && ctx.prompt_block ? '\n\n' + ctx.prompt_block : '';
  const family = await familyOfBlueprint(env, bt.blueprint).catch(() => null) || defaultFamily();
  const rules = seedRules(bt, sp.name, (ctx && ctx.guidelines || []).map((g) => g.current).filter(Boolean).slice(0, 3).join('; '), wordingFor(family));
  // The objective's content layers (layers.js) as a layered outline: structure only; nothing is added when no plan exists yet.
  const outline = layeredOutline(await layerPlan(env, { objectives: (await env.DB.prepare("SELECT dst FROM mk_edges WHERE src = ? AND rel = 'projects_objective' AND status = 'current'").bind(sp.objective || '').all()).results.map((r) => r.dst) }).catch(() => null));
  const words = Number(sp.words) || QP().seed.length_words;
  return { family, head: lessonHead(rules, block + outline, words, '', { kindName: 'foundational (first-pass, coverage)', basis: `This is the foundational first-pass lesson for the blueprint objective "${sp.name}". Teach the objective completely enough to stand on its own: the diagnosis and the management decisions the examination tests, with the reasoning. Leave advanced edge cases, rare variants and subspecialty depth for later enrichment passes; do not pad.` }),
    rhead: rules + block, qhead: rules + block, words, hasRef: false, audit: true, share: true, ljob: 'lesson', blueprint_source: bt.provenance && bt.provenance[0] ? S(bt.provenance[0].note, 200) : null };
}
/* seed_start {limit, words, model}: queue a pass-1 lesson for every current blueprint objective that has none (CERT, plus LKA-only
   objectives), highest blueprint priority first. Re-running it adds only what is missing; it never duplicates a queued objective. */
export async function seedStart(env, deps, u, a) {
  await genInit(env);
  const M = await genModels(env, deps), model = String(a.model || M.first || '').toLowerCase();
  if (!M.server.includes(model)) return { error: 'No writing model the server can run is set up (seeding runs on the server). ' + (M.server.length ? 'Choose one of: ' + M.server.join(', ') : '') };
  const words = Math.max(800, Math.min(4500, Number(a.words) || QP().seed.length_words));
  const { results } = await env.DB.prepare(`SELECT o.id, o.body, (SELECT json_extract(n.body, '$.legacy_topic_id') FROM mk_objects n, json_each(n.body, '$.blueprint_topics') b WHERE n.type = 'CurriculumNode' AND b.value = o.id LIMIT 1) AS tid
    FROM mk_objects o WHERE o.type = 'BlueprintTopic' AND o.status = 'current' AND (o.id LIKE 'bpt.cert.%' OR (o.id LIKE 'bpt.lka.%' AND json_extract(o.body, '$.code') NOT IN (SELECT json_extract(c.body, '$.data.lka_ref') FROM mk_objects c WHERE c.type = 'BlueprintTopic' AND c.id LIKE 'bpt.cert.%' AND json_extract(c.body, '$.data.lka_ref') IS NOT NULL)))`).all();
  const have = new Set((await env.DB.prepare("SELECT objective FROM mk_gen WHERE batch = 'seed' AND status NOT IN ('cancelled','failed')").all()).results.map((r) => r.objective));
  for (const r of (await env.DB.prepare("SELECT json_extract(body, '$.objective') AS o FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') IS NOT NULL AND id LIKE 'ea.s.%'").all()).results) have.add(r.o);
  const todo = results.map((r) => ({ id: r.id, b: J(r.body, {}), tid: r.tid })).filter((x) => x.tid && !have.has(x.id))
    .sort((x, y) => (Number(y.b.priority_score) || Number(y.b.est_pct) * 50 || 0) - (Number(x.b.priority_score) || Number(x.b.est_pct) * 50 || 0));
  const lim = Math.min(todo.length, Number(a.limit) || todo.length), now = nowIso();
  const bp = await env.DB.prepare('SELECT objective_id, priority_score FROM mk_blueprint_objectives').all().catch(() => ({ results: [] }));
  const pri = Object.fromEntries(bp.results.map((r) => [r.objective_id, r.priority_score]));
  const stmts = todo.slice(0, lim).map((x, i) => {
    const spec = seedSpecOf(x, words);
    return env.DB.prepare("INSERT INTO mk_gen (id, user_id, batch, kind, title, status, runner, model, spec, state, created, updated, prio, objective) VALUES (?, ?, 'seed', 'lesson', ?, 'queued', 'server', ?, ?, '{}', ?, ?, ?, ?)")
      .bind('s' + Date.now().toString(36) + i.toString(36).padStart(3, '0'), String(u.id), S(spec.name, 160), model, JSON.stringify(spec), now, now, Number(pri[x.id] ?? 0) / 100 + (lim - i) / 1e6, x.id);
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await setSetting(env, 'seed_paused', null);
  return { queued: stmts.length, already: have.size, unmapped: results.filter((r) => !r.tid).length, total_objectives: results.length, model, words };
}
/* The pass-1 seed job for one blueprint objective (x: {id, b: BlueprintTopic body, tid}); shared by seed_start and the ITE pipeline. */
function seedSpecOf(x, words) {
  const name = String(x.b.name || x.id);
  return { seed: 1, tid: x.tid, name: x.b.subcategory && !name.toLowerCase().includes(String(x.b.subcategory).toLowerCase()) && /^general\b|^other\b/i.test(name) ? `${x.b.subcategory}: ${name}` : name,
    len: 'std', words, min: Math.round(words / 135), objective: x.id, blueprint_id: x.b.blueprint || null, pass: QP().seed.pass, checks: 2, cards: 4 };
}
/* ITE pipeline (ite.js, spec stage 6): an eligible objective with no lesson and no job gets its pass-1 lesson through the same seed queue
   (shared, central, paced by seed.reserve_calls and seed_paused, on the server's own writing model; the AI order is untouched).
   items: [{objective, tid}] (tid: the app topic to file it under when the objective has no curriculum node). Never duplicates a seed job
   that is queued, running, waiting or done. Returns {results: {objective: {job} | {existing} | {error}}} or {error} for the whole call. */
export async function queueObjectiveSeeds(env, deps, items, { prioBase = 2 } = {}) {
  await genInit(env);
  const M = await genModels(env, deps), model = M.first && M.server.includes(M.first) ? M.first : null;
  if (!model) return { error: 'no_writer' };
  const owner = deps && deps.ownerId ? await deps.ownerId() : null; if (!owner) return { error: 'no_owner' };
  const words = QP().seed.length_words, now = nowIso(), results = {}, stmts = [];
  let i = 0;
  for (const it of A(items).slice(0, 60)) {
    const id = String(it && it.objective || ''); if (!id || results[id]) continue;
    const dup = await env.DB.prepare("SELECT id, status FROM mk_gen WHERE objective = ? AND batch = 'seed' AND status NOT IN ('cancelled','failed') LIMIT 1").bind(id).first();
    if (dup) { results[id] = { existing: dup.id, status: dup.status }; continue; }
    const o = await env.DB.prepare("SELECT body FROM mk_objects WHERE id = ? AND type = 'BlueprintTopic' AND status = 'current'").bind(id).first();
    if (!o) { results[id] = { error: 'objective_missing' }; continue; }
    const node = await env.DB.prepare("SELECT json_extract(n.body, '$.legacy_topic_id') AS tid FROM mk_objects n, json_each(n.body, '$.blueprint_topics') b WHERE n.type = 'CurriculumNode' AND b.value = ? LIMIT 1").bind(id).first().catch(() => null);
    const tid = (node && node.tid) || (it.tid ? S(it.tid, 120) : '');
    if (!tid) { results[id] = { error: 'no_topic' }; continue; }
    const pri = await env.DB.prepare('SELECT priority_score FROM mk_blueprint_objectives WHERE objective_id = ?').bind(id).first().catch(() => null);
    const spec = seedSpecOf({ id, b: J(o.body, {}), tid }, words), jid = 'w' + Date.now().toString(36) + (i++).toString(36).padStart(3, '0');
    stmts.push(env.DB.prepare("INSERT INTO mk_gen (id, user_id, batch, kind, title, status, runner, model, spec, state, created, updated, prio, objective) VALUES (?, ?, 'seed', 'lesson', ?, 'queued', 'server', ?, ?, '{}', ?, ?, ?, ?)")
      .bind(jid, String(owner), S(spec.name, 160), model, JSON.stringify(spec), now, now, Number(prioBase) + Number((pri && pri.priority_score) ?? 0) / 100, id));
    results[id] = { job: jid, status: 'queued' };
  }
  for (let k = 0; k < stmts.length; k += 50) await env.DB.batch(stmts.slice(k, k + 50));
  if (stmts.length) await audit(env, 'mkos-ite', 'ite_queue', null, null, null, { queued: stmts.length, model }).catch(() => { });
  return { results, model };
}
/* seed_status: how far seeding has come, by status and by confidence tier, with the coverage of all objectives. */
export async function seedStatus(env) {
  await genInit(env);
  const by = (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM mk_gen WHERE batch = 'seed' GROUP BY status").all()).results;
  const tiers = (await env.DB.prepare("SELECT json_extract(body, '$.confidence_tier') AS tier, COUNT(*) AS n FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') IS NOT NULL AND id LIKE 'ea.s.%' GROUP BY tier").all()).results;
  const total = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'BlueprintTopic' AND status = 'current' AND id LIKE 'bpt.cert.%'").first()) || {}).n || 0;
  const covered = ((await env.DB.prepare("SELECT COUNT(DISTINCT json_extract(body, '$.objective')) AS n FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') IS NOT NULL AND id LIKE 'ea.s.%'").first()) || {}).n || 0;
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_gen WHERE batch = 'seed' AND status = 'done' AND updated >= ?").bind(today).first()) || {}).n || 0;
  const next = (await env.DB.prepare("SELECT title, status, note, not_before FROM mk_gen WHERE batch = 'seed' AND status IN ('running','queued','waiting') ORDER BY (status = 'running') DESC, prio DESC LIMIT 5").all()).results;
  const failed = (await env.DB.prepare("SELECT id, title, note FROM mk_gen WHERE batch = 'seed' AND status = 'failed' ORDER BY updated DESC LIMIT 20").all()).results;
  return { by_status: Object.fromEntries(by.map((r) => [r.status, r.n])), tiers: Object.fromEntries(tiers.map((r) => [r.tier || 'unscored', r.n])), objectives: total, covered, coverage_pct: total ? Math.round(1000 * covered / total) / 10 : 0,
    done_today: doneToday, paused: (await getSetting(env, 'seed_paused')) === '1', reserve_calls: QP().seed.reserve_calls, release_hours: QP().seed.release_hours ?? 2, words: QP().seed.length_words, next, failed };
}
export async function seedPause(env, u, a) { await setSetting(env, 'seed_paused', a.on === false ? null : '1'); if (a.on === false) await env.DB.prepare("UPDATE mk_gen SET status = 'queued', not_before = 0, note = '' WHERE batch = 'seed' AND status = 'waiting'").run(); return { ok: true, paused: a.on !== false }; }
/* seed_retry: failed seed objectives go back in the queue. */
export async function seedRetry(env) { await genInit(env); const r = await env.DB.prepare("UPDATE mk_gen SET status = 'queued', tries = 0, not_before = 0, lease = 0, state = '{}', note = '' WHERE batch = 'seed' AND status = 'failed'").run(); return { requeued: r.meta ? r.meta.changes : 0 }; }

/* ---------- ITE mapping: missed objectives -> ABIM blueprint objectives (no AI) ---------- */
export const gramsOf = (s) => { const t = ' ' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ', g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
export const sim = (A1, B1) => { let n = 0; for (const g of A1) if (B1.has(g)) n++; return A1.size + B1.size ? (2 * n) / (A1.size + B1.size) : 0; };
/* ite_map {missed:[text], family}: each missed educational objective is matched to the blueprint objective it belongs to (best trigram
   match of its words against the objective, its subcategory and category), with that objective's domain, priority and app topic. */
export async function iteMap(env, u, a) {
  const missed = A(a.missed).map((x) => String(typeof x === 'string' ? x : x && x.text || '')).filter(Boolean).slice(0, 150); if (!missed.length && !A(a.items).length) return { map: [] };
  // The blueprint topics of the exam the family names, from the blueprint data (cert, lka, or any exam_key a family declares).
  const fam = 'bpt.' + (a.family === 'lka' ? 'lka' : String(examFamily(String(a.family || 'cert')).exam_key || 'cert')) + '.%';
  const { results } = await env.DB.prepare(`SELECT o.id, json_extract(o.body, '$.name') AS name, json_extract(o.body, '$.category') AS cat, json_extract(o.body, '$.subcategory') AS sub, json_extract(o.body, '$.domain') AS dom,
    json_extract(o.body, '$.est_pct') AS pct, (SELECT json_extract(n.body, '$.legacy_topic_id') FROM mk_objects n, json_each(n.body, '$.blueprint_topics') b WHERE n.type = 'CurriculumNode' AND b.value = o.id LIMIT 1) AS tid
    FROM mk_objects o WHERE o.type = 'BlueprintTopic' AND o.status = 'current' AND o.id LIKE ?`).bind(fam).all();
  const pri = Object.fromEntries((await env.DB.prepare('SELECT objective_id, priority_score FROM mk_blueprint_objectives').all().catch(() => ({ results: [] }))).results.map((r) => [r.objective_id, r.priority_score]));
  const pool = results.map((r) => ({ ...r, g: gramsOf(r.name), gs: gramsOf((r.sub || '') + ' ' + r.name) }));
  const map = missed.map((text) => {
    const g = gramsOf(text); let best = null;
    for (const p of pool) { const s = Math.max(sim(g, p.g), sim(g, p.gs) * 0.95); if (!best || s > best.s) best = { p, s }; }
    if (!best || best.s < 0.3) return { text, objective: null, confidence: best ? Math.round(best.s * 100) : 0 };
    const p = best.p; return { text, objective: p.id, name: p.name, category: p.cat, subcategory: p.sub, domain: p.dom, tid: p.tid, est_pct: p.pct, priority: pri[p.id] ?? null, confidence: Math.round(best.s * 100) };
  });
  if (!A(a.items).length) return { map };
  return iteShortlist(a, pool, pri);
}

/* ite_map {items:[{text, area}], family}: the shortlist half of ITE mapping (the AI half runs in the app, through the app's own
   "report" job, so the AI order of operations is untouched). An in-training exam lists missed items by content area, so each item is
   narrowed deterministically to the blueprint discipline that content area belongs to: the whole discipline (37 to 105 objectives)
   is offered, plus the closest few objectives from other disciplines by wording, because a content area such as "Pulmonary and
   Critical Care" or "General Internal Medicine" spans several blueprint disciplines. A content area that names no discipline gets the
   closest objectives across the whole blueprint. Returns the pools once, each item's pool key and extra candidates, its closest
   objective by wording, and the details of every objective offered. */
const ITE_AREAS = [
  [/cardio|heart/i, 'Cardiovascular Disease'], [/endocr|diabet|metabol/i, 'Endocrinology, Diabetes, and Metabolism'], [/gastro|hepat|liver/i, 'Gastroenterology'],
  [/hemat/i, 'Hematology'], [/oncol|cancer/i, 'Medical Oncology'], [/infect/i, 'Infectious Disease'], [/nephro|kidney|renal|urolog/i, 'Nephrology and Urology'],
  [/neurol/i, 'Neurology'], [/pulm|respir|critical/i, 'Pulmonary Disease'], [/rheum|musculo|orthop/i, 'Rheumatology and Orthopedics'], [/dermat|skin/i, 'Dermatology'],
  [/allerg|immunol/i, 'Allergy and Immunology'], [/geriat/i, 'Geriatric Syndromes'], [/psych/i, 'Psychiatry'], [/obstet|gynec|women/i, 'Obstetrics and Gynecology'],
  [/ophthal|eye/i, 'Ophthalmology'], [/otolar|\bent\b|dental/i, 'Otolaryngology and Dental Medicine']];
const ITE_STOP = new Set('a an the of in on with and or for to by from at as is are be patient patients adult adults man woman men women person older younger year old who has have having presenting presents select identify recognize diagnose diagnosis evaluate evaluation manage management treat treatment treating appropriate best next step most likely initial use using indications indication'.split(' '));
const iteWords = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1 && !ITE_STOP.has(w));
function iteShortlist(a, pool, pri) {
  const items = A(a.items).slice(0, 150).map((x) => ({ text: String(x && x.text || '').slice(0, 300), area: String(x && x.area || '').slice(0, 120) })).filter((x) => x.text);
  const cats = (area) => [...new Set(ITE_AREAS.filter(([re]) => re.test(area)).map(([, c]) => c))];
  const P = pool.map((p) => ({ ...p, w: new Set(iteWords((p.sub || '') + ' ' + p.name)) }));
  const score = (g, ws, p) => { let n = 0; for (const w of ws) if (p.w.has(w)) n++; return Math.max(sim(g, p.g), sim(g, p.gs) * 0.95) + (ws.length ? 0.25 * n / ws.length : 0); };
  // Shortlist sizes: the ITE pipeline (ite.js) passes its framework numbers in a._sl; other callers keep the original sizes.
  const SL = { near: 8, extra: 4, extraNo: 12, ...(a._sl || {}) };
  const pools = {}, used = new Set(A(a._also)), out = [];
  for (const it of items) {
    const cs = cats(it.area), key = cs.length ? cs.slice().sort().join('|') : '';
    if (key && !pools[key]) { pools[key] = P.filter((p) => cs.includes(p.cat)).map((p) => p.id); pools[key].forEach((id) => used.add(id)); }
    const ws = iteWords(it.text), g = gramsOf(ws.join(' ') || it.text), inPool = key ? new Set(pools[key]) : null;
    const ranked = P.map((p) => ({ p, s: score(g, ws, p) })).sort((x, y) => y.s - x.s);
    const extra = ranked.filter((r) => !inPool || !inPool.has(r.p.id)).slice(0, key ? SL.extra : SL.extraNo).map((r) => r.p.id);
    const nearR = (inPool ? ranked.filter((r) => inPool.has(r.p.id)) : ranked).slice(0, SL.near), near = nearR.map((r) => r.p.id), top = nearR[0] || ranked[0];
    extra.forEach((id) => used.add(id)); near.forEach((id) => used.add(id));
    out.push({ text: it.text, area: it.area, pool: key, extra, near, best: top ? { objective: top.p.id, score: Math.round(100 * Math.min(1, top.s)) } : null });
  }
  const objectives = {};
  for (const p of P) if (used.has(p.id)) objectives[p.id] = { name: p.name, category: p.cat, subcategory: p.sub, domain: p.dom, tid: p.tid, est_pct: p.pct, priority: pri[p.id] ?? null };
  return { pools, items: out, objectives };
}
