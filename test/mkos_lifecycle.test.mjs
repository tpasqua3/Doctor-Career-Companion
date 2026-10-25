// MKOS Continuous Knowledge Lifecycle (step 1): lifecycle progression, source metadata, the classifier's new classes, the relevance
// graph (bands, many objectives, thresholds), the exam projection, a second exam family added by its blueprint only, the objmap fix,
// and that existing edges, objects and asset-basis inputs are unchanged. Synthetic fixtures only (no library content).
// Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from '../tools/mkos/d1shim.mjs';
import { mkInit, _resetInit } from '../src/mkos/db.js';
import { putObject, getObject } from '../src/mkos/kb.js';
import { addEdges, reach, RELS } from '../src/mkos/graph.js';
import { classify, classifyBase, registerFile } from '../src/mkos/ingest.js';
import { importBlueprint, examFamily } from '../src/mkos/education.js';
import { projectBlueprint } from '../src/mkos/blueprint.js';
import { lifecycleStep, lifecycleStatus, classesOf, trialTokens } from '../src/mkos/lifecycle.js';
import { enterLifecycle, readRecord } from '../src/mkos/lifecycle_state.js';
import { bandOf, conceptRows, objectiveOf, examProjection, examProjections, conceptExamWeights } from '../src/mkos/relevance.js';
import { mapObjectives } from '../src/mkos/objmap.js';
import { FRAMEWORK } from '../src/mkos/framework.js';

const P = (note = 'fixture') => [{ source_id: 'src.fixture', method: 'derived', at: '2026-10-24T00:00:00Z', note }];
const CLINICAL = new Set(FRAMEWORK.frameworks.ontology.relationships.map((r) => r.key));

async function fresh() { _resetInit(); const env = { DB: d1(':memory:', { strict: true }) }; await mkInit(env); return env; }
const concept = (env, id, name, type, extra = {}) => putObject(env, { id, type: 'Concept', name, canonical_name: name, concept_type: type, aliases: [], specialty: ['spec.nephrology'], status: 'current', governance_status: 'pending_validation', facets: {}, provenance: P(), ...extra }, { audited: false });
const edge = (src, rel, dst, conf = 70) => ({ src, rel, dst, conf, prov: { source_id: 'src.fixture', method: 'derived', at: '2026-10-24T00:00:00Z' } });

// A small synthetic corpus: kidney disease, its biomarker, two causes, a treatment, one guideline source with two recommendations.
async function corpus(env) {
  await concept(env, 'c.disease.chronic_kidney_disease', 'Chronic kidney disease', 'disease', { board: { abim_weight: 1.1 } });
  await concept(env, 'c.biomarker.albuminuria', 'Albuminuria', 'biomarker');
  await concept(env, 'c.disease.diabetes_mellitus', 'Diabetes mellitus', 'disease');
  await concept(env, 'c.disease.hypertension', 'Hypertension', 'disease');
  await concept(env, 'c.medication.sglt2_inhibitor', 'SGLT2 inhibitor', 'medication');
  await concept(env, 'c.disease.heart_failure', 'Heart failure', 'disease');
  await concept(env, 'c.disease.hyperkalemia', 'Hyperkalemia', 'disease');
  await concept(env, 'c.procedure.diabetes_screening', 'Diabetes screening', 'procedure');
  await concept(env, 'c.clinical_finding.hypertension_in_pregnancy', 'Hypertension in pregnancy', 'clinical_finding');
  await addEdges(env, [edge('c.biomarker.albuminuria', 'diagnoses', 'c.disease.chronic_kidney_disease'), edge('c.disease.diabetes_mellitus', 'causes', 'c.disease.chronic_kidney_disease'),
    edge('c.disease.hypertension', 'contributes_to', 'c.disease.chronic_kidney_disease'), edge('c.medication.sglt2_inhibitor', 'treats', 'c.disease.chronic_kidney_disease'),
    edge('c.medication.sglt2_inhibitor', 'treats', 'c.disease.heart_failure'), edge('c.disease.chronic_kidney_disease', 'complicates', 'c.disease.hyperkalemia'), edge('c.disease.heart_failure', 'related_to', 'c.disease.hypertension')]);
  await putObject(env, { id: 'ev.empa_kidney', type: 'EvidenceObject', name: 'EMPA-KIDNEY', status: 'current', governance_status: 'pending_validation', evidence_kind: 'landmark_trial', acronym: 'EMPA-KIDNEY', design: 'RCT', concepts: ['c.disease.chronic_kidney_disease'], provenance: P() }, { audited: false });
  await putObject(env, { id: 'src.kdigo2024', type: 'Source', name: 'KDIGO 2024 CKD', title: 'KDIGO 2024 Clinical Practice Guideline for the Evaluation and Management of Chronic Kidney Disease', source_class: 'clinical_practice_guideline', spec_source_type: 'Guidelines',
    drive_file_id: 'kdigo2024', drive_path: 'Nephrology', population: 'adult', copyright: 'publisher_copyright_paraphrase', ingest_state: 'extracted', responsible_orgs: ['KDIGO'], year: 2024, issue_date: '2024-04', specialty: ['spec.nephrology'], status: 'current', governance_status: 'pending_validation', provenance: P() }, { audited: false });
  const rec = (id, statement, concepts) => putObject(env, { id, type: 'Recommendation', name: statement.slice(0, 100), statement, source_id: 'src.kdigo2024', strength: 'strong', strength_original: '1', evidence_level: 'A', loe_original: '1A', grading_system: 'KDIGO',
    concepts, status: 'current', governance_status: 'validated', provenance: P() }, { audited: false });
  await rec('rec.kdigo2024.a1', 'We recommend an SGLT2 inhibitor for adults with CKD and albuminuria, based on EMPA-KIDNEY and DAPA-CKD.', ['c.disease.chronic_kidney_disease', 'c.biomarker.albuminuria']);
  await rec('rec.kdigo2024.a2', 'We suggest measuring albuminuria at least annually in adults with diabetes (ACR).', ['c.biomarker.albuminuria']);
  await rec('rec.kdigo2024.a3', 'We recommend treating hypertension in adults with CKD.', ['c.disease.chronic_kidney_disease']);
  await putObject(env, { id: 'claim.kdigo2024.a1.x', type: 'Claim', name: 'SGLT2 inhibitors are indicated in CKD with albuminuria', statement: 'SGLT2 inhibitors are indicated in CKD with albuminuria.', claim_kind: 'eligibility', source_id: 'src.kdigo2024', status: 'current', governance_status: 'validated', provenance: P() }, { audited: false, aliases: false });
  await addEdges(env, [edge('rec.kdigo2024.a1', 'derived_from', 'src.kdigo2024', 95), edge('rec.kdigo2024.a2', 'derived_from', 'src.kdigo2024', 95), edge('rec.kdigo2024.a3', 'derived_from', 'src.kdigo2024', 95),
    edge('c.disease.chronic_kidney_disease', 'recommended_by', 'rec.kdigo2024.a1'), edge('c.biomarker.albuminuria', 'recommended_by', 'rec.kdigo2024.a1'), edge('c.biomarker.albuminuria', 'recommended_by', 'rec.kdigo2024.a2'),
    edge('c.disease.chronic_kidney_disease', 'recommended_by', 'rec.kdigo2024.a3'), edge('claim.kdigo2024.a1.x', 'derived_from', 'rec.kdigo2024.a1', 90),
    edge('src.kdigo2024', 'covers', 'c.disease.chronic_kidney_disease', 65), edge('src.kdigo2024', 'covers', 'c.biomarker.albuminuria', 65), edge('c.disease.chronic_kidney_disease', 'supported_by', 'ev.empa_kidney', 60)]);
}
// An ABIM-shaped registry (synthetic topics) and a registry for an exam MKOS has never heard of.
const abim = { registry_type: 'blueprint', registry_version: 1, exam: 'cert', blueprint_edition: '2026', task_types: ['diagnosis_testing', 'treatment_care', 'risk_prognosis_epidemiology', 'pathophysiology_basic_science'],
  topic_fields: ['id', 'topic', 'imp', 'lf', 'prov', 'score', 'tier', 'est_pct'],
  categories: [{ id: 'NEPH', name: 'Nephrology', exam_pct: 6, subcategories: [{ name: 'Chronic kidney disease', topics: [['NEPH.001', 'Chronic kidney disease', 'HHMM', 0, 0, 9, 'core', 1.2], ['NEPH.002', 'Diabetes mellitus', 'MMLL', 0, 0, 4, 'medium', 0.4]] }] }] };
const neph = { registry_type: 'blueprint', registry_version: 1, blueprint_family: 'test_nephrology_board', board_name: 'Test Nephrology Board', board_type: 'subspecialty', exam_key: 'tneph', blueprint_edition: '2027',
  topic_fields: ['id', 'topic', 'imp', 'lf', 'prov', 'score', 'tier', 'est_pct'],
  categories: [{ id: 'CKD', name: 'Chronic kidney disease', exam_pct: 30, specialty: 'spec.nephrology', subcategories: [{ name: 'CKD', topics: [['CKD.01', 'Albuminuria', 'HHHH', 0, 0, 12, 'core', 8], ['CKD.02', 'Chronic kidney disease', 'HHHM', 0, 0, 11, 'core', 9]] }] }] };

async function settle(env, n = 6) { let last; for (let i = 0; i < n; i++) last = await lifecycleStep(env, {}, {}); return last; }

test('relevance bands: the nearest spec band, ties to the lower band', () => {
  assert.equal(bandOf(1), 'foundational'); assert.equal(bandOf(0.95), 'directly_tested'); assert.equal(bandOf(0.7), 'adjacent_core');
  assert.equal(bandOf(0.49), 'supporting'); assert.equal(bandOf(0.665), 'adjacent_core'); assert.equal(bandOf(0.355), 'peripheral');
  assert.equal(bandOf(0.175), 'remote'); assert.equal(bandOf(0.125), 'remote'); assert.equal(bandOf(0), 'not_relevant');
});

test('concept rows: many objectives, products of hop weights, pruned below 0.10, no small fan-out cap', () => {
  const adj = new Map(), link = (a, b, rel, w) => { for (const [x, y] of [[a, b], [b, a]]) { const m = adj.get(x) || new Map(); m.set(y, { w, rel, conf: 70 }); adj.set(x, m); } };
  link('c.a', 'c.b', 'treats', 0.7); link('c.b', 'c.c', 'causes', 0.7); link('c.a', 'c.d', 'related_to', 0.25); link('c.d', 'c.e', 'related_to', 0.25);
  for (let i = 0; i < 30; i++) link('c.a', 'c.n' + i, 'associated_with', 0.5);
  const objs = new Set(['c.a', 'c.b', 'c.c', 'c.d', 'c.e', ...Array.from({ length: 30 }, (_, i) => 'c.n' + i)].map(objectiveOf));
  const rows = conceptRows('c.a', adj, objs), by = Object.fromEntries(rows.map((r) => [r.objective_id, r]));
  assert.equal(by[objectiveOf('c.a')].score, 1); assert.equal(by[objectiveOf('c.a')].band, 'foundational');
  assert.equal(by[objectiveOf('c.b')].score, 0.7); assert.equal(by[objectiveOf('c.c')].score, 0.49); assert.equal(by[objectiveOf('c.c')].band, 'supporting');
  assert.equal(by[objectiveOf('c.d')].score, 0.25);
  assert.equal(by[objectiveOf('c.e')], undefined, '0.0625 is below the 0.10 threshold');
  assert.ok(rows.length >= 33, 'one object relates to every objective over the threshold: ' + rows.length);
  assert.equal(by[objectiveOf('c.c')].basis.path, 'treats>causes');
});

test('classifier: new classes by rules, refinements only, base rules unchanged', () => {
  assert.equal(classify('SPRINT Trial: intensive versus standard blood-pressure control.pdf', ['Cardiology'], 'application/pdf'), 'landmark_trial');
  assert.equal(classify('A randomized, double-blind, placebo-controlled trial of finerenone', ['Nephrology'], 'application/pdf'), 'landmark_trial');
  assert.equal(classify('Statins for primary prevention: a systematic review and meta-analysis', ['Cardiology'], 'application/pdf'), 'meta_analysis');
  assert.equal(classify('Exercise therapy for low back pain: a systematic review', ['Rheumatology'], 'application/pdf'), 'systematic_review');
  assert.equal(classify('CDC Clinical Practice Guideline for Prescribing Opioids for Pain 2022', ['Pain'], 'application/pdf'), 'government_guidance');
  assert.equal(classify('Guideline on hepatitis B', ['Government', 'Infectious Disease'], 'application/pdf'), 'government_guidance');
  // More specific base classes stay as they were.
  assert.equal(classify('USPSTF recommendation statement: screening for colorectal cancer', ['Prevention'], 'application/pdf'), 'preventive_recommendations');
  assert.equal(classify('ACIP immunization schedule 2026', ['ID'], 'application/pdf'), 'immunization_schedule');
  assert.equal(classify('Expert consensus statement on WHO criteria', ['Heme'], 'application/pdf'), 'consensus_statement');
  assert.equal(classifyBase('Case report: a randomized surprise', ['Misc'], 'application/pdf'), 'research_article');
  assert.equal(classify('Case report: a randomized surprise', ['Misc'], 'application/pdf'), 'research_article', 'no trial wording: stays a research article');
  assert.equal(classify('Who should be treated? A review', ['Misc'], 'application/pdf'), 'review_article', 'lower-case "who" is not the WHO');
  assert.equal(classify('2017 ACC/AHA Hypertension Guideline', ['Cardiology'], 'application/pdf'), 'clinical_practice_guideline');
});

test('registerFile: a classified source changes class only by a more specific rule, and that is logged', async () => {
  const env = await fresh();
  const f = { id: 'fileTrial1', title: 'Results of the trial in heart failure.pdf', mimeType: 'application/pdf', md5: 'a', modifiedTime: '2026-01-01', fileSize: '10' };
  await registerFile(env, f, ['Cardiology']);
  assert.equal((await getObject(env, 'src.filetrial1')).source_class, 'research_article');
  await registerFile(env, { ...f, title: 'DELIVER Trial results in heart failure.pdf', md5: 'b' }, ['Cardiology']);
  assert.equal((await getObject(env, 'src.filetrial1')).source_class, 'landmark_trial');
  const a = await env.DB.prepare("SELECT detail FROM mk_audit WHERE action = 'source_reclassified' AND object_id = 'src.filetrial1'").first();
  assert.ok(a && /research_article/.test(a.detail));
  // A consensus statement is not refined into government guidance (not a refinement of it).
  const g = { id: 'fileCons1', title: 'Consensus statement on sepsis.pdf', mimeType: 'application/pdf', md5: 'a', modifiedTime: '2026-01-01', fileSize: '10' };
  await registerFile(env, g, ['Critical Care']); await registerFile(env, { ...g, title: 'CDC consensus statement on sepsis.pdf', md5: 'b' }, ['Critical Care']);
  assert.equal((await getObject(env, 'src.filecons1')).source_class, 'consensus_statement');
  // New and changed sources enter the lifecycle from the scanner.
  assert.ok(await readRecord(env, 'src.filetrial1')); assert.equal((await readRecord(env, 'src.filetrial1')).cycle, 1);
});

test('lifecycle: a source moves through every stage to complete; metadata is volatile', async () => {
  const env = await fresh(); await corpus(env);
  await importBlueprint(env, abim, 'cert'); await projectBlueprint(env, 'bp.abim_im_cert.2026');
  const before = await env.DB.prepare("SELECT version, hash FROM mk_objects WHERE id = 'src.kdigo2024'").first();
  const edgesBefore = (await env.DB.prepare('SELECT src, rel, dst, conf, status FROM mk_edges ORDER BY src, rel, dst').all()).results;
  const objsBefore = (await env.DB.prepare('SELECT id, version, hash FROM mk_objects ORDER BY id').all()).results;
  await settle(env, 12);
  const rec = await readRecord(env, 'src.kdigo2024');
  assert.equal(rec.status, 'complete', JSON.stringify(rec.doc.stages));
  for (const k of ['ingested', 'knowledge_objects', 'ontology_mapped', 'relevance_mapped', 'exam_projected', 'lesson_penetration', 'curriculum_penetration', 'confidence', 'gaps']) assert.equal(rec.doc.stages[k].state, 'done', k);
  assert.equal(rec.doc.stages.knowledge_objects.detail.Recommendation, 3);
  // Stage 1 metadata: grading system, referenced trials (cites edges), dates; no new version.
  const src = await getObject(env, 'src.kdigo2024'), md = src.source_metadata;
  assert.equal(md.evidence_strength_system, 'KDIGO'); assert.deepEqual(md.referenced_sources, ['ev.empa_kidney']);
  assert.equal(md.version_date, '2024-04'); assert.equal(md.source_type, 'Guidelines'); assert.deepEqual(md.source_organization, ['KDIGO']);
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM mk_edges WHERE src = 'src.kdigo2024' AND rel = 'cites' AND dst = 'ev.empa_kidney'").first());
  const after = await env.DB.prepare("SELECT version, hash FROM mk_objects WHERE id = 'src.kdigo2024'").first();
  assert.deepEqual(after, before, 'metadata is a volatile field: no version bump, same content hash');
  // Existing data unchanged: every pre-existing edge keeps its confidence and status; every pre-existing object its version and hash.
  const edgesAfter = Object.fromEntries((await env.DB.prepare('SELECT src, rel, dst, conf, status FROM mk_edges').all()).results.map((e) => [e.src + '|' + e.rel + '|' + e.dst, e]));
  for (const e of edgesBefore) assert.deepEqual(edgesAfter[e.src + '|' + e.rel + '|' + e.dst], e);
  const objsAfter = Object.fromEntries((await env.DB.prepare('SELECT id, version, hash FROM mk_objects').all()).results.map((o) => [o.id, o]));
  for (const o of objsBefore) assert.deepEqual(objsAfter[o.id], o, o.id);
  // Asset basis inputs (assets.js basisNow, decompose.js pearl basis) read clinical edges and obj.* teaches/assesses only: none were added.
  const added = Object.values(edgesAfter).filter((e) => !edgesBefore.some((b) => b.src === e.src && b.rel === e.rel && b.dst === e.dst));
  assert.ok(added.length > 0);
  for (const e of added) { assert.ok(!CLINICAL.has(e.rel), 'no new clinical edge ' + e.rel); assert.ok(['classified_as', 'anchored_on', 'projects_objective', 'cites'].includes(e.rel), e.rel); }
  const st = await lifecycleStatus(env);
  assert.equal(st.by_status.complete, 1); assert.ok(st.canonical_objectives >= 2, 'blueprint anchors (CKD, diabetes)'); assert.ok(st.relevance.rows > 0);
  assert.deepEqual(st.pending_engine, []);
});

test('ontology mapping: eleven classes as classified_as edges; impact reach does not follow them', async () => {
  const env = await fresh(); await corpus(env); await settle(env);
  const cls = async (c) => (await env.DB.prepare("SELECT dst FROM mk_edges WHERE src = ? AND rel = 'classified_as' AND status = 'current' ORDER BY dst").bind(c).all()).results.map((r) => r.dst);
  assert.deepEqual(await cls('c.biomarker.albuminuria'), ['cls.biomarker']);
  assert.deepEqual(await cls('c.disease.chronic_kidney_disease'), ['cls.complication', 'cls.disease'], 'CKD complicates hyperkalemia');
  assert.deepEqual(await cls('c.procedure.diabetes_screening'), ['cls.preventive', 'cls.procedure']);
  assert.deepEqual(await cls('c.clinical_finding.hypertension_in_pregnancy'), ['cls.population', 'cls.syndrome']);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'ConceptClass'").first()).n, 11);
  assert.deepEqual(classesOf({ id: 'c.x', name: 'Renal tubule', concept_type: 'anatomical_structure' }).map((c) => c.key), ['educational']);
  const r = await reach(env, ['c.biomarker.albuminuria'], { depth: 2 });
  assert.ok(!r.has('cls.biomarker'), 'class nodes are not reached');
  assert.ok(!r.has('cls.disease'));
  assert.ok(RELS.classified_as && RELS.anchored_on && RELS.projects_objective);
});

test('relevance graph: an object relates to many canonical objectives with scores from the rule table', async () => {
  const env = await fresh(); await corpus(env); await importBlueprint(env, abim, 'cert'); await projectBlueprint(env, 'bp.abim_im_cert.2026'); await settle(env);
  const rows = Object.fromEntries((await env.DB.prepare("SELECT objective_id, score, band FROM mk_relevance WHERE object_id = 'rec.kdigo2024.a1'").all()).results.map((r) => [r.objective_id, r]));
  const ckd = objectiveOf('c.disease.chronic_kidney_disease');
  assert.equal(rows[ckd].score, 0.95); assert.equal(rows[ckd].band, 'directly_tested');
  assert.ok(Object.keys(rows).length >= 2, 'no binary mapping: ' + Object.keys(rows).join(','));
  assert.ok(Object.values(rows).every((r) => r.score >= 0.1));
  // The claim derived from it relates through the recommendation (0.90 x concept score).
  const claim = await env.DB.prepare("SELECT score FROM mk_relevance WHERE object_id = 'claim.kdigo2024.a1.x' AND objective_id = ?").bind(ckd).first();
  assert.equal(claim.score, 0.9);
  // Concept to its own objective is foundational; the neighbour's objective follows the hop weight.
  assert.equal((await env.DB.prepare("SELECT band FROM mk_relevance WHERE object_id = 'c.disease.chronic_kidney_disease' AND objective_id = ?").bind(ckd).first()).band, 'foundational');
  const ev = await env.DB.prepare("SELECT score FROM mk_relevance WHERE object_id = 'ev.empa_kidney' AND objective_id = ?").bind(ckd).first();
  assert.equal(ev.score, 0.85);
  // Canonical objectives are exam-independent and anchored on their concept.
  const o = await getObject(env, ckd); assert.equal(o.objective_type, 'canonical'); assert.equal(o.anchor_concept, 'c.disease.chronic_kidney_disease');
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM mk_edges WHERE src = ? AND rel = 'anchored_on' AND dst = 'c.disease.chronic_kidney_disease'").bind(ckd).first());
});

test('exam projection: relevance x topic weight, computed on read; importBlueprint writes no board fields into concepts', async () => {
  const env = await fresh(); await corpus(env); await importBlueprint(env, abim, 'cert'); await projectBlueprint(env, 'bp.abim_im_cert.2026'); await settle(env);
  const p = (await examProjection(env, ['rec.kdigo2024.a1'], { family: 'abim_im_cert' }))['rec.kdigo2024.a1'];
  const pri = (await env.DB.prepare("SELECT priority_score FROM mk_blueprint_objectives WHERE objective_id = 'bpt.cert.neph_001'").first()).priority_score;
  assert.equal(p.topic_id, 'bpt.cert.neph_001'); assert.equal(p.relevance, Math.round(0.95 * pri / 100 * 10000) / 10000);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'mk_exam_relevance'").first()).n, 1);
  const v = await env.DB.prepare("SELECT relevance FROM mk_exam_relevance WHERE object_id = 'rec.kdigo2024.a1' AND blueprint_id = 'bp.abim_im_cert.2026'").first();
  assert.ok(Math.abs(v.relevance - p.relevance) < 1e-4);
  // Concepts named by the blueprint keep only ontology links; their exam data is in the projection.
  const dm = await getObject(env, 'c.disease.diabetes_mellitus'); assert.equal(dm.board, undefined); assert.deepEqual(dm.blueprint_topics, ['bpt.cert.neph_002']);
  assert.equal((await conceptExamWeights(env, ['c.disease.diabetes_mellitus']))['c.disease.diabetes_mellitus'].est_pct, 0.4);
  assert.deepEqual((await getObject(env, 'c.disease.chronic_kidney_disease')).board, { abim_weight: 1.1 }, 'existing board data is left as it was');
  // ABIM ids are unchanged.
  assert.ok(await getObject(env, 'bp.abim_im_cert.2026')); assert.ok(await getObject(env, 'bpt.cert.neph_001'));
  assert.equal((await env.DB.prepare("SELECT blueprint_family FROM mk_blueprint_registries WHERE blueprint_id = 'bp.abim_im_cert.2026'").first()).blueprint_family, 'abim_im_cert');
});

test('a second exam family needs only its blueprint: no code change, no remapping of the corpus', async () => {
  const env = await fresh(); await corpus(env); await importBlueprint(env, abim, 'cert'); await projectBlueprint(env, 'bp.abim_im_cert.2026'); await settle(env);
  const relBefore = (await env.DB.prepare('SELECT object_id, objective_id, score FROM mk_relevance').all()).results;
  assert.equal(examFamily(null, neph).id, 'test_nephrology_board');
  const r = await importBlueprint(env, neph, null);
  assert.equal(r.blueprint, 'bp.test_nephrology_board.2027');
  await projectBlueprint(env, r.blueprint); await settle(env);
  assert.equal((await env.DB.prepare('SELECT blueprint_family, board_name FROM mk_blueprint_registries WHERE blueprint_id = ?').bind(r.blueprint).first()).board_name, 'Test Nephrology Board');
  const p = await examProjection(env, ['rec.kdigo2024.a2', 'rec.kdigo2024.a1'], { family: 'test_nephrology_board' });
  assert.ok(p['rec.kdigo2024.a2'] && p['rec.kdigo2024.a2'].relevance > 0, JSON.stringify(p));
  assert.equal(p['rec.kdigo2024.a2'].topic_id, 'bpt.tneph.ckd_01');
  const all = (await examProjections(env, ['rec.kdigo2024.a1']))['rec.kdigo2024.a1'];
  assert.ok(all.abim_im_cert > 0 && all.test_nephrology_board > 0, JSON.stringify(all));
  // The corpus is not remapped: every relevance score that existed is unchanged; the only additions are the rows of the objective the
  // new blueprint anchored (Albuminuria, which no exam named before).
  const relAfter = Object.fromEntries((await env.DB.prepare('SELECT object_id, objective_id, score FROM mk_relevance').all()).results.map((r) => [r.object_id + '|' + r.objective_id, r.score]));
  for (const r of relBefore) assert.equal(relAfter[r.object_id + '|' + r.objective_id], r.score, r.object_id + ' -> ' + r.objective_id);
  const added = Object.keys(relAfter).filter((k) => !relBefore.some((r) => r.object_id + '|' + r.objective_id === k));
  assert.ok(added.length && added.every((k) => k.endsWith('|' + objectiveOf('c.biomarker.albuminuria'))), added.join(','));
  assert.equal((await getObject(env, 'bpt.tneph.ckd_01')).specialty[0], 'spec.nephrology');
});

test('objmap: the concept-neighbour pass now follows the declared complicates relation', async () => {
  const env = await fresh(); await corpus(env); await importBlueprint(env, abim, 'cert');
  // Renal osteodystrophy has no blueprint mapping of its own; it complicates CKD, which is mapped, so the pass maps it through CKD.
  await concept(env, 'c.disease.renal_osteodystrophy', 'Renal osteodystrophy', 'disease');
  await addEdges(env, [edge('c.disease.renal_osteodystrophy', 'complicates', 'c.disease.chronic_kidney_disease')]);
  await mapObjectives(env, { slice: 10 });
  const e = await env.DB.prepare("SELECT conf, prov FROM mk_edges WHERE src = 'c.disease.renal_osteodystrophy' AND rel = 'mapped_to_blueprint' AND dst = 'bpt.cert.neph_001'").first();
  assert.ok(e, 'mapped through complicates'); assert.equal(e.conf, 55); assert.match(e.prov, /concept_neighbor/);
});

test('lifecycle re-entry keeps history; trial tokens skip organizations', async () => {
  const env = await fresh(); await corpus(env); await settle(env);
  await enterLifecycle(env, 'src.kdigo2024', { event: 'source_modified' });
  const r = await readRecord(env, 'src.kdigo2024');
  assert.equal(r.cycle, 2); assert.equal(r.status, 'waiting'); assert.equal(r.doc.stages.ingested.state, 'pending'); assert.equal(r.doc.history.length, 1); assert.equal(r.doc.history[0].status, 'complete');
  await settle(env, 12); assert.equal((await readRecord(env, 'src.kdigo2024')).status, 'complete');
  assert.deepEqual(trialTokens(['In the SPRINT and ACCORD trials (ACC/AHA), DAPA-HF and DAPA-HF showed']), ['DAPA-HF', 'ACCORD', 'SPRINT']);
});

test('lifecycle records are durable: mirrored to Drive and restored; the relevance graph is derived and rebuilt', async () => {
  const { mirrorStep } = await import('../src/mkos/mirror.js');
  const { restoreStep } = await import('../src/mkos/restore.js');
  const env = await fresh(); await corpus(env); await settle(env, 12);
  const files = new Map(); let n = 0;
  const deps = { upload: async (o) => { const id = o.id || 'f' + (++n); files.set(id, { ...o, id }); return id; }, mkdir: async (name, parent) => { const id = 'd' + (++n); files.set(id, { name, parent, id, dir: true }); return id; },
    list: async (parent) => ({ files: [...files.values()].filter((f) => f.parent === parent).map((f) => ({ id: f.id, title: f.name })) }), readMine: async (id) => JSON.parse(files.get(id).text) };
  for (let i = 0; i < 6; i++) await mirrorStep(env, deps, 'root', { max: 60 });
  const lf = [...files.values()].find((f) => f.name === 'lifecycle.json'); assert.ok(lf, 'registries/lifecycle.json written');
  assert.equal(JSON.parse(lf.text).records[0].source_id, 'src.kdigo2024');
  assert.ok(![...files.values()].some((f) => /relevance/.test(f.name || '')), 'the derived relevance graph is not written');
  const env2 = await fresh(), prog = {};
  for (let i = 0; i < 20; i++) { const r = await restoreStep(env2, deps, 'root', prog, { rowsPerStep: 5000 }); if (r.done) break; }
  const back = await readRecord(env2, 'src.kdigo2024'); assert.equal(back.status, 'complete'); assert.equal(back.doc.stages.exam_projected.state, 'done');
  assert.equal((await env2.DB.prepare('SELECT COUNT(*) AS n FROM mk_relevance').first()).n, 0);
  await settle(env2);
  const a = (await env.DB.prepare('SELECT object_id, objective_id, score FROM mk_relevance ORDER BY object_id, objective_id').all()).results;
  const b = (await env2.DB.prepare('SELECT object_id, objective_id, score FROM mk_relevance ORDER BY object_id, objective_id').all()).results;
  assert.deepEqual(b, a, 'rebuilt from the restored objects and edges');
});

/* ---------- Step 2: relevance is event driven (dirty flags) ---------- */
import { processDirty, recomputeConcepts, recomputeObjects, objectiveSet, dirtyCount } from '../src/mkos/relevance.js';
import { setStatus } from '../src/mkos/kb.js';
import { getSetting, setSetting } from '../src/mkos/db.js';
const all = () => true;
async function built(env) { await corpus(env); await importBlueprint(env, abim, 'cert'); await projectBlueprint(env, 'bp.abim_im_cert.2026'); await settle(env, 8); return env; }
const relRows = async (env) => (await env.DB.prepare('SELECT object_id, objective_id, score, band, basis_json FROM mk_relevance ORDER BY object_id, objective_id').all()).results;

test('relevance: an unchanged recompute writes nothing (0 changes), no full sweep, nothing left dirty', async () => {
  const env = await built(await fresh());
  assert.equal(await dirtyCount(env), 0);
  const before = await relRows(env); assert.ok(before.length > 10);
  const objs = await objectiveSet(env);
  const cons = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type = 'Concept'").all()).results.map((r) => r.id);
  const others = (await env.DB.prepare("SELECT id FROM mk_objects WHERE type IN ('Recommendation','Claim','EvidenceObject')").all()).results.map((r) => r.id);
  assert.equal((await recomputeConcepts(env, cons, objs)).writes, 0);
  assert.equal((await recomputeObjects(env, others)).writes, 0);
  // Every object marked dirty and processed: still zero row writes.
  await env.DB.prepare("INSERT INTO mk_relevance_dirty (object_id, radius, reason, marked_at) SELECT id, -1, 't', 'x' FROM mk_objects WHERE type IN ('Concept','Recommendation','Claim','EvidenceObject')").run();
  const d = await processDirty(env, objs, all);
  assert.equal(d.writes, 0); assert.ok(d.concepts >= cons.length); assert.equal(await dirtyCount(env), 0);
  assert.deepEqual(await relRows(env), before);
  const rel = JSON.parse(await getSetting(env, 'lc_rel')); assert.equal(rel.mode, 'dirty'); assert.equal(rel.sweep, undefined, 'no sweep counter');
  // Later engine runs with nothing dirty write no relevance rows.
  const r = await lifecycleStep(env, {}, {}); assert.equal(r.relevance, 0);
});

test('relevance: a new guideline touching concepts recomputes only those and their hop radius; stale pairs go', async () => {
  const env = await built(await fresh());
  const objs = await objectiveSet(env), trace = { concepts: [], objects: [] };
  // A new drug that treats CKD, and a new guideline recommending it.
  await concept(env, 'c.medication.finerenone', 'Finerenone', 'medication');
  await addEdges(env, [edge('c.medication.finerenone', 'treats', 'c.disease.chronic_kidney_disease')]);
  await putObject(env, { id: 'src.ada2025', type: 'Source', name: 'ADA 2025', title: 'ADA Standards of Care 2025', source_class: 'clinical_practice_guideline', spec_source_type: 'Guidelines', drive_file_id: 'ada', drive_path: 'Endocrinology', ingest_state: 'extracted', responsible_orgs: ['ADA'], year: 2025, specialty: ['spec.endocrinology'], status: 'current', governance_status: 'pending_validation', provenance: P() }, { audited: false });
  await putObject(env, { id: 'rec.ada2025.1', type: 'Recommendation', name: 'Finerenone in CKD with T2D', statement: 'Use finerenone in CKD with type 2 diabetes and albuminuria.', source_id: 'src.ada2025', strength: 'strong', evidence_level: 'A', grading_system: 'ADA', status: 'current', governance_status: 'validated', provenance: P() }, { audited: false });
  await addEdges(env, [edge('rec.ada2025.1', 'derived_from', 'src.ada2025', 95), edge('c.medication.finerenone', 'recommended_by', 'rec.ada2025.1')]);
  const seeds = (await env.DB.prepare('SELECT object_id FROM mk_relevance_dirty ORDER BY object_id').all()).results.map((r) => r.object_id);
  assert.ok(seeds.includes('c.medication.finerenone') && seeds.includes('rec.ada2025.1') && seeds.includes('c.disease.chronic_kidney_disease'));
  await processDirty(env, objs, all, { trace });
  const touched = new Set(trace.concepts);
  // Within the radius: finerenone, CKD and CKD's neighbours. Heart failure is three hops from finerenone: untouched.
  for (const c of ['c.medication.finerenone', 'c.disease.chronic_kidney_disease', 'c.biomarker.albuminuria', 'c.medication.sglt2_inhibitor']) assert.ok(touched.has(c), c);
  assert.ok(!touched.has('c.disease.heart_failure'), 'outside the hop radius');
  assert.ok(trace.objects.includes('rec.ada2025.1'));
  assert.ok(!trace.objects.includes('rec.kdigo2024.a2'), 'an object whose concept rows did not change is not recomputed: ' + trace.objects.join(','));
  const r = await env.DB.prepare("SELECT score FROM mk_relevance WHERE object_id = 'rec.ada2025.1' AND objective_id = ?").bind(objectiveOf('c.disease.chronic_kidney_disease')).first();
  assert.equal(r.score, Math.round(0.95 * 0.7 * 10000) / 10000);
  // Stale pairs: retiring diabetes removes its rows and CKD's row to the diabetes objective (the causes path is gone); nothing else changes.
  const dm = objectiveOf('c.disease.diabetes_mellitus');
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM mk_relevance WHERE object_id = 'c.disease.chronic_kidney_disease' AND objective_id = ?").bind(dm).first());
  const keep = (await relRows(env)).filter((x) => x.objective_id !== dm && x.object_id !== 'c.disease.diabetes_mellitus');
  await setStatus(env, 'c.disease.diabetes_mellitus', 'retired', { force: true });
  await processDirty(env, objs, all);
  assert.equal(await env.DB.prepare("SELECT 1 AS x FROM mk_relevance WHERE object_id = 'c.disease.chronic_kidney_disease' AND objective_id = ?").bind(dm).first(), null);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_relevance WHERE object_id = 'c.disease.diabetes_mellitus'").first()).n, 0);
  const after = new Map((await relRows(env)).map((x) => [x.object_id + '|' + x.objective_id, x]));
  for (const x of keep) assert.deepEqual(after.get(x.object_id + '|' + x.objective_id), x, x.object_id + ' ' + x.objective_id);
});

test('relevance: a superseded source dirties its recommendations and what derives from them', async () => {
  const env = await built(await fresh()), trace = { concepts: [], objects: [] };
  await setStatus(env, 'src.kdigo2024', 'superseded', { force: true });
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM mk_relevance_dirty WHERE object_id = 'src.kdigo2024'").first());
  await processDirty(env, await objectiveSet(env), all, { trace });
  for (const id of ['rec.kdigo2024.a1', 'rec.kdigo2024.a2', 'rec.kdigo2024.a3', 'claim.kdigo2024.a1.x']) assert.ok(trace.objects.includes(id), id);
  assert.equal(await dirtyCount(env), 0);
});

test('relevance: a rules-version change re-backfills every object once; rows are rebuilt identically', async () => {
  const env = await built(await fresh()), before = await relRows(env);
  const rel = JSON.parse(await getSetting(env, 'lc_rel')); rel.v = 'r0.old'; await setSetting(env, 'lc_rel', JSON.stringify(rel));
  await env.DB.prepare('DELETE FROM mk_relevance WHERE object_id LIKE ?').bind('rec.%').run();   // and a damaged table
  await lifecycleStep(env, {}, {});
  const st = JSON.parse(await getSetting(env, 'lc_rel'));
  assert.ok(st.backfilled, 'backfill finished'); assert.equal(st.v, FRAMEWORK.frameworks.lifecycle.relevance.rules_version);
  await settle(env, 4);
  assert.deepEqual(await relRows(env), before);
});

test('relevance: the read-only audit finds drift and marks it, without rewriting unchanged rows', async () => {
  const { auditStep } = await import('../src/mkos/relevance.js');
  const env = await built(await fresh());
  await env.DB.prepare("UPDATE mk_relevance SET score = 0.11 WHERE object_id = 'rec.kdigo2024.a2'").run();   // a change no write path marked
  const prog = {}; let done = false; for (let i = 0; i < 10 && !done; i++) done = await auditStep(env, prog, await objectiveSet(env), all);
  assert.ok(done); assert.ok(prog.drifted >= 1);
  assert.deepEqual((await env.DB.prepare('SELECT object_id FROM mk_relevance_dirty').all()).results.map((r) => r.object_id), ['rec.kdigo2024.a2']);
});

/* ---------- Step 2: penetration, enrichment, layers, confidence, coverage, gaps, specialties, prompt wording ---------- */
import { computePenetration, penetrationRows } from '../src/mkos/impact.js';
import { enrichLesson, enhancementsOf, newAdditions } from '../src/mkos/enrich.js';
import { judgeWhy } from '../src/mkos/assets.js';
import { layerOf, planOf, layerPlan, layeredOutline, computeLayers } from '../src/mkos/layers.js';
import { evidenceFactors, relevanceFactors, lessonFactors, confidenceOf } from '../src/mkos/confidence.js';
import { coverageRows, gapRules, coverageLatest, gapsList } from '../src/mkos/coverage.js';
import { reviewSpecialty, resetSpecialtyCache, specialtyOf } from '../src/mkos/ingest.js';
import { seedRules, qspec, boardLevel } from '../src/mkos/genjobs.js';
import { PEARL_PROMPT } from '../src/mkos/decompose.js';
import { wordingFor, examKeyOf } from '../src/mkos/wording.js';
import { createHash } from 'node:crypto';

const LES = 'ea.s.les.chronic_kidney_disease.std.h';
async function lesson(env) {
  const basis = { families: {}, recs: { 'rec.kdigo2024.a1': 'sig1' }, priority: 90, band: 'h', cov: 2, objs: [], comps: [], rels: [] };
  await putObject(env, { id: LES, type: 'EducationalAsset', name: 'Lesson: Chronic kidney disease', asset_kind: 'long_form_lesson', app_topic: 'neph.ckd', variant: 'std', teaches: ['c.disease.chronic_kidney_disease'],
    store: { kind: 'mkos', user_scope: 'central', path: 'mk_asset_store', item_id: LES }, basis, review_status: 'validated', needs: [], status: 'current', governance_status: 'validated', version: '1.4.0',
    generation: { generated_at: '2026-01-01T00:00:00Z' }, provenance: P() }, { audited: false });
  await env.DB.batch([env.DB.prepare("INSERT INTO mk_asset_links (asset_id, user_id, path, item, object_id, rel, at) VALUES (?, 'central', 'mkos', ?, 'c.disease.chronic_kidney_disease', 'teaches', 'x')").bind(LES, LES),
    env.DB.prepare("INSERT INTO mk_asset_store (asset_id, version, content, bytes, at) VALUES (?, '1.4.0', ?, 10, '2026-01-01T00:00:00Z')").bind(LES, JSON.stringify({ title: 'CKD', segs: [{ heading: 'One', text: 'Text' }] }))]);
  await env.DB.prepare("UPDATE mk_objects SET created = '2026-01-01T00:00:00Z' WHERE id LIKE 'rec.kdigo2024.%' OR id = 'ev.empa_kidney'").run();
  await addEdges(env, [edge('cn.neph.ckd', 'covers', 'c.disease.chronic_kidney_disease')]);
}
async function newGuideline(env) {
  await putObject(env, { id: 'src.ada2025', type: 'Source', name: 'ADA 2025', title: 'ADA Standards of Care in Diabetes 2025', source_class: 'clinical_practice_guideline', spec_source_type: 'Guidelines', drive_file_id: 'ada', drive_path: 'Endocrinology', ingest_state: 'extracted', responsible_orgs: ['ADA'], year: 2025, guideline_family: 'gl.ada_standards_diabetes', specialty: ['spec.endocrinology'], status: 'current', governance_status: 'pending_validation', provenance: P() }, { audited: false });
  await putObject(env, { id: 'rec.ada2025.1', type: 'Recommendation', name: 'Finerenone in CKD with T2D', statement: 'Use finerenone in CKD with type 2 diabetes and albuminuria.', source_id: 'src.ada2025', strength: 'strong', evidence_level: 'A', grading_system: 'ADA', status: 'current', governance_status: 'validated', provenance: P() }, { audited: false });
  await addEdges(env, [edge('rec.ada2025.1', 'derived_from', 'src.ada2025', 95), edge('c.disease.chronic_kidney_disease', 'recommended_by', 'rec.ada2025.1'), edge('src.ada2025', 'covers', 'c.disease.chronic_kidney_disease', 65)]);
  await env.DB.prepare("INSERT INTO mk_events (id, kind, subject, stage, detail, created, updated) VALUES ('evt.ada', 'source_added', 'src.ada2025', 'created', '{}', 'x', 'x')").run();
  await enterLifecycle(env, 'src.ada2025', { event: 'source_added' });
}

test('penetration: a newly added source reaches objectives, lessons, curricula and exams with scores; the event carries it', async () => {
  const env = await built(await fresh()); await lesson(env); await newGuideline(env); await settle(env, 14);
  const rec = await readRecord(env, 'src.ada2025'); assert.equal(rec.status, 'complete', JSON.stringify(rec.doc.stages));
  const pen = Object.fromEntries((await env.DB.prepare("SELECT target_kind || '|' || target_id AS k, score, band FROM mk_penetration WHERE subject_id = 'src.ada2025'").all()).results.map((r) => [r.k, r]));
  const ckd = objectiveOf('c.disease.chronic_kidney_disease');
  assert.equal(pen['objective|' + ckd].score, 0.95);
  assert.equal(pen['lesson|' + LES].score, 0.95); assert.equal(pen['lesson|' + LES].band, 'directly_tested');
  assert.equal(pen['curriculum|cn.neph.ckd'].score, 0.95);
  assert.equal(pen['board_curriculum|bpt.cert.neph_001'].score, 0.95);
  assert.ok(pen['exam|abim_im_cert'].score > 0 && pen['exam|abim_im_cert'].score <= 0.95);
  assert.ok(pen['objective|' + objectiveOf('c.disease.diabetes_mellitus')].score < 0.95, 'graded, not binary');
  const ev = await env.DB.prepare("SELECT stage, impact FROM mk_events WHERE id = 'evt.ada'").first();
  assert.equal(ev.stage, 'impact_determined'); assert.ok(JSON.parse(ev.impact).penetration.counts.lesson >= 1);
  // Pure rule: lesson score = max over its objectives; exam = objective score x priority / 100; below 0.25 pruned.
  const rows = penetrationRows(new Map([['obj.c.a', 0.9], ['obj.c.b', 0.2]]), { lesson: [['L', 'obj.c.a'], ['L', 'obj.c.b'], ['M', 'obj.c.b']] }, [['t1', 'fam', 50, 'obj.c.a']]);
  assert.deepEqual(rows.map((r) => [r.target_kind, r.target_id, r.score]), [['objective', 'obj.c.a', 0.9], ['lesson', 'L', 0.9], ['exam', 'fam', 0.45]]);
});

test('enrichment: the lesson is enhanced, not regenerated; v1.4.0 + additions = v1.5.0; basis fingerprint untouched', async () => {
  const env = await built(await fresh()); await lesson(env);
  const before = await getObject(env, LES);
  await newGuideline(env); await settle(env, 14);
  const after = await getObject(env, LES);
  assert.equal(after.version, '1.5.0'); assert.deepEqual(after.basis, before.basis, 'basis fingerprint unchanged');
  assert.deepEqual(after.needs, []); assert.equal(after.review_status, 'validated');
  const en = await enhancementsOf(env, LES), kinds = en.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['citation', 'recommendation']); assert.ok(en.every((x) => x.asset_version === '1.5.0'));
  assert.equal(en.find((x) => x.kind === 'recommendation').object_id, 'rec.ada2025.1');
  const store = (await env.DB.prepare('SELECT version, content FROM mk_asset_store WHERE asset_id = ? ORDER BY at').bind(LES).all()).results;
  assert.deepEqual(store.map((r) => r.version), ['1.4.0', '1.5.0'], 'version history kept');
  assert.equal(JSON.parse(store[1].content).enhancements.length, 2); assert.equal(JSON.parse(store[1].content).title, 'CKD');
  // Idempotent: nothing new, no new version.
  assert.equal((await enrichLesson(env, LES)).added, 0); assert.equal((await getObject(env, LES)).version, '1.5.0');
  // judge: what enrichment absorbed no longer regenerates; a changed edition still does.
  const pol = { unreviewed: false, delta: 20 }, live = { 'rec.kdigo2024.a1': await getObject(env, 'rec.kdigo2024.a1') };
  const now = { families: { 'gl.ada_standards_diabetes': 'src.ada2025' }, cov: 6 };
  const raw = { ...after, enrichment: undefined, basis: { ...after.basis, recs: {} } };
  assert.deepEqual(await judgeWhy(raw, now, live, pol, false), ['guideline_changed', 'new_guideline_family']);
  const absorbed = { ...after, basis: { ...after.basis, recs: {} }, enrichment: { ...after.enrichment, recs: 2 } };
  assert.deepEqual(await judgeWhy(absorbed, now, live, pol, false), [null, null]);
  assert.deepEqual(await judgeWhy({ ...absorbed, basis: { ...absorbed.basis, families: { 'gl.ada_standards_diabetes': 'src.ada2019' } } }, now, live, pol, false), ['guideline_changed', 'edition_changed']);
  assert.deepEqual(await judgeWhy({ ...absorbed, enrichment: { ...absorbed.enrichment, recs: 0 } }, now, live, pol, false), ['coverage_expanded', 'coverage_expanded']);
  assert.equal(newAdditions(after, { recs: [{ id: 'rec.kdigo2024.a1', statement: 'x' }] }).length, 0, 'a recommendation in the basis is not an enhancement');
});

test('layers: rules place knowledge in core, adjacent, advanced and frontier; the outline is structure only', async () => {
  assert.equal(layerOf({ score: 0.95, conf: 0.8, type: 'Recommendation' }, { projected: true }), 'core');
  assert.equal(layerOf({ score: 0.95, conf: 0.6, type: 'Recommendation' }, { projected: true }), 'adjacent', 'high relevance, middling confidence');
  assert.equal(layerOf({ score: 0.95, conf: 0.3, type: 'Recommendation' }, {}), 'advanced', 'emerging');
  assert.equal(layerOf({ score: 0.85, conf: 0.9, type: 'EvidenceObject' }, {}), 'advanced', 'landmark trial');
  assert.equal(layerOf({ score: 0.9, conf: 0.9, type: 'Recommendation', specialty: 'spec.cardiology' }, { specialty: 'spec.nephrology' }), 'advanced', 'subspecialty');
  assert.equal(layerOf({ score: 0.6, conf: 0.9, type: 'Claim' }, {}), 'adjacent');
  assert.equal(layerOf({ score: 0.2, conf: 0.9, type: 'Claim' }, {}), 'frontier');
  assert.equal(layerOf({ score: 0.05, conf: 0.9, type: 'Claim' }, {}), null);
  const env = await built(await fresh()); await lesson(env);
  const ckd = objectiveOf('c.disease.chronic_kidney_disease');
  await computeLayers(env, [ckd]);
  const plan = await layerPlan(env, { asset: LES });
  assert.ok(plan.layers.core.top.some((x) => x.id === 'rec.kdigo2024.a1'), JSON.stringify(plan.layers));
  assert.ok(plan.layers.advanced.top.some((x) => x.id === 'ev.empa_kidney' && x.landmark));
  const w = await computeLayers(env, [ckd]); assert.equal(w, 0, 'unchanged plan writes nothing');
  const out = layeredOutline(plan); assert.match(out, /Required core: /); assert.match(out, /Advanced expansion: EMPA-KIDNEY/);
  assert.equal(layeredOutline({ layers: {} }), '');
});

test('confidence: three separate domains; mk_objects conf and trust keep their meaning', async () => {
  const e = evidenceFactors({ type: 'Recommendation', evidence_level: 'A' }, { source_class: 'clinical_practice_guideline', year: 2024 }, 3);
  assert.equal(e.factors.authority, 0.98); assert.equal(e.factors.agreement, 1); assert.ok(e.score > 0.8 && e.score <= 1);
  const weak = evidenceFactors({ type: 'Recommendation', evidence_level: 'C-EO' }, { source_class: 'review_article', year: 2001 }, 1);
  assert.ok(weak.score < e.score);
  assert.equal(evidenceFactors({ type: 'EvidenceObject', design: 'RCT' }, null, 0).factors.evidence_level, 0.9);
  const r = relevanceFactors({ max: 0.95, strong: 8, exam: 1 }); assert.ok(Math.abs(r.score - (0.5 * 0.95 + 0.3 + 0.2)) <= 0.0051, String(r.score));
  const l = lessonFactors({ sources: 2, recs_total: 4, recs_covered: 3, evidence: 0.8, objectives: 1, objectives_supported: 1, age_days: 0 });
  assert.equal(l.factors.coverage, 0.75); assert.equal(l.factors.recency, 1);
  const env = await built(await fresh()); await lesson(env);
  const trustBefore = (await env.DB.prepare('SELECT id, trust, conf FROM mk_objects ORDER BY id').all()).results;
  await newGuideline(env); await settle(env, 14);
  const c = await confidenceOf(env, 'rec.ada2025.1'); assert.ok(c.evidence && c.relevance, JSON.stringify(c));
  assert.equal(c.evidence.factors.agreeing_sources, 2, 'KDIGO and ADA both recommend on CKD');
  assert.ok((await confidenceOf(env, LES)).lesson);
  const after = Object.fromEntries((await env.DB.prepare('SELECT id, trust, conf FROM mk_objects').all()).results.map((x) => [x.id, x]));
  for (const o of trustBefore) if (o.id !== LES) assert.deepEqual(after[o.id], o, o.id);
});

test('coverage: numbers by dimension; knowledge penetration; the snapshot is stored', async () => {
  const x = { canon: [{ id: 'obj.c.a' }, { id: 'obj.c.b' }, { id: 'obj.c.c' }, { id: 'obj.c.d' }], supported: new Set(['obj.c.a', 'obj.c.b', 'obj.c.c']), recObj: new Set(['obj.c.a', 'obj.c.b']), evObj: new Set(['obj.c.a']),
    lessonObj: new Set(['obj.c.a']), curObj: new Set(), topics: [{ t: 't1', f: 'fam', p: 90 }, { t: 't2', f: 'fam', p: 40 }], topicObjs: new Map([['t1', ['obj.c.a']], ['t2', ['obj.c.d']]]), objPri: new Map(), topicLessons: new Set() };
  const rows = Object.fromEntries(coverageRows(x, { specialties: [{ key: 'spec.nephrology', num: 3, den: 4 }], lifecycle: [{ status: 'complete', stages_json: '{}' }, { status: 'in_progress', stages_json: '{}' }], knowledge: { num: 1, den: 4 } }).map((r) => [r.dimension + '|' + r.key, r]));
  assert.equal(rows['objective|supported'].pct, 75); assert.equal(rows['exam|fam'].pct, 50); assert.equal(rows['lesson|fam'].pct, 50);
  assert.equal(rows['evidence|objectives_with_recommendations'].pct, 50); assert.equal(rows['source|lifecycle_complete'].pct, 50);
  assert.equal(rows['specialty|spec.nephrology'].pct, 75); assert.equal(rows['lesson|objectives'].pct, 25); assert.equal(rows['penetration|knowledge'].pct, 25);
  const env = await built(await fresh()); await lesson(env); await setSetting(env, 'lc_cov', null); await settle(env, 4);
  const c = await coverageLatest(env); assert.ok(c.day); for (const d of ['specialty', 'objective', 'exam', 'evidence', 'source', 'lesson', 'penetration']) assert.ok(c.dimensions[d], d);
  assert.ok(c.dimensions.penetration[0].pct > 0, 'the lesson reaches CKD knowledge');
});

test('gaps: each rule with its recommended action', () => {
  const x = { canon: [{ id: 'obj.c.a', name: 'A', c: 'c.a', specialty: 'spec.nephrology' }, { id: 'obj.c.b', name: 'B', c: 'c.b' }, { id: 'obj.c.e', name: 'E', c: 'c.e' }], supported: new Set(['obj.c.b', 'obj.c.e']),
    recObj: new Set(['obj.c.e']), evObj: new Set(), lessonObj: new Set(['obj.c.e']), curObj: new Set(), topics: [{ t: 'bpt.x', f: 'fam', p: 80, name: 'X', b: 'bp' }],
    topicObjs: new Map([['bpt.x', ['obj.c.a']]]), objPri: new Map([['obj.c.a', 80], ['obj.c.b', 60]]), topicLessons: new Set() };
  const g = Object.fromEntries(gapRules(x, { specialtyRows: [{ key: 'spec.pediatrics', num: 0, den: 0, sources: 0 }], orgsBySpecialty: { 'spec.nephrology': ['KDIGO'] }, today: '2026-10-25',
    sources: [{ id: 'src.old', name: 'Old', spec: 'Guidelines', year: 2010, md: { version_date: '2010' } }, { id: 'src.rev', name: 'Rev', spec: 'Guidelines', md: { version_date: '2024', review_date: '2025-01-01' } }],
    citedSuperseded: [{ id: 'src.sup', name: 'Sup', n: 2, replaced_by: 'src.new' }], lowLessons: [{ id: 'ea.s.les.x', name: 'L', score: 0.3 }] }).map((r) => [r.gap_id, r]));
  assert.equal(g['objective:obj.c.a'].action.type, 'recommended_acquisition'); assert.deepEqual(g['objective:obj.c.a'].action.organizations, ['KDIGO']); assert.equal(g['objective:obj.c.a'].severity, 0.8);
  assert.equal(g['exam:bpt.x'].action.type, 'recommended_acquisition');
  assert.equal(g['lesson:obj.c.b'].action.type, 'recommended_lesson');
  assert.equal(g['evidence:obj.c.e'].action.type, 'recommended_trial');
  assert.equal(g['specialty:spec.pediatrics'].action.type, 'recommended_acquisition');
  assert.equal(g['update:src.old'].action.reason, 'older than 8 years'); assert.equal(g['update:src.rev'].action.reason, 'past its review date');
  assert.equal(g['update:src.sup'].action.replaced_by, 'src.new'); assert.equal(g['confidence:ea.s.les.x'].action.type, 'recommended_update');
});

test('specialties: Primary Care, Pediatrics and Critical Care; an unknown folder is a proposal awaiting review, never silent', async () => {
  assert.equal(specialtyOf(['Critical Care']), 'spec.critical_care'); assert.equal(specialtyOf(['Pulmonary']), 'spec.pulmonology');
  assert.equal(specialtyOf(['Pediatrics']), 'spec.pediatrics'); assert.equal(specialtyOf(['Family Medicine']), 'spec.primary_care');
  const env = await fresh(); resetSpecialtyCache();
  const f = { id: 'fileSleep1', title: 'AASM Guideline on insomnia 2025.pdf', mimeType: 'application/pdf', md5: 'a', modifiedTime: '2026-01-01', fileSize: '10' };
  await registerFile(env, f, ['Sleep Medicine']);
  const p = await getObject(env, 'spec.sleep_medicine');
  assert.equal(p.status, 'modified'); assert.equal(p.governance_status, 'pending_validation'); assert.deepEqual(p.proposed.sources, ['src.filesleep1']);
  assert.deepEqual((await getObject(env, 'src.filesleep1')).specialty, [], 'not assigned before review');
  assert.ok(await env.DB.prepare("SELECT 1 AS x FROM mk_audit WHERE action = 'specialty_proposed'").first());
  const r = await reviewSpecialty(env, { email: 'owner' }, { id: 'spec.sleep_medicine', result: 'approve' });
  assert.equal(r.sources_assigned, 1); assert.deepEqual((await getObject(env, 'src.filesleep1')).specialty, ['spec.sleep_medicine']);
  await registerFile(env, { ...f, id: 'fileSleep2', title: 'Sleep apnea guideline 2024.pdf' }, ['Sleep Medicine']);
  assert.deepEqual((await getObject(env, 'src.filesleep2')).specialty, ['spec.sleep_medicine'], 'approved folders resolve');
  await registerFile(env, { ...f, id: 'fileX', title: 'Notes.pdf' }, ['Wellness Coaching']);
  assert.equal((await reviewSpecialty(env, { email: 'owner' }, { id: 'spec.wellness_coaching', result: 'reject' })).sources_assigned, 0);
  assert.equal((await getObject(env, 'spec.wellness_coaching')).status, 'retired');
});

test('prompt wording: ABIM internal medicine prompts are byte-identical to before; other families are worded from their data', () => {
  const H = (s) => createHash('sha256').update(s).digest('hex');
  const bt = { category: 'Nephrology', subcategory: 'Chronic kidney disease', est_pct: 1.2, importance: 'HHMM', low_frequency: false };
  const before = { seed: '153dd619ff96681f04568fcdf04ab213dc1100ff2ba090e9fce74c9dd5dbbfac', seed0: '5d1f2b43ff1d9280251b0baae330bebf360283677ed8579826dd11e3c983e622', qspec: '5dfe8183fa0bb7c44d40f32a7a78aefab57d3d4a461e13d128d1a7291c36324a',
    board: 'f0ede39d7c2bcbffa53f4eaba32371fa9e9d411b856d83628b2f99213a583665', pearl: 'a4b6cd535ca6433e389ee4a8efb028cd80e92f4a95347987eb82c9c5235f9b36' };
  for (const fam of [undefined, 'abim_im_cert', 'abim_im_lka']) {
    const W = fam ? wordingFor(fam) : undefined;
    assert.equal(H(seedRules(bt, 'Chronic kidney disease', 'KDIGO 2024', W)), before.seed, 'seed rules ' + fam);
    assert.equal(H(seedRules({}, 'X', '', W)), before.seed0); assert.equal(H(qspec(W)), before.qspec); assert.equal(H(boardLevel(W)), before.board);
  }
  assert.equal(H(PEARL_PROMPT({ name: 'Albuminuria' }, [{ statement: 'Measure ACR yearly.', strength_original: '1', loe_original: 'B' }])), before.pearl);
  const cv = wordingFor('abim_cardiology');
  assert.match(seedRules(bt, 'Heart failure', '', cv), /for physicians in cardiovascular disease\./); assert.match(qspec(cv), /the ABIM Cardiovascular Disease Certification\./);
  assert.ok(!/internal medicine/i.test(seedRules({}, 'X', '', cv)));
  assert.equal(examKeyOf('abim_im_lka'), 'lka'); assert.equal(examKeyOf('abim_im_cert'), 'cert'); assert.equal(examKeyOf('abim_cardiology'), 'cert');
});

test('enhancements are durable: mirrored to Drive and restored', async () => {
  const { mirrorStep } = await import('../src/mkos/mirror.js');
  const { restoreStep } = await import('../src/mkos/restore.js');
  const env = await built(await fresh()); await lesson(env); await newGuideline(env); await settle(env, 14);
  const files = new Map(); let n = 0;
  const deps = { upload: async (o) => { const id = o.id || 'f' + (++n); files.set(id, { ...o, id }); return id; }, mkdir: async (name, parent) => { const id = 'd' + (++n); files.set(id, { name, parent, id, dir: true }); return id; },
    list: async (parent) => ({ files: [...files.values()].filter((f) => f.parent === parent).map((f) => ({ id: f.id, title: f.name })) }), readMine: async (id) => JSON.parse(files.get(id).text) };
  for (let i = 0; i < 8; i++) await mirrorStep(env, deps, 'root', { max: 80 });
  const ef = [...files.values()].find((f) => f.name === 'enhancements.json'); assert.ok(ef); assert.equal(JSON.parse(ef.text).count, 2);
  assert.ok(![...files.values()].some((f) => /penetration|coverage|gaps|layers|confidence/.test(f.name || '')), 'derived tables are not written');
  const env2 = await fresh(), prog = {};
  for (let i = 0; i < 30; i++) { const r = await restoreStep(env2, deps, 'root', prog, { rowsPerStep: 5000 }); if (r.done) break; }
  assert.deepEqual((await env2.DB.prepare('SELECT asset_id, object_id, kind, asset_version FROM mk_enhancements ORDER BY object_id').all()).results,
    (await env.DB.prepare('SELECT asset_id, object_id, kind, asset_version FROM mk_enhancements ORDER BY object_id').all()).results);
});
