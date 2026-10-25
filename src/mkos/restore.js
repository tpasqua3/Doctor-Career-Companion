// REBUILD FROM CANONICAL STORAGE: the operational database (D1) is rebuildable from the Drive MKOS folder, which is the system of record
// (mirror.js). A restore reads manifest.json and then each listed file, in dependency order, and upserts what it holds:
//   registry_data -> mk_objects (and the alias index)    history -> mk_versions    graph -> mk_edges
//   assets -> EducationalAsset records + mk_asset_store  registries/blueprints -> the blueprint execution tables    governance/reviews -> mk_reviews
//   registries/lifecycle -> mk_lifecycle (the relevance graph, mk_relevance, is derived and rebuilt by the lifecycle sweep)
//   config -> the app's settings and mk_settings (only where missing; credentials are never in Drive)
//   central -> the central registry records (docs held by '_central': pronunciation registry, change log, ABIM blueprint document)
// It never replaces a newer row with an older one (objects keep whichever 'updated' is later; versions, edges, content and table rows are
// inserted only when absent), so it is safe on an empty database and on a live one. Resumable: prog keeps the file and row position.
// Learner state is not part of canonical knowledge: it is rebuilt from each account's own record by the engine's learner jobs.
import { J, nowIso, audit, TABLES, setSetting } from './db.js';
import { contentHash, indexAliases, norm } from './kb.js';
import { queue } from './ingest.js';
import { fileHash, configDoc, CONFIG_MOVING, CENTRAL } from './mirror.js';

// The app's own tables that canonical storage also restores (the configuration and central records live in them).
export const APP_TABLES = ['CREATE TABLE IF NOT EXISTS docs (user_id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (user_id, path))',
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)'];

const ORDER = ['config', 'central/', 'registry_data/', 'history/', 'graph/', 'assets/', 'registries/blueprints', 'registries/lifecycle', 'governance/reviews'];
const rank = (k) => { const i = ORDER.findIndex((p) => k === p || k.startsWith(p)); return i < 0 ? 99 : i; };

async function readManifest(deps, root) {
  let token = null, file = null;
  // The worker's listing names files 'title' and pages 'next' (Drive's own API says 'name' and 'nextPageToken'): accept both.
  do { const page = await deps.list(root, token); file = (page.files || []).find((f) => (f.title || f.name) === 'manifest.json'); token = page.next || page.nextPageToken; } while (!file && token);
  if (!file) return null;
  return deps.readMine(file.id);
}

async function upsertObjects(env, objs) {
  for (let i = 0; i < objs.length; i += 25) {
    const part = objs.slice(i, i + 25), stmts = [];
    for (const o of part) {
      if (!o || !o.id || !o.type) continue;
      const spec = Array.isArray(o.specialty) ? o.specialty[0] || null : o.specialty || null;
      stmts.push(env.DB.prepare(`INSERT INTO mk_objects (id, type, name, norm, specialty, status, gov, version, trust, conf, hash, body, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (id) DO UPDATE SET type=excluded.type, name=excluded.name, norm=excluded.norm, specialty=excluded.specialty, status=excluded.status, gov=excluded.gov, version=excluded.version,
        trust=excluded.trust, conf=excluded.conf, hash=excluded.hash, body=excluded.body, updated=excluded.updated WHERE excluded.updated > mk_objects.updated`)
        .bind(o.id, o.type, String(o.name || o.id).slice(0, 300), norm(o.name || o.id).slice(0, 300), spec, o.status || 'current', o.governance_status || 'pending_validation', o.version || '1.0.0',
          (o.scores && o.scores.trust_score) ?? 50, (o.confidence && o.confidence.confidence_score) ?? 50, await contentHash(o), JSON.stringify(o), o.created || nowIso(), o.updated || nowIso()));
    }
    if (stmts.length) await env.DB.batch(stmts);
    for (const o of part) if (o && o.id && !['Objective', 'EducationalObject', 'Claim', 'EducationalAsset'].includes(o.type)) await indexAliases(env, o);
  }
}
const insertAll = async (env, sqlFor, rows, per = 40) => { for (let i = 0; i < rows.length; i += per) { const st = rows.slice(i, i + per).map(sqlFor).filter(Boolean); if (st.length) await env.DB.batch(st); } };
function tableRows(env, table, rows) {
  return rows.map((r) => { const cols = Object.keys(r).filter((c) => /^[a-z_]+$/.test(c)); if (!cols.length) return null;
    return env.DB.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => r[c] == null ? null : typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])); });
}

/* One slice of a restore (or a verification). prog: {files, at, row, counts}. mode 'verify' only compares the manifest with the database. */
export async function restoreStep(env, deps, root, prog, { mode = 'restore', rowsPerStep = 600 } = {}) {
  if (!root) return { done: true, error: 'no MKOS folder configured' };
  if (!prog.files) {
    const man = await readManifest(deps, root); if (!man || !man.files) return { done: true, error: 'manifest.json not found in the MKOS folder' };
    prog.files = Object.entries(man.files).filter(([k, f]) => f.file_id && rank(k) < 99).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([k, f]) => ({ key: k, id: f.file_id, rows: f.rows }));
    prog.at = 0; prog.row = 0; prog.counts = {}; prog.manifest_written = man.written; prog.framework_hash = man.framework_hash;
    if (mode === 'verify') {
      // Compare what the manifest says each file holds with what the database holds now.
      const db = {};
      for (const r of (await env.DB.prepare("SELECT type, COALESCE(specialty, 'general') AS s, COUNT(*) AS n FROM mk_objects WHERE id NOT LIKE 'ea.u%' GROUP BY type, s").all()).results) db[`registry_data/${r.type}/${String(r.s).replace(/^spec\./, '')}`] = r.n;
      const diff = prog.files.filter((f) => f.key.startsWith('registry_data/') && f.rows != null && db[f.key] !== f.rows).map((f) => ({ file: f.key, drive: f.rows, database: db[f.key] ?? 0 }));
      const missing = Object.keys(db).filter((k) => !prog.files.some((f) => f.key === k));
      // Configuration and the central records: what Drive's manifest says it holds must be what the database would write now.
      let crow = []; try { crow = (await env.DB.prepare('SELECT path FROM docs WHERE user_id = ?').bind(CENTRAL).all()).results; } catch (e) { crow = []; }
      const exact = ['config', ...crow.map((r) => 'central/' + r.path)];
      for (const k of exact) {
        const f = man.files[k], h = await fileHash(env, k, deps);
        if (!f) { if (h) missing.push(k); } else if (h && f.hash !== h) diff.push({ file: k, drive: 'hash ' + String(f.hash).slice(0, 10), database: 'hash ' + h.slice(0, 10) });
      }
      return { done: true, mode, manifest_written: man.written, files: prog.files.length, object_files_matching: prog.files.filter((f) => f.key.startsWith('registry_data/')).length - diff.length, differences: diff.slice(0, 40), not_yet_persisted: missing };
    }
  }
  let rows = 0;
  while (prog.at < prog.files.length && rows < rowsPerStep) {
    const f = prog.files[prog.at], doc = await deps.readMine(f.id), k = f.key;
    const list = k.startsWith('registry_data/') ? doc.objects || [] : k.startsWith('history/') ? doc.versions || [] : k.startsWith('graph/') ? (Array.isArray(doc) ? doc : []) : k.startsWith('assets/') ? doc.assets || []
      : k === 'governance/reviews' ? (Array.isArray(doc) ? doc : []) : null;
    if (k === 'config') {
      await env.DB.batch(APP_TABLES.map((q) => env.DB.prepare(q)));
      const st = [...Object.entries(doc.app_settings || {}).map(([key, v]) => env.DB.prepare('INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)').bind(key, String(v))),
        ...Object.entries(doc.mkos_settings || {}).map(([key, v]) => env.DB.prepare('INSERT OR IGNORE INTO mk_settings (k, v) VALUES (?, ?)').bind(key, String(v)))];
      if (st.length) await insertAll(env, (x) => x, st);
      prog.counts.config = st.length; prog.at++; prog.row = 0; rows += 50; continue;
    }
    if (k.startsWith('central/')) {
      await env.DB.batch(APP_TABLES.map((q) => env.DB.prepare(q)));
      if (doc && doc.path && doc.body !== undefined) await env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated WHERE excluded.updated > docs.updated')
        .bind(CENTRAL, doc.path, JSON.stringify(doc.body), doc.updated || nowIso()).run();
      prog.counts.central = (prog.counts.central || 0) + 1; prog.at++; prog.row = 0; rows += 20; continue;
    }
    if (k === 'registries/blueprints') {
      if (prog.row === 0) {
        for (const [t, key] of [['mk_blueprint_registries', 'registries'], ['mk_blueprint_domains', 'domains'], ['mk_blueprint_objectives', 'objectives'], ['mk_blueprint_concept_mappings', 'concept_mappings'], ['mk_blueprint_asset_mappings', 'asset_mappings']])
          await insertAll(env, (s) => s, tableRows(env, t, doc[key] || []));
        prog.counts.blueprint_tables = (prog.counts.blueprint_tables || 0) + 1;
      }
      prog.at++; prog.row = 0; rows += 200; continue;
    }
    if (k === 'registries/lifecycle') {
      // Lifecycle records: inserted, or replacing an older record (never a newer one). The relevance graph is derived: a backfill of
      // the dirty queue rebuilds it from the restored objects and edges.
      const recs = (doc && doc.records) || [];
      await insertAll(env, (r) => r && r.source_id ? env.DB.prepare(`INSERT INTO mk_lifecycle (source_id, stage, stages_json, status, source_v, cycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT (source_id) DO UPDATE SET stage = excluded.stage, stages_json = excluded.stages_json, status = excluded.status, source_v = excluded.source_v, cycle = excluded.cycle, updated_at = excluded.updated_at
        WHERE excluded.updated_at > mk_lifecycle.updated_at`).bind(r.source_id, r.stage, typeof r.stages_json === 'string' ? r.stages_json : JSON.stringify(r.stages_json || {}), r.status, r.source_v ?? null, r.cycle || 1, r.created_at || nowIso(), r.updated_at || nowIso()) : null, recs);
      prog.counts.lifecycle = (prog.counts.lifecycle || 0) + recs.length; prog.at++; prog.row = 0; rows += Math.max(20, recs.length); continue;
    }
    const slice = (list || []).slice(prog.row, prog.row + (rowsPerStep - rows));
    if (k.startsWith('registry_data/')) await upsertObjects(env, slice);
    else if (k.startsWith('history/')) await insertAll(env, (v) => v && v.id ? env.DB.prepare('INSERT OR IGNORE INTO mk_versions (id, version, hash, body, at, event_id, actor) VALUES (?,?,?,?,?,?,?)').bind(v.id, v.version, v.hash || '', JSON.stringify(v.body), v.at, v.event_id || null, v.actor || 'restore') : null, slice);
    else if (k.startsWith('graph/')) await insertAll(env, (e) => e && e.src ? env.DB.prepare('INSERT OR IGNORE INTO mk_edges (src, rel, dst, status, conf, prov, created, updated) VALUES (?,?,?,?,?,?,?,?)').bind(e.src, e.rel, e.dst, e.status || 'current', e.conf ?? 50, JSON.stringify(e.prov || []), e.created || nowIso(), e.updated || nowIso()) : null, slice);
    else if (k.startsWith('assets/')) {
      await upsertObjects(env, slice.map((a) => a.record).filter(Boolean));
      await insertAll(env, (a) => a && a.record && a.content ? env.DB.prepare('INSERT OR IGNORE INTO mk_asset_store (asset_id, version, content, bytes, at) VALUES (?,?,?,?,?)').bind(a.record.id, a.content_version || a.record.version, JSON.stringify(a.content), JSON.stringify(a.content).length, a.record.updated || nowIso()) : null, slice);
    } else if (k === 'governance/reviews') await insertAll(env, (s) => s, tableRows(env, 'mk_reviews', slice));
    rows += slice.length; prog.row += slice.length;
    prog.counts[k.split('/')[0]] = (prog.counts[k.split('/')[0]] || 0) + slice.length;
    if (prog.row >= (list || []).length) { prog.at++; prog.row = 0; }
  }
  const done = prog.at >= prog.files.length;
  if (done && mode === 'restore') {
    await audit(env, 'restore', 'restore_from_drive', null, null, prog.manifest_written, prog.counts);
    await queue(env, 'classify', 'all', {}, 5); await queue(env, 'reconcile', 'restore:' + nowIso(), {}, 3);
    // Derived layers are rebuilt from the restored objects, edges and rules: the relevance graph by a backfill of the dirty queue
    // (lifecycle.js; lc_rel is run state), and penetration, layers, confidence, coverage and gaps by their own daily passes.
    await setSetting(env, 'lc_rel', null); await setSetting(env, 'lc_derived', null);
  }
  return { done, mode, file: prog.at, of: prog.files.length, counts: prog.counts };
}

/* THE RESTORE DRILL: rebuild an empty database (DRILL_DB) from Drive alone, then compare it with production object by object.
   One slice per call; prog is kept by the caller. Phases: reset -> restore -> compare. */
export async function drillStep(env, drill, deps, root, prog) {
  if (!drill) return { done: true, error: 'DRILL_DB is not bound' };
  const D = { DB: drill };
  if (!prog.phase) {
    await drill.batch(TABLES.map((s) => drill.prepare(s)));
    const names = (await drill.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mk_%'").all()).results.map((r) => r.name);
    await drill.batch(names.map((n) => drill.prepare(`DELETE FROM ${n}`)));
    await drill.batch([...APP_TABLES.map((q) => drill.prepare(q)), drill.prepare('DELETE FROM docs'), drill.prepare('DELETE FROM settings')]);
    await env.DB.batch(APP_TABLES.map((q) => env.DB.prepare(q)));   // present in production already; makes the comparison safe anywhere
    prog.phase = 'restore'; prog.restore = {}; prog.started = nowIso();
    return { done: false, phase: 'reset', tables: names.length };
  }
  if (prog.phase === 'restore') {
    const r = await restoreStep(D, deps, root, prog.restore, { mode: 'drill', rowsPerStep: 500 });
    if (r.error) return { done: true, error: r.error };
    if (!r.done) return { done: false, phase: 'restore', file: r.file, of: r.of };
    prog.phase = 'compare'; return { done: false, phase: 'restore', file: r.file, of: r.of, counts: r.counts };
  }
  // Compare: every count, and every object's id, version and content hash.
  const one = async (db, sql) => ((await db.prepare(sql).first()) || {}).n;
  const checks = [['objects', "SELECT COUNT(*) AS n FROM mk_objects WHERE id NOT LIKE 'ea.u%'"], ['versions', "SELECT COUNT(*) AS n FROM mk_versions v WHERE v.id NOT LIKE 'ea.u%' AND EXISTS (SELECT 1 FROM mk_objects o WHERE o.id = v.id)"],
    ['relationships', 'SELECT COUNT(*) AS n FROM mk_edges'], ['relationship checksum', 'SELECT SUM(LENGTH(src) * 7 + LENGTH(rel) * 3 + LENGTH(dst) + CAST(conf AS INTEGER)) AS n FROM mk_edges'],
    ['asset content', "SELECT COUNT(DISTINCT asset_id) AS n FROM mk_asset_store WHERE asset_id LIKE 'ea.s.%'"], ['blueprint registries', 'SELECT COUNT(*) AS n FROM mk_blueprint_registries'],
    ['blueprint domains', 'SELECT COUNT(*) AS n FROM mk_blueprint_domains'], ['blueprint objectives', 'SELECT COUNT(*) AS n FROM mk_blueprint_objectives'], ['blueprint concept mappings', 'SELECT COUNT(*) AS n FROM mk_blueprint_concept_mappings'],
    ['reviews', 'SELECT COUNT(*) AS n FROM mk_reviews'], ['lifecycle records', 'SELECT COUNT(*) AS n FROM mk_lifecycle'], ['aliases', 'SELECT COUNT(*) AS n FROM mk_aliases']];
  checks.splice(checks.length - 1, 0, ['central records', `SELECT COUNT(*) AS n FROM docs WHERE user_id = '${CENTRAL}'`], ['central records checksum', `SELECT SUM(LENGTH(body)) AS n FROM docs WHERE user_id = '${CENTRAL}'`]);
  const counts = []; for (const [name, sql] of checks) { const a = await one(env.DB, sql), b = await one(drill, sql); counts.push({ name, production: a ?? 0, rebuilt: b ?? 0, match: (a ?? 0) === (b ?? 0) }); }
  // Configuration: every setting that does not move while the engine runs must come back with the same value.
  const stable = (d) => [...Object.entries(d.app_settings).map(([k, v]) => 'app:' + k + '=' + v), ...Object.entries(d.mkos_settings).filter(([k]) => !CONFIG_MOVING.test(k)).map(([k, v]) => 'mk:' + k + '=' + v)].sort();
  const cp = stable(await configDoc(env, null)), cr = new Set(stable(await configDoc(D, null))), cfgMissing = cp.filter((x) => !cr.has(x));
  counts.push({ name: 'configuration (settings)', production: cp.length, rebuilt: cp.length - cfgMissing.length, match: !cfgMissing.length, ...(cfgMissing.length ? { differing: cfgMissing.map((x) => x.split('=')[0]).slice(0, 10) } : {}) });
  const rows = async (db) => Object.fromEntries((await db.prepare("SELECT id, version, hash FROM mk_objects WHERE id NOT LIKE 'ea.u%'").all()).results.map((r) => [r.id, r.version + '|' + r.hash]));
  const P = await rows(env.DB), R = await rows(drill);
  const missing = Object.keys(P).filter((id) => !(id in R)), extra = Object.keys(R).filter((id) => !(id in P)), differ = Object.keys(P).filter((id) => id in R && P[id] !== R[id]);
  const byType = {}; for (const id of [...missing, ...differ]) { const t = id.split('.')[0]; byType[t] = (byType[t] || 0) + 1; }
  const report = { finished: nowIso(), started: prog.started, pass: counts.filter((c) => c.name !== 'aliases').every((c) => c.match) && !missing.length && !extra.length && !differ.length,
    counts, objects_compared: Object.keys(P).length, missing_in_rebuild: missing.length, extra_in_rebuild: extra.length, content_differs: differ.length, problem_prefixes: byType,
    samples: { missing: missing.slice(0, 10), differs: differ.slice(0, 10) }, restored: prog.restore.counts };
  prog.phase = 'done';
  return { done: true, report };
}
