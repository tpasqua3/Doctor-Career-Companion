// The MKOS engine loop, run by the 5-minute cron: bootstrap imports, the library scan, then queued jobs, then the Drive mirror.
// Every run works within a query budget (metered D1) and stops cleanly when it is spent; every step is resumable and idempotent,
// so the next run continues where this one stopped. The budget tunes itself: it grows while runs finish cleanly and drops to a safe
// value if the platform's per-run limit is hit (free and paid Cloudflare plans both work).
import { FRAMEWORK } from './framework.js';
import { mkInit, J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject } from './kb.js';
import { scanStep, refreshFamily, importLegacyRegistry, queue, event } from './ingest.js';
import { loadText, extractStep, finishSource } from './extract.js';
import { analyzeImpact, rescore } from './impact.js';
import { seedFramework, importBlueprint, importCurriculum, mapLearnerAssets } from './education.js';
import { deriveFromRecord } from './learner.js';
import { mirrorStep, snapshot } from './mirror.js';
import { syncOwner, generateCandidates, termsNeedingPronunciation } from './pronounce.js';
import { aiBudgetLeft } from './extract.js';

export class BudgetSpent extends Error { constructor() { super('MKOS query budget spent for this run'); this.budget = true; } }
// Only Cloudflare's own per-invocation limits count as a platform cap (a Google rate limit is an ordinary, retried error).
const PLATFORM = /too many api requests by single worker invocation|too many subrequests|subrequest limit/i;

// A D1 binding that counts calls and throws BudgetSpent when the run's budget is used.
export function metered(env, max) {
  const m = { n: 0, max };
  // When the budget runs out, the step in progress is stopped once; a small reserve then lets it save its progress.
  const tick = (k = 1) => { m.n += k; if (m.n > m.max) { if (!m.spent) { m.spent = true; m.max += 15; } else if (m.n <= m.max) return; throw new BudgetSpent(); } };
  const wrapStmt = (st) => new Proxy(st, { get(t, p) {
    if (p === '__raw') return t;
    if (p === 'bind') return (...a) => wrapStmt(t.bind(...a));
    if (['first', 'all', 'run', 'raw'].includes(p)) return (...a) => { tick(); return t[p](...a); };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
  const DB = new Proxy(env.DB, { get(t, p) {
    if (p === 'prepare') return (sql) => wrapStmt(t.prepare(sql));
    if (p === 'batch') return (list) => { tick(1 + Math.floor(list.length / 10)); return t.batch(list.map((s) => s.__raw || s)); };
    if (p === 'exec') return (sql) => { tick(); return t.exec(sql); };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
  return { env: { ...env, DB }, meter: m, tick };
}

const FIND = { legacy: "title contains 'guidelines_registry' and title contains 'CURRENT'", cert: "title contains 'CERT_blueprint_registry' and title contains 'CURRENT'", lka: "title contains 'LKA_blueprint_registry' and title contains 'CURRENT'" };

// Bootstrap, in dependency order: framework objects -> legacy registry -> blueprints -> curriculum. Each step resumable via its prog.
async function bootstrap(env, deps, B) {
  const st = J(await getSetting(env, 'bootstrap'), {}) || {};
  const save = () => setSetting(env, 'bootstrap', JSON.stringify(st));
  try {
    if (!st.framework) { st.framework_prog = st.framework_prog || { at: 0 }; try { await seedFramework(env, { prog: st.framework_prog }); st.framework = nowIso(); } finally { await save(); } }
    for (const [key, kind] of [['legacy', 'legacy'], ['cert', 'cert'], ['lka', 'lka']]) {
      if (st[key] && st[key].done && !(st[key].missing && Date.now() - Date.parse(st[key].done) > 864e5)) continue;   // a missing file is looked for again daily
      if (st[key] && st[key].retry_after && Date.now() < st[key].retry_after) continue;
      if (!st[key] || st[key].missing) st[key] = { prog: { at: 0 } };
      if (!st[key].file) { const f = await deps.findJson(FIND[kind]); if (!f) { st[key] = { done: nowIso(), missing: true }; await save(); continue; } st[key].file = f.id; st[key].title = f.title; await save(); }
      let reg;
      try { reg = await deps.readJson(st[key].file); }
      catch (e) { if (e.budget) throw e; st[key].error = String(e.message || e).slice(0, 200); st[key].retry_after = Date.now() + 3600e3; delete st[key].file; await save(); continue; }   // never stall the engine on one file
      try {
        if (kind === 'legacy') await importLegacyRegistry(env, reg, { registryFileId: st[key].file, prog: st[key].prog });
        else await importBlueprint(env, reg, kind, { registryFileId: st[key].file, prog: st[key].prog });
        st[key].done = nowIso();
      } finally { await save(); }
    }
    if (!st.curriculum || !st.curriculum.done) {
      st.curriculum = st.curriculum || { prog: { at: 0 } };
      const owner = await deps.ownerDocs(['med/blueprint']);
      try { await importCurriculum(env, FRAMEWORK.app_curriculum || [], { abimDoc: owner['med/blueprint'] || null, prog: st.curriculum.prog }); st.curriculum.done = nowIso(); }
      finally { await save(); }
    }
    return true;
  } catch (e) { if (e.budget) return false; throw e; }
}

// One job. Returns true when the job is finished (or permanently failed), false to continue it next run.
async function runJob(env, deps, job) {
  const p = J(job.payload, {}) || {};
  const save = (state, note) => env.DB.prepare('UPDATE mk_jobs SET state = ?, tries = tries + 1, payload = ?, note = ?, updated = ? WHERE id = ?').bind(state, JSON.stringify(p), note ? String(note).slice(0, 500) : null, nowIso(), job.id).run();
  try {
    if (job.kind === 'family') { await refreshFamily(env, job.subject, { event_id: p.event_id }); await save('done'); return true; }
    if (job.kind === 'impact') {
      const imp = await analyzeImpact(env, p.event_id, job.subject);
      if (imp.recalculate.length) await queue(env, 'rescore', job.subject, { event_id: p.event_id, ids: imp.recalculate.slice(0, 400) }, 3);
      await save('done'); return true;
    }
    if (job.kind === 'rescore') { const ids = p.ids || []; while (ids.length) { await rescore(env, ids.slice(0, 10), { event_id: p.event_id }); ids.splice(0, 10); p.ids = ids; } await save('done'); return true; }
    if (job.kind === 'extract') {
      const src = await getObject(env, job.subject);
      if (!src || src.status === 'retired' || src.ingest_state === 'skipped') { await save('done', 'nothing to extract'); return true; }
      if ((src.bytes || 0) > 25e6) { await save('failed', 'file over 25 MB: split it into chapters (or keep it as Google Docs) to have it read'); return true; }
      if (!p.loaded) { try { p.chunks = await loadText(env, deps, src, { complete: false }); p.loaded = true; await save('running'); } catch (e) { if (e.budget) throw e; await save(job.tries >= 3 ? 'failed' : 'queued', 'text: ' + (e.message || e)); return job.tries >= 3; } }
      const per = Number(FRAMEWORK.frameworks.ingestion.extraction.parts_per_run) || 1;
      for (let k = 0; k < per; k++) {
        const r = await extractStep(env, deps, src, { event_id: p.event_id, allowAI: !!deps.ai });
        if (r.waiting) { await save('queued', 'waiting for tomorrow\'s AI budget'); await env.DB.prepare('UPDATE mk_jobs SET not_before = ? WHERE id = ?').bind(Date.now() + 3600e3, job.id).run(); return false; }
        if (r.done) { await finishSource(env, src, { event_id: p.event_id }); await save('done', `${p.chunks || 0} parts`); return true; }
        p.done_chunks = (p.done_chunks || 0) + 1;
      }
      await save('running'); return false;
    }
    if (job.kind === 'pron_sync') { p.prog = p.prog || {}; await syncOwner(env, deps, { prog: p.prog }); await save('done'); return true; }
    if (job.kind === 'pronounce') {
      // Up to pronunciation.generation.batch terms per AI call, one call per run, within the shared daily AI budget.
      const b = await aiBudgetLeft(env);
      if (!deps.ai || b.left <= 0 || (p.batches || 0) >= 10) { await save('done', `${p.generated || 0} terms`); return true; }
      const terms = await termsNeedingPronunciation(env, FRAMEWORK.frameworks.pronunciation.generation.batch || 10);
      if (!terms.length) { await save('done', 'no terms waiting'); return true; }
      const r = await generateCandidates(env, deps, terms); await b.spend();
      p.batches = (p.batches || 0) + 1; p.generated = (p.generated || 0) + (r.generated || 0); await save('running'); return false;
    }
    if (job.kind === 'learner') { const docs = await deps.userDocs(job.subject, ['med/state', 'med/bank_', 'med/cards_']); await deriveFromRecord(env, job.subject, docs); await save('done'); return true; }
    if (job.kind === 'assets') {
      const docs = await deps.userDocs(job.subject, p.paths && p.paths.length ? p.paths : ['med/les_', 'med/bank_', 'med/cards_']);
      p.prog = p.prog || { at: 0 };
      try { await mapLearnerAssets(env, job.subject, docs, { prog: p.prog }); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      await save('done'); await queue(env, 'learner', job.subject, {}, 6); return true;
    }
    await save('failed', 'unknown job kind'); return true;
  } catch (e) {
    if (e.budget) {
      // Interrupted by the run budget: keep progress, step aside for 10 minutes so other jobs move, and give up after 8 interruptions
      // (the budget grows meanwhile; a requeue retries it).
      p.interrupts = (p.interrupts || 0) + 1;
      await env.DB.prepare('UPDATE mk_jobs SET payload = ?, state = ?, not_before = ?, note = ?, updated = ? WHERE id = ?').bind(JSON.stringify(p), p.interrupts >= 8 ? 'failed' : 'running', Date.now() + 600e3, p.interrupts >= 8 ? 'too large for the run budget; requeue later' : 'interrupted ' + p.interrupts + 'x', nowIso(), job.id).run().catch(() => {});
      throw e;
    }
    console.error('mkos job', job.kind, job.subject, e);
    await save(job.tries >= 4 ? 'failed' : 'queued', e.message || String(e)); return job.tries >= 4;
  }
}

// Learner records changed since they were last mapped -> asset mapping (which then queues learner derivation). One account per run.
async function learnerWatch(env, deps) {
  const seen = J(await getSetting(env, 'learner_watch'), {}) || {};
  const users = (await deps.changedUsers()).filter((u) => u.user_id && u.updated > (seen[u.user_id] || ''));
  const u = users[0]; if (!u) return;
  await queue(env, 'assets', u.user_id, {}, 5);
  seen[u.user_id] = u.updated; await setSetting(env, 'learner_watch', JSON.stringify(seen));
}

export async function mkTick(rawEnv, rawDeps, { root, mirrorRoot } = {}) {
  await mkInit(rawEnv);
  const tickSt = J(await getSetting(rawEnv, 'tick'), {}) || {};
  if (tickSt.capped && Date.now() - Date.parse(tickSt.capped_at || 0) > 864e5) tickSt.capped = false;   // a platform cap is re-tested daily
  if ((await getSetting(rawEnv, 'paused')) === '1') return { paused: true };
  const budget = Math.max(25, Math.min(880, Number(tickSt.budget) || 30));
  const { env, meter, tick } = metered(rawEnv, budget);
  // Queries the Worker makes on MKOS's behalf (learner records) count against the same budget.
  const deps = { ...rawDeps };
  for (const k of ['userDocs', 'ownerDocs', 'changedUsers', 'ownerUpdated', 'ownerSay']) if (rawDeps[k]) deps[k] = (...a) => { tick(1); return rawDeps[k](...a); };
  if (rawDeps.ai) deps.ai = (...a) => { tick(1); return rawDeps.ai(...a); };
  const report = { at: nowIso(), budget, steps: [] };
  let platformHit = false;
  try {
    if (!(await bootstrap(env, deps, meter))) throw new BudgetSpent();
    report.steps.push('bootstrap ok');
    const scan = J(await getSetting(env, 'scan_last_complete'), null);
    const scanDue = !scan || Date.now() - Date.parse(scan.finished) > 30 * 60e3 || J(await getSetting(env, 'scan'), {})?.cur;
    if (scanDue && root) { const s = await scanStep(env, deps, root, { pages: 1 }); report.steps.push(`scan +${s.files} files, ${s.changes.length} changes`); }
    await learnerWatch(env, deps);
    // Pronunciation: mirror the owner's list whenever it changes; one generation job per day for terms without a record.
    if (deps.ownerUpdated) { const t = await deps.ownerUpdated(['med/says', 'med/saylog']); if (t && t > ((await getSetting(env, 'pron_sync_t')) || '')) { await queue(env, 'pron_sync', 'owner', {}, 4); await setSetting(env, 'pron_sync_t', t); } }
    const day = nowIso().slice(0, 10); if ((await getSetting(env, 'pron_gen_day')) !== day && J(await getSetting(env, 'bootstrap'), {})?.curriculum?.done) { await queue(env, 'pronounce', 'day:' + day, {}, 8); await setSetting(env, 'pron_gen_day', day); }
    for (let k = 0; k < 6; k++) {
      const job = await env.DB.prepare("SELECT * FROM mk_jobs WHERE state IN ('queued','running') AND not_before <= ? ORDER BY priority, id LIMIT 1").bind(Date.now()).first();
      if (!job) break;
      const finished = await runJob(env, deps, job);
      report.steps.push(`${job.kind} ${job.subject}${finished ? ' done' : ' continues'}`);
      if (!finished && job.kind === 'extract') break;     // one AI-bearing step per run
    }
    if (mirrorRoot) { const m = await mirrorStep(env, deps, mirrorRoot, { max: 2 }); report.steps.push(`mirror ${m.written} written`); if (new Date().getUTCHours() === 7) await snapshot(env, deps, mirrorRoot).catch(() => {}); }
  } catch (e) {
    if (e.budget) report.steps.push('budget spent');
    else if (PLATFORM.test(String(e.message || e))) { platformHit = true; report.steps.push('platform limit: ' + e.message); }
    else { report.error = String(e.message || e).slice(0, 300); console.error('mkos tick', e); }
  }
  // Self-tuning: grow 25% after a clean run that used its budget; drop to a safe 28 after a platform limit.
  const next = platformHit ? 28 : meter.n >= budget && !tickSt.capped ? Math.round(budget * 1.25) : budget;
  report.used = meter.n;
  await setSetting(rawEnv, 'tick', JSON.stringify({ budget: next, capped: platformHit || tickSt.capped || false, capped_at: platformHit ? nowIso() : tickSt.capped_at || null, last: report }));
  return report;
}
