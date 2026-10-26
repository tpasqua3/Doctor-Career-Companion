// PROGRESS AND MILESTONES: how far the knowledge build has come, as percentages the owner can read at any time, and a milestone
// event the first time each stage completes (ingestion complete is the last). Every number is counted from the database; nothing is
// estimated by an AI. Stages and their weight in the overall figure:
//   startup 15        framework, legacy registry, every blueprint family's registry (ABIM: CERT, LKA), curriculum (bootstrap in tick.js)
//   library walk 10   the first full sweep of the Medical Knowledge Database (ingest.js scanStep)
//   registration 5    every readable file registered as a Source and classified
//   extraction 40     every source read: guidelines in full, index-only sources (MKSAP, textbooks) to their index parts
//   knowledge 30      every recommendation decomposed, every object classified, no decomposition, pearl or enrichment work waiting
// Complete means every stage is at 100% and no ingestion job is queued or running. A source whose reading failed for good (a file over
// 25 MB, an unreadable file) counts as finished with an exception: it is listed in the report and the milestone, so the build can
// complete and the exceptions are dealt with by the audit and remediation directives instead of holding everything back.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, objectsCached } from './db.js';
import { event } from './ingest.js';

const STAGES = [['startup', 15], ['library_walk', 10], ['registration', 5], ['extraction', 40], ['knowledge', 30]];
const NAMES = { startup: 'Startup (framework, registries, blueprints, curriculum)', library_walk: 'Library walk', registration: 'Source registration', extraction: 'Source extraction', knowledge: 'Knowledge object population' };
const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 1000) / 10) : 100);
const one = async (env, sql, ...b) => ((await env.DB.prepare(sql).bind(...b).first()) || {});

// The counts over mk_objects (the costly full scans) are reused until mk_objects changes (objectsCached, change driven); the job,
// file and text counts and the settings are read fresh every time. Every read is independent, so they are asked for together.
const objectCounts = (env) => objectsCached(env, 'progress_objects', async () => {
  const all = async (sql) => (await env.DB.prepare(sql).all()).results;
  const [bySrc, classes, rec, cls, kinds] = await Promise.all([
    all("SELECT COALESCE(json_extract(body, '$.ingest_state'), 'queued') AS s, COUNT(*) AS n FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified') GROUP BY s"),
    all("SELECT COALESCE(json_extract(body, '$.source_class'), 'unclassified') AS c, COUNT(*) AS n FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified') GROUP BY c"),
    one(env, "SELECT COUNT(*) AS n, SUM(CASE WHEN json_extract(body, '$.decomposition.v') IS NOT NULL AND json_extract(body, '$.decomposition.ov') IS version THEN 1 ELSE 0 END) AS d FROM mk_objects WHERE type = 'Recommendation' AND status = 'current'"),
    one(env, "SELECT COUNT(*) AS n, SUM(CASE WHEN json_extract(body, '$.classification.v') IS NOT NULL THEN 1 ELSE 0 END) AS c FROM mk_objects WHERE id NOT LIKE 'ea.u%'"),
    all("SELECT type, COUNT(*) AS n FROM mk_objects WHERE status = 'current' AND id NOT LIKE 'ea.u%' GROUP BY type")]);
  return { bySrc: Object.fromEntries(bySrc.map((r) => [r.s, r.n])), classes: Object.fromEntries(classes.map((r) => [r.c, r.n])), rec, cls, kinds: Object.fromEntries(kinds.map((r) => [r.type, r.n])) };
});

export async function progress(env) {
  const [stS, lastS, scanS, milesS, files, oc, partsR, jobsR, failedR] = await Promise.all([getSetting(env, 'bootstrap'), getSetting(env, 'scan_last_complete'), getSetting(env, 'scan'), getSetting(env, 'milestones'),
    one(env, "SELECT COUNT(*) AS n, SUM(CASE WHEN source_id IS NOT NULL THEN 1 ELSE 0 END) AS reg FROM mk_files WHERE state != 'removed'"),
    objectCounts(env),
    env.DB.prepare("SELECT t.source_id, SUM(t.done) AS d, COUNT(*) AS n FROM mk_text t JOIN mk_objects o ON o.id = t.source_id WHERE COALESCE(json_extract(o.body, '$.ingest_state'), 'queued') NOT IN ('extracted','done','indexed','skipped') GROUP BY t.source_id").all(),
    env.DB.prepare("SELECT kind || ':' || state AS k, COUNT(*) AS n FROM mk_jobs WHERE kind IN ('extract','enrich','decompose','classify','pearls','bp_extract','bp_project','family') AND state IN ('queued','running','failed') GROUP BY kind, state").all(),
    env.DB.prepare("SELECT j.subject, j.note FROM mk_jobs j JOIN mk_objects o ON o.id = j.subject WHERE j.kind = 'extract' AND j.state = 'failed' AND COALESCE(json_extract(o.body, '$.ingest_state'), 'queued') NOT IN ('extracted','done','indexed','skipped') AND NOT EXISTS (SELECT 1 FROM mk_jobs k WHERE k.kind = 'extract' AND k.subject = j.subject AND k.state IN ('queued','running')) GROUP BY j.subject").all()]);
  const st = J(stS, {}) || {};
  // Startup: five steps; a step in progress counts half.
  // The bootstrap's steps: the blueprint families with a registry file, by exam key (blueprints.json), as tick.js imports them.
  const steps = ['framework', 'legacy', ...FRAMEWORK.frameworks.blueprints.families.filter((f) => f.registry_find && f.exam_key).map((f) => f.exam_key), 'curriculum'];
  const doneStep = (k) => (k === 'framework' ? !!st.framework : !!(st[k] && st[k].done));
  const started = (k) => !!st[k];
  const startup = { percent: pct(steps.reduce((a, k) => a + (doneStep(k) ? 1 : started(k) ? 0.5 : 0), 0), steps.length),
    detail: Object.fromEntries(steps.map((k) => [k, doneStep(k) ? (st[k] && st[k].missing ? 'file not found' : 'done') : started(k) ? 'in progress' : 'waiting'])) };
  // Library walk: the first complete sweep; meanwhile the share of folders finished.
  const last = J(lastS, null), scan = J(scanS, null) || {};
  const left = (scan.queue || []).length + (scan.cur ? 1 : 0), fin = scan.done_folders || 0;
  const library_walk = last ? { percent: 100, detail: { finished: last.finished, sweeps: last.sweep } }
    : { percent: scan.started ? pct(fin, fin + left) : 0, detail: { folders_done: fin, folders_waiting: left, started: scan.started || null } };
  // Registration: files seen in the library that became Sources (the walk registers as it goes).
  const { bySrc, classes } = oc;
  const registration = { percent: library_walk.percent < 100 ? Math.min(library_walk.percent, pct(files.reg || 0, files.n || 0)) : pct(files.reg || 0, files.n || 0),
    detail: { files_seen: files.n || 0, registered: files.reg || 0, sources: Object.values(bySrc).reduce((a, n) => a + n, 0), by_class: classes } };
  // Extraction: sources finished, plus the parts done of sources being read now.
  const todo = Object.entries(bySrc).filter(([s]) => s !== 'skipped').reduce((a, [, n]) => a + n, 0), doneSrc = (bySrc.extracted || 0) + (bySrc.done || 0) + (bySrc.indexed || 0);
  const parts = partsR.results;
  const partial = parts.reduce((a, r) => a + (r.n ? r.d / r.n : 0), 0);
  const jobs = Object.fromEntries(jobsR.results.map((r) => [r.k, r.n]));
  const j = (kinds, states = ['queued', 'running']) => kinds.reduce((a, k) => a + states.reduce((b, s) => b + (jobs[k + ':' + s] || 0), 0), 0);
  const failedSrc = failedR.results;
  const extraction = { percent: registration.percent < 100 && !todo ? 0 : pct(doneSrc + failedSrc.length + partial, todo),
    detail: { sources_to_read: todo, finished: doneSrc, indexed_from_table_of_contents: bySrc.indexed || 0, being_read: parts.length, skipped: bySrc.skipped || 0, jobs_waiting: j(['extract']),
      exceptions: failedSrc.length, exception_reasons: Object.entries(failedSrc.reduce((a, r) => { const k = String(r.note || 'failed').split(':')[0].slice(0, 80); a[k] = (a[k] || 0) + 1; return a; }, {})).map(([reason, n]) => ({ reason, n })) } };
  // Knowledge objects: decomposition and classification of everything extracted.
  const { rec, cls, kinds } = oc;
  const kWait = j(['decompose', 'classify', 'pearls', 'enrich']);
  const recPct = pct(rec.d || 0, rec.n || 0), clsPct = pct(cls.c || 0, cls.n || 0);
  const knowledge = { percent: extraction.percent < 100 ? Math.min(Math.round((recPct + clsPct) / 2 * 10) / 10, extraction.percent) : Math.round((recPct * 0.6 + clsPct * 0.4) * 10) / 10,
    detail: { recommendations: rec.n || 0, decomposed: rec.d || 0, objects: cls.n || 0, classified: cls.c || 0, jobs_waiting: kWait, failed: j(['decompose', 'classify', 'pearls', 'enrich'], ['failed']), objects_by_type: kinds } };
  if (knowledge.percent >= 100 && kWait) knowledge.percent = 99.9;   // finished only when nothing is left to do
  if (extraction.percent >= 100 && extraction.detail.jobs_waiting) extraction.percent = 99.9;
  const stages = { startup, library_walk, registration, extraction, knowledge };
  for (const [k] of STAGES) stages[k].name = NAMES[k];
  const overall = Math.round(STAGES.reduce((a, [k, w]) => a + stages[k].percent * w, 0) / 100 * 10) / 10;
  const failed = j(['extract', 'enrich', 'decompose', 'classify', 'pearls', 'bp_extract', 'bp_project', 'family'], ['failed']);
  const complete = STAGES.every(([k]) => stages[k].percent >= 100);
  return { at: nowIso(), overall, complete, failed_jobs: failed, exceptions: failedSrc.length, stages, milestones: J(milesS, {}) || {} };
}

/* Called at the end of each engine run: records a milestone event the first time a stage reaches 100%, and 'ingestion_complete'
   once everything has. The events are governance records (persisted to Drive); the app shows them to the owner. */
export async function checkMilestones(env) {
  const p = await progress(env), m = p.milestones, fresh = [];
  for (const [k] of STAGES) if (p.stages[k].percent >= 100 && !m[k]) { m[k] = nowIso(); fresh.push(k); await event(env, 'milestone', k, { stage: NAMES[k], overall: p.overall }); }
  if (p.complete && !m.ingestion_complete) {
    m.ingestion_complete = nowIso(); fresh.push('ingestion_complete');
    await event(env, 'ingestion_complete', 'mkos', { overall: p.overall, objects: p.stages.knowledge.detail.objects_by_type, sources: p.stages.registration.detail.by_class, exceptions: p.stages.extraction.detail.exception_reasons, failed_jobs: p.failed_jobs });
  }
  if (fresh.length) await setSetting(env, 'milestones', JSON.stringify(m));
  return { overall: p.overall, fresh };
}
