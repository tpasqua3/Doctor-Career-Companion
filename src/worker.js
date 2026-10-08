// Doctor Career Companion server: accounts and each physician's study record in Cloudflare D1.
// The app runs inside Claude and reaches this server through the connector at /mcp/<token>; the website at / uses /api/*.
// Every document path starts with an area prefix (med/ holds the whole study and career record).
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

const SESSION_DAYS = 30, MAX_DOC = 250000;
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
/* ---------- The app's AI on the website ----------
   Inside Claude the app uses Claude itself. On the website it asks this server, which uses Claude when an ANTHROPIC_API_KEY secret
   is set and otherwise Cloudflare Workers AI (the AI binding), trying a short list of models in order. A daily allowance per account
   keeps the cost bounded (AI_DAILY, default 200 requests). */
const AI_MODELS = { quick: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8'],
  default: ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8'] };
const AI_SYSTEM = 'You are the teaching engine of Doctor Career Companion, a continuing medical education and career development app for one practicing physician. Write at attending level. Base clinical statements on current guidelines from the major professional societies and name the guideline and year. Never invent a citation, statistic, dose or threshold: when unsure, say so plainly. Follow the instructions in the messages exactly. When asked for JSON, reply with only valid JSON: no prose before or after it and no code fences.';
function aiText(r) {
  if (!r) return '';
  const flat = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : (x && (x.type === 'output_text' || x.type === 'text') && x.text) || '').join('') : '';
  const t = typeof r === 'string' ? r : flat(r.response) || flat(r.output_text) || flat(r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content)
    || (Array.isArray(r.output) ? r.output.filter(o => o && o.type === 'message').map(o => flat(o.content)).join('\n') : '') || flat(r.result && r.result.response);
  return String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
async function aiReply(env, messages, tier) {
  if (env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 8000, system: AI_SYSTEM, messages }) });
    if (!r.ok) throw new Error('ai upstream ' + r.status);
    const j = await r.json();
    return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim(), model: j.model || 'claude' };
  }
  if (!env.AI) return { text: '', model: '' };
  for (const model of [env.AI_MODEL, ...(AI_MODELS[tier] || AI_MODELS.default)].filter(Boolean)) {
    try { const text = aiText(await env.AI.run(model, { messages: [{ role: 'system', content: AI_SYSTEM }, ...messages], max_tokens: 8000 })); if (text) return { text, model: model.split('/').pop() }; }
    catch (e) { console.error('ai model failed: ' + model, e); }
  }
  return { text: '', model: '' };
}

const profile = u => ({ id: u.id, email: u.email, firstName: u.first || '', lastName: u.last || '' });

/* What each area holds, for the account page: how many documents and when they were last saved. */
async function summary(env, uid) {
  const { results } = await env.DB.prepare("SELECT substr(path, 1, instr(path, '/') - 1) AS lang, COUNT(*) AS n, MAX(updated) AS updated FROM docs WHERE user_id = ? GROUP BY lang").bind(uid).all();
  return results;
}

async function api(request, env, url) {
  const route = request.method + ' ' + url.pathname;
  if (request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return fail(403, 'Cross-site request refused.');
  }
  let body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    const text = await request.text();
    if (text.length > (url.pathname === '/api/doc' || url.pathname === '/api/ai' || url.pathname === '/api/restore' ? 2 * MAX_DOC : 20000)) return fail(413, 'That is too large.');
    try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'Bad request.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Bad request.');
  }
  await init(env);

  if (route === 'POST /api/signup') {
    const email = str(body.email, 200).toLowerCase(), password = typeof body.password === 'string' ? body.password : '';
    const first = str(body.firstName, 60), last = str(body.lastName, 60);
    if (!first) return fail(400, 'Enter your first name.');
    if (!EMAIL_OK.test(email)) return fail(400, 'Enter a valid recovery email address.');
    if (password.length < 8 || password.length > 200) return fail(400, 'Choose a password of at least 8 characters.');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) return fail(409, 'An account with that email already exists. Log in instead.');
    const id = rand(16), salt = rand(16);
    await env.DB.prepare('INSERT INTO users (id, email, salt, hash, first, last, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, salt, await hashPassword(password, salt), first, last, new Date().toISOString()).run();
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
    return json({ ...profile(user), connector: link ? link.created : null, areas: await summary(env, user.id) });
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
    if (request.method === 'DELETE') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(user.id, path).run(); return json({ ok: true }); }
    const text = JSON.stringify(body); if (text.length > MAX_DOC) return fail(413, 'That is too large to save.');
    await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(user.id, path, text, new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (route === 'POST /api/ai') {
    const tier = body.tier === 'quick' ? 'quick' : 'default';
    let messages = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : [];
    messages = messages.slice(-40).map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: typeof (m && m.content) === 'string' ? m.content.slice(0, 60000) : '' })).filter(m => m.content);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return fail(400, 'Nothing to answer.');
    const cap = Number(env.AI_DAILY) || 200, day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare('SELECT n FROM usage WHERE user_id = ? AND day = ?').bind(user.id, day).first();
    if (row && row.n >= cap) return fail(429, `You've used today's ${cap} AI requests on the website. They reset tomorrow, or use the app inside Claude, which has no daily limit here.`);
    await env.DB.prepare('INSERT INTO usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1').bind(user.id, day).run();
    let out = { text: '', model: '' };
    try { out = await aiReply(env, messages, tier); } catch (e) { console.error(e); }
    if (!out.text) return fail(502, 'The AI could not answer just now. Try again in a moment.');
    return json({ text: out.text, model: out.model, left: cap - ((row && row.n) || 0) - 1 });
  }
  /* Everything this account holds, for a backup file. */
  if (route === 'GET /api/backup') {
    const { results } = await env.DB.prepare('SELECT path, body, updated FROM docs WHERE user_id = ?').bind(user.id).all();
    const docs = {}; for (const r of results) { try { docs[r.path] = JSON.parse(r.body); } catch { } }
    return new Response(JSON.stringify({ app: 'doctor-career-companion', account: user.email, saved: new Date().toISOString(), docs }, null, 1), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="doctor-career-companion-backup-${new Date().toISOString().slice(0, 10)}.json"` } });
  }
  if (route === 'DELETE /api/account') {
    await env.DB.batch([
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
];
async function mcpServer(request, env, token) {
  if (request.method !== 'POST') return new Response('This address is for the Doctor Career Companion connector in Claude.', { status: 405, headers: { Allow: 'POST' } });
  await init(env);
  const link = /^[a-f0-9]{64}$/.test(token) ? await env.DB.prepare('SELECT user_id FROM links WHERE token_hash = ?').bind(await sha(token)).first() : null;
  if (!link) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This connector link is not valid. Make a new one on the Doctor Career Companion account page.' } }, 401);
  const text = await request.text();
  if (text.length > 2 * MAX_DOC) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, 413);
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
    const path = String(a.path || '');
    if (!PATH_OK.test(path)) return bad('That is not a valid document path. It must start with the area, like med/state.');
    if (name === 'save_doc') {
      if (!a.body || typeof a.body !== 'object' || Array.isArray(a.body)) return bad('The document must be an object.');
      const body = JSON.stringify(a.body); if (body.length > MAX_DOC) return bad('That document is too large to save.');
      await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(uid, path, body, new Date().toISOString()).run();
      return out({ ok: true });
    }
    if (name === 'delete_doc') { await env.DB.prepare('DELETE FROM docs WHERE user_id = ? AND path = ?').bind(uid, path).run(); return out({ ok: true }); }
    return err(-32602, 'Unknown tool');
  };
  if (Array.isArray(msg)) { const r = (await Promise.all(msg.map(one))).filter(Boolean); return r.length ? json(r) : new Response(null, { status: 202 }); }
  const r = await one(msg); return r ? json(r) : new Response(null, { status: 202 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/mcp/')) {
      try { return await mcpServer(request, env, url.pathname.slice(5).replace(/\/+$/, '')); }
      catch (e) { console.error(e); return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server error' } }, 500); }
    }
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    return env.ASSETS.fetch(request);
  },
};
