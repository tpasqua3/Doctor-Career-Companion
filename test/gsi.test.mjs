// Sign in with Google and Life OS single sign-on (Phase 8): the binding gate, tickets, the Google account rule, password-less
// accounts, the reused Drive callback and One Tap's checks. The worker runs on an in-memory SQLite stand-in for D1; Google is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';
import { checkClaims, verifyIdToken, resetKeys, safePath } from '../src/gsi.js';

/* A small D1: prepare/bind/first/all/run and batch, over node:sqlite. */
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
const CLIENT = 'client-123.apps.googleusercontent.com';
const env = { DB, GOOGLE_OAUTH_CLIENT_ID: CLIENT, GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };
const ctx = { waitUntil: p => { Promise.resolve(p).catch(() => { }); } };
const O = 'https://dcc.example';
const call = (path, { method = 'GET', headers = {}, body, e = env } = {}) => worker.fetch(new Request(O + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
const hub = { 'x-lifeos-hub': 'binding' };
const sso = (body, e) => call('/api/lifeos/sso', { method: 'POST', headers: hub, body, e });
const sessionOf = r => { const c = r.headers.getSetCookie().find(x => /^dcc_session=[a-f0-9]{64}/.test(x)); return c ? c.split(';')[0] : ''; };
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const claims = (o = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-1', email: 'ann@example.com', email_verified: true, given_name: 'Ann', family_name: 'Lee', exp: Math.floor(Date.now() / 1000) + 600, ...o });

test('the hub route is refused with a visitor address or without the hub header', async () => {
  assert.equal((await call('/api/lifeos/sso', { method: 'POST', headers: { ...hub, 'cf-connecting-ip': '203.0.113.9' }, body: { op: 'ticket', link: 'a'.repeat(64) } })).status, 404);
  assert.equal((await call('/api/lifeos/sso', { method: 'POST', body: { op: 'ticket', link: 'a'.repeat(64) } })).status, 404);
  assert.equal((await call('/api/lifeos/sso', { method: 'POST', headers: { 'x-lifeos-hub': 'nope' }, body: { op: 'ticket' } })).status, 404);
  assert.equal((await sso({ op: 'ticket', link: 'a'.repeat(64) })).status, 404);   // through the gate: an unknown link
});

let link = '', cookie = '';
test('the email path creates the account once, then reuses it; want_link makes a connector link', async () => {
  const r1 = await (await sso({ op: 'ticket', email: ' Hub@Example.com ', verified: 'google', name: 'Hal Bee', create: true, want_link: true })).json();
  assert.equal(r1.ok, true); assert.equal(r1.created, true); assert.match(r1.code, /^[a-f0-9]{64}$/); assert.match(r1.link, /^[a-f0-9]{64}$/);
  link = r1.link;
  const r2 = await (await sso({ op: 'ticket', email: 'hub@example.com', verified: 'google', create: true })).json();
  assert.equal(r2.ok, true); assert.equal(r2.created, false); assert.equal(r2.link, undefined);
  const u = DB.raw.prepare("SELECT * FROM users WHERE email = 'hub@example.com'").all();
  assert.equal(u.length, 1); assert.equal(u[0].hash, ''); assert.equal(u[0].first, 'Hal'); assert.equal(u[0].last, 'Bee'); assert.ok(u[0].google_linked);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM sso_tickets").get().n, 2);
  assert.equal(DB.raw.prepare('SELECT code_hash FROM sso_tickets').all().some(x => x.code_hash === r1.code), false);   // only the hash is kept
  assert.equal((await sso({ op: 'ticket', email: 'none@example.com', verified: 'google' })).status, 404);   // no create: none made
  assert.equal((await sso({ op: 'ticket', email: 'hub@example.com' })).status, 400);                       // not Google-verified
});

test('a ticket signs in once, in the frame with a partitioned cookie, and only to a same-origin path', async () => {
  const { code } = await (await sso({ op: 'ticket', link })).json();
  const r = await call('/auth/lifeos?code=' + code + '&to=/app?x=1', { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), O + '/app?x=1');
  const c = r.headers.getSetCookie()[0]; assert.match(c, /SameSite=None; Partitioned/); assert.match(c, /Secure/); assert.match(c, /HttpOnly/);
  cookie = sessionOf(r);
  const again = await call('/auth/lifeos?code=' + code + '&to=/app');
  assert.equal(again.headers.get('location'), O + '/'); assert.equal(again.headers.getSetCookie().length, 0);
  const t2 = (await (await sso({ op: 'ticket', link })).json()).code;
  const top = await call('/auth/lifeos?code=' + t2 + '&to=//evil.example/x');
  assert.equal(top.headers.get('location'), O + '/'); assert.match(top.headers.getSetCookie()[0], /SameSite=Lax/);
  const t3 = (await (await sso({ op: 'ticket', link })).json()).code;
  DB.raw.prepare('UPDATE sso_tickets SET expires = ?').run(Date.now() - 1);
  const old = await call('/auth/lifeos?code=' + t3);
  assert.equal(old.headers.get('location'), O + '/'); assert.equal(old.headers.getSetCookie().length, 0);
  assert.equal(safePath('/\\evil'), '/'); assert.equal(safePath('https://x'), '/'); assert.equal(safePath('/a/b?c=1'), '/a/b?c=1');
});

test('a password-less account: password login refused with the message; it finishes setup with a password, then has both', async () => {
  const me = await (await call('/api/me', { headers: { Cookie: cookie } })).json();
  assert.equal(me.email, 'hub@example.com'); assert.equal(me.password, false); assert.equal(me.setup.complete, false);
  const r = await call('/api/login', { method: 'POST', body: { email: 'hub@example.com', password: 'whatever1' } });
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'This account signs in with Google.');
  const nq = await call('/api/forgot/questions', { method: 'POST', body: { email: 'hub@example.com' } });   // no question yet: told to use Google
  assert.equal(nq.status, 403); assert.match((await nq.json()).error, /Sign in with Google with this email, then finish setting up/);
  assert.equal((await call('/api/account/setup', { method: 'POST', headers: { Cookie: cookie }, body: { firstName: 'Hal', lastName: 'Bee', password: 'brand-new-pw', confirm: 'brand-new-pw', question: 'What city were you born in?', answer: 'Rome' } })).status, 200);
  const ok = await call('/api/login', { method: 'POST', body: { email: 'hub@example.com', password: 'brand-new-pw', stay: false } });
  assert.equal(ok.status, 200); assert.doesNotMatch(ok.headers.get('set-cookie'), /Max-Age/);   // stay logged in off: a browser-session cookie
  assert.equal((await (await call('/api/me', { headers: { Cookie: cookie } })).json()).password, true);
});

test('sign-out clears the ordinary and the partitioned cookie', async () => {
  const { code } = await (await sso({ op: 'ticket', link })).json();
  const c = sessionOf(await call('/auth/lifeos?code=' + code, { headers: { 'sec-fetch-dest': 'iframe' } }));
  const out = (await call('/api/logout', { method: 'POST', headers: { Cookie: c } })).headers.getSetCookie();
  assert.equal(out.length, 2); assert.ok(out.some(x => /Partitioned/.test(x) && /Max-Age=0/.test(x))); assert.ok(out.some(x => /SameSite=Lax/.test(x) && /Max-Age=0/.test(x)));
  assert.equal((await call('/api/me', { headers: { Cookie: c } })).status, 401);
});

test('invitation codes are retired: a SIGNUP_CODE left set is ignored by Life OS creation', async () => {
  const gated = { ...env, SIGNUP_CODE: 'letmein' };
  const r = await sso({ op: 'ticket', email: 'gate@example.com', verified: 'google', create: true }, gated);
  assert.equal(r.status, 200); assert.equal((await r.json()).created, true);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'gate@example.com'").get().n, 1);
});

test('/auth/google starts at Google with the reused callback; in a frame it opens a new window', async () => {
  const r = await call('/auth/google?stay=0');
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(to.searchParams.get('redirect_uri'), O + '/api/google/callback'); assert.equal(to.searchParams.get('scope'), 'openid email profile');
  assert.equal(to.searchParams.get('prompt'), 'select_account'); assert.equal(to.searchParams.get('client_id'), CLIENT);
  const c = r.headers.getSetCookie()[0]; assert.match(c, new RegExp('^gsi_state=signin\\.0\\.' + to.searchParams.get('state') + ';')); assert.match(c, /Max-Age=600/);
  const f = await call('/auth/google', { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(f.status, 200); assert.match(await f.text(), /target="_blank"/);
  assert.deepEqual(await (await call('/api/auth/config')).json(), { google: true, client_id: CLIENT, redirect: true });
});

test('the callback still runs the Drive flow when gsi_state does not match', async () => {
  const real = globalThis.fetch; let asked = 0; globalThis.fetch = async () => { asked++; throw new Error('no network'); };
  try {
    const r = await call('/api/google/callback?state=' + 'b'.repeat(48) + '&code=x', { headers: { Cookie: 'gsi_state=signin.1.' + 'c'.repeat(48) + '; ' + cookie } });
    assert.equal(r.status, 302); assert.match(r.headers.get('location'), /\/account\.html\?drive=/);   // the Drive code's own answer
    const anon = await call('/api/google/callback?state=x&code=y');
    assert.equal(anon.status, 401);   // as before: the Drive callback needs a login
    assert.equal(asked, 0);
  } finally { globalThis.fetch = real; }
});

test('the callback signs in when gsi_state matches: creates once, links the Google account, updates a new sub', async () => {
  const real = globalThis.fetch; let sub = 'g-1', sent = null;
  globalThis.fetch = async (u, init) => { if (String(u) === 'https://oauth2.googleapis.com/token') { sent = String(init.body); return new Response(JSON.stringify({ id_token: b64u({ alg: 'RS256' }) + '.' + b64u(claims({ sub })) + '.' + b64u('sig') })); } throw new Error('unexpected ' + u); };
  try {
    const st = 'd'.repeat(48);
    const r = await call('/api/google/callback?state=' + st + '&code=abc', { headers: { Cookie: 'gsi_state=signin.1.' + st } });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), O + '/');
    assert.match(sent, /redirect_uri=https%3A%2F%2Fdcc\.example%2Fapi%2Fgoogle%2Fcallback/);
    const sc = r.headers.getSetCookie(); assert.ok(sc.some(x => /^gsi_state=;/.test(x))); assert.ok(sessionOf(r));
    const u = DB.raw.prepare("SELECT * FROM users WHERE email = 'ann@example.com'").get();
    assert.equal(u.hash, ''); assert.equal(u.first, 'Ann'); assert.match(u.google_sub, /^[a-f0-9]{64}$/); assert.notEqual(u.google_sub, 'g-1');
    sub = 'g-2';
    await call('/api/google/callback?state=' + st + '&code=abc', { headers: { Cookie: 'gsi_state=signin.1.' + st } });
    const u2 = DB.raw.prepare("SELECT * FROM users WHERE email = 'ann@example.com'").all();
    assert.equal(u2.length, 1); assert.notEqual(u2[0].google_sub, u.google_sub);
    const bad = await call('/api/google/callback?state=' + st + '&error=access_denied', { headers: { Cookie: 'gsi_state=signin.1.' + st } });
    assert.match(bad.headers.get('location'), /\/account\.html\?gsi=Google%20sign-in%20was%20cancelled/);
  } finally { globalThis.fetch = real; }
});

test('One Tap: the signature is checked against Google keys, then aud, email verification and expiry', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const sign = async (c, kid = 'k1') => { const h = b64u({ alg: 'RS256', kid }) + '.' + b64u(c); return h + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h))).toString('base64url'); };
  const real = globalThis.fetch; resetKeys();
  globalThis.fetch = async u => { if (String(u) === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] })); throw new Error('unexpected ' + u); };
  try {
    const tap = async credential => call('/auth/google/onetap', { method: 'POST', headers: { Origin: O }, body: { credential } });
    const ok = await tap(await sign(claims({ email: 'tap@example.com', sub: 't-1' })));
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, created: true }); assert.ok(sessionOf(ok));
    const again = await tap(await sign(claims({ email: 'TAP@example.com', sub: 't-1' })));
    assert.deepEqual(await again.json(), { ok: true, created: false });
    for (const [c, why] of [[claims({ aud: 'someone-else' }), /different app/], [claims({ email_verified: false }), /not verified/], [claims({ exp: Math.floor(Date.now() / 1000) - 5 }), /expired/], [claims({ iss: 'https://evil.example' }), /did not come from Google/]]) {
      const r = await tap(await sign(c)); assert.equal(r.status, 401); assert.match((await r.json()).error, why);
    }
    const forged = (await sign(claims())).replace(/\.[^.]+$/, '.' + Buffer.from('nope').toString('base64url'));
    assert.equal((await tap(forged)).status, 401);
    assert.equal((await tap(await sign(claims(), 'unknown-kid'))).status, 401);
    assert.equal((await call('/auth/google/onetap', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: { credential: 'x' } })).status, 403);
    await assert.rejects(verifyIdToken(await sign(claims()), 'other-client'), /different app/);
  } finally { globalThis.fetch = real; resetKeys(); }
  assert.throws(() => checkClaims(claims({ email: '' }), CLIENT), /email/);
  assert.equal(checkClaims(claims({ email: ' A@B.co ' }), CLIENT).email, 'a@b.co');
});

test('ordinary password sign-up and login keep working, stay logged in by default', async () => {
  const r = await call('/api/signup', { method: 'POST', headers: { Origin: O }, body: { firstName: 'Pat', lastName: 'Ray', email: 'pat@example.com', password: 'longenough1', confirm: 'longenough1', question: 'What was your childhood nickname?', answer: 'Patty' } });
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Max-Age=2592000/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'pat@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'pat@example.com', password: 'longenough1' } })).status, 200);
  /* From the page inside the Life OS frame the fetch is not a frame navigation, so the page says so: the cookie is partitioned. */
  const f = await call('/api/login', { method: 'POST', body: { email: 'pat@example.com', password: 'longenough1', framed: true } });
  assert.equal(f.status, 200); assert.match(f.headers.get('set-cookie'), /SameSite=None; Partitioned/);
});
