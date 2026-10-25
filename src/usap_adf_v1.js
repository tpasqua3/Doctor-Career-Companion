// USAP ACCOUNT-LEVEL DATA FRAMEWORK MODULE v1 (ADF) — shared by every USAP node, copied unchanged into each app.
// Source of truth: Master USAP Backend Brain / domain-sdk / usap_adf_v1.js; the standard it implements is
// governance/usap_account_data_framework_v1.json. Replace the copy in an app; never edit it there.
//
// What it does, on top of whatever Google Drive code the app already has (an adapter, below):
//   ensureLayout(userFolderId)       the standard subfolders inside a user's (existing) account folder
//   putAsset / getAsset / listAssets  user files with de-identified names, tracked in metadata_registry.json
//   recordEvents(userFolderId, evs)   user activity, one events_<YYYY-MM-DD>.json per day
//   backup(userFolderId, bundle)      backups/backup_<YYYY_MM_DD>.json, registered
//   exportBundle(...) / importBundle  the standard account export (JSON) that wraps the app's own bundle unchanged
//   check(...)                        ADF conformance (6 checks) -> score for the kit metric adf_conformance
//
// Adapter (the app supplies it, wrapping its own Drive functions):
//   findOrCreateFolder(name, parentId) -> folderId
//   writeFile(name, parentId, content, mimeType, existingFileId?) -> { id, md5?, bytes? }   (overwrite when existingFileId given)
//   readFile(fileId) -> string | null
//   findFile?(name, parentId) -> fileId | null      (only used to locate metadata_registry.json the first time)
// Nothing here deletes, moves or renames anything. Zero dependencies; an ES module (Workers, Node, browsers).
  const ADF_VERSION = "1.0.0";
  const SUBFOLDERS = ["profile", "preferences", "personalization", "events", "analytics", "reports", "backups", "uploads", "exports", "notes", "mastery", "user_generated_content", "app_specific"];
  const REGISTRY = "metadata_registry.json";
  const ID_RE = /^(usr|acct|u)[-_][A-Za-z0-9]{4,}$|^[a-f0-9]{16,64}$/;
  const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const rid = (n = 6) => { const a = new Uint8Array(n); (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))); return [...a].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n * 2 - 2); };
  const iso = () => new Date().toISOString();
  const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const slug = (s) => String(s || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "asset";

  function createAdf({ appId, adapter }) {
    if (!adapter || typeof adapter.findOrCreateFolder !== "function" || typeof adapter.writeFile !== "function" || typeof adapter.readFile !== "function")
      throw new Error("usap_adf: the adapter needs findOrCreateFolder, writeFile and readFile");
    const cache = new Map();   // userFolderId -> { registry, registryFileId }

    async function loadRegistry(userFolderId) {
      const c = cache.get(userFolderId); if (c) return c;
      let fileId = null, reg = null;
      if (adapter.findFile) fileId = await adapter.findFile(REGISTRY, userFolderId);
      if (fileId) { try { reg = JSON.parse((await adapter.readFile(fileId)) || "null"); } catch { reg = null; } }
      if (!reg || reg.schema_version !== "1") reg = { schema_version: "1", app_id: appId, user_id: null, created_at: iso(), updated_at: iso(), folders: {}, assets: [] };
      const out = { registry: reg, registryFileId: fileId };
      cache.set(userFolderId, out); return out;
    }
    async function saveRegistry(userFolderId) {
      const c = await loadRegistry(userFolderId);
      c.registry.updated_at = iso();
      const w = await adapter.writeFile(REGISTRY, userFolderId, JSON.stringify(c.registry, null, 1), "application/json", c.registryFileId || undefined);
      if (w && w.id) c.registryFileId = w.id;
      return c.registry;
    }

    // The standard subfolders in a user's folder (created when missing; existing ones are reused).
    async function ensureLayout(userFolderId, { userId = null } = {}) {
      const c = await loadRegistry(userFolderId);
      if (userId && !c.registry.user_id) c.registry.user_id = String(userId);
      let changed = false;
      for (const name of SUBFOLDERS) {
        if (c.registry.folders[name]) continue;
        c.registry.folders[name] = await adapter.findOrCreateFolder(name, userFolderId); changed = true;
      }
      if (changed || !c.registryFileId) await saveRegistry(userFolderId);
      return { folders: { ...c.registry.folders }, registry_file_id: c.registryFileId };
    }

    // Store a user-owned file under a de-identified name and register it. content: string; json: any (stored as JSON).
    async function putAsset(userFolderId, { asset_type, folder = "user_generated_content", ext, content, json, mimeType, asset_id, tags = [], relations = [], replace = false }) {
      if (!SUBFOLDERS.includes(folder)) throw new Error("usap_adf: unknown folder " + folder);
      await ensureLayout(userFolderId);
      const c = await loadRegistry(userFolderId);
      const type = slug(asset_type);
      const prior = asset_id ? c.registry.assets.find((a) => a.asset_id === asset_id) : null;
      const id = asset_id || `${type}_${rid(4)}`;
      const isJson = json !== undefined, body = isJson ? JSON.stringify(json, null, 1) : String(content ?? "");
      const e = ext || (isJson ? "json" : "txt"), file = `${id}.${e}`;
      const w = await adapter.writeFile(file, c.registry.folders[folder], body, mimeType || (isJson ? "application/json" : "text/plain"), prior && replace ? prior.drive_file_id : undefined);
      const rec = { asset_id: id, asset_type: type, folder, file, drive_file_id: (w && w.id) || null, created_at: prior ? prior.created_at : iso(), updated_at: iso(),
        bytes: (w && w.bytes) ?? body.length, md5: (w && w.md5) || null, tags: [...new Set(tags.map(String))], relations: relations.slice(0, 50) };
      c.registry.assets = c.registry.assets.filter((a) => a.asset_id !== id).concat(rec);
      await saveRegistry(userFolderId);
      return rec;
    }
    async function getAsset(userFolderId, assetId) {
      const c = await loadRegistry(userFolderId), a = c.registry.assets.find((x) => x.asset_id === assetId);
      if (!a || !a.drive_file_id) return null;
      const text = await adapter.readFile(a.drive_file_id);
      return { asset: a, content: text, json: /\.json$/.test(a.file) ? (() => { try { return JSON.parse(text); } catch { return null; } })() : undefined };
    }
    async function listAssets(userFolderId, { asset_type, folder, tag } = {}) {
      const c = await loadRegistry(userFolderId);
      return c.registry.assets.filter((a) => (!asset_type || a.asset_type === slug(asset_type)) && (!folder || a.folder === folder) && (!tag || (a.tags || []).includes(tag)));
    }
    // Register a file the app already wrote elsewhere in the user's folder (organizing existing files without moving them).
    async function registerExisting(userFolderId, { asset_type, folder = "app_specific", file, drive_file_id, bytes, md5, tags = [] }) {
      const c = await loadRegistry(userFolderId), type = slug(asset_type);
      const prior = c.registry.assets.find((a) => a.drive_file_id && a.drive_file_id === drive_file_id);
      const rec = { asset_id: prior ? prior.asset_id : `${type}_${rid(4)}`, asset_type: type, folder, file, drive_file_id: drive_file_id || null, created_at: prior ? prior.created_at : iso(), updated_at: iso(), bytes: bytes ?? null, md5: md5 || null, tags, relations: [], legacy_location: true };
      c.registry.assets = c.registry.assets.filter((a) => a.asset_id !== rec.asset_id).concat(rec);
      await saveRegistry(userFolderId); return rec;
    }

    // Append user activity events (counts, ids and times; the app decides what goes in) to events/events_<day>.json.
    async function recordEvents(userFolderId, events) {
      if (!events || !events.length) return null;
      const d = day(), id = `events_${d}`, c = await loadRegistry(userFolderId);
      const prior = c.registry.assets.find((a) => a.asset_id === id);
      let list = [];
      if (prior && prior.drive_file_id) { try { list = JSON.parse((await adapter.readFile(prior.drive_file_id)) || "[]"); } catch { list = []; } }
      list = list.concat(events.map((e) => ({ at: iso(), ...e }))).slice(-5000);
      return putAsset(userFolderId, { asset_type: "events", asset_id: id, folder: "events", json: list, replace: true, tags: ["events", d] });
    }

    // A full-state backup in backups/, registered (one per day; a second backup the same day replaces it).
    async function backup(userFolderId, bundle) {
      const id = `backup_${day().replace(/-/g, "_")}`, c = await loadRegistry(userFolderId);
      const prior = c.registry.assets.find((a) => a.asset_id === id);
      return putAsset(userFolderId, { asset_type: "backup", asset_id: id, folder: "backups", json: bundle, replace: !!prior, tags: ["backup"] });
    }

    // The standard export: the app's own complete bundle travels unchanged in app_data, so existing restores keep working.
    function exportBundle({ userId, appData, preferences = {}, history = {}, mastery = {}, analytics = {}, events = [], userProfile = {}, userContent = {}, customizations = {}, assets = [], lastActive = null }) {
      return { usap_adf: "1", adf_version: ADF_VERSION, app_id: appId, exported_at: iso(),
        user_state: { userId: userId ? String(userId) : "", preferences, history, mastery, analytics, lastActive: lastActive || "" },
        userProfile, preferences, events, analytics, userContent, customizations, assets, app_data: appData === undefined ? null : appData };
    }
    // Accepts a standard bundle (returns its parts) or, for backward compatibility, an app's own older bundle (returned as app_data).
    function importBundle(obj) {
      if (obj && obj.usap_adf === "1") {
        if (obj.app_id && obj.app_id !== appId) throw new Error(`usap_adf: this export is from ${obj.app_id}, not ${appId}`);
        return { standard: true, app_data: obj.app_data, preferences: obj.preferences || {}, user_state: obj.user_state || {}, events: obj.events || [], analytics: obj.analytics || {}, userContent: obj.userContent || {}, customizations: obj.customizations || {}, assets: obj.assets || [] };
      }
      return { standard: false, app_data: obj };
    }

    // Conformance: six checks from the standard. Returns { score 0..1, checks }.
    async function check({ userFolderId = null, exportSupported, importSupported, separateFolders, names = [] }) {
      const checks = { layout: null, registry: null, export: !!exportSupported, import: !!importSupported, deidentified: names.every((n) => !EMAIL_RE.test(n) && (ID_RE.test(n) || !/\s/.test(n))), separation: !!separateFolders };
      if (userFolderId) { const c = await loadRegistry(userFolderId); checks.layout = SUBFOLDERS.every((n) => !!c.registry.folders[n]); checks.registry = !!c.registryFileId; }
      const vals = Object.values(checks).filter((v) => v !== null);
      return { score: vals.length ? vals.filter(Boolean).length / 6 : 0, checks };
    }

    return { ADF_VERSION, SUBFOLDERS, ensureLayout, putAsset, getAsset, listAssets, registerExisting, recordEvents, backup, exportBundle, importBundle, check, _registry: loadRegistry };
  }

  const isDeidentified = (n) => !EMAIL_RE.test(String(n)) && ID_RE.test(String(n));
  export { ADF_VERSION, SUBFOLDERS, REGISTRY, createAdf, isDeidentified };
