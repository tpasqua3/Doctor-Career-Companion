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
import { findAsset, putAssets, flagAsset, reviewAsset, assetStats } from './assets.js';
import { dashboard as pronDashboard, flag as pronFlag, approve as pronApprove, rejectCandidate, syncOwner, pronId } from './pronounce.js';

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
  settings: { owner: true, run: async (env, u, a) => { if (!a.path) return { error: 'path required' }; const before = fwGet(String(a.path)); await setSetting(env, 'fw:' + a.path, a.value == null ? null : JSON.stringify(a.value)); resetOverrides(); await audit(env, 'owner:' + u.email, 'setting', 'fw:' + a.path, JSON.stringify(before), JSON.stringify(a.value)); return { ok: true, path: a.path, default: before, value: a.value }; } },
  rescan: { owner: true, run: async (env) => { await setSetting(env, 'scan', null); return { ok: true, note: 'A full library sweep starts on the next run.' }; } },
  pause: { owner: true, run: async (env, u, a) => { await setSetting(env, 'paused', a.on === false ? null : '1'); return { ok: true, paused: a.on !== false }; } },
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
  { name: 'mkos', description: 'The Medical Knowledge Operating System (MKOS): the app\'s structured knowledge base (sources, guidelines, concepts, recommendations, evidence, blueprint, curriculum) and this physician\'s learner state. `op` is one of: status, search {q, type, specialty, include_history}, object {id, history, neighbors}, context {id} (the governed teaching package for a concept: current recommendations with citations, board mapping, facets), route {q} (answers from the lowest-cost authoritative layer and says which), learner {level}, plan (what to teach, review, assess, reinforce, remediate, prioritize, delay), refresh_me, framework. pronunciation {term}. Educational assets (retrieve first, generate only when needed): asset_find {kind: lesson|question|flashcard, tid, name, len, level, n, exclude, personal} (a current, validated, guideline-current stored asset, or the reason to generate), asset_put {kind, tid, name, len|level, personal, local_id, validated, generated_by, reviewed_by, sources, content | items} (validate and store a generated asset), asset_flag {id, reason}, asset_stats. Owner: asset_review {id, result: ok|regenerate|retire}. Owner only: pron_dashboard, pron_flag {term, source_system} (Mark Pronunciation Incorrect: records it and generates ranked candidates), pron_approve {term, index | simplified, ipa, lock}, pron_reject {term, index}, pron_sync, events, jobs, audit {id}, review {id, result, note}, edit {object, summary}, set_status {id, status, replaced_by, reason}, settings {path, value}, rescan, requeue {kind}, tick, graph_validation, compat_registry, cutover_validate, cutover_retire {confirm}, cutover_rollback.',
    inputSchema: { type: 'object', properties: { op: { type: 'string' }, args: { type: 'object' } }, required: ['op'] }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
