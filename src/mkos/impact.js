// AUTOMATIC IMPACT ANALYSIS and LEARNER STATE RECONCILIATION: from a changed object, find exactly what it touches, and update only that.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObjects, putObject } from './kb.js';
import { reach } from './graph.js';

const KIND = { Concept: 'concepts', Recommendation: 'recommendations', Guideline: 'guidelines', EducationalAsset: 'educational_assets', EducationalObject: 'educational_objects',
  CurriculumNode: 'curricula', BlueprintTopic: 'blueprint', Objective: 'objectives', EvidenceObject: 'evidence', Source: 'sources', Claim: 'claims' };

/* Determine impact of a change to `subject` for change event `eventId`. Writes the impact onto the event, flags affected assets
   (needs: review|regenerate), opens learner reconciliation rows, and returns the summary. Bounded: depth 2, 2000 objects. */
export async function analyzeImpact(env, eventId, subject, { actor = 'impact' } = {}) {
  const ev = await env.DB.prepare('SELECT * FROM mk_events WHERE id = ?').bind(eventId).first();
  const hit = await reach(env, [subject], { depth: 2, seedAll: true });
  const ids = [...hit.keys()];
  const objs = await getObjects(env, ids);
  const by = {}; for (const o of Object.values(objs)) (by[KIND[o.type] || o.type] = by[KIND[o.type] || o.type] || []).push(o.id);
  const subj = objs[subject];
  const superseded = subj && (subj.status === 'superseded' || subj.status === 'retired');
  // Assets stored outside MKOS (learner record documents) that cite or teach anything affected.
  const assets = [];
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80), { results } = await env.DB.prepare(`SELECT DISTINCT asset_id, user_id, path, item, rel FROM mk_asset_links WHERE object_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    assets.push(...results);
  }
  for (const a of [...new Set(assets.map((x) => x.asset_id))]) {
    const cur = (await getObjects(env, [a]))[a]; if (!cur) continue;
    const need = superseded && assets.some((x) => x.asset_id === a && x.rel === 'cites') ? 'regenerate' : 'review';
    if (!(cur.needs || []).includes(need)) await putObject(env, { ...cur, needs: [...new Set([...(cur.needs || []), need])], review_status: 'needs_' + need }, { actor, event_id: eventId, summary: `flagged ${need}: ${subject} changed`, audited: false });
  }
  // Learner states on affected concepts / blueprint topics / curriculum nodes.
  const learnerObjs = [...(by.concepts || []), ...(by.blueprint || []), ...(by.curricula || [])];
  let learners = 0;
  for (let i = 0; i < learnerObjs.length; i += 80) {
    const part = learnerObjs.slice(i, i + 80), { results } = await env.DB.prepare(`SELECT user_id, object_id FROM mk_learner WHERE object_id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const r of results) { await env.DB.prepare('INSERT OR IGNORE INTO mk_reconcile (user_id, object_id, event_id, reason, state, at) VALUES (?, ?, ?, ?, \'open\', ?)').bind(r.user_id, r.object_id, eventId, (ev && ev.kind) || 'knowledge_changed', nowIso()).run(); learners++; }
  }
  const impact = {
    what_changed: [subject], what_did_not_change: ['everything outside the depth-2 neighborhood of ' + subject],
    superseded: superseded ? [subject] : [], recalculate: [...(by.recommendations || []), ...(by.concepts || [])].slice(0, 500),
    regenerate: assets.filter((x) => x.rel === 'cites' && superseded).map((x) => x.asset_id), review: [...new Set(assets.map((x) => x.asset_id))],
    republish: ['snapshot', 'compat_registry'], counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), learner_states: learners,
    affected_competencies: [...new Set(Object.values(objs).flatMap((o) => o.competencies || []))],
  };
  if (ev) await env.DB.prepare("UPDATE mk_events SET stage = 'impact_determined', impact = ?, updated = ? WHERE id = ?").bind(JSON.stringify(impact).slice(0, 60000), nowIso(), eventId).run();
  return impact;
}

// Re-score objects whose inputs changed (Update Affected Nodes). Only what impact analysis listed.
export async function rescore(env, ids, { actor = 'rescore', event_id = null } = {}) {
  const objs = await getObjects(env, ids); let n = 0;
  const srcIds = [...new Set(Object.values(objs).map((o) => o.source_id).filter(Boolean))], srcs = await getObjects(env, srcIds);
  for (const o of Object.values(objs)) {
    const src = o.source_id ? srcs[o.source_id] : null;
    // A recommendation from a superseded or retired source follows its source (Preserve Supersession).
    const status = src && (src.status === 'superseded' || src.status === 'retired') && o.status === 'current' ? 'superseded' : o.status;
    const r = await putObject(env, { ...o, status, replaced_by: status !== o.status ? src.replaced_by || null : o.replaced_by }, { actor, event_id, srcScores: src ? src.scores : null, summary: 'rescored after upstream change', audited: false, rescore: true });
    if (r.changed || r.rescored) n++;
  }
  return n;
}
