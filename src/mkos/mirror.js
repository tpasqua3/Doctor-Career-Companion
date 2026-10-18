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
//   registries/guidelines_registry_vN_MKOS_STAGED.json          the compatibility registry (cutover step 2)
//   governance/events_YYYY-MM.json, audit_YYYY-MM.json, reviews.json, reconciliation.json
//   snapshot/mkos-knowledge-base.json                           one bundled restore point, daily
// Change detection is cheap: one grouped query per family of files gives every file's fingerprint, and only files whose fingerprint
// moved are rebuilt and compared by content hash. Learner state and a learner's own assets are never written here: they live in that
// account's own Drive folder (the app's record sync).
import { FRAMEWORK, FRAMEWORK_HASH } from './framework.js';
import { J, nowIso, getSetting, setSetting } from './db.js';
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
registries/      the readable sources registry, the board blueprint tables, and the staged compatibility registry.
governance/      change events, audit records, reviews and the daily reconciliation report.
snapshot/        one bundled file holding the knowledge base, as a restore point.
ontology/        the ontology, frameworks and schemas the knowledge base follows.

Each person's own learning state and personal material stay in their account's folder under "Doctor Companion App Account-level Data".
`;

const spec2 = (s) => String(s || 'general').replace(/^spec\./, '');
const specWhere = (s) => s === 'general' ? "(o.specialty IS NULL OR o.specialty = 'general')" : 'o.specialty = ?';
const specArgs = (s) => s === 'general' ? [] : ['spec.' + s];
const BUCKET = "CASE WHEN lower(substr(src, -1)) GLOB '[a-z0-9]' THEN lower(substr(src, -1)) ELSE '_' END";

/* Every file with its fingerprint, from a few grouped queries. Returns [{key, fp}] in write order (manifest last). */
async function fingerprints(env) {
  const out = [{ key: 'readme', fp: README.length + ':' + FRAMEWORK_HASH }, { key: 'ontology', fp: FRAMEWORK_HASH }];
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
  const month = nowIso().slice(0, 7);
  const ev = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated) AS u FROM mk_events WHERE created LIKE ?').bind(month + '%').first();
  out.push({ key: 'governance/events_' + month, fp: `${ev.n}|${ev.u}` });
  const au = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM mk_audit WHERE at LIKE ?').bind(month + '%').first();
  out.push({ key: 'governance/audit_' + month, fp: `${au.n}|${au.m}` });
  const rv = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(at) AS u FROM mk_reviews').first();
  out.push({ key: 'governance/reviews', fp: `${rv.n}|${rv.u}` });
  const rc = await getSetting(env, 'reconcile_report');
  out.push({ key: 'governance/reconciliation', fp: rc ? String(rc.length) + (J(rc, {}) || {}).finished : '' });
  return out;
}

async function content(env, key) {
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
async function write(env, deps, root, c, key) {
  const parent = await folder(env, deps, root, c.folder), row = await env.DB.prepare('SELECT file_id FROM mk_mirror WHERE key = ?').bind(key).first();
  let id = row && row.file_id;
  try { id = await deps.upload({ id, name: c.name, parent, text: c.text, mime: c.mime }); }
  catch (e) { if (!e.gone) throw e; id = await deps.upload({ name: c.name, parent, text: c.text, mime: c.mime }); }
  return id;
}

/* Persist up to `max` files whose fingerprint moved, then the manifest. Returns {written, dirty, files}. Unchanged content (same
   hash) only records the new fingerprint, so a file is never rewritten for nothing. */
export async function mirrorStep(env, deps, root, { max = 4 } = {}) {
  if (!root) return { off: true };
  const fps = await fingerprints(env);
  const known = Object.fromEntries((await env.DB.prepare("SELECT key, file_id, hash, synced FROM mk_mirror WHERE key NOT LIKE 'dir:%'").all()).results.map((r) => [r.key, r]));
  const dirty = fps.filter((f) => !known['fp:' + f.key] || known['fp:' + f.key].hash !== f.fp);
  let written = 0;
  for (const f of dirty.slice(0, max + 6)) {
    if (written >= max) break;
    const c = await content(env, f.key);
    if (c) {
      const hash = await contentHash({ t: c.text });
      if (!known[f.key] || known[f.key].hash !== hash) {
        const id = await write(env, deps, root, c, f.key);
        await env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind(f.key, id, hash, nowIso()).run();
        await env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind('n:' + f.key, c.folder + '/' + c.name, String(c.n ?? ''), nowIso()).run();
        written++;
      }
    }
    await env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind('fp:' + f.key, null, f.fp, nowIso()).run();
  }
  // The manifest: the index a restore starts from, rewritten whenever anything was written (or if it is missing).
  if (written || !known.manifest) {
    const rows = (await env.DB.prepare("SELECT key, file_id, hash, synced FROM mk_mirror WHERE key NOT LIKE 'dir:%' AND key NOT LIKE 'fp:%' AND key NOT LIKE 'n:%' AND key NOT IN ('manifest','snapshot')").all()).results;
    const names = Object.fromEntries((await env.DB.prepare("SELECT key, file_id, hash FROM mk_mirror WHERE key LIKE 'n:%'").all()).results.map((r) => [r.key.slice(2), r]));
    const current = new Set(fps.map((f) => f.key));   // files of an older layout are left out of the index (a restore reads only these)
    const files = Object.fromEntries(rows.filter((r) => current.has(r.key)).map((r) => [r.key, { file_id: r.file_id, path: names[r.key] ? names[r.key].file_id : null, rows: names[r.key] && names[r.key].hash !== '' ? Number(names[r.key].hash) : null, hash: r.hash, synced: r.synced }]));
    const pending = dirty.length - written;
    const doc = { app: 'doctor-career-companion', kind: 'mkos-manifest', framework_hash: FRAMEWORK_HASH, written: nowIso(), pending_files: Math.max(0, pending), files };
    const id = await write(env, deps, root, { name: 'manifest.json', folder: '', text: JSON.stringify(doc, null, 1) }, 'manifest');
    await env.DB.prepare("INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES ('manifest', ?, ?, ?)").bind(id, String(Math.max(0, pending)), nowIso()).run();
  }
  return { written, dirty: dirty.length, files: fps.length };
}

// How far canonical storage is behind the database: files whose fingerprint moved since they were last persisted.
export async function durability(env) {
  const fps = await fingerprints(env);
  const known = Object.fromEntries((await env.DB.prepare("SELECT key, hash, synced FROM mk_mirror WHERE key LIKE 'fp:%' OR key = 'manifest' OR key = 'snapshot'").all()).results.map((r) => [r.key, r]));
  const behind = fps.filter((f) => !known['fp:' + f.key] || known['fp:' + f.key].hash !== f.fp).map((f) => f.key);
  return { files: fps.length, persisted: fps.length - behind.length, behind: behind.length, behind_files: behind.slice(0, 40), manifest_written: known.manifest ? known.manifest.synced : null, snapshot_written: known.snapshot ? known.snapshot.synced : null };
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
