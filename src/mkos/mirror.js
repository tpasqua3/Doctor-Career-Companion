// CANONICAL STORAGE (MKOS Canonical Storage, Persistence, Governance and System-of-Record Directive): Google Drive is the system of
// record; D1 is the execution layer and must stay rebuildable from Drive (restore.js). Folder: Side Gigs > App Backends > Doctor
// Companion App > Doctor Companion App Central Registry Data > MKOS (MKOS_DRIVE_FOLDER). Written by the server; edits made there are
// not read back except by an owner-confirmed restore. Layout:
//   README.txt, manifest.json                                   what is here, and every file's id, hash, row count and sync time
//   ontology/mkos-framework.json                                the ontology, frameworks and schemas the knowledge follows
//   registry_data/<Type>/<specialty>.json                       every knowledge object (sources, guidelines, concepts, recommendations,
//                                                               evidence, claims, objectives, teaching points, targets, pearls,
//                                                               blueprint topics, curriculum, asset records), with scores, confidence,
//                                                               classification, provenance and change log
//   history/<Type>/<specialty>.json                             every version of those objects (version history, rollback)
//   graph/edges_<bucket>.json                                   the knowledge graph (typed relationships), in stable buckets
//   assets/<asset kind>/<specialty>.json                        shared educational assets (lessons, questions, flashcards) with content
//   registries/sources_registry.json, blueprints.json           readable sources registry; blueprint execution tables and mappings
//   registries/lifecycle.json                                   every source's Continuous Knowledge Lifecycle record (stages, history)
//   registries/enhancements.json                                every lesson enhancement (enrich.js) with the asset version it made
//   registries/guidelines_registry_vN_MKOS_STAGED.json          the compatibility registry (cutover step 2)
//   governance/events_YYYY-MM.json, audit_YYYY-MM.json, reviews.json, reconciliation.json
//   config/configuration.json                                   configuration: the AI order of operations (built-in and the owner's
//                                                               changes), framework overrides, ingestion, persistence and engine
//                                                               settings, the site's own pages; every future setting by default
//                                                               (credentials never: they stay Worker secrets)
//   central/<record>.json                                       central registry records kept out of every account: the pronunciation
//                                                               registry and its change log (and their daily copies), the ABIM
//                                                               blueprint document the curriculum was built from
//   governance/persistence_YYYY-MM.json                         the persistence ledger (queued, persisted, failed, retried, reconciled)
//   snapshot/mkos-knowledge-base.json                           one bundled restore point, daily
// Change detection is cheap: one grouped query per family of files gives every file's fingerprint, and only files whose fingerprint
// moved are rebuilt and compared by content hash.
// SYNC REQUIREMENT: a changed file is queued (mk_mirror 'pend:<file>', ledger state 'queued') the first time its fingerprint moves, and
// stays pending until Drive itself confirms the write (the size and MD5 Drive reports for the uploaded file match what was sent). A
// refused or unconfirmed write is recorded ('failed') and retried by every later run ('retried' when it then succeeds); nothing is
// skipped silently. durability() reports what is pending and for how long; the daily reconciliation flags anything overdue.
// Learner state and a learner's own assets are never written here: they live in that account's own Drive folder (the app's record sync).
import { FRAMEWORK, FRAMEWORK_HASH } from './framework.js';
import { J, nowIso, getSetting, setSetting, mkInit } from './db.js';
import { contentHash } from './kb.js';
import { buildCompatRegistry } from './cutover.js';

const README = `MKOS: the Medical Knowledge Operating System behind the Doctor Career Companion app.

This folder is the system of record for the app's knowledge base: one knowledge base for every account. The server's database is
only the fast working copy and can be rebuilt from these files (owner tool "restore"). Files are written by the server automatically
whenever the knowledge changes. Do not edit them by hand. Change knowledge by adding or replacing documents in the Medical
Knowledge Database folder (the server notices within minutes), or through the owner tools.

manifest.json    every file here with its id, content hash, row count and when it was written.
registry_data/   every knowledge object: sources, guidelines, concepts, recommendations (class and level of evidence), evidence,
                 criteria, objectives, competencies, teaching points, high-yield points, common errors, clinical pearls, lesson,
                 question, flashcard, case and review targets, pathways, blueprint topics and mappings, curriculum, asset records,
                 with confidence, classification, governance and provenance.
history/         every version of every object (version history).
graph/           the knowledge graph: typed relationships between all of the above.
assets/          the shared library of educational assets (lessons, questions, flashcards) with their content.
registries/      the readable sources registry, the board blueprint tables, the staged compatibility registry, and each source's
                 knowledge lifecycle record (lifecycle.json), and the enhancements added to lessons (enhancements.json).
governance/      change events, audit records, reviews and the daily reconciliation report.
snapshot/        one bundled file holding the knowledge base, as a restore point.
ontology/        the ontology, frameworks and schemas the knowledge base follows.
config/          configuration: AI order of operations, framework overrides, engine, ingestion and persistence settings, site pages.
central/         central registry records that belong to no account: the pronunciation registry and its change log, the ABIM
                 blueprint document the curriculum was built from.

Each person's own learning state and personal material stay in their account's folder under "Doctor Companion App Account-level Data".
`;

const spec2 = (s) => String(s || 'general').replace(/^spec\./, '');
const specWhere = (s) => s === 'general' ? "(o.specialty IS NULL OR o.specialty = 'general')" : 'o.specialty = ?';
const specArgs = (s) => s === 'general' ? [] : ['spec.' + s];
const BUCKET = "CASE WHEN lower(substr(src, -1)) GLOB '[a-z0-9]' THEN lower(substr(src, -1)) ELSE '_' END";

// ---------- Configuration and central records ----------
// Operational state (cursors, leases, counters, reports persisted elsewhere) is not configuration and stays in D1. Everything else in
// mk_settings and the app's settings table is configuration and persists by default, so a setting added later is covered without a
// change here. Credentials are never written to Drive.
// lc_*: the lifecycle orchestrator's cursors and pass state (lifecycle.js), run state like the scan cursor.
const STATE_KEYS = /^(tick|tick_lease|scan|scan_last_complete|ai_budget|drill_prog|drill_report|learner_watch|mirror_errors|reconcile_day|reconcile_report|snapshot_day|pron_gen_day|pron_sync|pron_sync_t|persist_lease|restore_prog|lc_[a-z_]+)$/;
const CREDENTIAL = /^google_|token|secret|refresh|password|credential|api_?key/i;
// Settings that change as the engine runs; a restore drill compares only the rest (they can move between the persist and the compare).
export const CONFIG_MOVING = /^(bootstrap|paused|framework_hash|legacy_registry_check)$/;
export const CENTRAL = '_central';
const centralName = (path) => String(path).replace(/[^A-Za-z0-9_.-]+/g, '__') + '.json';
export async function configDoc(env, deps) {
  const mk = (await env.DB.prepare('SELECT k, v FROM mk_settings ORDER BY k').all()).results.filter((r) => !STATE_KEYS.test(r.k));
  let app = []; try { app = (await env.DB.prepare('SELECT k, v FROM settings ORDER BY k').all()).results.filter((r) => !CREDENTIAL.test(r.k)); } catch (e) { app = []; }
  let routing = null; try { routing = deps && deps.appConfig ? await deps.appConfig() : null; } catch (e) { routing = { error: String(e.message || e).slice(0, 120) }; }
  return { kind: 'mkos-configuration', app: 'doctor-career-companion', framework_hash: FRAMEWORK_HASH,
    note: 'Values are stored exactly as the database holds them (strings). Restored where missing; credentials (Google connection, API keys) are never written here and are set again as Worker secrets after a rebuild.',
    app_settings: Object.fromEntries(app.map((r) => [r.k, r.v])), mkos_settings: Object.fromEntries(mk.map((r) => [r.k, r.v])), ai_routing: routing };
}
async function centralRows(env) {
  try { return (await env.DB.prepare('SELECT path, length(body) AS l, updated FROM docs WHERE user_id = ? ORDER BY path').bind(CENTRAL).all()).results; } catch (e) { return []; }
}

/* Every file with its fingerprint, from a few grouped queries. Returns [{key, fp}] in write order (manifest last). */
async function fingerprints(env, deps) {
  const out = [{ key: 'readme', fp: README.length + ':' + FRAMEWORK_HASH }, { key: 'ontology', fp: FRAMEWORK_HASH }];
  // Configuration and central records first: small, and the hardest to recreate.
  out.push({ key: 'config', fp: await contentHash(await configDoc(env, deps)) });
  for (const r of await centralRows(env)) out.push({ key: 'central/' + r.path, fp: `${r.l}|${r.updated}` });
  const objs = (await env.DB.prepare("SELECT type, COALESCE(specialty, 'general') AS s, COUNT(*) AS n, MAX(updated) AS u, SUM(LENGTH(body)) AS l FROM mk_objects WHERE id NOT LIKE 'ea.u%' GROUP BY type, s").all()).results;
  for (const r of objs) out.push({ key: `registry_data/${r.type}/${spec2(r.s)}`, fp: `${r.n}|${r.u}|${r.l}`, n: r.n });
  const src = objs.filter((r) => r.type === 'Source').map((r) => `${r.n}|${r.u}|${r.l}`).join(',');
  out.push({ key: 'registries/sources', fp: src }, { key: 'registries/compat', fp: src });
  for (const r of (await env.DB.prepare("SELECT o.type AS type, COALESCE(o.specialty, 'general') AS s, COUNT(*) AS n, MAX(v.at) AS u FROM mk_versions v JOIN mk_objects o ON o.id = v.id WHERE o.id NOT LIKE 'ea.u%' GROUP BY o.type, s").all()).results)
    out.push({ key: `history/${r.type}/${spec2(r.s)}`, fp: `${r.n}|${r.u}`, n: r.n });
  for (const r of (await env.DB.prepare(`SELECT ${BUCKET} AS b, COUNT(*) AS n, MAX(updated) AS u, SUM(conf) AS c, SUM(LENGTH(status)) AS st FROM mk_edges GROUP BY b`).all()).results)
    out.push({ key: `graph/edges_${r.b}`, fp: `${r.n}|${r.u}|${r.c}|${r.st}`, n: r.n });
  for (const r of (await env.DB.prepare("SELECT COALESCE(json_extract(o.body, '$.asset_kind'), 'asset') AS k, COALESCE(o.specialty, 'general') AS s, COUNT(*) AS n, MAX(o.updated) AS u, SUM(LENGTH(o.body)) AS l, (SELECT COUNT(*) FROM mk_asset_store) AS sc FROM mk_objects o WHERE o.type = 'EducationalAsset' AND o.id LIKE 'ea.s.%' GROUP BY k, s").all()).results)
    out.push({ key: `assets/${r.k}/${spec2(r.s)}`, fp: `${r.n}|${r.u}|${r.l}|${r.sc}`, n: r.n });
  const bp = await env.DB.prepare("SELECT (SELECT COUNT(*) || '|' || COALESCE(MAX(version), '') FROM mk_blueprint_registries) || '/' || (SELECT COUNT(*) FROM mk_blueprint_domains) || '/' || (SELECT COUNT(*) FROM mk_blueprint_objectives) || '/' || (SELECT COUNT(*) || '|' || COALESCE(SUM(priority_score), 0) FROM mk_blueprint_concept_mappings) || '/' || (SELECT COUNT(*) FROM mk_blueprint_asset_mappings) AS fp").first();
  out.push({ key: 'registries/blueprints', fp: bp ? bp.fp : '' });
  // The lifecycle records (durable: a source's lifecycle history is not derivable). The relevance graph is derived and not written.
  const lc = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM mk_lifecycle').first();
  out.push({ key: 'registries/lifecycle', fp: lc && lc.n ? `${lc.n}|${lc.u}` : '', n: lc ? lc.n : 0 });
  // Lesson enhancements (durable: lesson version history). Penetration, layers, confidence, coverage and gaps are derived and not written.
  const en = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(at) AS u FROM mk_enhancements').first();
  if (en && en.n) out.push({ key: 'registries/enhancements', fp: `${en.n}|${en.u}`, n: en.n });
  const month = nowIso().slice(0, 7);
  const ev = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated) AS u FROM mk_events WHERE created LIKE ?').bind(month + '%').first();
  out.push({ key: 'governance/events_' + month, fp: `${ev.n}|${ev.u}` });
  const au = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM mk_audit WHERE at LIKE ?').bind(month + '%').first();
  out.push({ key: 'governance/audit_' + month, fp: `${au.n}|${au.m}` });
  const rv = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(at) AS u FROM mk_reviews').first();
  out.push({ key: 'governance/reviews', fp: `${rv.n}|${rv.u}` });
  const rc = await getSetting(env, 'reconcile_report');
  out.push({ key: 'governance/reconciliation', fp: rc ? String(rc.length) + (J(rc, {}) || {}).finished : '' });
  // The ledger is written after this run's own entries, so it trails by one run (it describes the files, it is not one of them).
  const pl = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(id) AS m FROM mk_persist_log WHERE at LIKE ? AND state != 'queued' AND key NOT LIKE 'governance/persistence_%'").bind(month + '%').first();
  out.push({ key: 'governance/persistence_' + month, fp: `${pl.n}|${pl.m}` });
  return out;
}

async function content(env, key, deps) {
  if (key === 'config') { const d = await configDoc(env, deps); return { name: 'configuration.json', folder: 'config', text: JSON.stringify(d, null, 1), n: Object.keys(d.app_settings).length + Object.keys(d.mkos_settings).length }; }
  if (key.startsWith('central/')) {
    const path = key.slice(8), r = await env.DB.prepare('SELECT body, updated FROM docs WHERE user_id = ? AND path = ?').bind(CENTRAL, path).first(); if (!r) return null;
    return { name: centralName(path), folder: 'central', text: '{"kind":"mkos-central-record","path":' + JSON.stringify(path) + ',"updated":' + JSON.stringify(r.updated) + ',"body":' + r.body + '}', n: 1 };
  }
  let pm = /^governance\/persistence_(\d{4}-\d{2})$/.exec(key);
  if (pm) { const rows = (await env.DB.prepare('SELECT at, key, state, detail FROM mk_persist_log WHERE at LIKE ? ORDER BY id').bind(pm[1] + '%').all()).results; return { name: `persistence_${pm[1]}.json`, folder: 'governance', text: JSON.stringify(rows), n: rows.length }; }
  if (key === 'readme') return { name: 'README.txt', folder: '', text: README, mime: 'text/plain' };
  if (key === 'ontology') return { name: 'mkos-framework.json', folder: 'ontology', text: JSON.stringify({ framework_hash: FRAMEWORK_HASH, ...FRAMEWORK }, null, 1) };
  if (key === 'registries/sources') {
    const { results } = await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' ORDER BY specialty, name").all();
    const rows = results.map((r) => J(r.body)).map((s) => ({ id: s.id, label: s.short_label || s.name, title: s.title, class: s.source_class, specialty: s.specialty, status: s.status, governance: s.governance_status,
      year: s.year, citation: s.citation || '', doi: s.doi || '', orgs: s.responsible_orgs || [], population: s.population, family: s.guideline_family || null, edition_role: s.edition_role || null,
      ref_id: s.registry_ref_id || null, drive_file_id: s.drive_file_id, path: s.drive_path, ingest: s.ingest_state, trust: s.scores?.trust_score, version: s.version }));
    return { name: 'sources_registry.json', folder: 'registries', text: JSON.stringify({ count: rows.length, sources: rows }, null, 1), n: rows.length };
  }
  if (key === 'registries/compat') {
    const c = await buildCompatRegistry(env); if (!c) return null;
    return { name: `guidelines_registry_v${c.registry_version}_MKOS_STAGED.json`, folder: 'registries', text: JSON.stringify(c, null, 1) };
  }
  if (key === 'registries/blueprints') {
    const t = async (name) => (await env.DB.prepare(`SELECT * FROM ${name}`).all()).results;
    const doc = { kind: 'mkos-blueprint-tables', registries: await t('mk_blueprint_registries'), domains: await t('mk_blueprint_domains'), objectives: await t('mk_blueprint_objectives'),
      concept_mappings: await t('mk_blueprint_concept_mappings'), asset_mappings: await t('mk_blueprint_asset_mappings') };
    return { name: 'blueprints.json', folder: 'registries', text: JSON.stringify(doc), n: doc.concept_mappings.length };
  }
  if (key === 'registries/lifecycle') {
    const rows = (await env.DB.prepare('SELECT * FROM mk_lifecycle ORDER BY source_id').all()).results.map((r) => ({ ...r, stages_json: J(r.stages_json, {}) }));
    return { name: 'lifecycle.json', folder: 'registries', text: JSON.stringify({ kind: 'mkos-lifecycle', count: rows.length, records: rows }), n: rows.length };
  }
  if (key === 'registries/enhancements') {
    const rows = (await env.DB.prepare('SELECT * FROM mk_enhancements ORDER BY asset_id, object_id').all()).results.map((r) => ({ ...r, payload_json: J(r.payload_json, {}) }));
    return { name: 'enhancements.json', folder: 'registries', text: JSON.stringify({ kind: 'mkos-enhancements', count: rows.length, records: rows }), n: rows.length };
  }
  let m = /^governance\/(events|audit)_(\d{4}-\d{2})$/.exec(key);
  if (m) {
    const rows = m[1] === 'events' ? (await env.DB.prepare('SELECT * FROM mk_events WHERE created LIKE ? ORDER BY created').bind(m[2] + '%').all()).results.map((r) => ({ ...r, detail: J(r.detail), impact: J(r.impact) }))
      : (await env.DB.prepare('SELECT * FROM mk_audit WHERE at LIKE ? ORDER BY id').bind(m[2] + '%').all()).results.map((r) => ({ ...r, detail: J(r.detail) }));
    return { name: `${m[1]}_${m[2]}.json`, folder: 'governance', text: JSON.stringify(rows), n: rows.length };
  }
  if (key === 'governance/reviews') { const rows = (await env.DB.prepare('SELECT * FROM mk_reviews ORDER BY at').all()).results; return { name: 'reviews.json', folder: 'governance', text: JSON.stringify(rows), n: rows.length }; }
  if (key === 'governance/reconciliation') { const r = await getSetting(env, 'reconcile_report'); return { name: 'reconciliation.json', folder: 'governance', text: r || '{}' }; }
  m = /^registry_data\/([A-Za-z]+)\/(.+)$/.exec(key);
  if (m) {
    const { results } = await env.DB.prepare(`SELECT o.body FROM mk_objects o WHERE o.type = ? AND o.id NOT LIKE 'ea.u%' AND ${specWhere(m[2])} ORDER BY o.id`).bind(m[1], ...specArgs(m[2])).all();
    return { name: m[2] + '.json', folder: 'registry_data/' + m[1], text: '{"type":' + JSON.stringify(m[1]) + ',"specialty":' + JSON.stringify(m[2]) + ',"count":' + results.length + ',"objects":[' + results.map((r) => r.body).join(',') + ']}', n: results.length };
  }
  m = /^history\/([A-Za-z]+)\/(.+)$/.exec(key);
  if (m) {
    const { results } = await env.DB.prepare(`SELECT v.id, v.version, v.hash, v.at, v.event_id, v.actor, v.body FROM mk_versions v JOIN mk_objects o ON o.id = v.id WHERE o.type = ? AND o.id NOT LIKE 'ea.u%' AND ${specWhere(m[2])} ORDER BY v.id, v.at`).bind(m[1], ...specArgs(m[2])).all();
    return { name: m[2] + '.json', folder: 'history/' + m[1], text: '{"type":' + JSON.stringify(m[1]) + ',"specialty":' + JSON.stringify(m[2]) + ',"count":' + results.length + ',"versions":[' + results.map((r) => JSON.stringify({ id: r.id, version: r.version, hash: r.hash, at: r.at, event_id: r.event_id, actor: r.actor }).slice(0, -1) + ',"body":' + r.body + '}').join(',') + ']}', n: results.length };
  }
  m = /^graph\/edges_(.)$/.exec(key);
  if (m) {
    const { results } = await env.DB.prepare(`SELECT src, rel, dst, status, conf, prov, created, updated FROM mk_edges WHERE ${BUCKET} = ? ORDER BY src, rel, dst`).bind(m[1]).all();
    return { name: `edges_${m[1]}.json`, folder: 'graph', text: JSON.stringify(results.map((r) => ({ ...r, prov: J(r.prov) }))), n: results.length };
  }
  m = /^assets\/([a-z_]+)\/(.+)$/.exec(key);
  if (m) {
    const { results } = await env.DB.prepare(`SELECT o.id, o.body, (SELECT s.content FROM mk_asset_store s WHERE s.asset_id = o.id ORDER BY s.at DESC, s.rowid DESC LIMIT 1) AS content,
      (SELECT s.version FROM mk_asset_store s WHERE s.asset_id = o.id ORDER BY s.at DESC, s.rowid DESC LIMIT 1) AS cv FROM mk_objects o
      WHERE o.type = 'EducationalAsset' AND o.id LIKE 'ea.s.%' AND COALESCE(json_extract(o.body, '$.asset_kind'), 'asset') = ? AND ${specWhere(m[2])} ORDER BY o.id`).bind(m[1], ...specArgs(m[2])).all();
    return { name: m[2] + '.json', folder: 'assets/' + m[1], text: '{"asset_kind":' + JSON.stringify(m[1]) + ',"count":' + results.length + ',"assets":[' + results.map((r) => '{"record":' + r.body + ',"content_version":' + JSON.stringify(r.cv) + ',"content":' + (r.content || 'null') + '}').join(',') + ']}', n: results.length };
  }
  return null;
}

// The content hash a file would be written with now (the manifest records the same hash for what Drive holds).
export async function fileHash(env, key, deps) { const c = await content(env, key, deps); return c ? contentHash({ t: c.text }) : null; }

/* DRIVE EXISTS: list every MKOS folder in Drive and check that each file the database believes is there still is. A file removed
   or trashed in Drive is forgotten here, so the next runs write it again (ledger state 'reconciled'). Drive requests only. */
export async function driveCheck(env, deps, root) {
  const dirs = [{ path: '', id: root }, ...(await env.DB.prepare("SELECT key, file_id FROM mk_mirror WHERE key LIKE 'dir:%'").all()).results.map((r) => ({ path: r.key.slice(4), id: r.file_id }))];
  const seen = new Set(), goneDirs = [];
  for (const d of dirs) {
    let token = null, ok = false;
    try { do { const page = await deps.list(d.id, token); ok = true; for (const f of page.files || []) seen.add(f.id); token = page.next || page.nextPageToken; } while (token); }
    catch (e) { if (!ok) goneDirs.push(d.path); }
  }
  // A folder that could not be listed may be a passing Drive error: judge nothing this time rather than write duplicates.
  if (goneDirs.length) return { folders: dirs.length, folders_unreadable: goneDirs.length, unreadable: goneDirs.slice(0, 10), checked: false };
  const files = (await env.DB.prepare("SELECT key, file_id FROM mk_mirror WHERE file_id IS NOT NULL AND key NOT LIKE 'dir:%' AND key NOT LIKE 'n:%' AND key NOT LIKE 'pend:%' AND key NOT LIKE 'fp:%'").all()).results;
  const missing = files.filter((f) => !seen.has(f.file_id)).map((f) => f.key);
  for (const k of missing) {
    await env.DB.batch([env.DB.prepare('DELETE FROM mk_mirror WHERE key IN (?, ?)').bind(k, 'fp:' + k),
      env.DB.prepare('INSERT INTO mk_persist_log (at, key, state, detail) VALUES (?, ?, ?, ?)').bind(nowIso(), k, 'reconciled', 'not found in Drive; written again')]);
  }
  return { folders: dirs.length, folders_unreadable: goneDirs.length, files_checked: files.length, files_in_drive: files.length - missing.length, missing_rewritten: missing.slice(0, 20), missing: missing.length };
}

// Folder ids under the MKOS root, made on first use and remembered in mk_mirror (key 'dir:<path>').
async function folder(env, deps, root, path) {
  if (!path) return root;
  let parent = root, acc = '';
  for (const part of path.split('/')) {
    acc = acc ? acc + '/' + part : part;
    const row = await env.DB.prepare('SELECT file_id FROM mk_mirror WHERE key = ?').bind('dir:' + acc).first();
    if (row && row.file_id) { parent = row.file_id; continue; }
    const id = await deps.mkdir(part, parent);
    await env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind('dir:' + acc, id, '', nowIso()).run();
    parent = id;
  }
  return parent;
}
// Drive's confirmation of a write: the upload answers with the size and MD5 Drive stored, which must match what was sent. (A helper
// that answers only with an id, as in tests, counts as confirmed by the id alone.)
const enc = new TextEncoder();
async function md5hex(bytes) { try { return [...new Uint8Array(await crypto.subtle.digest('MD5', bytes))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch (e) { return null; } }
async function confirm(meta, text) {
  if (typeof meta === 'string') return { id: meta, confirmed: true, how: 'id' };
  if (!meta || !meta.id) throw new Error('Drive returned no file id');
  const bytes = enc.encode(text);
  if (meta.size != null && meta.size !== '' && Number(meta.size) !== bytes.length) throw new Error(`Drive stored ${meta.size} bytes, ${bytes.length} were sent`);
  if (meta.md5) { const m = await md5hex(bytes); if (m && m !== meta.md5) throw new Error('Drive reports a different MD5 than what was sent'); }
  return { id: meta.id, confirmed: true, how: meta.md5 ? 'md5' : meta.size != null ? 'size' : 'id' };
}
async function write(env, deps, root, c, key) {
  const parent = await folder(env, deps, root, c.folder), row = await env.DB.prepare('SELECT file_id FROM mk_mirror WHERE key = ?').bind(key).first();
  let meta;
  try { meta = await deps.upload({ id: row && row.file_id, name: c.name, parent, text: c.text, mime: c.mime }); }
  catch (e) { if (!e.gone) throw e; meta = await deps.upload({ name: c.name, parent, text: c.text, mime: c.mime }); }   // removed by hand in Drive: write it again
  return (await confirm(meta, c.text)).id;
}
const SELF = (key) => key.startsWith('governance/persistence_');   // the ledger's own file is not logged in itself (it would never settle)
const ledger = async (env, key, state, detail) => SELF(key) ? null : env.DB.prepare('INSERT INTO mk_persist_log (at, key, state, detail) VALUES (?, ?, ?, ?)').bind(nowIso(), key, state, detail == null ? null : String(detail).slice(0, 300)).run();
const put = (env, key, file_id, hash) => env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind(key, file_id, hash, nowIso()).run();

/* Persist up to `max` files whose fingerprint moved, then the manifest. Returns {written, dirty, files, failed}. Unchanged content
   (same hash) only records the new fingerprint, so a file is never rewritten for nothing. `only` limits the run to files whose key
   starts with one of the given prefixes (an immediate persist after a configuration or central-record change). */
export async function mirrorStep(env, deps, root, { max = 4, only = null } = {}) {
  if (!root) return { off: true };
  const fps = await fingerprints(env, deps);
  const known = Object.fromEntries((await env.DB.prepare("SELECT key, file_id, hash, synced FROM mk_mirror WHERE key NOT LIKE 'dir:%'").all()).results.map((r) => [r.key, r]));
  const dirty = fps.filter((f) => !known['fp:' + f.key] || known['fp:' + f.key].hash !== f.fp);
  // Queue: the first time a file's fingerprint moves it becomes pending, and stays so until Drive confirms it.
  const fresh = dirty.filter((f) => !known['pend:' + f.key]), at = nowIso();
  for (let i = 0; i < fresh.length; i += 40) await env.DB.batch(fresh.slice(i, i + 40).flatMap((f) => [
    env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, NULL, ?, ?)').bind('pend:' + f.key, '0', at),
    ...(SELF(f.key) ? [] : [env.DB.prepare('INSERT INTO mk_persist_log (at, key, state, detail) VALUES (?, ?, ?, NULL)').bind(at, f.key, 'queued')])]));
  for (const f of fresh) known['pend:' + f.key] = { hash: '0', synced: at };
  // Oldest pending first, so a file that keeps changing never starves the ones behind it.
  const since = (f) => (known['pend:' + f.key] || {}).synced || '';
  const todo = (only ? dirty.filter((f) => only.some((p) => f.key === p || f.key.startsWith(p))) : dirty).slice().sort((a, b) => since(a).localeCompare(since(b)));
  let written = 0, failed = 0;
  for (const f of todo.slice(0, max + 6)) {
    if (written >= max) break;
    const tries = Number((known['pend:' + f.key] || {}).hash) || 0;
    try {
      const c = await content(env, f.key, deps);
      if (c) {
        const hash = await contentHash({ t: c.text });
        if (!known[f.key] || known[f.key].hash !== hash) {
          const id = await write(env, deps, root, c, f.key);
          await put(env, f.key, id, hash);
          await put(env, 'n:' + f.key, c.folder + '/' + c.name, String(c.n ?? ''));
          written++;
          await ledger(env, f.key, tries ? 'retried' : 'persisted', `${c.folder}/${c.name}` + (tries ? ` after ${tries} failed attempt(s)` : ''));
        }
      }
      await put(env, 'fp:' + f.key, null, f.fp);
      await env.DB.prepare('DELETE FROM mk_mirror WHERE key = ?').bind('pend:' + f.key).run();
    } catch (e) {
      if (e && e.budget) throw e;
      failed++;
      await put(env, 'pend:' + f.key, null, String(tries + 1));   // still pending; the next run retries it
      await ledger(env, f.key, 'failed', String(e && e.message || e));
      if (failed >= 2) break;   // Drive is refusing: stop for this run rather than fail every file
    }
  }
  // The manifest: the index a restore starts from, rewritten whenever anything was written (or if it is missing).
  if (written || !known.manifest) {
    const rows = (await env.DB.prepare("SELECT key, file_id, hash, synced FROM mk_mirror WHERE key NOT LIKE 'dir:%' AND key NOT LIKE 'fp:%' AND key NOT LIKE 'n:%' AND key NOT LIKE 'pend:%' AND key NOT IN ('manifest','snapshot')").all()).results;
    const names = Object.fromEntries((await env.DB.prepare("SELECT key, file_id, hash FROM mk_mirror WHERE key LIKE 'n:%'").all()).results.map((r) => [r.key.slice(2), r]));
    const current = new Set(fps.map((f) => f.key));   // files of an older layout are left out of the index (a restore reads only these)
    const files = Object.fromEntries(rows.filter((r) => current.has(r.key)).map((r) => [r.key, { file_id: r.file_id, path: names[r.key] ? names[r.key].file_id : null, rows: names[r.key] && names[r.key].hash !== '' ? Number(names[r.key].hash) : null, hash: r.hash, synced: r.synced }]));
    const pending = (await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_mirror WHERE key LIKE 'pend:%'").first()).n;
    const doc = { app: 'doctor-career-companion', kind: 'mkos-manifest', framework_hash: FRAMEWORK_HASH, written: nowIso(), pending_files: pending, files };
    const id = await write(env, deps, root, { name: 'manifest.json', folder: '', text: JSON.stringify(doc, null, 1) }, 'manifest');
    await put(env, 'manifest', id, String(pending));
  }
  return { written, dirty: dirty.length, files: fps.length, failed };
}

/* An immediate persist of the given files (configuration, central records), outside the engine's run. A short lease keeps two of
   these, or one and the engine's own mirror, from creating the same new file twice. */
export async function persistNow(env, deps, root, { only, max = 6 } = {}) {
  await mkInit(env);
  const lease = J(await getSetting(env, 'persist_lease'), null); if (lease && Date.now() - lease.t < 60e3) return { skipped: 'busy' };
  await setSetting(env, 'persist_lease', JSON.stringify({ t: Date.now() }));
  try { return await mirrorStep(env, deps, root, { max, only }); } finally { await setSetting(env, 'persist_lease', null); }
}

// How far canonical storage is behind the database: files whose fingerprint moved since they were last persisted, how long the oldest
// has been pending, and the ledger's last day.
export async function durability(env, deps) {
  const fps = await fingerprints(env, deps);
  const known = Object.fromEntries((await env.DB.prepare("SELECT key, hash, synced FROM mk_mirror WHERE key LIKE 'fp:%' OR key LIKE 'pend:%' OR key = 'manifest' OR key = 'snapshot'").all()).results.map((r) => [r.key, r]));
  const behind = fps.filter((f) => !known['fp:' + f.key] || known['fp:' + f.key].hash !== f.fp).map((f) => f.key);
  const pend = Object.entries(known).filter(([k]) => k.startsWith('pend:')).map(([k, r]) => ({ file: k.slice(5), since: r.synced, failed_attempts: Number(r.hash) || 0 })).sort((a, b) => a.since.localeCompare(b.since));
  const day = new Date(Date.now() - 864e5).toISOString();
  const states = Object.fromEntries((await env.DB.prepare('SELECT state, COUNT(*) AS n FROM mk_persist_log WHERE at >= ? GROUP BY state').bind(day).all()).results.map((r) => [r.state, r.n]));
  return { files: fps.length, persisted: fps.length - behind.length, behind: behind.length, behind_files: behind.slice(0, 40),
    pending: pend.length, oldest_pending_since: pend[0] ? pend[0].since : null, oldest_pending_minutes: pend[0] ? Math.round((Date.now() - Date.parse(pend[0].since)) / 60e3) : 0,
    failing: pend.filter((p) => p.failed_attempts).slice(0, 10), ledger_24h: states,
    manifest_written: known.manifest ? known.manifest.synced : null, snapshot_written: known.snapshot ? known.snapshot.synced : null };
}

// The daily snapshot: every object, edge and shared asset in one file (a restore point independent of the sharded layout).
export async function snapshot(env, deps, root) {
  const day = nowIso().slice(0, 10); if ((await getSetting(env, 'snapshot_day')) === day) return { skipped: true };
  const objs = (await env.DB.prepare("SELECT body FROM mk_objects WHERE id NOT LIKE 'ea.u%' ORDER BY id").all()).results.map((r) => r.body);
  const edges = (await env.DB.prepare('SELECT src, rel, dst, status, conf FROM mk_edges').all()).results;
  const store = (await env.DB.prepare("SELECT s.asset_id, s.version, s.content FROM mk_asset_store s WHERE s.asset_id LIKE 'ea.s.%' AND s.rowid = (SELECT t.rowid FROM mk_asset_store t WHERE t.asset_id = s.asset_id ORDER BY t.at DESC, t.rowid DESC LIMIT 1)").all()).results;
  const text = '{"app":"doctor-career-companion","kind":"mkos-snapshot","framework_hash":' + JSON.stringify(FRAMEWORK_HASH) + ',"saved":' + JSON.stringify(nowIso()) + ',"objects":[' + objs.join(',') + '],"edges":' + JSON.stringify(edges)
    + ',"asset_content":[' + store.map((r) => '{"asset_id":' + JSON.stringify(r.asset_id) + ',"version":' + JSON.stringify(r.version) + ',"content":' + r.content + '}').join(',') + ']}';
  const parent = await folder(env, deps, root, 'snapshot'), row = await env.DB.prepare("SELECT file_id FROM mk_mirror WHERE key = 'snapshot'").first();
  let id = row && row.file_id;
  try { id = await deps.upload({ id, name: 'mkos-knowledge-base.json', parent, text }); } catch (e) { if (!e.gone) throw e; id = await deps.upload({ name: 'mkos-knowledge-base.json', parent, text }); }
  await env.DB.prepare("INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES ('snapshot', ?, ?, ?)").bind(id, day, nowIso()).run();
  await setSetting(env, 'snapshot_day', day);
  return { objects: objs.length, edges: edges.length, assets: store.length, bytes: text.length };
}
