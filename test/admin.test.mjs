// USAP admins (owner decision 2026-10-25): the account page's admin sections are only for people USAP says hold a Control
// Center role; integrations 'edit' (owner, developer) may change the Google Drive connection. No network: a fake binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminOf } from '../src/worker.js';

const usap = (answer, seen = []) => ({ seen, fetch: async (url, init) => { seen.push({ url: String(url), app: init.headers['x-usap-app'] }); return new Response(JSON.stringify(answer)); } });

test('the owner is an admin who edits integrations, without asking USAP', async () => {
  const b = usap({}); const v = await adminOf({ OWNER_EMAIL: 'Boss@Example.com', USAP_UGF: b }, { email: 'boss@example.com' });
  assert.deepEqual(v, { role: 'owner', integrations: 'edit' }); assert.equal(b.seen.length, 0);
});
test('a standard user is no admin; only a hash of the email is sent', async () => {
  const b = usap({ admin: false, usap_role: null }); const v = await adminOf({ USAP_UGF: b }, { email: 'plain@example.com' });
  assert.equal(v, null); assert.ok(/subject=[0-9a-f]{64}$/.test(b.seen[0].url) && !b.seen[0].url.includes('@')); assert.equal(b.seen[0].app, 'doctor_companion_app');
});
test('an administrator sees integrations, a developer edits them', async () => {
  assert.deepEqual(await adminOf({ USAP_UGF: usap({ admin: true, usap_role: 'administrator', integrations: 'view' }) }, { email: 'a1@example.com' }), { role: 'administrator', integrations: 'view' });
  assert.deepEqual(await adminOf({ USAP_UGF: usap({ admin: true, usap_role: 'developer', integrations: 'edit' }) }, { email: 'd1@example.com' }), { role: 'developer', integrations: 'edit' });
});
test('no USAP, or USAP failing, means no admin', async () => {
  assert.equal(await adminOf({}, { email: 'x1@example.com' }), null);
  assert.equal(await adminOf({ USAP_UGF: { fetch: async () => { throw new Error('down'); } } }, { email: 'x2@example.com' }), null);
});
