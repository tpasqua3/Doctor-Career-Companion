// The app bridge: what the app's screens read from MKOS, in one call per screen, computed from structure with no AI.
//   appBundle     Today / Progress / Boards / Cards / Questions: learner model, plan, board plan, topic priorities, flags, pronunciations
//   topicContext  the governed package for one curriculum topic, including a prompt block the app hands to its AI (AI as teacher only)
//   checkCitations  citations as written -> current / older edition / unmatched (Superseded Guideline Usage, stop-the-line)
//   assetFlags    this learner's lessons, questions and cards that MKOS has flagged for review or regeneration
import { progress } from './progress.js';
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
    registry: await sourceRegistry(env),
    // The owner sees the knowledge build's progress on the MKOS card (progress.js).
    build: owner ? await progress(env).catch(() => null) : null,
  };
}

// The library's sources registry as the app reads it (drive file id -> label, citation, DOI, organisations, status, year): one shared
// registry in MKOS instead of a copy cached in every account (the app keeps only entries for files MKOS does not know).
async function sourceRegistry(env) {
  const { results } = await env.DB.prepare("SELECT body FROM mk_objects WHERE type = 'Source' AND json_extract(body, '$.drive_file_id') IS NOT NULL").all().catch(() => ({ results: [] }));
  const out = {};
  for (const r of results) { const x = J(r.body); if (!x || !x.drive_file_id) continue;
    out[x.drive_file_id] = { l: String(x.short_label || x.title || x.name || '').slice(0, 90), c: String(x.citation || '').slice(0, 120), d: String(x.doi || '').slice(0, 80), o: (x.responsible_orgs || []).map(String).slice(0, 5).join('/'),
      s: x.status === 'superseded' || x.status === 'withdrawn' ? x.status : 'active', y: x.year ? String(x.year) : '' }; }
  return out;
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

// Decomposed knowledge for a set of concepts: what teaches, assesses or covers them, and the criteria parsed from their recommendations.
export async function topicKnowledge(env, concepts) {
  const out = { high_yield: [], common_errors: [], pearls: [], objectives: [], criteria: [], targets: [], references: [], counts: {} };
  const cs = [...new Set(concepts)].filter(Boolean).slice(0, 20); if (!cs.length) return out;
  const q = cs.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT o.body FROM mk_objects o WHERE o.id IN (SELECT src FROM mk_edges WHERE dst IN (${q}) AND rel IN ('covers','teaches','assesses') AND status = 'current' AND (src LIKE 'eo.%' OR src LIKE 'obj.%'))
    AND o.status = 'current' ORDER BY o.trust DESC LIMIT 160`).bind(...cs).all().catch(() => ({ results: [] }));
  for (const r of results) { const o = J(r.body); if (!o || o.empty || (o.edu_kind === 'clinical_pearl' && (o.needs || []).length)) continue; const x = { id: o.id, statement: o.statement || o.name, difficulty: o.difficulty ?? null, targets: o.targets || [], governance: o.governance_status };
    out.counts[o.edu_kind || o.objective_type] = (out.counts[o.edu_kind || o.objective_type] || 0) + 1;
    if (o.edu_kind === 'high_yield') out.high_yield.push(x); else if (o.edu_kind === 'common_error') out.common_errors.push(x); else if (o.edu_kind === 'clinical_pearl') out.pearls.push(x);
    else if (o.type === 'Objective' && o.objective_type !== 'assessment' && o.objective_type !== 'board') out.objectives.push(x); else if (/_target$/.test(o.edu_kind || '')) out.targets.push(x); }
  const cl = await env.DB.prepare(`SELECT body FROM mk_objects WHERE type = 'Claim' AND status = 'current' AND json_extract(body, '$.concept') IN (${q}) AND json_extract(body, '$.claim_kind') IN ('contraindication','not_recommended','monitoring','threshold','exception') LIMIT 40`).bind(...cs).all().catch(() => ({ results: [] }));
  for (const r of cl.results) { const o = J(r.body); if (o) out.criteria.push({ id: o.id, kind: o.claim_kind, statement: o.statement, values: o.values || [] }); }
  // Where the indexed textbooks and educational sources treat these concepts: chapter and section references (headings and pages only).
  const ss = await env.DB.prepare(`SELECT s.id, s.name, json_extract(s.body, '$.page') AS page, json_extract(s.body, '$.section_kind') AS kind, src.name AS source, src.id AS source_id, MAX(e.conf) AS conf
    FROM mk_edges e JOIN mk_objects s ON s.id = e.src JOIN mk_objects src ON src.id = json_extract(s.body, '$.source_id')
    WHERE e.dst IN (${q}) AND e.rel = 'covers' AND e.status = 'current' AND e.src LIKE 'ss.%' AND s.status = 'current' GROUP BY s.id ORDER BY conf DESC, s.trust DESC LIMIT 12`).bind(...cs).all().catch(() => ({ results: [] }));
  out.references = ss.results.map((r) => ({ id: r.id, source: r.source, source_id: r.source_id, heading: r.name, kind: r.kind, page: r.page }));
  return out;
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
  // The topic's decomposed knowledge (decompose.js): high-yield points, common errors, criteria, objectives, and AI pearls (unvalidated).
  const dk = await topicKnowledge(env, [...(node ? (node.concepts || []).length ? node.concepts : cid ? [cid] : [] : cid ? [cid] : []), ...(node ? [node.id] : [])]);
  if (dk.high_yield.length) lines.push('- High-yield (teach these): ' + dk.high_yield.slice(0, 5).map((x) => x.statement.replace(/^High-yield:\s*/, '')).join(' | '));
  if (dk.common_errors.length) lines.push('- Common errors to address: ' + dk.common_errors.slice(0, 4).map((x) => x.statement.replace(/^Common error to avoid \(acting against this recommendation\):\s*/, '')).join(' | '));
  if (dk.criteria.length) lines.push('- Criteria: ' + dk.criteria.slice(0, 6).map((x) => `${x.kind}: ${x.values && x.values.length ? x.values.join(', ') + ' (' + x.statement.slice(0, 160) + ')' : x.statement.slice(0, 200)}`).join(' | '));
  if (dk.objectives.length) lines.push('- Objectives this material should meet: ' + dk.objectives.slice(0, 5).map((x) => x.statement.slice(0, 220)).join(' | '));
  { const pv = dk.pearls.filter((x) => x.governance === 'validated'), pu = dk.pearls.filter((x) => x.governance !== 'validated');
    if (pv.length) lines.push('- Clinical pearls (validated): ' + pv.slice(0, 3).map((x) => x.statement).join(' | '));
    if (pu.length) lines.push('- Clinical pearls (AI-suggested, not yet validated; use only where they agree with the recommendations above): ' + pu.slice(0, 3).map((x) => x.statement).join(' | ')); }
  if (dk.references.length) lines.push('- Where the library\'s textbooks and educational sources treat this (cite by source and chapter; do not quote them): ' + dk.references.slice(0, 6).map((x) => `${x.source}, "${x.heading}"${x.page ? ' (p. ' + x.page + ')' : ''}`).join(' | '));
  // A shared educational asset is written from everything above but not from one learner's state (assets.json shared_prompt_excludes_learner_state).
  const shared = lines.slice();
  if (st) lines.push(`- This learner: mastery ${Math.round(st.mastery)}/100, system confidence ${Math.round(st.confidence)}/100, state ${st.knowledge_state}${st.calibration && st.calibration.incorrect_confident ? ', has been wrong while confident here (address the misconception)' : ''}.`);
  return { tid, node: node ? { id: node.id, name: node.name, concepts: node.concepts || [] } : null, concept: ctx ? ctx.concept : null, recommendations: recs, guidelines: fams, related: ctx ? ctx.related : [],
    blueprint: { selection: sel, mapping: bp }, learner: st, scores, pronunciations: prons, existing_assets: assets, stop_the_line: ctx ? ctx.stop_the_line : [], knowledge: dk,
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
