// ITE -> blueprint objective mapping v2 (src/mkos/ite.js): the mapping order (exact, fuzzy, then the shortlist for AI), no AI when the
// central library answers, confirmations strengthen the central mapping and never performance, eligibility without lessons, blueprint
// separation, the pipeline trace for every failure reason, the audit invariant, an idempotent migration, and no user identity in the
// central layer. Synthetic fixtures only (made-up wording, no ITE or library content). Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from '../tools/mkos/d1shim.mjs';
import { mkInit, _resetInit } from '../src/mkos/db.js';
import { APP_TABLES } from '../src/mkos/restore.js';
import { _resetGenInit, genInit } from '../src/mkos/genjobs.js';
import { iteNorm, famOf, isEligible, deriveRecords, mapItems, confirmCentral, confirmIte, centralMatch, iteConfig, buildTrace, traceFor, auditAll,
  ensureMigrated, migrateSweep, mappingRows, restoreMappingStmt, reportId, PERF, TRACE, MIG, ITE, MAP } from '../src/mkos/ite.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
async function fresh() {
  _resetInit(); _resetGenInit(); const env = { DB: d1(':memory:', { strict: true }) }; await mkInit(env);
  await env.DB.batch(APP_TABLES.map((q) => env.DB.prepare(q))); await genInit(env);
  const topic = (id, name, category, sub) => env.DB.prepare("INSERT INTO mk_objects (id, type, name, norm, specialty, status, gov, version, trust, conf, hash, body, created, updated) VALUES (?, 'BlueprintTopic', ?, ?, NULL, 'current', 'validated', '1.0.0', 50, 50, 'h', ?, '2026-10-01', '2026-10-01')")
    .bind(id, name, name.toLowerCase(), JSON.stringify({ id, type: 'BlueprintTopic', name, category, subcategory: sub, code: id.split('.').slice(2).join('.'), blueprint: 'bp.' + id.split('.')[1] }));
  await env.DB.batch([
    topic('bpt.cert.HEM.001', 'Fictional platelet disorder alpha', 'Hematology', 'Platelets'), topic('bpt.cert.HEM.002', 'Fictional anemia beta', 'Hematology', 'Anemia'),
    topic('bpt.cert.PUL.001', 'Fictional lung spot gamma', 'Pulmonary Disease', 'Nodules'), topic('bpt.lka.HEM.001', 'Fictional platelet disorder alpha', 'Hematology', 'Platelets'),
    topic('bpt.lka.PUL.001', 'Fictional lung spot gamma', 'Pulmonary Disease', 'Nodules'),
    env.DB.prepare("INSERT INTO mk_edges (src, rel, dst, status, conf, prov, created, updated) VALUES ('bpt.cert.HEM.001', 'projects_objective', 'obj.c.disease.fictional_alpha', 'current', 80, '[]', '2026-10-01', '2026-10-01')"),
  ]);
  return env;
}
const docsOf = (env) => async (uid, paths) => { const out = {}; for (const p of paths) { const r = await env.DB.prepare('SELECT body FROM docs WHERE user_id = ? AND path = ?').bind(String(uid), p).first(); if (r) out[p] = JSON.parse(r.body); } return out; };
const putDoc = (env, uid, path, obj) => env.DB.prepare('INSERT OR REPLACE INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?)').bind(uid, path, JSON.stringify(obj), '2026-10-20T00:00:00Z').run();
const depsOf = (env, extra = {}) => { const calls = []; return { calls, userDocs: docsOf(env), ownerId: async () => 'owner0', genModels: async () => ({ server: ['gemini'], first: 'gemini' }), recordDeterministic: (a, d) => calls.push(a), ...extra }; };
const TEXT = 'Treat fictional platelet disorder alpha in an adult with severe bleeding';
// A report as the page stores it (med/ite), with items in every state.
const report = (over = {}) => ({ exam: 'Synthetic ITE', year: '2026', t: Date.parse('2026-10-20T00:00:00Z'), rid: 'rtest1', mapped: 'cert', bp: 'abim_im_cert', areas: [], v: 2, missed: [
  { text: TEXT, area: 'Hematology', status: 'ok', src: 'ai', conf: 92, objective: 'bpt.cert.HEM.001', oname: 'Fictional platelet disorder alpha', ocat: 'Hematology', osub: 'Platelets', opri: 70, tid: 'b-hem.alpha', ct: Date.parse('2026-10-21T00:00:00Z') },
  { text: 'Recognize fictional anemia beta', area: 'Hematology', status: 'pending', src: 'lex', conf: 41, prop: ['bpt.cert.HEM.002'], ttid: '' },
  { text: 'A fictional item never mapped', area: '', status: 'pending', ttid: '' },
  { text: 'A fictional item with no objective', area: 'General', status: 'none', src: 'you', tid: '' },
  { text: 'A fictional topic-only item', area: 'General', status: 'none', src: 'you', tid: 'own.topic-x' },
  { text: 'Evaluate fictional lung spot gamma', area: 'Pulmonary', status: 'ok', src: 'central', conf: 100, objective: 'bpt.cert.PUL.001', oname: 'Fictional lung spot gamma', ocat: 'Pulmonary Disease', osub: 'Nodules', opri: 50, tid: 'b-pul.gamma' },
], ...over });

test('normalized wording and blueprint families come from the data', () => {
  assert.equal(iteNorm('Treat ITP in an adult with severe thrombocytopenia'), 'treat itp adult severe thrombocytopenia');
  assert.equal(famOf('cert').id, 'abim_im_cert'); assert.equal(famOf('lka').id, 'abim_im_lka'); assert.equal(famOf('abim_im_lka').exam_key, 'lka');
});

test('mapping order: exact, then fuzzy >= 0.90, then the discipline shortlist for the one AI call; no AI when the library answers', async () => {
  const env = await fresh(), deps = depsOf(env);
  await confirmCentral(env, { blueprint: 'abim_im_cert', exam_key: 'cert', text: TEXT, area: 'Hematology', ids: ['bpt.cert.HEM.001'], method: 'ai_reviewed', confidence: 90 });
  const items = [{ text: 'TREAT fictional platelet disorder alpha, in an adult with SEVERE bleeding.', area: 'Hematology' }, { text: 'Treat fictional platelet disorder alpha in adults with severe bleeding', area: 'Hematology' },
    { text: 'Evaluate a fictional lung spot gamma found by chance', area: 'Pulmonary and Critical Care' }];
  const R = await mapItems(env, { id: 'u1' }, { family: 'cert', items, central: true }, deps);
  assert.equal(R.blueprint, 'abim_im_cert');
  assert.equal(R.items[0].central.step, 'exact'); assert.deepEqual(R.items[0].central.ids, ['bpt.cert.HEM.001']);
  assert.equal(R.items[1].central.step, 'fuzzy'); assert.ok(R.items[1].central.score >= 90);
  assert.equal(R.items[2].central, undefined);
  assert.deepEqual(R.ai, [2], 'only the unmatched item goes to the AI');
  assert.deepEqual(R.steps, { exact: 1, fuzzy: 1, ai: 1 });
  assert.equal(deps.calls.filter((c) => c === 'ite_objective_map').length, 2, 'each library answer is recorded as deterministic');
  const cfg = await iteConfig(env);
  assert.ok(R.items[2].near.length >= 1 && R.items[2].near.length <= cfg.shortlist_size, 'a shortlist of at most shortlist_size');
  assert.ok(R.items[2].near.includes('bpt.cert.PUL.001'));
  assert.deepEqual(R.pools, {}, 'the whole discipline is not offered unless whole_discipline is set');
  assert.ok(R.objectives['bpt.cert.HEM.001'], 'details of the objectives the library proposed');
  // An unrelated wording below the fuzzy threshold is not matched.
  const [miss] = await centralMatch(env, 'abim_im_cert', ['Manage fictional anemia beta in pregnancy'], cfg); assert.equal(miss, null);
});

test('a confirmation strengthens the central mapping (mapping only), counts once on retry, and creates only that account\'s records', async () => {
  const env = await fresh(), deps = depsOf(env);
  const entry = (n) => ({ report_id: 'rtest1', item: 0, exam_key: 'cert', text: TEXT, area: 'Hematology', ids: ['bpt.cert.HEM.001'], method: 'ai', conf: 92, n,
    recs: [{ objective_id: 'bpt.cert.HEM.001', oname: 'Fictional platelet disorder alpha', tid: 'b-hem.alpha', date: '2026-10-21' }] });
  const a = await confirmIte(env, deps, { id: 'userA' }, { items: [entry('nonce-1')] });
  assert.equal(a.central, 1); assert.equal(a.perf.r.length, 1);
  assert.ok(isEligible(a.perf.r[0]) && isEligible(a.perf.r[0], 'cert'));
  let row = await env.DB.prepare('SELECT * FROM mk_ite_map').first();
  assert.equal(row.confirmations, 1); assert.equal(row.method, 'ai_reviewed'); assert.equal(row.confidence, 0.92); assert.equal(row.canonical_objective, 'obj.c.disease.fictional_alpha'); assert.equal(row.discipline, 'Hematology');
  const again = await confirmIte(env, deps, { id: 'userA' }, { items: [entry('nonce-1')] });
  assert.equal(again.retries, 1); assert.equal((await env.DB.prepare('SELECT confirmations FROM mk_ite_map').first()).confirmations, 1, 'a retried confirmation counts once');
  await confirmIte(env, deps, { id: 'userB' }, { items: [{ ...entry('nonce-2'), report_id: 'rother' }] });
  row = await env.DB.prepare('SELECT * FROM mk_ite_map').first();
  assert.equal(row.confirmations, 2, 'a second physician strengthens the same mapping'); assert.equal(row.version, 1, 'strengthening is not a new version');
  // Performance stayed per account: A's records are untouched by B's confirmation, and the central call alone writes no records.
  const docs = await docsOf(env)('userA', [PERF]); assert.equal(docs[PERF].r.length, 1); assert.equal(docs[PERF].r[0].report_id, 'rtest1');
  await confirmCentral(env, { blueprint: 'abim_im_cert', exam_key: 'cert', text: 'Some other fictional wording', ids: [], method: 'human_selected' });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE path = ?").bind(PERF).first()).n, 2, 'only the two confirming accounts have records');
});

test('eligibility is confirmed && !archived and never depends on a lesson; lessons are then queued once and recognised when written', async () => {
  const env = await fresh(), deps = depsOf(env);
  await putDoc(env, 'u1', ITE, report()); await putDoc(env, 'u1', MIG, { v: 1 });
  const recs = deriveRecords(report());
  assert.ok(recs.filter((r) => r.objective_id).every((r) => isEligible(r, 'cert')), 'eligible with no lesson anywhere');
  assert.equal(isEligible({ ...recs[0], archived: true }), false); assert.equal(isEligible({ ...recs[0], confirmed: false }), false);
  const t1 = (await traceFor(env, deps, 'u1', { family: 'cert', now: NOW })).trace;
  const alpha = t1.items[0];
  assert.equal(alpha.eligible, true); assert.equal(alpha.queued, true, 'queued through the seed queue'); assert.equal(alpha.generated, false); assert.equal(alpha.code, 'writing');
  const jobs = (await env.DB.prepare("SELECT objective, batch, user_id, status FROM mk_gen ORDER BY objective").all()).results;
  assert.deepEqual(jobs.map((j) => [j.objective, j.batch, j.user_id, j.status]), [['bpt.cert.HEM.001', 'seed', 'owner0', 'queued'], ['bpt.cert.PUL.001', 'seed', 'owner0', 'queued']]);
  await traceFor(env, deps, 'u1', { family: 'cert', now: NOW });
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_gen').first()).n, 2, 'never queued twice');
  await env.DB.prepare("INSERT INTO mk_objects (id, type, name, norm, status, gov, version, hash, body, created, updated) VALUES ('ea.s.l.fixture', 'EducationalAsset', 'Lesson', 'lesson', 'current', 'validated', '1.0.0', 'h', ?, '2026-10-22', '2026-10-22')")
    .bind(JSON.stringify({ id: 'ea.s.l.fixture', objective: 'bpt.cert.HEM.001' })).run();
  const t2 = (await traceFor(env, deps, 'u1', { family: 'cert', now: NOW })).trace;
  assert.equal(t2.items[0].eligible, true); assert.equal(t2.items[0].generated, true); assert.equal(t2.items[0].stage, 'done'); assert.equal(t2.items[0].objectives[0].lesson, 'ea.s.l.fixture');
  assert.equal(t2.counts.eligible_objectives, 2); assert.equal(t2.counts.generated_objectives, 1);
});

test('blueprint separation: mappings and records belong to a blueprint; nothing is remapped or switched silently', async () => {
  const env = await fresh(), deps = depsOf(env);
  await confirmCentral(env, { blueprint: 'abim_im_cert', exam_key: 'cert', text: TEXT, ids: ['bpt.cert.HEM.001'], method: 'ai_reviewed' });
  const cfg = await iteConfig(env);
  assert.equal((await centralMatch(env, 'abim_im_lka', [TEXT], cfg))[0], null, 'a certification mapping does not answer for LKA');
  await putDoc(env, 'u1', ITE, report()); await putDoc(env, 'u1', MIG, { v: 1 });
  const t = (await traceFor(env, deps, 'u1', { family: 'lka', now: NOW, autoQueue: false })).trace;
  assert.equal(t.exam_key, 'lka'); assert.equal(t.items[0].eligible, false); assert.equal(t.items[0].code, 'wrong_blueprint');
  assert.match(t.items[0].reason, /Certification.*current blueprint is .*LKA/);
  assert.deepEqual(t.other_blueprints.map((o) => o.exam_key), ['cert']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM mk_gen').first()).n, 0, 'nothing queued for the wrong blueprint');
  // Confirming under LKA adds LKA records and keeps the certification ones.
  const r = await confirmIte(env, deps, { id: 'u1' }, { items: [{ report_id: 'rtest1', item: 0, exam_key: 'lka', text: TEXT, ids: ['bpt.lka.HEM.001'], method: 'you', recs: [{ objective_id: 'bpt.lka.HEM.001', tid: 'b-hem.alpha' }] }] });
  const ks = r.perf.r.filter((x) => x.item === 0).map((x) => x.exam_key).sort(); assert.deepEqual(ks, ['cert', 'lka']);
  assert.equal((await env.DB.prepare('SELECT COUNT(DISTINCT blueprint) AS n FROM mk_ite_map').first()).n, 2, 'one mapping per blueprint');
  assert.equal(r.perf.r.find((x) => x.exam_key === 'lka').blueprint, 'abim_im_lka');
});

test('the trace names the step and the reason for every way an item can stall', async () => {
  const env = await fresh(), cfg = await iteConfig(env), d = report();
  const recs = deriveRecords(d).filter((r) => r.item !== 5);   // item 5 confirmed, but its record not stored yet
  const t = buildTrace(d, recs, { cur: 'cert', jobs: { 'bpt.cert.HEM.001': { id: 'j1', objective: 'bpt.cert.HEM.001', status: 'failed', note: 'model error' } }, lessons: {}, queueErr: {}, now: NOW, cfg });
  const by = Object.fromEntries(t.items.map((x) => [x.item, x]));
  assert.equal(by[0].code, 'queue_failed'); assert.match(by[0].reason, /model error/); assert.equal(by[0].stage, 'queued');
  assert.equal(by[1].code, 'not_confirmed'); assert.equal(by[1].mapped, true); assert.equal(by[1].stage, 'confirmed');
  assert.equal(by[2].code, 'not_mapped'); assert.equal(by[2].stage, 'mapped');
  assert.equal(by[3].code, 'no_objective'); assert.equal(by[3].stage, 'done');
  assert.equal(by[4].code, 'topic_only'); assert.equal(by[4].stage, 'done');
  assert.equal(by[5].code, 'not_stored'); assert.equal(by[5].stage, 'stored');
  const t2 = buildTrace(d, deriveRecords(d), { cur: 'cert', jobs: {}, lessons: {}, queueErr: { 'bpt.cert.HEM.001': 'no_writer', 'bpt.cert.PUL.001': 'manual' }, now: NOW, cfg });
  assert.equal(t2.items[0].code, 'no_writer'); assert.equal(t2.items[5].code, 'manual');
  const t3 = buildTrace(d, deriveRecords(d), { cur: 'cert', jobs: { 'bpt.cert.HEM.001': { id: 'j', status: 'queued' } }, lessons: {}, queueErr: { 'bpt.cert.PUL.001': 'no_topic' }, paused: true, now: NOW, cfg });
  assert.equal(t3.items[0].code, 'writing'); assert.match(t3.items[0].reason, /paused/); assert.equal(t3.items[5].code, 'no_topic');
  assert.equal(t.counts.extracted, 6); assert.equal(t.counts.mapped, 5); assert.equal(t.counts.confirmed, 4); assert.equal(t.counts.eligible, 1);
});

test('audit invariant: an item that waits on a step past its threshold is an audit failure, counted without identity', async () => {
  const env = await fresh(), deps = depsOf(env, { genModels: async () => ({ server: [], first: null }) });
  await putDoc(env, 'u1', ITE, report()); await putDoc(env, 'u1', MIG, { v: 1 });
  const first = (await traceFor(env, deps, 'u1', { family: 'cert', now: NOW })).trace;
  assert.equal(first.items[0].code, 'no_writer'); assert.equal(first.items[0].stalled, false);
  const later = NOW + 3 * 864e5, t = (await traceFor(env, deps, 'u1', { family: 'cert', now: later })).trace;
  assert.equal(t.items[0].since, first.items[0].since, 'the wait is measured from when the item reached its step');
  assert.equal(t.items[0].stalled, true, 'past stall_hours.queued');
  assert.ok(t.counts.stalled >= 1);
  const all = await auditAll(env, { now: later });
  assert.equal(all.pass, false); assert.ok(all.stalled >= 1); assert.ok(all.stalled_by_stage.queued >= 1); assert.equal(all.accounts, 1);
  assert.ok(!JSON.stringify(all).includes('u1') && !JSON.stringify(all).includes('fictional'), 'no account id or item text in the cross-account audit');
  const stored = (await docsOf(env)('u1', [TRACE]))[TRACE]; assert.equal(stored.items.length, 6, 'the trace is kept in the account');
  const w = await traceFor(env, deps, 'u1', { family: 'cert', now: later }); assert.equal(w.written, false, 'an unchanged trace is not written again');
});

test('migration: once, idempotent, without user identity, and the records read exactly as the planner reads the report today', async () => {
  const env = await fresh(), deps = depsOf(env), d = report();
  await putDoc(env, 'acct7', ITE, d);
  await putDoc(env, 'acct7', MAP, { v: 1, m: { [TEXT.toLowerCase()]: { text: TEXT, cert: { o: ['bpt.cert.HEM.001'] }, lka: { o: ['bpt.lka.HEM.001'] }, t: 1 }, 'a fictional item with no objective': { text: 'A fictional item with no objective', cert: { none: 1 }, t: 2 } } });
  const m1 = await ensureMigrated(env, deps, 'acct7');
  assert.equal(m1.migrated, true); assert.equal(m1.central, 3); assert.deepEqual(m1.perf.r, deriveRecords(d)); assert.deepEqual(m1.perf.reports, [reportId(d)]);
  const before = await mappingRows(env);
  assert.equal(before.length, 3); assert.ok(before.every((r) => r.confirmations === 1 && r.method === 'migrated' && r.verified === 1));
  assert.ok(before.some((r) => r.objective_id === '' && r.blueprint === 'abim_im_cert'), 'a confirmed "no objective" is central knowledge too');
  const m2 = await ensureMigrated(env, deps, 'acct7'); assert.equal(m2.already, true);
  assert.deepEqual(await mappingRows(env), before, 'running it again changes nothing');
  assert.deepEqual((await migrateSweep(env, deps)).migrated, 0);
  assert.ok((await docsOf(env)('acct7', [MIG]))[MIG]);
  const audits = (await env.DB.prepare("SELECT detail FROM mk_audit WHERE action = 'ite_migrate'").all()).results; assert.equal(audits.length, 1); assert.ok(!audits[0].detail.includes('acct7'));
  // The background sweep migrates accounts nobody has opened.
  await putDoc(env, 'acct8', MAP, { v: 1, m: { x: { text: 'Another fictional wording', cert: { o: ['bpt.cert.HEM.002'] } } } });
  assert.equal((await migrateSweep(env, deps)).migrated, 1);
});

test('no user identity in central rows, their Drive file or their restore', async () => {
  const env = await fresh(), deps = depsOf(env);
  await confirmIte(env, deps, { id: 'user-secret-42' }, { items: [{ report_id: 'report-secret-9', item: 0, exam_key: 'cert', text: TEXT, ids: ['bpt.cert.HEM.001'], method: 'ai', conf: 80, n: 'z', recs: [{ objective_id: 'bpt.cert.HEM.001', tid: 't' }] }] });
  const cols = (await env.DB.prepare('PRAGMA table_info(mk_ite_map)').all()).results.map((c) => c.name);
  assert.ok(!cols.some((c) => /user|account|report|email|learner/.test(c)), 'no identity columns: ' + cols.join(','));
  const rows = JSON.stringify(await mappingRows(env)); assert.ok(!rows.includes('user-secret-42') && !rows.includes('report-secret-9'));
  // Restore: inserted where missing, never replacing a newer row.
  const [r] = await mappingRows(env); await env.DB.prepare('DELETE FROM mk_ite_map').run();
  await restoreMappingStmt(env, r).run(); assert.equal((await mappingRows(env))[0].confirmations, r.confirmations);
  await restoreMappingStmt(env, { ...r, confirmations: 99, updated: '2000-01-01T00:00:00Z' }).run(); assert.equal((await mappingRows(env))[0].confirmations, r.confirmations, 'an older Drive row does not win');
});

test('the page reads performance records by the same rules as the server (itePerfFor in app/companion.html)', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../app/companion.html', import.meta.url), 'utf8');
  const done = /const iteDone=[^\n]*\n/.exec(html)[0], a = html.indexOf('const iteRid='), b = html.indexOf('function itePerfView(');
  assert.ok(a > 0 && b > a, 'the page functions are where they were');
  const page = new Function('A', `${done}${html.slice(a, b)}; return { itePerfFor, iteRid };`)((x) => Array.isArray(x) ? x : []);
  const d = report(), fromPage = d.missed.flatMap((x, i) => page.itePerfFor(d, x, i));
  assert.deepEqual(fromPage, deriveRecords(d));
  const legacy = { t: 5, missed: [{ text: 'Old fictional item', tid: 'b-x.y' }], mapped: '' };
  assert.deepEqual(legacy.missed.flatMap((x, i) => page.itePerfFor(legacy, x, i)), deriveRecords(legacy));
  assert.equal(page.iteRid(legacy), reportId(legacy));
});
