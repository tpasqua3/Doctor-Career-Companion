// EDUCATIONAL ASSETS as governed MKOS objects (mkos/ontology/assets.json): retrieve first, generate only when needed.
//   Knowledge Objects -> Educational Assets -> asset exists? yes: reuse.  no: generate -> validate -> store.
// An asset is an EducationalAsset object (metadata, currency fingerprint, validation, confidence) plus its content per version in
// mk_asset_store. Shared assets (ea.s.*) serve every account; a personalized adaptation is stored as the learner's own (ea.u<account>.g.*)
// and never shared. Assets are linked to the concepts they teach and the guideline editions and recommendations they were built on
// (mk_asset_links), so impact analysis flags them the moment that knowledge changes.
import { FRAMEWORK } from './framework.js';
import { nowIso, audit, fwGet, overrides } from './db.js';
import { getObject, getObjects, putObject, setStatus, slug } from './kb.js';
import { topicContext, checkCitations } from './bridge.js';
import { nodeForTopic } from './education.js';

const U = (uid) => 'u' + String(uid).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const KINDS = () => FRAMEWORK.frameworks.assets.kinds;
const REGEN = () => FRAMEWORK.frameworks.decomposition.regeneration;
const CLINICAL = FRAMEWORK.frameworks.ontology.relationships.map((r) => r.key);
const h10 = async (s) => (await sha(s)).slice(0, 10);
const jac = (a, b) => { const A = new Set(a || []), B = new Set(b || []); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
const tslug = (tid) => slug(String(tid).replace(/\./g, ' '), 48);
const lessonId = (tid, variant, band) => `ea.s.les.${tslug(tid)}.${slug(variant, 8)}.${band}`;
// What a recommendation says (its substance, not its governance bookkeeping): a change here means the guideline content changed.
const recSig = async (r) => r ? (await sha([r.statement, r.strength, r.strength_original, r.evidence_level, r.loe_original].map((x) => String(x ?? '')).join('|'))).slice(0, 16) : '';

async function policy(env) {
  const o = await overrides(env), g = (p) => fwGet('assets.' + p, o);
  return { delta: g('blueprint_material_delta') ?? 20, bands: g('bands') || { high: 67, medium: 34 }, unreviewed: !!g('validation.reuse_unreviewed'),
    max: g('max_content_bytes') || 600000, batch: g('max_batch') || 30 };
}
const band = (p, b) => p == null ? 'n' : p >= b.high ? 'h' : p >= b.medium ? 'm' : 'l';

/* CONFIDENCE TIERS (assets.json "confidence"): every asset's overall score decides whether and how it is served. Durable assets are
   retrieved deterministically with no AI; provisional ones are served, marked and re-verified at each retrieval; anything below is not
   served to anyone else and waits for review or regeneration. */
const CONF = () => FRAMEWORK.frameworks.assets.confidence;
export const tierOf = (score) => { const t = [...CONF().tiers].sort((a, b) => b.min - a.min).find((x) => (score ?? 0) >= x.min) || CONF().tiers[CONF().tiers.length - 1]; return t; };
export function assetScore(o, { cov = null, uses = 0 } = {}) {
  const S = CONF().score, rs = o.review_status || 'unreviewed', b = o.basis || {};
  let s = S.base[rs] ?? S.base.unreviewed;
  if ((o.needs || []).includes('regenerate')) s = Math.min(s, S.base.needs_regenerate);
  else if ((o.needs || []).length) s = Math.min(s, S.base.flagged);
  const c = cov ?? (o.asset_confidence && o.asset_confidence.citation_coverage) ?? 0;
  s += S.citation_coverage_max_bonus * Math.max(0, Math.min(100, c)) / 100;
  if (Object.keys(b.recs || {}).length || Object.keys(b.families || {}).length) s += S.grounded_bonus;
  const rv = o.review || {};
  if (rs === 'validated') { if (!rv.flagged) s += S.clean_review_bonus; else s += Math.max(S.flagged_segments_floor, S.per_flagged_segment * rv.flagged); }
  s += Math.min(S.reuse_bonus_max, S.reuse_bonus_per_clean_serve * (uses || 0));
  const overall = Math.max(0, Math.min(100, Math.round(s)));
  return { citation_coverage: c, validation_score: S.base[rs] ?? 50, overall, tier: tierOf(overall).id, scored_at: nowIso() };
}
const serves = (o) => !!tierOf(o && o.asset_confidence ? o.asset_confidence.overall : 0).serve;
const GEN = () => FRAMEWORK.frameworks.assets.generation_metadata;
/* Generation metadata (assets.json generation_metadata): who wrote it, with which prompt and template, for which objective. */
const genMeta = (g, d) => { g = g && typeof g === 'object' ? g : {};
  const pick = (k, max = 120) => g[k] == null || g[k] === '' ? null : String(g[k]).slice(0, max);
  return { model: pick('model') || d.generated_by || null, model_version: pick('model_version'), prompt_version: pick('prompt_version') || GEN().prompt_version,
    template_version: pick('template_version') || GEN().template_version, generated_at: pick('generated_at', 40) || nowIso(), objective_id: pick('objective_id') || d.objective || null,
    blueprint_id: pick('blueprint_id') || (d.blueprint_id ? String(d.blueprint_id) : null), blueprint_source: pick('blueprint_source', 200), status: pick('status', 40) || 'complete',
    runner: pick('runner', 20), job_id: pick('job_id', 60), pass: g.pass == null ? null : Number(g.pass) || null, reviewed_by: pick('reviewed_by') || d.reviewed_by || null }; };
const objVariant = async (objective) => 'o' + (await sha(String(objective))).slice(0, 7);

// The topic's currency fingerprint right now: current guideline editions, what its recommendations say, the board weighting.
async function basisNow(env, u, tid, name, pol) {
  const ctx = await topicContext(env, u, tid, { name });
  const families = {}; for (const f of ctx.guidelines || []) if (f.family && f.current_id) families[f.family] = f.current_id;
  const ro = await getObjects(env, (ctx.recommendations || []).slice(0, 12).map((r) => r.id)), recs = {};
  for (const [id, r] of Object.entries(ro)) recs[id] = await recSig(r);
  const priority = ctx.blueprint && ctx.blueprint.mapping ? Math.round(ctx.blueprint.mapping.priority_score) : null;
  // What the topic's knowledge looks like as structure: how many current recommendations cover it, which objectives teach or assess it,
  // which competencies those develop, and its clinical relationships (decomposition.json regeneration rules).
  const concepts = (ctx.node && ctx.node.concepts && ctx.node.concepts.length ? ctx.node.concepts : ctx.concept ? [ctx.concept.id] : []).slice(0, 20);
  let cov = 0, objs = [], comps = [], rels = [];
  if (concepts.length) {
    const q = concepts.map(() => '?').join(',');
    cov = ((await env.DB.prepare(`SELECT COUNT(DISTINCT e.dst) AS n FROM mk_edges e JOIN mk_objects r ON r.id = e.dst WHERE e.src IN (${q}) AND e.rel = 'recommended_by' AND e.status = 'current' AND r.status IN ('current','modified')`).bind(...concepts).first()) || {}).n || 0;
    const ol = (await env.DB.prepare(`SELECT DISTINCT src FROM mk_edges WHERE dst IN (${q}) AND rel IN ('teaches','assesses') AND status = 'current' AND src LIKE 'obj.%' LIMIT 300`).bind(...concepts).all()).results.map((r) => r.src);
    objs = (await Promise.all(ol.map(h10))).sort();
    if (ol.length) { const p = ol.slice(0, 90); comps = (await env.DB.prepare(`SELECT DISTINCT dst FROM mk_edges WHERE src IN (${p.map(() => '?').join(',')}) AND rel = 'develops' AND status = 'current'`).bind(...p).all()).results.map((r) => r.dst).sort(); }
    const rl = (await env.DB.prepare(`SELECT rel, src, dst FROM mk_edges WHERE (src IN (${q}) OR dst IN (${q})) AND status = 'current' AND rel IN (${CLINICAL.map(() => '?').join(',')}) LIMIT 400`).bind(...concepts, ...concepts, ...CLINICAL).all()).results;
    rels = (await Promise.all(rl.map((r) => h10(r.rel + '|' + r.src + '|' + r.dst)))).sort();
  }
  return { ctx, basis: { families, recs, priority, band: band(priority, pol.bands), blueprint_family: (ctx.blueprint && ctx.blueprint.selection && ctx.blueprint.selection.family) || null, cov, objs, comps, rels } };
}

/* Why a stored asset may not be served (null = serve it). The order follows assets.json "regenerate_when". */
async function judge(o, now, live, pol, pool) {
  if (!o) return 'no_asset';
  if (o.status !== 'current') return 'superseded';
  const needs = o.needs || [];
  if (needs.includes('regenerate')) return 'superseded';
  if (needs.length) return 'flagged';
  if (o.review_status !== 'validated' && !(pol.unreviewed && o.review_status === 'unreviewed')) return 'unvalidated';
  const b = o.basis || {};
  for (const [fam, ed] of Object.entries(b.families || {})) if (now.families[fam] && now.families[fam] !== ed) return 'guideline_changed';
  // A guideline family that now speaks to the topic but did not when the asset was written (the library was indexed later, or a new
  // guideline arrived): the asset was written without it, so it is regenerated.
  for (const fam of Object.keys(now.families || {})) if (!(fam in (b.families || {}))) return 'guideline_changed';
  for (const [rid, sig] of Object.entries(b.recs || {})) {
    const r = live[rid];
    if (!r || r.status === 'superseded' || r.status === 'retired' || (sig && (await recSig(r)) !== sig)) return 'guideline_changed';
  }
  if (pool && b.priority != null && now.priority != null && Math.abs(b.priority - now.priority) >= pol.delta) return 'blueprint_changed';
  // Structural change in the topic's knowledge (assets written before these fingerprints existed are judged on the rules above only).
  const R = REGEN();
  if (b.cov != null && now.cov != null && now.cov >= b.cov + Math.max(R.coverage_expanded.min_new, Math.ceil(b.cov * (R.coverage_expanded.min_ratio - 1)))) return 'coverage_expanded';
  if (b.objs && now.objs && jac(b.objs, now.objs) < R.set_change_jaccard_below) return 'objectives_changed';
  if (b.comps && b.comps.length && now.comps && jac(b.comps, now.comps) < 1) return 'competencies_changed';
  if (b.rels && now.rels && jac(b.rels, now.rels) < R.set_change_jaccard_below) return 'relationships_changed';
  return null;
}

// The newest stored content of each asset. A version that changed only metadata (a flag, a review, a status) stores no new content,
// so the newest content row is the current content.
async function loadContent(env, objs) {
  const out = {}, list = [...new Set(objs.filter(Boolean).map((o) => o.id))];
  for (let i = 0; i < list.length; i += 80) {
    const part = list.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT asset_id, content FROM mk_asset_store WHERE asset_id IN (${part.map(() => '?').join(',')}) ORDER BY at, rowid`).bind(...part).all();
    for (const r of results) { try { out[r.asset_id] = JSON.parse(r.content); } catch { /* unreadable content is simply not served */ } }
  }
  return out;
}
async function served(env, uid, kind, ids) {
  if (!ids.length) return;
  const at = nowIso();
  await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO mk_asset_usage (asset_id, user_id, kind, at, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (asset_id, user_id) DO UPDATE SET n = n + 1, at = excluded.at').bind(id, String(uid), kind, at)));
}
const meta = (o) => ({ id: o.id, version: o.version, kind: o.asset_kind, review_status: o.review_status, generated_by: o.generated_by || '', reviewed_by: o.reviewed_by || '',
  generated_at: o.created, updated: o.updated, confidence: o.asset_confidence ? o.asset_confidence.overall : null,
  tier: o.asset_confidence ? tierOf(o.asset_confidence.overall).id : null, objective: o.objective || null, generation: o.generation || null });
const currentWith = (ctx) => (ctx.guidelines || []).map((g) => g.current).filter(Boolean).slice(0, 4);

/* Re-verification at retrieval: the asset's confidence is recomputed with what is known now (its review state, flags, citation coverage,
   grounding and clean reuse). A tier change is stored; an asset that falls below the serving tiers is queued for the owner's review. */
async function reverify(env, o) {
  const uses = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_asset_usage WHERE asset_id = ?').bind(o.id).first()) || {}).n || 0;
  const sc = assetScore(o, { uses }), before = o.asset_confidence || {}, t = tierOf(sc.overall);
  if (before.tier !== sc.tier || Math.abs((before.overall ?? -99) - sc.overall) >= 3) {
    const needs = !t.serve && !(o.needs || []).length ? ['review'] : o.needs || [];
    await putObject(env, { ...o, asset_confidence: sc, confidence_tier: sc.tier, needs }, { actor: 'mkos-reverify', summary: `confidence ${before.overall ?? '-'} -> ${sc.overall} (${sc.tier})`, audited: false });
  }
  return { ...sc, serve: !!t.serve };
}
/* The best objective lesson (assets with an `objective`) on one of this topic's blueprint objectives, if one is servable. */
async function objectiveLessonFor(env, u, tid, now, pol) {
  const node = await getObject(env, nodeForTopic(tid)); const bpts = (node && node.blueprint_topics) || []; if (!bpts.length) return null;
  const { results } = await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.les.%' AND status = 'current' AND json_extract(body, '$.objective') IN (${bpts.slice(0, 60).map(() => '?').join(',')})`).bind(...bpts.slice(0, 60)).all();
  const list = results.map((r) => JSON.parse(r.body)).sort((x, y) => ((y.asset_confidence || {}).overall || 0) - ((x.asset_confidence || {}).overall || 0));
  for (const o of list) {
    if (await judge(o, now, await getObjects(env, Object.keys((o.basis || {}).recs || {})), pol, false)) continue;
    const v = await reverify(env, o); if (!v.serve) continue;
    const c = (await loadContent(env, [o]))[o.id]; if (!c) continue;
    await served(env, u.id, 'lesson', [o.id]);
    return { reuse: true, reason: 'objective_lesson', asset: meta(o), content: c };
  }
  return null;
}
/* objective_lessons {objective | objectives[] | tid}: the stored objective lessons (any tier) with their confidence, for the Boards view. */
export async function objectiveLessons(env, u, a) {
  const ids = Array.isArray(a.objectives) ? a.objectives.map(String).slice(0, 200) : a.objective ? [String(a.objective)] : [];
  let rows;
  if (ids.length) rows = (await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  else rows = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') IS NOT NULL ORDER BY updated DESC LIMIT ?").bind(Math.min(1000, Number(a.limit) || 1000)).all()).results;
  return { lessons: rows.map((r) => meta(JSON.parse(r.body))) };
}
/* objective_lesson {objective}: serve one objective's lesson (deterministic retrieval, no AI) when it is servable. */
export async function objectiveLesson(env, u, a) {
  const id = String(a.objective || ''); if (!id) return { error: 'objective required' };
  const pol = await policy(env);
  const rows = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND json_extract(body, '$.objective') = ? AND id LIKE 'ea.s.%'").bind(id).all()).results.map((r) => JSON.parse(r.body));
  if (!rows.length) return { reuse: false, reason: 'no_asset' };
  const o = rows.sort((x, y) => ((y.asset_confidence || {}).overall || 0) - ((x.asset_confidence || {}).overall || 0))[0];
  const { basis: now } = await basisNow(env, u, o.app_topic, '', pol);
  const why = await judge(o, now, await getObjects(env, Object.keys((o.basis || {}).recs || {})), pol, false); if (why) return { reuse: false, reason: why, asset_id: o.id };
  const v = await reverify(env, o); if (!v.serve) return { reuse: false, reason: 'low_confidence', asset_id: o.id, confidence: v };
  const c = (await loadContent(env, [o]))[o.id]; if (!c) return { reuse: false, reason: 'no_asset' };
  await served(env, u.id, 'lesson', [o.id]);
  return { reuse: true, reason: 'objective_lesson', asset: meta(o), content: c, tid: o.app_topic };
}

/* asset_find {kind, tid, name, len|variant, level, n, exclude, personal}
   Lessons: the one current, validated, guideline-current asset for this topic, length and board-weighting band, or the reason to generate.
   Questions and flashcards: up to n current validated items on the topic this learner has not been served, and how many are missing. */
export async function findAsset(env, u, a) {
  const kind = String(a.kind || ''), K = KINDS()[kind]; if (!K) return { error: 'unknown asset kind (lesson, question, flashcard)' };
  const tid = String(a.tid || ''); if (!tid) return { error: 'tid required' };
  const n = Math.max(1, Math.min(30, Number(a.n) || 1));
  if (a.personal) return { reuse: false, reason: 'personalized', missing: n };
  const pol = await policy(env), { ctx, basis: now } = await basisNow(env, u, tid, String(a.name || ''), pol);
  if (!K.pool) {
    const variant = String(a.len || a.variant || 'std'), id = lessonId(tid, variant, now.band), o = await getObject(env, id);
    let reason = await judge(o, now, o ? await getObjects(env, Object.keys((o.basis || {}).recs || {})) : {}, pol, false);
    if (reason === 'no_asset') for (const b of ['h', 'm', 'l', 'n']) if (b !== now.band) { const x = await getObject(env, lessonId(tid, variant, b)); if (x && x.status === 'current') { reason = 'blueprint_changed'; break; } }
    if (!reason) { const v = await reverify(env, o); if (!v.serve) reason = 'low_confidence'; }
    if (reason) {
      // Deterministic fallback: no current lesson for the topic at this length, but an objective lesson (pass-1 seed) on one of the
      // topic's blueprint objectives is durable or provisional and current: serve it instead of writing.
      if (variant === 'std' && !a.no_objective) { const ob = await objectiveLessonFor(env, u, tid, now, pol); if (ob) return { ...ob, current_with: currentWith(ctx), instead_of: reason }; }
      return { reuse: false, reason, asset_id: id, current_with: currentWith(ctx) };
    }
    const c = (await loadContent(env, [o]))[id]; if (!c) return { reuse: false, reason: 'no_asset', asset_id: id };
    await served(env, u.id, kind, [id]);
    return { reuse: true, reason: 'current_validated', asset: meta(o), content: c, current_with: currentWith(ctx) };
  }
  const prefix = `ea.s.${K.code}.${tslug(tid)}.`, lvl = a.level == null || a.level === '' ? null : Number(a.level);
  const ex = new Set((Array.isArray(a.exclude) ? a.exclude : []).map(String));
  for (const r of (await env.DB.prepare('SELECT asset_id FROM mk_asset_usage WHERE user_id = ? AND asset_id LIKE ?').bind(String(u.id), prefix + '%').all()).results) ex.add(r.asset_id);
  const cands = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE ? AND status = 'current' ORDER BY updated DESC LIMIT 400").bind(prefix + '%').all()).results
    .map((r) => JSON.parse(r.body)).filter((o) => !ex.has(o.id) && (lvl == null || kind !== 'question' || Number(o.variant) === lvl));
  const live = await getObjects(env, [...new Set(cands.flatMap((o) => Object.keys((o.basis || {}).recs || {})))]), ok = [], reasons = {};
  for (const o of cands) { const r = await judge(o, now, live, pol, true) || (serves(o.asset_confidence ? o : { ...o, asset_confidence: assetScore(o) }) ? null : 'low_confidence'); if (r) reasons[r] = (reasons[r] || 0) + 1; else ok.push(o); }
  // Highest confidence first (durable before provisional); ties broken at random so a pool does not always open the same way.
  const sc = (o) => (o.asset_confidence ? o.asset_confidence.overall : assetScore(o).overall) + Math.random() * 0.9;
  ok.sort((x, y) => sc(y) - sc(x));
  const pick = ok.slice(0, n), contents = await loadContent(env, pick), items = pick.filter((o) => contents[o.id]).map((o) => ({ asset: meta(o), content: contents[o.id] }));
  await served(env, u.id, kind, items.map((x) => x.asset.id));
  return { reuse: items.length > 0, reason: items.length ? 'current_validated' : cands.length ? Object.keys(reasons)[0] || 'no_asset' : 'no_asset', items, missing: n - items.length,
    pool: { available: ok.length, not_servable: reasons, already_served: ex.size }, current_with: currentWith(ctx) };
}

/* asset_put {kind, tid, name, len|level, personal, local_id, validated, generated_by, reviewed_by, sources, content | items:[{content, sources, validated, level, local_id}]}
   Validate -> store. Validated means the app's independent accuracy review ran over the whole asset; an asset citing a superseded
   guideline edition is stored but never served (stop-the-line). Unchanged content is a no-op (Generate Once, Store Once). */
export async function putAssets(env, u, a) {
  const kind = String(a.kind || ''), K = KINDS()[kind]; if (!K) return { error: 'unknown asset kind (lesson, question, flashcard)' };
  const tid = String(a.tid || ''); if (!tid) return { error: 'tid required' };
  const pol = await policy(env), items = (Array.isArray(a.items) ? a.items : [a]).slice(0, pol.batch), personal = !!a.personal;
  const { ctx, basis } = await basisNow(env, u, tid, String(a.name || ''), pol);
  const concepts = (ctx.node && ctx.node.concepts && ctx.node.concepts.length ? ctx.node.concepts : ctx.concept ? [ctx.concept.id] : []).slice(0, 20);
  const cites = [...new Set(Object.values(basis.families))], out = [];
  for (const it of items) {
    const content = it.content; if (!content || typeof content !== 'object') { out.push({ error: 'content required' }); continue; }
    const text = JSON.stringify(content); if (text.length > pol.max) { out.push({ error: 'content too large' }); continue; }
    const srcs = (Array.isArray(it.sources) ? it.sources : Array.isArray(a.sources) ? a.sources : []).map(String).filter((s) => s.length > 6).slice(0, 20);
    const cc = srcs.length ? await checkCitations(env, srcs) : { results: [], older: 0 };
    const reviewed = !!(it.validated ?? a.validated);
    const review_status = cc.older ? 'citation_outdated' : reviewed ? 'validated' : 'unreviewed';
    const objective = !K.pool && a.objective ? String(a.objective).slice(0, 80) : null;
    const variant = K.pool ? (it.level ?? a.level ?? null) : objective ? await objVariant(objective) : String(a.len || a.variant || 'std');
    const key = K.pool ? (await sha(tid + '|' + (kind === 'question' ? String(content.stem || '') : String(content.f || content.front || '')).toLowerCase().replace(/\s+/g, ' ').trim())).slice(0, 14) : null;
    const local = String(it.local_id || a.local_id || '');
    const id = personal ? `ea.${U(u.id)}.g.${K.code}.${(await sha(tid + '|' + (K.pool ? key : variant + '|' + local))).slice(0, 16)}`
      : K.pool ? `ea.s.${K.code}.${tslug(tid)}.${key}` : lessonId(tid, variant, basis.band);
    // A shared asset that is current and validated is never replaced by one that is not (a fresh rewrite that failed review, say).
    if (!personal && review_status !== 'validated') {
      const prev = await getObject(env, id);
      if (prev && prev.status === 'current' && prev.review_status === 'validated' && !(prev.needs || []).length) { out.push({ id, version: prev.version, review_status: 'kept_validated', changed: false }); continue; }
    }
    const label = String(it.name || a.title || content.title || content.stem || content.f || tid).replace(/\s+/g, ' ').slice(0, 120);
    const cov = srcs.length ? Math.round(100 * cc.results.filter((x) => x.status === 'current').length / srcs.length) : 0;
    const vs = review_status === 'validated' ? 90 : review_status === 'unreviewed' ? 55 : 20;
    const o = { id, type: 'EducationalAsset', name: `${kind[0].toUpperCase() + kind.slice(1)}: ${label}`,
      asset_kind: K.asset_kind || (K.asset_kind_by_variant || {})[variant] || 'long_form_lesson', app_topic: tid, variant, content_sha: await sha(text),
      store: { kind: 'mkos', user_scope: personal ? 'user' : 'central', path: 'mk_asset_store', item_id: personal && local ? local : id },
      teaches: concepts, cites, difficulty: kind === 'question' && variant != null && !isNaN(Number(variant)) ? Math.round(Number(variant)) : null,
      generated_by: String(it.generated_by || a.generated_by || ''), reviewed_by: reviewed ? String(it.reviewed_by || a.reviewed_by || '') : '',
      derived_from_versions: { ...basis.families, ...basis.recs }, basis,
      asset_confidence: null,
      ...(objective ? { objective, blueprint_id: a.blueprint_id ? String(a.blueprint_id).slice(0, 80) : null, len: String(a.len || 'std') } : {}),
      generation: genMeta(it.generation || a.generation, { generated_by: String(it.generated_by || a.generated_by || ''), objective, blueprint_id: a.blueprint_id, reviewed_by: reviewed ? String(it.reviewed_by || a.reviewed_by || '') : '' }),
      review: (it.review || a.review) && typeof (it.review || a.review) === 'object' ? { fixed: Number((it.review || a.review).fixed) || 0, flagged: Number((it.review || a.review).flagged) || 0 } : null,
      review_status, needs: [], status: 'current', governance_status: review_status === 'validated' ? 'validated' : 'pending_validation',
      provenance: [{ source_id: 'src.app_generation', method: 'ai_generation', agent: String(it.generated_by || a.generated_by || 'ai'), at: nowIso(), note: tid }],
      data: personal ? { user: U(u.id) } : {} };
    void vs; o.asset_confidence = assetScore(o, { cov }); o.confidence_tier = o.asset_confidence.tier;
    // A score below the serving tiers is queued for review at once, so it is never served before someone looks at it.
    if (!tierOf(o.asset_confidence.overall).serve && review_status !== 'citation_outdated') o.needs = ['review'];
    const r = await putObject(env, o, { actor: personal ? 'learner:' + U(u.id) : 'app', summary: `generated ${kind}${review_status === 'validated' ? ', validated' : ', ' + review_status}`, audited: !K.pool });
    const last = await env.DB.prepare('SELECT content FROM mk_asset_store WHERE asset_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(id).first();
    if (!last || last.content !== text)
      await env.DB.prepare('INSERT OR REPLACE INTO mk_asset_store (asset_id, version, content, bytes, at) VALUES (?, ?, ?, ?, ?)').bind(id, r.version, text, text.length, nowIso()).run();
    const who = personal ? String(u.id) : 'central', at = nowIso(), item = o.store.item_id;
    const links = [...concepts.map((c) => [c, 'teaches']), ...cites.map((c) => [c, 'cites']), ...Object.keys(basis.recs).map((c) => [c, 'cites'])];
    await env.DB.batch([env.DB.prepare('DELETE FROM mk_asset_links WHERE asset_id = ?').bind(id),
      ...links.map(([obj, rel]) => env.DB.prepare('INSERT OR IGNORE INTO mk_asset_links (asset_id, user_id, path, item, object_id, rel, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, who, 'mkos', item, obj, rel, at))]);
    if (objective) {
      await env.DB.prepare('INSERT OR IGNORE INTO mk_asset_links (asset_id, user_id, path, item, object_id, rel, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, who, 'mkos', item, objective, 'teaches_objective', at).run();
      const bt = await getObject(env, objective);
      if (bt && bt.blueprint) await env.DB.prepare('INSERT OR REPLACE INTO mk_blueprint_asset_mappings (blueprint_id, asset_id, asset_type, blueprint_weight, priority_score, confidence_score) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(bt.blueprint, id, 'objective_lesson', Number(bt.est_pct) || null, Number(bt.priority_score) || null, o.asset_confidence.overall).run();
    }
    if (!personal) await served(env, u.id, kind, [id]);
    out.push({ id, version: r.version, review_status, changed: r.changed, older_citations: cc.older || 0, confidence: o.asset_confidence.overall, tier: o.asset_confidence.tier });
  }
  return { stored: out, current_with: currentWith(ctx) };
}

/* asset_flag {id, reason}: a learner reports a problem. One flag stops reuse until the owner reviews it. */
export async function flagAsset(env, u, a, owner) {
  const id = String(a.id || '');
  if (!/^(ea|eo\.pe)\./.test(id) || (id.startsWith('ea.u') && !id.startsWith('ea.' + U(u.id) + '.'))) return { error: 'not found' };
  const o = await getObject(env, id); if (!o || !(o.type === 'EducationalAsset' || (o.type === 'EducationalObject' && o.edu_kind === 'clinical_pearl'))) return { error: 'not found' };
  const note = String(a.reason || '').replace(/\s+/g, ' ').slice(0, 500);
  const flags = [...((o.data && o.data.flags) || []), { by: owner ? 'owner' : U(u.id), at: nowIso(), note }].slice(-20);
  await putObject(env, { ...o, needs: [...new Set([...(o.needs || []), 'review'])], review_status: 'flagged', data: { ...(o.data || {}), flags } }, { actor: owner ? 'owner' : 'learner:' + U(u.id), summary: 'flagged: ' + (note || 'no reason given') });
  return { ok: true, id };
}

/* asset_review {id, result: ok | regenerate | retire, note} (owner): clear a flag, send the asset back for regeneration, or retire it. */
export async function reviewAsset(env, u, a) {
  // Educational assets and clinical pearls share this review (a pearl validated here stops being labelled unvalidated; regenerate = failed validation).
  const id = String(a.id || ''), o = await getObject(env, id); if (!o || !(o.type === 'EducationalAsset' || (o.type === 'EducationalObject' && o.edu_kind === 'clinical_pearl'))) return { error: 'not found' };
  const actor = 'owner:' + u.email, note = String(a.note || '').slice(0, 500);
  if (a.result === 'retire') return setStatus(env, id, 'retired', { actor, reason: note || 'retired at review', force: true });
  if (a.result === 'regenerate') { await putObject(env, { ...o, needs: ['regenerate'], review_status: 'needs_regenerate', data: { ...(o.data || {}), regenerate_reason: 'failed validation' + (note ? ': ' + note : '') } }, { actor, summary: 'sent for regeneration' + (note ? ': ' + note : '') }); return { ok: true }; }
  if (a.result !== 'ok') return { error: 'result must be ok, regenerate or retire' };
  await putObject(env, { ...o, needs: [], review_status: 'validated', governance_status: 'validated' }, { actor, summary: 'reviewed ok' + (note ? ': ' + note : '') });
  await audit(env, actor, 'asset_review', id, o.version, null, { result: 'ok', note });
  return { ok: true };
}

/* asset_stats: the shared library by kind and review state, how often it is reused, and (owner) what is waiting for review. */
export async function assetStats(env, u, owner) {
  const by = (await env.DB.prepare("SELECT json_extract(body, '$.asset_kind') AS kind, json_extract(body, '$.review_status') AS rs, status, COUNT(*) AS n FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.%' GROUP BY kind, rs, status").all()).results;
  const use = await env.DB.prepare('SELECT COUNT(*) AS served, COALESCE(SUM(n), 0) AS times FROM mk_asset_usage WHERE at >= ?').bind(new Date(Date.now() - 7 * 864e5).toISOString()).first();
  const mine = await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM mk_asset_usage WHERE user_id = ? GROUP BY kind').bind(String(u.id)).all();
  const flagged = owner ? (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.%' AND json_array_length(COALESCE(json_extract(body, '$.needs'), '[]')) > 0 ORDER BY updated DESC LIMIT 50").all()).results
    .map((r) => { const o = JSON.parse(r.body); return { id: o.id, name: o.name, needs: o.needs, review_status: o.review_status, flags: (o.data && o.data.flags) || [] }; }) : undefined;
  return { library: by, served_7d: use, mine: Object.fromEntries(mine.results.map((r) => [r.kind, r.n])), flagged };
}

/* Daily reconciliation: every current shared asset is judged against today's knowledge; whatever no longer holds is flagged for
   regeneration with the reason (it is rewritten the next time anyone asks for it, never served stale meanwhile). Board weighting is
   judged per learner at request time, so it is not part of this sweep. prog: {after}. */
export async function auditAssets(env, { prog = {}, limit = 40 } = {}) {
  const pol = await policy(env), sys = { id: 'mkos-reconcile', email: 'mkos@system' };
  const list = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.%' AND id > ? AND status = 'current' ORDER BY id LIMIT ?").bind(prog.after || '', limit).all()).results.map((r) => JSON.parse(r.body));
  const byTopic = {}; for (const o of list) (byTopic[o.app_topic] = byTopic[o.app_topic] || []).push(o);
  let flagged = 0; const reasons = {};
  for (const [tid, objs] of Object.entries(byTopic)) {
    const { basis: now } = await basisNow(env, sys, tid, '', pol);
    const live = await getObjects(env, [...new Set(objs.flatMap((o) => Object.keys((o.basis || {}).recs || {})))]);
    for (const o of objs) {
      if ((o.needs || []).length || o.review_status !== 'validated') continue;
      const r = await judge(o, now, live, pol, false);
      if (r && r !== 'unvalidated' && r !== 'flagged') { reasons[r] = (reasons[r] || 0) + 1; flagged++;
        await putObject(env, { ...o, needs: ['regenerate'], review_status: 'needs_regenerate', data: { ...(o.data || {}), regenerate_reason: r, regenerate_at: nowIso() } }, { actor: 'reconcile', summary: 'regeneration queued: ' + r, audited: false }); }
      else if (!r) { const v = await reverify(env, o); if (!v.serve) { reasons.low_confidence = (reasons.low_confidence || 0) + 1; flagged++; } }
    }
  }
  if (list.length) prog.after = list[list.length - 1].id;
  return { done: list.length < limit, checked: list.length, flagged, reasons };
}

/* RETROACTIVE ASSET IMPORT: the owner's existing reviewed lessons (with their check questions) and reviewed questions become shared
   library assets, judged like anything newly written: personalized ones (a focus, a gap, a dig-deeper, a lesson being finished) are left
   out, and anything citing an older guideline edition is stored as citation_outdated and never served. Flashcards are not imported:
   the record does not show which passed review. prog: {at} index into the record's documents. */
export async function importOwnerAssets(env, deps, { prog = {}, perStep = 6 } = {}) {
  const oid = deps.ownerId ? await deps.ownerId() : null; if (!oid) return { done: true, note: 'no owner account' };
  const u = { id: oid, email: 'owner' }, docs = await deps.ownerDocs(['med/les_', 'med/bank_']), paths = Object.keys(docs).sort();
  const out = prog.out || (prog.out = { lessons: 0, questions: 0, skipped: 0, outdated: 0 });
  const allQs = paths.filter((p) => /^med\/bank_/.test(p)).flatMap((p) => (docs[p] && docs[p].qs) || []);
  const qOut = (q) => ({ stem: q.stem, opts: q.opts, ans: q.ans, exp: q.exp, obj: q.obj || '', cav: q.cav || '', src: q.src || [], ref: q.ref || '', d: q.d || null });
  let n = 0;
  for (prog.at = prog.at || 0; prog.at < paths.length && n < perStep; prog.at++) {
    const path = paths[prog.at], d = docs[path]; if (!d || typeof d !== 'object') continue;
    if (/^med\/les_/.test(path)) {
      if (!d.tid || !d.len || d.focus || d.parent || d.deeper || d.part || !d.rev || !d.rev.done || !Array.isArray(d.segs) || !d.segs.length || d.mk) { out.skipped++; continue; }
      const checks = allQs.filter((q) => q.les === d.id).map(qOut);
      const r = await putAssets(env, u, { kind: 'lesson', tid: d.tid, name: '', len: d.len, validated: true, generated_by: (d.by && d.by.w) || 'legacy_record', reviewed_by: (d.by && d.by.r) || '', sources: d.src || [], title: d.title,
        content: { title: d.title, len: d.len, min: d.min, rev: d.rev, segs: d.segs, pts: d.pts || [], pit: d.pit || [], src: d.src || [], unc: d.unc || [], ref: d.ref || '', by: d.by || null, checks, cards: [] } });
      const st = (r.stored || [])[0] || {}; if (st.review_status === 'citation_outdated') out.outdated++; else if (st.id) out.lessons++; n++;
    } else if (/^med\/bank_/.test(path)) {
      const by = {};
      for (const q of d.qs || []) { if (!q.tid || !q.rev || q.gap || q.les || q.from || q.mk || q.lib || !Array.isArray(q.opts) || q.opts.length < 4) { out.skipped++; continue; } const k = q.tid + '|' + (q.d || 3); (by[k] = by[k] || []).push(q); }
      for (const [k, qs] of Object.entries(by)) {
        const [tid, lvl] = k.split('|');
        for (let i = 0; i < qs.length; i += 30) {
          const r = await putAssets(env, u, { kind: 'question', tid, name: '', level: Number(lvl), generated_by: 'legacy_record', items: qs.slice(i, i + 30).map((q) => ({ content: qOut(q), validated: true, sources: q.src || [] })) });
          for (const st of r.stored || []) { if (st.review_status === 'citation_outdated') out.outdated++; else if (st.id) out.questions++; }
        }
      }
      n++;
    }
  }
  return { done: prog.at >= paths.length, ...out };
}
