// Legacy registry cutover, in eight gated steps (the owner's order):
//   1 Import everything            importLegacyRegistry (ingest.js), blueprints, scan
//   2 Publish compatibility registry   buildCompatRegistry -> MKOS folder, staged (never named *CURRENT* until step 8)
//   3 Structural parity validation
//   4 Functional application validation  (the app's own registry parse, run on legacy and compat, must give the same map; and the
//                                          learner's cached med/libreg must be reproduced)
//   5 Citation resolution validation     (every drive file id / ref_id the learner's record uses resolves; free-text citations reported)
//   6 Knowledge graph validation         (governance.graphValidation)
//   7 Historical rollback validation     (the legacy registry is rebuilt from MKOS history and must equal the original, field for field)
//   8 Retire legacy registry             only when 3-7 passed in the last 24 h AND the owner confirms; reversible (rollback()).
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject, contentHash, norm } from './kb.js';
import { resolveName, AUTO, matchCitation } from './resolve.js';
import { orgsOf, topicWords } from './ingest.js';
import { graphValidation } from './governance.js';

const STATUS_BACK = { current: 'active', modified: 'updated', superseded: 'superseded', retired: 'retired' };
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const same = (a, b) => canon(a) === canon(b);

// The app's registry reader, exactly as app/companion.html does it (keep in step with libInit there).
const appYearOf = (...xs) => { for (const x of xs) { const m = /\b(19[89]\d|20[0-4]\d)\b/.exec(String(x || '')); if (m) return m[1]; } return ''; };
const A = (x) => Array.isArray(x) ? x : [];
export function appRegistryMap(j) {
  const map = {};
  A(j && j.sources).forEach((x) => { if (x && x.drive_file_id) map[x.drive_file_id] = { l: String(x.short_label || x.title || '').slice(0, 90), c: String(x.citation || '').slice(0, 120), d: String(x.doi || '').slice(0, 80),
    o: A(x.responsible_orgs).map(String).slice(0, 5).join('/'), s: String(x.status || 'active').slice(0, 20), y: appYearOf(x.issue_date, x.published_online, x.short_label) }; });
  return map;
}

// Every source that came from the legacy registry, whatever its status (no row limit), and approved MKOS-only guideline sources.
const legacySources = async (env) => (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' AND json_extract(body, '$.data.legacy') IS NOT NULL").all()).results.map((r) => J(r.body));
const approvedNewSources = async (env) => (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' AND gov = 'approved' AND json_extract(body, '$.data.legacy') IS NULL").all()).results.map((r) => J(r.body));

// Rebuild the legacy registry purely from MKOS (rollback source of truth): legacy meta from settings + each source's data.legacy.
export async function rebuildLegacy(env) {
  const meta = J(await getSetting(env, 'legacy_registry'), null); if (!meta) return null;
  const srcs = await legacySources(env);
  const withLegacy = srcs.filter((s) => s.data && s.data.legacy && s.data.legacy_registry_version === meta.version);
  const order = meta.meta.order || null;
  const sources = [...withLegacy.map((s) => s.data.legacy), ...(meta.meta.no_file_sources || [])];
  if (order) sources.sort((a, b) => order.indexOf(a.ref_id) - order.indexOf(b.ref_id));
  const { order: _o, no_file_sources: _n, ...rest } = meta.meta;
  return { ...rest, sources };
}

// Step 2: the compatibility registry: legacy shape, legacy entries carried forward with MKOS's current values, plus approved new ones.
export async function buildCompatRegistry(env) {
  const meta = J(await getSetting(env, 'legacy_registry'), null); if (!meta) return null;
  const srcs = [...(await legacySources(env)), ...(await approvedNewSources(env))];
  const legacy = [], added = [];
  for (const s of srcs) {
    if (s.data?.legacy) {
      const L = s.data.legacy;
      legacy.push({ ...L, short_label: s.short_label || L.short_label, title: s.title || L.title, responsible_orgs: s.responsible_orgs?.length ? s.responsible_orgs : L.responsible_orgs,
        citation: s.citation || L.citation, doi: s.doi || L.doi, published_online: s.published_online || L.published_online, issue_date: s.issue_date || L.issue_date,
        status: L.status === 'check_edition' || L.status === 'review_relevance' ? L.status : STATUS_BACK[s.status] || L.status, drive_file_id: s.drive_file_id });
    } else if (s.governance_status === 'approved' && ['Guidelines', 'Consensus Statements'].includes(s.spec_source_type) && s.status !== 'retired') {
      added.push({ ref_id: 'mkos-' + s.id.slice(4), short_label: s.short_label || s.name, title: s.title, type: s.source_class, responsible_orgs: s.responsible_orgs || [], collaborating_orgs: s.collaborating_orgs || [],
        authors: s.authors || '', journal: s.journal || '', citation: s.citation || '', doi: s.doi || '', published_online: s.published_online || '', issue_date: s.issue_date || '', citation_source: 'mkos',
        specialty: s.specialty?.[0] || '', folder_path: s.drive_path || '', file_name: s.title, drive_file_id: s.drive_file_id, status: STATUS_BACK[s.status] || 'active', notes: 'Added by MKOS' });
    }
  }
  legacy.push(...(meta.meta.no_file_sources || []));
  const order = meta.meta.order || [];
  legacy.sort((a, b) => order.indexOf(a.ref_id) - order.indexOf(b.ref_id));
  const { order: _o, no_file_sources: _n, ...rest } = meta.meta;
  return { ...rest, registry_version: Number(meta.version) + 1, generated: nowIso().slice(0, 10), replaces: `guidelines_registry_v${meta.version}_CURRENT.json`, produced_by: 'MKOS', sources: [...legacy, ...added] };
}

// Steps 3-7. deps.readJson(fileId) reads the original legacy registry from Drive; learnerDocs is the owner's record (for 4 and 5).
export async function validateCutover(env, deps, { learnerDocs = {} } = {}) {
  const meta = J(await getSetting(env, 'legacy_registry'), null);
  if (!meta) return { pass: false, error: 'Step 1 not done: the legacy registry has not been imported.' };
  const original = await deps.readJson(meta.file);
  const compat = await buildCompatRegistry(env), rebuilt = await rebuildLegacy(env);
  const gates = {};
  // 3 Structural parity: every top-level key and every legacy entry (by ref_id) with every field, values equal or explained by a newer MKOS version.
  {
    const missingKeys = Object.keys(original).filter((k) => !(k in compat)), diffs = [], missing = [];
    const byRef = Object.fromEntries(compat.sources.map((s) => [s.ref_id, s]));
    for (const e of original.sources) {
      const c = byRef[e.ref_id]; if (!c) { missing.push(e.ref_id); continue; }
      for (const k of Object.keys(e)) if (!(k in c)) diffs.push({ ref_id: e.ref_id, field: k, problem: 'missing' }); else if (!same(e[k], c[k])) diffs.push({ ref_id: e.ref_id, field: k, legacy: e[k], mkos: c[k] });
    }
    gates.structural_parity = { pass: !missingKeys.length && !missing.length && !diffs.length, legacy_entries: original.sources.length, compat_entries: compat.sources.length, added_by_mkos: compat.sources.length - original.sources.length, missing_top_level_keys: missingKeys, missing_entries: missing, field_differences: diffs.slice(0, 50) };
  }
  // 4 Functional application validation.
  {
    const a = appRegistryMap(original), b = appRegistryMap(compat), diff = [];
    for (const [id, v] of Object.entries(a)) if (!same(v, b[id])) diff.push({ drive_file_id: id, legacy: v, mkos: b[id] || null });
    const cached = (learnerDocs['med/libreg'] && learnerDocs['med/libreg'].map) || null, cacheDiff = [];
    if (cached) for (const [id, v] of Object.entries(cached)) if (!same(v, b[id])) cacheDiff.push({ drive_file_id: id, app_cache: v, mkos: b[id] || null });
    gates.functional_application = { pass: !diff.length && !cacheDiff.length, app_entries_legacy: Object.keys(a).length, app_entries_mkos: Object.keys(b).length, differences: diff.slice(0, 30), app_cache_checked: !!cached, app_cache_differences: cacheDiff.slice(0, 30),
      note: 'Runs the app\'s own registry-reading logic (libInit) on both files. New MKOS-only entries are additive and do not change any existing entry.' };
  }
  // 5 Citation resolution validation.
  {
    const ids = new Set(Object.keys((learnerDocs['med/libreg'] || {}).map || {})), refs = new Set(original.sources.map((s) => s.ref_id)), texts = new Map();
    for (const [path, d] of Object.entries(learnerDocs)) {
      const items = /^med\/bank_/.test(path) ? d.qs || [] : /^med\/cards_/.test(path) ? d.cards || [] : /^med\/les_/.test(path) ? [d] : [];
      for (const it of items) for (const s of [].concat(it.src || [])) if (s) texts.set(String(s).slice(0, 300), (texts.get(String(s).slice(0, 300)) || []).concat(path + (it.id ? '#' + it.id : '')));
    }
    const unresolvedIds = [], unresolvedRefs = [], resolved = [], unresolvedText = [], superseded = [];
    for (const id of ids) { const s = await getObject(env, 'src.' + id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)); if (!s) unresolvedIds.push(id); }
    // ref_ids resolve whatever the source's status (a superseded or retired legacy entry still resolves).
    for (const r of refs) { const hit = await env.DB.prepare("SELECT id FROM mk_aliases WHERE alias = ? AND id LIKE 'src.%' LIMIT 1").bind(norm(r)).first(); if (!hit) unresolvedRefs.push(r); }
    const fams = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Guideline'").all()).results.map((r) => J(r.body));
    const eds = Object.fromEntries((await env.DB.prepare("SELECT id, body FROM mk_objects WHERE type = 'Source' AND json_extract(body, '$.guideline_family') IS NOT NULL").all()).results.map((r) => [r.id, J(r.body)]));
    for (const [t, where] of texts) {
      const hit = await resolveName(env, t, { types: ['Source', 'Guideline'] });
      if (hit.id && hit.confidence >= AUTO) { const o = await getObject(env, hit.id); resolved.push({ citation: t, id: hit.id }); if (o && (o.status === 'superseded' || o.status === 'retired')) superseded.push({ citation: t, id: hit.id, replaced_by: o.replaced_by, used_in: where.slice(0, 5) }); continue; }
      const m = matchCitation(t, fams, eds, { orgsOf, topicWords });
      if (m.status === 'unmatched') { unresolvedText.push({ citation: t, used_in: where.slice(0, 3), candidates: (hit.candidates || []).slice(0, 2) }); continue; }
      resolved.push({ citation: t, id: m.edition || m.family, family: m.family, status: m.status });
      if (m.status === 'older_edition') superseded.push({ citation: t, cited_year: m.cited_year, family: m.family_name, current_edition: m.current_edition, current_year: m.current_year, used_in: where.slice(0, 5) });
    }
    gates.citation_resolution = { pass: !unresolvedIds.length && !unresolvedRefs.length, drive_ids_checked: ids.size, ref_ids_checked: refs.size, unresolved_drive_ids: unresolvedIds, unresolved_ref_ids: unresolvedRefs,
      free_text_citations: texts.size, free_text_resolved: resolved.length, free_text_unresolved: unresolvedText.slice(0, 40), citing_superseded_sources: superseded,
      note: 'Pass requires every registry file id and ref_id to resolve. Free-text citations written by the AI into lessons, questions and cards are reported (they do not block cutover); ones that resolve to a superseded source are flagged for regeneration.' };
  }
  // 6 Knowledge graph validation.
  gates.knowledge_graph = await graphValidation(env);
  // 7 Historical rollback validation.
  {
    const eq = same(original, rebuilt), diffs = [];
    if (!eq) { for (const k of new Set([...Object.keys(original), ...Object.keys(rebuilt || {})])) if (!same(original[k], (rebuilt || {})[k])) diffs.push(k); }
    const versionsMissing = [];
    for (const e of original.sources) { const id = 'src.' + e.drive_file_id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40); const v = await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_versions WHERE id = ?').bind(id).first(); if (!v || !v.n) versionsMissing.push(e.ref_id); }
    gates.historical_rollback = { pass: eq && !versionsMissing.length, rebuilt_equals_original: eq, differing_top_level_keys: diffs, entries_without_version_history: versionsMissing };
  }
  const pass = Object.values(gates).every((g) => g.pass);
  const result = { at: nowIso(), pass, gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g])), legacy_file: meta.file, legacy_version: meta.version };
  // The exact registry that was validated is fingerprinted; retirement publishes it only if nothing has changed since.
  const compatHash = await contentHash({ c: compat });
  await setSetting(env, 'legacy_registry_check', JSON.stringify({ at: result.at, pass, compat_hash: compatHash, gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.pass])) }));
  await audit(env, 'cutover', 'validate', 'registry.legacy', null, null, { pass, gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.pass])) });
  return result;
}

/* Step 8. deps: {upload({name, parent, text, id}), patch(id, {name, addParents, removeParents}), folders: {registry, oldVersions, mkos}}. */
export async function retireLegacy(env, deps, { actor, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: 'The owner must confirm (confirm: true).' };
  if (!deps.folders.registry || !deps.folders.oldVersions) return { ok: false, error: 'MKOS_REGISTRY_FOLDER and MKOS_REGISTRY_OLD_FOLDER must be set.' };
  const done = J(await getSetting(env, 'cutover'), null);
  if (done) return { ok: false, error: done.stage === 'complete' ? 'The legacy registry is already retired (roll back first to repeat).' : 'A cutover was started and not finished; roll back first.', cutover: done };
  const chk = J(await getSetting(env, 'legacy_registry_check'), null);
  if (!chk || !chk.pass || Date.now() - Date.parse(chk.at) > 864e5) return { ok: false, error: 'Validation gates 3-7 must all pass within the last 24 hours. Run validate first.', last: chk };
  const meta = J(await getSetting(env, 'legacy_registry'), null), compat = await buildCompatRegistry(env);
  if ((await contentHash({ c: compat })) !== chk.compat_hash) return { ok: false, error: 'The knowledge changed since validation; run validate again so exactly what is published has been checked.' };
  const name = `guidelines_registry_v${compat.registry_version}_CURRENT.json`;
  // Intent first, so a failure part-way leaves a record that rollback can act on.
  const rec = { at: nowIso(), actor, stage: 'started', retired: meta.file, published: null, name, from_version: meta.version, to_version: compat.registry_version };
  await setSetting(env, 'cutover', JSON.stringify(rec));
  rec.published = await deps.upload({ name, parent: deps.folders.registry, text: JSON.stringify(compat, null, 1) }); rec.stage = 'published';
  await setSetting(env, 'cutover', JSON.stringify(rec));
  await deps.patch(meta.file, { name: `guidelines_registry_v${meta.version}_OLD.json`, addParents: deps.folders.oldVersions, removeParents: deps.folders.registry }); rec.stage = 'complete';
  await setSetting(env, 'cutover', JSON.stringify(rec));
  await audit(env, actor, 'cutover_retire_legacy', 'registry.legacy', String(meta.version), String(compat.registry_version), rec);
  return { ok: true, ...rec };
}
export async function rollbackCutover(env, deps, { actor } = {}) {
  const rec = J(await getSetting(env, 'cutover'), null); if (!rec) return { ok: false, error: 'No cutover to roll back.' };
  if (rec.published) await deps.patch(rec.published, { name: rec.name.replace('_CURRENT', '_ROLLED_BACK'), addParents: deps.folders.mkos, removeParents: deps.folders.registry });
  if (rec.stage === 'complete') await deps.patch(rec.retired, { name: `guidelines_registry_v${rec.from_version}_CURRENT.json`, addParents: deps.folders.registry, removeParents: deps.folders.oldVersions });
  await setSetting(env, 'cutover', null);
  await audit(env, actor, 'cutover_rollback', 'registry.legacy', String(rec.to_version), String(rec.from_version), rec);
  return { ok: true, restored: rec.retired };
}
