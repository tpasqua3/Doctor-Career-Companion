// The per-source lifecycle record (mk_lifecycle) and its stage bookkeeping, kept apart from lifecycle.js so the scanner (ingest.js)
// can enter a source without importing the engine. Stages come from mkos/ontology/lifecycle.json.
import { FRAMEWORK } from './framework.js';
import { J, nowIso } from './db.js';

export const LC = FRAMEWORK.frameworks.lifecycle;
export const STAGES = LC.stages.map((s) => s.key);
const IMPL = new Set(LC.stages.filter((s) => s.implemented).map((s) => s.key));

export function freshStages() {
  return Object.fromEntries(STAGES.map((k) => [k, IMPL.has(k) ? { state: 'pending' } : { state: 'pending_engine' }]));
}
// The stage a record is at (first implemented stage not done) and the record's status.
export function summarize(doc) {
  const st = doc.stages || {};
  const at = STAGES.find((k) => IMPL.has(k) && (st[k] || {}).state !== 'done');
  if (doc.retired) return { stage: at || 'retired', status: 'retired' };
  if (STAGES.some((k) => (st[k] || {}).state === 'blocked')) return { stage: STAGES.find((k) => (st[k] || {}).state === 'blocked'), status: 'blocked' };
  if (at) return { stage: at, status: (st.ingested || {}).state === 'done' ? 'in_progress' : 'waiting' };
  const later = STAGES.find((k) => (st[k] || {}).state === 'pending_engine');
  return later ? { stage: later, status: 'pending_engine' } : { stage: STAGES[STAGES.length - 1], status: 'complete' };
}
export async function readRecord(env, sourceId) {
  const r = await env.DB.prepare('SELECT * FROM mk_lifecycle WHERE source_id = ?').bind(sourceId).first();
  return r ? { ...r, doc: J(r.stages_json, {}) || {} } : null;
}
export async function writeRecord(env, sourceId, doc, { source_v = null, cycle = 1, created = null } = {}) {
  const s = summarize(doc), now = nowIso();
  await env.DB.prepare(`INSERT INTO mk_lifecycle (source_id, stage, stages_json, status, source_v, cycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (source_id) DO UPDATE SET stage = excluded.stage, stages_json = excluded.stages_json, status = excluded.status, source_v = excluded.source_v, cycle = excluded.cycle, updated_at = excluded.updated_at`)
    .bind(sourceId, s.stage, JSON.stringify(doc), s.status, source_v, cycle, created || now, now).run();
  return s;
}

/* A source enters (or re-enters) the lifecycle: a new or changed source starts a new cycle at the first stage; the previous cycle is
   kept in the record's history (Knowledge Preservation: never delete). Idempotent for a source already at the start of a cycle.
   trigger: the UEPD trigger key (SourceIngested) this cycle answers; a trigger it replaces before finishing is returned as `replaced`
   (the caller reports that procedure as skipped). */
export async function enterLifecycle(env, sourceId, { event = 'entered', source_v = null, trigger = null } = {}) {
  const cur = await readRecord(env, sourceId), now = nowIso();
  const open = cur && cur.doc.trigger && !cur.doc.trigger_done && cur.doc.trigger !== trigger ? cur.doc.trigger : null;
  if (cur && cur.doc.stages && (cur.doc.stages.ingested || {}).state !== 'done' && !cur.doc.retired) {
    if (trigger && cur.doc.trigger !== trigger) { await writeRecord(env, sourceId, { ...cur.doc, trigger, trigger_done: false }, { source_v: cur.source_v, cycle: cur.cycle, created: cur.created_at }); return { unchanged: true, replaced: open }; }
    return { unchanged: true };
  }
  const history = cur ? [...(cur.doc.history || []), { cycle: cur.cycle, started: cur.doc.started || cur.created_at, ended: now, reached: cur.stage, status: cur.status, event: cur.doc.event || null, source_v: cur.source_v }]
    .slice(-(Number(LC.orchestrator.history_cycles_kept) || 10)) : [];
  const doc = { started: now, event, stages: freshStages(), history, ...(trigger ? { trigger, trigger_done: false } : {}) };
  const r = await writeRecord(env, sourceId, doc, { source_v, cycle: cur ? cur.cycle + 1 : 1, created: cur ? cur.created_at : now });
  return open ? { ...r, replaced: open } : r;
}
