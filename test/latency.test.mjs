// Server latency (USAP API latency compliance): the change-driven cache of central MKOS figures (objectsCached, SR-44), the chunked
// object read, and the one-batch schema check. Synthetic fixtures only. Run: node --test test/*.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from '../tools/mkos/d1shim.mjs';
import { mkInit, _resetInit, objectsCached } from '../src/mkos/db.js';
import { getObjects } from '../src/mkos/kb.js';

async function fresh() { _resetInit(); const env = { DB: d1(':memory:', { strict: true }) }; await mkInit(env); return env; }
const put = (env, id, body) => env.DB.prepare("INSERT OR REPLACE INTO mk_objects (id, type, name, norm, specialty, status, gov, version, trust, conf, hash, body, created, updated) VALUES (?, 'Source', ?, ?, NULL, 'current', 'validated', '1.0.0', 50, 50, 'h', ?, 'x', 'x')")
  .bind(id, id, id, JSON.stringify(body)).run();
const count = async (env) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM mk_objects").first()).n;

test('a cached figure is reused while mk_objects is unchanged and recomputed after any write to it', async () => {
  const env = await fresh(); let runs = 0;
  const f = () => objectsCached(env, 't', async () => { runs++; return { n: await count(env) }; });
  await put(env, 's1', { a: 1 });
  assert.deepEqual(await f(), { n: 1 }); assert.deepEqual(await f(), { n: 1 }); assert.equal(runs, 1);
  await put(env, 's2', { a: 2 });                                                            // insert
  assert.deepEqual(await f(), { n: 2 }); assert.equal(runs, 2);
  await env.DB.prepare("UPDATE mk_objects SET body = json_set(body, '$.a', 9) WHERE id = 's1'").run();   // a json_set writer
  await f(); assert.equal(runs, 3);
  await env.DB.prepare("DELETE FROM mk_objects WHERE id = 's2'").run();                      // delete
  assert.deepEqual(await f(), { n: 1 }); assert.equal(runs, 4);
  // Another isolate (no memory) reads the stored value without computing.
  _resetInit(); const mod = await import('../src/mkos/db.js?isolate=2'); let other = 0;
  assert.deepEqual(await mod.objectsCached(env, 't', async () => { other++; return null; }), { n: 1 }); assert.equal(other, 0);
  // Writes to other tables do not invalidate it; a failed computation is not kept.
  await env.DB.prepare("INSERT INTO mk_settings (k, v) VALUES ('x', '1')").run(); await f(); assert.equal(runs, 4);
  await put(env, 's3', {});
  await assert.rejects(objectsCached(env, 't', async () => { throw new Error('D1 down'); }));
  assert.deepEqual(await f(), { n: 2 }); assert.equal(runs, 5);
});

test('without the change counter (an emptied table) every call computes, as before', async () => {
  const env = await fresh(); let runs = 0;
  await env.DB.prepare('DELETE FROM mk_change').run();
  const f = () => objectsCached(env, 'u', async () => ++runs);
  await f(); await f(); assert.equal(runs, 2);
  await put(env, 'a', {}); await f(); assert.equal(runs, 3);
});

test('getObjects reads every chunk (more than six chunks of 90 ids)', async () => {
  const env = await fresh(); const ids = [];
  for (let i = 0; i < 700; i++) { ids.push('o' + i); await put(env, 'o' + i, { i }); }
  const got = await getObjects(env, [...ids, 'missing', 'o3']);
  assert.equal(Object.keys(got).length, 700); assert.equal(got.o699.i, 699); assert.equal(got.o0.i, 0);
});
