// USAP telemetry wiring: the browser reporter route and the daily heartbeat (kit 1.2.0). No network: a fake USAP_UGF binding
// records what the kit sends. The heartbeat tests run first: the kit skips a counter already seen today in this process. Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createUsapNode } from '../src/usap_node_kit_v1.js';

function binding() {
  const sent = [];
  return { sent, fetch: async (url, init) => { if (String(url).endsWith('/metrics/events')) sent.push(...JSON.parse(init.body).events); return new Response('{}'); } };
}
function ctx() { const jobs = []; return { jobs, waitUntil: p => jobs.push(p), done: async () => { while (jobs.length) await Promise.allSettled(jobs.splice(0)); } }; }

test('the first timer run of 00:00 UTC sends the heartbeat zeros', async () => {
  const b = binding(), c = ctx(), env = { USAP_UGF: b, MKOS: 'off', GEN: 'off' };
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-25T00:00:00Z') }, env, c);
  await c.done();
  for (const k of ['ai_calls', 'frontend_views', 'mcp_tool_calls', 'tts_chars_used']) {
    const e = b.sent.find(x => x.metric_key === k && x.dims.job === 'heartbeat');
    assert.ok(e, k + ' heartbeat sent'); assert.equal(e.value, 0);
  }
});

test('other hours send no heartbeat', async () => {
  const b = binding(), c = ctx(), env = { USAP_UGF: b, MKOS: 'off', GEN: 'off' };
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-25T13:00:00Z') }, env, c);
  await c.done();
  assert.equal(b.sent.filter(x => x.dims && x.dims.job === 'heartbeat').length, 0);
});

test('POST /api/usap/client reports load time, error flag and a view, without sign-in', async () => {
  const b = binding(), c = ctx(), env = { USAP_UGF: b };
  const res = await worker.fetch(new Request('https://x.test/api/usap/client', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ load_ms: 1234, errors: 2, views: 1, surface: 'web' }) }), env, c);
  assert.equal(res.status, 200);
  await c.done();
  const m = k => b.sent.filter(e => e.metric_key === k);
  assert.equal(m('frontend_load_ms')[0].value, 1234);
  assert.equal(m('frontend_js_error_rate')[0].value, 1);
  assert.equal(m('frontend_views')[0].value, 1);
  assert.equal(m('frontend_views')[0].dims.surface, 'web');
});

test('the client route refuses GET and oversized bodies', async () => {
  const env = { USAP_UGF: binding() };
  assert.equal((await worker.fetch(new Request('https://x.test/api/usap/client'), env, ctx())).status, 405);
  const big = await worker.fetch(new Request('https://x.test/api/usap/client', { method: 'POST', body: 'x'.repeat(3000) }), env, ctx());
  assert.equal(big.status, 413);
});

test('timeAI sends ai_calls with the provider and job, and does not change the answer', async () => {
  const b = binding(), k = createUsapNode({ appId: 'doctor_companion_app' });
  const out = await k.timeAI(async () => ({ text: 'hi', model: 'm' }), { provider: 'gemini', job: 'lesson', fell_back: 0 });
  assert.deepEqual(out, { text: 'hi', model: 'm' });
  await k.flush({ USAP_UGF: b });
  const e = b.sent.find(x => x.metric_key === 'ai_calls');
  assert.equal(e.value, 1); assert.equal(e.dims.provider, 'gemini'); assert.equal(e.dims.job, 'lesson'); assert.equal(e.dims.outcome, 'ok');
});
