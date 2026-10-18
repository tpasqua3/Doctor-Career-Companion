// MKOS storage in D1. Central tables (one knowledge base for every account) are prefixed mk_; learner tables are keyed by user_id.
// Nothing is deleted: objects change by new versions (mk_versions keeps every one), and status moves current -> modified ->
// superseded -> retired. The only rows ever removed are transient ones: mk_text (source text held while a source is being
// processed) and finished jobs older than the retention window.
import { FRAMEWORK, FRAMEWORK_HASH } from './framework.js';

export const TABLES = [
  // The universal object store: every knowledge, educational and curriculum object, one row per id at its current version.
  `CREATE TABLE IF NOT EXISTS mk_objects (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, norm TEXT NOT NULL, specialty TEXT,
     status TEXT NOT NULL, gov TEXT NOT NULL, version TEXT NOT NULL, trust REAL NOT NULL DEFAULT 0, conf REAL NOT NULL DEFAULT 0,
     hash TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_objects_type ON mk_objects (type, status)`,
  `CREATE INDEX IF NOT EXISTS mk_objects_norm ON mk_objects (norm)`,
  `CREATE INDEX IF NOT EXISTS mk_objects_spec ON mk_objects (specialty, type)`,
  // Version history (Version Everything / Delete Nothing).
  `CREATE TABLE IF NOT EXISTS mk_versions (id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, event_id TEXT, actor TEXT,
     PRIMARY KEY (id, version))`,
  // Knowledge graph. One row per (src, rel, dst); the inverse is read from the ontology.
  `CREATE TABLE IF NOT EXISTS mk_edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'current', conf REAL NOT NULL DEFAULT 50,
     prov TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (src, rel, dst))`,
  `CREATE INDEX IF NOT EXISTS mk_edges_dst ON mk_edges (dst, rel)`,
  // Concept resolution: every name, alias, abbreviation and synonym, normalized.
  `CREATE TABLE IF NOT EXISTS mk_aliases (alias TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (alias, id))`,
  // The library as the scanner last saw it (one row per Drive file), for change detection.
  `CREATE TABLE IF NOT EXISTS mk_files (drive_file_id TEXT PRIMARY KEY, source_id TEXT, title TEXT, path TEXT, parent TEXT, mime TEXT, bytes INTEGER,
     md5 TEXT, modified TEXT, sweep INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'seen', note TEXT, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_files_state ON mk_files (state)`,
  // Dynamic Knowledge Refresh Engine: change events and the processing queue.
  `CREATE TABLE IF NOT EXISTS mk_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT, impact TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_events_stage ON mk_events (stage, created)`,
  `CREATE TABLE IF NOT EXISTS mk_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT, state TEXT NOT NULL DEFAULT 'queued',
     tries INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 5, note TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_jobs_next ON mk_jobs (state, priority, not_before)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mk_jobs_open ON mk_jobs (kind, subject) WHERE state IN ('queued', 'running')`,
  // Source text held only while a source is being extracted.
  `CREATE TABLE IF NOT EXISTS mk_text (source_id TEXT NOT NULL, chunk INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_id, chunk))`,
  // Governance: audit log and reviews (validation, approval).
  `CREATE TABLE IF NOT EXISTS mk_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, object_id TEXT, from_v TEXT, to_v TEXT, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS mk_audit_obj ON mk_audit (object_id)`,
  `CREATE TABLE IF NOT EXISTS mk_reviews (object_id TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, actor TEXT NOT NULL, note TEXT, at TEXT NOT NULL, PRIMARY KEY (object_id, version, kind))`,
  `CREATE TABLE IF NOT EXISTS mk_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // Links from educational assets that live elsewhere (learner record documents) to MKOS objects, for impact analysis.
  `CREATE TABLE IF NOT EXISTS mk_asset_links (asset_id TEXT NOT NULL, user_id TEXT NOT NULL, path TEXT NOT NULL, item TEXT NOT NULL, object_id TEXT NOT NULL, rel TEXT NOT NULL,
     at TEXT NOT NULL, PRIMARY KEY (asset_id, object_id, rel))`,
  `CREATE INDEX IF NOT EXISTS mk_asset_links_obj ON mk_asset_links (object_id)`,
  `CREATE INDEX IF NOT EXISTS mk_asset_links_user ON mk_asset_links (user_id, path)`,
  // Learner Intelligence: a state per learner per object at any granularity level, events, misconceptions.
  `CREATE TABLE IF NOT EXISTS mk_learner (user_id TEXT NOT NULL, object_id TEXT NOT NULL, level TEXT NOT NULL, mastery REAL NOT NULL, conf REAL NOT NULL,
     priority REAL NOT NULL DEFAULT 0, body TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (user_id, object_id))`,
  `CREATE INDEX IF NOT EXISTS mk_learner_pri ON mk_learner (user_id, level, priority)`,
  `CREATE TABLE IF NOT EXISTS mk_learner_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, object_ids TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS mk_learner_events_user ON mk_learner_events (user_id, at)`,
  `CREATE TABLE IF NOT EXISTS mk_misconceptions (user_id TEXT NOT NULL, object_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1,
     body TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (user_id, object_id, kind))`,
  `CREATE TABLE IF NOT EXISTS mk_reconcile (user_id TEXT NOT NULL, object_id TEXT NOT NULL, event_id TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', at TEXT NOT NULL,
     PRIMARY KEY (user_id, object_id, event_id))`,
  // Routing decisions (Routing Confidence).
  `CREATE TABLE IF NOT EXISTS mk_routes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, request TEXT NOT NULL, decision TEXT NOT NULL, conf REAL NOT NULL, body TEXT NOT NULL)`,
  // The Drive mirror: which shard files exist and the hash last written.
  `CREATE TABLE IF NOT EXISTS mk_mirror (key TEXT PRIMARY KEY, file_id TEXT, hash TEXT, synced TEXT)`,
  // Board Blueprint registry projection (Blueprint Execution Engine tables).

  `CREATE TABLE IF NOT EXISTS mk_blueprint_registries (blueprint_id TEXT PRIMARY KEY, blueprint_family TEXT NOT NULL, board_name TEXT, board_type TEXT, year INTEGER, version TEXT,
     publication_date TEXT, effective_date TEXT, current_status TEXT NOT NULL, supersession_status TEXT, source_confidence REAL, overall_blueprint_confidence REAL, confidence TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS blueprint_family_current ON mk_blueprint_registries (blueprint_family, current_status)`,
  `CREATE TABLE IF NOT EXISTS mk_blueprint_domains (domain_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, domain_name TEXT, blueprint_weight REAL, frequency_score REAL, importance_score REAL,
     question_distribution_weight REAL, confidence_score REAL, PRIMARY KEY (blueprint_id, domain_id))`,
  `CREATE INDEX IF NOT EXISTS domain_weight ON mk_blueprint_domains (blueprint_id, blueprint_weight DESC)`,
  `CREATE TABLE IF NOT EXISTS mk_blueprint_objectives (objective_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, domain_id TEXT, objective_text TEXT, objective_type TEXT, frequency_score REAL,
     importance_score REAL, priority_score REAL, confidence_score REAL, PRIMARY KEY (blueprint_id, objective_id))`,
  `CREATE INDEX IF NOT EXISTS objective_priority ON mk_blueprint_objectives (blueprint_id, priority_score DESC)`,
  `CREATE TABLE IF NOT EXISTS mk_blueprint_concept_mappings (blueprint_id TEXT NOT NULL, concept_id TEXT NOT NULL, relevance_score REAL, weight_score REAL, frequency_score REAL, priority_score REAL,
     confidence_score REAL, PRIMARY KEY (blueprint_id, concept_id))`,
  `CREATE INDEX IF NOT EXISTS concept_priority ON mk_blueprint_concept_mappings (blueprint_id, priority_score DESC)`,
  `CREATE TABLE IF NOT EXISTS mk_blueprint_asset_mappings (blueprint_id TEXT NOT NULL, asset_id TEXT NOT NULL, asset_type TEXT, blueprint_weight REAL, priority_score REAL, confidence_score REAL,
     PRIMARY KEY (blueprint_id, asset_id))`,
  `CREATE TABLE IF NOT EXISTS mk_learner_blueprint (learner_id TEXT PRIMARY KEY, selected_blueprint_family TEXT NOT NULL, selected_blueprint_id TEXT, source TEXT, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS learner_blueprint ON mk_learner_blueprint (learner_id, selected_blueprint_id)`,
  // Educational assets as governed MKOS objects (assets.js): the content of each version, and who has been served which asset.
  `CREATE TABLE IF NOT EXISTS mk_asset_store (asset_id TEXT NOT NULL, version TEXT NOT NULL, content TEXT NOT NULL, bytes INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (asset_id, version))`,
  `CREATE TABLE IF NOT EXISTS mk_asset_usage (asset_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (asset_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS mk_asset_usage_user ON mk_asset_usage (user_id, kind)`,
];

let ready = '';
// Tests only: open a second database in the same process.
export const _resetInit = () => { ready = ''; };
export async function mkInit(env) {
  if (ready === FRAMEWORK_HASH) return;
  await env.DB.batch(TABLES.map((s) => env.DB.prepare(s)));
  // Settings overlay the framework defaults; record which framework version the store was last opened with.
  const prev = await getSetting(env, 'framework_hash');
  if (prev !== FRAMEWORK_HASH) {
    await setSetting(env, 'framework_hash', FRAMEWORK_HASH);
    await audit(env, 'system', 'framework_loaded', null, prev || '', FRAMEWORK_HASH, { versions: Object.fromEntries(Object.entries(FRAMEWORK.frameworks).map(([k, v]) => [k, v.version])) });
  }
  ready = FRAMEWORK_HASH;
}

export const nowIso = () => new Date().toISOString();
export const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export async function getSetting(env, k) { const r = await env.DB.prepare('SELECT v FROM mk_settings WHERE k = ?').bind(k).first(); return r ? r.v : null; }
export const setSetting = (env, k, v) => v == null ? env.DB.prepare('DELETE FROM mk_settings WHERE k = ?').bind(k).run()
  : env.DB.prepare('INSERT INTO mk_settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
export async function audit(env, actor, action, objectId, fromV, toV, detail) {
  await env.DB.prepare('INSERT INTO mk_audit (at, actor, action, object_id, from_v, to_v, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(nowIso(), String(actor || 'system').slice(0, 80), action, objectId || null, fromV || null, toV || null, detail ? JSON.stringify(detail).slice(0, 20000) : null).run();
}

// A framework number with the owner's central override laid over it: path like "scoring.freshness.half_life_years.Guidelines".
let OVR = { t: 0, v: {} };
export async function overrides(env) {
  if (Date.now() - OVR.t < 30000) return OVR.v;
  const { results } = await env.DB.prepare("SELECT k, v FROM mk_settings WHERE k LIKE 'fw:%'").all();
  OVR = { t: Date.now(), v: Object.fromEntries(results.map((r) => [r.k.slice(3), J(r.v, r.v)])) };
  return OVR.v;
}
export function fwGet(path, ovr = {}) {
  if (path in ovr) return ovr[path];
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), FRAMEWORK.frameworks);
}
export const resetOverrides = () => { OVR = { t: 0, v: {} }; };
