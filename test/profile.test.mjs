// Editing the profile after sign-up (account standard): PUT /api/profile changes only the fields sent (names, gender, date of birth),
// never passwords; demographics stay in D1, never in the Drive account file; the connector's get_profile shows them read only; the
// app's Profile edits them on the website and links to the website inside Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { raw: db, prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const DB = d1();
const env = { DB };
const ctx = { waitUntil: p => { Promise.resolve(p).catch(() => { }); } };
const O = 'https://dcc.example';
const call = (path, { method = 'GET', headers = {}, body } = {}) => worker.fetch(new Request(O + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
const sessionOf = r => { const c = r.headers.getSetCookie().find(x => /^dcc_session=[a-f0-9]{64}/.test(x)); return c ? c.split(';')[0] : ''; };
const Q = 'What was the name of your first pet?';
let cookie = '';
const put = body => call('/api/profile', { method: 'PUT', body, headers: { Cookie: cookie } });
const me = async () => (await call('/api/me', { headers: { Cookie: cookie } })).json();

test('PUT /api/profile changes only the fields sent', async () => {
  const r = await call('/api/signup', { method: 'POST', body: { firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com', password: 'longenough1', confirm: 'longenough1', question: Q, answer: 'Rex', gender: 'woman', dob: '1990-05-01' } });
  assert.equal(r.status, 200); cookie = sessionOf(r);
  assert.equal((await call('/api/profile', { method: 'PUT', body: { firstName: 'X' } })).status, 401);   // signed in only
  let x = await put({ dob: '1991-06-02' }); assert.equal(x.status, 200);
  let m = await me(); assert.equal(m.dob, '1991-06-02'); assert.equal(m.gender, 'woman'); assert.equal(m.firstName, 'Ana'); assert.equal(m.lastName, 'Cruz');
  x = await put({ gender: 'self', genderSelf: 'Agender' }); assert.equal(x.status, 200);
  const j = await x.json(); assert.equal(j.gender, 'self'); assert.equal(j.genderSelf, 'Agender'); assert.equal(j.dob, '1991-06-02');
  x = await put({ firstName: '  Anabel ', lastName: 'Cruz Diaz' }); assert.equal(x.status, 200);
  m = await me(); assert.equal(m.firstName, 'Anabel'); assert.equal(m.lastName, 'Cruz Diaz'); assert.equal(m.gender, 'self'); assert.equal(m.genderSelf, 'Agender');
  /* Prefer not to say, and clearing the date of birth. */
  x = await put({ gender: '', dob: '' }); assert.equal(x.status, 200);
  m = await me(); assert.equal(m.gender, ''); assert.equal(m.genderSelf, ''); assert.equal(m.dob, ''); assert.equal(m.setup.complete, true);
});

test('names cannot be emptied, demographics are checked, passwords are never changed here', async () => {
  for (const [b, why] of [[{ firstName: '' }, /first name/], [{ lastName: '   ' }, /last name/], [{ gender: 'robot' }, /gender/], [{ dob: '2999-01-01' }, /date of birth/],
    [{ dob: '2001-02-30' }, /date of birth/], [{ dob: '01/02/1990' }, /date of birth/], [{}, /Nothing to change/], [{ password: 'newpassword9', confirm: 'newpassword9' }, /Passwords/]]) {
    const x = await put(b); assert.equal(x.status, 400, JSON.stringify(b)); assert.match((await x.json()).error, why);
  }
  const m = await me(); assert.equal(m.firstName, 'Anabel'); assert.equal(m.lastName, 'Cruz Diaz');
  /* The password still works, and a refused request with a name did not change the name either. */
  assert.equal((await put({ firstName: 'Zed', password: 'x' })).status, 400); assert.equal((await me()).firstName, 'Anabel');
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: 'longenough1' } })).status, 200);
  const cross = await call('/api/profile', { method: 'PUT', body: { firstName: 'Evil' }, headers: { Cookie: cookie, Origin: 'https://evil.example' } }); assert.equal(cross.status, 403);
});

test('demographics stay in D1, never in the Drive account file; the connector shows them read only', async () => {
  await put({ gender: 'nonbinary', dob: '1988-03-04' });
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const i = src.indexOf('const accountFile = u =>'), af = src.slice(i, src.indexOf('\n', src.indexOf('\n', i) + 1));
  assert.ok(af.length > 20); assert.doesNotMatch(af, /gender|dob/);
  const row = DB.raw.prepare('SELECT gender, dob FROM users WHERE email = ?').get('ana@example.com'); assert.equal(row.gender, 'nonbinary'); assert.equal(row.dob, '1988-03-04');
  const l = await call('/api/connector', { method: 'POST', body: {}, headers: { Cookie: cookie } }); const url = (await l.json()).url; assert.ok(url);
  const mcp = (name, args = {}) => call(new URL(url).pathname, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }).then(r => r.json());
  const p = (await mcp('get_profile')).result.structuredContent;
  assert.equal(p.gender, 'nonbinary'); assert.equal(p.dob, '1988-03-04'); assert.equal(p.firstName, 'Anabel');
  const tools = (await call(new URL(url).pathname, { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } }).then(r => r.json())).result.tools.map(t => t.name);
  assert.ok(!tools.includes('update_profile'), 'no new connector tool: the Claude copy shows the profile read only');
  assert.equal((await call('/api/profile', { method: 'PUT', body: { firstName: 'Nope' } })).status, 401);
});

/* The app's Profile block, run against a tiny stand-in for the document. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function appBlock(web) {
  const html = readFileSync(new URL('../app/companion.html', import.meta.url), 'utf8');
  const a = html.indexOf('let PFEDIT=false'), b = html.indexOf('const ROLEN=');
  assert.ok(a > 0 && b > a);
  const on = {}, els = {}, calls = { fetch: [], toast: [], render: 0 };
  const document = { addEventListener: (t, f) => { (on[t] = on[t] || []).push(f); }, getElementById: id => els[id] || null };
  const FINGEN = [['', 'Prefer not to say'], ['woman', 'Woman'], ['man', 'Man'], ['nonbinary', 'Non-binary'], ['self', 'Prefer to self-describe']];
  const run = new Function('document', 'esc', 'WEB', 'FINGEN', 'acctLink', 'render', 'toast', 'fetch', 'location',
    `let PROF={firstName:'Ana',lastName:'Cruz',gender:'woman',genderSelf:'',dob:'1990-05-01'},FINME=null;${html.slice(a, b)}; return { profDetails, profSave, get prof(){return PROF}, get edit(){return PFEDIT}, setEdit(v){PFEDIT=v}, get draft(){return PFD} };`);
  const api = run(document, esc, web, FINGEN, t => `<a href="https://dcc.example/account.html" target="_blank">${t}</a>`, () => calls.render++, t => calls.toast.push(t),
    async (url, init) => { calls.fetch.push([url, init.method, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true, firstName: 'Anna', lastName: 'Cruz', gender: '', genderSelf: '', dob: '' }) }; },
    { replace() { throw new Error('no redirect'); } });
  return { api, on, els, calls };
}
const P = { firstName: 'Ana', lastName: 'Cruz', gender: 'woman', genderSelf: '', dob: '1990-05-01' };

test('the app Profile edits the details on the website and saves only through PUT /api/profile', async () => {
  const { api, on, calls } = appBlock(true);
  const view = api.profDetails(P); assert.match(view, /Your details/); assert.match(view, /Woman/); assert.match(view, /1990-05-01/); assert.match(view, /data-pfact="edit"/);
  on.click.forEach(f => f({ target: { closest: s => s === '[data-pfact]' ? { dataset: { pfact: 'edit' } } : null }, preventDefault() { }, stopPropagation() { } }));
  assert.equal(api.edit, true);
  const form = api.profDetails(P); assert.match(form, /id="pf-first"[^>]*value="Ana"/); assert.match(form, /id="pf-gender"/); assert.match(form, /id="pf-dob"[^>]*type="date"/); assert.doesNotMatch(form, /password/i);
  const d = api.draft; d.first = 'Anna'; d.gender = ''; d.dob = '';
  await api.profSave();
  assert.deepEqual(calls.fetch[0], ['/api/profile', 'PUT', { firstName: 'Anna', lastName: 'Cruz', gender: '', genderSelf: '', dob: '' }]);
  assert.equal(api.edit, false); assert.equal(api.prof.firstName, 'Anna'); assert.deepEqual(calls.toast, ['Saved.']);
  /* An emptied name never reaches the server. */
  const b = appBlock(true); b.api.setEdit(true); b.api.profDetails(P); b.api.draft.last = ' '; b.els['pf-msg'] = { innerHTML: '' };
  await b.api.profSave(); assert.equal(b.calls.fetch.length, 0); assert.match(b.els['pf-msg'].innerHTML, /first and last name/);
});

test('inside Claude the details are read only, with a link to the website', () => {
  const { api } = appBlock(false);
  api.setEdit(true);
  const v = api.profDetails(P);
  assert.doesNotMatch(v, /data-pfact="edit"/); assert.doesNotMatch(v, /id="pf-first"/);
  assert.match(v, /Woman/); assert.match(v, /account\.html" target="_blank"/);
});

test('the account page has a profile card that saves with PUT /api/profile', () => {
  const html = readFileSync(new URL('../public/account.html', import.meta.url), 'utf8');
  assert.match(html, /function profileCard\(\)/); assert.match(html, /\$\{profileCard\(\)\}/);
  assert.match(html, /api\('PUT','\/api\/profile',\{firstName:v\('pffirst'\),lastName:v\('pflast'\),\.\.\.demoBody\('pf'\)\}\)/);
});
