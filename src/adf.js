/* USAP Account-Level Data Framework (ADF, governance SR-42): this app's wiring of the shared module ./usap_adf_v1.js (a copy of the
   Brain's domain-sdk/usap_adf_v1.js: replace it, never edit it here). It covers only the per-account folders in
   DRIVE_ACCOUNTS_FOLDER; MKOS central storage and the knowledge library are not touched.
   - Each existing account folder (acct-<id>) keeps its name, place and files. Once per account the standard subfolders are made
     inside it (the existing `backups` folder is reused) and the files already there are registered in metadata_registry.json:
     account.json under profile, each record file under app_specific. Nothing is moved, renamed or deleted, and the app keeps
     writing records/, backups/ and account.json exactly as before. The once-per-account flag is drive_accounts.adf.
   - Export wraps the app's own backup bundle unchanged in app_data; import accepts that and the older bundle.
   Everything here is plain functions over injected Drive and store helpers, so it can be tested with fakes (test/adf.test.mjs). */
import { createAdf, REGISTRY } from './usap_adf_v1.js';

export const ADF_APP = 'doctor_companion_app';
const FOLDER = 'application/vnd.google-apps.folder';
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/* The adapter the module asks for, over the app's own Drive helpers:
   d.list(query) -> [{ id, name }], d.mkdir(name, parent) -> id, d.upload({ id?, name, parent, text, mime }) -> { id, size, md5 },
   d.read(id) -> text. Folder look-ups list an account folder's subfolders once, then answer from that list. */
export function driveAdapter(d) {
  const kids = new Map();
  const folders = async parent => {
    if (!kids.has(parent)) {
      const m = new Map();
      for (const f of await d.list(`'${q(parent)}' in parents and mimeType = '${FOLDER}' and trashed = false`)) if (!m.has(f.name)) m.set(f.name, f.id);
      kids.set(parent, m);
    }
    return kids.get(parent);
  };
  return {
    async findOrCreateFolder(name, parentId) {
      const m = await folders(parentId);
      if (m.has(name)) return m.get(name);
      const id = await d.mkdir(name, parentId); m.set(name, id); return id;
    },
    async writeFile(name, parentId, content, mimeType, existingFileId) {
      const w = await d.upload(existingFileId ? { id: existingFileId, text: content, mime: mimeType } : { name, parent: parentId, text: content, mime: mimeType });
      return { id: w.id, md5: w.md5 || undefined, bytes: w.size != null ? Number(w.size) : undefined };
    },
    async readFile(fileId) { try { return await d.read(fileId); } catch { return null; } },
    async findFile(name, parentId) {
      const f = await d.list(`name = '${q(name)}' and '${q(parentId)}' in parents and trashed = false`);
      return f && f[0] ? f[0].id : null;
    },
  };
}

/* The module writes metadata_registry.json after every registration; registering a few hundred existing records would mean a few
   hundred uploads. Here registry writes are held and written once by flush(), which also tells the module the registry's file id. */
export function bufferedAdf(adapter) {
  const pending = new Map();   // folderId -> { content, mime, id }
  const inner = {
    ...adapter,
    async writeFile(name, parentId, content, mimeType, existingFileId) {
      if (name !== REGISTRY) return adapter.writeFile(name, parentId, content, mimeType, existingFileId);
      const p = pending.get(parentId) || {}; pending.set(parentId, { content, mime: mimeType, id: existingFileId || p.id });
      return { id: existingFileId || p.id || null };
    },
  };
  const adf = createAdf({ appId: ADF_APP, adapter: inner });
  async function flush() {
    for (const [folderId, p] of pending) {
      const w = await adapter.writeFile(REGISTRY, folderId, p.content, p.mime, p.id || undefined);
      const c = await adf._registry(folderId); if (w && w.id) c.registryFileId = w.id;
      pending.delete(folderId);
    }
  }
  return { adf, flush };
}

/* Lay out one account folder and register what is already in it. a = { folderId, name, profileId, records: [{ path, file_id }] }. */
export async function layoutAccount(adapter, a) {
  const { adf, flush } = bufferedAdf(adapter);
  const out = await adf.ensureLayout(a.folderId, { userId: a.name });
  if (a.profileId) await adf.registerExisting(a.folderId, { asset_type: 'account_profile', folder: 'profile', file: 'account.json', drive_file_id: a.profileId, tags: ['account'] });
  for (const r of a.records || []) {
    if (!r || !r.file_id) continue;
    await adf.registerExisting(a.folderId, { asset_type: 'record', folder: 'app_specific', file: String(r.path).replace(/\//g, '__') + '.json', drive_file_id: r.file_id, tags: ['record'] });
  }
  await flush();
  return { folders: Object.keys(out.folders).length, registered: (a.profileId ? 1 : 0) + (a.records || []).filter(r => r && r.file_id).length };
}

/* One account due its layout, once. store = { next() -> { uid, folderId, name, profileId } | null, take(uid) -> bool,
   records(uid) -> [{ path, file_id }], done(uid), release(uid) }. Best effort: an error is logged and the account is tried again later. */
export async function adfOnce(store, adapter, log = console.error) {
  const a = await store.next(); if (!a) return null;
  if (!await store.take(a.uid)) return null;
  try { const r = await layoutAccount(adapter, { ...a, records: await store.records(a.uid) }); await store.done(a.uid); return r; }
  catch (e) { log('adf layout failed for ' + a.uid, e); return { error: true }; }
  finally { await store.release(a.uid); }
}

/* The daily conformance figure for USAP: score only, no identity. */
export async function adfConformance(adapter, { folderId, name, separate, emit }) {
  const adf = createAdf({ appId: ADF_APP, adapter });
  const r = await adf.check({ userFolderId: folderId || null, exportSupported: true, importSupported: true, separateFolders: !!separate, names: name ? [name] : [] });
  emit('adf_conformance', r.score, {});
  return r;
}

/* Export: the app's own bundle travels unchanged in app_data. */
export const adfExport = (userId, appData) => createAdf({ appId: ADF_APP, adapter: NOOP }).exportBundle({ userId, appData });
/* Import: the app's own bundle from either a standard export or an older file. */
export const adfImport = obj => createAdf({ appId: ADF_APP, adapter: NOOP }).importBundle(obj).app_data;
const NOOP = { findOrCreateFolder: async () => null, writeFile: async () => ({}), readFile: async () => null };
