// The durable central record in Google Drive: Side Gigs > App Backends > Doctor Companion App > Doctor Companion App Central Registry
// Data > MKOS (MKOS_DRIVE_FOLDER). Written by the server; edits made there are not read back. Layout:
//   README.txt
//   ontology/<framework>.json, ontology/schemas.json          the framework the store was built with
//   registry_data/<Type>/<specialty>.json                       every object of that type, sharded by specialty (one file per shard)
//   graph/edges_<n>.json                                        the knowledge graph, 5000 edges per file
//   registries/sources_registry.json                            every source with citation, class, status, family (human-readable index)
//   registries/guidelines_registry_vN_MKOS_STAGED.json          the compatibility registry (cutover step 2; never named CURRENT here)
//   governance/events_YYYY-MM.json, governance/cutover_validation.json
//   snapshot/mkos-knowledge-base.json                           one bundled file of every object and edge (restore point), daily
// Only shards whose content hash changed are rewritten. Learner state is never written here (it is per account).
import { FRAMEWORK, FRAMEWORK_HASH } from './framework.js';
import { J, nowIso, getSetting, setSetting } from './db.js';
import { contentHash } from './kb.js';
import { buildCompatRegistry } from './cutover.js';

const README = `MKOS: the Medical Knowledge Operating System behind the Doctor Career Companion app.

This folder is the durable central record of the app's knowledge base: one knowledge base for every account.
It is written by the server automatically and refreshed whenever the knowledge changes. Do not edit these files by hand:
edits made here are not read back. Change knowledge by adding or replacing documents in the Medical Knowledge Database
folder (the server notices within minutes), or through the owner tools.

registry_data/   every knowledge object (sources, guidelines, concepts, recommendations, evidence, blueprint topics,
                 curriculum, educational assets), one file per type and specialty, each object versioned with provenance.
graph/           the knowledge graph (typed relationships).
registries/      a readable sources registry and the staged compatibility registry for the legacy guideline registry.
governance/      change events, impact analysis and cutover validation reports.
snapshot/        one bundled file holding everything, as a restore point.
ontology/        the ontology, frameworks and schemas the knowledge base follows.

Each person's own learning state stays in their account's folder under "Doctor Companion App Account-level Data", not here.
`;

const shardOf = (o) => (Array.isArray(o.specialty) ? o.specialty[0] : o.specialty) || 'general';
async function shardKeys(env) {
  const { results } = await env.DB.prepare("SELECT type, COALESCE(specialty, 'general') AS s, COUNT(*) AS n FROM mk_objects GROUP BY type, s").all();
  const keys = ['readme', 'ontology', 'registries/sources', 'registries/compat', 'governance/events'];
  for (const r of results) keys.push(`registry_data/${r.type}/${String(r.s).replace(/^spec\./, '')}`);
  const e = await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_edges').first();
  for (let i = 0; i < Math.ceil(((e && e.n) || 0) / 5000); i++) keys.push('graph/edges_' + i);
  return keys;
}
async function content(env, key) {
  if (key === 'readme') return { name: 'README.txt', folder: '', text: README, mime: 'text/plain' };
  if (key === 'ontology') return { name: 'mkos-framework.json', folder: 'ontology', text: JSON.stringify({ framework_hash: FRAMEWORK_HASH, ...FRAMEWORK }, null, 1) };
  if (key === 'registries/sources') {
    const { results } = await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' ORDER BY specialty, name").all();
    const rows = results.map((r) => J(r.body)).map((s) => ({ id: s.id, label: s.short_label || s.name, title: s.title, class: s.source_class, specialty: s.specialty, status: s.status, governance: s.governance_status,
      year: s.year, citation: s.citation || '', doi: s.doi || '', orgs: s.responsible_orgs || [], population: s.population, family: s.guideline_family || null, edition_role: s.edition_role || null,
      ref_id: s.registry_ref_id || null, drive_file_id: s.drive_file_id, path: s.drive_path, ingest: s.ingest_state, trust: s.scores?.trust_score, version: s.version }));
    return { name: 'sources_registry.json', folder: 'registries', text: JSON.stringify({ generated: nowIso(), count: rows.length, sources: rows }, null, 1) };
  }
  if (key === 'registries/compat') {
    const c = await buildCompatRegistry(env); if (!c) return null;
    return { name: `guidelines_registry_v${c.registry_version}_MKOS_STAGED.json`, folder: 'registries', text: JSON.stringify(c, null, 1) };
  }
  if (key === 'governance/events') {
    const month = nowIso().slice(0, 7), { results } = await env.DB.prepare('SELECT * FROM mk_events WHERE created LIKE ? ORDER BY created').bind(month + '%').all();
    return { name: `events_${month}.json`, folder: 'governance', text: JSON.stringify(results.map((r) => ({ ...r, detail: J(r.detail), impact: J(r.impact) })), null, 1), key: 'governance/events_' + month };
  }
  let m = /^registry_data\/([A-Za-z]+)\/(.+)$/.exec(key);
  if (m) {
    const spec = m[2] === 'general' ? null : 'spec.' + m[2];
    const { results } = await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = ? AND ${spec ? 'specialty = ?' : "(specialty IS NULL OR specialty = 'general')"} ORDER BY id`).bind(...(spec ? [m[1], spec] : [m[1]])).all();
    return { name: m[2] + '.json', folder: 'registry_data/' + m[1], text: JSON.stringify({ type: m[1], specialty: spec, count: results.length, objects: results.map((r) => J(r.body)) }, null, 1) };
  }
  m = /^graph\/edges_(\d+)$/.exec(key);
  if (m) {
    const { results } = await env.DB.prepare('SELECT src, rel, dst, status, conf, prov FROM mk_edges ORDER BY src, rel, dst LIMIT 5000 OFFSET ?').bind(Number(m[1]) * 5000).all();
    return { name: `edges_${m[1]}.json`, folder: 'graph', text: JSON.stringify(results.map((r) => ({ ...r, prov: J(r.prov) }))) };
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

// Write up to `max` changed shards. Returns {written, checked, pending}.
export async function mirrorStep(env, deps, root, { max = 3 } = {}) {
  if (!root) return { off: true };
  const keys = await shardKeys(env), cursor = Number(await getSetting(env, 'mirror_cursor')) || 0;
  let written = 0, checked = 0, i = cursor;
  for (; checked < keys.length && written < max; checked++, i = (i + 1) % keys.length) {
    const c = await content(env, keys[i]); if (!c) continue;
    const key = c.key || keys[i], hash = await contentHash({ t: c.text });
    const row = await env.DB.prepare('SELECT file_id, hash FROM mk_mirror WHERE key = ?').bind(key).first();
    if (row && row.hash === hash) continue;
    const parent = await folder(env, deps, root, c.folder);
    let id = row && row.file_id;
    try { id = await deps.upload({ id, name: c.name, parent, text: c.text, mime: c.mime }); }
    catch (e) { if (!e.gone) throw e; id = await deps.upload({ name: c.name, parent, text: c.text, mime: c.mime }); }
    await env.DB.prepare('INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES (?, ?, ?, ?)').bind(key, id, hash, nowIso()).run();
    written++;
  }
  await setSetting(env, 'mirror_cursor', String(i));
  return { written, checked, shards: keys.length };
}

// The daily snapshot: every object and edge in one file.
export async function snapshot(env, deps, root) {
  const day = nowIso().slice(0, 10); if ((await getSetting(env, 'snapshot_day')) === day) return { skipped: true };
  const objs = (await env.DB.prepare('SELECT body FROM mk_objects ORDER BY id').all()).results.map((r) => r.body);
  const edges = (await env.DB.prepare('SELECT src, rel, dst, status, conf FROM mk_edges').all()).results;
  const text = '{"app":"doctor-career-companion","kind":"mkos-snapshot","framework_hash":' + JSON.stringify(FRAMEWORK_HASH) + ',"saved":' + JSON.stringify(nowIso()) + ',"objects":[' + objs.join(',') + '],"edges":' + JSON.stringify(edges) + '}';
  const parent = await folder(env, deps, root, 'snapshot'), row = await env.DB.prepare("SELECT file_id FROM mk_mirror WHERE key = 'snapshot'").first();
  let id = row && row.file_id;
  try { id = await deps.upload({ id, name: 'mkos-knowledge-base.json', parent, text }); } catch (e) { if (!e.gone) throw e; id = await deps.upload({ name: 'mkos-knowledge-base.json', parent, text }); }
  await env.DB.prepare("INSERT OR REPLACE INTO mk_mirror (key, file_id, hash, synced) VALUES ('snapshot', ?, ?, ?)").bind(id, day, nowIso()).run();
  await setSetting(env, 'snapshot_day', day);
  return { objects: objs.length, edges: edges.length, bytes: text.length };
}
