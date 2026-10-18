// The MKOS engine loop, run by the 5-minute cron: bootstrap imports, the library scan, then queued jobs, then the Drive mirror.
// Every run works within a query budget (metered D1) and stops cleanly when it is spent; every step is resumable and idempotent,
// so the next run continues where this one stopped. The budget tunes itself: it grows while runs finish cleanly and drops to a safe
// value if the platform's per-run limit is hit (free and paid Cloudflare plans both work).
import { FRAMEWORK } from './framework.js';
import { mkInit, J, nowIso, getSetting, setSetting, audit } from './db.js';
import { getObject, putObject } from './kb.js';
import { scanStep, refreshFamily, importLegacyRegistry, queue, event } from './ingest.js';
import { loadText, extractStep, finishSource } from './extract.js';
import { analyzeImpact, rescore } from './impact.js';
import { seedFramework, importBlueprint, importCurriculum, mapLearnerAssets } from './education.js';
import { deriveFromRecord } from './learner.js';
import { mirrorStep, snapshot } from './mirror.js';
import { checkMilestones } from './progress.js';
import { syncOwner, generateCandidates, termsNeedingPronunciation } from './pronounce.js';
import { aiBudgetLeft } from './extract.js';
import { projectBlueprint, evolve, parseBlueprintText, familyOf } from './blueprint.js';
import { decomposeStep, pearlStep } from './decompose.js';
import { classifyStep } from './classify.js';
import { reconcileStep, reconcileDue } from './reconcile.js';
import { importOwnerAssets } from './assets.js';
import { restoreStep } from './restore.js';

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
      // The ABIM blueprint document is a central registry record (Central Registry Data > MKOS > central); the owner's copy in his
      // account is read only when no central copy exists yet.
      const central = await env.DB.prepare("SELECT body FROM docs WHERE user_id = '_central' AND path = 'mkos/abim_blueprint'").first().catch(() => null);
      const abimDoc = central ? J(central.body, null) : ((await deps.ownerDocs(['med/blueprint']))['med/blueprint'] || null);
      try { await importCurriculum(env, FRAMEWORK.app_curriculum || [], { abimDoc, prog: st.curriculum.prog }); st.curriculum.done = nowIso(); }
      finally { await save(); }
    }
    return true;
  } catch (e) { if (e.budget) return false; throw e; }
}

// One job. Returns true when the job is finished (or permanently failed), false to continue it next run.
async function runJob(env, deps, job, meter = null) {
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
      // Up to parts_per_run parts that use the AI; parts done by rules alone continue while the run's query budget has room.
      const per = Number(FRAMEWORK.frameworks.ingestion.extraction.parts_per_run) || 1;
      let aiParts = 0;
      for (let k = 0; k < 60; k++) {
        if (aiParts >= per || (k >= per && meter && meter.n > meter.max * 0.7)) break;
        const r = await extractStep(env, deps, src, { event_id: p.event_id, allowAI: !!deps.ai && aiParts < per });
        if (r.done) {
          await finishSource(env, src, { event_id: p.event_id }); await queue(env, 'decompose', src.id, { event_id: p.event_id }, 4);
          // Parts that wanted the AI on a day its budget was spent are enriched later; the rules' knowledge is already in place.
          if ((p.ai_pending || []).length) { const cur = await getObject(env, src.id); await putObject(env, { ...cur, ai_pending: p.ai_pending.slice(0, 400) }, { summary: `${p.ai_pending.length} parts await AI enrichment`, audited: false }); await queue(env, 'enrich', src.id, {}, 8); }
          await save('done', `${p.chunks || 0} parts${(p.ai_pending || []).length ? ', ' + p.ai_pending.length + ' await AI enrichment' : ''}`); return true;
        }
        if (r.used_ai) aiParts++;
        if (r.ai_pending) (p.ai_pending = p.ai_pending || []).push(r.chunk);
        p.done_chunks = (p.done_chunks || 0) + 1;
      }
      await save('running'); return false;
    }
    if (job.kind === 'bp_project') {
      p.prog = p.prog || { at: 0 };
      try { await projectBlueprint(env, job.subject, { prog: p.prog, kind: p.kind || 'owner_registry' }); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      const bp = await getObject(env, job.subject), fam = (await env.DB.prepare('SELECT blueprint_family FROM mk_blueprint_registries WHERE blueprint_id = ?').bind(job.subject).first() || {}).blueprint_family;
      if (bp && bp.status === 'current' && fam) { const old = (await env.DB.prepare("SELECT blueprint_id FROM mk_blueprint_registries WHERE blueprint_family = ? AND current_status = 'current' AND blueprint_id != ?").bind(fam, job.subject).all()).results;
        for (const o of old) await evolve(env, job.subject, o.blueprint_id); }
      await save('done'); return true;
    }
    if (job.kind === 'bp_extract') {
      // A blueprint document without a curated registry: rules first (the app's own table reading); the owner's registry always governs.
      const src = await getObject(env, job.subject); if (!src) { await save('done'); return true; }
      const fam = familyOf(src.title, src.drive_path).family, owned = await env.DB.prepare("SELECT 1 FROM mk_blueprint_registries WHERE blueprint_family = ? AND current_status = 'current' AND CAST(source_confidence AS INTEGER) >= 95").bind(fam).first();
      if (owned) { await save('done', 'the curated registry for ' + fam + ' governs; document kept as its source'); return true; }
      const reg = parseBlueprintText(await deps.readText(src.drive_file_id), fam);
      if (!reg) { await save('done', 'no blueprint tables found by rules'); return true; }
      reg.blueprint_edition = String(src.year || ''); reg.source_document = { drive_file_id: src.drive_file_id, title: src.title };
      p.prog = p.prog || { at: 0 }; await importBlueprint(env, reg, fam, { registryFileId: src.drive_file_id, prog: p.prog });
      await save('done', 'parsed by rules'); return true;
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
    // AI ENRICHMENT of parts that were processed by rules alone because the day's free AI budget was spent.
    if (job.kind === 'enrich') {
      const src = await getObject(env, job.subject), pend = new Set((src && src.ai_pending) || []);
      if (!src || !pend.size || src.status === 'retired') { await save('done', 'nothing to enrich'); return true; }
      const b = await aiBudgetLeft(env);
      if (!deps.ai || b.left <= 0) { await env.DB.prepare("UPDATE mk_jobs SET state = 'queued', not_before = ?, note = 'waiting for the free AI budget', updated = ? WHERE id = ?").bind(Date.now() + 3600e3, nowIso(), job.id).run(); return false; }
      if (!p.loaded) { await loadText(env, deps, src, { complete: false }); await env.DB.prepare(`UPDATE mk_text SET done = 1 WHERE source_id = ? AND chunk NOT IN (${[...pend].slice(0, 90).map(() => '?').join(',')})`).bind(src.id, ...[...pend].slice(0, 90)).run(); p.loaded = true; }
      const per = Number(FRAMEWORK.frameworks.ingestion.extraction.parts_per_run) || 1;
      for (let k = 0; k < per; k++) {
        if ((await aiBudgetLeft(env)).left <= 0) break;   // never spend a pending part on rules alone: stop and wait for budget
        const r = await extractStep(env, deps, src, { event_id: p.event_id, allowAI: true });
        if (r.done) { await finishSource(env, src, {}); const cur = await getObject(env, src.id); await putObject(env, { ...cur, ai_pending: [] }, { summary: 'AI enrichment complete', audited: false }); await queue(env, 'decompose', src.id, {}, 5); await save('done', 'enriched'); return true; }
      }
      await save('running'); return false;
    }
    // Knowledge decomposition (delta): one source's recommendations, or every recommendation not yet decomposed at this version ('all').
    if (job.kind === 'decompose') { p.prog = p.prog || {}; let r;
      try { r = await decomposeStep(env, job.subject, { prog: p.prog }); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      p.recs = (p.recs || 0) + r.recs; p.objects = (p.objects || 0) + r.objects;
      if (r.done) { await save('done', `${p.recs} recommendations, ${p.objects} objects`); await queue(env, 'classify', 'all', {}, 6); return true; }
      await save('running', `${p.recs} recommendations so far`); return false; }
    if (job.kind === 'classify') { const r = await classifyStep(env); p.n = (p.n || 0) + r.classified; if (!r.more) { await save('done', `${p.n} classified`); return true; } await save('running', `${p.n} classified so far`); return false; }
    if (job.kind === 'pearls') { const cap = Number(FRAMEWORK.frameworks.decomposition.decomposition.pearls_per_day) || 40; const r = await pearlStep(env, deps); p.concepts = (p.concepts || 0) + (r.concept ? 1 : 0);
      if (r.done || p.concepts >= cap) { await save('done', `${p.concepts} concepts${r.note ? '; ' + r.note : ''}`); return true; } await save('running'); return false; }
    if (job.kind === 'reconcile') { let fin;
      try { fin = await reconcileStep(env, deps, p); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      if (fin) { await save('done', 'daily reconciliation complete'); return true; } await save('running', 'step ' + (p.step + 1)); return false; }
    if (job.kind === 'asset_import') { p.prog = p.prog || {}; let r;
      try { r = await importOwnerAssets(env, deps, { prog: p.prog }); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      if (r.done) { await save('done', `${r.lessons || 0} lessons, ${r.questions || 0} questions imported; ${r.outdated || 0} citing older editions kept out`); return true; } await save('running'); return false; }
    // Rebuild the operational database from canonical storage (owner-confirmed), or verify that it could be.
    if (job.kind === 'restore') { p.prog = p.prog || {}; let r;
      try { r = await restoreStep(env, deps, deps.mkosRoot, p.prog, { mode: p.mode || 'restore' }); } finally { await env.DB.prepare('UPDATE mk_jobs SET payload = ? WHERE id = ?').bind(JSON.stringify(p), job.id).run().catch(() => {}); }
      if (r.done) { await save(r.error ? 'failed' : 'done', r.error || JSON.stringify(r.counts || r).slice(0, 400)); return true; } await save('running', `file ${r.file} of ${r.of}`); return false; }
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

export async function mkTick(rawEnv, rawDeps, { root, mirrorRoot, maxBudget = 880 } = {}) {
  await mkInit(rawEnv);
  const tickSt = J(await getSetting(rawEnv, 'tick'), {}) || {};
  if (tickSt.capped && Date.now() - Date.parse(tickSt.capped_at || 0) > 864e5) tickSt.capped = false;   // a platform cap is re-tested daily
  if ((await getSetting(rawEnv, 'paused')) === '1') return { paused: true };
  // One run at a time: a manual run and the scheduled run never work on the same jobs at once (the lease expires after 6 minutes; a run can take minutes when the database is far away).
  const lease = J(await getSetting(rawEnv, 'tick_lease'), null);
  if (lease && Date.now() - lease.t < 360e3) return { skipped: 'another run is in progress' };
  const leaseId = Math.random().toString(36).slice(2); await setSetting(rawEnv, 'tick_lease', JSON.stringify({ t: Date.now(), id: leaseId }));
  // Cloudflare allows 1,000 queries per invocation; a run that shares its invocation with other work (the cron's Drive sweep) gets less.
  const budget = Math.max(25, Math.min(maxBudget, Number(tickSt.budget) || 30));
  const { env, meter, tick } = metered(rawEnv, budget);
  // Queries the Worker makes on MKOS's behalf (learner records) count against the same budget.
  const deps = { ...rawDeps };
  for (const k of ['userDocs', 'ownerDocs', 'changedUsers', 'ownerUpdated', 'ownerSay']) if (rawDeps[k]) deps[k] = (...a) => { tick(1); return rawDeps[k](...a); };
  if (rawDeps.ai) deps.ai = (...a) => { tick(1); return rawDeps.ai(...a); };
  const report = { at: nowIso(), budget, steps: [] };
  let platformHit = false;
  // Canonical storage first, on its own small budget: persisting to Drive (the system of record) never waits behind other work.
  if (mirrorRoot) {
    // Up to 8 files a run (about 7 queries each): during bootstrap and ingestion many files change every run, and every change must
    // reach Drive within the hour the daily check allows.
    const mm = metered(rawEnv, 160);
    try { const m = await mirrorStep(mm.env, rawDeps, mirrorRoot, { max: 8 }); report.steps.push(`drive ${m.written} written, ${Math.max(0, m.dirty - m.written)} behind` + (m.failed ? `, ${m.failed} failed (pending, retried next run)` : ''));
      if (m.failed) { const l = J(await getSetting(rawEnv, 'mirror_errors'), []) || []; l.push({ at: nowIso(), error: `${m.failed} file(s) not confirmed by Drive; see the persistence ledger` }); await setSetting(rawEnv, 'mirror_errors', JSON.stringify(l.slice(-20))); }
      if (new Date().getUTCHours() === 7) await snapshot(mm.env, rawDeps, mirrorRoot); }
    catch (e) { if (!e.budget) { if (PLATFORM.test(String(e.message || e))) platformHit = true; report.steps.push('drive: ' + String(e.message || e).slice(0, 120));
      try { const l = J(await getSetting(rawEnv, 'mirror_errors'), []) || []; l.push({ at: nowIso(), error: String(e.message || e).slice(0, 300) }); await setSetting(rawEnv, 'mirror_errors', JSON.stringify(l.slice(-20))); } catch (x) { /* best effort */ } } }
  }
  try {
    if (!(await bootstrap(env, deps, meter))) throw new BudgetSpent();
    report.steps.push('bootstrap ok');
    const scan = J(await getSetting(env, 'scan_last_complete'), null);
    const scanDue = !scan || Date.now() - Date.parse(scan.finished) > 30 * 60e3 || J(await getSetting(env, 'scan'), {})?.cur;
    if (scanDue && root) { const s = await scanStep(env, deps, root, { pages: 1 }); report.steps.push(`scan +${s.files} files, ${s.changes.length} changes`); }
    await learnerWatch(env, deps);
    // Blueprint registry projection follows the Blueprint objects (new edition, or a changed one).
    { const { results } = await env.DB.prepare("SELECT o.id, o.version FROM mk_objects o LEFT JOIN mk_blueprint_registries r ON r.blueprint_id = o.id WHERE o.type = 'Blueprint' AND (r.blueprint_id IS NULL OR r.version != o.version) LIMIT 3").all();
      for (const r of results) await queue(env, 'bp_project', r.id, {}, 3); }
    // Pronunciation: mirror the owner's list whenever it changes; one generation job per day for terms without a record.
    if (deps.ownerUpdated) { const t = await deps.ownerUpdated(['med/says', 'med/saylog']); if (t && t > ((await getSetting(env, 'pron_sync_t')) || '')) { await queue(env, 'pron_sync', 'owner', {}, 4); await setSetting(env, 'pron_sync_t', t); } }
    const day = nowIso().slice(0, 10), booted = J(await getSetting(env, 'bootstrap'), {})?.curriculum?.done;
    if ((await getSetting(env, 'pron_gen_day')) !== day && booted) { await queue(env, 'pronounce', 'day:' + day, {}, 8); await setSetting(env, 'pron_gen_day', day); }
    if (booted) {
      // Retroactive processing, once per decomposition version: decompose and classify everything already in MKOS, import the owner's assets.
      const bf = String(FRAMEWORK.frameworks.decomposition.decomposition.backfill_version || FRAMEWORK.frameworks.decomposition.version);
      if ((await getSetting(env, 'backfill_version')) !== bf) { await queue(env, 'decompose', 'all', {}, 5); await queue(env, 'classify', 'all', {}, 6); await queue(env, 'asset_import', 'owner', {}, 6); await setSetting(env, 'backfill_version', bf); }
      // Daily: reconciliation with the Life OS refresh, and clinical pearls within the free AI budget.
      const rd = await reconcileDue(env); if (rd) { await queue(env, 'reconcile', 'day:' + rd, {}, 2); await queue(env, 'pearls', 'day:' + rd, {}, 9); }
    }
    // Jobs in priority order while the run's query budget has room (at least six steps; small steps no longer waste a run).
    for (let k = 0; k < 60; k++) {
      if (k >= 6 && meter.n > meter.max * 0.8) break;
      const job = await env.DB.prepare("SELECT * FROM mk_jobs WHERE state IN ('queued','running') AND not_before <= ? ORDER BY priority, id LIMIT 1").bind(Date.now()).first();
      if (!job) break;
      const finished = await runJob(env, deps, job, meter);
      report.steps.push(`${job.kind} ${job.subject}${finished ? ' done' : ' continues'}`);
      if (!finished && job.kind === 'extract') break;     // one AI-bearing step per run
    }
  } catch (e) {
    if (e.budget) report.steps.push('budget spent');
    else if (PLATFORM.test(String(e.message || e))) { platformHit = true; report.steps.push('platform limit: ' + e.message); }
    else { report.error = String(e.message || e).slice(0, 300); console.error('mkos tick', e); }
  }
  // Milestones: the first time a stage of the knowledge build completes, and when ingestion as a whole is complete (progress.js).
  try { const ms = await checkMilestones(rawEnv); report.progress = ms.overall; if (ms.fresh.length) report.steps.push('milestone: ' + ms.fresh.join(', ')); } catch (e) { report.steps.push('progress: ' + String(e.message || e).slice(0, 80)); }
  // Self-tuning: grow 25% after a clean run that used its budget; drop to a safe 28 after a platform limit.
  const next = platformHit ? 28 : meter.n >= budget && !tickSt.capped ? Math.round(budget * 1.25) : budget;
  report.used = meter.n;
  try {
    await setSetting(rawEnv, 'tick', JSON.stringify({ budget: next, capped: platformHit || tickSt.capped || false, capped_at: platformHit ? nowIso() : tickSt.capped_at || null, last: report }));
  } finally {
    try { const cur = J(await getSetting(rawEnv, 'tick_lease'), null); if (cur && cur.id === leaseId) await setSetting(rawEnv, 'tick_lease', null); } catch (e) { /* the lease expires by itself */ }
  }
  return report;
}
