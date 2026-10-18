// The app bridge: what the app's screens read from MKOS, in one call per screen, computed from structure with no AI.
//   appBundle     Today / Progress / Boards / Cards / Questions: learner model, plan, board plan, topic priorities, flags, pronunciations
//   topicContext  the governed package for one curriculum topic, including a prompt block the app hands to its AI (AI as teacher only)
//   checkCitations  citations as written -> current / older edition / unmatched (Superseded Guideline Usage, stop-the-line)
//   assetFlags    this learner's lessons, questions and cards that MKOS has flagged for review or regeneration
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObject, getObjects, norm } from './kb.js';
import { resolveName, AUTO, matchCitation } from './resolve.js';
import { orgsOf, topicWords } from './ingest.js';
import { nodeForTopic } from './education.js';
import { conceptContext, curriculumPlan } from './adaptive.js';
import { selection, select, boardPlan, scoresFor } from './blueprint.js';
import { ttsList } from './pronounce.js';

const U = (uid) => 'u' + String(uid).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase();
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));

// Per app topic id: [board priority, question, flashcard, lesson, recommendation] scores for the learner's selected blueprint.
async function topicPriorities(env, uid, bpId) {
  if (!bpId) return {};
  const { results } = await env.DB.prepare(`SELECT json_extract(n.body, '$.legacy_topic_id') AS tid, n.id AS nid, MAX(m.priority_score) AS p, MAX(m.frequency_score) AS f, MAX(m.relevance_score) AS i
    FROM mk_objects n, json_each(n.body, '$.concepts') c JOIN mk_blueprint_concept_mappings m ON m.concept_id = c.value AND m.blueprint_id = ?
    WHERE n.type = 'CurriculumNode' AND n.id LIKE 'cn.t.%' GROUP BY n.id`).bind(bpId).all();
  const st = Object.fromEntries((await env.DB.prepare("SELECT object_id, body FROM mk_learner WHERE user_id = ? AND level = 'curriculum_node'").bind(uid).all()).results.map((r) => [r.object_id, J(r.body)]));
  const out = {};
  for (const r of results) { const s = scoresFor({ frequency_score: r.f, importance_score: r.i, relevance_score: r.i, priority_score: r.p }, st[r.nid]); out[r.tid] = [s.board_priority, s.question, s.flashcard, s.lesson, s.recommendation, Math.round(r.p)]; }
  return out;
}

export async function assetFlags(env, u) {
  const { results } = await env.DB.prepare("SELECT body FROM mk_objects WHERE id LIKE ? AND json_array_length(COALESCE(json_extract(body, '$.needs'), '[]')) > 0").bind('ea.' + U(u.id) + '.%').all();
  const out = {}; for (const r of results) { const o = J(r.body); out[o.store?.item_id || o.id] = { needs: o.needs, status: o.review_status, kind: o.asset_kind, path: o.store?.path }; }
  // Shared library assets this learner was served that are now flagged (a guideline changed, or someone reported a problem).
  const sh = await env.DB.prepare("SELECT o.body FROM mk_asset_usage g JOIN mk_objects o ON o.id = g.asset_id WHERE g.user_id = ? AND json_array_length(COALESCE(json_extract(o.body, '$.needs'), '[]')) > 0 LIMIT 300").bind(String(u.id)).all().catch(() => ({ results: [] }));
  for (const r of sh.results) { const o = J(r.body); out[o.id] = { needs: o.needs, status: o.review_status, kind: o.asset_kind, path: 'mkos' }; }
  return { flags: out };
}

// The shared educational asset library at a glance, and how much of this learner's material came from it (retrieve-first progress).
async function assetSummary(env, u) {
  const lib = (await env.DB.prepare("SELECT json_extract(body, '$.asset_kind') AS k, COUNT(*) AS n FROM mk_objects WHERE type = 'EducationalAsset' AND id LIKE 'ea.s.%' AND status = 'current' AND json_extract(body, '$.review_status') = 'validated' GROUP BY k").all().catch(() => ({ results: [] }))).results;
  const mine = (await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM mk_asset_usage WHERE user_id = ? GROUP BY kind').bind(String(u.id)).all().catch(() => ({ results: [] }))).results;
  return { library: Object.fromEntries(lib.map((r) => [r.k, r.n])), served: Object.fromEntries(mine.map((r) => [r.kind, r.n])) };
}

export async function appBundle(env, u, { owner = false, app_kind = null } = {}) {
  let sel = await selection(env, u.id);
  if (app_kind) { const fam = (FRAMEWORK.frameworks.blueprints.families.find((f) => f.app_kind === app_kind) || {}).id; if (fam && (fam !== sel.family || sel.source === 'default')) { await select(env, u.id, { app_kind, source: 'app' }); sel = await selection(env, u.id); } }
  const lv = async (level, limit = 40, order = 'priority DESC') => (await env.DB.prepare(`SELECT object_id, mastery, conf, priority, body FROM mk_learner WHERE user_id = ? AND level = ? ORDER BY ${order} LIMIT ?`).bind(u.id, level, limit).all()).results.map((r) => { const b = J(r.body, {}); return { id: r.object_id, mastery: r.mastery, confidence: r.conf, priority: r.priority, retention: b.retention || null, interactions: b.interactions || 0, state: b.knowledge_state, calibration: b.calibration || null }; });
  const [specialty, competency, domain, concept] = [await lv('specialty', 30), await lv('competency', 12), await lv('domain', 15), await lv('concept', 400)];
  const names = await getObjects(env, [...specialty, ...competency, ...domain].map((x) => x.id));
  for (const x of [...specialty, ...competency, ...domain]) x.name = names[x.id]?.name || x.id;
  const mis = (await env.DB.prepare("SELECT object_id, kind, n, last_seen FROM mk_misconceptions WHERE user_id = ? AND status != 'resolved' ORDER BY n DESC LIMIT 10").bind(u.id).all()).results;
  const rec = (await env.DB.prepare("SELECT object_id, reason, at FROM mk_reconcile WHERE user_id = ? AND state = 'open' ORDER BY at DESC LIMIT 10").bind(u.id).all()).results;
  const mn = await getObjects(env, [...mis.map((m) => m.object_id), ...rec.map((r) => r.object_id)]);
  const avg = (k) => concept.length ? clamp(concept.reduce((a, x) => a + (x[k] || 0), 0) / concept.length) : null;
  const due = concept.filter((x) => x.retention && x.retention.next_review && x.retention.next_review <= nowIso().slice(0, 10)).length;
  const events = (await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_learner_events WHERE user_id = ? AND at >= ?').bind(u.id, new Date(Date.now() - 7 * 864e5).toISOString()).first()) || { n: 0 };
  const kn = Object.fromEntries((await env.DB.prepare("SELECT type, COUNT(*) AS n FROM mk_objects WHERE status IN ('current','modified') AND id NOT LIKE 'ea.u%' GROUP BY type").all()).results.map((r) => [r.type, r.n]));
  const ingest = Object.fromEntries((await env.DB.prepare("SELECT json_extract(body, '$.ingest_state') AS s, COUNT(*) AS n FROM mk_objects WHERE type = 'Source' GROUP BY s").all()).results.map((r) => [r.s, r.n]));
  return {
    at: nowIso(), owner, selection: sel,
    summary: { mastery: avg('mastery'), confidence: avg('confidence'), concepts_with_evidence: concept.length, review_burden: concept.filter((x) => (x.retention?.forgetting_risk || 0) >= 40).length, due_reviews: due, learning_events_7d: events.n,
      calibration: concept.reduce((a, x) => { const c = x.calibration || {}; for (const k of Object.keys(c)) a[k] = (a[k] || 0) + c[k]; return a; }, {}) },
    specialty, competency, domain,
    misconceptions: mis.map((m) => ({ ...m, name: mn[m.object_id]?.name || m.object_id })), changed_knowledge: rec.map((r) => ({ ...r, name: mn[r.object_id]?.name || r.object_id })),
    plan: (await curriculumPlan(env, u.id, { limit: 8, exam: sel.family === 'abim_im_lka' ? 'lka' : 'cert' })).plan,
    board: await boardPlan(env, u.id, { limit: 8 }).catch((e) => ({ error: String(e.message || e) })),
    topics: await topicPriorities(env, u.id, sel.blueprint_id),
    flags: (await assetFlags(env, u)).flags, pronunciations: await ttsList(env),
    knowledge: { objects: kn, sources: ingest },
    assets: await assetSummary(env, u),
  };
}

// Guideline families that speak to a topic: by its concepts' recommendations, else by topic words in the family name/topic key.
async function familiesFor(env, words) {
  const ws = words.filter((w) => w.length >= 5).slice(0, 6); if (!ws.length) return [];
  const { results } = await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'Guideline' AND (${ws.map(() => "(json_extract(body, '$.topic_key') LIKE ? OR lower(name) LIKE ?)").join(' OR ')}) LIMIT 8`).bind(...ws.flatMap((w) => ['%' + w + '%', '%' + w + '%'])).all();
  const fams = results.map((r) => J(r.body)), eds = await getObjects(env, fams.flatMap((f) => f.editions || []));
  const lab = (s) => s ? `${s.short_label || s.name}${s.citation ? ' (' + s.citation + ')' : ''}` : '';
  return fams.map((f) => ({ family: f.id, name: f.name, current: lab(eds[f.current_edition]), current_id: f.current_edition, current_year: eds[f.current_edition]?.year || null,
    superseded: (f.editions || []).map((id) => eds[id]).filter((s) => s && (s.status === 'superseded' || s.status === 'modified')).map((s) => ({ label: lab(s), status: s.status, year: s.year })) }));
}

export async function topicContext(env, u, tid, { name = '' } = {}) {
  const node = tid ? await getObject(env, nodeForTopic(tid)) : null;
  let cid = (node && (node.concepts || [])[0]) || null;
  if (!cid && (name || node)) { const r = await resolveName(env, name || node.name, { types: ['Concept'] }); if (r.id && r.confidence >= AUTO) cid = r.id; }
  const ctx = cid ? await conceptContext(env, cid, { limit: 12 }) : null;
  const label = (node && node.name) || name || (ctx && ctx.concept.name) || tid;
  const fams = await familiesFor(env, topicWords(label + ' ' + (ctx ? ctx.concept.name : '')));
  const sel = await selection(env, u.id);
  const bp = sel.blueprint_id && cid ? await env.DB.prepare('SELECT * FROM mk_blueprint_concept_mappings WHERE blueprint_id = ? AND concept_id = ?').bind(sel.blueprint_id, cid).first() : null;
  const st = node ? J((await env.DB.prepare('SELECT body FROM mk_learner WHERE user_id = ? AND object_id = ?').bind(u.id, node.id).first() || {}).body, null) : null;
  const scores = scoresFor(bp, st);
  const words = [...new Set(norm(label + ' ' + (ctx ? ctx.recommendations.map((r) => r.statement).join(' ') : '')).split(' ').filter((w) => w.length >= 6))].slice(0, 80);
  const prons = words.length ? (await env.DB.prepare(`SELECT json_extract(body, '$.term') AS w, json_extract(body, '$.simplified') AS s, json_extract(body, '$.speak') AS speak FROM mk_objects WHERE type = 'Pronunciation' AND json_extract(body, '$.term') IN (${words.map(() => '?').join(',')})`).bind(...words).all()).results : [];
  const assets = node ? (await env.DB.prepare("SELECT DISTINCT asset_id, path, item FROM mk_asset_links WHERE user_id = ? AND object_id = ? AND rel = 'teaches' LIMIT 40").bind(u.id, node.id).all()).results : [];
  const recs = ctx ? ctx.recommendations : [];
  const lines = [];
  lines.push(`MKOS KNOWLEDGE for "${label}" (the app's governed knowledge base; prefer it over memory, and cite only current editions):`);
  for (const f of fams) { lines.push(`- Current guideline in the library: ${f.current}.`); for (const s of f.superseded) lines.push(`  - ${s.status === 'modified' ? 'Partly updated by a newer edition (use only for issues the update does not cover)' : 'Superseded, do not cite as current'}: ${s.label}.`); }
  for (const r of recs.slice(0, 10)) lines.push(`- [${r.strength_original || r.strength} / LOE ${r.loe_original || r.evidence_level}] ${r.statement} (${r.cite ? r.cite.label : 'source'}${r.governance === 'pending_validation' ? ', extracted, pending validation' : ''})`);
  if (!recs.length && !fams.length) lines.push('- No extracted recommendations or matching guideline families yet; rely on the reference text and current major-society guidance, and list anything to verify.');
  if (bp) lines.push(`- Board weighting (${sel.family}): priority ${Math.round(bp.priority_score)}/100, frequency ${Math.round(bp.frequency_score)}/100.`);
  // A shared educational asset is written from everything above but not from one learner's state (assets.json shared_prompt_excludes_learner_state).
  const shared = lines.slice();
  if (st) lines.push(`- This learner: mastery ${Math.round(st.mastery)}/100, system confidence ${Math.round(st.confidence)}/100, state ${st.knowledge_state}${st.calibration && st.calibration.incorrect_confident ? ', has been wrong while confident here (address the misconception)' : ''}.`);
  return { tid, node: node ? { id: node.id, name: node.name, concepts: node.concepts || [] } : null, concept: ctx ? ctx.concept : null, recommendations: recs, guidelines: fams, related: ctx ? ctx.related : [],
    blueprint: { selection: sel, mapping: bp }, learner: st, scores, pronunciations: prons, existing_assets: assets, stop_the_line: ctx ? ctx.stop_the_line : [],
    prompt_block: lines.join('\n'), prompt_block_shared: shared.join('\n'), route: recs.length ? 'graph' : fams.length ? 'registry' : cid ? 'database' : 'ai' };
}

export async function checkCitations(env, citations) {
  const fams = (await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Guideline'").all()).results.map((r) => J(r.body));
  const eds = Object.fromEntries((await env.DB.prepare("SELECT id, body FROM mk_objects WHERE type = 'Source' AND json_extract(body, '$.guideline_family') IS NOT NULL").all()).results.map((r) => [r.id, J(r.body)]));
  const out = [];
  for (const c of citations) {
    const t = String(c || '').slice(0, 400); if (!t) continue;
    const m = matchCitation(t, fams, eds, { orgsOf, topicWords });
    const cur = m.current_edition ? eds[m.current_edition] : null;
    out.push({ citation: t, status: m.status, family: m.family_name || null, cited_year: m.cited_year || null, current_year: m.current_year || null, current: cur ? (cur.short_label || cur.name) + (cur.citation ? ' (' + cur.citation + ')' : '') : null });
  }
  return { results: out, older: out.filter((x) => x.status === 'older_edition').length };
}
