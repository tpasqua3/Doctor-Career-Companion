// MKOS API (/api/mkos/*) and connector tools. One implementation (mkosCall) serves both, so the website and the app inside Claude
// see the same thing. Reading knowledge is open to every signed-in account (it is central); learner state is the caller's own only;
// administration (reviews, edits, settings, scans, cutover) is the owner's alone.
import { mkInit, J, nowIso, setSetting, getSetting, audit, resetOverrides, fwGet } from './db.js';
import { getObject, getObjects, query, history, putObject, setStatus } from './kb.js';
import { neighbors } from './graph.js';
import { conceptContext, routeRequest, curriculumPlan } from './adaptive.js';
import { learnerSummary } from './learner.js';
import { review, graphValidation, status, stopChecks } from './governance.js';
import { queue } from './ingest.js';
import { buildCompatRegistry, validateCutover, retireLegacy, rollbackCutover } from './cutover.js';
import { mkTick } from './tick.js';
import { FRAMEWORK, FRAMEWORK_HASH } from './framework.js';
import { listBlueprints, blueprintDetail, boardPlan, boardRecommendations, select as selectBlueprint, selection as bpSelection, scoresFor } from './blueprint.js';
import { appBundle, topicContext, checkCitations, assetFlags } from './bridge.js';
import { ttsList } from './pronounce.js';
import { findAsset, putAssets, flagAsset, reviewAsset, assetStats, objectiveLessons, objectiveLesson } from './assets.js';
import { curSync, curStatus } from './curstore.js';
import { mapObjectives, mappingStatus } from './objmap.js';
import { genAdd, genBatch, genList, genGet, genResume, genCancel, genPage, genFiled, runGen, genModels, seedStart, seedStatus, seedPause, seedRetry, iteMap } from './genjobs.js';
import { durability, mirrorStep, persistNow } from './mirror.js';
import { progress } from './progress.js';
import { pdfOutline } from './outline.js';
import { restoreStep, drillStep } from './restore.js';
import { dashboard as pronDashboard, flag as pronFlag, approve as pronApprove, rejectCandidate, syncOwner, pronId } from './pronounce.js';

// The engine's run lease (tick.js): one writer at a time.
async function withLease(env, fn) {
  const lease = J(await getSetting(env, 'tick_lease'), null);
  if (lease && Date.now() - lease.t < 360e3) return { skipped: 'another run is in progress; try again in a minute' };
  const id = 'op' + Math.random().toString(36).slice(2); await setSetting(env, 'tick_lease', JSON.stringify({ t: Date.now(), id }));
  try { return await fn(); } finally { const cur = J(await getSetting(env, 'tick_lease'), null); if (cur && cur.id === id) await setSetting(env, 'tick_lease', null); }
}
// Configuration changed: persist it to Drive now (it is already queued, so a failure here is retried by the next run).
async function persistConfig(env, x) {
  if (!x || !x.deps || !x.deps.mkosRoot) return null;
  try { const r = await persistNow(env, x.deps, x.deps.mkosRoot, { only: ['config'] }); return r.skipped ? 'queued' : r.failed ? 'queued (Drive did not confirm; retried next run)' : 'confirmed'; }
  catch (e) { return 'queued (' + String(e.message || e).slice(0, 80) + ')'; }
}
export async function noteMirrorError(env, e) {
  const list = J(await getSetting(env, 'mirror_errors'), []) || [];
  list.push({ at: nowIso(), error: String((e && e.message) || e).slice(0, 300) }); await setSetting(env, 'mirror_errors', JSON.stringify(list.slice(-20)));
}

const OPS = {
  // ---- open to every account
  status: { owner: false, run: async (env, u, a, x) => x.owner ? { framework_hash: FRAMEWORK_HASH, ...(await status(env)) } : { framework_hash: FRAMEWORK_HASH, objects: (await status(env)).objects } },
  search: { owner: false, run: async (env, u, a, x) => ({ results: (await query(env, { q: a.q, type: a.type, types: a.types, specialty: a.specialty, include_history: !!a.include_history, include_user_assets: !!x.owner && !!a.include_user_assets, limit: Math.min(100, Number(a.limit) || 25), offset: Number(a.offset) || 0 }))
    .map((o) => ({ id: o.id, type: o.type, name: o.name, status: o.status, governance: o.governance_status, trust: o.scores?.trust_score, confidence: o.confidence?.confidence_score, specialty: o.specialty, version: o.version })) }) },
  object: { owner: false, run: async (env, u, a) => { const o = await getObject(env, String(a.id || '')); if (!o) return { error: 'not found' };
    if (o.store?.user_scope === 'user' && o.data?.user && !a._owner && !String(o.id).includes('u' + String(u.id).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase())) return { error: 'not found' };
    return { object: o, history: a.history ? await history(env, o.id) : undefined, neighbors: a.neighbors ? await neighbors(env, o.id, { include_history: !!a.include_history, limit: 200 }) : undefined, stop_the_line: await stopChecks(env, o) }; } },
  context: { owner: false, run: async (env, u, a) => (await conceptContext(env, String(a.id || ''), { include_history: !!a.include_history })) || { error: 'not found' } },
  route: { owner: false, run: async (env, u, a) => routeRequest(env, u.id, String(a.q || ''), { include_history: !!a.include_history }) },
  learner: { owner: false, run: async (env, u, a) => ({ states: await learnerSummary(env, u.id, { level: a.level || null, limit: Math.min(200, Number(a.limit) || 50) }) }) },
  plan: { owner: false, run: async (env, u, a) => curriculumPlan(env, u.id, { limit: Math.min(30, Number(a.limit) || 12), exam: a.exam === 'cert' ? 'cert' : 'lka' }) },
  refresh_me: { owner: false, run: async (env, u) => { await queue(env, 'assets', u.id, {}, 4); return { queued: true }; } },
  // ---- owner
  events: { owner: true, run: async (env, u, a) => ({ events: (await env.DB.prepare('SELECT * FROM mk_events ORDER BY created DESC LIMIT ?').bind(Math.min(200, Number(a.limit) || 50)).all()).results.map((r) => ({ ...r, detail: J(r.detail), impact: J(r.impact) })) }) },
  jobs: { owner: true, run: async (env, u, a) => ({ jobs: (await env.DB.prepare("SELECT id, kind, subject, state, tries, priority, note, updated FROM mk_jobs WHERE state != 'done' ORDER BY priority, id LIMIT ?").bind(Math.min(300, Number(a.limit) || 100)).all()).results }) },
  audit: { owner: true, run: async (env, u, a) => ({ audit: (await env.DB.prepare(a.id ? 'SELECT * FROM mk_audit WHERE object_id = ? ORDER BY id DESC LIMIT 100' : 'SELECT * FROM mk_audit ORDER BY id DESC LIMIT 100').bind(...(a.id ? [a.id] : [])).all()).results }) },
  review: { owner: true, run: async (env, u, a) => review(env, String(a.id || ''), a.result, { actor: 'owner:' + u.email, note: String(a.note || '') }) },
  edit: { owner: true, run: async (env, u, a) => { const o = a.object; if (!o || !o.id) return { error: 'object with id required' }; const prev = await getObject(env, o.id);
    const next = { ...(prev || {}), ...o, provenance: [...(prev?.provenance || []), { source_id: (o.source_id || prev?.source_id || 'src.owner'), method: 'owner_edit', at: nowIso(), agent: u.email }] };
    return putObject(env, next, { actor: 'owner:' + u.email, summary: String(a.summary || 'owner edit'), part: a.part || 'minor', strict: true }); } },
  set_status: { owner: true, run: async (env, u, a) => setStatus(env, String(a.id || ''), a.status, { actor: 'owner:' + u.email, replaced_by: a.replaced_by || null, reason: String(a.reason || '') }) },
  settings: { owner: true, run: async (env, u, a, x) => { if (!a.path) return { error: 'path required' }; const before = fwGet(String(a.path)); await setSetting(env, 'fw:' + a.path, a.value == null ? null : JSON.stringify(a.value)); resetOverrides(); await audit(env, 'owner:' + u.email, 'setting', 'fw:' + a.path, JSON.stringify(before), JSON.stringify(a.value)); const persisted = await persistConfig(env, x); return { ok: true, path: a.path, default: before, value: a.value, persisted }; } },
  rescan: { owner: true, run: async (env) => { await setSetting(env, 'scan', null); return { ok: true, note: 'A full library sweep starts on the next run.' }; } },
  pause: { owner: true, run: async (env, u, a, x) => { await setSetting(env, 'paused', a.on === false ? null : '1'); await persistConfig(env, x); return { ok: true, paused: a.on !== false }; } },
  requeue: { owner: true, run: async (env, u, a) => { await env.DB.prepare("UPDATE mk_jobs SET state = 'queued', tries = 0, not_before = 0 WHERE state = 'failed' AND (? = '' OR kind = ?)").bind(a.kind || '', a.kind || '').run(); return { ok: true }; } },
  tick: { owner: true, run: async (env, u, a, x) => mkTick(env, x.deps, x.roots) },
  graph_validation: { owner: true, run: async (env) => graphValidation(env) },
  compat_registry: { owner: true, run: async (env) => (await buildCompatRegistry(env)) || { error: 'legacy registry not imported yet' } },
  cutover_validate: { owner: true, run: async (env, u, a, x) => validateCutover(env, x.deps, { learnerDocs: await x.deps.userDocs(u.id, ['med/libreg', 'med/les_', 'med/bank_', 'med/cards_']) }) },
  cutover_retire: { owner: true, run: async (env, u, a, x) => retireLegacy(env, x.deps, { actor: 'owner:' + u.email, confirm: a.confirm === true }) },
  cutover_rollback: { owner: true, run: async (env, u, a, x) => rollbackCutover(env, x.deps, { actor: 'owner:' + u.email }) },
  pronunciation: { owner: false, run: async (env, u, a) => { const o = await getObject(env, pronId(String(a.term || ''))); return o ? { record: o } : { error: 'no pronunciation record for that term' }; } },
  pron_dashboard: { owner: true, run: async (env, u, a) => pronDashboard(env, { limit: Math.min(100, Number(a.limit) || 25) }) },
  pron_flag: { owner: true, run: async (env, u, a, x) => pronFlag(env, x.deps, String(a.term || ''), { user: 'owner:' + u.email, source_system: String(a.source_system || 'api') }) },
  pron_approve: { owner: true, run: async (env, u, a, x) => pronApprove(env, x.deps, String(a.term || ''), { index: a.index ?? null, simplified: a.simplified || null, ipa: a.ipa || '', lock: a.lock !== false, user: 'owner:' + u.email }) },
  pron_reject: { owner: true, run: async (env, u, a) => rejectCandidate(env, String(a.term || ''), a.index, { user: 'owner:' + u.email }) },
  pron_sync: { owner: true, run: async (env, u, a, x) => syncOwner(env, x.deps, {}) },
  // ---- Board Blueprint Governance (Blueprint Execution Engine API contracts)
  blueprints: { owner: false, run: async (env, u, a) => a.id ? blueprintDetail(env, a.id, { limit: Math.min(800, Number(a.limit) || 200) }) : listBlueprints(env) },
  learners: { owner: false, run: async (env, u, a, x) => { const [lid, what] = String(a.id || '').split('/'); const id = lid === 'me' ? u.id : lid;
    if (id !== u.id && !x.owner) return { error: 'You can see your own plan only.' };
    if (what === 'board-plan') return boardPlan(env, id, { limit: Math.min(50, Number(a.limit) || 15) }); return { error: 'unknown learner resource' }; } },
  'board-review': { owner: false, run: async (env, u, a) => boardRecommendations(env, u.id, { limit: Math.min(40, Number(a.limit) || 12) }) },
  select_blueprint: { owner: false, run: async (env, u, a) => selectBlueprint(env, u.id, { family: a.family || null, app_kind: a.app_kind || null, source: a.source || 'app' }) },
  // ---- The app bridge (one call per screen; everything computed from MKOS, no AI)
  app_bundle: { owner: false, run: async (env, u, a, x) => appBundle(env, u, { owner: x.owner, app_kind: a.app_kind || null }) },
  topic_context: { owner: false, run: async (env, u, a) => topicContext(env, u, String(a.tid || ''), { name: String(a.name || '') }) },
  check_citations: { owner: false, run: async (env, u, a) => checkCitations(env, Array.isArray(a.citations) ? a.citations.slice(0, 40) : []) },
  asset_flags: { owner: false, run: async (env, u) => assetFlags(env, u) },
  pron_tts: { owner: false, run: async (env) => ({ list: await ttsList(env) }) },
  // ---- Educational assets as governed MKOS objects: retrieve first, generate only when needed (assets.js)
  asset_find: { owner: false, run: async (env, u, a) => findAsset(env, u, a) },
  asset_put: { owner: false, run: async (env, u, a) => putAssets(env, u, a) },
  asset_flag: { owner: false, run: async (env, u, a, x) => flagAsset(env, u, a, x.owner) },
  asset_stats: { owner: false, run: async (env, u, a, x) => assetStats(env, u, x.owner) },
  asset_review: { owner: true, run: async (env, u, a) => reviewAsset(env, u, a) },
  objective_lessons: { owner: false, run: async (env, u, a) => objectiveLessons(env, u, a) },
  objective_lesson: { owner: false, run: async (env, u, a) => objectiveLesson(env, u, a) },
  // ---- The generation queue: lessons as jobs bound to one model, background and batch generation, objective seeding (genjobs.js)
  gen_models: { owner: false, run: async (env, u, a, x) => genModels(env, x.deps) },
  gen_add: { owner: false, run: async (env, u, a, x) => { const r = await genAdd(env, x.deps, u, a); if (r.job && r.job.runner === 'server' && x.kick) x.kick(u.id); return r; } },
  gen_batch: { owner: false, run: async (env, u, a, x) => { const r = await genBatch(env, x.deps, u, a); if (x.kick) x.kick(u.id); return r; } },
  gen_list: { owner: false, run: async (env, u, a) => genList(env, u, a) },
  gen_get: { owner: false, run: async (env, u, a) => genGet(env, u, a) },
  gen_resume: { owner: false, run: async (env, u, a, x) => { const r = await genResume(env, u, a); if (r.job && r.job.runner === 'server' && x.kick) x.kick(u.id); return r; } },
  gen_cancel: { owner: false, run: async (env, u, a) => genCancel(env, u, a) },
  gen_page: { owner: false, run: async (env, u, a) => genPage(env, u, a) },
  gen_filed: { owner: false, run: async (env, u, a) => genFiled(env, u, a) },
  // An open page lends the server its connection to get its own queued lessons written sooner (the 5-minute run does it otherwise).
  gen_pump: { owner: false, run: async (env, u, a, x) => runGen(env, x.deps, { budgetMs: Math.max(30e3, Math.min(150e3, Number(a.ms) || 100e3)), user: u.id }) },
  ite_map: { owner: false, run: async (env, u, a) => iteMap(env, u, a) },
  seed_status: { owner: false, run: async (env) => seedStatus(env) },
  seed_start: { owner: true, run: async (env, u, a, x) => seedStart(env, x.deps, u, a) },
  seed_pause: { owner: true, run: async (env, u, a) => seedPause(env, u, a) },
  seed_retry: { owner: true, run: async (env) => seedRetry(env) },
  objective_mapping_status: { owner: false, run: async (env) => mappingStatus(env) },
  objective_mapping_run: { owner: true, run: async (env) => mapObjectives(env, {}) },
  curriculum_status: { owner: false, run: async (env) => curStatus(env) },
  curriculum_sync: { owner: true, run: async (env, u, a, x) => curSync(env, x.deps, { max: Math.max(1, Math.min(30, Number(a.max) || 10)) }) },
  // ---- Decomposition and the daily reconciliation (decompose.js, classify.js, reconcile.js)
  decomposition: { owner: false, run: async (env) => ({
    objects: (await env.DB.prepare("SELECT type, COALESCE(json_extract(body, '$.edu_kind'), json_extract(body, '$.claim_kind'), json_extract(body, '$.objective_type')) AS kind, status, COUNT(*) AS n FROM mk_objects WHERE type IN ('Objective','EducationalObject','Claim') GROUP BY type, kind, status").all()).results,
    recommendations: (await env.DB.prepare("SELECT CASE WHEN json_extract(body, '$.decomposition.v') IS NULL THEN 'waiting' WHEN json_extract(body, '$.decomposition.ov') IS NOT version THEN 'changed' ELSE 'decomposed' END AS state, COUNT(*) AS n FROM mk_objects WHERE type = 'Recommendation' GROUP BY state").all()).results,
    classified: (await env.DB.prepare("SELECT CASE WHEN json_extract(body, '$.classification.v') IS NULL THEN 'unclassified' ELSE 'classified' END AS state, COUNT(*) AS n FROM mk_objects WHERE id NOT LIKE 'ea.u%' GROUP BY state").all()).results }) },
  // ---- Canonical storage: Drive is the system of record; D1 is rebuildable from it (mirror.js, restore.js)
  durability: { owner: false, run: async (env, u, a, x) => ({ ...(await durability(env, x && x.deps)), errors: J(await getSetting(env, 'mirror_errors'), []), drill: J(await getSetting(env, 'drill_report'), null) }) },
  // Persist to Drive now, in a larger batch than the engine's per-run slice (shares the engine's run lease, so the two never collide).
  persist: { owner: true, run: async (env, u, a, x) => withLease(env, async () => {
    try { return await mirrorStep(env, x.deps, x.deps.mkosRoot, { max: Math.max(1, Math.min(40, Number(a.max) || 20)) }); }
    catch (e) { await noteMirrorError(env, e); return { error: String(e.message || e).slice(0, 300) }; } }) },
  // How far the knowledge build has come: percent per stage and overall, the milestones reached, failed jobs (progress.js).
  progress: { owner: false, run: async (env) => progress(env) },
  // Owner: read a large library PDF's table of contents without indexing it (headings and page numbers only), to check a file.
  outline_probe: { owner: true, run: async (env, u, a, x) => {
    const id = String(a.file_id || ''); if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return { error: 'file_id required' };
    const size = Number(a.size) || 0; if (!size) return { error: 'size (bytes) required' };
    const t0 = Date.now(), log = [], limit = Math.min(150e3, Number(a.ms) || 90e3);
    const read = async (s, e) => { if (Date.now() - t0 > limit) throw new Error('time limit reached'); const t = Date.now(); const b = await x.deps.readRange(id, s, e); log.push({ at: s, ms: Date.now() - t, bytes: b.length }); return b; };
    let r; try { r = await pdfOutline(read, size, { maxReads: Number(a.max_reads) || 120 }); } catch (e) { return { error: String(e.message || e), reads: log.length, ms: Date.now() - t0, read_log: log.slice(0, 30) }; }
    return { items: r.items.length, chapters: r.items.filter((i) => i.level === 1).length, pages: r.pages || null, reason: r.reason || null, reads: log.length, ms: Date.now() - t0, read_ms: log.map((l) => l.ms).slice(0, 20), read_bytes: log.map((l) => l.bytes).slice(0, 20), status: x.deps.lastRangeStatus ? x.deps.lastRangeStatus() : null, first: r.items.slice(0, Math.min(40, Number(a.n) || 15)) };
  } },
  // The persistence ledger: every file's queued, persisted, failed, retried and reconciled entries (newest first).
  persistence: { owner: true, run: async (env, u, a) => ({ ledger: (await env.DB.prepare(`SELECT at, key, state, detail FROM mk_persist_log ${a.state ? 'WHERE state = ?' : ''} ORDER BY id DESC LIMIT ?`).bind(...(a.state ? [String(a.state)] : []), Math.max(1, Math.min(500, Number(a.limit) || 100))).all()).results,
    counts_7d: (await env.DB.prepare('SELECT state, COUNT(*) AS n FROM mk_persist_log WHERE at >= ? GROUP BY state').bind(new Date(Date.now() - 7 * 864e5).toISOString()).all()).results }) },
  // The restore drill: rebuild the empty DRILL_DB from Drive alone and compare with production. One slice per call; reset starts over.
  restore_drill: { owner: true, run: async (env, u, a, x) => {
    const prog = a.reset ? {} : J(await getSetting(env, 'drill_prog'), {}) || {};
    if (prog.phase === 'done' && !a.reset) return { done: true, report: J(await getSetting(env, 'drill_report'), null) };
    const r = await drillStep(env, env.DRILL_DB, x.deps, x.deps.mkosRoot, prog);
    await setSetting(env, 'drill_prog', JSON.stringify(prog));
    if (r.report) { await setSetting(env, 'drill_report', JSON.stringify(r.report)); await audit(env, 'owner:' + u.email, 'restore_drill', null, null, r.report.pass ? 'pass' : 'fail', { counts: r.report.counts, missing: r.report.missing_in_rebuild, differs: r.report.content_differs }); }
    return r; } },
  restore: { owner: true, run: async (env, u, a, x) => {
    if (a.mode === 'verify' || !a.mode) return restoreStep(env, x.deps, x.deps.mkosRoot, {}, { mode: 'verify' });
    if (a.mode === 'restore' && a.confirm === true) { await queue(env, 'restore', 'drive:' + nowIso(), { mode: 'restore' }, 1); return { queued: true, note: 'The database is being rebuilt from the Drive MKOS folder over the next runs; nothing newer in the database is overwritten.' }; }
    return { error: 'mode is verify, or restore with confirm: true' }; } },
  reconcile: { owner: true, run: async (env, u, a) => { if (a.run) { await queue(env, 'reconcile', 'manual:' + nowIso(), {}, 2); }
    return { queued: !!a.run, last_report: J(await getSetting(env, 'reconcile_report'), null), last_day: await getSetting(env, 'reconcile_day') }; } },
  framework: { owner: false, run: async () => ({ framework_hash: FRAMEWORK_HASH, versions: Object.fromEntries(Object.entries(FRAMEWORK.frameworks).map(([k, v]) => [k, v.version])), ontology: FRAMEWORK.frameworks.ontology }) },
};

// x: {owner: bool, deps, roots}
export async function mkosCall(env, user, op, args, x) {
  const d = OPS[op]; if (!d) return { status: 404, body: { error: 'Unknown MKOS operation.', ops: Object.keys(OPS) } };
  if (d.owner && !x.owner) return { status: 403, body: { error: 'Only the site owner can do that.' } };
  await mkInit(env);
  const body = await d.run(env, user, { ...(args || {}), _owner: x.owner }, x);
  return { status: body && body.error ? 400 : 200, body };
}

// /api/mkos/<op>[/<id>] — GET takes query parameters, POST/PUT take a JSON body.
export async function mkosApi(request, env, url, user, body, x) {
  const parts = url.pathname.replace(/^\/api\/mkos\/?/, '').split('/').filter(Boolean);
  const op = parts[0] || 'status', args = { ...Object.fromEntries(url.searchParams), ...(body || {}) };
  if (parts[1]) args.id = decodeURIComponent(parts.slice(1).join('/'));
  for (const k of ['include_history', 'history', 'neighbors', 'confirm']) if (args[k] === 'true' || args[k] === '1') args[k] = true;
  return mkosCall(env, user, op, args, x);
}

export const MKOS_TOOLS = [
  { name: 'mkos', description: 'The Medical Knowledge Operating System (MKOS): the app\'s structured knowledge base (sources, guidelines, concepts, recommendations, evidence, blueprint, curriculum) and this physician\'s learner state. `op` is one of: status, search {q, type, specialty, include_history}, object {id, history, neighbors}, context {id} (the governed teaching package for a concept: current recommendations with citations, board mapping, facets), route {q} (answers from the lowest-cost authoritative layer and says which), learner {level}, plan (what to teach, review, assess, reinforce, remediate, prioritize, delay), refresh_me, framework. pronunciation {term}. Educational assets (retrieve first, generate only when needed): asset_find {kind: lesson|question|flashcard, tid, name, len, level, n, exclude, personal} (a current, validated, guideline-current stored asset, or the reason to generate), asset_put {kind, tid, name, len|level, personal, local_id, validated, generated_by, reviewed_by, sources, content | items} (validate and store a generated asset), asset_flag {id, reason} (also clinical pearls), asset_stats. Owner: asset_review {id, result: ok|regenerate|retire} (assets and clinical pearls: ok validates, regenerate = failed validation). decomposition (counts of objectives, teaching points, targets and criteria; decomposition and classification progress). Owner: reconcile {run} (queue the daily reconciliation now; returns the last report). durability (how far the Drive system of record is behind the database, recent write errors, the last restore drill). Owner: persist {max} (write to Drive now), restore_drill {reset} (rebuild an empty database from Drive and compare with production; call until done). Owner: restore {mode: verify} (compare the Drive manifest with the database) or restore {mode: restore, confirm: true} (rebuild the database from Drive). Owner only: pron_dashboard, pron_flag {term, source_system} (Mark Pronunciation Incorrect: records it and generates ranked candidates), pron_approve {term, index | simplified, ipa, lock}, pron_reject {term, index}, pron_sync, events, jobs, audit {id}, review {id, result, note}, edit {object, summary}, set_status {id, status, replaced_by, reason}, settings {path, value}, rescan, requeue {kind}, tick, graph_validation, compat_registry, cutover_validate, cutover_retire {confirm}, cutover_rollback.',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, args: { type: 'object' } }, required: ['op'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
