// DADD-AI (the Department of Advancing the Development of Deterministic AI, USAP): confidence triage of AI-made MKOS assets, the owner's
// review, learner reports, the source-ingestion procedure events, coverage gap events and the daily health report.
// Synthetic fixtures only. Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from '../tools/mkos/d1shim.mjs';
import { mkInit, _resetInit } from '../src/mkos/db.js';
import { getObject } from '../src/mkos/kb.js';
import { putAssets, findAsset, reportAsset, flagAsset, assetQueue, decideAsset, reviewAsset } from '../src/mkos/assets.js';
import { assetFlags } from '../src/mkos/bridge.js';
import { detectGaps } from '../src/mkos/coverage.js';
import { registerFile } from '../src/mkos/ingest.js';
import { readRecord, enterLifecycle } from '../src/mkos/lifecycle_state.js';
import { bindDadd, domains, composite, routeBands, assess, policyFor, DEFAULT_BANDS, _resetPolicyCache, healthReport, procedureCompleted } from '../src/mkos/dadd.js';
import { mkosCall } from '../src/mkos/routes.js';

async function fresh() { _resetInit(); _resetPolicyCache(); const env = { DB: d1(':memory:', { strict: true }) }; await mkInit(env); return env; }
const recorder = () => { const evs = []; bindDadd({ emit: (t, e) => evs.push({ type: t, ...e }) }); return evs; };
const A = { id: 'u1', email: 'a@example.test' }, B = { id: 'u2', email: 'b@example.test' }, OWNER = { id: 'own', email: 'owner@example.test' };
const Q = (stem) => ({ stem, opts: ['one', 'two', 'three', 'four'], ans: 0, exp: 'because' });
const putQ = (env, u, stem, extra = {}) => putAssets(env, u, { kind: 'question', tid: 'cardio.hf', name: 'Heart failure', level: 3, items: [{ content: Q(stem), validated: true, sources: [], ...extra }] });

test('domains, composite and the MKOS critical bands (green, yellow, orange, red)', () => {
  const full = domains({ cited: 2, cited_current: 2, recs: [{ validated: true }, { validated: true }, { method: 'deterministic_parse' }], families: 1, objectives: 3, concepts: 4, review_status: 'validated', flagged: 0, history: { n: 0 } });
  assert.equal(full.review, 0.5); assert.equal(full.source, 1); assert.equal(full.evidence, 1); assert.ok(full.extraction > 0.9);
  const c = composite(full); assert.ok(c >= 0.9 && c < 0.95, 'a fully grounded new asset with no owner history is yellow: ' + c);
  assert.deepEqual(routeBands(DEFAULT_BANDS.critical, 0.97), { action: 'live', band: 'green' });
  assert.deepEqual(routeBands(DEFAULT_BANDS.critical, 0.92), { action: 'live_flagged', band: 'yellow' });
  assert.deepEqual(routeBands(DEFAULT_BANDS.critical, 0.85), { action: 'review_hold', band: 'orange' });
  assert.deepEqual(routeBands(DEFAULT_BANDS.critical, 0.5), { action: 'review_hold', band: 'red' });
  // An older policy that still says "drop" is held for review instead (no drop band for MKOS).
  assert.equal(routeBands([{ min: 0.95, action: 'live_review_later' }, { min: 0.8, action: 'review_hold' }, { min: 0, action: 'drop' }], 0.2).action, 'review_hold');
  // Unmeasured domains are left out and the weights renormalize.
  assert.equal(composite({ source: 1, evidence: 1 }), 1);
  const a = assess({ source: 1, evidence: 1, objective_mapping: 1, ontology: 1, generation: 1, review: 1 }, DEFAULT_BANDS, { random: () => 0 });
  assert.equal(a.band, 'green'); assert.equal(a.failure_mode, null); assert.equal(a.queue, null);
  const h = assess({ source: 1, evidence: 1, objective_mapping: 1, ontology: 1, generation: 1, review: 1 }, DEFAULT_BANDS, { hard: 'source_currency' });
  assert.equal(h.action, 'review_hold'); assert.equal(h.band, 'red'); assert.equal(h.failure_mode, 'source_currency'); assert.equal(h.severity, 'high');
  const y = assess({ ...full }, DEFAULT_BANDS, { random: () => 0 });
  assert.equal(y.band, 'yellow'); assert.equal(y.severity, 'low'); assert.equal(y.queue, 'monitor'); assert.equal(y.sampled, true);
  assert.ok(y.contributing.every((k) => k !== y.failure_mode));
});

test('the review policy comes from USAP (cached), and the defaults when USAP cannot answer', async () => {
  _resetPolicyCache();
  let calls = 0;
  const env = { USAP_UGF: { fetch: async (url, init) => { calls++; assert.match(url, /\/api\/v1\/governance\/review\/policy\?kind=lesson$/); assert.equal(init.headers['x-usap-app'], 'doctor_companion_app');
    return new Response(JSON.stringify({ critical: [{ min: 0.97, action: 'live' }, { min: 0.92, action: 'live_flagged' }, { min: 0.82, action: 'review_hold' }, { min: 0, action: 'review_hold' }], standard: [], sampling_rate: 0.04, floor_delta: 0.02 })); } } };
  const p = await policyFor(env, 'lesson'); await policyFor(env, 'lesson');
  assert.equal(calls, 1); assert.equal(p.from, 'usap'); assert.equal(p.critical[0].min, 0.97); assert.equal(p.sampling_rate, 0.04);
  const down = await policyFor({ USAP_UGF: { fetch: async () => { throw new Error('down'); } } }, 'question');
  assert.equal(down.from, 'default'); assert.deepEqual(down.critical, DEFAULT_BANDS.critical);
  assert.equal((await policyFor({}, 'flashcard')).from, 'default');
});

test('a low-confidence shared asset is held from other learners, seen by the owner, assessed once, and released by accept', async () => {
  const env = await fresh(), evs = recorder();
  const r = await putQ(env, A, 'A 60-year-old man has dyspnea. What next?');
  const st = r.stored[0]; assert.equal(st.triage.band, 'red'); assert.equal(st.triage.action, 'review_hold');
  const o = await getObject(env, st.id);
  assert.deepEqual(o.needs, ['review']); assert.equal(o.triage.queue, 'held'); assert.equal(o.triage.kind, 'question'); assert.equal(o.triage.critical, true);
  const ca = evs.filter((e) => e.type === 'ContentAssessed');
  assert.equal(ca.length, 1); assert.equal(ca[0].user_id, null); assert.equal(ca[0].node_id, st.id);
  assert.match(ca[0].idempotency_key, new RegExp(`^doctor_companion_app:${st.id.replace(/\./g, '\\.')}:[0-9a-f]{12}:ContentAssessed$`));
  const m = ca[0].metadata; assert.equal(typeof m.scores, 'object'); assert.ok(Array.isArray(m.contributing)); assert.equal(m.label, 'Heart failure'); assert.equal(m.severity, 'high');
  assert.ok(!JSON.stringify(ca[0]).includes('example.test'), 'no email in the event');
  // The same content again: no new assessment.
  await putQ(env, A, 'A 60-year-old man has dyspnea. What next?');
  assert.equal(evs.filter((e) => e.type === 'ContentAssessed').length, 1);
  // Another learner is not served it; the owner is.
  assert.equal((await findAsset(env, B, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 })).items.length, 0);
  assert.equal((await findAsset(env, OWNER, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5, _owner: true })).items.length, 1);
  assert.deepEqual((await getObject(env, st.id)).needs, ['review'], 'the owner\'s look writes nothing back');
  // The learner's flag list does not call a triage hold a knowledge change.
  assert.equal((await assetFlags(env, A)).flags[st.id], undefined);
  // The owner's queue lists it; accept releases it.
  const q = await assetQueue(env, OWNER, {}); assert.equal(q.agency, 'DADD-AI'); assert.equal(q.counts.held, 1); assert.equal(q.items[0].id, st.id); assert.equal(q.items[0].band, 'red');
  const one = await assetQueue(env, OWNER, { id: st.id }); assert.equal(one.content.stem, 'A 60-year-old man has dyspnea. What next?');
  const vReviewed = (await getObject(env, st.id)).version;
  const d = await decideAsset(env, OWNER, { id: st.id, decision: 'accept' }); assert.equal(d.ok, true);
  const after = await getObject(env, st.id);
  assert.deepEqual(after.needs, []); assert.equal(after.triage.queue, null); assert.equal(after.triage.review.decision, 'accept'); assert.equal(after.triage.review.reviewer, 'owner'); assert.equal(after.triage.review.version, vReviewed);
  assert.equal((await findAsset(env, B, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 })).items.length, 1);
  const rd = evs.find((e) => e.type === 'ReviewDecided');
  assert.deepEqual({ ...rd.metadata, confidence_before: typeof rd.metadata.confidence_before }, { kind: 'question', decision: 'accept', reported: false, sampled: false, band: 'red', asset_id: st.id, confidence_before: 'number' });
  // Past owner decisions raise the review domain of the next question.
  await putQ(env, A, 'A second stem about heart failure?');
  const next = evs.filter((e) => e.type === 'ContentAssessed').pop();
  assert.ok(next.metadata.scores.review > 0.5);
  // A live owner-reviewed asset is never replaced by a new AI version.
  assert.equal((await assetQueue(env, OWNER, {})).counts.held, 1);
});

test('edit is a new owner version superseding the AI one; reject retires; asset_review maps onto the decisions', async () => {
  const env = await fresh(), evs = recorder();
  const id = (await putQ(env, A, 'Edit me?')).stored[0].id, v0 = (await getObject(env, id)).version;
  const e = await decideAsset(env, OWNER, { id, decision: 'edit', content: Q('Edited by the owner?') });
  assert.equal(e.ok, true); assert.notEqual(e.version, v0); assert.equal(typeof e.confidence_after, 'number');
  const o = await getObject(env, id);
  assert.equal(o.triage.review.decision, 'edit'); assert.equal(o.triage.review.supersedes_version, v0); assert.equal(o.reviewed_by, 'owner');
  assert.equal(o.provenance.at(-1).method, 'owner_edit');
  const served = await findAsset(env, B, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 });
  assert.equal(served.items[0].content.stem, 'Edited by the owner?');
  const rd = evs.filter((x) => x.type === 'ReviewDecided').pop(); assert.equal(rd.metadata.decision, 'edit'); assert.equal(rd.metadata.confidence_after, e.confidence_after);
  // A later AI rewrite of the same item (same stem, so the same id) does not replace the owner's version.
  const kept = await putAssets(env, A, { kind: 'question', tid: 'cardio.hf', level: 3, items: [{ content: { ...Q('Edit me?'), exp: 'a new AI explanation' }, validated: true }] });
  assert.equal(kept.stored[0].id, id); assert.equal(kept.stored[0].review_status, 'kept_owner_reviewed'); assert.equal(kept.stored[0].changed, false);
  const id2 = (await putQ(env, A, 'Reject me?')).stored[0].id;
  assert.equal((await reviewAsset(env, OWNER, { id: id2, result: 'retire' })).ok, true);
  assert.equal((await getObject(env, id2)).status, 'retired'); assert.equal((await getObject(env, id2)).triage.review.decision, 'reject');
  const id3 = (await putQ(env, A, 'Fine as is?')).stored[0].id;
  assert.equal((await reviewAsset(env, OWNER, { id: id3, result: 'ok' })).ok, true);
  assert.equal((await getObject(env, id3)).triage.review.decision, 'accept');
  assert.equal((await decideAsset(env, OWNER, { id: id3, decision: 'maybe' })).error, 'decision must be accept, edit or reject');
});

test('learner reports: one per person, hidden from others, flagged reported in the queue, ContentReported without personal data', async () => {
  const env = await fresh(), evs = recorder();
  const id = (await putQ(env, A, 'Reported question?')).stored[0].id;
  await decideAsset(env, OWNER, { id, decision: 'accept' });
  assert.equal((await findAsset(env, B, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 })).items.length, 1);
  const r1 = await reportAsset(env, B, { id, reason: 'unsafe' }); assert.equal(r1.ok, true); assert.equal(r1.reported, 1);
  const r2 = await reportAsset(env, B, { id, reason: 'wrong' }); assert.equal(r2.already, true);
  await flagAsset(env, A, { id, reason: 'Reported from the lesson screen' }, false);   // the older page's call counts as "other"
  const o = await getObject(env, id);
  assert.equal(o.triage.reported.n, 2); assert.deepEqual(o.triage.reported.reasons, { unsafe: 1, other: 1 }); assert.deepEqual(o.needs, ['review']);
  const rows = (await env.DB.prepare('SELECT * FROM mk_asset_reports').all()).results;
  assert.equal(rows.length, 2); assert.deepEqual(Object.keys(rows[0]).sort(), ['acct', 'asset_id', 'at', 'reason']);
  assert.ok(rows.every((r) => /^[0-9a-f]{16}$/.test(r.acct) && r.acct !== 'u1' && r.acct !== 'u2'));
  const C = { id: 'u3', email: 'c@example.test' };
  assert.equal((await findAsset(env, C, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 })).items.length, 0);
  const q = await assetQueue(env, OWNER, {}); assert.equal(q.items[0].id, id); assert.equal(q.items[0].reported.n, 2);
  const cr = evs.filter((e) => e.type === 'ContentReported');
  assert.equal(cr.length, 2); assert.deepEqual(cr[0].metadata, { kind: 'question', reason: 'unsafe' }); assert.equal(cr[0].user_id, null);
  assert.notEqual(cr[0].idempotency_key, cr[1].idempotency_key);
  assert.ok(!cr.some((e) => /u[123]\b|example\.test/.test(e.idempotency_key)));
  await decideAsset(env, OWNER, { id, decision: 'accept' });
  const rd = evs.filter((e) => e.type === 'ReviewDecided').pop(); assert.equal(rd.metadata.reported, true);
  assert.equal((await findAsset(env, C, { kind: 'question', tid: 'cardio.hf', level: 3, n: 5 })).items.length, 1);
  assert.equal((await reportAsset(env, B, { id: 'ea.s.q.nothing.here' })).error, 'not found');
});

test('personalized adaptations keep their behaviour; the owner import is not triaged; the routes are wired and owner-gated', async () => {
  const env = await fresh(), evs = recorder();
  const p = await putAssets(env, A, { kind: 'question', tid: 'cardio.hf', level: 3, personal: true, items: [{ content: Q('Mine?'), validated: true, local_id: 'q1' }] });
  const o = await getObject(env, p.stored[0].id); assert.equal(o.triage, undefined); assert.equal(p.stored[0].triage, undefined);
  const imp = await putAssets(env, OWNER, { kind: 'question', tid: 'cardio.hf', level: 3, items: [{ content: Q('Imported?'), validated: true }] }, { triage: false });
  assert.equal((await getObject(env, imp.stored[0].id)).triage, undefined);
  assert.equal(evs.length, 0);
  assert.equal((await mkosCall(env, A, 'asset_queue', {}, { owner: false })).status, 403);
  assert.equal((await mkosCall(env, A, 'asset_decide', { id: imp.stored[0].id, decision: 'accept' }, { owner: false })).status, 403);
  assert.equal((await mkosCall(env, OWNER, 'asset_queue', {}, { owner: true })).status, 200);
  assert.equal((await mkosCall(env, B, 'asset_report', { id: imp.stored[0].id, reason: 'duplicate' }, { owner: false })).body.ok, true);
});

test('SourceIngested on a new or changed source (by md5), ProcedureCompleted once its ingestion finishes or is replaced', async () => {
  const env = await fresh(), evs = recorder();
  const f = { id: 'FILE1', title: 'KDIGO 2024 CKD Guideline.pdf', mimeType: 'application/pdf', fileSize: '100', md5: 'abcdef0123456789abcdef0123456789', modifiedTime: '2026-10-01T00:00:00Z', parentId: 'p' };
  await registerFile(env, f, ['Nephrology', 'Guidelines']);
  const si = evs.filter((e) => e.type === 'SourceIngested');
  assert.equal(si.length, 1); assert.equal(si[0].idempotency_key, 'doctor_companion_app:src.file1:abcdef012345:SourceIngested'); assert.equal(si[0].user_id, null);
  assert.equal((await readRecord(env, 'src.file1')).doc.trigger, si[0].idempotency_key);
  await registerFile(env, f, ['Nephrology', 'Guidelines']);   // unchanged: nothing
  assert.equal(evs.filter((e) => e.type === 'SourceIngested').length, 1);
  await registerFile(env, { ...f, md5: '99999999999999999999999999999999' }, ['Nephrology', 'Guidelines']);   // changed before it finished
  const si2 = evs.filter((e) => e.type === 'SourceIngested'); assert.equal(si2.length, 2); assert.match(si2[1].idempotency_key, /:999999999999:SourceIngested$/);
  const skipped = evs.find((e) => e.type === 'ProcedureCompleted');
  assert.equal(skipped.metadata.outcome, 'skipped'); assert.equal(skipped.metadata.trigger, si[0].idempotency_key); assert.equal(skipped.metadata.procedure, 'sop.source_ingestion');
  assert.match(skipped.idempotency_key, /^doctor_companion_app:[0-9a-f]{16}:ProcedureCompleted$/);
  assert.equal((await readRecord(env, 'src.file1')).doc.trigger, si2[1].idempotency_key);
  // A trigger with no trigger key (older cycles) reports nothing; the completion carries the counts it is given.
  assert.equal((await enterLifecycle(env, 'src.other', { event: 'source_added' })).replaced, undefined);
  await procedureCompleted('k', { steps: 2, ai_calls: 3, written: 7 });
  const pc = evs.filter((e) => e.type === 'ProcedureCompleted').pop().metadata;
  assert.deepEqual(pc, { procedure: 'sop.source_ingestion', trigger: 'k', steps: 2, ai_calls: 3, queued_review: 0, written: 7, outcome: 'ok', label: '' });
});

test('coverage gaps: CoverageGapDetected when an objective with exam weight has no lesson, CoverageGapClosed when it gets one, only on change', async () => {
  const env = await fresh(), evs = recorder();
  const facts = (withLesson) => ({ canon: [{ id: 'obj.c.heart_failure', name: 'Heart failure', c: 'c.disease.heart_failure', specialty: null }], supported: new Set(['obj.c.heart_failure']), recObj: new Set(), evObj: new Set(),
    lessonObj: new Set(withLesson ? ['obj.c.heart_failure'] : []), curObj: new Set(), topics: [], topicObjs: new Map(), objPri: new Map([['obj.c.heart_failure', 60]]), topicLessons: new Set() });
  await detectGaps(env, facts(false)); await detectGaps(env, facts(false));
  const det = evs.filter((e) => e.type === 'CoverageGapDetected'); assert.equal(det.length, 1);
  assert.deepEqual(det[0].metadata, { area_id: 'lesson:obj.c.heart_failure', area: 'Heart failure', measure: 'lessons_for_objective', value: 0, target: 1, queue: 'recommended_lesson' });
  assert.equal(det[0].node_id, 'lesson:obj.c.heart_failure');
  await detectGaps(env, facts(true)); await detectGaps(env, facts(true));
  const cl = evs.filter((e) => e.type === 'CoverageGapClosed'); assert.equal(cl.length, 1); assert.equal(cl[0].metadata.area_id, 'lesson:obj.c.heart_failure'); assert.equal(cl[0].metadata.value, 1);
});

test('the daily DADD-AI health report sends only what it can compute', async () => {
  const env = await fresh(); recorder();
  const id = (await putQ(env, A, 'Health?')).stored[0].id; void id;
  const out = {}; await healthReport(env, (k, v) => { out[k] = v; });
  assert.equal(out.dadd_ai_failure_rate, 1); assert.ok(out.dadd_ai_overall_confidence > 0 && out.dadd_ai_overall_confidence < 1);
  assert.equal(out.dadd_ai_evidence_linkage, 0); assert.equal(typeof out.dadd_ai_population_velocity, 'number');
  assert.ok(!('dadd_ai_objective_coverage' in out), 'no blueprint objectives yet: nothing sent');
  for (const [k, v] of Object.entries(out)) if (k !== 'dadd_ai_population_velocity') assert.ok(v >= 0 && v <= 1, k);
});
