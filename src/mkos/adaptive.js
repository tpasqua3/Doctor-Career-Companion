// Adaptive Learning Layer (ADAPTIVE CURRICULUM MODEL) and the Routing Layer (ROUTING MODEL + DETERMINISTIC-FIRST RULE).
// Both read structure; neither calls an AI. AI is the last route and receives a governed context package, never authority.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, fwGet, overrides } from './db.js';
import { getObject, getObjects, query, norm } from './kb.js';
import { neighbors } from './graph.js';
import { resolveName, AUTO } from './resolve.js';

const F = FRAMEWORK.frameworks;

/* What To Teach / Review / Assess / Reinforce / Remediate / Prioritize / Delay, for one learner, from learner state + board relevance +
   open reconciliation items (knowledge that changed under them) + misconceptions. Deterministic. */
export async function curriculumPlan(env, uid, { limit = 12, exam = 'lka' } = {}) {
  const o = await overrides(env), low = fwGet('scoring.low_confidence.threshold', o);
  const states = (await env.DB.prepare("SELECT object_id, mastery, conf, priority, body FROM mk_learner WHERE user_id = ? AND level IN ('concept','blueprint_topic')").bind(uid).all()).results.map((r) => ({ ...J(r.body, {}), object_id: r.object_id }));
  const seen = new Set(states.map((s) => s.object_id));
  // Missing concepts: highest-weight blueprint topics the learner has no state for.
  const missing = (await env.DB.prepare(`SELECT id, name, json_extract(body, '$.est_pct') AS w, json_extract(body, '$.tier') AS tier FROM mk_objects WHERE type = 'BlueprintTopic' AND status = 'current' AND id LIKE ?
    ORDER BY w DESC LIMIT 200`).bind('bpt.' + exam + '.%').all()).results.filter((r) => !seen.has(r.id) && r.tier !== 'excluded').slice(0, limit);
  const mis = (await env.DB.prepare("SELECT object_id, kind, n, body FROM mk_misconceptions WHERE user_id = ? AND status != 'resolved' ORDER BY n DESC LIMIT ?").bind(uid, limit).all()).results;
  const rec = (await env.DB.prepare("SELECT object_id, event_id, reason FROM mk_reconcile WHERE user_id = ? AND state = 'open' LIMIT ?").bind(uid, limit).all()).results;
  const by = (f, s = (a, b) => b.priority - a.priority) => states.filter(f).sort(s).slice(0, limit);
  const plan = {
    teach: missing.map((m) => ({ object_id: m.id, name: m.name, why: `not yet studied; ${Number(m.w || 0).toFixed(2)}% of the exam (est.)` })),
    review: by((s) => (s.retention?.forgetting_risk || 0) >= 40 && s.mastery >= 50).map((s) => ({ object_id: s.object_id, why: `retention falling (risk ${s.retention.forgetting_risk})`, next_review: s.retention.next_review })),
    assess: by((s) => s.confidence < low).map((s) => ({ object_id: s.object_id, why: `system confidence ${s.confidence} (${s.interactions} interactions): needs more evidence` })),
    reinforce: by((s) => s.mastery >= 50 && s.mastery < 75 && s.confidence >= low).map((s) => ({ object_id: s.object_id, why: `mastery ${s.mastery}` })),
    remediate: [...mis.map((m) => ({ object_id: m.object_id, why: `incorrect while confident x${m.n} (${m.kind})` })), ...rec.map((r) => ({ object_id: r.object_id, why: `knowledge changed (${r.reason}); review the update`, event_id: r.event_id }))],
    prioritize: by(() => true).map((s) => ({ object_id: s.object_id, priority: s.priority, mastery: s.mastery, confidence: s.confidence })),
    delay: by((s) => s.mastery >= 85 && s.confidence >= 70, (a, b) => b.mastery - a.mastery).map((s) => ({ object_id: s.object_id, why: `mastered (${s.mastery}, confidence ${s.confidence})` })),
  };
  const names = await getObjects(env, [...new Set(Object.values(plan).flat().map((x) => x.object_id))]);
  // One line per subject: a concept and the blueprint topics that name it are the same thing to the learner.
  for (const [k, list] of Object.entries(plan)) { const seen = new Set(); plan[k] = list.map((x) => ({ ...x, name: x.name || names[x.object_id]?.name || x.object_id })).filter((x) => { const n = String(x.name).toLowerCase(); if (seen.has(n)) return false; seen.add(n); return true; }); }
  return { generated: nowIso(), engine: 'curriculum', version: F.scoring.version, confidence_note: 'Priorities weigh deficit, retention risk, board relevance, competency importance and low system confidence (scoring.learner.curriculum_priority_weights).', plan };
}

/* The governed context package for one concept: everything the AI Teaching Engine may use, already prioritized.
   Current recommendations from the highest-authority current sources first; superseded ones only with include_history; pediatric-only
   recommendations excluded from adult curriculum. Every item carries its citation (Provenance Is Mandatory). */
export async function conceptContext(env, conceptId, { include_history = false, limit = 25 } = {}) {
  const c = await getObject(env, conceptId); if (!c) return null;
  const nb = await neighbors(env, conceptId, { include_history, limit: 600 });
  const ids = [...new Set(nb.map((n) => n.id))], objs = await getObjects(env, ids);
  const recs = Object.values(objs).filter((o) => o.type === 'Recommendation' && (include_history || ['current', 'modified'].includes(o.status)) && o.adult_scope !== false && o.governance_status !== 'rejected' && o.governance_status !== 'stopped');
  const srcs = await getObjects(env, [...new Set(recs.map((r) => r.source_id))]);
  const rank = (r) => (r.status === 'current' ? 0 : r.status === 'modified' ? 1 : 2) * 1000 - (r.scores?.trust_score || 0);
  recs.sort((a, b) => rank(a) - rank(b));
  const cite = (s) => s ? { source_id: s.id, label: s.short_label || s.title, citation: s.citation || '', doi: s.doi || '', orgs: s.responsible_orgs || [], year: s.year || null, status: s.status, ref_id: s.registry_ref_id || '' } : null;
  const stop = [];
  for (const r of recs) { const s = srcs[r.source_id]; if (!s) stop.push({ condition: 'missing_provenance', object: r.id }); else if (s.status === 'superseded' && r.status === 'current') stop.push({ condition: 'superseded_guideline_usage', object: r.id }); }
  return {
    concept: { id: c.id, name: c.name, type: c.concept_type, aliases: c.aliases || [], board: c.board || {}, facets: c.facets || {}, confidence: c.confidence },
    recommendations: recs.slice(0, limit).map((r) => ({ id: r.id, statement: r.statement, strength: r.strength, strength_original: r.strength_original, evidence_level: r.evidence_level, loe_original: r.loe_original,
      status: r.status, governance: r.governance_status, trust: r.scores?.trust_score, confidence: r.confidence?.confidence_score, section: r.section, page: r.page, cite: cite(srcs[r.source_id]) })),
    related: nb.filter((n) => objs[n.id] && objs[n.id].type === 'Concept').slice(0, 40).map((n) => ({ id: n.id, rel: n.rel, name: objs[n.id].name })),
    blueprint: nb.filter((n) => objs[n.id] && objs[n.id].type === 'BlueprintTopic').map((n) => ({ id: n.id, name: objs[n.id].name, est_pct: objs[n.id].est_pct, tier: objs[n.id].tier, importance: objs[n.id].importance })),
    sources_covering: nb.filter((n) => objs[n.id] && objs[n.id].type === 'Source' && n.rel === 'covered_by').map((n) => cite(objs[n.id])).filter(Boolean).slice(0, 20),
    stop_the_line: stop,
    handoff: { engine: 'knowledge', timestamp: nowIso(), version: c.version, confidence_score: Math.min(c.confidence?.confidence_score ?? 50, ...recs.slice(0, 5).map((r) => r.confidence?.confidence_score ?? 50)),
      validation_status: stop.length ? 'stopped' : 'ok', governance_status: stop.length ? 'stopped' : c.governance_status, provenance_bundle: recs.slice(0, limit).map((r) => r.source_id) },
  };
}

/* ROUTING: answer a knowledge request with the lowest-cost authoritative layer that can. Records the decision (Routing Confidence). */
export async function routeRequest(env, uid, text, { include_history = false } = {}) {
  const steps = [];
  // Database: is it a known object (concept, guideline, source by name, ref_id or DOI)?
  const r = await resolveName(env, text, { types: ['Concept', 'Guideline', 'Source', 'BlueprintTopic'] });
  steps.push({ layer: 'database', hit: !!r.id, confidence: r.confidence });
  let decision = 'ai', payload = null, conf = 0, reasoning = '';
  if (r.id && r.confidence >= AUTO) {
    const o = await getObject(env, r.id);
    if (o.type === 'Concept') {
      const ctx = await conceptContext(env, o.id, { include_history });
      steps.push({ layer: 'graph', recommendations: ctx.recommendations.length });
      decision = ctx.recommendations.length ? 'graph' : 'database'; payload = ctx; conf = ctx.handoff.confidence_score;
      reasoning = ctx.recommendations.length ? 'Concept resolved; current recommendations available from the graph.' : 'Concept resolved; no extracted recommendations yet, facets and board mapping returned.';
    } else { decision = 'database'; payload = o; conf = (o.confidence?.confidence_score ?? 60); reasoning = `Resolved to ${o.type} ${o.id}.`; }
  } else {
    // Assets: an existing educational asset on a candidate concept beats generating a new one.
    const cands = (r.candidates || []).slice(0, 3);
    if (cands.length) {
      const { results } = await env.DB.prepare(`SELECT asset_id, path, item FROM mk_asset_links WHERE user_id = ? AND object_id IN (${cands.map(() => '?').join(',')}) LIMIT 5`).bind(uid || '', ...cands.map((c) => c.id)).all();
      steps.push({ layer: 'assets', hits: results.length });
      if (results.length) { decision = 'assets'; payload = { assets: results, candidates: cands }; conf = 55; reasoning = 'No confident concept match; existing assets on the nearest concepts.'; }
    }
    if (decision === 'ai') { payload = { candidates: cands, note: 'No authoritative structure matched; AI may teach or explain but may not create authority (AI governance).' }; conf = 30; reasoning = 'Nothing in the database, rules, graph or assets solved it.'; }
  }
  const alternatives = steps.filter((s) => s.layer !== decision).map((s) => s.layer);
  await env.DB.prepare('INSERT INTO mk_routes (at, user_id, request, decision, conf, body) VALUES (?, ?, ?, ?, ?, ?)').bind(nowIso(), uid || null, String(text).slice(0, 300), decision, conf, JSON.stringify({ steps, alternatives, reasoning })).run();
  return { decision, confidence: conf, reasoning, alternatives, signals: steps, result: payload };
}
