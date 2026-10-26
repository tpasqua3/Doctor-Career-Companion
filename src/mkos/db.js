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
  // The persistence ledger: every file of canonical storage as it moves through queued -> persisted (confirmed by Drive), or failed ->
  // retried, and files the daily reconciliation sent back (reconciled). Kept 60 days; mirrored to Drive (governance/persistence_<month>).
  `CREATE TABLE IF NOT EXISTS mk_persist_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS mk_persist_log_at ON mk_persist_log (at)`,
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
  // DADD-AI learner reports (dadd.js, assets.js reportAsset): one row per item and account, keyed by a one-way hash of the account id.
  // Only the item id, the reason and the time are kept; the count and reasons also live on the asset (triage.reported), which is durable.
  `CREATE TABLE IF NOT EXISTS mk_asset_reports (asset_id TEXT NOT NULL, acct TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (asset_id, acct))`,
  // Continuous Knowledge Lifecycle (lifecycle.js, mkos/ontology/lifecycle.json): one record per source of the stages it has reached.
  // Durable: mirrored to Drive (registries/lifecycle.json) and restored. stages_json holds {stage: {state, at, v, detail}} and the
  // history of earlier cycles (a source re-enters the lifecycle when its content version changes).
  `CREATE TABLE IF NOT EXISTS mk_lifecycle (source_id TEXT PRIMARY KEY, stage TEXT NOT NULL, stages_json TEXT NOT NULL, status TEXT NOT NULL, source_v TEXT,
     cycle INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_lifecycle_status ON mk_lifecycle (status, updated_at)`,
  // The weighted relevance graph (relevance.js): knowledge object -> canonical objective, score 0..1 with its band and the path that
  // gave it. Derived: rebuilt by the relevance sweep from objects, edges and the rule table (never mirrored; recomputed after a restore).
  `CREATE TABLE IF NOT EXISTS mk_relevance (object_id TEXT NOT NULL, objective_id TEXT NOT NULL, score REAL NOT NULL, band TEXT NOT NULL, basis_json TEXT NOT NULL,
     computed_v TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (object_id, objective_id))`,
  `CREATE INDEX IF NOT EXISTS mk_relevance_objective ON mk_relevance (objective_id, score DESC)`,
  // computed_v is only stamped now (event-driven recompute, no per-sweep cleanup by tag), so its index would only add a write per row.
  `DROP INDEX IF EXISTS mk_relevance_v`,
  // Which concepts the relevance sweep has computed at which rules version and sweep (derived, like mk_relevance).
  `CREATE TABLE IF NOT EXISTS mk_relevance_marks (object_id TEXT PRIMARY KEY, computed_v TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL)`,
  // The exam projection view mk_exam_relevance is created by relevance.js (best effort: the projection is a function first).
  // Relevance dirty flags (dirty.js): the objects whose relevance rows a change touched, and the frontier of the hop-radius expansion
  // (radius >= 0: a seed still to expand; -1: recompute). Derived run state, never mirrored: a restore re-marks everything (backfill).
  `CREATE TABLE IF NOT EXISTS mk_relevance_dirty (object_id TEXT PRIMARY KEY, radius INTEGER NOT NULL, reason TEXT NOT NULL, marked_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_relevance_dirty_r ON mk_relevance_dirty (radius)`,
  // Lesson and curriculum penetration (impact.js computePenetration, lifecycle stage 5): what a changed knowledge object (or a source,
  // over its objects) reaches, target kinds objective | lesson | curriculum | board_curriculum | exam, score 0..1 with its band.
  // Derived (from mk_relevance, asset links, curriculum nodes and blueprints); the queue holds subjects whose rows just changed.
  `CREATE TABLE IF NOT EXISTS mk_penetration (subject_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, score REAL NOT NULL, band TEXT NOT NULL,
     basis_json TEXT NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY (subject_id, target_kind, target_id))`,
  `CREATE INDEX IF NOT EXISTS mk_penetration_target ON mk_penetration (target_kind, target_id, score DESC)`,
  `CREATE TABLE IF NOT EXISTS mk_penetration_queue (subject_id TEXT PRIMARY KEY, reason TEXT NOT NULL, marked_at TEXT NOT NULL)`,
  // Lesson enhancements (enrich.js, lifecycle stage 6): what was added to an existing lesson instead of regenerating it (recommendation,
  // evidence, trial lineage, citation, pearl), with the asset version it produced. Durable: mirrored (registries/enhancements) and restored.
  `CREATE TABLE IF NOT EXISTS mk_enhancements (asset_id TEXT NOT NULL, object_id TEXT NOT NULL, kind TEXT NOT NULL, asset_version TEXT NOT NULL, payload_json TEXT NOT NULL,
     score REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY (asset_id, object_id))`,
  // Lesson content layers per canonical objective (layers.js, stage 7): core | adjacent | advanced | frontier. Derived.
  `CREATE TABLE IF NOT EXISTS mk_layers (objective_id TEXT NOT NULL, layer TEXT NOT NULL, n INTEGER NOT NULL, top_json TEXT NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY (objective_id, layer))`,
  // The three confidence domains (confidence.js, stage 8): evidence | relevance | lesson, 0..1 with the factors. Derived; never changes
  // mk_objects.conf or trust.
  `CREATE TABLE IF NOT EXISTS mk_confidence (object_id TEXT NOT NULL, domain TEXT NOT NULL, score REAL NOT NULL, factors_json TEXT NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY (object_id, domain))`,
  `CREATE INDEX IF NOT EXISTS mk_confidence_domain ON mk_confidence (domain, score)`,
  // Coverage snapshots (coverage.js, stage 9): one row per day, dimension and key. Derived; the last coverage.keep_days are kept.
  `CREATE TABLE IF NOT EXISTS mk_coverage (day TEXT NOT NULL, dimension TEXT NOT NULL, key TEXT NOT NULL, num INTEGER NOT NULL, den INTEGER NOT NULL, pct REAL NOT NULL, PRIMARY KEY (day, dimension, key))`,
  // Gaps (coverage.js, stage 10): rules over coverage and confidence, each with its recommended action. Derived (recomputed daily; an
  // owner acts by adding a source, which closes the gap on the next run), so not mirrored.
  `CREATE TABLE IF NOT EXISTS mk_gaps (gap_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, severity REAL NOT NULL, detail_json TEXT NOT NULL, action_json TEXT NOT NULL,
     status TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_gaps_kind ON mk_gaps (status, kind, severity DESC)`,
  // ITE -> blueprint objective mapping v2 (ite.js). mk_ite_map is CENTRAL knowledge: one row per normalized ITE wording, blueprint
  // family and objective set ('' = no blueprint objective), strengthened by every confirmation. It holds no user id, report id or
  // anything else about who confirmed it. Durable: mirrored (registries/ite_mapping) and restored.
  `CREATE TABLE IF NOT EXISTS mk_ite_map (mapping_id TEXT PRIMARY KEY, blueprint TEXT NOT NULL, exam_key TEXT NOT NULL, norm TEXT NOT NULL, source_text TEXT NOT NULL,
     objective_id TEXT NOT NULL, objective_ids TEXT NOT NULL, canonical_objective TEXT, canonical_ids TEXT NOT NULL DEFAULT '[]', discipline TEXT, confidence REAL,
     method TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, confirmations INTEGER NOT NULL DEFAULT 0, last_confirmed TEXT,
     created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mk_ite_map_norm ON mk_ite_map (blueprint, norm)`,
  // Retries of one confirmation count once (a random token from the page, no identity). Run state, pruned after 30 days.
  `CREATE TABLE IF NOT EXISTS mk_ite_seen (nonce TEXT PRIMARY KEY, at TEXT NOT NULL)`,
  // Per account and derived (rebuilt from the account's own records whenever its trace is computed): which objectives an account's
  // trace waits on, so a lesson finishing marks only those accounts (change driven), the accounts to recompute, and each account's
  // trace summary for the owner's audit panel (counts and stall times only, no item text).
  `CREATE TABLE IF NOT EXISTS mk_ite_watch (user_id TEXT NOT NULL, objective_id TEXT NOT NULL, PRIMARY KEY (user_id, objective_id))`,
  `CREATE INDEX IF NOT EXISTS mk_ite_watch_obj ON mk_ite_watch (objective_id)`,
  `CREATE TABLE IF NOT EXISTS mk_ite_dirty (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, marked_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mk_ite_audit (user_id TEXT NOT NULL, report_id TEXT NOT NULL, exam_key TEXT, counts_json TEXT NOT NULL, stall_json TEXT NOT NULL, updated TEXT NOT NULL,
     PRIMARY KEY (user_id, report_id))`,
  // Change-driven caches of central figures (SR-44): every write to mk_objects (any writer, including json_set updates) moves the
  // 'objects' counter in the same transaction, so a figure computed from mk_objects is reused exactly while the counter is unchanged
  // and recomputed the first time it moves. The counter starts at a random value, so a row made again never matches an older cache.
  // Derived run state only: never mirrored to Drive, never restored, safe to empty (it is then simply rebuilt).
  `CREATE TABLE IF NOT EXISTS mk_change (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO mk_change (k, n) VALUES ('objects', abs(random() % 1000000000000))`,
  `CREATE TRIGGER IF NOT EXISTS mk_objects_chg_i AFTER INSERT ON mk_objects BEGIN UPDATE mk_change SET n = n + 1 WHERE k = 'objects'; END`,
  `CREATE TRIGGER IF NOT EXISTS mk_objects_chg_u AFTER UPDATE ON mk_objects BEGIN UPDATE mk_change SET n = n + 1 WHERE k = 'objects'; END`,
  `CREATE TRIGGER IF NOT EXISTS mk_objects_chg_d AFTER DELETE ON mk_objects BEGIN UPDATE mk_change SET n = n + 1 WHERE k = 'objects'; END`,
  `CREATE TABLE IF NOT EXISTS mk_cache (k TEXT PRIMARY KEY, stamp TEXT NOT NULL, v TEXT NOT NULL, at TEXT NOT NULL)`,
];

let ready = '';
// Tests only: open a second database in the same process.
export const _resetInit = () => { ready = ''; };
export async function mkInit(env) {
  if (ready === FRAMEWORK_HASH) return;
  // One round trip: the tables, and which framework version the store was last opened with (settings overlay the framework defaults).
  const out = await env.DB.batch([...TABLES.map((s) => env.DB.prepare(s)), env.DB.prepare("SELECT v FROM mk_settings WHERE k = 'framework_hash'")]);
  const last = out && out[out.length - 1], row = last && Array.isArray(last.results) ? last.results[0] : undefined;
  const prev = last && Array.isArray(last.results) ? (row ? row.v : null) : await getSetting(env, 'framework_hash');
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

/* A figure computed only from mk_objects, reused while nothing in mk_objects has changed (see mk_change above). One round trip when it
   is still valid (the counter and, unless this isolate already holds it, the stored value come back together); on a change it is
   computed again and stored under the counter read before computing, so a value is never served for a state older than it reflects. */
const MEMO = new Map();
export async function objectsCached(env, key, compute) {
  const mem = MEMO.get(key);
  let row = null;
  try {
    row = await env.DB.prepare(`SELECT (SELECT n FROM mk_change WHERE k = 'objects') AS cur, c.stamp AS stamp, CASE WHEN c.stamp = ? THEN NULL ELSE c.v END AS v
      FROM (SELECT 1) LEFT JOIN mk_cache c ON c.k = ?`).bind(mem ? mem.stamp : '', key).first();
  } catch (e) { row = null; }
  if (!row || row.cur == null) return compute();   // no counter (a database without the triggers yet): compute as before
  const cur = String(row.cur);
  if (mem && mem.stamp === cur) return mem.v;
  if (row.stamp === cur) {
    const v = J(row.v, undefined); if (v !== undefined) { MEMO.set(key, { stamp: cur, v }); return v; }
  }
  const v = await compute();
  MEMO.set(key, { stamp: cur, v });
  try { await env.DB.prepare('INSERT INTO mk_cache (k, stamp, v, at) VALUES (?, ?, ?, ?) ON CONFLICT (k) DO UPDATE SET stamp = excluded.stamp, v = excluded.v, at = excluded.at').bind(key, cur, JSON.stringify(v), nowIso()).run(); } catch (e) { /* the value is still returned */ }
  return v;
}
