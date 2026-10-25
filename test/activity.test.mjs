// Activity events for Routine Rewards (src/activity.js): one event per real completion, stable idempotency keys, the subject only
// in user_id, nothing without an email, only the contract's metadata. End to end through the connector's save_doc (D1 shim) and
// through MKOS's learner derivation. Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { d1 } from '../tools/mkos/d1shim.mjs';
import worker from '../src/worker.js';
import { detect, subjectOf, emitActivity, keyOf, objective, watched } from '../src/activity.js';
import { createUsapNode } from '../src/usap_node_kit_v1.js';
import { mkInit, _resetInit } from '../src/mkos/db.js';
import { putObject } from '../src/mkos/kb.js';
import { deriveFromRecord } from '../src/mkos/learner.js';

const EMAIL = 'Doc.Person@Example.com ';
const SUBJECT = 's1_' + createHash('sha256').update('lifeos-subject:v1:doc.person@example.com').digest('hex');
const ALLOWED = new Set(['duration_min', 'quantity', 'unit', 'category', 'label', 'objective_id']);
const now = Date.now();

function binding() {
  const events = [];
  return { events, fetch: async (url, init) => { if (String(url).endsWith('/governance/events')) events.push(...JSON.parse(init.body).events); return new Response('{}'); } };
}
function ctx() { const jobs = []; return { jobs, waitUntil: p => jobs.push(p), done: async () => { while (jobs.length) await Promise.allSettled(jobs.splice(0)); } }; }
function clean(e) {
  assert.equal(e.user_id, SUBJECT);
  assert.match(e.user_id, /^s1_[0-9a-f]{64}$/);
  const rest = JSON.stringify({ ...e, user_id: null });
  assert.ok(!/s1_[0-9a-f]{64}/.test(rest), 'subject only in user_id');
  assert.ok(!/@/.test(rest), 'no email anywhere');
  for (const k of Object.keys(e.metadata)) assert.ok(ALLOWED.has(k), 'metadata ' + k + ' allowed');
  assert.ok(e.idempotency_key.length <= 120);
  assert.ok(e.idempotency_key.startsWith('doctor_companion_app:'));
}

test('the subject is s1_ + sha256 of the trimmed, lowercased email; no email, no subject', async () => {
  assert.equal(await subjectOf(EMAIL), SUBJECT);
  assert.equal(await subjectOf(''), null);
  assert.equal(await subjectOf(null), null);
});

test('detect: a new question set, a new study sitting, a lesson marked done; nothing old, repeated or trivial', () => {
  const st0 = { sets: [{ t: now - 5000, title: 'Old', n: 10, c: 9, total: 10 }], prefs: {} };
  const st1 = { ...st0, sets: [...st0.sets, { t: now - 1000, title: 'Heart failure set', n: 12, c: 7, total: 15 }] };
  const q = detect('med/state', st0, st1, now);
  assert.equal(q.length, 1); assert.equal(q[0].type, 'QuestionSetCompleted'); assert.equal(q[0].metadata.quantity, 12); assert.equal(q[0].metadata.unit, 'question');
  assert.equal(detect('med/state', st1, st1, now).length, 0, 'a re-save completes nothing');
  assert.equal(detect('med/state', null, { sets: [{ t: now - 10 * 864e5, n: 5 }] }, now).length, 0, 'no backfill of old sets');
  assert.equal(detect('med/state', null, { sets: [{ t: now - 100, n: 0 }] }, now).length, 0, 'an empty set is not a completion');

  const lg0 = { e: [{ t: now - 9e5, k: 'lesson', title: 'x', min: 12, done: 1 }] };
  const lg1 = { e: [...lg0.e, { t: now - 6e5, k: 'cards', title: 'Deck', min: 8.5, done: 0 }, { t: now - 3e5, k: 'quiz', title: 'q', min: 0.5, n: 3, c: 1 }] };
  const s = detect('med/log', lg0, lg1, now);
  assert.equal(s.length, 1, 'sittings under a minute are not sessions'); assert.equal(s[0].type, 'StudySessionCompleted'); assert.equal(s[0].metadata.duration_min, 8.5); assert.equal(s[0].metadata.category, 'medical_study');
  assert.ok(!JSON.stringify(s).includes('Deck'), 'no titles');

  const l = detect('med/les_abc', { id: 'abc', tid: 't', done: 0 }, { id: 'abc', tid: 't', done: now - 50 }, now);
  assert.equal(l.length, 1); assert.equal(l[0].type, 'LessonCompleted');
  assert.equal(detect('med/les_abc', { id: 'abc', done: now - 60 }, { id: 'abc', done: now - 50 }, now).length, 0, 'already done');
  assert.ok(watched('med/state') && watched('med/log') && watched('med/les_abc') && !watched('med/says') && !watched('med/bank_cv'));
});

test('emitActivity: subject only in user_id, stable keys, no email means nothing sent', async () => {
  const b = binding(), env = { USAP_UGF: b }, kit = createUsapNode({ appId: 'doctor_companion_app' });
  const found = [...detect('med/les_abc', null, { id: 'abc', done: now }, now), objective('bpt.abim.cardiology.heart_failure', 'Heart failure', now)];
  assert.equal(await emitActivity(kit, { id: 'u1', email: '' }, found), 0);
  assert.equal(await emitActivity(kit, { id: 'u1', email: EMAIL }, found), 2);
  await kit.flush(env);
  assert.equal(b.events.length, 2);
  b.events.forEach(clean);
  assert.equal(b.events[0].idempotency_key, await keyOf('u1', found[0]));
  assert.equal(await keyOf('u1', found[0]), await keyOf('u1', detect('med/les_abc', null, { id: 'abc', done: now - 7 }, now)[0]), 'same completion, same key');
  assert.notEqual(await keyOf('u1', found[0]), await keyOf('u2', found[0]), 'accounts never share a key');
  assert.equal(b.events[1].metadata.objective_id, 'bpt.abim.cardiology.heart_failure');
  const long = await keyOf('u1', objective('x'.repeat(200)));
  assert.ok(long.length <= 120);
});

async function siteWithAccount(email) {
  const env = { DB: d1(':memory:'), USAP_UGF: binding(), MKOS: 'off', GEN: 'off' };
  const c0 = ctx();
  await worker.fetch(new Request('https://x.test/api/nothing', { method: 'GET' }), env, c0); await c0.done();   // creates the tables
  const token = 'ab'.repeat(32), th = createHash('sha256').update(token).digest('hex');
  await env.DB.prepare('INSERT INTO users (id, email, salt, hash, first, last, created) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('u1', email, 's', 'h', 'A', 'B', new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO links (token_hash, user_id, created) VALUES (?, ?, ?)').bind(th, 'u1', new Date().toISOString()).run();
  const save = async (path, body) => { const c = ctx(); const r = await worker.fetch(new Request('https://x.test/mcp/' + token, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_doc', arguments: { path, body } } }) }), env, c); await c.done(); return r.json(); };
  return { env, save };
}

test('end to end: the connector save of a finished lesson sends one LessonCompleted, a re-save sends nothing', async () => {
  const { env, save } = await siteWithAccount(EMAIL.trim());
  const r = await save('med/les_l1', { id: 'l1', tid: 't1', title: 'Some lesson', done: 0, segs: [] });
  assert.ok(r.result && !r.result.isError);
  assert.equal(env.USAP_UGF.events.length, 0, 'an unfinished lesson sends nothing');
  await save('med/les_l1', { id: 'l1', tid: 't1', title: 'Some lesson', done: Date.now(), segs: [] });
  await save('med/les_l1', { id: 'l1', tid: 't1', title: 'Some lesson', done: Date.now(), segs: [], extra: 1 });
  const evs = env.USAP_UGF.events.filter(e => e.event_type === 'LessonCompleted');
  assert.equal(evs.length, 1); clean(evs[0]);
  const t = Date.now() - 100;
  await save('med/state', { sets: [{ t, title: 'Set', n: 4, c: 2, total: 4 }], prefs: {} });
  await save('med/state', { sets: [{ t, title: 'Set', n: 4, c: 2, total: 4 }], prefs: { x: 1 } });
  const qs = env.USAP_UGF.events.filter(e => e.event_type === 'QuestionSetCompleted');
  assert.equal(qs.length, 1); clean(qs[0]); assert.equal(qs[0].metadata.quantity, 4);
});

test('MKOS: a blueprint objective entering Mastery is reported once; a first derivation reports nothing', async () => {
  _resetInit(); const env = { DB: d1(':memory:') }; await mkInit(env);
  await putObject(env, { id: 'cn.t.hf', type: 'CurriculumNode', name: 'Heart failure', concepts: [], blueprint_topics: ['bpt.fixture.hf'], status: 'current' }, { audited: false });
  const docs = { 'med/state': { topics: { hf: { n: 400, c: 398, rate: 5, last: Date.now(), les: 3 } } } };
  const first = await deriveFromRecord(env, 'u1', docs);
  assert.deepEqual(first.mastered, [], 'no earlier state: nothing reported');
  await env.DB.prepare("UPDATE mk_learner SET body = json_set(body, '$.knowledge_state', 'Application') WHERE object_id = 'bpt.fixture.hf'").run();
  const second = await deriveFromRecord(env, 'u1', docs);
  assert.deepEqual(second.mastered, ['bpt.fixture.hf']);
  const third = await deriveFromRecord(env, 'u1', docs);
  assert.deepEqual(third.mastered, [], 'already mastered');
});
