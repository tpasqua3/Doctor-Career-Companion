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
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
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
  ]).catch(e => { schema = null; throw e; });
  return schema;
}

async function currentUser(request, env) {
  const m = /(?:^|;\s*)dcc_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
  if (!m) return null;
  const row = await env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?').bind(await sha(m[1]), Date.now()).first();
  return row || null;
}
async function startSession(env, userId) {
  const token = rand(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha(token), userId, Date.now() + SESSION_DAYS * 864e5).run();
  return cookie(token, SESSION_DAYS * 86400);
}
/* ---------- The app's AI ----------
   Three services can answer, each switched on by its own setting:
     gemini   Google Gemini, with a GEMINI_API_KEY secret (GEMINI_MODEL and GEMINI_MODEL_QUICK choose the models)
     claude   Anthropic Claude, with an ANTHROPIC_API_KEY secret (AI_MODEL and AI_MODEL_QUICK choose the models)
     llama    Cloudflare Workers AI, through the AI binding (always there)
   The app says which one it wants, or "auto". If that one has used its daily allowance for the account, is over its own limit or
   does not answer, the next one in AI_ORDER (default gemini, claude, llama) answers instead and the reply says so. Each account
   has a daily allowance per service: AI_DAILY (default 200), or AI_DAILY_GEMINI, AI_DAILY_CLAUDE, AI_DAILY_LLAMA for one service.
   Inside Claude the app uses Claude itself by default and reaches the other services through the connector (ask_ai).
   Teaching is held to a higher bar than chat: lessons, questions, cards, plans and every accuracy review are written only by the
   services in TEACHERS (Gemini and Claude). Llama answers in the Ask chat and nowhere else, and only a request the app marks as
   chat may reach it. */
const PROVIDERS = [['gemini', 'Gemini'], ['claude', 'Claude'], ['llama', 'Llama']], PNAME = Object.fromEntries(PROVIDERS);
/* The Gemini key, under the name it is usually saved as or one of the other common ones. */
const geminiKey = env => env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_KEY || env.GOOGLE_GEMINI_API_KEY || env.GOOGLE_AI_API_KEY || '';
const TEACHERS = ['gemini', 'claude'];
const hasProvider = (env, id) => id === 'gemini' ? !!geminiKey(env) : id === 'claude' ? !!env.ANTHROPIC_API_KEY : id === 'llama' ? !!env.AI : false;
const aiOrder = env => [...String(env.AI_ORDER || '').toLowerCase().split(/[\s,;]+/), ...PROVIDERS.map(p => p[0])].filter((x, i, a) => a.indexOf(x) === i && hasProvider(env, x));
const aiCap = (env, id) => Number(env['AI_DAILY_' + id.toUpperCase()]) || Number(env.AI_DAILY) || 200;
const today = () => new Date().toISOString().slice(0, 10);
async function aiUsed(env, uid) { const { results } = await env.DB.prepare('SELECT provider, n FROM ai_usage WHERE user_id = ? AND day = ?').bind(uid, today()).all(); return Object.fromEntries(results.map(r => [r.provider, r.n])); }
const aiList = (env, used) => aiOrder(env).map(id => ({ id, name: PNAME[id], teach: TEACHERS.includes(id), cap: aiCap(env, id), left: Math.max(0, aiCap(env, id) - (used[id] || 0)) }));
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
      if (name === 'list_my_records') return { records: (await env.DB.prepare('SELECT path, length(body) AS size, updated FROM docs WHERE user_id = ? ORDER BY path').bind(user.id).all()).results };
      if (name === 'read_my_record') {
        const path = str(a.path, 130); if (!PATH_OK.test(path)) return { error: 'No record has that name.' };
        const r = await env.DB.prepare('SELECT body, updated FROM docs WHERE user_id = ? AND path = ?').bind(user.id, path).first(); if (!r) return { error: 'No record has that name.' };
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
/* One request from the app, for one account. `provider` is the service the user picked ("auto" for the site's order);
   `account` lets the model look up this account's record and the library while it answers (Gemini only). */
async function runAI(env, user, { input, tier, provider, account, chat }) {
  tier = tier === 'quick' ? 'quick' : 'default';
  let messages = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
  messages = messages.slice(-40).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: typeof (m && m.content) === 'string' ? m.content.slice(0, 150000) : '' })).filter(m => m.content);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return { status: 400, error: 'Nothing to answer.' };
  const order = aiOrder(env).filter(id => chat || TEACHERS.includes(id));
  if (!order.length) return { status: 503, error: chat ? 'No AI is set up on this site yet.' : 'Lessons, questions and reviews are written only by Gemini or Claude, and neither is set up on this site yet. The owner needs to add a GEMINI_API_KEY secret.' };
  const want = order.includes(provider) ? provider : '', used = await aiUsed(env, user.id), notes = []; let capped = 0;
  for (const id of want ? [want, ...order.filter(x => x !== want)] : order) {
    const cap = aiCap(env, id);
    if ((used[id] || 0) >= cap) { capped++; notes.push(`${PNAME[id]} has used today's ${cap} requests for your account`); continue; }
    let out = { text: '', model: '' };
    try { out = id === 'gemini' ? await gemini(env, messages, tier, account ? accountTools(env, user) : null) : id === 'claude' ? await claude(env, messages, tier) : await llama(env, messages, tier); }
    catch (e) { console.error(e); notes.push(PNAME[id] + (e.busy ? ' is over its limit right now' : ' did not answer')); continue; }
    if (!out.text) { notes.push(PNAME[id] + ' did not answer'); continue; }
    await env.DB.prepare('INSERT INTO ai_usage (user_id, day, provider, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, provider) DO UPDATE SET n = n + 1').bind(user.id, today(), id).run();
    used[id] = (used[id] || 0) + 1;
    return { status: 200, text: out.text, model: out.model, provider: id, name: PNAME[id], asked: want || 'auto', fellBack: notes.length > 0, note: notes.join('; '), left: cap - used[id], providers: aiList(env, used) };
  }
  return capped === notes.length ? { status: 429, error: notes.join('; ') + '. Allowances reset at midnight UTC' + (chat ? '.' : '. Lessons, questions and reviews are written only by Gemini or Claude' + (hasProvider(env, 'llama') ? '; Llama is kept for the Ask chat.' : '.')) } : { status: 502, error: 'The AI could not answer just now (' + notes.join('; ') + '). Try again in a moment.' };
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
async function driveTool(env, tool, input) {
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
      const out = await env.AI.toMarkdown([{ name: meta.name || 'file', blob: new Blob([blob], { type: meta.mimeType || 'application/octet-stream' }) }]);
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
     <First Last> - <email> [<first 8 of the account id>]/
       account.json          who the account belongs to (no password, no login tokens)
       records/              one file per record, e.g. med__state.json for med/state: the same documents the app saves
       backups/              backup-YYYY-MM-DD.json, the whole record on each day something changed (the newest 14 are kept)
   D1 is the copy the app reads and writes, so it stays fast and works when Google is slow. Each save is copied to Drive straight
   after the reply is sent, and a timer every five minutes copies whatever is still waiting.
   Isolation: every function here takes the account id the server worked out for itself and looks the folder up in that account's
   own drive_accounts row. No request carries a folder or file id for this part of Drive, except a backup to download, and that one
   is checked to sit in the caller's own backups folder first. */
const FOLDER = 'application/vnd.google-apps.folder', LEASE = 90000, KEEP_BACKUPS = 14;
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
async function gupload(env, { id, name, parent, text, props }) {
  const meta = id ? {} : { name, parents: [parent], mimeType: 'application/json', ...(props ? { appProperties: props } : {}) }, bytes = enc.encode(text);
  const base = 'https://www.googleapis.com/upload/drive/v3/files' + (id ? '/' + id : ''), auth = 'Bearer ' + await googleToken(env), method = id ? 'PATCH' : 'POST';
  let r;
  if (bytes.length < 4e6) {
    const b = 'dcc' + rand(12);
    r = await fetch(base + '?uploadType=multipart&supportsAllDrives=true&fields=id', { method, headers: { Authorization: auth, 'Content-Type': 'multipart/related; boundary=' + b },
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--` });
  } else {
    const start = await fetch(base + '?uploadType=resumable&supportsAllDrives=true&fields=id', { method, headers: { Authorization: auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' }, body: JSON.stringify(meta) });
    const to = start.headers.get('Location'); if (!start.ok || !to) { const e = gfail(start, await start.json().catch(() => ({}))); e.gone = start.status === 404; throw e; }
    r = await fetch(to, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bytes });
  }
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.id) { const e = gfail(r, j); e.gone = r.status === 404; throw e; }
  return j.id;
}
const storeOn = env => !!DRIVE.mode && !!ACCTS(env);
const fileName = path => path.replace(/\//g, '__') + '.json';
const DIRTY = 'FROM docs d LEFT JOIN drive_docs x ON x.user_id = d.user_id AND x.path = d.path WHERE (x.synced IS NULL OR x.synced != d.updated)';
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
    const about = () => JSON.stringify({ app: 'doctor-career-companion', accountId: u.id, email: u.email, firstName: u.first || '', lastName: u.last || '', created: u.created, written: new Date().toISOString() }, null, 1);
    if (!row.folder) { B.n--; await set('folder', await mkdir(env, `${[u.first, u.last].filter(Boolean).join(' ') || 'Account'} - ${u.email} [${u.id.slice(0, 8)}]`.replace(/[\\/]/g, ' ').slice(0, 200), ACCTS(env), { dccAccount: u.id })); }
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
      const text = '{"app":"doctor-career-companion","account":' + JSON.stringify(u.email) + ',"saved":' + JSON.stringify(new Date().toISOString()) + ',"docs":{' + results.map(r => JSON.stringify(r.path) + ':' + r.body).join(',') + '}}';
      B.n -= 3; await gupload(env, { name: 'backup-' + day + '.json', parent: row.backups, text, props: { dccAccount: u.id } });
      await gupload(env, { id: row.profile, text: about() }).catch(() => { });
      await set('backup_day', day);
      const old = (await (await gfetch(env, 'files', { q: `'${row.backups}' in parents and trashed = false`, orderBy: 'name desc', pageSize: 100, fields: 'files(id,name)' })).json()).files || [];
      for (const f of old.slice(KEEP_BACKUPS)) { if (B.n <= 1) break; B.n--; await trash(env, f.id); }
    }
  } catch (e) { error = e instanceof LibError ? e.message : 'Google Drive could not be reached.'; console.error('drive copy failed for ' + uid, e); }
  finally { await env.DB.prepare('UPDATE drive_accounts SET lease = 0, error = ?, synced = ? WHERE user_id = ?').bind(error, error ? row.synced : new Date().toISOString(), uid).run(); }
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
  await init(env); await driveState(env); if (!storeOn(env)) return;
  const B = { n: 34 }, ids = new Set();
  (await env.DB.prepare('SELECT DISTINCT d.user_id AS id ' + DIRTY + ' LIMIT 4').all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare('SELECT u.id FROM users u LEFT JOIN drive_accounts a ON a.user_id = u.id WHERE a.profile IS NULL LIMIT 3').all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare("SELECT DISTINCT x.user_id AS id FROM drive_docs x LEFT JOIN docs d ON d.user_id = x.user_id AND d.path = x.path WHERE d.path IS NULL LIMIT 2").all()).results.forEach(r => ids.add(r.id));
  (await env.DB.prepare("SELECT a.user_id AS id FROM drive_accounts a WHERE a.folder IS NOT NULL AND EXISTS (SELECT 1 FROM docs d WHERE d.user_id = a.user_id AND substr(d.updated, 1, 10) > COALESCE(a.backup_day, '')) LIMIT 2").all()).results.forEach(r => ids.add(r.id));
  for (const id of ids) { if (B.n <= 6) break; await syncUser(env, id, B); }
}

const profile = u => ({ id: u.id, email: u.email, firstName: u.first || '', lastName: u.last || '' });

/* What each area holds, for the account page: how many documents and when they were last saved. */
async function summary(env, uid) {
  const { results } = await env.DB.prepare("SELECT substr(path, 1, instr(path, '/') - 1) AS lang, COUNT(*) AS n, MAX(updated) AS updated FROM docs WHERE user_id = ? GROUP BY lang").bind(uid).all();
  return results;
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
    if (text.length > (url.pathname === '/api/doc' || url.pathname === '/api/ai' || url.pathname === '/api/restore' ? MAX_DOC + 200000 : 20000)) return fail(413, 'That is too large.');
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
    if (password.length < 8 || password.length > 200) return fail(400, 'Choose a password of at least 8 characters.');
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
    if (!same(await hashPassword(password, u.salt), u.hash)) {
      const fails = u.fails + 1;
      await env.DB.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?').bind(fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 15 * 60000 : 0, u.id).run();
      return bad();
    }
    await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0 WHERE id = ?').bind(u.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
    return json(profile(u), 200, { 'Set-Cookie': await startSession(env, u.id) });
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
    if (password.length < 8 || password.length > 200) return fail(400, 'Choose a password of at least 8 characters.');
    const row = token && await env.DB.prepare('SELECT user_id FROM resets WHERE token_hash = ? AND expires > ?').bind(await sha(token), Date.now()).first();
    if (!row) return fail(400, 'This reset link has expired or was already used. Ask for a new one.');
    const salt = rand(16);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = 0 WHERE id = ?').bind(salt, await hashPassword(password, salt), row.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
      env.DB.prepare('DELETE FROM resets WHERE user_id = ?').bind(row.user_id),
    ]);
    return json({ ok: true });
  }

  const user = await currentUser(request, env);
  if (route === 'POST /api/logout') {
    const m = /(?:^|;\s*)dcc_session=([a-f0-9]{64})/.exec(request.headers.get('Cookie') || '');
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(m[1])).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  if (!user) return fail(401, 'Log in to continue.');

  if (route === 'GET /api/me') {
    const link = await env.DB.prepare('SELECT created FROM links WHERE user_id = ?').bind(user.id).first();
    const providers = aiList(env, await aiUsed(env, user.id)), owner = isOwner(env, user);
    return json({ ...profile(user), ai: (providers[0] || {}).id || 'none', providers, connector: link ? link.created : null, areas: await summary(env, user.id),
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
    const { results } = await env.DB.prepare('SELECT path, body FROM docs WHERE user_id = ? AND path LIKE ?').bind(user.id, lang + '/%').all();
    const docs = {}; for (const r of results) { try { docs[r.path] = JSON.parse(r.body); } catch { } }
    return json({ now: Date.now(), docs });
  }
  if (url.pathname === '/api/doc' && (request.method === 'PUT' || request.method === 'DELETE')) {
    const path = url.searchParams.get('path') || '';
    if (!PATH_OK.test(path)) return fail(400, 'Bad path.');
    if (request.method === 'DELETE') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(user.id, path).run(); syncSoon(env, ctx, user.id); return json({ ok: true }); }
    const text = JSON.stringify(body); if (text.length > MAX_DOC) return fail(413, 'That is too large to save.');
    await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(user.id, path, text, new Date().toISOString()).run();
    syncSoon(env, ctx, user.id);
    return json({ ok: true });
  }
  if (route === 'POST /api/ai') {
    const out = await runAI(env, user, { input: body.input, tier: body.tier, provider: str(body.provider, 20).toLowerCase(), account: body.account === true, chat: body.chat === true });
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
    return new Response(JSON.stringify({ app: 'doctor-career-companion', account: user.email, saved: new Date().toISOString(), docs }, null, 1), { headers: {
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
      env.DB.prepare('DELETE FROM links WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
  }
  return fail(404, 'Not found.');
}

/* ---------- MCP connector at /mcp/<token> ----------
   A small Model Context Protocol server (JSON over HTTP POST). The token in the address is the only credential,
   so it is long, random, stored only as a hash, and can be replaced or switched off from the account page. */
const MCP_TOOLS = [
  { name: 'load_progress', description: "Load this physician's saved study and career record: the documents changed since `since` (milliseconds since 1970; 0 for everything), the list of every document path, and the server time to pass as `since` next time. `area` defaults to \"med\".",
    inputSchema: { type: 'object', properties: { area: { type: 'string' }, since: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'get_profile', description: "The account's first name, last name and email, and how much is saved.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'save_doc', description: "Save one document, replacing what was there. The path starts with the area, e.g. med/state or med/bank_cv.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, body: { type: 'object' } }, required: ['path', 'body'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_doc', description: "Delete one document, e.g. an old lesson removed in the app.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'ai_providers', description: "Which AI services this account can ask through the website's server (Gemini, Llama, Claude) and how many requests each has left today.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'ask_ai', description: "Ask one of the website's AI services instead of Claude. `input` is the prompt, or a list of {role, content} messages. `provider` is gemini, llama, claude or auto. `tier` is quick or default. `account` true lets the service look up this account's own record and the reference library while it answers. `chat` true marks a conversational question; only those may be answered by llama.",
    inputSchema: { type: 'object', properties: { input: {}, provider: { type: 'string' }, tier: { type: 'string' }, account: { type: 'boolean' }, chat: { type: 'boolean' } }, required: ['input'] }, annotations: { readOnlyHint: true } },
  { name: 'storage_status', description: "How much of this account's record has been copied to its own folder in Google Drive, and when.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'library_status', description: "Whether this account may read the reference library that is shared with the Doctor Career Companion website.",
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'library_file', description: "One slice of a file in the reference library (a guideline PDF), base64 encoded, for the app's PDF reader. Start at `offset` 0 and continue from offset + length until `done` is true.",
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, offset: { type: 'number' } }, required: ['fileId'] }, annotations: { readOnlyHint: true } },
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
      const { results } = await env.DB.prepare('SELECT path, body, updated FROM docs WHERE user_id = ? AND path LIKE ?').bind(uid, lang + '/%').all();
      for (const r of results) { paths.push(r.path); if (!since || Date.parse(r.updated) > since) { try { docs[r.path] = JSON.parse(r.body); } catch { } } }
      return out({ now: Date.now(), area: lang, paths, docs });
    }
    if (name === 'get_profile') {
      const u = await env.DB.prepare('SELECT first, last, email FROM users WHERE id = ?').bind(uid).first();
      return out({ firstName: (u && u.first) || '', lastName: (u && u.last) || '', email: (u && u.email) || '', areas: await summary(env, uid) });
    }
    if (name === 'ai_providers' || name === 'ask_ai' || name === 'storage_status') {
      const u = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(uid).first(); if (!u) return bad('This account no longer exists.');
      if (name === 'storage_status') return out(await storage(env, u));
      if (name === 'ai_providers') return out({ providers: aiList(env, await aiUsed(env, uid)) });
      const r = await runAI(env, u, { input: a.input, tier: a.tier, provider: String(a.provider || '').toLowerCase(), account: a.account === true, chat: a.chat === true });
      return r.status === 200 ? out({ ...r, status: undefined }) : out({ error: r.error, code: r.status === 429 ? 'rate_limited' : 'upstream_error' });
    }
    if (name === 'library_status' || name === 'library_file') {
      const u = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(uid).first(), on = !!u && libraryOn(env, u);
      if (name === 'library_status') return out({ library: on, why: u ? libraryWhy(env, u) : '', serviceAccount: '' });
      if (!on) return bad('The reference library is not turned on for this account.');
      try { return out(await driveSlice(env, fileId(a.fileId), a.offset)); } catch (e) { if (e instanceof LibError) return bad(e.message); throw e; }
    }
    const path = String(a.path || '');
    if (!PATH_OK.test(path)) return bad('That is not a valid document path. It must start with the area, like med/state.');
    if (name === 'save_doc') {
      if (!a.body || typeof a.body !== 'object' || Array.isArray(a.body)) return bad('The document must be an object.');
      const body = JSON.stringify(a.body); if (body.length > MAX_DOC) return bad('That document is too large to save.');
      await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(uid, path, body, new Date().toISOString()).run();
      syncSoon(env, ctx, uid);
      return out({ ok: true });
    }
    if (name === 'delete_doc') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(uid, path).run(); syncSoon(env, ctx, uid); return out({ ok: true }); }
    return err(-32602, 'Unknown tool');
  };
  if (Array.isArray(msg)) { const r = (await Promise.all(msg.map(one))).filter(Boolean); return r.length ? json(r) : new Response(null, { status: 202 }); }
  const r = await one(msg); return r ? json(r) : new Response(null, { status: 202 });
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(sweep(env).catch(e => console.error(e))); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/mcp/')) {
      try { return await mcpServer(request, env, url.pathname.slice(5).replace(/\/+$/, ''), ctx); }
      catch (e) { console.error(e); return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server error' } }, 500); }
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url, ctx); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    return env.ASSETS.fetch(request);
  },
};
