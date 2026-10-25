/* Sign in with Google (roadmap Phase 8, spec /specs/google_signin_sso.md): the parts that need no database.
   The worker (src/worker.js) owns the routes, the accounts and the sessions; this file only reads and checks Google's ID tokens.
     - checkClaims: the claim checks every path applies (aud = this app's client, iss Google, exp in the future, email verified).
     - verifyIdToken: One Tap's credential, verified against Google's published keys (JWKS, RS256, WebCrypto), then checkClaims.
     - decodeJwt: the payload of a token that came straight from Google's token endpoint over TLS (redirect flow: no signature needed).
   Nothing here keeps a token or the Google `sub`; the worker stores only sha256("google-sub:" + sub). */
const ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const b64uBytes = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')), c => c.charCodeAt(0));
/* An error whose message is fit to show the person (`gsi` marks it). */
const oops = m => Object.assign(new Error(m), { gsi: true });
const b64uJson = s => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

/* This app's own Google OAuth client (never shared across apps). The Drive connection's names first, because the reused callback
   (/api/google/callback) is registered on that client; GOOGLE_CLIENT_ID/SECRET when only those are set. Id and secret come as a pair. */
export function gsiClient(env) {
  if (env.GOOGLE_OAUTH_CLIENT_ID) return { id: String(env.GOOGLE_OAUTH_CLIENT_ID), secret: String(env.GOOGLE_OAUTH_CLIENT_SECRET || '') };
  if (env.GOOGLE_CLIENT_ID) return { id: String(env.GOOGLE_CLIENT_ID), secret: String(env.GOOGLE_CLIENT_SECRET || '') };
  return { id: '', secret: '' };
}

export function decodeJwt(jwt) {
  const p = String(jwt || '').split('.');
  if (p.length !== 3) throw oops('That Google sign-in could not be read.');
  try { return { header: b64uJson(p[0]), payload: b64uJson(p[1]), signed: new TextEncoder().encode(p[0] + '.' + p[1]), sig: b64uBytes(p[2]) }; } catch { throw oops('That Google sign-in could not be read.'); }
}

/* The claims of a Google ID token, or an Error with a message fit to show the person. */
export function checkClaims(p, clientId, now = Date.now()) {
  if (!p || typeof p !== 'object') throw oops('Google did not send a sign-in.');
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!clientId || !aud.includes(clientId)) throw oops('That Google sign-in was meant for a different app.');
  if (!ISS.has(p.iss)) throw oops('That sign-in did not come from Google.');
  if (!(Number(p.exp) * 1000 > now)) throw oops('That Google sign-in has expired. Try again.');
  if (!(p.email_verified === true || p.email_verified === 'true')) throw oops('Google has not verified the email of that account.');
  const email = String(p.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw oops('Google did not share an email address.');
  if (!p.sub) throw oops('Google did not send a sign-in.');
  return { email, sub: String(p.sub), given: String(p.given_name || '').trim().slice(0, 60), family: String(p.family_name || '').trim().slice(0, 60), name: String(p.name || '').trim().slice(0, 120) };
}

/* Google's signing keys, kept about an hour; asked again once when a token names a key we do not have. */
let KEYS = { at: 0, keys: [] };
async function keys(fetchFn, fresh) {
  if (!fresh && KEYS.keys.length && Date.now() - KEYS.at < 3600e3) return KEYS.keys;
  const r = await fetchFn(CERTS);
  if (!r.ok) throw oops('Google could not be reached. Try again.');
  const j = await r.json();
  KEYS = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
  return KEYS.keys;
}
export const resetKeys = () => { KEYS = { at: 0, keys: [] }; };

/* One Tap: verify the signature (RS256 against the JWKS), then the claims. */
export async function verifyIdToken(jwt, clientId, { fetchFn = globalThis.fetch, now = Date.now() } = {}) {
  let t; try { t = decodeJwt(jwt); } catch { throw oops('That Google sign-in could not be read.'); }
  if (t.header.alg !== 'RS256') throw oops('That Google sign-in could not be checked.');
  let k = (await keys(fetchFn)).find(x => x.kid === t.header.kid);
  if (!k) k = (await keys(fetchFn, true)).find(x => x.kid === t.header.kid);
  if (!k) throw oops('That Google sign-in could not be checked.');
  const key = await crypto.subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, t.sig, t.signed)) throw oops('That Google sign-in could not be checked.');
  return checkClaims(t.payload, clientId, now);
}

/* A same-origin path to continue to after a sign-in ("/" when it is anything else). */
export function safePath(to) {
  const s = String(to || '');
  return /^\/(?![\/\\])[^\s]*$/.test(s) && s.length <= 500 ? s : '/';
}
