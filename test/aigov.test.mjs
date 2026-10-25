// USAP AI governance (node kit 1.3.0): timeAI with an action sends an ai_invocation record, recordDeterministic sends a
// path "deterministic" record, and the app's labels map each call site to its catalog action. No network. Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsapNode } from '../src/usap_node_kit_v1.js';
import { govDims, govOf, GOV_ACTIONS } from '../src/aigov.js';

function binding() {
  const sent = [];
  return { sent, fetch: async (url, init) => { if (String(url).endsWith('/metrics/events')) sent.push(...JSON.parse(init.body).events); return new Response('{}'); } };
}

test('timeAI with an action sends ai_invocation with the governance dims and returns the answer unchanged', async () => {
  const b = binding(), k = createUsapNode({ appId: 'doctor_companion_app' });
  const dims = { provider: 'gemini', job: 'lesson', fell_back: 0, ...govDims({ job: 'lesson', rawJob: 'lesson', head: 'Write a lesson', gov: { route: '/api/ai' } }) };
  const out = await k.timeAI(async () => ({ text: 'hi', model: 'gemini-x', usage: { total_tokens: 42 } }), dims);
  assert.deepEqual(out, { text: 'hi', model: 'gemini-x', usage: { total_tokens: 42 } });
  await k.flush({ USAP_UGF: b });
  const e = b.sent.find(x => x.metric_key === 'ai_invocation');
  assert.ok(e, 'ai_invocation sent');
  assert.equal(e.dims.action, 'doctor_companion_app.lesson_write');
  assert.equal(e.dims.feature, 'lesson'); assert.equal(e.dims.path, 'hybrid'); assert.equal(e.dims.user_initiated, 1);
  assert.equal(e.dims.provider, 'gemini'); assert.equal(e.dims.model_id, 'gemini-x'); assert.equal(e.dims.route, '/api/ai');
  assert.equal(e.dims.outcome, 'ok'); assert.equal(e.dims.tokens, 42);
});

test('recordDeterministic sends a path "deterministic" record', async () => {
  const b = binding(), k = createUsapNode({ appId: 'doctor_companion_app' });
  k.recordDeterministic('doctor_companion_app.mkos_extract', { feature: 'mkos', route: 'mkos:extract', user_initiated: 0 });
  await k.flush({ USAP_UGF: b });
  const e = b.sent.find(x => x.metric_key === 'ai_invocation');
  assert.equal(e.dims.path, 'deterministic'); assert.equal(e.dims.action, 'doctor_companion_app.mkos_extract'); assert.equal(e.dims.user_initiated, 0);
});

test('page jobs map to their catalog actions', () => {
  const a = (o) => govDims(o).action.replace('doctor_companion_app.', '');
  assert.equal(a({ job: 'lesson_lib', rawJob: 'lesson_lib' }), 'lesson_lib_write');
  assert.equal(a({ job: 'questions', rawJob: 'questions' }), 'questions_write');
  assert.equal(a({ job: 'cards', rawJob: 'cards' }), 'cards_write');
  assert.equal(a({ job: 'review', rawJob: 'review' }), 'lesson_review');
  assert.equal(a({ job: 'plan', rawJob: 'plan', head: "You are the chief resident planning one physician's study." }), 'plan_build');
  assert.equal(a({ job: 'plan', rawJob: 'plan', head: 'You are a career strategist for a physician.' }), 'career_plan');
  assert.equal(a({ job: 'report', rawJob: 'report', head: "This is a physician's in-training examination score report" }), 'ite_report_extract');
  assert.equal(a({ job: 'report', rawJob: 'report', head: "You are mapping a physician's missed in-training exam items" }), 'ite_objective_map');
  assert.equal(a({ job: 'notes', rawJob: 'notes' }), 'notes_update');
  assert.equal(a({ job: 'chat', rawJob: '', chat: true }), 'ask_chat');
  assert.equal(a({ job: 'lesson', rawJob: '' }), 'record_brief');
  const q = govDims({ job: 'review', rawJob: 'review', gov: { action: 'gen_questions_review', user_initiated: 0, route: 'gen:review' } });
  assert.deepEqual(q, { action: 'doctor_companion_app.gen_questions_review', feature: 'lesson_queue', path: 'ai', user_initiated: 0, route: 'gen:review' });
  assert.equal(govOf('mkos_extract', { user_initiated: 0, path: 'ai' }).path, 'ai');
  assert.equal(govOf('speak_tts').feature, 'speech');
  for (const [k, [, p]] of Object.entries(GOV_ACTIONS)) assert.ok(p === 'ai' || p === 'hybrid', k);
});
