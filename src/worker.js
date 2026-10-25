// Doctor Career Companion server: accounts and each physician's study record.
// The app runs inside Claude and reaches this server through the connector at /mcp/<token>; the website at / uses /api/*.
// Every document path starts with an area prefix (med/ holds the whole study and career record).
//
// Where things live:
//   Cloudflare D1   logins (password hashes, sessions, connector links) and the working copy of every record. Logins never leave D1.
//   Google Drive    two folders, named by DRIVE_KNOWLEDGE_FOLDER and DRIVE_ACCOUNTS_FOLDER. The knowledge folder is read by every
//                   account the library is turned on for. The accounts folder holds one subfolder per account: every record as its
//                   own file, a profile file and dated backups.
// The rule that keeps accounts apart: nothing a browser, the connector or an AI model sends ever names an account or an account
// folder. The account comes from the login session (or the connector link) and the folder comes from that account's row in D1.
// The AI models hold no Google credential at all; when one asks for a record, this server answers from the caller's rows only.
import { mkosApi, mkosCall, MKOS_TOOLS } from './mkos/routes.js';
import { runGen } from './mkos/genjobs.js';
import { curSync } from './mkos/curstore.js';
import { mapObjectives } from './mkos/objmap.js';
import { mkTick } from './mkos/tick.js';
import { aiWindow, markGeminiOut } from './mkos/extract.js';
import { persistNow, durability } from './mkos/mirror.js';
import { mkInit } from './mkos/db.js';
import { ttsList as mkosSays } from './mkos/pronounce.js';
/* USAP node kit (Brain domain-sdk/usap_node_kit_v1.js, copied unchanged; replace it, never edit it here).
   Observation only: counts and timings (never user data, text or amounts) go to USAP through the USAP_UGF service binding (USAP's
   NodeGateway entrypoint, no key needed); without the binding it does nothing. It also serves Settings > Governance
   (/api/usap/governance/*, /usap/ui.js, the usap_governance connector tool) and the remediation hooks registered near the end of
   this file, plus the browser reporter (/api/usap/client) and a daily heartbeat in usapStatus. The AI order of operations (SERVICES,
   TIERS, JOBS, AI_ORDER) is locked (SR-03): usap.timeAI only times each provider call (owner go-ahead 2026-10-24) and never reorders
   or skips one, and the hooks that would touch AI routing or MKOS migration are refused by the kit. */
import { createUsapNode } from './usap_node_kit_v1.js';
/* USAP Account-Level Data Framework (SR-42): src/adf.js wires the Brain's shared module src/usap_adf_v1.js (a copy: replace it, never
   edit it here) into the account folders only. See the note above syncUser. */
import { driveAdapter, adfOnce, adfConformance, adfExport } from './adf.js';
/* USAP AI governance (kit 1.3.0): the catalog action of each AI call. Labels only; see src/aigov.js. */
import { govDims, govOf, GOV_APP } from './aigov.js';
/* Route templates only: the connector token in /mcp/<token> and any id never leave the app. */
const usapRoute = url => url.pathname.startsWith('/mcp') ? '/mcp/:token'
  : '/' + url.pathname.split('/').filter(Boolean).slice(0, 3).map(s => /^[a-f0-9]{16,}$/i.test(s) || /^\d+$/.test(s) || s.length > 40 ? ':id' : s).join('/');
const usap = createUsapNode({
  appId: 'doctor_companion_app',
  isOwner: (env, u) => isOwner(env, u),   // the app's own owner check (OWNER_EMAIL); the signed-in row carries `email`
  routeLabel: usapRoute,
  /* SR-03: provider_circuit (and rollback_config, which could restore an AI hierarchy setting) would change AI routing.
     SR-12: MKOS domain migration is gated, so apply_migration is refused too. */
  lockedHooks: ['provider_circuit', 'rollback_config', 'apply_migration'],
});
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function hashPassword(password, saltHex, iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

/* One record can be up to about 900,000 characters: room for an hour-long lesson with its tables, or a question bank fed by sets of 30.
   D1 holds at most 2 MB in a row. */
const SESSION_DAYS = 30, MAX_DOC = 900000;
const cookie = (token, age) => `dcc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const LANG_OK = /^[a-z]{2,3}$/;
const PATH_OK = /^[a-z]{2,3}\/[A-Za-z0-9_\-.~:@+]{1,120}$/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

let schema;
function init(env) {
  schema = schema || env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL,
      first TEXT, last TEXT, created TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)`),
    /* Recovery questions an account set on its account page (up to three). The answer is kept only as a salted hash, like a password. */
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recovery (user_id TEXT NOT NULL, slot INTEGER NOT NULL, question TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (user_id, slot))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS links (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage (user_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (user_id, day))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS docs (user_id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (user_id, path))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (user_id, day, provider))`),
    /* One row per account: its own subfolder in the accounts folder in Drive, and the lease that lets one copy job run at a time. */
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS drive_accounts (user_id TEXT PRIMARY KEY, folder TEXT, records TEXT, backups TEXT, profile TEXT, backup_day TEXT,
      lease INTEGER NOT NULL DEFAULT 0, synced TEXT, error TEXT)`),
    /* Which Drive file holds each record, and the version of the record that file holds. */
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS drive_docs (user_id TEXT NOT NULL, path TEXT NOT NULL, file_id TEXT NOT NULL, synced TEXT NOT NULL, PRIMARY KEY (user_id, path))`),
  ]).then(() => env.DB.prepare('ALTER TABLE drive_accounts ADD COLUMN v INTEGER NOT NULL DEFAULT 0').run().catch(() => { }))   // added later; fails harmlessly once it is there
    .then(() => env.DB.prepare('ALTER TABLE drive_accounts ADD COLUMN adf TEXT').run().catch(() => { }))   // ADF: when the account folder got its standard layout (once)
    .catch(e => { schema = null; throw e; });
  return schema;
}

async function currentUser(request, env) {
  const m = /(?:^|;\s*)dcc_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
  if (!m) return null;
  const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?').bind(await sha(m[1]), Date.now()).first();
  return row || null;
}
/* Passwords are replaced in one place, whichever way the change was asked for (email link, the direct form, or the account page).
   Every login session of the account ends, except `keep` (the session the change was made from), and any unused reset link dies. */
const PASSWORD_OK = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const PASSWORD_RULE = 'Choose a password of at least 8 characters.';
async function setPassword(env, userId, password, keep) {
  const salt = rand(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = 0 WHERE id = ?').bind(salt, await hashPassword(password, salt), userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(userId, keep || ''),
    env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(userId),
  ]);
}
/* A wrong guess counts toward the same lock as a wrong login: five in a row and the account waits 15 minutes. */
async function strike(env, u) {
  const fails = u.fails + 1;
  await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?').bind(fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 15 * 60000 : 0, u.id).run();
}
/* How a forgotten password is replaced on this site:
     email    a one-hour link sent to the recovery email. On as soon as a RESEND_API_KEY secret is set.
     direct   no email: the person gives the account's email, picks one of the recovery questions that account set on its account page,
              answers it, and chooses a new password on the spot. An account that has not set any questions yet is checked against the
              name it was made under instead. Used while email is not set up. PASSWORD_RESET = "direct" keeps it on alongside email; "off" switches it off.
     off      neither. */
const resetMode = env => { const want = String(env.PASSWORD_RESET || '').toLowerCase(); return want === 'off' ? (env.RESEND_API_KEY ? 'email' : 'off') : want === 'direct' || !env.RESEND_API_KEY ? 'direct' : 'email'; };
/* The recovery questions an account may choose from. An answer is compared ignoring capitals, punctuation and extra spaces. */
const QUESTIONS = ['What was the name of your first pet?', 'What city were you born in?', 'What was the name of your elementary school?', 'What was the make and model of your first car?',
  'What is your mother\'s maiden name?', 'What was the name of the street you grew up on?', 'What was your childhood nickname?', 'What is the middle name of your oldest sibling?',
  'What was the first concert you attended?', 'What was the name of your first employer?', 'In what city did your parents meet?', 'What was the name of your favorite teacher?'];
const MAX_RECOVERY = 3, ANSWER_ROUNDS = 25000;
const answerKey = a => String(a || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
const recoveryOf = async (env, uid) => (await env.DB.prepare('SELECT slot, question, salt, hash FROM recovery WHERE user_id = ? ORDER BY slot').bind(uid).all()).results;
const sameName = (a, b) => same(String(a || '').trim().toLowerCase(), String(b || '').trim().toLowerCase());
async function startSession(env, userId) {
  const token = rand(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return cookie(token, SESSION_DAYS * 86400);
}
/* ---------- The app's AI ----------
   Three services can answer, each switched on by its own setting:
     gemini   Google Gemini, with a GEMINI_API_KEY secret (GEMINI_MODEL and GEMINI_MODEL_QUICK choose the models)
     claude   Anthropic Claude, with an ANTHROPIC_API_KEY secret (AI_MODEL and AI_MODEL_QUICK choose the models)
     deepseek DeepSeek, with a DEEPSEEK_API_KEY secret (DEEPSEEK_MODEL and DEEPSEEK_MODEL_QUICK choose the models)
     llama    Cloudflare Workers AI, shown as "Cloudflare AI Stack": a list of open models tried in order, through the AI binding
   The app says which one it wants, or "auto". If that one has used its daily allowance for the account, is over its own limit or
   does not answer, the next one in AI_ORDER (default gemini, claude, llama) answers instead and the reply says so. Each account
   has a daily allowance per service: AI_DAILY (default 200), or AI_DAILY_GEMINI, AI_DAILY_CLAUDE, AI_DAILY_LLAMA for one service.
   Inside Claude the app uses Claude itself by default and reaches the other services through the connector (ask_ai).
   Who does which job is set by the hierarchy further down (TIERS, JOBS and each service's tier). */
/* Every AI service this site can call. A service is offered to users only while `on` is true, which means its key (or binding) is
   set in Cloudflare. `tier` is where it starts in the hierarchy below; the owner can move it on the account page. To add a service
   later (OpenAI, say): add a row here with the secret it needs and the tier it starts in (chatStyle() already speaks the common
   format). The app's drop-downs and the division of labour are built from this list, so nothing else changes. */
const SERVICES = [
  { id: 'gemini', name: 'Gemini', tier: 'lead', on: env => !!geminiKey(env), run: (env, messages, tier, tools) => gemini(env, messages, tier, tools) },
  { id: 'claude', name: 'Claude', tier: 'lead', on: env => !!env.ANTHROPIC_API_KEY, run: (env, messages, tier) => claude(env, messages, tier) },
  { id: 'deepseek', name: 'DeepSeek', tier: 'assistant', on: env => !!deepseekKey(env), run: (env, messages, tier, tools) => chatStyle(env, { name: 'deepseek', url: 'https://api.deepseek.com/chat/completions', key: deepseekKey(env),
      models: [tier === 'quick' ? env.DEEPSEEK_MODEL_QUICK : env.DEEPSEEK_MODEL, ...(tier === 'quick' ? ['deepseek-flash', 'deepseek-v4-pro'] : ['deepseek-v4-pro', 'deepseek-flash'])] }, messages, tools) },
  { id: 'llama', name: 'Cloudflare AI Stack', tier: 'chat', on: env => !!env.AI, run: (env, messages, tier) => llama(env, messages, tier) },
];
const PROVIDERS = SERVICES.map(s => [s.id, s.name]), PNAME = Object.fromEntries(PROVIDERS), SERVICE = Object.fromEntries(SERVICES.map(s => [s.id, s]));
/* The Gemini key, under the name it is usually saved as or one of the other common ones. */
const deepseekKey = env => env.DEEPSEEK_API_KEY || env.DEEPSEEK_KEY || env.DEEPSEEK || '';
const geminiKey = env => env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_KEY || env.GOOGLE_GEMINI_API_KEY || env.GOOGLE_AI_API_KEY || '';
/* ---------- The hierarchy: who may do which job ----------
   Three tiers, lowest to highest. A service sits in one tier; a job names the lowest tier allowed to do it.
     lead        writes lessons and board questions, runs the accuracy review, builds plans, reads exam reports
     assistant   the lower-risk jobs, whose output a lead always reviews before it is shown
     chat        answers in the Ask panel only
   A service may do every job at or below its own tier. For each job the order is worked out the same way:
     - jobs marked `own` go first to the services of exactly that tier (so assistants take the assistant jobs and leave the leads'
       allowances for teaching), then to higher tiers as a fallback;
     - jobs marked `pick` put the service the user chose first, when it is allowed to do the job;
     - jobs marked `differ` are reviews: the service that wrote the thing goes last, so a different one checks it whenever one exists.
   The defaults are here. The owner changes a service's tier or a job's lowest tier on the account page; the changes are kept in D1
   (settings, ai_hierarchy) and laid over these defaults, so a job or service added here later shows up without losing them. */
const TIERS = ['chat', 'assistant', 'lead'], TIER_NAME = { lead: 'Lead teacher', assistant: 'Assistant', chat: 'Chat only' };
const JOBS = [
  { id: 'lesson', name: 'Write lessons', what: 'The lesson text, part by part', need: 'lead', pick: true },
  /* The teaching-assistant role: a lesson for which a chapter or guideline was found in the library, so the facts are on the page.
     Leads still write these by default; an assistant writes one only when the user picks it under "Teaching by", and a lead
     always reviews the result (the app runs the review even when the user has switched reviews off). */
  { id: 'lesson_lib', name: 'Write lessons from the library', what: 'A lesson grounded in a library chapter or guideline; a lead always reviews it', need: 'assistant', pick: true },
  { id: 'questions', name: 'Write board questions', what: 'Board-style questions with their answer keys', need: 'lead', pick: true },
  { id: 'review', name: 'Accuracy review', what: 'The second pass over every lesson, question and card', need: 'lead', differ: true },
  { id: 'plan', name: 'Plans and mentoring', what: 'The learning plan, the mentor brief and career plans', need: 'lead', pick: true },
  { id: 'report', name: 'Read exam reports', what: 'An in-training exam report into scores and missed objectives', need: 'lead', pick: true },
  { id: 'cards', name: 'Draft flashcards', what: 'Cards for a topic or from a lesson; a lead reviews them before they are kept', need: 'assistant', own: true },
  { id: 'notes', name: 'Housekeeping', what: 'The running note on what the physician is trying to learn', need: 'assistant', own: true },
  { id: 'chat', name: 'Ask chat', what: 'Answers in the Ask panel', need: 'chat', pick: true },
];
const JOB = Object.fromEntries(JOBS.map(j => [j.id, j])), rank = t => TIERS.indexOf(t);
let HIER = { t: 0, v: null };
async function hierarchy(env, fresh) {
  if (!fresh && HIER.v && Date.now() - HIER.t < 20000) return HIER.v;
  let saved = {}; try { saved = JSON.parse(await setting(env, 'ai_hierarchy') || '{}') || {}; } catch { }
  const tiers = {}, jobs = {};
  SERVICES.forEach(s => { const t = saved.tiers && saved.tiers[s.id]; tiers[s.id] = TIERS.includes(t) ? t : s.tier; });
  JOBS.forEach(j => { const n = saved.jobs && saved.jobs[j.id]; jobs[j.id] = TIERS.includes(n) ? n : j.need; });
  HIER = { t: Date.now(), v: { tiers, jobs } }; return HIER.v;
}
/* The services that may do this job, in the order they are tried. */
function route(env, H, job, pick, avoid) {
  const J = JOB[job] || JOB.lesson, need = rank(H.jobs[J.id]);
  let list = aiOrder(env).filter(id => rank(H.tiers[id]) >= need);
  /* Unless a job is the assistants' own, the higher tier goes first: an assistant does it only when picked, or when no lead can. */
  if (!J.own && J.id !== 'chat') list = [...list].sort((a, b) => rank(H.tiers[b]) - rank(H.tiers[a]));
  if (J.own) list = [...list.filter(id => rank(H.tiers[id]) === need), ...list.filter(id => rank(H.tiers[id]) !== need)];
  if (J.pick && list.includes(pick)) list = [pick, ...list.filter(id => id !== pick)];
  if (J.differ && avoid && list.length > 1 && list.includes(avoid)) list = [...list.filter(id => id !== avoid), avoid];
  return list;
}
/* The whole picture, for drawing it: every service with its tier and whether its key is set, every job with who does it. */
function chart(env, H) {
  return { tiers: TIERS.slice().reverse().map(id => ({ id, name: TIER_NAME[id] })),
    services: SERVICES.map(s => ({ id: s.id, name: s.name, tier: H.tiers[s.id], on: s.on(env) })),
    jobs: JOBS.map(j => ({ id: j.id, name: j.name, what: j.what, need: H.jobs[j.id], differ: !!j.differ, pick: !!j.pick, own: !!j.own, order: route(env, H, j.id).map(id => PNAME[id]) })) };
}
const hasProvider = (env, id) => !!SERVICE[id] && SERVICE[id].on(env);
const aiOrder = env => [...String(env.AI_ORDER || '').toLowerCase().split(/[\s,;]+/), ...PROVIDERS.map(p => p[0])].filter((x, i, a) => a.indexOf(x) === i && hasProvider(env, x));
const aiCap = (env, id) => Number(env['AI_DAILY_' + id.toUpperCase()]) || Number(env.AI_DAILY) || 200;
const today = () => new Date().toISOString().slice(0, 10);
async function aiUsed(env, uid) { const { results } = await env.DB.prepare('SELECT provider, n FROM ai_usage WHERE user_id = ? AND day = ?').bind(uid, today()).all(); return Object.fromEntries(results.map(r => [r.provider, r.n])); }
const aiList = (env, used, H) => aiOrder(env).map(id => ({ id, name: PNAME[id], tier: H.tiers[id], teach: H.tiers[id] === 'lead', cap: aiCap(env, id), left: Math.max(0, aiCap(env, id) - (used[id] || 0)) }));
const AI_MODELS = { quick: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8'],
  default: ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8'] };
const GEMINI_MODELS = { quick: ['gemini-3.5-flash-lite', 'gemini-3.6-flash'], default: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] };
const AI_SYSTEM = 'You are the teaching engine of Doctor Career Companion, a continuing medical education and career development app for one practicing physician. Write at attending level. Base clinical statements on current guidelines from the major professional societies and name the guideline and year. Never invent a citation, statistic, dose or threshold: when unsure, say so plainly. Follow the instructions in the messages exactly. When asked for JSON, reply with only valid JSON: no prose before or after it and no code fences.';
const TOOL_NOTE = ' You can look things up with the tools you are given: the saved study record of the physician you are talking with, and the reference library. Use them when the question is about their progress, history or plan, or when a reference chapter or guideline would make the answer more exact. The tools reach this one physician\'s record only; no other account exists as far as you can see, so never claim to know about anyone else.';
function aiText(r) {
  if (!r) return '';
  const flat = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : (x && (x.type === 'output_text' || x.type === 'text') && x.text) || '').join('') : '';
  const t = typeof r === 'string' ? r : flat(r.response) || flat(r.output_text) || flat(r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content)
    || (Array.isArray(r.output) ? r.output.filter(o => o && o.type === 'message').map(o => flat(o.content)).join('\n') : '') || flat(r.result && r.result.response);
  return String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
const busy = m => Object.assign(new Error(m), { busy: true });
/* What an AI may look up for the account it is answering. The account is fixed here, from the login, before the model says a word:
   the model supplies a record name or a search phrase, never an account. */
function accountTools(env, user) {
  const lib = libraryOn(env, user), CUT = 24000, at = v => Math.max(0, Math.floor(Number(v) || 0));
  const list = [
    { name: 'list_my_records', description: 'List the saved study and career records of the physician you are talking with: each record name, its size in characters and when it last changed. Names look like med/state (settings, mastery and statistics by topic), med/log (what was studied and for how long), med/asks (questions they asked) and one record per saved lesson, question bank or card deck.' },
    { name: 'read_my_record', description: 'Read one of this physician\'s records by the name list_my_records gave. Long records come in pieces: pass the offset the previous piece returned as "next".', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path'] } },
    ...(lib ? [
      { name: 'search_library', description: 'Search the reference library (board syllabus chapters, society guidelines, exam blueprints, the sources registry) by a word or short phrase from a title or the text.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'read_library', description: 'Read a reference library file by the id search_library gave. Long files come in pieces: pass the offset the previous piece returned as "next".', parameters: { type: 'object', properties: { fileId: { type: 'string' }, offset: { type: 'integer' } }, required: ['fileId'] } }] : []),
  ];
  const run = async (name, a) => {
    a = a && typeof a === 'object' ? a : {};
    try {
      if (name === 'list_my_records') { const h = await holders(env, user.id); return { records: (await env.DB.prepare(`SELECT path, length(body) AS size, updated FROM docs WHERE user_id IN (${HOLD(h)}) ORDER BY path`).bind(...h).all()).results }; }
      if (name === 'read_my_record') {
        const path = str(a.path, 130); if (!PATH_OK.test(path)) return { error: 'No record has that name.' };
        const r = await env.DB.prepare('SELECT body, updated FROM docs WHERE user_id = ? AND path = ?').bind(await homeOf(env, user.id, path), path).first(); if (!r) return { error: 'No record has that name.' };
        const o = at(a.offset); return { path, updated: r.updated, text: r.body.slice(o, o + CUT), next: o + CUT < r.body.length ? o + CUT : null };
      }
      if (lib && name === 'search_library') {
        const q = str(a.query, 120).replace(/['\\]/g, ' ').trim(); if (!q) return { error: 'Give a word or phrase to search for.' };
        return { files: (await driveTool(env, 'search_files', { query: `title contains '${q}' or fullText contains '${q}'`, pageSize: 25 })).files.slice(0, 15).map(f => ({ fileId: f.id, title: f.title, kind: f.mimeType === FOLDER ? 'folder' : 'file' })) };
      }
      if (lib && name === 'read_library') {
        const v = await driveTool(env, 'read_file_content', { fileId: str(a.fileId, 200) }), o = at(a.offset);
        return { title: v.title, text: v.fileContent.slice(o, o + CUT), next: o + CUT < v.fileContent.length ? o + CUT : null };
      }
      return { error: 'There is no such tool.' };
    } catch (e) { if (!(e instanceof LibError)) console.error(e); return { error: e instanceof LibError ? e.message : 'That could not be read just now.' }; }
  };
  return { list, run };
}
async function gemini(env, messages, tier, tools) {
  const models = [tier === 'quick' ? env.GEMINI_MODEL_QUICK : env.GEMINI_MODEL, ...GEMINI_MODELS[tier]].filter((m, i, a) => m && a.indexOf(m) === i);
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  let last = '', limited = false;
  for (const model of models) {
    const turn = contents.slice();
    for (let round = 0; round < 7; round++) {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey(env) },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: AI_SYSTEM + (tools ? TOOL_NOTE : '') }] }, contents: turn, generationConfig: { maxOutputTokens: 32768 },
          ...(tools ? { tools: [{ functionDeclarations: tools.list }], toolConfig: { functionCallingConfig: { mode: round < 6 ? 'AUTO' : 'NONE' } } } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        last = model + ': ' + r.status + ' ' + String((j.error && j.error.message) || '').slice(0, 200);
        if (r.status === 401 || r.status === 403 || (r.status === 400 && /API key/i.test(last))) throw new Error('gemini refused the key (' + last + ')');
        if (r.status === 429) limited = true;
        break;   // this model is missing, busy or over its limit: the next one has its own allowance
      }
      const c = j.candidates && j.candidates[0], parts = (c && c.content && c.content.parts) || [], calls = parts.filter(p => p && p.functionCall);
      if (calls.length && tools && round < 6) {
        turn.push(c.content);   // handed back exactly as it came, so the model's own bookkeeping on each call stays attached
        const out = []; for (const p of calls) out.push({ functionResponse: { name: p.functionCall.name, ...(p.functionCall.id ? { id: p.functionCall.id } : {}), response: { result: await tools.run(p.functionCall.name, p.functionCall.args) } } });
        turn.push({ role: 'user', parts: out }); continue;
      }
      const text = parts.filter(p => p && !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
      if (text) return { text, model };
      last = model + ': empty reply (' + ((c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || 'no text') + ')'; break;
    }
  }
  throw limited ? busy('gemini ' + last) : new Error('gemini ' + last);
}
/* Any service that speaks the widely used chat-completions format (DeepSeek today; OpenAI and others later use the same function
   with their own address, key and model names). Account lookups work the same way as for Gemini: the model names a record or a
   search phrase, this server runs it for the caller's account, and the answer goes back. If a service rejects the lookup tools,
   the request is sent again without them. */
async function chatStyle(env, svc, messages, tools) {
  const models = svc.models.filter((m, i, a) => m && a.indexOf(m) === i);
  let last = '', limited = false;
  for (const model of models) {
    for (const withTools of tools ? [true, false] : [false]) {
      const turn = [{ role: 'system', content: AI_SYSTEM + (withTools ? TOOL_NOTE : '') }, ...messages]; let again = false;
      for (let round = 0; round < 7; round++) {
        const r = await fetch(svc.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + svc.key },
          body: JSON.stringify({ model, messages: turn, ...(withTools && round < 6 ? { tools: tools.list.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } })) } : {}) }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          last = model + ': ' + r.status + ' ' + String((j.error && (j.error.message || j.error)) || '').slice(0, 200);
          if (r.status === 401 || r.status === 403) throw new Error(svc.name + ' refused the key (' + last + ')');
          if (r.status === 402) throw busy(svc.name + ' has no credit left (' + last + ')');
          if (r.status === 429) limited = true;
          again = withTools && r.status === 400; break;
        }
        const msg = j.choices && j.choices[0] && j.choices[0].message, calls = (msg && Array.isArray(msg.tool_calls) && msg.tool_calls) || [];
        if (calls.length && withTools && round < 6) {
          turn.push(msg);   // handed back exactly as it came
          for (const c of calls) { let a = {}; try { a = JSON.parse((c.function && c.function.arguments) || '{}'); } catch { } turn.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await tools.run(c.function && c.function.name, a)) }); }
          continue;
        }
        const text = aiText(j);
        if (text) return { text, model };
        last = model + ': empty reply'; break;
      }
      if (!again) break;
    }
  }
  throw limited ? busy(svc.name + ' ' + last) : new Error(svc.name + ' ' + last);
}
async function claude(env, messages, tier) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: tier === 'quick' ? (env.AI_MODEL_QUICK || 'claude-haiku-4-5-20251001') : (env.AI_MODEL || 'claude-sonnet-5-5'), max_tokens: 16000, system: AI_SYSTEM, messages }) });
  if (!r.ok) throw r.status === 429 || r.status === 529 ? busy('claude ' + r.status) : new Error('claude ' + r.status);
  const j = await r.json();
  return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim(), model: j.model || 'claude' };
}
async function llama(env, messages, tier) {
  for (const model of [env.LLAMA_MODEL, ...(AI_MODELS[tier] || AI_MODELS.default)].filter(Boolean)) {
    try { const text = aiText(await env.AI.run(model, { messages: [{ role: 'system', content: AI_SYSTEM }, ...messages], max_tokens: 8000 })); if (text) return { text, model: model.split('/').pop() }; }
    catch (e) { console.error('ai model failed: ' + model, e); }
  }
  return { text: '', model: '' };
}
/* One request from the app, for one account. `job` says what the request is for (see JOBS); `provider` is the service the user
   picked ("auto" for none); `avoid` is the service that wrote the thing under review; `account` lets the model look up this
   account's record and the library while it answers (Gemini and DeepSeek). */
/* ---------- Reading aloud ----------
   One short passage of a lesson turned into speech, by Google's voices while their free monthly allowance lasts (googleSpeak below)
   and otherwise by Cloudflare's free voice model, returned as a sound file in base64. It arrives as an
   /api/ai request (or the ask_ai connector tool) whose job is "speak", so the app inside Claude needs no extra tool.
   The free Cloudflare allowance is one pool for the whole Cloudflare account. TTS_DAILY_CHARS (default 400,000 characters, about
   seven hours of speech) stops this app using more than that in a day; past it, or whenever Cloudflare refuses, the answer is a
   429 and the app reads with the device's own voice instead. Characters spoken are counted per account in ai_usage as "tts". */
const TTS_MODEL = '@cf/myshell-ai/melotts';
const b64 = bytes => { let t = ''; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(t); };
const unb64 = t => { if (Uint8Array.fromBase64) return Uint8Array.fromBase64(t); const bin = atob(t), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
/* The voice model answers with an uncompressed sound file at 44,100 samples a second, far more than speech needs and heavy on a
   phone's data. A plain 16-bit single-channel file is halved to 22,050 by averaging each pair of samples; anything else is passed on as it is. */
function slim(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = o => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 1000 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(36) !== 'data' || v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint16(34, true) !== 16 || v.getUint32(24, true) < 32000) return bytes;
  const rate = v.getUint32(24, true) / 2, n = Math.floor(Math.min(v.getUint32(40, true), bytes.length - 44) / 4), out = new Uint8Array(44 + n * 2), o = new DataView(out.buffer);
  out.set(bytes.subarray(0, 44)); o.setUint32(4, 36 + n * 2, true); o.setUint32(24, rate, true); o.setUint32(28, rate * 2, true); o.setUint32(40, n * 2, true);
  for (let i = 0, a = 44; i < n; i++, a += 4) o.setInt16(44 + i * 2, (v.getInt16(a, true) + v.getInt16(a + 2, true)) >> 1, true);
  return out;
}
const soundType = b => b[0] === 0x52 && b[1] === 0x49 ? 'audio/wav' : 'audio/mpeg';
/* Google Cloud Text-to-Speech reads first when the site has a key for it (GOOGLE_TTS_KEY). Google gives each kind of voice its own free
   allowance of characters every month and bills the account's card for anything past it, so each kind is used only up to a share of
   its allowance (GOOGLE_TTS_SHARE, default 0.95) and then the next kind takes over: the newest and most natural first. When all
   three are spent for the month, or Google cannot be reached, the Cloudflare voice below reads instead. Characters are counted for
   the whole site, per kind, in ai_usage as "gtts-<kind>"; a month here is a calendar month in UTC, which the margin allows for. */
const GTTS = [
  { id: 'chirp', voice: 'en-US-Chirp3-HD-Aoede', free: 1e6 },
  { id: 'neural2', voice: 'en-US-Neural2-F', free: 1e6 },
  { id: 'wavenet', voice: 'en-US-Wavenet-F', free: 4e6 },
];
/* The Google voices a listener may pick in the app's Settings (kept in their record as prefs.gvoice), and whether each is a woman's
   or a man's voice, so that the other kinds, which have their own names, follow the choice as closely as they can. GVOICES are the
   Chirp 3 HD voices; WAVENET are the WaveNet ones, picked as 'Wavenet-<letter>'. */
const GVOICES = { Aoede: 'F', Kore: 'F', Leda: 'F', Zephyr: 'F', Puck: 'M', Charon: 'M', Fenrir: 'M', Orus: 'M' };
const WAVENET = { A: 'M', B: 'M', C: 'F', D: 'M', E: 'F', F: 'F', G: 'F', H: 'F', I: 'M', J: 'M' };
const gvoiceOk = v => typeof v === 'string' && (!!GVOICES[v] || /^Wavenet-[A-J]$/.test(v));
/* Only the site owner (OWNER_EMAIL) may use the costlier Google kinds (Chirp 3 HD, Neural2), whose free monthly allowances are small
   and shared by the whole site; every other account reads with WaveNet, which has the largest allowance, then Cloudflare, then the device. */
const googleKinds = (env, user) => isOwner(env, user) ? GTTS : GTTS.filter(x => x.id === 'wavenet');
/* prefs.gtier is the listener's choice of model: '' (best available), one of the Google kinds to start from, or 'melo' for the
   Cloudflare voice only. A chosen Google kind still gives way to the next once its free allowance for the month is spent. */
async function googlePrefs(env, user) {
  try { const row = await env.DB.prepare("SELECT json_extract(body, '$.prefs.gvoice') AS v, json_extract(body, '$.prefs.gtier') AS t FROM docs WHERE user_id = ? AND path = 'med/state'").bind(user.id).first();
    return { pick: row && gvoiceOk(row.v) ? row.v : '', tier: row && typeof row.t === 'string' ? row.t : '' }; } catch (e) { return { pick: '', tier: '' }; }
}
function googleVoice(env, pick, kind) {
  const wn = /^Wavenet-[A-J]$/.test(pick), man = (wn ? WAVENET[pick.slice(8)] : GVOICES[pick]) === 'M';
  if (kind === 'chirp') return GVOICES[pick] ? 'en-US-Chirp3-HD-' + pick : man ? 'en-US-Chirp3-HD-Charon' : (env.GOOGLE_TTS_VOICE || 'en-US-Chirp3-HD-Aoede');
  if (kind === 'neural2') return 'en-US-Neural2-' + (man ? 'D' : 'F');
  return 'en-US-' + (wn ? pick : 'Wavenet-' + (man ? 'D' : 'F'));
}
async function googleUsage(env) {
  const { results } = await env.DB.prepare("SELECT provider, SUM(n) AS n FROM ai_usage WHERE day LIKE ? AND provider LIKE 'gtts-%' GROUP BY provider").bind(today().slice(0, 7) + '-%').all();
  return Object.fromEntries(results.map(r => [r.provider, r.n || 0]));
}
async function googleSpeak(env, user, text) {
  if (!env.GOOGLE_TTS_KEY) return null;
  const prefs = await googlePrefs(env, user);
  if (prefs.tier === 'melo') return null;
  const used = await googleUsage(env), share = Math.min(1, Math.max(0, Number(env.GOOGLE_TTS_SHARE) || 0.95));
  const kinds = googleKinds(env, user);
  for (const v of kinds.slice(Math.max(0, kinds.findIndex(x => x.id === prefs.tier)))) {
    const key = 'gtts-' + v.id;
    if ((used[key] || 0) + text.length > v.free * share) continue;
    try {
      const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_TTS_KEY },
        body: JSON.stringify({ input: { text }, voice: { languageCode: 'en-US', name: googleVoice(env, prefs.pick, v.id) }, audioConfig: { audioEncoding: 'MP3' } }), signal: AbortSignal.timeout(9000) });
      if (!r.ok) { console.log('google voice ' + v.id + ': ' + r.status + ' ' + (await r.text()).slice(0, 200)); if (r.status === 429 || r.status >= 500) continue; return null; }
      const j = await r.json();
      if (!j || typeof j.audioContent !== 'string' || !j.audioContent) continue;
      await env.DB.prepare('INSERT INTO ai_usage (user_id, day, provider, n) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, day, provider) DO UPDATE SET n = n + excluded.n').bind(user.id, today(), key, text.length).run();
      usap.emitMetric('tts_chars_used', text.length, { provider: 'google', voice_kind: v.id });   // USAP: counts only
      usap.emitMetric('tts_quota_utilization', ((used[key] || 0) + text.length) / v.free, { provider: 'google', voice_kind: v.id });
      return { status: 200, audio: j.audioContent, type: 'audio/mpeg', voice: 'google-' + v.id };
    } catch (e) { console.log('google voice ' + v.id + ': ' + String(e && e.message || e).slice(0, 200)); return null; }
  }
  return null;
}
/* Pronunciations. The Cloudflare voice reads plain text only and gets some words wrong, drug names above all. Each account keeps a
   list in its record (`says` in med/state: { w: the word, s: how to spell it so the voice says it right, on }), edited in the app's
   Settings. Just before a passage goes to any voice (Google, Cloudflare, and on the device the offline and device voices, which
   swap the words in the app itself), each listed word is swapped for its respelling: whole words only, any capitalisation, a plural
   s carried over. The text on screen is never touched. */
async function sayList(env, user) {
  /* The list has its own document (med/says, {list}); an older record keeps it inside med/state as `says`. The owner's is central. */
  try { const row = await env.DB.prepare("SELECT json_extract(body, '$.list') AS s FROM docs WHERE user_id = ? AND path = 'med/says'").bind(await homeOf(env, user.id, 'med/says')).first();
    if (row && row.s) { const a = JSON.parse(row.s); if (Array.isArray(a)) return a; } } catch (e) { }
  try { const row = await env.DB.prepare("SELECT json_extract(body, '$.says') AS s FROM docs WHERE user_id = ? AND path = 'med/state'").bind(user.id).first();
    const a = row && row.s ? JSON.parse(row.s) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
/* The site owner's list is the central one: it is used for every account. Anyone else's list applies to their own account only,
   on top of the owner's, and wins where both give the same word (respell keeps the first entry it meets for a word and skips
   entries that are switched off, so a person's own entries go first). */
async function ownerId(env) {
  if (!env.OWNER_EMAIL) return null;
  try { const r = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?').bind(String(env.OWNER_EMAIL).trim().toLowerCase()).first(); return r ? r.id : null; } catch (e) { return null; }
}
/* ---------- Central registry records (MKOS Data Domain Separation) ----------
   The owner's pronunciation list (med/says), its change log (med/saylog) and their daily copies (bak/says-<day>, bak/saylog-<day>)
   are platform knowledge used for every account, so they are not kept in the owner's account: they live under the reserved record
   holder CENTRAL, which no login reaches and deleting an account never touches. MKOS persists them to Drive (Doctor Companion App
   Central Registry Data > MKOS > central) and restores them from there. The owner still edits them in the app as before: every
   record path below resolves the owner's copy of these names to the central one. Anyone else's list stays in their own account. */
const CENTRAL = '_central';
const centralPath = p => p === 'med/says' || p === 'med/saylog' || /^bak\/(says|saylog)-/.test(String(p || ''));
async function homeOf(env, uid, path) {
  if (!centralPath(path) || !uid || uid !== await ownerId(env)) return uid;
  await centralize(env);   // never write a central record before the owner's older copy has moved, or the guard would compare against nothing
  return CENTRAL;
}
/* Whose records a bulk read covers: the account, plus the central records when the account is the owner's. The central rows sort
   last so they win over any leftover copy. */
async function holders(env, uid) { const o = await ownerId(env); return o && o === uid ? [uid, CENTRAL] : [uid]; }
const HOLD = ids => ids.map(() => '?').join(',');
/* One-time move (repeated harmlessly): any of these records still in the owner's account go to the central holder (a newer
   central copy is kept), and the owner's copies and their account Drive files are removed. */
let centralized = false;
async function centralize(env) {
  if (centralized) return; const o = await ownerId(env); if (!o) return;
  const { results } = await env.DB.prepare("SELECT path, body, updated FROM docs WHERE user_id = ? AND (path IN ('med/says','med/saylog') OR path LIKE 'bak/says-%' OR path LIKE 'bak/saylog-%')").bind(o).all();
  for (const r of results) {
    await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated WHERE excluded.updated > docs.updated').bind(CENTRAL, r.path, r.body, r.updated).run();
    await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(o, r.path).run();   // the account Drive sync moves its file to the trash
  }
  /* The ABIM blueprint document the MKOS curriculum is built from: a central copy (the owner's own choice of outline in the app stays
     his, in his account). */
  await env.DB.prepare("INSERT OR IGNORE INTO docs (user_id, path, body, updated) SELECT ?, 'mkos/abim_blueprint', body, updated FROM docs WHERE user_id = ? AND path = 'med/blueprint'").bind(CENTRAL, o).run();
  /* Cached copies of the shared sources registry (med/libreg) keep only entries for files MKOS does not know (a person's own library). */
  try {
    const known = new Set((await env.DB.prepare("SELECT json_extract(body, '$.drive_file_id') AS f FROM mk_objects WHERE type = 'Source' AND json_extract(body, '$.drive_file_id') IS NOT NULL").all()).results.map(r => r.f));
    if (known.size) for (const r of (await env.DB.prepare("SELECT user_id, body FROM docs WHERE path = 'med/libreg'").all()).results) {
      let d = null; try { d = JSON.parse(r.body); } catch { } const map = (d && d.map) || {}, own = {};
      for (const [k, v] of Object.entries(map)) if (!known.has(k)) own[k] = v;
      if (Object.keys(own).length === Object.keys(map).length) continue;
      if (Object.keys(own).length) await env.DB.prepare("UPDATE docs SET body = ?, updated = ? WHERE user_id = ? AND path = 'med/libreg'").bind(JSON.stringify({ ...d, map: own }), new Date().toISOString(), r.user_id).run();
      else await env.DB.prepare("DELETE FROM docs WHERE user_id = ? AND path = 'med/libreg'").bind(r.user_id).run();
    }
  } catch (e) { console.log('libreg: ' + String(e && e.message || e).slice(0, 120)); }
  centralized = true;
  return results.length;
}
/* After the account's list and the owner's central list come the MKOS pronunciation records cleared for speech (src/mkos/pronounce.js):
   respell keeps the first entry it meets for a word, so a person's own entries, then the owner's, always win. */
async function sayFor(env, user) {
  const mine = await sayList(env, user), o = await ownerId(env);
  const mk = env.MKOS === 'off' ? [] : await mkosSays(env).catch(() => []);
  return (!o || o === user.id ? mine : mine.concat(await sayList(env, { id: o }))).concat(mk);
}
/* What the app shows about it: whether this account is the owner, and for everyone else the central entries in use. */
async function siteSays(env, user) {
  const o = await ownerId(env);
  if (!o || o === user.id) return { owner: !!o, list: [] };
  const mk = env.MKOS === 'off' ? [] : await mkosSays(env).catch(() => []);
  const list = (await sayList(env, { id: o })).concat(mk).filter(x => x && x.on !== false && typeof x.w === 'string' && typeof x.s === 'string' && x.w.trim() && x.s.trim()).slice(0, SAY_MAX).map(x => ({ w: x.w.trim().toLowerCase().slice(0, 60), s: x.s.trim().slice(0, 120) }));
  return { owner: false, list };
}
/* Up to SAY_MAX words in use per account (the owner's central list counts separately). Single words are found by looking each
   word of the text up in a table, which stays fast with thousands of entries; entries of two or three words use a pattern. */
const SAY_MAX = 10000;
function respell(text, list) {
  const map = new Map(), multi = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || x.on === false || typeof x.w !== 'string' || typeof x.s !== 'string') continue;
    const w = x.w.replace(/\s+/g, ' ').trim().toLowerCase(), s = x.s.replace(/\s+/g, ' ').trim();
    if (w && s && w.length <= 60 && s.length <= 120 && !map.has(w) && map.size < SAY_MAX * 2) { map.set(w, s); if (/[^a-z0-9]/.test(w)) multi.push(w); }
  }
  if (!map.size) return text;
  if (multi.length) {
    const words = multi.sort((a, b) => b.length - a.length).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    const re = new RegExp("(?<![A-Za-z0-9])(" + words.join('|') + ")(s?)(?![A-Za-z0-9])", 'gi');
    text = text.replace(re, (m, w, s) => { const to = map.get(w.toLowerCase().replace(/\s+/g, ' ')); return to ? '\u0000' + to + s + '\u0001' : m; });
  }
  /* Words already swapped above sit between \u0000 and \u0001 and are left alone; the markers are removed at the end. */
  text = text.replace(/\u0000[^\u0001]*\u0001|[A-Za-z0-9]+/g, m => {
    if (m.charCodeAt(0) === 0) return m;
    const l = m.toLowerCase();let to = map.get(l);
    if (to) return to;
    if (l.length > 3 && l.endsWith('s') && (to = map.get(l.slice(0, -1)))) return to + 's';
    return m;
  });
  return text.replace(/[\u0000\u0001]/g, '');
}
/* ---------- Guarding the pronunciation list ----------
   The list (med/says) and the AI's notes about it (med/saylog) are built by hand over many hours, and every copy of the app (the
   website, the app inside Claude, the copy inside Life OS, another phone) saves the whole list at once. A copy that was opened
   earlier and still holds an older, shorter list would otherwise replace the longer one. So a save may remove at most a few words
   at a time (removing a word in the app removes one); anything more and the missing words are put back. Before each save the list
   as it stood is also kept as that day's copy (bak/says-<day>, bak/saylog-<day>, holding the longest version seen that day), which
   the app never loads and nothing overwrites with a shorter list. */
const SAY_DROP_MAX = 3;
const sayKey = x => x && typeof x.w === 'string' ? x.w.replace(/\s+/g, ' ').trim().toLowerCase() : '';
async function guardSays(env, uid, path, obj) {
  if (path !== 'med/says' && path !== 'med/saylog') return obj;
  uid = await homeOf(env, uid, path);
  let old = null;
  try { const row = await env.DB.prepare('SELECT body FROM docs WHERE user_id = ? AND path = ?').bind(uid, path).first(); old = row ? JSON.parse(row.body) : null; } catch (e) { old = null; }
  if (!old || typeof old !== 'object') return obj;
  const size = o => path === 'med/says' ? (Array.isArray(o.list) ? o.list.length : 0) : (Array.isArray(o.learn) ? o.learn.length : 0) + (Array.isArray(o.tried) ? o.tried.length : 0);
  try {
    const bak = 'bak/' + path.slice(4) + '-' + today(), b = await env.DB.prepare('SELECT body FROM docs WHERE user_id = ? AND path = ?').bind(uid, bak).first();
    let had = -1; try { had = b ? size(JSON.parse(b.body)) : -1; } catch (e) { }
    if (size(old) >= had) await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(uid, bak, JSON.stringify(old), new Date().toISOString()).run();
  } catch (e) { console.log('says backup: ' + String(e && e.message || e).slice(0, 200)); }
  const keep = (was, now, key) => {
    if (!Array.isArray(was)) return now;
    now = Array.isArray(now) ? now : [];
    const have = new Set(now.map(key)), gone = was.filter(x => key(x) && !have.has(key(x)));
    return gone.length > SAY_DROP_MAX ? now.concat(gone) : now;
  };
  const out = Object.assign({}, obj);
  if (path === 'med/says') out.list = keep(old.list, obj.list, sayKey);
  else { const lk = x => typeof x === 'string' ? x.trim().toLowerCase() : ''; out.learn = keep(old.learn, obj.learn, sayKey); out.tried = keep(old.tried, obj.tried, lk);
    /* Words checked as sounding right as written are never dropped by a whole-record save. */
    if (Array.isArray(old.asis)) { const have = new Set(Array.isArray(obj.asis) ? obj.asis.map(lk) : []); out.asis = (Array.isArray(obj.asis) ? obj.asis : []).concat(old.asis.filter(w => lk(w) && !have.has(lk(w)))); } }
  return out;
}
/* ---------- Changing the pronunciation list one word at a time ----------
   The app does not save the list as a whole. Each change is sent as a small instruction about one word, saved through the usual
   save path as the document med/sayop ({ops}), which is never stored: the server applies the instructions to med/says and
   med/saylog as they stand on the server. A copy of the app that was opened earlier therefore cannot replace words it never saw.
     {o:'put', x:{w, s, g, on}}  add a word (newest first) or replace the entry with that word
     {o:'del', w}                remove a word from the list
     {o:'learn', x:{w, g, s, r, t}}  note what happened to the AI's suggestion for a word (one note per word)
     {o:'try', w}                the word was tried, so the word tester does not offer it again
     {o:'asis', w}               the voice says the word right as written: kept for good, never offered again, counted as checked
   saylog.asis is the list of words checked as sounding right as written. */
async function applySayOps(env, uid, ops) {
  if (!Array.isArray(ops) || !ops.length) return { ok: true, n: 0 };
  uid = await homeOf(env, uid, 'med/says');
  const read = async path => { try { const r = await env.DB.prepare('SELECT body FROM docs WHERE user_id = ? AND path = ?').bind(uid, path).first(); const o = r ? JSON.parse(r.body) : null; return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };
  const write = (path, o) => env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(uid, path, JSON.stringify(o), new Date().toISOString()).run();
  const says = (await read('med/says')) || { v: 1, list: [] }, log = (await read('med/saylog')) || { v: 1, learn: [], tried: [], asis: [] };
  let list = Array.isArray(says.list) ? says.list.slice() : [], learn = Array.isArray(log.learn) ? log.learn.slice() : [];
  const tried = new Set((Array.isArray(log.tried) ? log.tried : []).filter(x => typeof x === 'string')), asis = new Set((Array.isArray(log.asis) ? log.asis : []).filter(x => typeof x === 'string'));
  const lw = w => typeof w === 'string' ? w.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60) : '';
  const str = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
  let a = 0, b = 0;
  for (const op of ops.slice(0, 5000)) {
    if (!op || typeof op !== 'object') continue;
    if (op.o === 'put' && op.x && lw(op.x.w)) {
      const w = lw(op.x.w), x = { w, s: str(op.x.s, 120) };
      if (str(op.x.g, 120)) x.g = str(op.x.g, 120);
      if (op.x.on === false) x.on = false; else if (op.x.on === true) x.on = true;
      const i = list.findIndex(y => sayKey(y) === w);
      if (i >= 0) list[i] = x; else { if (list.length >= SAY_MAX * 2) continue; list.unshift(x); }
      if (x.s && x.on !== false) asis.delete(w);
      a++;
    } else if (op.o === 'del' && lw(op.w)) { const w = lw(op.w); list = list.filter(y => sayKey(y) !== w); a++; }
    else if (op.o === 'learn' && op.x && lw(op.x.w)) {
      const w = lw(op.x.w), x = { w, g: str(op.x.g, 120), s: str(op.x.s, 120), r: ['ok', 'edit', 'asis'].includes(op.x.r) ? op.x.r : 'edit', t: Number(op.x.t) || Date.now() };
      learn = learn.filter(y => sayKey(y) !== w); learn.push(x); if (learn.length > 4000) learn = learn.slice(-4000); b++;
    } else if (op.o === 'try' && lw(op.w)) { const w = lw(op.w); tried.delete(w); tried.add(w); b++; }
    else if (op.o === 'asis' && lw(op.w)) { const w = lw(op.w); asis.add(w); tried.add(w); b++; }
  }
  if (a) { const o = await read('med/says'); if (o) await guardSays(env, uid, 'med/says', o); await write('med/says', Object.assign({}, says, { v: 1, list, _t: Date.now() })); }
  if (b) { const o = await read('med/saylog'); if (o) await guardSays(env, uid, 'med/saylog', o); await write('med/saylog', Object.assign({}, log, { v: 1, learn, tried: [...tried].slice(-20000), asis: [...asis], _t: Date.now() })); }
  return { ok: true, n: a + b };
}
/* `only` is 'cf' for the Settings play buttons: the Cloudflare voice reads the text exactly as given, so a respelling can be heard
   and compared with the word as written. */
async function speak(env, user, input, only) {
  let text = String(typeof input === 'string' ? input : '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!text) return { status: 400, error: 'Nothing to read.' };
  if (only !== 'cf') {
    text = respell(text, await sayFor(env, user)).slice(0, 900);
    const g = await googleSpeak(env, user, text).catch(() => null);
    if (g) return g;
  }
  if (!env.AI) return { status: 429, error: 'The natural voice is not available on this site.' };
  const cap = Number(env.TTS_DAILY_CHARS) || 400000;
  const row = await env.DB.prepare("SELECT SUM(n) AS n FROM ai_usage WHERE day = ? AND provider = 'tts'").bind(today()).first();
  if (((row && row.n) || 0) + text.length > cap) return { status: 429, error: 'The natural voice has reached its limit for today.' };
  let audio = '', type = 'audio/mpeg';
  try {
    const r = await usap.timeAI(() => env.AI.run(env.TTS_MODEL || TTS_MODEL, { prompt: text, lang: 'en' }), { provider: 'cloudflare', model_id: env.TTS_MODEL || TTS_MODEL, job: 'speak', ...govOf('speak_tts', { route: 'speak' }) });   // USAP: timing only
    if (r && typeof r.audio === 'string') audio = r.audio;
    else if (r instanceof ArrayBuffer) audio = b64(new Uint8Array(r));
    else if (r instanceof Uint8Array) audio = b64(r);
    else if (r && typeof r.getReader === 'function') audio = b64(new Uint8Array(await new Response(r).arrayBuffer()));
    if (audio) { try { const small = slim(unb64(audio)); type = soundType(small); audio = b64(small); } catch (e) {} }
  } catch (e) { console.log('speak: ' + String(e && e.message || e).slice(0, 200)); return { status: 503, error: 'The natural voice is not available just now.' }; }
  if (!audio) return { status: 502, error: 'The natural voice sent nothing back.' };
  await env.DB.prepare("INSERT INTO ai_usage (user_id, day, provider, n) VALUES (?, ?, 'tts', ?) ON CONFLICT (user_id, day, provider) DO UPDATE SET n = n + excluded.n").bind(user.id, today(), text.length).run();
  usap.emitMetric('tts_chars_used', text.length, { provider: 'cloudflare', voice_kind: 'melotts' });   // USAP: counts only
  usap.emitMetric('tts_quota_utilization', (((row && row.n) || 0) + text.length) / cap, { provider: 'cloudflare', voice_kind: 'melotts' });
  return { status: 200, audio, type, voice: 'cloudflare' };
}
/* ---------- The offline voice's files ----------
   The app can also read with a voice model that runs on the listener's own device (Kokoro; public/voice/). Its files are large
   (the model is 92 MB compressed or 326 MB at full quality) and are published by others, so this site keeps its own copy in the R2
   bucket VOICE and serves them from /voice/hf/ (the model and voices, from huggingface.co) and /voice/ort/ (the ONNX runtime, from
   jsdelivr). A file is copied into R2 the first time anyone asks for it and served from R2 ever after. Only the files named here
   can be asked for, so this is not an open door to those sites. */
const VOICE_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX', ORT_VERSION = '3.5.1';
function voiceSource(path) {
  let m = new RegExp('^/voice/hf/' + VOICE_REPO.replace(/[.]/g, '\\.') + '/resolve/main/(config\\.json|tokenizer\\.json|tokenizer_config\\.json|onnx/model(?:_quantized)?\\.onnx|voices/[a-z]{2}_[a-z0-9]{2,20}\\.bin)$').exec(path);
  if (m) return { key: 'kokoro-v1.0/' + m[1], from: 'https://huggingface.co/' + VOICE_REPO + '/resolve/main/' + m[1], type: m[1].endsWith('.json') ? 'application/json' : 'application/octet-stream' };
  m = /^\/voice\/ort\/(ort-wasm-simd-threaded(?:\.jsep)?\.(mjs|wasm))$/.exec(path);
  if (m) return { key: 'ort-' + ORT_VERSION + '/' + m[1], from: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' + ORT_VERSION + '/dist/' + m[1], type: m[2] === 'mjs' ? 'text/javascript' : 'application/wasm' };
  return null;
}
async function voiceCopy(env, f) {
  const r = await fetch(f.from, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error('source answered ' + r.status);
  const len = Number(r.headers.get('Content-Length')) || 0, opt = { httpMetadata: { contentType: f.type } };
  if (len > 150e6) { try { await r.body.cancel(); } catch (e) {} return voiceCopyBig(env, f, len, opt); }
  if (len > 4e6 && !r.headers.get('Content-Encoding')) { const pipe = new FixedLengthStream(len); await Promise.all([r.body.pipeTo(pipe.writable), env.VOICE.put(f.key, pipe.readable, opt)]); }
  else await env.VOICE.put(f.key, await r.arrayBuffer(), opt);
  return true;
}
/* A very large file is copied a few 32 MB pieces at a time, so no single request runs long: each call adds up to three pieces and
   notes how far it got (in "<file>.parts"), and the call that adds the last piece finishes the file. Returns true once it is whole. */
async function voiceCopyBig(env, f, len, opt) {
  const PART = 32 * 1024 * 1024, note = f.key + '.parts', total = Math.ceil(len / PART);
  const kept = await env.VOICE.get(note); let st = kept ? await kept.json() : null, up;
  if (st && st.len === len) up = env.VOICE.resumeMultipartUpload(f.key, st.id);
  else { up = await env.VOICE.createMultipartUpload(f.key, opt); st = { id: up.uploadId, len, parts: [] }; }
  for (let did = 0; st.parts.length < total && did < 3; did++) {
    const n = st.parts.length, a = n * PART, b = Math.min(len, a + PART) - 1;
    const r = await fetch(f.from, { redirect: 'follow', headers: { Range: 'bytes=' + a + '-' + b } });
    if (r.status !== 206) throw new Error('source answered ' + r.status + ' to a piece');
    const part = await up.uploadPart(n + 1, await r.arrayBuffer());
    st.parts.push({ partNumber: part.partNumber, etag: part.etag }); await env.VOICE.put(note, JSON.stringify(st));
  }
  if (st.parts.length < total) return false;
  await up.complete(st.parts); await env.VOICE.delete(note); return true;
}
async function voiceFile(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Not allowed.');
  const f = voiceSource(url.pathname);
  if (!f) return fail(404, 'Not found.');
  if (!env.VOICE) return fail(503, 'The offline voice is not set up on this site.');
  let head = await env.VOICE.head(f.key);
  if (!head) { const job = voiceCopy(env, f); ctx.waitUntil(job.catch(() => {})); let whole = false;
    try { whole = await job; } catch (e) { console.log('voice: ' + f.key + ': ' + String(e && e.message || e)); return fail(502, 'That file could not be fetched just now. Try again. (' + String(e && e.message || e).slice(0, 120) + ')'); }
    if (!whole) return json({ file: f.key, copying: true, error: 'This file is still being prepared. Try again in a minute.' }, 503, { 'Retry-After': '20' });
    head = await env.VOICE.head(f.key); }
  if (!head) return fail(502, 'That file could not be kept. Try again.');
  if (url.searchParams.has('check')) return json({ file: f.key, bytes: head.size });
  const headers = { 'Content-Type': f.type, 'Content-Length': String(head.size), 'Cache-Control': 'public, max-age=31536000, immutable', ETag: head.httpEtag };
  if (request.method === 'HEAD') return new Response(null, { headers });
  const obj = await env.VOICE.get(f.key);
  return obj ? new Response(obj.body, { headers }) : fail(502, 'That file could not be read. Try again.');
}
async function runAI(env, user, { input, tier, provider, account, chat, job, avoid, strict, gov }) {
  tier = tier === 'quick' ? 'quick' : 'default';
  const rawJob = job;
  job = JOB[job] ? job : chat ? 'chat' : 'lesson';   // a request that does not say is held to the highest bar
  let messages = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
  messages = messages.slice(-40).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: typeof (m && m.content) === 'string' ? m.content.slice(0, 150000) : '' })).filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return { status: 400, error: 'Nothing to answer.' };
  const H = await hierarchy(env), who = TIER_NAME[H.jobs[job]].toLowerCase();
  const G = govDims({ job, rawJob, chat, head: messages[0].content, gov });   // USAP AI governance labels only (src/aigov.js)
  let order = route(env, H, job, provider, str(avoid, 20).toLowerCase());
  /* A lesson job is bound to the model chosen when it was queued: `strict` asks that one service only, so a lesson never changes writer
     part-way (the hierarchy above still decides whether that service may do the job at all). */
  if (strict && provider && order.includes(provider)) order = [provider];
  if (!order.length) return { status: 503, error: job === 'chat' ? 'No AI is set up on this site yet.' : `"${JOB[job].name}" needs a service in the ${who} tier or above, and none is set up on this site yet. The owner adds a key in Cloudflare or changes the tiers on the account page.` };
  const want = JOB[job].pick && order.includes(provider) ? provider : '', used = await aiUsed(env, user.id), notes = []; let capped = 0;
  for (const id of order) {
    const cap = aiCap(env, id);
    if ((used[id] || 0) >= cap) { capped++; notes.push(`${PNAME[id]} has used today's ${cap} requests for your account`); continue; }
    let out = { text: '', model: '' };
    try { out = await usap.timeAI(() => SERVICE[id].run(env, messages, tier, account ? accountTools(env, user) : null), { provider: id, job, fell_back: notes.length ? 1 : 0, ...G }); }   // USAP: timing and counts only (owner go-ahead 2026-10-24); the order is unchanged
    catch (e) { console.error(e); notes.push(PNAME[id] + (e.busy ? ' is over its limit right now' : ' did not answer') + (isOwner(env, user) ? ' [' + String(e && e.message || e).slice(0, 300) + ']' : '')); continue; }
    if (!out.text) { notes.push(PNAME[id] + ' did not answer'); continue; }
    await env.DB.prepare('INSERT INTO ai_usage (user_id, day, provider, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, provider) DO UPDATE SET n = n + 1').bind(user.id, today(), id).run();
    used[id] = (used[id] || 0) + 1;
    usap.emitMetric('ai_quota_utilization', used[id] / cap, { provider: id, job });   // USAP: share of today's allowance used
    return { status: 200, text: out.text, model: out.model, provider: id, name: PNAME[id], job, asked: want || 'auto', fellBack: notes.length > 0, note: notes.join('; '), left: cap - used[id], providers: aiList(env, used, H) };
  }
  const only = job === 'chat' ? '' : ` "${JOB[job].name}" is done only by: ${order.map(id => PNAME[id]).join(', ')}.`;
  return capped === notes.length ? { status: 429, error: notes.join('; ') + '. Allowances reset at midnight UTC.' + only } : { status: 502, error: 'The AI could not answer just now (' + notes.join('; ') + ').' + only + ' Try again in a moment.' };
}

/* ---------- Google Drive ----------
   Inside Claude the app reads the physician's Google Drive through Claude's own connector. The website has no such connector, so this
   server holds one Google credential and reaches exactly two folders with it:
     DRIVE_KNOWLEDGE_FOLDER   the reference library (board syllabus, guidelines, blueprints, the sources registry). Read only, for the
                              accounts named in LIBRARY_EMAILS (comma separated; * for every account). Every file asked for is checked
                              to sit inside this folder before a byte of it is read, whatever else the credential could open.
     DRIVE_ACCOUNTS_FOLDER    one subfolder per account, written by this server alone (see "Account folders" below).
   The credential is either the owner's own Google account, connected once on the account page (GOOGLE_OAUTH_CLIENT_ID and
   GOOGLE_OAUTH_CLIENT_SECRET; the token is kept encrypted in D1), or a service account key (GOOGLE_SERVICE_ACCOUNT). Google does not
   let a service account keep files in a personal Drive, so a service account can read the library but cannot write account folders
   unless the folders are in a shared drive. Library text is read when a lesson needs it and held in memory for a few minutes. */
const KNOW = env => str(env.DRIVE_KNOWLEDGE_FOLDER, 200), ACCTS = env => str(env.DRIVE_ACCOUNTS_FOLDER, 200);
const isOwner = (env, user) => !!env.OWNER_EMAIL && !!user && String(env.OWNER_EMAIL).trim().toLowerCase() === String(user.email).toLowerCase();
const setting = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const setSetting = (env, k, v) => v == null ? env.DB.prepare('DELETE FROM settings WHERE k = ?').bind(k).run()
  : env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
const unhex = h => Uint8Array.from(String(h).match(/../g) || [], x => parseInt(x, 16));
const sealKey = async env => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('dcc-drive:' + env.GOOGLE_OAUTH_CLIENT_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); return hex(iv) + ':' + hex(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), enc.encode(text))); }
async function unseal(env, sealed) { const [iv, data] = String(sealed || '').split(':'); try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv) }, await sealKey(env), unhex(data))); } catch { return ''; } }

/* Which Google credential this site is using right now: 'oauth' (the owner's account), 'service' (a service account key) or none. */
let DRIVE = { t: 0, mode: '', email: '' }, gToken = null;
async function driveState(env, fresh) {
  if (!fresh && Date.now() - DRIVE.t < 30000) return DRIVE;
  let mode = '', email = '';
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    const { results } = await env.DB.prepare("SELECT k, v FROM settings WHERE k IN ('google_refresh', 'google_email')").all(), m = Object.fromEntries(results.map(r => [r.k, r.v]));
    if (m.google_refresh) { mode = 'oauth'; email = m.google_email || ''; }
  }
  if (!mode && env.GOOGLE_SERVICE_ACCOUNT) { mode = 'service'; try { email = String(JSON.parse(env.GOOGLE_SERVICE_ACCOUNT).client_email || ''); } catch { } }
  if (gToken && gToken.mode !== mode) gToken = null;
  return DRIVE = { t: Date.now(), mode, email };
}
const libraryOn = (env, user) => { if (!DRIVE.mode || !KNOW(env)) return false; const list = String(env.LIBRARY_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean); return list.includes('*') || list.includes(String(user.email).toLowerCase()); };
/* Why the library is off for an account, in words the owner can act on. Nothing secret is given away: only whether each setting is there. */
const libraryWhy = (env, user) => { if (libraryOn(env, user)) return '';
  if (!DRIVE.mode) return 'Google Drive is not connected to this site yet. The owner connects it on the account page.';
  if (!KNOW(env)) return 'The DRIVE_KNOWLEDGE_FOLDER setting is missing on the server.';
  if (!env.LIBRARY_EMAILS) return 'The LIBRARY_EMAILS secret is not set on the server. Add it as type Secret with the value ' + user.email + ' (or * for every account), then deploy.';
  return 'LIBRARY_EMAILS is set, but it does not list this account (' + user.email + ').'; };
const libraryEmail = () => DRIVE.email;
class LibError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
async function googleToken(env) {
  if (gToken && gToken.exp > Date.now() + 60000) return gToken.token;
  const mode = (await driveState(env)).mode;
  if (!mode) throw new LibError('Google Drive is not connected to this site yet.', 503);
  let j = {}, ok = false;
  if (mode === 'oauth') {
    const refresh = await unseal(env, await setting(env, 'google_refresh'));
    if (!refresh) throw new LibError('The saved Google connection could not be read. The owner needs to connect Google Drive again on the account page.', 503);
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: refresh }) });
    j = await r.json().catch(() => ({})); ok = r.ok && !!j.access_token;
    if (!ok) throw new LibError(j.error === 'invalid_grant' ? 'Google has ended this site\'s access to Drive. The owner needs to connect Google Drive again on the account page.' : 'Google did not renew this site\'s access to Drive (' + (j.error_description || j.error || r.status) + ').', 503);
  } else {
    let key; try { key = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { throw new LibError('The Google key saved in Cloudflare could not be read. Paste the whole contents of the key file as the GOOGLE_SERVICE_ACCOUNT secret.'); }
    if (!key || !key.client_email || !key.private_key) throw new LibError('The Google key saved in Cloudflare is missing its email or private key. Paste the whole contents of the key file.');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.' + b64u(enc.encode(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
    let signer;
    try { signer = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(String(key.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']); }
    catch { throw new LibError('The private key in the Google key file could not be used. Make a new JSON key for the service account and save it again.'); }
    const assertion = unsigned + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, enc.encode(unsigned)));
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + assertion });
    j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new LibError('Google did not accept the service account key (' + (j.error_description || j.error || r.status) + ').');
  }
  gToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, mode };
  return gToken.token;
}
/* Is this file or folder inside `root`? Walks up the parents, remembering each step for ten minutes. */
const parentOf = new Map();
async function inside(env, id, root) {
  if (!root) return false;
  for (let i = 0, cur = id; i < 30 && cur; i++) {
    if (cur === root) return true;
    let hit = parentOf.get(cur);
    if (!hit || Date.now() - hit.t > 6e5) {
      let p = '';
      try { p = ((await (await gfetch(env, 'files/' + cur, { fields: 'id,parents' })).json()).parents || [])[0] || ''; }
      catch (e) { if (!(e instanceof LibError) || (e.status !== 404 && !e.google)) throw e; }
      hit = { p, t: Date.now() }; parentOf.set(cur, hit); if (parentOf.size > 4000) parentOf.delete(parentOf.keys().next().value);
    }
    cur = hit.p;
  }
  return false;
}
async function inLibrary(env, id) {
  if (!KNOW(env)) throw new LibError('The DRIVE_KNOWLEDGE_FOLDER setting is missing on the server.', 503);
  if (!await inside(env, id, KNOW(env))) throw new LibError('That file is not in the reference library.', 404);
}
async function gfetch(env, path, params) {
  const u = new URL('https://www.googleapis.com/drive/v3/' + path); Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== '') u.searchParams.set(k, v); });
  u.searchParams.set('supportsAllDrives', 'true');
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + await googleToken(env) } });
  if (r.ok) return r;
  const j = await r.json().catch(() => ({})), why = (j.error && (j.error.message || j.error.status)) || r.status;
  if (r.status === 404) throw new LibError('That file is not in the folders shared with this website.', 404);
  if (r.status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(String(why))) throw new LibError('The Google Drive API is not turned on for the Google Cloud project that owns the service account.');
  const e = new LibError('Google Drive refused the request (' + why + ').'); e.google = r.status; e.reason = String(why); throw e;
}
/* The app writes its searches the way Claude's Drive connector takes them (title, parentId); Google's own API says name and parents. */
const driveQuery = q => '(' + String(q).replace(/\btitle\s+(contains|=|!=)/g, 'name $1').replace(/\bparentId\s*=\s*'([^']+)'/g, "'$1' in parents") + ') and trashed = false';
const GDOC = 'application/vnd.google-apps.document';
const chapters = new Map();
const tidyMarkdown = t => String(t).replace(/^\[[^\]\n]+\]:\s*<data:[^>\n]*>\s*$/gm, '').replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, '').replace(/!\[[^\]\n]*\]\(data:[^)\n]*\)/g, '').replace(/\n{3,}/g, '\n\n');
async function driveTool(env, tool, input, opt = {}) {
  input = input && typeof input === 'object' ? input : {};
  if (tool === 'search_files') {
    const q = str(input.query, 600); if (!q) throw new LibError('Nothing to search for.', 400);
    const j = await (await gfetch(env, 'files', { q: driveQuery(q), pageSize: Math.max(1, Math.min(100, Number(input.pageSize) || 20)), pageToken: str(input.pageToken, 2000), fields: 'nextPageToken,files(id,name,mimeType,parents,size)', includeItemsFromAllDrives: 'true' })).json();
    /* Google answers from everything the credential can see. Only what sits inside the knowledge folder is passed on. */
    const kept = []; for (const f of j.files || []) { if (f.id === KNOW(env) || await inside(env, (f.parents || [])[0], KNOW(env))) kept.push(f); }
    return { files: kept.map(f => ({ id: f.id, title: f.name, mimeType: f.mimeType, parentId: (f.parents || [])[0] || '', fileSize: f.size || '' })), nextPageToken: j.nextPageToken || undefined };
  }
  const id = str(input.fileId, 200); if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new LibError('Bad file.', 400);
  await inLibrary(env, id);
  if (tool === 'read_file_content') {
    const hit = chapters.get(id); if (hit && Date.now() - hit.t < 6e5) return hit.v;
    const meta = await (await gfetch(env, 'files/' + id, { fields: 'id,name,mimeType,size' })).json();
    let text = '';
    if (meta.mimeType === GDOC) {
      /* A chapter heavy with pictures can be over Google's export limit as markdown; plain text has no pictures and always fits. */
      try { text = tidyMarkdown(await (await gfetch(env, 'files/' + id + '/export', { mimeType: 'text/markdown' })).text()); }
      catch (e) { if (e.status === 404) throw e; text = await (await gfetch(env, 'files/' + id + '/export', { mimeType: 'text/plain' })).text(); }
    } else if (/^text\/|json/.test(meta.mimeType || '')) { text = await (await gfetch(env, 'files/' + id, { alt: 'media' })).text();
    } else {
      if (Number(meta.size) > 25e6) throw new LibError('That file is too large to read on the website. Split it into chapters, or keep it as Google Docs.', 413);
      if (!env.AI || !env.AI.toMarkdown) throw new LibError('Only Google Docs and text files can be read on this website.', 415);
      const blob = await (await gfetch(env, 'files/' + id, { alt: 'media' })).blob();
      const out = await usap.timeAI(() => env.AI.toMarkdown([{ name: meta.name || 'file', blob: new Blob([blob], { type: meta.mimeType || 'application/octet-stream' }) }]), { provider: 'cloudflare', job: 'to_markdown', ...govOf('doc_to_markdown', { user_initiated: opt.bg ? 0 : 1, route: opt.bg ? 'mkos:read_text' : 'library:read_file_content' }) });   // USAP: timing only
      const one = Array.isArray(out) ? out[0] : out; text = tidyMarkdown((one && one.data) || '');
      if (!text.trim()) throw new LibError('That file could not be read as text on the website.', 415);
    }
    const v = { fileContent: text.slice(0, 1500000), title: meta.name || '' };
    chapters.set(id, { t: Date.now(), v }); if (chapters.size > 40) chapters.delete(chapters.keys().next().value);
    return v;
  }
  if (tool === 'download_file_content') {
    const meta = await (await gfetch(env, 'files/' + id, { fields: 'id,name,mimeType' })).json();
    if (meta.mimeType !== GDOC) return { html: '', title: meta.name || '' };
    return { html: await (await gfetch(env, 'files/' + id + '/export', { mimeType: 'text/html' })).text(), title: meta.name || '' };
  }
  throw new LibError('Unknown library request.', 400);
}
/* The file itself, for the app's own PDF reader, which runs in the browser. The website streams the whole file. The connector inside
   Claude can only pass text, and not much at a time, so it asks for the file one slice at a time. */
const fileId = v => { const id = str(v, 200); if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) throw new LibError('Bad file.', 400); return id; };
async function driveBytes(env, id, range) {
  await inLibrary(env, id);
  const u = new URL('https://www.googleapis.com/drive/v3/files/' + id); u.searchParams.set('alt', 'media'); u.searchParams.set('supportsAllDrives', 'true');
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + await googleToken(env), ...(range ? { Range: range } : {}) } });
  if (r.status === 404) throw new LibError('That file is not in the folders shared with this website.', 404);
  if (r.status === 416) throw new LibError('Past the end of the file.', 416);
  if (!r.ok) throw new LibError('Google Drive refused the download (' + r.status + '). Google Docs are read as text, not downloaded.', r.status === 403 ? 403 : 502);
  return r;
}
const SLICE = 720000;
async function driveSlice(env, id, offset) {
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  await inLibrary(env, id);
  const meta = await (await gfetch(env, 'files/' + id, { fields: 'id,name,mimeType,size' })).json(), size = Number(meta.size) || 0;
  if (!size) throw new LibError('That file has no downloadable content.', 415);
  if (size > 60e6) throw new LibError('That file is too large to read in the app.', 413);
  if (offset >= size) return { size, offset, length: 0, data: '', done: true };
  const end = Math.min(size, offset + SLICE) - 1, bytes = new Uint8Array(await (await driveBytes(env, id, 'bytes=' + offset + '-' + end)).arrayBuffer());
  let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { size, offset, length: bytes.length, data: btoa(bin), done: offset + bytes.length >= size, title: meta.name || '', mimeType: meta.mimeType || '' };
}

/* ---------- Account folders in Google Drive ----------
   Inside DRIVE_ACCOUNTS_FOLDER every account gets one subfolder, made the moment the account is created:
     acct-<first 12 characters of the account's random id>/
       account.json          the account's id and the day it was made: no name, no email, no password, no login tokens
       records/              one file per record, e.g. med__state.json for med/state: the same documents the app saves
       backups/              backup-YYYY-MM-DD.json, the whole record on each day something changed (the newest 14 are kept)
   Nothing in a folder's name or its account.json says whose it is. Which person an id belongs to is known only to the database
   (the owner's accounts list on the account page shows it). The records themselves are the study record, which can hold what
   the user typed about themselves.
   D1 is the copy the app reads and writes, so it stays fast and works when Google is slow. Each save is copied to Drive straight
   after the reply is sent, and a timer every five minutes copies whatever is still waiting.
   Isolation: every function here takes the account id the server worked out for itself and looks the folder up in that account's
   own drive_accounts row. No request carries a folder or file id for this part of Drive, except a backup to download, and that one
   is checked to sit in the caller's own backups folder first.
   USAP ADF (src/adf.js): once per account, from the timer, the standard subfolders are made inside the account folder (backups/ is
   reused) and metadata_registry.json registers account.json and the record files where they are. Nothing is moved or renamed and
   the copy job above is unchanged; drive_accounts.adf records that it was done. */
const FOLDER = 'application/vnd.google-apps.folder', LEASE = 90000, KEEP_BACKUPS = 14, LAYOUT = 2;
const folderName = id => 'acct-' + id.slice(0, 12);
function gfail(r, j) {
  const why = String((j && j.error && (j.error.message || j.error.status)) || r.status);
  if (/storage quota|storageQuotaExceeded/i.test(why + JSON.stringify((j && j.error && j.error.errors) || ''))) return new LibError('Google does not let a service account keep files in a personal Drive. The owner needs to connect their own Google account on the account page.', 507);
  if (r.status === 403 || r.status === 404) return new LibError('This site cannot write to the accounts folder in Drive (' + why + '). Check that the connected Google account can edit it.', 502);
  return new LibError('Google Drive refused the save (' + why + ').', 502);
}
async function gsend(env, method, path, body) {
  const r = await fetch('https://www.googleapis.com/drive/v3/' + path + (path.includes('?') ? '&' : '?') + 'supportsAllDrives=true&fields=id', { method, headers: { Authorization: 'Bearer ' + await googleToken(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = gfail(r, j); e.gone = r.status === 404; throw e; }
  return j.id;
}
const mkdir = (env, name, parent, props) => gsend(env, 'POST', 'files', { name, mimeType: FOLDER, parents: [parent], ...(props ? { appProperties: props } : {}) });
const trash = (env, id) => gsend(env, 'PATCH', 'files/' + id, { trashed: true }).catch(e => { if (!e.gone) throw e; });
/* Write one file: a new one in `parent`, or new contents for the file `id`. */
async function gupload(env, { id, name, parent, text, props, mime, full }) {
  const type = mime || 'application/json', meta = id ? {} : { name, parents: [parent], mimeType: type, ...(props ? { appProperties: props } : {}) }, bytes = enc.encode(text);
  const base = 'https://www.googleapis.com/upload/drive/v3/files' + (id ? '/' + id : ''), auth = 'Bearer ' + await googleToken(env), method = id ? 'PATCH' : 'POST';
  let r;
  if (bytes.length < 4e6) {
    const b = 'dcc' + rand(12);
    r = await fetch(base + '?uploadType=multipart&supportsAllDrives=true&fields=' + (full ? 'id,size,md5Checksum' : 'id'), { method, headers: { Authorization: auth, 'Content-Type': 'multipart/related; boundary=' + b },
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n${text}\r\n--${b}--` });
  } else {
    const start = await fetch(base + '?uploadType=resumable&supportsAllDrives=true&fields=' + (full ? 'id,size,md5Checksum' : 'id'), { method, headers: { Authorization: auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type }, body: JSON.stringify(meta) });
    const to = start.headers.get('Location'); if (!start.ok || !to) { const e = gfail(start, await start.json().catch(() => ({}))); e.gone = start.status === 404; throw e; }
    r = await fetch(to, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });
  }
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.id) { const e = gfail(r, j); e.gone = r.status === 404; throw e; }
  /* `full`: Drive's own record of what it stored (size and MD5), so canonical storage can confirm each write (src/mkos/mirror.js). */
  return full ? { id: j.id, size: j.size ?? null, md5: j.md5Checksum || null } : j.id;
}
const storeOn = env => !!DRIVE.mode && !!ACCTS(env);
const fileName = path => path.replace(/\//g, '__') + '.json';
/* Central registry records ('_central') are not an account: MKOS persists them to the Central Registry Data folder instead. */
const DIRTY = "FROM docs d LEFT JOIN drive_docs x ON x.user_id = d.user_id AND x.path = d.path WHERE (x.synced IS NULL OR x.synced != d.updated) AND d.user_id != '_central'";
/* Copy one account's waiting records into its own Drive folder. `B.n` is how many Google requests this run may still make. */
async function syncUser(env, uid, B) {
  if (!storeOn(env)) return { on: false };
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO drive_accounts (user_id, lease) VALUES (?, 0)').bind(uid).run();
  let row = await env.DB.prepare('UPDATE drive_accounts SET lease = ? WHERE user_id = ? AND lease < ? RETURNING *').bind(now, uid, now - LEASE).first();
  if (!row) return { on: true, busy: true };
  let error = '';
  try {
    const u = await env.DB.prepare('SELECT id, email, first, last, created FROM users WHERE id = ?').bind(uid).first();
    if (!u) return { on: true };
    const set = async (col, val) => { await env.DB.prepare(`UPDATE drive_accounts SET ${col} = ? WHERE user_id = ?`).bind(val, uid).run(); row[col] = val; };
    const about = () => JSON.stringify({ app: 'doctor-career-companion', accountId: u.id, created: String(u.created).slice(0, 10), written: new Date().toISOString() }, null, 1);
    if (!row.folder) { B.n--; await set('folder', await mkdir(env, folderName(u.id), ACCTS(env), { dccAccount: u.id })); await set('v', LAYOUT); }
    /* A folder made before names were taken out: rename it, rewrite its account file, and replace its backups, which carried the email. */
    if (row.folder && (row.v || 0) < LAYOUT && row.records && row.backups && row.profile) {
      B.n -= 3; await gsend(env, 'PATCH', 'files/' + row.folder, { name: folderName(u.id) }); await gupload(env, { id: row.profile, text: about() });
      const old = (await (await gfetch(env, 'files', { q: `'${row.backups}' in parents and trashed = false`, pageSize: 100, fields: 'files(id)' })).json()).files || [];
      for (const f of old) { B.n--; await trash(env, f.id); }
      await set('backup_day', null); await set('v', LAYOUT);
    }
    if (!row.records) { B.n--; await set('records', await mkdir(env, 'records', row.folder)); }
    if (!row.backups) { B.n--; await set('backups', await mkdir(env, 'backups', row.folder)); }
    if (!row.profile) { B.n--; await set('profile', await gupload(env, { name: 'account.json', parent: row.folder, text: about() })); }
    /* Records changed since they were last copied. */
    const { results: dirty } = await env.DB.prepare('SELECT d.path, d.body, d.updated, x.file_id ' + DIRTY + ' AND d.user_id = ? LIMIT ?').bind(uid, Math.max(0, B.n - 2)).all();
    for (const d of dirty) {
      if (B.n <= 2) break;
      let id = d.file_id || '';
      if (id) { B.n--; try { await gupload(env, { id, text: d.body }); } catch (e) { if (!e.gone) throw e; id = ''; } }   // the file was removed by hand in Drive: write it again
      if (!id) { B.n--; id = await gupload(env, { name: fileName(d.path), parent: row.records, text: d.body, props: { dccAccount: u.id, dccPath: d.path } }); }
      await env.DB.prepare('INSERT INTO drive_docs (user_id, path, file_id, synced) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET file_id = excluded.file_id, synced = excluded.synced').bind(uid, d.path, id, d.updated).run();
    }
    /* Records deleted in the app go to the Drive trash, where Google keeps them for 30 days. */
    const { results: gone } = await env.DB.prepare('SELECT x.path, x.file_id FROM drive_docs x LEFT JOIN docs d ON d.user_id = x.user_id AND d.path = x.path WHERE x.user_id = ? AND d.path IS NULL LIMIT ?').bind(uid, Math.max(0, Math.min(10, B.n - 2))).all();
    for (const g of gone) { if (B.n <= 2) break; B.n--; await trash(env, g.file_id); await env.DB.prepare('DELETE FROM drive_docs WHERE user_id = ? AND path = ?').bind(uid, g.path).run(); }
    /* A dated backup of the whole record, once for each day something changed. */
    const last = await env.DB.prepare('SELECT MAX(updated) AS t, COUNT(*) AS n FROM docs WHERE user_id = ?').bind(uid).first(), day = String((last && last.t) || '').slice(0, 10);
    if (B.n > 4 && last && last.n && day && day !== row.backup_day) {
      const { results } = await env.DB.prepare('SELECT path, body FROM docs WHERE user_id = ?').bind(uid).all();
      const text = '{"app":"doctor-career-companion","accountId":' + JSON.stringify(u.id) + ',"saved":' + JSON.stringify(new Date().toISOString()) + ',"docs":{' + results.map(r => JSON.stringify(r.path) + ':' + r.body).join(',') + '}}';
      B.n -= 3; await gupload(env, { name: 'backup-' + day + '.json', parent: row.backups, text, props: { dccAccount: u.id } });
      await gupload(env, { id: row.profile, text: about() }).catch(() => { });
      await set('backup_day', day);
      const old = (await (await gfetch(env, 'files', { q: `'${row.backups}' in parents and trashed = false`, orderBy: 'name desc', pageSize: 100, fields: 'files(id,name)' })).json()).files || [];
      for (const f of old.slice(KEEP_BACKUPS)) { if (B.n <= 1) break; B.n--; await trash(env, f.id); }
    }
  } catch (e) { error = e instanceof LibError ? e.message : 'Google Drive could not be reached.'; console.error('drive copy failed for ' + uid, e); }
  finally {
    await env.DB.prepare('UPDATE drive_accounts SET lease = 0, error = ?, synced = ? WHERE user_id = ?').bind(error, error ? row.synced : new Date().toISOString(), uid).run();
    usap.emitMetric('drive_sync_success_rate', error ? 0 : 1, { store: 'drive' });   // USAP: 1 copied, 0 failed
  }
  return { on: true, error };
}
const syncSoon = (env, ctx, uid) => { if (ctx && storeOn(env)) ctx.waitUntil(syncUser(env, uid, { n: 14 }).catch(e => console.error(e))); };
/* How much of one account's record is in Drive. */
async function storage(env, user) {
  const row = await env.DB.prepare('SELECT folder, backup_day, synced, error FROM drive_accounts WHERE user_id = ?').bind(user.id).first();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE user_id = ?').bind(user.id).first(), w = await env.DB.prepare('SELECT COUNT(*) AS n ' + DIRTY + ' AND d.user_id = ?').bind(user.id).first();
  return { on: storeOn(env), mode: DRIVE.mode, records: (n && n.n) || 0, waiting: (w && w.n) || 0, folder: !!(row && row.folder), synced: (row && row.synced) || '', backupDay: (row && row.backup_day) || '', error: (row && row.error) || '',
    url: row && row.folder && isOwner(env, user) ? 'https://drive.google.com/drive/folders/' + row.folder : '' };
}
/* The timer: accounts with records waiting, then accounts due a backup. */
async function sweep(env) {
  await init(env); await driveState(env); if (!storeOn(env)) return 0;
  const B = { n: 34 }, ids = new Set();
  (await env.DB.prepare('SELECT DISTINCT d.user_id AS id ' + DIRTY + ' LIMIT 4').all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare('SELECT u.id FROM users u LEFT JOIN drive_accounts a ON a.user_id = u.id WHERE a.profile IS NULL LIMIT 3').all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare("SELECT DISTINCT x.user_id AS id FROM drive_docs x LEFT JOIN docs d ON d.user_id = x.user_id AND d.path = x.path WHERE d.path IS NULL LIMIT 2").all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare("SELECT a.user_id AS id FROM drive_accounts a WHERE a.folder IS NOT NULL AND EXISTS (SELECT 1 FROM docs d WHERE d.user_id = a.user_id AND substr(d.updated, 1, 10) > COALESCE(a.backup_day, '')) LIMIT 2").all()).results.forEach(r => ids.add(r.id));
  for (const id of ids) { if (B.n <= 6) break; await syncUser(env, id, B); }
  return 34 - B.n;   // Google requests this run spent
}
/* ADF: the app's Drive helpers as the module's adapter (account folders only). */
const adfDrive = env => driveAdapter({
  list: async query => ((await (await gfetch(env, 'files', { q: query, pageSize: 100, fields: 'files(id,name)' })).json()).files || []),
  mkdir: (name, parent) => mkdir(env, name, parent),
  upload: o => gupload(env, { ...o, full: true }),
  read: async id => await (await gfetch(env, 'files/' + id, { alt: 'media' })).text(),
});
/* ADF: one account folder a run gets its standard layout and registry, once (drive_accounts.adf), under the copy job's lease. */
async function adfTick(env) {
  if (!storeOn(env)) return null;
  const now = Date.now(), DB = env.DB;
  return adfOnce({
    next: async () => { const r = await DB.prepare('SELECT user_id, folder, profile FROM drive_accounts WHERE folder IS NOT NULL AND profile IS NOT NULL AND records IS NOT NULL AND backups IS NOT NULL AND v >= ? AND adf IS NULL AND lease < ? LIMIT 1').bind(LAYOUT, now - LEASE).first();
      return r ? { uid: r.user_id, folderId: r.folder, name: folderName(r.user_id), profileId: r.profile } : null; },
    take: async uid => !!await DB.prepare('UPDATE drive_accounts SET lease = ? WHERE user_id = ? AND lease < ? RETURNING user_id').bind(now, uid, now - LEASE).first(),
    records: async uid => (await DB.prepare('SELECT path, file_id FROM drive_docs WHERE user_id = ?').bind(uid).all()).results,
    done: uid => DB.prepare('UPDATE drive_accounts SET adf = ? WHERE user_id = ?').bind(new Date().toISOString(), uid).run(),
    release: uid => DB.prepare('UPDATE drive_accounts SET lease = 0 WHERE user_id = ?').bind(uid).run(),
  }, adfDrive(env));
}
const adfTickSafe = env => adfTick(env).catch(e => { console.error('adf', e); return null; });

/* ---------- The privacy policy and terms of service ----------
   Both pages are plain text that the owner can rewrite on the account page. The words below are the starting versions; an edited
   version is kept in D1 (settings, page_privacy and page_terms) and shown instead. The text uses a few simple marks:
     ## Heading        starts a new section          - item        a bullet
     **bold**          bold words                    [words](https://address)   a link
   A blank line starts a new paragraph. Everything else is shown exactly as typed; HTML is not interpreted. */
const PAGE_DATE = 'October 10, 2026';
const PAGES = {
  privacy: { title: 'Privacy policy', text: `## What this is
Doctor Career Companion is a study and career development app for physicians. It is an independent personal project, offered by invitation to colleagues. This page says what the app keeps about you, where it goes, and how to remove it.

The app is for study. Do not enter patient information into it.

## Where lesson content comes from
Lessons, questions and flashcards draw on a central reference library of published clinical practice guidelines from professional societies and board study resources. The library is updated regularly so that content is informed by current, authoritative sources. Each lesson names the sources it used and flags anything that should be verified.

## What the app keeps
- **Your account:** first name, last name, the email address you sign up with, and your password. The password is stored only as a salted hash and cannot be read back.
- **Your study record:** the lessons, questions, flashcards and plans written for you, your answers and ratings, time spent, the questions you ask the study companion, your settings, and any exam report or blueprint you upload.
- **Usage counts:** how many AI requests your account has made each day, to apply the daily allowance.

The app sets one cookie, which keeps you logged in. It has no advertising and no analytics or tracking tools.

## Where it is kept
- **Cloudflare.** The site runs on Cloudflare, and your account and study record are stored in its database.
- **Google Drive.** A copy of your study record, with dated backups, is kept in private Google Drive storage that the app uses. Each account's data is stored in its own folder under a de-identified naming convention: the folder is labelled with a randomly generated account code, and neither the folder nor its files are labelled with your name or email address. Your password and login tokens are never copied there. The study record inside is the same one you see in the app, so it includes anything you typed about yourself. The person who runs the app can access this storage; other users cannot reach it.
- **Your browser.** The app keeps a copy of your record and a few preferences on your device so it opens quickly and works briefly offline.

## AI services
Lessons, questions, reviews and chat answers are written by outside AI services. When you ask for one, the text of that request is sent to the service that answers it. A request can include the topic, reference text, a summary of your progress, your question and, in the Ask panel, parts of your own study record. Your password is never sent.

The services in use are Google Gemini, DeepSeek, Cloudflare Workers AI and, when enabled, Anthropic Claude. DeepSeek is operated from China. Each service handles what it receives under its own terms and privacy policy. The app never gives an AI service access to another user's record.

## How Google account data is used
The app uses a single Google account, set up by the person who runs it, for its Google Drive storage. Users of the app are not asked to sign in with Google, and the app does not access any user's Google account.

With that one connection the app does two things only: it reads the reference library in a single Drive folder to ground lessons, and it creates and updates each account's own folder of study records in a second Drive folder. It does not read, change or delete anything else in the connected Drive.

The app's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Data obtained through Google Drive is not sold, not used for advertising, and not used to train general-purpose AI models. Reference text is passed to an AI service only to write the lesson or answer that a user asked for.

## Sharing
Your information is not sold or shared for marketing. It goes only to the services named above, to run the app, and would be disclosed otherwise only if the law required it.

## Your choices
- **Download:** the account page and the History tab give you a backup file of your whole record.
- **Delete:** "Delete account" on the account page removes your account and study record from the database at once and moves your folder in Drive to the trash, where Google removes it after about 30 days.
- **Ask:** write to the contact below to see, correct or remove anything held about you.

## Security, age and changes
The site is served over HTTPS, passwords are hashed, and the Google connection is stored encrypted. No system is perfectly secure, so keep your own backup of anything you would not want to lose.

The app is intended for adult medical professionals and trainees, not for children.

If this policy changes, the date at the top changes with it.

## Contact
Questions or requests: [tpasqua3@gmail.com](mailto:tpasqua3@gmail.com)` },
  terms: { title: 'Terms of service', text: `## The short version
Doctor Career Companion is a study aid for physicians, run as an independent personal project and offered by invitation. Its lessons and questions are written by AI and can be wrong. It is not medical advice and must not be used to make decisions about a patient. By creating an account you agree to these terms.

## For education only
- The app is for study, board preparation and career planning. It does not give medical advice, and nothing in it replaces current guidelines, the primary literature, your institution's policies or your own clinical judgment.
- Content draws on a central reference library of published clinical practice guidelines and board study resources that is updated regularly. It is written by AI services and checked by a second AI pass, which reduces errors but does not remove them. Thresholds, doses, recommendations and citations can be wrong or out of date. Verify anything you intend to rely on.
- The app is not affiliated with or endorsed by the American Board of Internal Medicine, the American College of Physicians or any professional society. Using it does not guarantee any exam result.
- Do not enter patient information or anything that could identify a patient.

## Your account
- Accounts are for the adult medical professionals and trainees who were invited. Use your own account and keep your password and connector link private.
- You are responsible for what is done through your account.
- Each account has a daily allowance of AI requests, which may change.

## Acceptable use
Do not try to reach another account's data, get around the app's limits, overload or probe the service, use automated tools to extract its content, or use it for anything unlawful.

## Content
- Your study record is yours. You can download it or delete it at any time from the account page.
- Some lessons draw on reference material that is licensed to the person who runs the app or published by professional societies. That material stays the property of its owners. Lessons, questions and cards are for your personal study: do not republish, sell or redistribute them.
- If you upload a file, such as an exam report or a blueprint, you confirm you are allowed to use it this way.

## Availability
This is a personal project, provided free of charge. It may change, pause or stop at any time, features may be added or removed, and an account that breaks these terms may be closed. Keep your own backup of anything you would not want to lose.

## No warranty, limited liability
The app is provided "as is" and "as available", without warranties of any kind, including accuracy, fitness for a particular purpose and uninterrupted service. To the fullest extent the law allows, the person who runs the app is not liable for any loss or harm arising from use of the app or reliance on its content, including clinical decisions, exam results or lost data.

## Privacy, changes and law
How your information is handled is set out in the [privacy policy](/privacy.html).

If these terms change, the date at the top changes with them, and continuing to use the app means you accept the new terms.

These terms are governed by the laws of the State of Georgia, United States.

## Contact
Questions or requests: [tpasqua3@gmail.com](mailto:tpasqua3@gmail.com)` },
};
const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* Bold and links inside one line of already-escaped text. Only web, mail and same-site addresses become links. */
const inlineH = t => escH(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
function pageBody(text) {
  const out = []; let card = null, list = null, para = [];
  const flushP = () => { if (para.length) { card.push('<p>' + para.join(' ') + '</p>'); para = []; } }, flushL = () => { if (list) { card.push('<ul>' + list.join('') + '</ul>'); list = null; } };
  const open = h => { if (card) { flushP(); flushL(); out.push('<div class="card">' + card.join('') + '</div>'); } card = h == null ? null : [h ? '<h2>' + inlineH(h) + '</h2>' : '']; };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const l = raw.trim(); let m;
    if ((m = /^#{1,3}\s+(.*)$/.exec(l))) { open(m[1]); continue; }
    if (!card) { if (!l) continue; open(''); }
    if ((m = /^[-*•]\s+(.*)$/.exec(l))) { flushP(); (list = list || []).push('<li>' + inlineH(m[1]) + '</li>'); continue; }
    if (!l) { flushP(); flushL(); continue; }
    flushL(); para.push(inlineH(l));
  }
  open(null); return out.join('\n');
}
async function pageText(env, name) { const r = await setting(env, 'page_' + name).catch(() => null); let j = null; try { j = r ? JSON.parse(r) : null; } catch { } return j && j.text ? { text: j.text, date: j.date || PAGE_DATE, custom: true } : { text: PAGES[name].text, date: PAGE_DATE, custom: false }; }
async function pageResponse(env, name) {
  await init(env); const p = await pageText(env, name), title = PAGES[name].title;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} · Doctor Career Companion</title>
<link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>:root{--paper:#f2f5f4;--card:#fff;--ink:#12242b;--muted:#55686f;--line:#d5dedc;--cobalt:#0d6e6a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#0c1517;--card:#142023;--ink:#e3ecea;--muted:#93a6a6;--line:#24363a;--cobalt:#5fc9bf;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;padding-top:env(safe-area-inset-top,0px)}
.wrap{max-width:680px;margin:0 auto;padding-inline:16px;padding-block:28px 64px;display:flex;flex-direction:column;gap:16px}
h1,h2{font-family:"IBM Plex Serif",Georgia,serif;margin:0;line-height:1.2}h1{font-size:1.7rem}h2{font-size:1.2rem}p{margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;overflow-wrap:anywhere}
.card ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}.muted{color:var(--muted)}a{color:var(--cobalt)}
.nav{display:flex;gap:16px;flex-wrap:wrap;font-size:.9rem}</style></head><body><div class="wrap">
<div><h1>${title}</h1><p class="muted">Doctor Career Companion · last updated ${escH(p.date)}</p></div>
${pageBody(p.text)}
<div class="nav"><a href="/account.html">Back to the app</a><a href="/privacy.html">Privacy policy</a><a href="/terms.html">Terms of service</a></div>
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

const profile = u => ({ id: u.id, email: u.email, firstName: u.first || '', lastName: u.last || '' });

/* What each area holds, for the account page: how many documents and when they were last saved. */
async function summary(env, uid) {
  const { results } = await env.DB.prepare("SELECT substr(path, 1, instr(path, '/') - 1) AS lang, COUNT(*) AS n, MAX(updated) AS updated FROM docs WHERE user_id = ? GROUP BY lang").bind(uid).all();
  return results;
}

/* ---------- Life OS "Connect" button ----------
   Life OS shows this account's recent activity on its Home screen. Pressing Connect there brings the person here; if they are
   logged in, a private read link for their account is made (the same kind the Claude connector uses, in addition to it) and
   handed straight back to Life OS. The link only ever goes to the Life OS address below. */
const LIFEOS_URL = 'https://life-os.tpasqua3.workers.dev';
async function lifeosConnect(env, user) {
  const home = String(env.LIFEOS_URL || LIFEOS_URL).replace(/\/+$/, ''), head = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (!user) return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in first</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:34ch;padding:24px;text-align:center}h1{font-size:1.4rem;margin:0 0 8px}a{display:inline-block;margin:10px 6px 0;padding:10px 16px;border-radius:8px;border:1px solid;text-decoration:none;color:inherit;font-weight:600}</style><main><h1>Log in to Doctor Career Companion first</h1><p>You are not logged in to Doctor Career Companion in this browser. Log in, then press Connect in Life OS again.</p><a href="/">Log in to Doctor Career Companion</a><a href="${home}/">Back to Life OS</a></main></html>`, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', ...head } });
  const token = rand(32);
  await env.DB.prepare('INSERT INTO links (token_hash, user_id, created) VALUES (?, ?, ?)').bind(await sha(token), user.id, new Date().toISOString()).run();
  return new Response(null, { status: 302, headers: { Location: home + '/#connected=' + token, ...head } });
}

async function api(request, env, url, ctx) {
  const route = request.method + ' ' + url.pathname;
  if (request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return fail(403, 'Cross-site request refused.');
  }
  let body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    const text = await request.text();
    if (text.length > (url.pathname === '/api/doc' || url.pathname === '/api/ai' || url.pathname === '/api/restore' ? MAX_DOC + 200000 : url.pathname === '/api/admin/page' ? 70000 : 20000)) return fail(413, 'That is too large.');
    try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'Bad request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Bad request.');
  }
  await init(env); await driveState(env);

  if (route === 'POST /api/signup') {
    const email = str(body.email, 200).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    const first = str(body.firstName, 60), last = str(body.lastName, 60);
    /* Sign-up can be limited to invited people: set a SIGNUP_CODE secret and only someone who types it can create an account. */
    if (env.SIGNUP_CODE && !same(str(body.code, 100), String(env.SIGNUP_CODE))) return fail(403, 'This site is by invitation. Enter the invitation code you were given.');
    if (!first) return fail(400, 'Enter your first name.');
    if (!EMAIL_OK.test(email)) return fail(400, 'Enter a valid recovery email address.');
    if (!PASSWORD_OK(password)) return fail(400, PASSWORD_RULE);
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) return fail(409, 'An account with that email already exists. Log in instead.');
    const id = rand(16), salt = rand(16);
    await env.DB.prepare('INSERT INTO users (id, email, salt, hash, first, last, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, salt, await hashPassword(password, salt), first, last, new Date().toISOString()).run();
    syncSoon(env, ctx, id);   // the account's own folder in Drive is made now, before anything is saved in it
    return json(profile({ id, email, first, last }), 200, { 'Set-Cookie': await startSession(env, id) });
  }
  if (route === 'POST /api/login') {
    const email = str(body.email, 200).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    const bad = () => fail(401, 'That email and password do not match.');
    if (!u) { await hashPassword(password || 'x', '00000000000000000000000000000000'); return bad(); }
    if (u.locked_until > Date.now()) return fail(429, 'Too many attempts. Try again in a few minutes.');
    if (!same(await hashPassword(password, u.salt), u.hash)) { await strike(env, u); return bad(); }
    await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(u.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
    return json(profile(u), 200, { 'Set-Cookie': await startSession(env, u.id) });
  }

  /* The login screen asks which way a forgotten password is replaced here, so it can show the right form. */
  if (route === 'GET /api/reset/mode') return json({ mode: resetMode(env), email: !!env.RESEND_API_KEY, questions: QUESTIONS });
  /* Forgot password without email, step 1: the recovery questions the account with this email has set (never the answers). */
  if (route === 'POST /api/forgot/questions') {
    if (resetMode(env) !== 'direct') return fail(403, 'Passwords are reset by email on this site.');
    const email = str(body.email, 200).toLowerCase();
    if (!EMAIL_OK.test(email)) return fail(400, 'Enter the email address of your account.');
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (!u) return fail(404, 'No account uses that email address.');
    return json({ questions: (await recoveryOf(env, u.id)).map(r => r.question) });
  }
  /* Step 2: the answer to one of those questions, and the new password. An account with no questions set gives its first and last name. */
  if (route === 'POST /api/forgot/direct') {
    if (resetMode(env) !== 'direct') return fail(403, 'Passwords are reset by email on this site.');
    const email = str(body.email, 200).toLowerCase(), password = body.password;
    if (!EMAIL_OK.test(email)) return fail(400, 'Enter the email address of your account.');
    if (!PASSWORD_OK(password)) return fail(400, PASSWORD_RULE);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!u) { await hashPassword('x', '00000000000000000000000000000000', ANSWER_ROUNDS); return fail(401, 'Those details do not match an account.'); }
    if (u.locked_until > Date.now()) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const set = await recoveryOf(env, u.id);
    if (set.length) {
      const row = set.find(r => r.question === str(body.question, 200)), answer = answerKey(body.answer);
      if (!row) return fail(400, 'Choose one of your recovery questions.');
      if (!answer) return fail(400, 'Enter your answer.');
      if (!same(await hashPassword(answer, row.salt, ANSWER_ROUNDS), row.hash)) { await strike(env, u); return fail(401, 'That answer is not right.'); }
    } else {
      if (!str(body.firstName, 60)) return fail(400, 'Enter the first name on your account.');
      if (!sameName(body.firstName, u.first) || !sameName(body.lastName, u.last)) { await strike(env, u); return fail(401, 'Those details do not match the account.'); }
    }
    await setPassword(env, u.id, password);
    console.log('password reset without email', u.id);
    return json({ ok: true });
  }
  /* Forgot password: a one-hour, single-use link to the recovery email, sent through Resend (RESEND_API_KEY secret; MAIL_FROM sets the sender). */
  if (route === 'POST /api/forgot') {
    const email = str(body.email, 200).toLowerCase();
    if (!EMAIL_OK.test(email)) return fail(400, 'Enter your recovery email address.');
    if (!env.RESEND_API_KEY) return fail(503, 'Password reset by email is not switched on for this site yet.');
    const u = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
    if (!u) return fail(404, 'No account uses that email address.');
    if (await env.DB.prepare('SELECT 1 FROM resets WHERE user_id = ? AND created > ?').bind(u.id, Date.now() - 120000).first()) return fail(429, 'A reset link was just sent. Give it a couple of minutes before asking again.');
    const token = rand(32), link = url.origin + '/account.html?reset=' + token;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM resets WHERE expires < ? OR user_id = ?').bind(Date.now(), u.id),
      env.DB.prepare('INSERT INTO resets (token_hash, user_id, expires, created) VALUES (?, ?, ?, ?)').bind(await sha(token), u.id, Date.now() + 36e5, Date.now()),
    ]);
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'Doctor Career Companion <onboarding@resend.dev>', to: [u.email], subject: 'Reset your Doctor Career Companion password',
        text: `Someone asked to reset the password for your Doctor Career Companion account.\n\nOpen this link within one hour to choose a new password:\n${link}\n\nIf this was not you, ignore this email and your password stays as it is.`,
        html: `<p>Someone asked to reset the password for your Doctor Career Companion account.</p><p><a href="${link}">Choose a new password</a> (the link works for one hour).</p><p>If this was not you, ignore this email and your password stays as it is.</p>` }) });
    if (!r.ok) { console.error('reset mail failed', r.status); await env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(u.id).run(); return fail(502, 'The reset email could not be sent just now. Try again later.'); }
    return json({ ok: true });
  }
  if (route === 'POST /api/reset') {
    const token = typeof body.token === 'string' && /^[a-f0-9]{64}$/.test(body.token) ? body.token : '', password = typeof body.password === 'string' ? body.password : '';
    if (!PASSWORD_OK(password)) return fail(400, PASSWORD_RULE);
    const row = token && await env.DB.prepare('SELECT user_id FROM resets WHERE token_hash = ? AND expires > ?').bind(await sha(token), Date.now()).first();
    if (!row) return fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    await setPassword(env, row.user_id, password);
    return json({ ok: true });
  }

  const user = await currentUser(request, env);
  if (request.method === 'GET' && url.pathname === '/api/lifeos/connect') return lifeosConnect(env, user);
  if (route === 'POST /api/logout') {
    const m = /(?:^|;\s*)dcc_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(m[1])).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (!user) return fail(401, 'Log in to continue.');

  /* MKOS, the Medical Knowledge Operating System (src/mkos): /api/mkos/<op>[/<id>]. Knowledge is central and readable by every
     account; learner state is the caller's own; administration is the owner's. */
  if (url.pathname.startsWith('/api/mkos')) { const r = await mkosApi(request, env, url, user, body, { owner: isOwner(env, user), deps: mkDeps(env), roots: mkRoots(env), kick: genKick(env, ctx) }); return json(r.body, r.status); }

  /* Change password while logged in: the current password is asked for again. This device stays logged in; every other one is logged out. */
  if (route === 'POST /api/password') {
    if (user.locked_until > Date.now()) return fail(429, 'Too many attempts. Try again in a few minutes.');
    if (!PASSWORD_OK(body.password)) return fail(400, PASSWORD_RULE);
    if (typeof body.current !== 'string' || !same(await hashPassword(body.current, user.salt), user.hash)) { await strike(env, user); return fail(401, 'Your current password is not right.'); }
    if (body.password === body.current) return fail(400, 'Choose a password different from your current one.');
    const m = /(?:^|;\s*)dcc_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
    await setPassword(env, user.id, body.password, m ? await sha(m[1]) : '');
    return json({ ok: true });
  }
  /* Set the account's recovery questions (one to three, each from the list, no question twice). The current password is asked for again.
     A question left with a blank answer keeps the answer it already had. */
  if (route === 'PUT /api/recovery') {
    if (user.locked_until > Date.now()) return fail(429, 'Too many attempts. Try again in a few minutes.');
    const items = (Array.isArray(body.items) ? body.items : []).filter(i => i && typeof i === 'object' && str(i.question, 200)).slice(0, MAX_RECOVERY + 1);
    if (items.length > MAX_RECOVERY) return fail(400, `Choose up to ${MAX_RECOVERY} questions.`);
    if (items.some(i => !QUESTIONS.includes(str(i.question, 200)))) return fail(400, 'Choose each question from the list.');
    if (new Set(items.map(i => str(i.question, 200))).size !== items.length) return fail(400, 'Choose a different question for each one.');
    const had = await recoveryOf(env, user.id), rows = [];
    for (const i of items) {
      const question = str(i.question, 200), answer = answerKey(i.answer), old = had.find(r => r.question === question);
      if (!answer && !old) return fail(400, 'Enter an answer for each question.');
      if (answer && answer.length < 2) return fail(400, 'Each answer needs at least 2 letters or numbers.');
      rows.push({ question, answer, old });
    }
    if (typeof body.current !== 'string' || !same(await hashPassword(body.current, user.salt), user.hash)) { await strike(env, user); return fail(401, 'Your current password is not right.'); }
    const writes = [env.DB.prepare('DELETE FROM recovery WHERE user_id = ?').bind(user.id)];
    for (const [slot, r] of rows.entries()) {
      const salt = r.answer ? rand(16) : r.old.salt, hash = r.answer ? await hashPassword(r.answer, salt, ANSWER_ROUNDS) : r.old.hash;
      writes.push(env.DB.prepare('INSERT INTO recovery (user_id, slot, question, salt, hash) VALUES (?, ?, ?, ?, ?)').bind(user.id, slot, r.question, salt, hash));
    }
    await env.DB.batch(writes);
    return json({ recovery: rows.map(r => r.question) });
  }
  if (route === 'GET /api/me') {
    const link = await env.DB.prepare('SELECT created FROM links WHERE user_id = ?').bind(user.id).first();
    const H = await hierarchy(env), providers = aiList(env, await aiUsed(env, user.id), H), owner = isOwner(env, user);
    return json({ ...profile(user), reset: resetMode(env), recovery: (await recoveryOf(env, user.id)).map(r => r.question), questions: QUESTIONS, ai: (providers[0] || {}).id || 'none', providers, hierarchy: chart(env, H), says: await siteSays(env, user), connector: link ? link.created : null, areas: await summary(env, user.id),
      library: libraryOn(env, user), libraryEmail: libraryOn(env, user) && owner ? libraryEmail() : '', libraryWhy: libraryWhy(env, user), storage: await storage(env, user), owner,
      drive: owner ? { mode: DRIVE.mode, account: DRIVE.email, canConnect: !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET), redirect: url.origin + '/api/google/callback' } : undefined });
  }
  /* The owner connects their own Google account once, so this server can write the account folders in their Drive. Google sends
     the owner back to /api/google/callback with a code; the long-lived token it is traded for is kept encrypted in D1. */
  if (route === 'GET /api/google/connect' || route === 'GET /api/google/callback') {
    const back = t => Response.redirect(url.origin + '/account.html?drive=' + encodeURIComponent(t), 302);
    if (!isOwner(env, user)) return back('Only the site owner (the OWNER_EMAIL secret) can connect Google Drive.');
    if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return back('Add the GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET secrets in Cloudflare first.');
    const redirect = url.origin + '/api/google/callback';
    if (route === 'GET /api/google/connect') {
      const state = rand(24); await setSetting(env, 'google_state', state + ':' + (Date.now() + 6e5));
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + form({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive', access_type: 'offline', prompt: 'consent', state }), 302);
    }
    const [state, until] = String(await setting(env, 'google_state') || '').split(':'); await setSetting(env, 'google_state', null);
    if (url.searchParams.get('error')) return back('Google did not grant access (' + url.searchParams.get('error') + ').');
    if (!state || !same(str(url.searchParams.get('state'), 100), state) || Number(until) < Date.now()) return back('That sign-in link expired. Start again from the account page.');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code: str(url.searchParams.get('code'), 2000), client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirect_uri: redirect }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return back('Google did not complete the connection (' + (j.error_description || j.error || r.status) + ').');
    if (!j.refresh_token) return back('Google did not send a lasting token. Remove this app at myaccount.google.com/permissions, then connect again.');
    let email = ''; try { email = (await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + j.access_token } })).json()).user.emailAddress || ''; } catch { }
    await setSetting(env, 'google_refresh', await seal(env, j.refresh_token)); await setSetting(env, 'google_email', email);
    gToken = null; await driveState(env, true);
    return back('ok');
  }
  if (route === 'DELETE /api/google/connect') {
    if (!isOwner(env, user)) return fail(403, 'Only the site owner can do that.');
    await setSetting(env, 'google_refresh', null); await setSetting(env, 'google_email', null); gToken = null; await driveState(env, true);
    return json({ ok: true });
  }
  /* The owner's check that both folders can be reached, and that the accounts folder can be written to. */
  if (route === 'POST /api/google/test') {
    if (!isOwner(env, user)) return fail(403, 'Only the site owner can do that.');
    const out = { mode: DRIVE.mode, account: DRIVE.email, knowledge: { ok: false }, accounts: { ok: false, write: false } };
    const look = async (id, o) => { if (!id) { o.error = 'The folder setting is missing on the server.'; return; } try { o.name = (await (await gfetch(env, 'files/' + id, { fields: 'id,name' })).json()).name; o.ok = true; } catch (e) { if (!(e instanceof LibError)) throw e; o.error = e.message; } };
    await look(KNOW(env), out.knowledge); await look(ACCTS(env), out.accounts);
    if (out.accounts.ok) { try { await trash(env, await gupload(env, { name: 'connection-test.json', parent: ACCTS(env), text: '{"test":true}' })); out.accounts.write = true; } catch (e) { if (!(e instanceof LibError)) throw e; out.accounts.error = e.message; } }
    return json(out);
  }
  /* The owner moves a service between tiers, or changes the lowest tier allowed to do a job. Only the differences from the
     built-in defaults are kept. DELETE puts everything back. */
  if (url.pathname === '/api/admin/hierarchy' && (request.method === 'PUT' || request.method === 'DELETE')) {
    if (!isOwner(env, user)) return fail(403, 'Only the site owner can do that.');
    if (request.method === 'DELETE') await setSetting(env, 'ai_hierarchy', null);
    else {
      const H = await hierarchy(env, true), tiers = {}, jobs = {};
      SERVICES.forEach(s => { const t = body.tiers && TIERS.includes(body.tiers[s.id]) ? body.tiers[s.id] : H.tiers[s.id]; if (t !== s.tier) tiers[s.id] = t; });
      JOBS.forEach(j => { const n = body.jobs && TIERS.includes(body.jobs[j.id]) ? body.jobs[j.id] : H.jobs[j.id]; if (n !== j.need) jobs[j.id] = n; });
      await setSetting(env, 'ai_hierarchy', JSON.stringify({ tiers, jobs }));
    }
    persistSoon(env, ctx);   // configuration belongs in Drive (Central Registry Data > MKOS > config)
    return json(chart(env, await hierarchy(env, true)));
  }
  /* The owner reads and rewrites the privacy policy and the terms of service. DELETE goes back to the built-in wording. */
  if (url.pathname === '/api/admin/page') {
    if (!isOwner(env, user)) return fail(403, 'Only the site owner can do that.');
    const name = str(request.method === 'GET' || request.method === 'DELETE' ? url.searchParams.get('name') : body.name, 20);
    if (!PAGES[name]) return fail(400, 'No such page.');
    if (request.method === 'PUT') {
      const text = typeof body.text === 'string' ? body.text.trim() : ''; if (text.length < 200) return fail(400, 'That is too short to be the whole page. Nothing was saved.'); if (text.length > 60000) return fail(413, 'That is too long.');
      await setSetting(env, 'page_' + name, JSON.stringify({ text, date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' }) }));
    } else if (request.method === 'DELETE') await setSetting(env, 'page_' + name, null);
    else if (request.method !== 'GET') return fail(405, 'Not allowed.');
    if (request.method !== 'GET') persistSoon(env, ctx);
    return json({ name, title: PAGES[name].title, ...(await pageText(env, name)) });
  }
  /* Every account and how much of it is in Drive, for the owner. Counts and folder links only: no record is read here. */
  if (route === 'GET /api/admin/accounts') {
    if (!isOwner(env, user)) return fail(403, 'Only the site owner can do that.');
    const { results } = await env.DB.prepare(`SELECT u.email, u.first, u.last, u.created, a.folder, a.synced, a.backup_day AS backupDay, a.error,
      (SELECT COUNT(*) FROM docs d WHERE d.user_id = u.id) AS records, (SELECT COUNT(*) FROM drive_docs x WHERE x.user_id = u.id) AS inDrive
      FROM users u LEFT JOIN drive_accounts a ON a.user_id = u.id ORDER BY u.created LIMIT 500`).all();
    return json({ accounts: results.map(r => ({ ...r, folder: r.folder ? 'https://drive.google.com/drive/folders/' + r.folder : '' })) });
  }
  /* This account's own folder in Drive: how much is copied, copy the rest now, and its dated backups. */
  if (route === 'GET /api/storage') return json(await storage(env, user));
  if (route === 'POST /api/storage/sync') { await syncUser(env, user.id, { n: 30 }); return json(await storage(env, user)); }
  if (route === 'GET /api/storage/backups' || route === 'GET /api/storage/backup') {
    const row = await env.DB.prepare('SELECT backups FROM drive_accounts WHERE user_id = ?').bind(user.id).first();
    if (!storeOn(env) || !row || !row.backups) return route === 'GET /api/storage/backups' ? json({ backups: [] }) : fail(404, 'No backup found.');
    try {
      if (route === 'GET /api/storage/backups') return json({ backups: ((await (await gfetch(env, 'files', { q: `'${row.backups}' in parents and trashed = false`, orderBy: 'name desc', pageSize: 50, fields: 'files(id,name,size,modifiedTime)' })).json()).files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size) || 0, saved: f.modifiedTime })) });
      const id = fileId(url.searchParams.get('id')), meta = await (await gfetch(env, 'files/' + id, { fields: 'id,name,parents,trashed' })).json();
      /* The file must sit directly in this account's own backups folder. Anything else, another account's backup included, is "not found". */
      if (meta.trashed || !(meta.parents || []).includes(row.backups)) return fail(404, 'No backup found.');
      const r = await fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + await googleToken(env) } });
      if (!r.ok) return fail(502, 'That backup could not be read from Drive just now.');
      return new Response(r.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="doctor-career-companion-${String(meta.name).replace(/[^A-Za-z0-9._-]/g, '')}"` } });
    } catch (e) { if (e instanceof LibError) return fail(e.status === 404 ? 404 : 502, e.status === 404 ? 'No backup found.' : e.message); throw e; }
  }
  /* Connector link: a private address, one per account, that lets the app inside Claude read and save this account's record. */
  if (route === 'POST /api/connector') {
    const token = rand(32);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM links WHERE user_id = ?').bind(user.id),
      env.DB.prepare('INSERT INTO links (token_hash, user_id, created) VALUES (?, ?, ?)').bind(await sha(token), user.id, new Date().toISOString()),
    ]);
    return json({ url: url.origin + '/mcp/' + token });
  }
  if (route === 'DELETE /api/connector') {
    await env.DB.prepare('DELETE FROM links WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  /* The app on the website: the saved record, and saving or deleting one document. */
  if (route === 'GET /api/progress') {
    const lang = url.searchParams.get('area') || 'med';
    if (!LANG_OK.test(lang)) return fail(400, 'Bad area.');
    /* `only` (a comma-separated list of document names, e.g. says,saylog) returns just those, for the app's quick refresh of the pronunciation list. */
    const only = (url.searchParams.get('only') || '').split(',').filter(n => /^[A-Za-z0-9_\-]{1,60}$/.test(n)).slice(0, 10).map(n => lang + '/' + n);
    const h = await holders(env, user.id);
    const { results } = only.length ? await env.DB.prepare(`SELECT path, body FROM docs WHERE user_id IN (${HOLD(h)}) AND path IN (` + only.map(() => '?').join(',') + `) ORDER BY user_id = '${CENTRAL}'`).bind(...h, ...only).all()
      : await env.DB.prepare(`SELECT path, body FROM docs WHERE user_id IN (${HOLD(h)}) AND path LIKE ? ORDER BY user_id = '${CENTRAL}'`).bind(...h, lang + '/%').all();
    const docs = {}; for (const r of results) { try { docs[r.path] = JSON.parse(r.body); } catch { } }
    return json({ now: Date.now(), docs });
  }
  if (url.pathname === '/api/doc' && (request.method === 'PUT' || request.method === 'DELETE')) {
    const path = url.searchParams.get('path') || '';
    if (!PATH_OK.test(path)) return fail(400, 'Bad path.');
    if (request.method === 'DELETE' && (path === 'med/says' || path === 'med/saylog')) return fail(400, 'The pronunciation list is not deleted as a whole.');
    if (request.method === 'DELETE') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(await homeOf(env, user.id, path), path).run(); syncSoon(env, ctx, user.id); return json({ ok: true }); }
    if (path === 'med/sayop') { const r = await applySayOps(env, user.id, body && body.ops); syncSoon(env, ctx, user.id); persistSoon(env, ctx); return json(r); }
    const text = JSON.stringify(await guardSays(env, user.id, path, body)); if (text.length > MAX_DOC) return fail(413, 'That is too large to save.');
    await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(await homeOf(env, user.id, path), path, text, new Date().toISOString()).run();
    syncSoon(env, ctx, user.id); if (centralPath(path)) persistSoon(env, ctx);
    return json({ ok: true });
  }
  if (route === 'POST /api/ai') {
    const out = body.job === 'speak' || body.job === 'speak_cf' ? await speak(env, user, body.input, body.job === 'speak_cf' ? 'cf' : '') : await runAI(env, user, { input: body.input, tier: body.tier, provider: str(body.provider, 20).toLowerCase(), account: body.account === true, chat: body.chat === true, job: str(body.job, 20), avoid: str(body.avoid, 20), gov: { route: '/api/ai' } });
    return out.status === 200 ? json({ ...out, status: undefined }) : fail(out.status, out.error);
  }
  if (route === 'GET /api/drive/file') {
    if (!libraryOn(env, user)) return fail(403, 'The reference library is not turned on for this account.');
    try { const r = await driveBytes(env, fileId(url.searchParams.get('id')));
      if (Number(r.headers.get('Content-Length')) > 60e6) return fail(413, 'That file is too large to read in the app.');
      return new Response(r.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=600' } }); }
    catch (e) { if (e instanceof LibError) return fail(e.status, e.message); throw e; }
  }
  /* The reference library in Google Drive, for accounts it is turned on for. */
  if (route === 'POST /api/drive') {
    if (!libraryOn(env, user)) return fail(403, 'The reference library is not turned on for this account.');
    try { return json(await driveTool(env, str(body.tool, 40), body.input)); }
    catch (e) { if (e instanceof LibError) return fail(e.status, e.message); throw e; }
  }
  /* Everything this account holds, for a backup file. */
  if (route === 'GET /api/backup') {
    const { results } = await env.DB.prepare('SELECT path, body, updated FROM docs WHERE user_id = ?').bind(user.id).all();
    const docs = {}; for (const r of results) { try { docs[r.path] = JSON.parse(r.body); } catch { } }
    /* USAP ADF standard export: the app's own bundle (unchanged) is app_data; the restore on the page accepts this and older files. */
    return new Response(JSON.stringify(adfExport(folderName(user.id), { app: 'doctor-career-companion', account: user.email, saved: new Date().toISOString(), docs }), null, 1), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="doctor-career-companion-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  if (route === 'DELETE /api/account') {
    /* The account's Drive folder goes to the owner's Drive trash, where Google keeps it for 30 days. */
    const gone = storeOn(env) ? await env.DB.prepare('SELECT folder FROM drive_accounts WHERE user_id = ?').bind(user.id).first() : null;
    if (gone && gone.folder && ctx) ctx.waitUntil(trash(env, gone.folder).catch(e => console.error(e)));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM drive_docs WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM drive_accounts WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM ai_usage WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM docs WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM usage WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM recovery WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM links WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  return fail(404, 'Not found.');
}

/* ---------- MKOS: what the knowledge engine may use from this server ----------
   Drive access goes through the same owner credential and the same library check as the rest of the site; the MKOS folder in the
   central registry folder (MKOS_DRIVE_FOLDER) is the only place it writes. AI extraction calls only the free services, directly, under
   its own usage account 'mkos', so the AI hierarchy is unchanged and no learner's allowance (or paid service) is spent. */
const mkRoots = env => ({ root: KNOW(env), mirrorRoot: str(env.MKOS_DRIVE_FOLDER, 200) });
let rangeStatus = null;
function mkDeps(env) {
  const META = 'nextPageToken,files(id,name,mimeType,parents,size,md5Checksum,modifiedTime)';
  const shape = f => ({ id: f.id, title: f.name, mimeType: f.mimeType, parentId: (f.parents || [])[0] || '', fileSize: f.size || '', md5: f.md5Checksum || '', modifiedTime: f.modifiedTime || '' });
  const docsOf = async (uid, prefixes) => {
    if (!uid) return {};
    const where = prefixes.map(p => p.endsWith('_') ? 'path LIKE ?' : 'path = ?').join(' OR '), h = await holders(env, uid);
    const { results } = await env.DB.prepare(`SELECT path, body FROM docs WHERE user_id IN (${HOLD(h)}) AND (${where}) ORDER BY user_id = '${CENTRAL}'`).bind(...h, ...prefixes.map(p => p.endsWith('_') ? p + '%' : p)).all();
    const out = {}; for (const r of results) { try { out[r.path] = JSON.parse(r.body); } catch { } } return out;
  };
  return {
    list: async (folderId, token) => { const j = await (await gfetch(env, 'files', { q: `'${folderId}' in parents and trashed = false`, pageSize: 100, pageToken: token || '', fields: META, includeItemsFromAllDrives: 'true' })).json(); return { files: (j.files || []).map(shape), next: j.nextPageToken || '' }; },
    readText: async fileId => (await driveTool(env, 'read_file_content', { fileId }, { bg: true })).fileContent || '',
    readJson: async fileId => { await inLibrary(env, fileId); return await (await gfetch(env, 'files/' + fileId, { alt: 'media' })).json(); },
    findJson: async q => { const j = await (await gfetch(env, 'files', { q: driveQuery(q), pageSize: 20, fields: 'files(id,name,mimeType,parents)', includeItemsFromAllDrives: 'true' })).json();
      for (const f of j.files || []) if (/json/i.test(f.mimeType + f.name) && await inside(env, (f.parents || [])[0], KNOW(env))) return { id: f.id, title: f.name }; return null; },
    upload: ({ id, name, parent, text, mime }) => gupload(env, { id, name, parent, text, mime, full: true }),
    /* The AI order of operations as built (SERVICES, TIERS, JOBS, AI_ORDER) and as the owner has adjusted it: configuration that
       canonical storage keeps in Drive (config/configuration.json). Read only; nothing here changes the order. */
    appConfig: async () => ({ services: SERVICES.map(x => ({ id: x.id, tier: x.tier, ...(x.name ? { name: x.name } : {}) })), tiers: TIERS, jobs: JOBS.map(j => ({ id: j.id, need: j.need })),
      ai_order: { setting: str(env.AI_ORDER, 200) || null, resolved: aiOrder(env) }, effective: await hierarchy(env, true),
      /* Model choices set as Worker variables (names only, never keys). */
      models: Object.fromEntries(Object.entries(env).filter(([k, v]) => /_MODEL(_|$)/.test(k) && typeof v === 'string' && !/KEY|TOKEN|SECRET/.test(k)).map(([k, v]) => [k, v.slice(0, 120)])) }),
    mkdir: (name, parent) => mkdir(env, name, parent),
    patch: async (id, { name, addParents, removeParents }) => gsend(env, 'PATCH', 'files/' + id + '?' + form({ ...(addParents ? { addParents } : {}), ...(removeParents ? { removeParents } : {}) }), name ? { name } : {}),
    folders: { registry: str(env.MKOS_REGISTRY_FOLDER, 200), oldVersions: str(env.MKOS_REGISTRY_OLD_FOLDER, 200), mkos: str(env.MKOS_DRIVE_FOLDER, 200) },
    userDocs: docsOf,
    ownerUpdated: async paths => { const o = await ownerId(env); if (!o) return ''; const r = await env.DB.prepare(`SELECT MAX(updated) AS t FROM docs WHERE user_id IN (?, ?) AND path IN (${paths.map(() => '?').join(',')})`).bind(o, CENTRAL, ...paths).first(); return (r && r.t) || ''; },
    ownerSay: async ops => { const o = await ownerId(env); if (!o) throw new Error('No owner account.'); const r = await applySayOps(env, o, ops); syncSoon(env, null, o); return r; },
    ownerDocs: async prefixes => docsOf(await ownerId(env), prefixes),
    ownerId: () => ownerId(env),
    // A file in the MKOS folder itself (canonical storage), read back only for a restore or its verification.
    readMine: async fileId => await (await gfetch(env, 'files/' + fileId, { alt: 'media' })).json(),
    /* A byte range of a library file: large sources are indexed from their table of contents without downloading them whole. */
    readRange: async (fileId, start, end) => {
      const r = await driveBytes(env, fileId, 'bytes=' + start + '-' + end); rangeStatus = r.status;
      if (r.status === 206) return new Uint8Array(await r.arrayBuffer());
      /* Google answered with the whole file: read only up to the end of the range, then stop the download. */
      const reader = r.body.getReader(), want = end + 1, parts = []; let got = 0;
      while (got < want) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
      try { await reader.cancel(); } catch { }
      const all = new Uint8Array(got); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      return all.subarray(start, Math.min(got, want));
    },
    lastRangeStatus: () => rangeStatus,
    /* USAP AI governance: a deterministic path (rules) answered where the catalog action could have used AI. Labels only. */
    recordDeterministic: (action, d) => { try { usap.recordDeterministic(GOV_APP + action, d); } catch { } },
    mkosRoot: env.MKOS_DRIVE_FOLDER || null,
    /* The library root, and the Dynamic Board Objective Curriculum folder inside it (found by name unless MKOS_CURRICULUM_FOLDER names it). */
    libraryRoot: KNOW(env) || null, curriculumFolder: str(env.MKOS_CURRICULUM_FOLDER, 200) || null,
    /* The generation queue (src/mkos/genjobs.js) writes lessons with the app's own AI, through runAI and its hierarchy, as the account
       that queued them: the same allowances and the same order of operations as a lesson written in the page. */
    genAI: async (uid, opts) => { const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(uid).first(); if (!u) return { status: 404, error: 'no such account' }; return runAI(env, u, { ...opts, gov: { action: opts && opts.gov, user_initiated: 0, route: 'gen:' + ((opts && opts.job) || 'lesson') } }); },
    aiLeft: async (uid, provider) => { const used = await aiUsed(env, uid); return aiCap(env, provider) - (used[provider] || 0); },
    genModels: async () => { const H = await hierarchy(env); const server = route(env, H, 'lesson').filter(id => hasProvider(env, id)); return { server, first: server[0] || null, names: Object.fromEntries(server.map(id => [id, PNAME[id]])) }; },
    isLead: async (provider) => { const H = await hierarchy(env); return H.tiers[provider] === 'lead'; },
    putDoc: async (uid, path, obj) => { obj._t = Date.now(); await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(uid, path, JSON.stringify(obj), new Date().toISOString()).run(); },
    changedUsers: async () => (await env.DB.prepare("SELECT user_id, MAX(updated) AS updated FROM docs WHERE path = 'med/state' OR path LIKE 'med/les_%' OR path LIKE 'med/bank_%' OR path LIKE 'med/cards_%' GROUP BY user_id").all()).results,
    /* Free services only (Gemini's free tier, then Cloudflare Workers AI), called directly so a paid service is never reached and the
       app's AI hierarchy is untouched. Usage is counted under the account 'mkos'. */
    ai: (geminiKey(env) || env.AI) && env.MKOS_AI !== 'off' ? async (prompt, meta = {}) => {
      const G = govOf(meta.action || 'mkos_other', { user_initiated: 0, route: 'mkos:' + (meta.action || 'other'), path: meta.path });   // USAP AI governance labels only
      const messages = [{ role: 'user', content: prompt }]; let last = null;
      /* Owner directive 2026-10-24: in the release window (the last hours before midnight UTC) only the Gemini models are used, quick
         models first and then the default ones, so their remaining free allowance is spent; when every one reports its limit the
         engine stops for the day. Outside it: Gemini quick, then Cloudflare Workers AI, within the daily cap (aiBudgetLeft). */
      const w = await aiWindow(env), plan = w.release ? [['gemini', 'quick'], ['gemini', 'default']] : [['gemini', 'quick'], ['llama', 'quick']];
      let geminiBusy = 0;
      for (const [id, tier] of plan) {
        if (!hasProvider(env, id)) continue;
        try { const out = await usap.timeAI(() => SERVICE[id].run(env, messages, tier), { provider: id, job: 'mkos', fell_back: last ? 1 : 0, ...G });   // USAP: timing and counts only
          if (out && out.text) {
          await env.DB.prepare('INSERT INTO ai_usage (user_id, day, provider, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, provider) DO UPDATE SET n = n + 1').bind('mkos', today(), id).run();
          return out.text; } } catch (e) { last = e; if (id === 'gemini' && e.busy) geminiBusy++; }
      }
      if (w.release && geminiBusy === plan.length) await markGeminiOut(env);   // every Gemini model is at its limit: done for today
      throw last || new Error('No free AI service answered'); } : null,
  };
}
/* A lesson just queued for the server starts at once, after the reply (the 5-minute run carries on from wherever this stops). */
const genKick = (env, ctx) => ctx ? uid => ctx.waitUntil(runGen(env, mkDeps(env), { budgetMs: 28e3, user: uid, maxSteps: 1 }).catch(e => console.error('gen kick', e))) : null;
async function genRunSafe(env) {
  try { if (env.GEN === 'off') return; await init(env); await runGen(env, mkDeps(env), { maxSteps: Number(env.GEN_STEPS) || 14 }); }
  catch (e) { console.error('gen', e); }
  /* Map as many knowledge objects as possible to the board objectives (src/mkos/objmap.js), then write the objective curriculum's
     durable files in Drive (src/mkos/curstore.js). */
  try { if (env.MKOS !== 'off') await mapObjectives(env, {}); } catch (e) { console.error('objective mapping', e); }
  try { await driveState(env); if (DRIVE.mode && env.MKOS !== 'off') await curSync(env, mkDeps(env), { max: Number(env.CUR_FILES) || 8 }); }
  catch (e) { console.error('curriculum', e); }
}
async function mkTickSafe(env) {
  try { await init(env); await centralize(env); await driveState(env); if (!DRIVE.mode) return;
    const r = await mkTick(env, mkDeps(env), { ...mkRoots(env), maxBudget: 480 });
    if (r && typeof r.used === 'number') usap.emitMetric('d1_query_count', r.used, { job: 'mkos_tick' }); }   // USAP: the run's metered D1 statements
  catch (e) { console.error('mkos', e); }
}
/* A durable change made outside the engine (configuration, the central records) is persisted to Drive straight after the reply
   instead of waiting for the next run; it is already queued (src/mkos/mirror.js keeps it pending until Drive confirms it), so if
   this attempt fails the next run retries it. */
const persistSoon = (env, ctx) => { if (ctx && env.MKOS !== 'off' && env.MKOS_DRIVE_FOLDER) ctx.waitUntil(mkPersist(env).catch(e => console.error('persist', e))); };
async function mkPersist(env) { await init(env); await driveState(env); if (!DRIVE.mode) return; await persistNow(env, mkDeps(env), env.MKOS_DRIVE_FOLDER, { only: ['config', 'central/'] }); }

/* ---------- MCP connector at /mcp/<token> ----------
   A small Model Context Protocol server (JSON over HTTP POST). The token in the address is the only credential,
   so it is long, random, stored only as a hash, and can be replaced or switched off from the account page. */
const MCP_TOOLS = [
  ...MKOS_TOOLS,
  { name: 'load_progress', description: "Load this physician's saved study and career record: the documents changed since `since` (milliseconds since 1970; 0 for everything), the list of every document path, and the server time to pass as `since` next time. `area` defaults to \"med\". `only` (a list of document names such as [\"says\", \"saylog\"]) returns just those documents, whenever they changed.",
    inputSchema: { type: 'object', properties: { area: { type: 'string' }, since: { type: 'number' }, only: { type: 'array', items: { type: 'string' } } } }, annotations: { readOnlyHint: true } },
  { name: 'get_profile', description: "The account's first name, last name and email, and how much is saved.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'save_doc', description: "Save one document, replacing what was there. The path starts with the area, e.g. med/state or med/bank_cv.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, body: { type: 'object' } }, required: ['path', 'body'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_doc', description: "Delete one document, e.g. an old lesson removed in the app.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'ai_providers', description: "Which AI services this account can ask through the website's server (Gemini, Llama, Claude) and how many requests each has left today.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'ask_ai', description: "Ask one of the website's AI services instead of Claude. `input` is the prompt, or a list of {role, content} messages. `provider` is gemini, llama, claude or auto. `tier` is quick or default. `account` true lets the service look up this account's own record and the reference library while it answers. `job` says what the request is for (lesson, lesson_lib, questions, review, plan, report, cards, notes or chat) and decides which services may answer; `avoid` names the service that wrote the thing under review.",
    inputSchema: { type: 'object', properties: { input: {}, provider: { type: 'string' }, tier: { type: 'string' }, account: { type: 'boolean' }, chat: { type: 'boolean' }, job: { type: 'string' }, avoid: { type: 'string' } }, required: ['input'] }, annotations: { readOnlyHint: true } },
  { name: 'storage_status', description: "How much of this account's record has been copied to its own folder in Google Drive, and when.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'library_status', description: "Whether this account may read the reference library that is shared with the Doctor Career Companion website.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'library_file', description: "One slice of a file in the reference library (a guideline PDF), base64 encoded, for the app's PDF reader. Start at `offset` 0 and continue from offset + length until `done` is true.",
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, offset: { type: 'number' } }, required: ['fileId'] }, annotations: { readOnlyHint: true } },
  /* USAP governance (the node kit's standard tool): Settings > Governance inside Claude. Owner and owner-granted people only. */
  { name: usap.mcpTool.name, description: usap.mcpTool.description, inputSchema: usap.mcpTool.inputSchema, annotations: { readOnlyHint: false, destructiveHint: false } },
];
async function mcpServer(request, env, token, ctx) {
  if (request.method !== 'POST') return new Response('This address is for the Doctor Career Companion connector in Claude.', { status: 405, headers: { Allow: 'POST' } });
  await init(env); await driveState(env);
  const link = /^[a-f0-9]{64}$/.test(token) ? await env.DB.prepare('SELECT user_id FROM links WHERE token_hash = ?').bind(await sha(token)).first() : null;
  if (!link) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This connector link is not valid. Make a new one on the Doctor Career Companion account page.' } }, 401);
  const text = await request.text();
  if (text.length > MAX_DOC + 200000) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, 413);
  let msg; try { msg = JSON.parse(text); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const uid = link.user_id;
  const one = async m => {
    if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return null;   // notifications need no answer
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result }), err = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.method === 'initialize') return ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'doctor-career-companion', version: '1.0.0' },
      instructions: 'The study and career record for one Doctor Career Companion account. The app inside Claude uses these tools to save and load question history, lessons, mastery statistics and career plans.' });
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: MCP_TOOLS });
    if (m.method !== 'tools/call') return err(-32601, 'Method not found');
    const name = m.params && m.params.name, a = (m.params && m.params.arguments) || {};
    const out = o => ok({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o }), bad = t => ok({ content: [{ type: 'text', text: t }], isError: true });
    if (name === 'load_progress') {
      const lang = String(a.area || 'med'); if (!LANG_OK.test(lang)) return bad('Give an area such as "med".');
      const since = Number(a.since) || 0, docs = {}, paths = [];
      const h = await holders(env, uid);
      const { results } = await env.DB.prepare(`SELECT path, body, updated FROM docs WHERE user_id IN (${HOLD(h)}) AND path LIKE ? ORDER BY user_id = '${CENTRAL}'`).bind(...h, lang + '/%').all();
      const only = Array.isArray(a.only) ? new Set(a.only.filter(n => typeof n === 'string').slice(0, 10).map(n => lang + '/' + n)) : null;
      for (const r of results) { paths.push(r.path); if (only ? only.has(r.path) : (!since || Date.parse(r.updated) > since)) { try { docs[r.path] = JSON.parse(r.body); } catch { } } }
      return out({ now: Date.now(), area: lang, paths, docs });
    }
    if (name === 'get_profile') {
      const u = await env.DB.prepare('SELECT first, last, email FROM users WHERE id = ?').bind(uid).first();
      return out({ firstName: (u && u.first) || '', lastName: (u && u.last) || '', email: (u && u.email) || '', areas: await summary(env, uid) });
    }
    if (name === 'ai_providers' || name === 'ask_ai' || name === 'storage_status') {
      const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(uid).first(); if (!u) return bad('This account no longer exists.');
      if (name === 'storage_status') return out(await storage(env, u));
      if (name === 'ai_providers') { const H = await hierarchy(env); return out({ providers: aiList(env, await aiUsed(env, uid), H), hierarchy: chart(env, H), says: await siteSays(env, u) }); }
      const r = a.job === 'speak' || a.job === 'speak_cf' ? await speak(env, u, a.input, a.job === 'speak_cf' ? 'cf' : '') : await runAI(env, u, { input: a.input, tier: a.tier, provider: String(a.provider || '').toLowerCase(), account: a.account === true, chat: a.chat === true, job: String(a.job || ''), avoid: String(a.avoid || ''), gov: { route: 'mcp:ask_ai' } });
      return r.status === 200 ? out({ ...r, status: undefined }) : out({ error: r.error, code: r.status === 429 ? 'rate_limited' : 'upstream_error' });
    }
    if (name === 'library_status' || name === 'library_file') {
      const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(uid).first(), on = !!u && libraryOn(env, u);
      if (name === 'library_status') return out({ library: on, why: u ? libraryWhy(env, u) : '', serviceAccount: '' });
      if (!on) return bad('The reference library is not turned on for this account.');
      try { return out(await driveSlice(env, fileId(a.fileId), a.offset)); } catch (e) { if (e instanceof LibError) return bad(e.message); throw e; }
    }
    if (name === 'mkos') {
      const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(uid).first(); if (!u) return bad('This account no longer exists.');
      const r = await mkosCall(env, u, String(a.op || 'status'), a.args && typeof a.args === 'object' ? a.args : {}, { owner: isOwner(env, u), deps: mkDeps(env), roots: mkRoots(env), kick: genKick(env, ctx) });
      return r.status === 200 ? out(r.body) : bad(JSON.stringify(r.body).slice(0, 2000));
    }
    if (name === usap.mcpTool.name) {
      const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(uid).first(); if (!u) return bad('This account no longer exists.');
      return out(await usap.mcpTool.call(env, u, a));
    }
    const path = String(a.path || '');
    if (!PATH_OK.test(path)) return bad('That is not a valid document path. It must start with the area, like med/state.');
    if (name === 'save_doc') {
      if (!a.body || typeof a.body !== 'object' || Array.isArray(a.body)) return bad('The document must be an object.');
      if (path === 'med/sayop') { const r = await applySayOps(env, uid, a.body.ops); syncSoon(env, ctx, uid); persistSoon(env, ctx); return out(r); }
      const body = JSON.stringify(await guardSays(env, uid, path, a.body)); if (body.length > MAX_DOC) return bad('That document is too large to save.');
      await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(await homeOf(env, uid, path), path, body, new Date().toISOString()).run();
      syncSoon(env, ctx, uid); if (centralPath(path)) persistSoon(env, ctx);
      return out({ ok: true });
    }
    if (name === 'delete_doc' && (path === 'med/says' || path === 'med/saylog')) return bad('The pronunciation list is not deleted as a whole.');
    if (name === 'delete_doc') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(await homeOf(env, uid, path), path).run(); syncSoon(env, ctx, uid); return out({ ok: true }); }
    return err(-32602, 'Unknown tool');
  };
  if (Array.isArray(msg)) { const r = (await Promise.all(msg.map(one))).filter(Boolean); return r.length ? json(r) : new Response(null, { status: 202 }); }
  const r = await one(msg); return r ? json(r) : new Response(null, { status: 202 });
}

const app = {
  /* Every five minutes: copy waiting records to Drive first; when nothing was waiting, the same run gives MKOS its turn (scan, jobs,
     mirror). Splitting the run this way keeps each invocation inside the platform's per-run limits. */
  async scheduled(event, env, ctx) {
    const drive = (async () => {
      const spent = await sweep(env).catch(e => { console.error(e); return 34; });
      /* USAP ADF: when the copy job was light, one account folder still waiting gets its standard layout (once per account). */
      if (spent <= 6) await adfTickSafe(env);
      /* MKOS runs when the sweep had little to copy, and in every third run regardless, so it is never starved. */
      const third = Math.floor(new Date(event.scheduledTime || Date.now()).getUTCMinutes() / 5) % 3 === 0;
      if (env.MKOS !== 'off' && (spent <= 6 || (third && spent <= 20))) await mkTickSafe(env);
    })();
    ctx.waitUntil(drive);
    /* The generation queue has its own turn every run: background and batch lessons, then objective seeding (src/mkos/genjobs.js). */
    const gen = genRunSafe(env);
    ctx.waitUntil(gen);
    /* USAP: once both are done, the hourly status figures, then everything observed in this run is sent. */
    ctx.waitUntil(Promise.allSettled([drive, gen]).then(() => usapStatus(env, event, ctx)).catch(() => { }).then(() => usap.flush(env)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/mcp/')) {
      try { return await mcpServer(request, env, url.pathname.slice(5).replace(/\/+$/, ''), ctx); }
      catch (e) { console.error(e); return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server error' } }, 500); }
    }
    const page = /^\/(privacy|terms)(?:\.html)?\/?$/.exec(url.pathname);
    if (page && request.method === 'GET') { try { return await pageResponse(env, page[1]); } catch (e) { console.error(e); return new Response('This page could not be shown just now. Try again.', { status: 500 }); } }
    if (url.pathname.startsWith('/voice/hf/') || url.pathname.startsWith('/voice/ort/')) {
      try { return await voiceFile(request, env, ctx, url); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    /* USAP: the shared governance renderer, the remediation hooks (USAP only) and Settings > Governance (owner and granted people). */
    if (url.pathname === '/usap/ui.js') return usap.serveUI(request, env);
    /* USAP browser reporter (kit 1.2.0): page load time, whether a script error happened, one view. Numbers only, no sign-in. */
    if (url.pathname === '/api/usap/client') return usap.handleClient(request, env, ctx);
    if (url.pathname === '/api/usap/remediate') {
      /* A request over USAP's service binding has no visitor address; one from the internet always does, so it may not claim the binding. */
      if (request.headers.get('x-usap-ugf') === 'binding' && request.headers.get('CF-Connecting-IP')) return fail(401, 'Not allowed.');
      return usap.handleRemediation(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/usap/governance')) {
      const origin = request.headers.get('Origin');
      if (request.method !== 'GET' && origin && new URL(origin).host !== url.host) return fail(403, 'Cross-site request refused.');
      try { await init(env); return await usap.handleGovernance(request, env, ctx, await currentUser(request, env)); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url, ctx); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------- USAP status figures (hourly, from the five-minute timer) ----------
   Read-only counts and ages from tables the app already keeps; nothing about a person, no text. Every figure is optional: a table
   that does not exist yet (MKOS before its first run) simply sends nothing. */
async function usapStatus(env, event, ctx) {
  if (new Date(event && event.scheduledTime || Date.now()).getUTCMinutes() >= 5) return;   // the first run of each hour
  const one = async (sql, ...a) => { try { return await env.DB.prepare(sql).bind(...a).first(); } catch { return null; } };
  const mkSet = async k => { const r = await one('SELECT v FROM mk_settings WHERE k = ?', k); try { return r ? JSON.parse(r.v) : null; } catch { return null; } };
  const now = Date.now(), mins = t => t && Date.parse(t) ? Math.max(0, (now - Date.parse(t)) / 60e3) : 0, M = (k, v, d) => { if (typeof v === 'number' && Number.isFinite(v)) usap.emitMetric(k, v, d || {}); };
  // Persistence: account records waiting for Drive, MKOS files pending Drive's confirmation, and how old the oldest of each is.
  const acc = await one('SELECT COUNT(*) AS n, MIN(d.updated) AS t ' + DIRTY), mk = await one("SELECT COUNT(*) AS n, MIN(synced) AS t FROM mk_mirror WHERE key LIKE 'pend:%'");
  if (acc) M('drive_sync_backlog', acc.n || 0, { store: 'drive' });
  if (mk) M('drive_sync_backlog', mk.n || 0, { store: 'mkos' });
  if (acc || mk) M('drive_sync_lag_minutes', Math.round(Math.max(mins(acc && acc.n ? acc.t : null), mins(mk && mk.n ? mk.t : null))), {});
  const snap = await one("SELECT synced FROM mk_mirror WHERE key = 'snapshot'");
  if (snap && snap.synced) M('backup_age_hours', Math.round(mins(snap.synced) / 6) / 10, { store: 'mkos' });
  const drill = await mkSet('drill_report'); if (drill && typeof drill.pass === 'boolean') M('restore_drill_pass', drill.pass ? 1 : 0, {});
  // Knowledge: central objects (shared knowledge only, never a learner's own assets), concepts nothing links to, retrieve-first routing.
  const objs = await one("SELECT COUNT(*) AS n FROM mk_objects WHERE id NOT LIKE 'ea.u%'"); if (objs) M('registry_object_count', objs.n || 0, {});
  const rec = await mkSet('reconcile_report'), concepts = await one("SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'Concept'");
  if (rec && rec.orphans && typeof rec.orphans.unlinked_concepts === 'number' && concepts && concepts.n) M('knowledge_orphan_ratio', rec.orphans.unlinked_concepts / concepts.n, {});
  const routed = await one("SELECT COUNT(*) AS n, SUM(CASE WHEN decision != 'ai' THEN 1 ELSE 0 END) AS r FROM mk_routes WHERE at >= ?", new Date(now - 3600e3).toISOString());
  if (routed && routed.n) M('retrieval_satisfied_rate', (routed.r || 0) / routed.n, {});
  // The database's size, as D1 reports it after a statement.
  try { const r = await env.DB.prepare('SELECT 1').run(); M('d1_size_bytes', r && r.meta && r.meta.size_after, { database: 'doctor-career-companion' }); } catch { }
  /* Once a day (the first run of 00:00 UTC): a zero for each activity counter with nothing yet today (kit heartbeat), so a quiet day
     reads as "no activity" rather than missing telemetry: AI calls, page views, connector calls and speech characters. */
  if (new Date(event && event.scheduledTime || Date.now()).getUTCHours() === 0) usap.heartbeat(env, ['ai_calls', 'frontend_views', 'mcp_tool_calls', 'tts_chars_used'], ctx);
  // ADF conformance, once a day (the first run of 00:00 UTC): checked on the most recently synced account folder that has its layout.
  if (new Date(event && event.scheduledTime || Date.now()).getUTCHours() === 0 && storeOn(env)) {
    try {
      const row = await one('SELECT user_id, folder FROM drive_accounts WHERE adf IS NOT NULL AND folder IS NOT NULL ORDER BY synced DESC LIMIT 1');
      const central = [KNOW(env), str(env.MKOS_DRIVE_FOLDER, 200)].filter(Boolean);
      await adfConformance(adfDrive(env), { folderId: row && row.folder, name: row ? folderName(row.user_id) : '', separate: !!ACCTS(env) && !central.includes(ACCTS(env)), emit: M });
    } catch (e) { console.error('adf check', e); }
  }
}

/* ---------- Self-healing (USAP remediation, H7) ----------
   The only actions USAP may ask this app to run, both safe to repeat. They run the app's own existing jobs and change no data.
   The locked hooks (above, SR-03 and SR-12) are refused by the kit even if asked for. */
usap.onRemediate('retry_persistence', async (env, params, { mode }) => {
  await init(env); await driveState(env);
  const waiting = ((await env.DB.prepare('SELECT COUNT(*) AS n ' + DIRTY).first()) || {}).n || 0;
  if (mode === 'verify') return { waiting };
  const googleRequests = await sweep(env);                                  // account records waiting for Drive (the timer's own copy job)
  await mkPersist(env);                                                    // MKOS configuration and central records, pending until Drive confirms
  return { waiting, googleRequests, waitingAfter: ((await env.DB.prepare('SELECT COUNT(*) AS n ' + DIRTY).first()) || {}).n || 0 };
});
/* The persistence audit: what canonical storage (Drive) is behind the database, the oldest pending file, the ledger's last day and
   the latest restore drill. Read only, the same report the owner sees under MKOS durability. */
usap.onRemediate('run_backup_audit', async (env) => {
  await init(env); await mkInit(env); await driveState(env);
  const d = await durability(env, mkDeps(env)), drill = await env.DB.prepare("SELECT v FROM mk_settings WHERE k = 'drill_report'").first().catch(() => null);
  let pass = null; try { pass = drill ? !!JSON.parse(drill.v).pass : null; } catch { }
  const accounts = ((await env.DB.prepare('SELECT COUNT(*) AS n ' + DIRTY).first()) || {}).n || 0;
  return { files: d.files, persisted: d.persisted, behind: d.behind, pending: d.pending, oldest_pending_minutes: d.oldest_pending_minutes, ledger_24h: d.ledger_24h,
    snapshot_written: d.snapshot_written, restore_drill_pass: pass, account_records_waiting: accounts };
});

/* H1: every /api and /mcp request is timed by the kit (the response is returned untouched). The kit sends each time as the median
   sample; the same time is also sent as the 95th-percentile sample here. */
const timed = async (req, env, ctx) => { const t0 = Date.now(); try { return await app.fetch(req, env, ctx); } finally {
  try { const u = new URL(req.url); if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/mcp')) usap.emitMetric('api_latency_p95_ms', Date.now() - t0, { route: usapRoute(u) }); } catch { } } };
export default { ...app, fetch: usap.timeRequest(timed) };
