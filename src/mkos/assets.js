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

const U = (uid) => 'u' + String(uid).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const KINDS = () => FRAMEWORK.frameworks.assets.kinds;
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

// The topic's currency fingerprint right now: current guideline editions, what its recommendations say, the board weighting.
async function basisNow(env, u, tid, name, pol) {
  const ctx = await topicContext(env, u, tid, { name });
  const families = {}; for (const f of ctx.guidelines || []) if (f.family && f.current_id) families[f.family] = f.current_id;
  const ro = await getObjects(env, (ctx.recommendations || []).slice(0, 12).map((r) => r.id)), recs = {};
  for (const [id, r] of Object.entries(ro)) recs[id] = await recSig(r);
  const priority = ctx.blueprint && ctx.blueprint.mapping ? Math.round(ctx.blueprint.mapping.priority_score) : null;
  return { ctx, basis: { families, recs, priority, band: band(priority, pol.bands), blueprint_family: (ctx.blueprint && ctx.blueprint.selection && ctx.blueprint.selection.family) || null } };
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
  for (const [rid, sig] of Object.entries(b.recs || {})) {
    const r = live[rid];
    if (!r || r.status === 'superseded' || r.status === 'retired' || (sig && (await recSig(r)) !== sig)) return 'guideline_changed';
  }
  if (pool && b.priority != null && now.priority != null && Math.abs(b.priority - now.priority) >= pol.delta) return 'blueprint_changed';
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
  generated_at: o.created, updated: o.updated, confidence: o.asset_confidence ? o.asset_confidence.overall : null });
const currentWith = (ctx) => (ctx.guidelines || []).map((g) => g.current).filter(Boolean).slice(0, 4);

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
    if (reason) return { reuse: false, reason, asset_id: id, current_with: currentWith(ctx) };
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
  for (const o of cands) { const r = await judge(o, now, live, pol, true); if (r) reasons[r] = (reasons[r] || 0) + 1; else ok.push(o); }
  for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
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
    const variant = K.pool ? (it.level ?? a.level ?? null) : String(a.len || a.variant || 'std');
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
      asset_confidence: { citation_coverage: cov, validation_score: vs, overall: Math.round(vs * 0.75 + cov * 0.25) },
      review_status, needs: [], status: 'current', governance_status: review_status === 'validated' ? 'validated' : 'pending_validation',
      provenance: [{ source_id: 'src.app_generation', method: 'ai_generation', agent: String(it.generated_by || a.generated_by || 'ai'), at: nowIso(), note: tid }],
      data: personal ? { user: U(u.id) } : {} };
    const r = await putObject(env, o, { actor: personal ? 'learner:' + U(u.id) : 'app', summary: `generated ${kind}${review_status === 'validated' ? ', validated' : ', ' + review_status}`, audited: !K.pool });
    const last = await env.DB.prepare('SELECT content FROM mk_asset_store WHERE asset_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(id).first();
    if (!last || last.content !== text)
      await env.DB.prepare('INSERT OR REPLACE INTO mk_asset_store (asset_id, version, content, bytes, at) VALUES (?, ?, ?, ?, ?)').bind(id, r.version, text, text.length, nowIso()).run();
    const who = personal ? String(u.id) : 'central', at = nowIso(), item = o.store.item_id;
    const links = [...concepts.map((c) => [c, 'teaches']), ...cites.map((c) => [c, 'cites']), ...Object.keys(basis.recs).map((c) => [c, 'cites'])];
    await env.DB.batch([env.DB.prepare('DELETE FROM mk_asset_links WHERE asset_id = ?').bind(id),
      ...links.map(([obj, rel]) => env.DB.prepare('INSERT OR IGNORE INTO mk_asset_links (asset_id, user_id, path, item, object_id, rel, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, who, 'mkos', item, obj, rel, at))]);
    if (!personal) await served(env, u.id, kind, [id]);
    out.push({ id, version: r.version, review_status, changed: r.changed, older_citations: cc.older || 0 });
  }
  return { stored: out, current_with: currentWith(ctx) };
}

/* asset_flag {id, reason}: a learner reports a problem. One flag stops reuse until the owner reviews it. */
export async function flagAsset(env, u, a, owner) {
  const id = String(a.id || '');
  if (!/^ea\./.test(id) || (id.startsWith('ea.u') && !id.startsWith('ea.' + U(u.id) + '.'))) return { error: 'not found' };
  const o = await getObject(env, id); if (!o || o.type !== 'EducationalAsset') return { error: 'not found' };
  const note = String(a.reason || '').replace(/\s+/g, ' ').slice(0, 500);
  const flags = [...((o.data && o.data.flags) || []), { by: owner ? 'owner' : U(u.id), at: nowIso(), note }].slice(-20);
  await putObject(env, { ...o, needs: [...new Set([...(o.needs || []), 'review'])], review_status: 'flagged', data: { ...(o.data || {}), flags } }, { actor: owner ? 'owner' : 'learner:' + U(u.id), summary: 'flagged: ' + (note || 'no reason given') });
  return { ok: true, id };
}

/* asset_review {id, result: ok | regenerate | retire, note} (owner): clear a flag, send the asset back for regeneration, or retire it. */
export async function reviewAsset(env, u, a) {
  const id = String(a.id || ''), o = await getObject(env, id); if (!o || o.type !== 'EducationalAsset') return { error: 'not found' };
  const actor = 'owner:' + u.email, note = String(a.note || '').slice(0, 500);
  if (a.result === 'retire') return setStatus(env, id, 'retired', { actor, reason: note || 'retired at review', force: true });
  if (a.result === 'regenerate') { await putObject(env, { ...o, needs: ['regenerate'], review_status: 'needs_regenerate' }, { actor, summary: 'sent for regeneration' + (note ? ': ' + note : '') }); return { ok: true }; }
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
