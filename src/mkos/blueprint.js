// Board Blueprint Governance and the Blueprint Execution Engine. Blueprints never determine medical truth; they determine emphasis.
// The versioned Blueprint / BlueprintTopic objects (education.js importBlueprint) are the source of truth; the tables below are the
// spec's registry projection, rebuilt incrementally for one blueprint at a time, and read by every prioritization in the app.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject, getObjects, query } from './kb.js';
import { event, queue } from './ingest.js';

const B = FRAMEWORK.frameworks.blueprints;
const clamp = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));


// ---- Discovery and classification
export function familyOf(title, path = '') {
  const s = (title + ' ' + path).toLowerCase();
  for (const f of B.families) {
    if (f.requires.length && !f.requires.some((r) => new RegExp(r, 'i').test(s))) continue;
    if (f.match.some((m) => new RegExp(m, 'i').test(s))) return { family: f.id, confidence: 85 };
  }
  return { family: B.default_family, confidence: 40 };
}
export const isBlueprintDoc = (title, path = '') => B.discovery.title_signals.some((t) => (title + ' ' + path).toLowerCase().includes(t));

const confFor = (kind) => {
  const c = { classification_confidence: 95, version_confidence: 90, priority_confidence: 85, ...(B.confidence_by_source[kind] || B.confidence_by_source.parsed_document) };
  c.trust_score = clamp((c.source_confidence + c.objective_extraction_confidence + c.weighting_confidence) / 3);
  c.overall_blueprint_confidence = clamp((c.source_confidence + c.classification_confidence + c.version_confidence + c.objective_extraction_confidence + c.weighting_confidence + c.priority_confidence) / 6);
  return c;
};
const impPoints = (imp) => [...String(imp || '')].reduce((a, ch) => a + (B.importance_points[ch] ?? 0), 0);

/* Project one Blueprint object (and its topics) into the registry tables. Resumable via prog (topics in id order).
   Blueprint-only scores: frequency = the topic's share of the exam scaled to the blueprint's largest; importance = task ratings
   (H 3, M 1, L 0 over four tasks; x0.75 if low frequency), or the share when ratings are absent; priority = 0.55 importance + 0.45 frequency. */
export async function projectBlueprint(env, bpId, { prog = { at: 0 }, kind = 'owner_registry' } = {}) {
  const bp = await getObject(env, bpId); if (!bp) return { error: 'no blueprint ' + bpId };
  const fam = bpId.includes('_lka') ? 'abim_im_lka' : bpId.includes('_cert') ? 'abim_im_cert' : (bp.data?.family || familyOf(bp.name).family);
  const F = B.families.find((f) => f.id === fam) || {}, c = confFor(kind);
  if (!prog.at) {
    await env.DB.prepare(`INSERT INTO mk_blueprint_registries (blueprint_id, blueprint_family, board_name, board_type, year, version, publication_date, effective_date, current_status, supersession_status, source_confidence, overall_blueprint_confidence, confidence, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (blueprint_id) DO UPDATE SET current_status = excluded.current_status, supersession_status = excluded.supersession_status, version = excluded.version,
      overall_blueprint_confidence = excluded.overall_blueprint_confidence, confidence = excluded.confidence, updated_at = excluded.updated_at`)
      .bind(bpId, fam, F.board_name || bp.name, F.board_type || '', Number((String(bp.edition).match(/\d{4}/) || [])[0]) || null, bp.version, bp.edition || '', bp.edition || '',
        bp.status, bp.replaced_by ? 'superseded_by:' + bp.replaced_by : bp.supersedes ? 'supersedes:' + bp.supersedes : 'none', c.source_confidence, c.overall_blueprint_confidence, JSON.stringify(c), bp.created, nowIso()).run();
  }
  const { results } = await env.DB.prepare("SELECT id, body FROM mk_objects WHERE type = 'BlueprintTopic' AND json_extract(body, '$.blueprint') = ? ORDER BY id").bind(bpId).all();
  const topics = results.map((r) => J(r.body)), maxPct = Math.max(0.0001, ...topics.map((t) => t.est_pct || 0));
  const dom = {};
  for (const t of topics) { const d = (dom[t.domain] = dom[t.domain] || { name: t.subcategory, w: 0, imp: 0, n: 0 }); d.w += t.est_pct || 0; d.imp += impPoints(t.importance); d.n++; }
  if (!prog.at) {
    const ds = Object.entries(dom), maxW = Math.max(0.0001, ...ds.map(([, d]) => d.w));
    for (let i = 0; i < ds.length; i += 40) await env.DB.batch(ds.slice(i, i + 40).map(([id, d]) => env.DB.prepare('INSERT OR REPLACE INTO mk_blueprint_domains (domain_id, blueprint_id, domain_name, blueprint_weight, frequency_score, importance_score, question_distribution_weight, confidence_score) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, bpId, d.name, clamp(d.w), clamp((100 * d.w) / maxW), clamp(d.n ? (100 * d.imp) / (12 * d.n) : 50), clamp(d.w), c.weighting_confidence)));
  }
  for (let i = prog.at || 0; i < topics.length; i += 30) {
    const part = topics.slice(i, i + 30), stmts = [];
    for (const t of part) {
      const freq = clamp((100 * (t.est_pct || 0)) / maxPct), rated = !!t.importance;
      const imp = clamp(rated ? (100 * impPoints(t.importance)) / 12 * (t.low_frequency ? B.low_frequency_factor : 1) : freq);
      const pri = clamp(0.55 * imp + 0.45 * freq), conf = t.provisional ? c.weighting_confidence - 15 : c.weighting_confidence;
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO mk_blueprint_objectives (objective_id, blueprint_id, domain_id, objective_text, objective_type, frequency_score, importance_score, priority_score, confidence_score) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(t.id, bpId, t.domain, t.name, t.tier || 'topic', freq, imp, pri, conf));
      for (const cid of t.concepts || []) stmts.push(env.DB.prepare(`INSERT INTO mk_blueprint_concept_mappings (blueprint_id, concept_id, relevance_score, weight_score, frequency_score, priority_score, confidence_score) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (blueprint_id, concept_id) DO UPDATE SET relevance_score = MAX(relevance_score, excluded.relevance_score), weight_score = weight_score + excluded.weight_score, frequency_score = MAX(frequency_score, excluded.frequency_score), priority_score = MAX(priority_score, excluded.priority_score)`)
        .bind(bpId, cid, imp, t.est_pct || 0, freq, pri, conf));
    }
    await env.DB.batch(stmts);
    prog.at = i + part.length;
  }
  return { blueprint: bpId, family: fam, topics: topics.length, domains: Object.keys(dom).length };
}

/* BLUEPRINT EVOLUTION ENGINE: a newer edition in a family. Diff topics by code/name, supersede the old projection, flag concepts whose
   weight changed (impact jobs), and queue learner re-derivation for learners who selected the family. Incremental only. */
export async function evolve(env, newBpId, oldBpId) {
  const ev = await event(env, 'blueprint_superseded', oldBpId, { replaced_by: newBpId, chain: B.events.supersession });
  const map = async (id) => Object.fromEntries((await env.DB.prepare('SELECT concept_id, priority_score FROM mk_blueprint_concept_mappings WHERE blueprint_id = ?').bind(id).all()).results.map((r) => [r.concept_id, r.priority_score]));
  const a = await map(oldBpId), b = await map(newBpId), changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (Math.abs((a[k] || 0) - (b[k] || 0)) >= 5) changed.push(k);
  await env.DB.prepare("UPDATE mk_blueprint_registries SET current_status = 'superseded', supersession_status = ?, updated_at = ? WHERE blueprint_id = ?").bind('superseded_by:' + newBpId, nowIso(), oldBpId).run();
  for (const c of changed.slice(0, 300)) await queue(env, 'impact', c, { event_id: ev }, 4);
  const fam = (await env.DB.prepare('SELECT blueprint_family FROM mk_blueprint_registries WHERE blueprint_id = ?').bind(newBpId).first() || {}).blueprint_family;
  const { results } = await env.DB.prepare('SELECT learner_id FROM mk_learner_blueprint WHERE selected_blueprint_family = ?').bind(fam || '').all();
  for (const r of results) { await env.DB.prepare('UPDATE mk_learner_blueprint SET selected_blueprint_id = ?, updated = ? WHERE learner_id = ?').bind(newBpId, nowIso(), r.learner_id).run(); await queue(env, 'learner', r.learner_id, {}, 5); }
  await env.DB.prepare("UPDATE mk_events SET stage = 'impact_determined', impact = ?, updated = ? WHERE id = ?").bind(JSON.stringify({ changed_concepts: changed.length, learners: results.length, chain: B.events.supersession }), nowIso(), ev).run();
  await audit(env, 'blueprint', 'blueprint_superseded', oldBpId, null, null, { replaced_by: newBpId, changed: changed.length });
  return { changed: changed.length, learners: results.length };
}

// ---- Selection (User Profile -> Selected Examination -> Blueprint Registry)
export async function currentBlueprint(env, family) {
  const r = await env.DB.prepare("SELECT blueprint_id FROM mk_blueprint_registries WHERE blueprint_family = ? AND current_status = 'current' ORDER BY updated_at DESC LIMIT 1").bind(family).first();
  return r ? r.blueprint_id : null;
}
export async function selection(env, uid) {
  const r = await env.DB.prepare('SELECT * FROM mk_learner_blueprint WHERE learner_id = ?').bind(uid).first();
  const family = r ? r.selected_blueprint_family : B.default_family;
  return { family, blueprint_id: (r && r.selected_blueprint_id) || (await currentBlueprint(env, family)), source: r ? r.source : 'default' };
}
export async function select(env, uid, { family = null, app_kind = null, source = 'learner' } = {}) {
  const fam = family || (B.families.find((f) => f.app_kind === app_kind) || {}).id || B.default_family;
  if (!B.families.some((f) => f.id === fam)) return { error: 'unknown blueprint family ' + fam };
  const bp = await currentBlueprint(env, fam), prev = await env.DB.prepare('SELECT selected_blueprint_family AS f FROM mk_learner_blueprint WHERE learner_id = ?').bind(uid).first();
  await env.DB.prepare('INSERT INTO mk_learner_blueprint (learner_id, selected_blueprint_family, selected_blueprint_id, source, updated) VALUES (?,?,?,?,?) ON CONFLICT (learner_id) DO UPDATE SET selected_blueprint_family = excluded.selected_blueprint_family, selected_blueprint_id = excluded.selected_blueprint_id, source = excluded.source, updated = excluded.updated')
    .bind(uid, fam, bp, source, nowIso()).run();
  if (!prev || prev.f !== fam) await queue(env, 'learner', uid, {}, 4);
  return { family: fam, blueprint_id: bp };
}

// ---- Scoring engine (the spec's five formulas, 0-100)
const S = B.scores;
const weighted = (w, v) => clamp(Object.entries(w).reduce((a, [k, x]) => a + x * (v[k] ?? B.unknown_learner_defaults[k] ?? 50), 0));
export function scoresFor(bpRow, st, comp = {}) {
  const v = {
    blueprint_frequency: bpRow ? bpRow.frequency_score : 0, blueprint_importance: bpRow ? bpRow.relevance_score ?? bpRow.importance_score : 0, blueprint_weight: bpRow ? bpRow.priority_score : 0,
    objective_priority: bpRow ? bpRow.priority_score : 0, competency_priority: comp.priority ?? 50, competency_importance: comp.priority ?? 50, competency_gap: comp.gap,
    learner_weakness: st ? 100 - st.mastery : undefined, retention_risk: st ? (st.retention?.forgetting_risk ?? 100 - (st.recency || 0)) : undefined,
    confidence_deficit: st ? 100 - st.confidence : undefined, learner_model: st ? st.priority : undefined,
  };
  return { board_priority: weighted(S.board_priority, v), question: weighted(S.question, v), flashcard: weighted(S.flashcard, v), lesson: weighted(S.lesson, v), recommendation: weighted(S.recommendation, v) };
}

// GET /api/mkos/blueprints
export async function listBlueprints(env) {
  const { results } = await env.DB.prepare('SELECT * FROM mk_blueprint_registries ORDER BY blueprint_family, updated_at DESC').all();
  return { families: B.families.map((f) => ({ id: f.id, board_name: f.board_name, board_type: f.board_type, versions: results.filter((r) => r.blueprint_family === f.id).map((r) => ({ ...r, confidence: J(r.confidence) })) })) };
}
// GET /api/mkos/blueprints/{id}
export async function blueprintDetail(env, id, { limit = 200 } = {}) {
  const reg = await env.DB.prepare('SELECT * FROM mk_blueprint_registries WHERE blueprint_id = ?').bind(id).first(); if (!reg) return { error: 'not found' };
  const domains = (await env.DB.prepare('SELECT * FROM mk_blueprint_domains WHERE blueprint_id = ? ORDER BY blueprint_weight DESC').bind(id).all()).results;
  const objectives = (await env.DB.prepare('SELECT * FROM mk_blueprint_objectives WHERE blueprint_id = ? ORDER BY priority_score DESC LIMIT ?').bind(id, limit).all()).results;
  return { blueprint: { ...reg, confidence: J(reg.confidence) }, domains, objectives, object: await getObject(env, id) };
}

/* GET /api/mkos/learners/{id}/board-plan: current blueprint, priorities (board priority score per objective, learner-personalized),
   weak areas, recommended objectives, recommended review queue, readiness with its confidence. */
export async function boardPlan(env, uid, { limit = 15 } = {}) {
  const sel = await selection(env, uid); if (!sel.blueprint_id) return { selection: sel, note: 'The selected blueprint has not been imported yet.' };
  const objs = (await env.DB.prepare('SELECT * FROM mk_blueprint_objectives WHERE blueprint_id = ? ORDER BY priority_score DESC LIMIT 400').bind(sel.blueprint_id).all()).results;
  const topics = await getObjects(env, objs.map((o) => o.objective_id));
  for (const o of objs) o.concept_id = ((topics[o.objective_id] || {}).concepts || [])[0] || null;
  const states = Object.fromEntries((await env.DB.prepare("SELECT object_id, body FROM mk_learner WHERE user_id = ? AND level IN ('concept','blueprint_topic','domain','competency')").bind(uid).all()).results.map((r) => [r.object_id, J(r.body)]));
  const rows = objs.map((o) => { const st = states[o.objective_id] || states[o.concept_id]; const sc = scoresFor({ frequency_score: o.frequency_score, importance_score: o.importance_score, relevance_score: o.importance_score, priority_score: o.priority_score }, st);
    return { objective_id: o.objective_id, concept_id: o.concept_id, name: o.objective_text, domain: o.domain_id, blueprint_priority: o.priority_score, frequency: o.frequency_score, importance: o.importance_score, studied: !!st, mastery: st ? st.mastery : null, confidence: st ? st.confidence : null, ...sc }; });
  const studied = rows.filter((r) => r.studied), totalW = rows.reduce((a, r) => a + r.blueprint_priority, 0) || 1;
  const readiness = clamp(rows.reduce((a, r) => a + r.blueprint_priority * (r.mastery || 0) / 100, 0) / totalW * 100);
  const coverage = clamp(studied.reduce((a, r) => a + r.blueprint_priority, 0) / totalW * 100);
  const domains = (await env.DB.prepare('SELECT * FROM mk_blueprint_domains WHERE blueprint_id = ? ORDER BY blueprint_weight DESC').bind(sel.blueprint_id).all()).results.map((d) => ({ ...d, learner: states[d.domain_id] ? { mastery: states[d.domain_id].mastery, confidence: states[d.domain_id].confidence } : null }));
  return {
    selection: sel, generated: nowIso(),
    readiness: { score: readiness, coverage, confidence: clamp(Math.min(coverage, studied.length ? studied.reduce((a, r) => a + (r.confidence || 0), 0) / studied.length : 0)), note: 'Readiness weighs mastery by blueprint priority over every objective; its confidence is limited by how much of the blueprint has evidence.' },
    current_priorities: [...rows].sort((a, b) => b.board_priority - a.board_priority).slice(0, limit),
    weak_areas: studied.filter((r) => r.mastery < 60).sort((a, b) => b.board_priority - a.board_priority).slice(0, limit),
    recommended_objectives: rows.filter((r) => !r.studied).slice(0, limit),
    review_queue: studied.sort((a, b) => b.flashcard - a.flashcard).slice(0, limit),
    domains: domains.slice(0, 40),
  };
}
// GET /api/mkos/board-review/recommendations: Board Review Mode = curriculum + blueprint filtering + weighting + learner personalization.
export async function boardRecommendations(env, uid, { limit = 12 } = {}) {
  const p = await boardPlan(env, uid, { limit: 60 }); if (!p.current_priorities) return p;
  const pick = (k) => [...p.current_priorities, ...p.weak_areas, ...p.review_queue, ...p.recommended_objectives].filter((x, i, a) => a.findIndex((y) => y.objective_id === x.objective_id) === i).sort((a, b) => b[k] - a[k]).slice(0, limit);
  return { selection: p.selection, readiness: p.readiness, lessons: pick('lesson'), questions: pick('question'), flashcards: pick('flashcard'), overall: pick('recommendation') };
}

/* Blueprint Extraction Engine, rules first: the ABIM blueprint as converted text (markdown tables of topics rated HIGH/MEDIUM/LOW per
   task, with category shares). Same reading as the app's parseBlueprint. Returns a registry-shaped object, or null. */
export function parseBlueprintText(text, family) {
  const u = (s) => s.replace(/\\+/g, '').trim(), cats = [], by = {}; let cur = null, sub = '', started = false;
  for (const raw of String(text).split('\n')) {
    const l = u(raw); let m;
    if (!started && (m = /^\|\s*([A-Z][A-Za-z ,&\/\-]+?)\s*\|\s*(\d+(?:\.\d+)?)%\s*\|/.exec(l))) { const c = { name: m[1].trim(), pct: Number(m[2]), subs: {} }; if (!by[c.name.toUpperCase()]) { by[c.name.toUpperCase()] = c; cats.push(c); } continue; }
    if ((m = /\*\*([A-Z][A-Z ,&\/\-]+?)\*\*/.exec(l)) && by[m[1].trim()]) { cur = by[m[1].trim()]; started = true; continue; }
    if ((m = /^\*\*([A-Z][^*]+?)\*\*\s*\*[^(]*\(\s*<?\s*\d+(?:\.\d+)?\s*% of exam\)/.exec(l)) && !by[m[1].trim()]) { sub = m[1].trim(); continue; }
    if (cur && (m = /^\|\s*(.+?)\s*\|\s*\*\*(HIGH|MEDIUM|LOW)\*\*\s*\|\s*\*\*(HIGH|MEDIUM|LOW)\*\*\s*\|\s*\*\*(HIGH|MEDIUM|LOW)\*\*\s*\|\s*\*\*(HIGH|MEDIUM|LOW)\*\*/.exec(l))) {
      const lf = /\*\*LF\*\*/.test(m[1]), name = m[1].replace(/\*\*LF\*\*/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim(), sn = sub ? sub.charAt(0) + sub.slice(1).toLowerCase() : 'General';
      (cur.subs[sn] = cur.subs[sn] || []).push({ name, lf, imp: m.slice(2, 6).map((x) => x[0]).join('') });
    }
  }
  const good = cats.filter((c) => Object.keys(c.subs).length); if (!good.length) return null;
  const categories = good.map((c, ci) => {
    const code = c.name.replace(/[^A-Z]/gi, '').slice(0, 5).toUpperCase() || 'C' + ci, all = Object.values(c.subs).flat();
    const pts = (t) => Math.max(0.0001, [...t.imp].reduce((a, ch) => a + (B.importance_points[ch] ?? 0), 0) * (t.lf ? B.low_frequency_factor : 1)), tot = all.reduce((a, t) => a + pts(t), 0);
    let n = 0;
    return { id: code, name: c.name, exam_pct: c.pct, subcategories: Object.entries(c.subs).map(([sn, ts]) => ({ name: sn, topics: ts.map((t) => { n++; const id = code + '.' + String(n).padStart(3, '0'), sc = pts(t);
      return [id, t.name, t.imp, t.lf ? 1 : 0, 0, sc, [...t.imp].filter((x) => x === 'H').length >= 2 && !t.lf ? 'core' : t.imp.includes('H') ? 'high' : t.imp.includes('M') ? 'medium' : 'excluded', Math.round((c.pct * sc / tot) * 1000) / 1000]; }) })) };
  });
  return { registry_type: 'blueprint', registry_version: 1, exam: family, blueprint_edition: '', task_types: ['diagnosis_testing', 'treatment_care', 'risk_prognosis_epidemiology', 'pathophysiology_basic_science'],
    topic_fields: ['id', 'topic', 'imp', 'lf', 'prov', 'score', 'tier', 'est_pct'], categories, extracted_by: 'rules' };
}
