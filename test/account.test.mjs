// Standard account creation, setup and recovery (spec /specs/account_standard.md): the sign-up form's rules, codes retired, setup for
// accounts made by Google or Life OS (and older incomplete ones), never blocking them (section 7), forgot password by the security question (setting a first
// password too), the steady decoy for unknown emails, and the name fallback kept only for older accounts with no question.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const env = { DB, GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', SIGNUP_CODE: 'old-code' };
const ctx = { waitUntil: p => { Promise.resolve(p).catch(() => { }); } };
const O = 'https://dcc.example';
const call = (path, { method = 'GET', headers = {}, body } = {}) => worker.fetch(new Request(O + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
const post = (path, body, headers) => call(path, { method: 'POST', body, headers });
const sessionOf = r => { const c = r.headers.getSetCookie().find(x => /^dcc_session=[a-f0-9]{64}/.test(x)); return c ? c.split(';')[0] : ''; };
const Q = 'What was the name of your first pet?';
const full = (o = {}) => ({ firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com', password: 'longenough1', confirm: 'longenough1', question: Q, answer: 'Rex', ...o });

test('sign-up requires the standard fields, with clear messages; a code a request still sends is ignored', async () => {
  for (const [o, why] of [[{ firstName: '' }, /first name/], [{ lastName: '' }, /last name/], [{ email: 'x' }, /valid email/], [{ password: 'short', confirm: 'short' }, /at least 8/],
    [{ confirm: 'different1' }, /do not match/], [{ question: '' }, /security question/], [{ question: 'Who am I?' }, /security question/], [{ answer: '' }, /answer/],
    [{ gender: 'robot' }, /gender/], [{ dob: '2999-01-01' }, /date of birth/], [{ dob: '2001-02-30' }, /date of birth/]]) {
    const r = await post('/api/signup', full(o)); assert.equal(r.status, 400, JSON.stringify(o)); assert.match((await r.json()).error, why);
  }
  const r = await post('/api/signup', full({ code: 'wrong-or-none', gender: 'self', genderSelf: 'Agender', dob: '1990-05-01' }));
  assert.equal(r.status, 200); assert.ok(sessionOf(r));
  const me = await (await call('/api/me', { headers: { Cookie: sessionOf(r) } })).json();
  assert.equal(me.setup.complete, true); assert.deepEqual(me.recovery, [Q]); assert.equal(me.gender, 'self'); assert.equal(me.genderSelf, 'Agender'); assert.equal(me.dob, '1990-05-01');
  const row = DB.raw.prepare("SELECT hash FROM recovery WHERE question = ?").get(Q); assert.ok(row.hash && row.hash !== 'rex');   // the answer only as a hash
  /* Without any code or demographics at all (prefer not to say). */
  const r2 = await post('/api/signup', full({ email: 'bo@example.com' })); assert.equal(r2.status, 200);
  const me2 = await (await call('/api/me', { headers: { Cookie: sessionOf(r2) } })).json(); assert.equal(me2.gender, ''); assert.equal(me2.dob, '');
});

const hub = body => post('/api/lifeos/sso', body, { 'x-lifeos-hub': 'binding' });
let gcookie = '';
test('a Life OS ticket for a new email creates the account, which reports setup in the frame and is never blocked', async () => {
  const t = await (await hub({ op: 'ticket', email: 'new@example.com', verified: 'google', name: 'Nia Park', create: true })).json();
  assert.equal(t.ok, true); assert.equal(t.created, true);
  const r = await call('/auth/lifeos?code=' + t.code + '&to=/', { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(r.status, 302); assert.match(r.headers.getSetCookie()[0], /Partitioned/);
  gcookie = sessionOf(r);
  const me = await (await call('/api/me', { headers: { Cookie: gcookie } })).json();
  assert.equal(me.setup.complete, false); assert.deepEqual(me.setup.missing, ['password', 'question']); assert.equal(me.firstName, 'Nia'); assert.equal(me.lastName, 'Park');
  for (const [m, path] of [['GET', '/api/progress?area=med'], ['PUT', '/api/doc'], ['POST', '/api/connector'], ['POST', '/api/mkos/asset_find'], ['POST', '/api/password']]) {
    const x = await call(path, { method: m, headers: { Cookie: gcookie }, body: m === 'GET' ? undefined : {} });
    assert.notEqual(x.status, 401, path); assert.notEqual(x.status, 403, path); assert.equal((await x.json()).setup, undefined, path);
  }
  assert.equal((await call('/api/progress?area=med', { headers: { Cookie: gcookie } })).status, 200);   // the app works while incomplete
  /* The connector (the Claude copy) reports that setup is still needed, and sets no password. */
  const { link } = await (await hub({ op: 'ticket', email: 'new@example.com', verified: 'google', want_link: true })).json();
  const mcp = await post('/mcp/' + link, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_profile', arguments: {} } });
  assert.match(await mcp.text(), /"complete":false/);
});

test('setup validates, saves everything at once, and then the account logs in with its password', async () => {
  const bad = [[{ lastName: '' }, /last name/], [{ confirm: 'nope-nope' }, /do not match/], [{ password: '' }, /at least 8/], [{ question: '' }, /security question/], [{ dob: 'soon' }, /date of birth/]];
  const ok = { firstName: 'Nia', lastName: 'Park', password: 'nia-password', confirm: 'nia-password', question: Q, answer: 'Milo', gender: 'woman', dob: '1988-03-04' };
  for (const [o, why] of bad) { const r = await post('/api/account/setup', { ...ok, ...o }, { Cookie: gcookie }); assert.equal(r.status, 400); assert.match((await r.json()).error, why); }
  const r = await post('/api/account/setup', ok, { Cookie: gcookie });
  assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.setup.complete, true); assert.equal(j.password, true);
  assert.equal((await call('/api/progress?area=med', { headers: { Cookie: gcookie } })).status, 200);   // this session stayed signed in
  const l = await post('/api/login', { email: 'new@example.com', password: 'nia-password' }); assert.equal(l.status, 200);
  const me = await (await call('/api/me', { headers: { Cookie: sessionOf(l) } })).json(); assert.equal(me.gender, 'woman'); assert.deepEqual(me.recovery, [Q]);
});

test('forgot password sets a password for a password-less account that has a question; then it can log in', async () => {
  await hub({ op: 'ticket', email: 'gq@example.com', verified: 'google', name: 'Gus Q', create: true });
  const u = DB.raw.prepare("SELECT id FROM users WHERE email = 'gq@example.com'").get();
  const t = await (await hub({ op: 'ticket', email: 'gq@example.com', verified: 'google' })).json();
  const c = sessionOf(await call('/auth/lifeos?code=' + t.code));
  assert.equal((await call('/api/progress?area=med', { headers: { Cookie: c } })).status, 200);   // never blocked while incomplete
  /* A question but still no password (as one set on the account page before the standard would be): copy a known answer hash. */
  await post('/api/signup', full({ email: 'tmp@example.com', answer: 'Spot' }));
  const row = DB.raw.prepare("SELECT r.salt, r.hash FROM recovery r JOIN users x ON x.id = r.user_id WHERE x.email = 'tmp@example.com'").get();
  DB.raw.prepare('INSERT INTO recovery (user_id, slot, question, salt, hash) VALUES (?, 0, ?, ?, ?)').run(u.id, Q, row.salt, row.hash);
  const q = await (await post('/api/forgot/questions', { email: 'gq@example.com' })).json();
  assert.equal(q.question, Q); assert.equal(q.password, false);   // the page says "Set a password"
  assert.equal((await post('/api/forgot/direct', { email: 'gq@example.com', question: Q, answer: 'spot!', password: 'gus-password', confirm: 'other-pass' })).status, 400);
  assert.equal((await post('/api/forgot/direct', { email: 'gq@example.com', question: Q, answer: 'wrong', password: 'gus-password', confirm: 'gus-password' })).status, 401);
  assert.equal((await post('/api/forgot/direct', { email: 'gq@example.com', question: Q, answer: ' SPOT ', password: 'gus-password', confirm: 'gus-password' })).status, 200);
  assert.equal((await call('/api/me', { headers: { Cookie: c } })).status, 401);   // old sessions ended
  const l = await post('/api/login', { email: 'gq@example.com', password: 'gus-password' }); assert.equal(l.status, 200);
  assert.equal((await (await call('/api/me', { headers: { Cookie: sessionOf(l) } })).json()).setup.complete, true);
});

test('an unknown email gets the same steady decoy question, and the same answers as a real account', async () => {
  const a = await (await post('/api/forgot/questions', { email: 'nobody@example.com' })).json();
  const b = await (await post('/api/forgot/questions', { email: 'nobody@example.com' })).json();
  assert.ok(a.question); assert.equal(a.question, b.question); assert.equal(a.password, true); assert.deepEqual(Object.keys(a).sort(), ['password', 'question', 'questions']);
  const real = await (await post('/api/forgot/questions', { email: 'ana@example.com' })).json();
  assert.deepEqual(Object.keys(real).sort(), Object.keys(a).sort());
  const r = await post('/api/forgot/direct', { email: 'nobody@example.com', question: a.question, answer: 'anything', password: 'whatever-pw', confirm: 'whatever-pw' });
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'That answer is not right.');
});

test('an older account with no question: name fallback still resets it, and setup asks for the question at its next login', async () => {
  await post('/api/signup', full({ email: 'old@example.com', firstName: 'Olga', lastName: 'Old' }));
  const u = DB.raw.prepare("SELECT id FROM users WHERE email = 'old@example.com'").get();
  DB.raw.prepare('DELETE FROM recovery WHERE user_id = ?').run(u.id);
  const q = await (await post('/api/forgot/questions', { email: 'old@example.com' })).json(); assert.equal(q.names, true);
  assert.equal((await post('/api/forgot/direct', { email: 'old@example.com', firstName: 'Olga', lastName: 'Wrong', password: 'olga-password', confirm: 'olga-password' })).status, 401);
  assert.equal((await post('/api/forgot/direct', { email: 'old@example.com', firstName: 'olga', lastName: 'OLD', password: 'olga-password', confirm: 'olga-password' })).status, 200);
  const l = await post('/api/login', { email: 'old@example.com', password: 'olga-password' }); const c = sessionOf(l);
  const me = await (await call('/api/me', { headers: { Cookie: c } })).json(); assert.deepEqual(me.setup.missing, ['question']);
  assert.equal((await call('/api/progress?area=med', { headers: { Cookie: c } })).status, 200);   // never blocked
  const s = await post('/api/account/setup', { question: Q, answer: 'Fido' }, { Cookie: c });   // only what is missing: no password asked again
  assert.equal(s.status, 200); assert.equal((await s.json()).setup.complete, true);
  assert.equal((await call('/api/progress?area=med', { headers: { Cookie: c } })).status, 200);
  assert.equal((await call('/api/recovery', { method: 'PUT', headers: { Cookie: c }, body: { current: 'olga-password', items: [] } })).status, 400);   // at least one stays
});
