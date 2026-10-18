// CLASSIFICATION AND SUBCLASSIFICATION (mkos/ontology/decomposition.json): every object carries domain, subdomain, specialty, topic,
// subtopic, object type, difficulty, board and educational relevance, evidence strength, authority level, confidence, version and its
// status, supersession, validation and governance state. Classification is derived (like the scores): it is written onto the object
// without making a new content version, and recomputed only for objects that changed since they were last classified.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';
import { getObjects } from './kb.js';

const F = FRAMEWORK.frameworks, CV = F.decomposition.classification.version;
const SPEC = Object.fromEntries(F.specialties.specialties.map((s) => [s.id, s]));
const SCLASS = Object.fromEntries(F.source_classes.classes.map((c) => [c.key, c]));
const STRENGTH = { strong: 90, moderate: 70, weak: 45, against_strong: 85, against_moderate: 65, insufficient: 25, unstated: 30 };
const SUBDOMAIN = { im_subspecialty: 'internal_medicine', im_core: 'internal_medicine', ancillary: 'ancillary_specialties', practice: 'practice_and_quality' };

// Highest board priority of each concept across the current blueprints (0-100).
export async function boardRelevance(env, conceptIds) {
  const out = {}, list = [...new Set(conceptIds.filter(Boolean))];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT m.concept_id AS c, MAX(m.priority_score) AS p FROM mk_blueprint_concept_mappings m JOIN mk_blueprint_registries r ON r.blueprint_id = m.blueprint_id
      WHERE r.current_status = 'current' AND m.concept_id IN (${part.map(() => '?').join(',')}) GROUP BY m.concept_id`).bind(...part).all();
    for (const r of results) out[r.c] = Math.round(r.p || 0);
  }
  return out;
}

const conceptsOf = (o) => o.type === 'Concept' ? [o.id] : [].concat(o.concepts || [], o.teaches || [], o.concept ? [o.concept] : []);
// Recommendation difficulty on the difficulty model (1 Recognition .. 5 Advanced Clinical Reasoning): strong, well-evidenced = recall;
// judgment calls and weak evidence = integration.
export function recDifficulty(r) {
  const s = r.strength || 'unstated', e = r.evidence_level || '';
  if ((s === 'strong' || s === 'against_strong') && /^A|B-R/.test(e)) return 2;
  if (s === 'weak' || /^C/.test(e)) return 4;
  return 3;
}

/* ctx: {board: concept -> relevance, srcs: id -> Source, names: id -> name} (looked up once per batch by classifyBatch). */
export function classifyOne(o, ctx) {
  const cs = conceptsOf(o), board = cs.length ? Math.max(0, ...cs.map((c) => ctx.board[c] ?? 0)) : (o.type === 'BlueprintTopic' ? Math.round(o.importance || o.est_pct || 0) : null);
  const spec = Array.isArray(o.specialty) ? o.specialty[0] || null : o.specialty || null;
  const src = o.type === 'Source' ? o : ctx.srcs[o.source_id] || null;
  const sc = src ? SCLASS[src.source_class] || null : null;
  const strength = o.strength || null;
  const difficulty = Number.isInteger(o.difficulty) ? o.difficulty : o.type === 'Recommendation' ? recDifficulty(o) : null;
  const topic = o.type === 'Concept' ? o.name : o.type === 'Guideline' ? o.name : o.type === 'Source' ? (o.topic_key || o.short_label || o.title || null)
    : o.guideline && ctx.names[o.guideline] ? ctx.names[o.guideline] : cs.length && ctx.names[cs[0]] ? ctx.names[cs[0]] : (o.app_topic || null);
  const subtopic = o.section || o.concept_type || o.objective_type || o.edu_kind || o.claim_kind || o.asset_kind || o.source_class || null;
  const strengthScore = strength ? STRENGTH[strength] ?? 30 : null, auth = sc ? sc.base_authority : o.scores ? o.scores.authority_score : null;
  const edu = board == null && strengthScore == null ? null : Math.round(0.5 * (board || 0) + 0.3 * (strengthScore ?? 40) + 0.2 * (auth ?? 60));
  return { domain: 'medicine', subdomain: spec && SPEC[spec] ? SUBDOMAIN[SPEC[spec].kind] || SPEC[spec].kind || 'internal_medicine' : null, specialty: spec,
    topic: topic ? String(topic).slice(0, 160) : null, subtopic: subtopic ? String(subtopic).slice(0, 160) : null,
    object_type: o.type + (o.concept_type ? ':' + o.concept_type : o.edu_kind ? ':' + o.edu_kind : o.claim_kind ? ':' + o.claim_kind : o.asset_kind ? ':' + o.asset_kind : ''),
    difficulty, board_relevance: board, educational_relevance: edu,
    evidence_strength: o.evidence_level || (o.type === 'EvidenceObject' ? o.evidence_kind || null : null) || (strength ? strength : null),
    authority_level: sc ? sc.authority_tier : null,
    confidence: o.confidence ? o.confidence.confidence_score ?? null : null, version: o.version || null, status: o.status || null,
    supersession_status: o.status === 'superseded' || o.status === 'modified' ? o.status + (o.replaced_by ? ' by ' + o.replaced_by : '') : o.status === 'retired' ? 'retired' : 'current',
    validation_status: o.review_status || (o.governance_status === 'validated' || o.governance_status === 'approved' ? 'validated' : o.governance_status === 'stopped' ? 'stopped' : 'pending'),
    governance_status: o.governance_status || null, v: CV, ov: o.version || null, at: nowIso() };
}

// Classify a set of objects and write the classification onto each (no new content version).
export async function classifyBatch(env, objs) {
  if (!objs.length) return 0;
  const cids = [...new Set(objs.flatMap(conceptsOf))], board = await boardRelevance(env, cids);
  const refs = await getObjects(env, [...new Set([...objs.map((o) => o.source_id), ...objs.map((o) => o.guideline), ...cids.slice(0, 300)].filter(Boolean))]);
  const srcs = {}, names = {}; for (const [id, x] of Object.entries(refs)) { if (x.type === 'Source') srcs[id] = x; names[id] = x.name; }
  const stmts = objs.map((o) => { const c = classifyOne(o, { board, srcs, names }); o.classification = c; return env.DB.prepare("UPDATE mk_objects SET body = json_set(body, '$.classification', json(?)) WHERE id = ?").bind(JSON.stringify(c), o.id); });
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return objs.length;
}

// The next objects that have no classification, an older classification version, or changed since they were classified.
export async function classifyStep(env, { limit = F.decomposition.classification.batch || 60 } = {}) {
  const { results } = await env.DB.prepare(`SELECT body FROM mk_objects WHERE id NOT LIKE 'ea.u%' AND (json_extract(body, '$.classification.v') IS NULL OR json_extract(body, '$.classification.v') != ?
    OR json_extract(body, '$.classification.ov') IS NOT version) LIMIT ?`).bind(CV, limit).all();
  const objs = results.map((r) => J(r.body)).filter(Boolean);
  return { classified: await classifyBatch(env, objs), more: objs.length >= limit };
}
