// Educational Asset and Curriculum Layers: framework seeding (specialties, competencies), blueprint import (Blueprint, Domain,
// BlueprintTopic and the concepts they name), the curriculum tree (with the app's own topic ids, so existing progress maps), and
// the mapping of existing learner-record assets (lessons, questions, cards) onto concepts and sources. Deterministic: no AI.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, audit } from './db.js';
import { putObject, getObject, setStatus, slug } from './kb.js';
import { addEdges } from './graph.js';
import { resolveName, AUTO } from './resolve.js';
import { event } from './ingest.js';

const F = FRAMEWORK.frameworks;
const prov = (source_id, method, note) => ({ source_id, method, at: nowIso(), ...(note ? { note } : {}) });
const SPEC_BY_ABIM = Object.fromEntries(F.specialties.specialties.filter((s) => s.abim_code).map((s) => [s.abim_code, s.id]));
export const appSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);   // the app's slug(), exactly

// Specialties and competencies as objects, so the graph can point at them.
export async function seedFramework(env, { actor = 'framework', prog = { at: 0 } } = {}) {
  const items = [...F.specialties.specialties.map((s) => ({ ...s, type: 'Specialty', status: s.status || 'current', governance_status: 'approved', provenance: [prov('src.framework', 'derived', 'mkos/ontology/specialties.json v' + F.specialties.version)] })),
    ...F.competencies.competencies.map((c) => ({ ...c, type: 'Competency', status: 'current', governance_status: 'approved', provenance: [prov('src.framework', 'derived', 'mkos/ontology/competencies.json v' + F.competencies.version)] }))];
  let n = 0;
  for (let i = prog.at || 0; i < items.length; i++) { const r = await putObject(env, items[i], { actor, summary: 'seeded from framework', audited: false }); if (r.changed) n++; prog.at = i + 1; }
  return n;
}

// Guess a concept type for a blueprint topic name (owner can correct; correction is a new version).
export function guessType(name) {
  const s = name.toLowerCase();
  if (/screening|vaccin|immuniz|prophylaxis|surveillance|counsel/.test(s)) return 'procedure';
  if (/\b(test|testing|interpretation|imaging|biopsy|ecg|electrocardiogra|echocardiogra|spirometry|pulmonary function)\b/.test(s)) return 'diagnostic_test';
  if (/toxicity|poisoning|overdose|adverse|drug-induced|medication-induced/.test(s)) return 'disease';
  if (/syndrome/.test(s)) return 'syndrome';
  if (/\b(pain|fever|cough|dyspnea|syncope|dizziness|fatigue|weight loss|edema|palpitations|headache|vertigo|chest pain)\b/.test(s)) return 'symptom';
  if (/risk factor|smoking|obesity|alcohol use/.test(s)) return 'risk_factor';
  return 'disease';
}

/* Import a blueprint registry (the owner's ABIM_IM_<EXAM>_blueprint_registry JSON). exam: 'cert' | 'lka'. Idempotent; a new edition
   supersedes the previous edition's Blueprint object and its topics keep their concept links. */
export async function importBlueprint(env, reg, exam, { actor = 'blueprint_import', registryFileId = '', prog = { at: 0 } } = {}) {
  const from = prog.at || 0;
  const ev = prog.ev || (prog.ev = await event(env, 'blueprint_changed', 'bp.abim_im_' + exam, { edition: reg.blueprint_edition, file: registryFileId }));
  const srcId = reg.source_document?.drive_file_id ? 'src.' + reg.source_document.drive_file_id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) : 'src.blueprint_registry_' + exam;
  const bpId = 'bp.abim_im_' + exam + '.' + slug(reg.blueprint_edition || 'edition', 20);
  const fields = reg.topic_fields;
  const ix = (k) => fields.indexOf(k);
  const P = prov(srcId, 'blueprint_import', `${reg.exam || exam} blueprint registry v${reg.registry_version} (${reg.blueprint_edition})`);
  if (!from) {
  const prevBp = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Blueprint' AND id LIKE ? AND id != ? AND status = 'current'").bind('bp.abim_im_' + exam + '.%', bpId).all()).results;
  await putObject(env, { id: bpId, type: 'Blueprint', name: `ABIM Internal Medicine ${exam === 'lka' ? 'LKA / MOC' : 'Certification'} blueprint (${reg.blueprint_edition})`, status: 'current', governance_status: 'approved',
    exam: reg.exam || exam, exam_code: reg.exam_code || exam, edition: reg.blueprint_edition || '', source_id: srcId, task_types: reg.task_types || [],
    categories: reg.categories.map((c) => ({ id: c.id, name: c.name, exam_pct: c.exam_pct, subcategories: c.subcategories.length })), data: { meta: Object.fromEntries(Object.entries(reg).filter(([k]) => k !== 'categories')) }, provenance: [P] }, { actor, event_id: ev, summary: 'blueprint ' + reg.blueprint_edition });
  for (const p of prevBp) { await setStatus(env, p.id, 'superseded', { actor, replaced_by: bpId, event_id: ev, reason: 'newer blueprint edition' }); }
  }
  const out = prog.out || (prog.out = { topics: 0, concepts_new: 0, concepts_linked: 0, domains: 0 });
  // Flat work list (resumable: prog.at is the next item). A subcategory's domain is written with its first topic.
  const work = []; for (const c of reg.categories) for (const sc of c.subcategories) sc.topics.forEach((t, k) => work.push({ c, sc, t, first: k === 0 }));
  for (let i = from; i < work.length; i++) {
    const { c, sc, t, first } = work[i], edges = [];
    const spec = SPEC_BY_ABIM[c.id] || null, domId = 'dom.' + c.id.toLowerCase() + '.' + slug(sc.name, 50);
    if (first) {
      const oldDom = (await getObject(env, domId)) || {};
      const dr = await putObject(env, { id: domId, type: 'Domain', name: sc.name, parent: spec, abim_code: c.id, folder_aliases: [], kind: 'abim_subcategory', exam_pct: { ...(oldDom.exam_pct || {}), [exam]: sc.exam_pct_label || null }, status: 'current', governance_status: 'approved', provenance: oldDom.provenance || [P] }, { actor, event_id: ev, summary: 'domain from blueprint', audited: false });
      if (dr.created) out.domains++;
      if (spec) edges.push({ src: domId, rel: 'in_specialty', dst: spec, conf: 100, prov: P });
    }
    {
        const code = t[ix('id')], name = t[ix('topic')], tid = 'bpt.' + exam + '.' + code.toLowerCase().replace(/[^a-z0-9]/g, '_');
        // One concept per topic, shared by both exams (the cert registry names its LKA twin in lka_ref).
        let cId = null;
        const r = await resolveName(env, name, { types: ['Concept'] });
        if (r.id && r.confidence >= AUTO) { cId = r.id; out.concepts_linked++; }
        else {
          cId = 'c.' + guessType(name) + '.' + slug(name, 60);
          const old = await getObject(env, cId);
          if (!old) { out.concepts_new++; }
        }
        const old = (await getObject(env, cId)) || {};
        const imp = ix('imp') >= 0 ? t[ix('imp')] : ix('lka_imp') >= 0 ? t[ix('lka_imp')] : '';
        const est = t[ix('est_pct')];
        await putObject(env, { ...old, id: cId, type: 'Concept', name: old.name || name, canonical_name: old.canonical_name || name, concept_type: old.concept_type || guessType(name),
          aliases: old.aliases || [], specialty: [...new Set([...(old.specialty || []), ...(spec ? [spec] : [])])], domains: [...new Set([...(old.domains || []), domId])],
          blueprint_topics: [...new Set([...(old.blueprint_topics || []), tid])], status: old.status || 'current', governance_status: old.governance_status || 'pending_validation', facets: old.facets || {},
          board: { ...(old.board || {}), [exam === 'lka' ? 'lka_weight' : 'abim_weight']: est, ...(exam === 'lka' ? { lka_tier: t[ix('tier')], task_importance: imp, low_frequency: !!t[ix('lf')] } : { task_importance: old.board?.task_importance || imp }) },
          provenance: old.provenance?.length ? old.provenance : [P] }, { actor, event_id: ev, summary: 'board mapping ' + exam.toUpperCase() + ' ' + code, audited: false });
        await putObject(env, { id: tid, type: 'BlueprintTopic', name, blueprint: bpId, code, category: c.name, subcategory: sc.name, importance: imp || '', low_frequency: ix('lf') >= 0 ? !!t[ix('lf')] : false,
          provisional: ix('prov') >= 0 ? !!t[ix('prov')] : false, tier: ix('tier') >= 0 ? t[ix('tier')] : '', est_pct: typeof est === 'number' ? est : 0, priority_score: ix('score') >= 0 ? t[ix('score')] : 0,
          concepts: [cId], domain: domId, specialty: spec ? [spec] : [], status: 'current', governance_status: 'approved', provenance: [P], data: ix('lka_ref') >= 0 ? { lka_ref: t[ix('lka_ref')] } : {} },
          { actor, event_id: ev, summary: 'blueprint topic', audited: false });
        out.topics++;
        edges.push({ src: cId, rel: 'mapped_to_blueprint', dst: tid, conf: 95, prov: P }, { src: tid, rel: 'in_domain', dst: domId, conf: 100, prov: P }, { src: cId, rel: 'in_domain', dst: domId, conf: 90, prov: P });
        if (spec) edges.push({ src: cId, rel: 'in_specialty', dst: spec, conf: 90, prov: P });
        // Task ratings -> competencies the topic develops (task_type_map).
        if (imp) [...imp].forEach((lvl, j) => { if (lvl !== 'L') for (const comp of F.competencies.task_type_map[(reg.task_types || [])[j]] || []) edges.push({ src: tid, rel: 'develops', dst: comp, conf: lvl === 'H' ? 90 : 60, prov: P }); });
    }
    await addEdges(env, edges);
    prog.at = i + 1;
  }
  await audit(env, actor, 'blueprint_import', bpId, null, null, out);
  return { blueprint: bpId, ...out, event_id: ev };
}

/* The curriculum tree from the app's TRACKS (passed in, same shape as app/companion.html) plus the ABIM track derived from the
   learner's parsed blueprint document (med/blueprint), using the app's own id rules so every existing topic id maps 1:1. */
export async function importCurriculum(env, tracks, { actor = 'curriculum_import', abimDoc = null, prog = { at: 0 } } = {}) {
  const P = prov('src.app_curriculum', 'legacy_app_data', 'app/companion.html TRACKS');
  const all = [...tracks];
  if (abimDoc && Array.isArray(abimDoc.cats)) all.unshift({ id: 'abim', name: 'ABIM Boards', blurb: 'The exam blueprint, weighted by relevance', sections: abimDoc.cats.map((c) => ({ id: 'b-' + appSlug(c.name).slice(0, 24), name: c.name, pct: c.pct, topics: c.topics.map((t) => t.n) })) });
  // Flat, resumable work list: tracks, sections, topics in order.
  const work = [];
  all.forEach((tr, ti) => { work.push({ k: 'track', tr, ti }); tr.sections.forEach((s, si) => { work.push({ k: 'sec', tr, s, si }); const seen = new Set();
    s.topics.forEach((raw, i) => { const inp = String(raw).endsWith('~'), name = inp ? String(raw).slice(0, -1) : String(raw); let legacy = s.id + '.' + appSlug(name); if (tr.id === 'abim' && seen.has(legacy)) legacy += '-' + i; seen.add(legacy); work.push({ k: 'topic', tr, s, i, name, inp, legacy }); }); }); });
  const out = prog.out || (prog.out = { nodes: 0, mapped: 0 });
  for (let w = prog.at || 0; w < work.length; w++) {
    const x = work[w], trId = 'cn.' + slug(x.tr.id, 20);
    if (x.k === 'track') await putObject(env, { id: trId, type: 'CurriculumNode', name: x.tr.name, track: x.tr.id, parent: null, order: x.ti, legacy_topic_id: x.tr.id, concepts: [], blueprint_topics: [], status: 'current', governance_status: 'approved', provenance: [P], data: { blurb: x.tr.blurb || '' } }, { actor, summary: 'track', audited: false });
    else if (x.k === 'sec') await putObject(env, { id: trId + '.' + slug(x.s.id, 30), type: 'CurriculumNode', name: x.s.name, track: x.tr.id, parent: trId, order: x.si, legacy_topic_id: x.s.id, concepts: [], blueprint_topics: [], status: 'current', governance_status: 'approved', provenance: [P],
      data: { weight: x.s.w || 1, lib: x.s.lib || [], src: x.s.src || '', pct: x.s.pct || null } }, { actor, summary: 'section', audited: false });
    else {
      const id = nodeForTopic(x.legacy), r = await resolveName(env, x.name, { types: ['Concept'] });
      const concepts = r.id && r.confidence >= AUTO ? [r.id] : [];
      const bpts = concepts.length ? ((await getObject(env, concepts[0]))?.blueprint_topics || []) : [];
      await putObject(env, { id, type: 'CurriculumNode', name: x.name, track: x.tr.id, parent: trId + '.' + slug(x.s.id, 30), order: x.i, legacy_topic_id: x.legacy, concepts, blueprint_topics: bpts, status: 'current', governance_status: concepts.length ? 'approved' : 'pending_validation', provenance: [P],
        data: { inpatient: x.inp, resolution: { method: r.method, confidence: r.confidence, candidates: (r.candidates || []).slice(0, 3) } } }, { actor, summary: 'topic', audited: false });
      if (concepts.length) { await addEdges(env, concepts.map((c) => ({ src: id, rel: 'covers', dst: c, conf: Math.round(r.confidence * 100), prov: P }))); out.mapped++; }
      out.nodes++;
    }
    prog.at = w + 1;
  }
  return out;
}

// Topic id (as the app stores it) -> curriculum node id.
export const nodeForTopic = (tid) => 'cn.t.' + String(tid).replace(/[^a-z0-9.\-]/g, '').replace(/\./g, '__');

/* Map one learner's existing assets (lessons, question banks, card decks in their record) into EducationalAsset objects that point at
   the stored item (never copy it), linked to the curriculum node and concepts it teaches and the sources it cites.
   docs: { 'med/les_x': {...}, 'med/bank_y': {...}, 'med/cards_z': {...} }. */
export async function mapLearnerAssets(env, userId, docs, { actor = 'asset_mapper', prog = { at: 0 } } = {}) {
  const U = 'u' + String(userId).replace(/[^a-z0-9]/gi, '').slice(0, 10).toLowerCase(), P = (path) => prov('src.learner_record', 'legacy_app_data', path);
  const out = prog.out || (prog.out = { lessons: 0, questions: 0, cards: 0, linked: 0 });
  const citeIds = async (text) => {
    const ids = new Set();
    for (const part of [].concat(text || []).join('; ').split(/\s*(?:;| and )\s*/)) { if (part.length < 3) continue; const r = await resolveName(env, part, { types: ['Source', 'Guideline'] }); if (r.id && r.confidence >= AUTO) ids.add(r.id); }
    return [...ids];
  };
  const work = [];
  for (const [path, d] of Object.entries(docs).sort(([a], [b]) => a.localeCompare(b))) {
    if (!d || typeof d !== 'object') continue;
    if (/^med\/les_/.test(path)) work.push({ path, kind: d.len === 'short' ? 'micro_lesson' : 'long_form_lesson', id: 'ea.' + U + '.les_' + slug(d.id || path, 20), item: d.id || '', name: 'Lesson ' + (d.id || path), tid: d.tid, extra: { minutes: d.min || null }, src: [d.src, ...(d.segs || []).map((x) => x.src || '')], n: 'lessons' });
    else if (/^med\/bank_/.test(path)) for (const q of d.qs || []) work.push({ path, kind: 'question', id: 'ea.' + U + '.q_' + slug(q.id, 20), item: q.id, name: 'Question ' + q.id, tid: q.tid, extra: { difficulty: q.d || null }, src: q.src, n: 'questions' });
    else if (/^med\/cards_/.test(path)) for (const c of d.cards || []) work.push({ path, kind: 'flashcard', id: 'ea.' + U + '.card_' + slug(c.id, 20), item: c.id, name: 'Flashcard ' + c.id, tid: c.tid, extra: {}, src: c.src, n: 'cards' });
  }
  for (let i = prog.at || 0; i < work.length; i++) {
    const w = work[i], n = w.tid ? await getObject(env, nodeForTopic(w.tid)) : null, teaches = n ? n.concepts || [] : [], cites = await citeIds(w.src);
    await putObject(env, { id: w.id, type: 'EducationalAsset', name: String(w.name || w.kind).slice(0, 200), asset_kind: w.kind, store: { kind: 'learner_doc', user_scope: 'user', path: w.path, item_id: w.item },
      teaches, objectives: [], cites, blueprint_topics: n ? n.blueprint_topics || [] : [], status: 'current', governance_status: 'validated', provenance: [P(w.path)],
      data: { topic_id: w.tid || '', curriculum_node: n ? n.id : null, user: U, ...w.extra } }, { actor, summary: 'mapped from the learner record', audited: false });   // pointers only: the asset's text stays in the learner's record
    const links = [...teaches.map((c) => [c, 'teaches']), ...(n ? [[n.id, 'teaches']] : []), ...cites.map((c) => [c, 'cites'])];
    if (links.length) await env.DB.batch(links.map(([o, rel]) => env.DB.prepare('INSERT OR REPLACE INTO mk_asset_links (asset_id, user_id, path, item, object_id, rel, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(w.id, userId, w.path, w.item, o, rel, nowIso())));
    out[w.n]++; out.linked += links.length; prog.at = i + 1;
  }
  return out;
}
