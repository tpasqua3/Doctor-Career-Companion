// ADF wiring tests with an in-memory Drive and store (no network). Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { driveAdapter, adfOnce, adfConformance, adfExport, adfImport, layoutAccount } from '../src/adf.js';
import { SUBFOLDERS, REGISTRY } from '../src/usap_adf_v1.js';

const FOLDER = 'application/vnd.google-apps.folder';
function fakeDrive() {
  const files = new Map(); let n = 0; const calls = { list: 0, mkdir: 0, upload: 0, read: 0 };
  const add = (name, parent, mime, text = '') => { const id = 'f' + (++n); files.set(id, { id, name, parent, mime, text }); return id; };
  const d = {
    calls, files, add,
    list: async query => { calls.list++;
      const parent = /'([^']+)' in parents/.exec(query)[1], name = (/name = '([^']+)'/.exec(query) || [])[1], folders = query.includes(FOLDER);
      return [...files.values()].filter(f => f.parent === parent && (!name || f.name === name) && (!folders || f.mime === FOLDER)); },
    mkdir: async (name, parent) => { calls.mkdir++; return add(name, parent, FOLDER); },
    upload: async o => { calls.upload++;
      if (o.id) { const f = files.get(o.id); f.text = o.text; return { id: o.id, size: String(o.text.length), md5: 'm' }; }
      return { id: add(o.name, o.parent, o.mime, o.text), size: String(o.text.length), md5: 'm' }; },
    read: async id => { calls.read++; return files.get(id).text; },
  };
  return d;
}
function account(d) {
  const root = d.add('accounts', null, FOLDER), folder = d.add('acct-0123456789ab', root, FOLDER);
  const backups = d.add('backups', folder, FOLDER), records = d.add('records', folder, FOLDER);
  const profile = d.add('account.json', folder, 'application/json', '{}');
  const recs = ['med/state', 'med/les_1', 'med/cards'].map(p => ({ path: p, file_id: d.add(p.replace(/\//g, '__') + '.json', records, 'application/json', '{}') }));
  return { root, folder, backups, records, profile, recs };
}
const registryOf = (d, folder) => JSON.parse([...d.files.values()].find(f => f.parent === folder && f.name === REGISTRY).text);

test('existing files are registered and the backups folder is reused; nothing is moved', async () => {
  const d = fakeDrive(), a = account(d), before = [...d.files.values()].map(f => ({ ...f }));
  const r = await layoutAccount(driveAdapter(d), { folderId: a.folder, name: 'acct-0123456789ab', profileId: a.profile, records: a.recs });
  assert.equal(r.registered, 4);
  const reg = registryOf(d, a.folder);
  assert.equal(reg.user_id, 'acct-0123456789ab');
  assert.deepEqual(Object.keys(reg.folders).sort(), [...SUBFOLDERS].sort());
  assert.equal(reg.folders.backups, a.backups);
  assert.equal(reg.assets.find(x => x.drive_file_id === a.profile).folder, 'profile');
  for (const x of a.recs) assert.equal(reg.assets.find(y => y.drive_file_id === x.file_id).folder, 'app_specific');
  for (const f of before) { const now = d.files.get(f.id); assert.equal(now.parent, f.parent); assert.equal(now.name, f.name); }
  // one registry write for the whole layout, 12 new folders (backups reused)
  assert.equal(d.calls.upload, 1); assert.equal(d.calls.mkdir, SUBFOLDERS.length - 1);
});

test('layout happens once per account', async () => {
  const d = fakeDrive(), a = account(d), flags = new Map(); let lease = 0;
  const store = {
    next: async () => flags.has('u1') ? null : { uid: 'u1', folderId: a.folder, name: 'acct-0123456789ab', profileId: a.profile },
    take: async () => (lease ? false : (lease = 1, true)), release: async () => { lease = 0; },
    records: async () => a.recs, done: async uid => flags.set(uid, true),
  };
  const first = await adfOnce(store, driveAdapter(d));
  assert.equal(first.registered, 4); assert.ok(flags.get('u1'));
  const calls = { ...d.calls };
  assert.equal(await adfOnce(store, driveAdapter(d)), null);
  assert.deepEqual(d.calls, calls);   // no Drive work on later runs
  assert.equal([...d.files.values()].filter(f => f.name === REGISTRY).length, 1);
});

test('a failed layout is logged, not thrown, and the account is not flagged', async () => {
  const d = fakeDrive(), a = account(d), flags = new Map(), logged = [];
  d.mkdir = async () => { throw new Error('drive down'); };
  const store = { next: async () => ({ uid: 'u1', folderId: a.folder, name: 'acct-x', profileId: a.profile }), take: async () => true, release: async () => {}, records: async () => [], done: async uid => flags.set(uid, 1) };
  const r = await adfOnce(store, driveAdapter(d), (...m) => logged.push(m));
  assert.deepEqual(r, { error: true }); assert.equal(flags.size, 0); assert.equal(logged.length, 1);
});

test('export wraps the old bundle unchanged and import accepts both formats', () => {
  const old = { app: 'doctor-career-companion', account: 'x', saved: '2026-10-24T00:00:00Z', docs: { 'med/state': { v: 1 } } };
  const b = adfExport('acct-0123456789ab', old);
  assert.equal(b.usap_adf, '1'); assert.equal(b.adf_version, '1.0.0'); assert.equal(b.app_id, 'doctor_companion_app');
  assert.equal(b.user_state.userId, 'acct-0123456789ab'); assert.deepEqual(b.app_data, old);
  assert.deepEqual(adfImport(JSON.parse(JSON.stringify(b))), old);
  assert.deepEqual(adfImport(old), old);
  assert.throws(() => adfImport({ ...b, app_id: 'media_os' }));
});

test('the page wrapper produces the same shape as the module', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../app/companion.html', import.meta.url), 'utf8');
  const wrap = /function adfWrap\(old\)\{.*\}\n/.exec(html)[0], open = /function adfOpen\(j\)\{.*\}\n/.exec(html)[0];
  const { adfWrap, adfOpen } = new Function(wrap + open + 'return {adfWrap,adfOpen}')();
  const old = { app: 'doctor-career-companion', saved: 's', docs: { state: { v: 1 } } }, page = adfWrap(old), mod = adfExport('', old);
  assert.deepEqual(Object.keys(page).sort(), Object.keys(mod).sort());
  assert.deepEqual(Object.keys(page.user_state).sort(), Object.keys(mod.user_state).sort());
  assert.deepEqual(adfOpen(page), old); assert.deepEqual(adfOpen(old), old); assert.deepEqual(adfOpen(mod), old);
  assert.equal(adfOpen({ ...page, app_id: 'media_os' }), null);
});

test('the conformance metric is emitted, with no identity', async () => {
  const d = fakeDrive(), a = account(d);
  await layoutAccount(driveAdapter(d), { folderId: a.folder, name: 'acct-0123456789ab', profileId: a.profile, records: a.recs });
  const sent = [];
  const r = await adfConformance(driveAdapter(d), { folderId: a.folder, name: 'acct-0123456789ab', separate: true, emit: (k, v, dims) => sent.push([k, v, dims]) });
  assert.deepEqual(sent, [['adf_conformance', 1, {}]]); assert.equal(r.score, 1);
  const none = []; await adfConformance(driveAdapter(fakeDrive()), { folderId: null, name: '', separate: true, emit: (k, v) => none.push([k, v]) });
  assert.equal(none[0][0], 'adf_conformance'); assert.ok(none[0][1] < 1);
});
