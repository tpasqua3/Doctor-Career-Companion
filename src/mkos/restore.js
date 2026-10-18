// REBUILD FROM CANONICAL STORAGE: the operational database (D1) is rebuildable from the Drive MKOS folder, which is the system of record
// (mirror.js). A restore reads manifest.json and then each listed file, in dependency order, and upserts what it holds:
//   registry_data -> mk_objects (and the alias index)    history -> mk_versions    graph -> mk_edges
//   assets -> EducationalAsset records + mk_asset_store  registries/blueprints -> the blueprint execution tables    governance/reviews -> mk_reviews
// It never replaces a newer row with an older one (objects keep whichever 'updated' is later; versions, edges, content and table rows are
// inserted only when absent), so it is safe on an empty database and on a live one. Resumable: prog keeps the file and row position.
// Learner state is not part of canonical knowledge: it is rebuilt from each account's own record by the engine's learner jobs.
import { J, nowIso, audit } from './db.js';
import { contentHash, indexAliases, norm } from './kb.js';
import { queue } from './ingest.js';

const ORDER = ['registry_data/', 'history/', 'graph/', 'assets/', 'registries/blueprints', 'governance/reviews'];
const rank = (k) => { const i = ORDER.findIndex((p) => k.startsWith(p)); return i < 0 ? 99 : i; };

async function readManifest(deps, root) {
  let token = null, file = null;
  do { const page = await deps.list(root, token); file = (page.files || []).find((f) => f.name === 'manifest.json'); token = page.nextPageToken; } while (!file && token);
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
      return { done: true, mode, manifest_written: man.written, files: prog.files.length, object_files_matching: prog.files.filter((f) => f.key.startsWith('registry_data/')).length - diff.length, differences: diff.slice(0, 40), not_yet_persisted: missing };
    }
  }
  let rows = 0;
  while (prog.at < prog.files.length && rows < rowsPerStep) {
    const f = prog.files[prog.at], doc = await deps.readMine(f.id), k = f.key;
    const list = k.startsWith('registry_data/') ? doc.objects || [] : k.startsWith('history/') ? doc.versions || [] : k.startsWith('graph/') ? (Array.isArray(doc) ? doc : []) : k.startsWith('assets/') ? doc.assets || []
      : k === 'governance/reviews' ? (Array.isArray(doc) ? doc : []) : null;
    if (k === 'registries/blueprints') {
      if (prog.row === 0) {
        for (const [t, key] of [['mk_blueprint_registries', 'registries'], ['mk_blueprint_domains', 'domains'], ['mk_blueprint_objectives', 'objectives'], ['mk_blueprint_concept_mappings', 'concept_mappings'], ['mk_blueprint_asset_mappings', 'asset_mappings']])
          await insertAll(env, (s) => s, tableRows(env, t, doc[key] || []));
        prog.counts.blueprint_tables = (prog.counts.blueprint_tables || 0) + 1;
      }
      prog.at++; prog.row = 0; rows += 200; continue;
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
  }
  return { done, mode, file: prog.at, of: prog.files.length, counts: prog.counts };
}
