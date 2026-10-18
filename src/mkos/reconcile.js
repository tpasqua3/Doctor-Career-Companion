// DAILY RECONCILIATION ENGINE (mkos/ontology/decomposition.json "reconciliation"): once every 24 hours, with the Life OS daily refresh,
// MKOS checks itself and repairs what it can: new and updated sources, guideline versions, blueprint projections, knowledge and
// recommendation changes not yet decomposed or classified, relationship drift, missing extractions, failed jobs, orphaned objects,
// outdated educational assets, change events never carried through, and version integrity. Each step is bounded and resumable
// (the job's payload keeps the step and cursors), so the pass completes across runs within the engine's query budget.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, getSetting, setSetting, audit } from './db.js';
import { putObject } from './kb.js';
import { queue } from './ingest.js';
import { auditAssets } from './assets.js';

const R = FRAMEWORK.frameworks.decomposition.reconciliation, DV = (() => { const [a, b] = FRAMEWORK.frameworks.decomposition.version.split('.').map(Number); return a * 100 + b; })();
const CV = FRAMEWORK.frameworks.decomposition.classification.version;
const n = async (env, sql, ...a) => ((await env.DB.prepare(sql).bind(...a).first()) || {}).n || 0;
const openJob = async (env, kind, subject) => !!(await env.DB.prepare("SELECT 1 FROM mk_jobs WHERE kind = ? AND subject = ? AND state IN ('queued','running')").bind(kind, subject).first());

const STEPS = [
  ['sources', async (env, p, rep) => {
    const day = new Date(Date.now() - 864e5).toISOString();
    rep.sources = { new_24h: await n(env, "SELECT COUNT(*) AS n FROM mk_events WHERE kind = 'source_added' AND created >= ?", day), updated_24h: await n(env, "SELECT COUNT(*) AS n FROM mk_events WHERE kind = 'source_modified' AND created >= ?", day),
      removed_24h: await n(env, "SELECT COUNT(*) AS n FROM mk_events WHERE kind = 'source_removed' AND created >= ?", day) };
    // The library sweep runs continuously; if no full sweep finished in the last day, start one now (missed updates are found this way).
    const last = J(await getSetting(env, 'scan_last_complete'), null), cur = J(await getSetting(env, 'scan'), {}) || {};
    if (!cur.cur && (!last || Date.now() - Date.parse(last.finished) > 864e5)) { await setSetting(env, 'scan', null); rep.sources.full_sweep_started = true; }
    return true;
  }],
  ['versions', async (env, p, rep) => {
    // A guideline family whose supersession contradicts itself is recomputed: more than one edition current, or the family's current
    // edition superseded, retired or missing. (A focused update that is current beside the full guideline it partly updates is correct.)
    const { results } = await env.DB.prepare(`SELECT f.id, SUM(CASE WHEN s.status = 'current' THEN 1 ELSE 0 END) AS cur,
      MAX(CASE WHEN e.value = json_extract(f.body, '$.current_edition') AND (s.id IS NULL OR s.status NOT IN ('current','modified')) THEN 1 ELSE 0 END) AS bad
      FROM mk_objects f, json_each(f.body, '$.editions') e LEFT JOIN mk_objects s ON s.id = e.value WHERE f.type = 'Guideline' GROUP BY f.id HAVING cur > 1 OR bad = 1 LIMIT 60`).all();
    for (const r of results) if (!(await openJob(env, 'family', r.id))) await queue(env, 'family', r.id, {}, 3);
    rep.versions = { families_recomputed: results.length };
    return true;
  }],
  ['blueprints', async (env, p, rep) => {
    const { results } = await env.DB.prepare("SELECT r.blueprint_id AS id FROM mk_blueprint_registries r WHERE r.current_status = 'current' AND NOT EXISTS (SELECT 1 FROM mk_blueprint_concept_mappings m WHERE m.blueprint_id = r.blueprint_id) LIMIT 10").all();
    for (const r of results) if (!(await openJob(env, 'bp_project', r.id))) await queue(env, 'bp_project', r.id, {}, 3);
    rep.blueprints = { current: await n(env, "SELECT COUNT(*) AS n FROM mk_blueprint_registries WHERE current_status = 'current'"), reprojected: results.length };
    return true;
  }],
  ['knowledge', async (env, p, rep) => {
    // Recommendations new or changed since they were decomposed, and objects changed since they were classified (delta processing).
    const dec = await n(env, "SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'Recommendation' AND (json_extract(body, '$.decomposition.v') IS NULL OR json_extract(body, '$.decomposition.v') != ? OR json_extract(body, '$.decomposition.ov') IS NOT version)", DV);
    const cls = await n(env, "SELECT COUNT(*) AS n FROM mk_objects WHERE id NOT LIKE 'ea.u%' AND (json_extract(body, '$.classification.v') IS NULL OR json_extract(body, '$.classification.v') != ? OR json_extract(body, '$.classification.ov') IS NOT version)", CV);
    if (dec && !(await openJob(env, 'decompose', 'all'))) await queue(env, 'decompose', 'all', {}, 5);
    if (cls && !(await openJob(env, 'classify', 'all'))) await queue(env, 'classify', 'all', {}, 6);
    rep.knowledge = { recommendations_to_decompose: dec, objects_to_classify: cls, recommendations_changed_24h: await n(env, "SELECT COUNT(*) AS n FROM mk_objects WHERE type = 'Recommendation' AND updated >= ?", new Date(Date.now() - 864e5).toISOString()) };
    return true;
  }],
  ['relationships', async (env, p, rep) => {
    // Relationship drift: a current edge touching a superseded or retired object takes that status; an edge to nothing is retired.
    const at = nowIso();
    const a = await env.DB.prepare(`UPDATE mk_edges SET status = 'retired', updated = ? WHERE status = 'current' AND (src IN (SELECT id FROM mk_objects WHERE status = 'retired') OR dst IN (SELECT id FROM mk_objects WHERE status = 'retired'))`).bind(at).run();
    const b = await env.DB.prepare(`UPDATE mk_edges SET status = 'superseded', updated = ? WHERE status = 'current' AND (src IN (SELECT id FROM mk_objects WHERE status = 'superseded') OR dst IN (SELECT id FROM mk_objects WHERE status = 'superseded'))`).bind(at).run();
    const c = await env.DB.prepare(`UPDATE mk_edges SET status = 'retired', updated = ? WHERE status = 'current' AND (NOT EXISTS (SELECT 1 FROM mk_objects o WHERE o.id = mk_edges.src) OR NOT EXISTS (SELECT 1 FROM mk_objects o WHERE o.id = mk_edges.dst))`).bind(at).run();
    rep.relationships = { retired: (a.meta && a.meta.changes) || 0, superseded: (b.meta && b.meta.changes) || 0, dangling_retired: (c.meta && c.meta.changes) || 0 };
    return true;
  }],
  ['extractions', async (env, p, rep) => {
    const old = new Date(Date.now() - (R.stale_extraction_hours || 48) * 3600e3).toISOString();
    const { results } = await env.DB.prepare(`SELECT id FROM mk_objects WHERE type = 'Source' AND status IN ('current','modified') AND COALESCE(json_extract(body, '$.ingest_state'), 'queued') IN ('queued','registered') AND json_extract(body, '$.drive_file_id') IS NOT NULL
      AND updated < ? AND id NOT IN (SELECT subject FROM mk_jobs WHERE kind = 'extract' AND state IN ('queued','running','failed')) LIMIT 60`).bind(old).all();
    for (const r of results) await queue(env, 'extract', r.id, {}, 6);
    rep.extractions = { missing_requeued: results.length, waiting: await n(env, "SELECT COUNT(*) AS n FROM mk_jobs WHERE kind = 'extract' AND state IN ('queued','running')") };
    return true;
  }],
  ['jobs', async (env, p, rep) => {
    // Failed jobs get one fresh attempt a day, except failures that need the owner (a file too large to read).
    const r = await env.DB.prepare(`UPDATE mk_jobs SET state = 'queued', tries = 0, not_before = 0, note = 'requeued by the daily reconciliation' WHERE state = 'failed'
      AND COALESCE(note, '') NOT LIKE '%25 MB%' AND COALESCE(note, '') NOT LIKE 'unknown job kind%'`).run();
    rep.jobs = { failed_requeued: (r.meta && r.meta.changes) || 0, needing_owner: await n(env, "SELECT COUNT(*) AS n FROM mk_jobs WHERE state = 'failed'"),
      open: await n(env, "SELECT COUNT(*) AS n FROM mk_jobs WHERE state IN ('queued','running')") };
    await env.DB.prepare("DELETE FROM mk_jobs WHERE state = 'done' AND updated < ?").bind(new Date(Date.now() - 14 * 864e5).toISOString()).run();
    return true;
  }],
  ['orphans', async (env, p, rep) => {
    // Derived knowledge whose recommendation is gone, superseded or retired follows it; concepts nothing points to are counted for review.
    const { results } = await env.DB.prepare(`SELECT o.id, o.body FROM mk_objects o WHERE (o.id LIKE 'claim.%' OR o.id LIKE 'obj.l.%' OR o.id LIKE 'obj.a.%' OR o.id LIKE 'eo.tp.%' OR o.id LIKE 'eo.hy.%' OR o.id LIKE 'eo.ce.%')
      AND o.status = 'current' AND NOT EXISTS (SELECT 1 FROM mk_edges e JOIN mk_objects r ON r.id = e.dst WHERE e.src = o.id AND e.rel = 'derived_from' AND r.status IN ('current','modified')) LIMIT 80`).all();
    for (const r of results) { const o = J(r.body); await putObject(env, { ...o, status: 'retired' }, { actor: 'reconcile', summary: 'orphaned: its recommendation is no longer current', audited: false, aliases: false }); }
    rep.orphans = { derived_retired: results.length, unlinked_concepts: await n(env, "SELECT COUNT(*) AS n FROM mk_objects o WHERE o.type = 'Concept' AND NOT EXISTS (SELECT 1 FROM mk_edges e WHERE e.src = o.id OR e.dst = o.id)") };
    return true;
  }],
  ['assets', async (env, p, rep) => {
    p.assets = p.assets || {};
    const r = await auditAssets(env, { prog: p.assets, limit: 40 });
    const t = rep.assets || (rep.assets = { checked: 0, flagged: 0, reasons: {} });
    t.checked += r.checked; t.flagged += r.flagged; for (const [k, v] of Object.entries(r.reasons)) t.reasons[k] = (t.reasons[k] || 0) + v;
    return r.done;
  }],
  ['propagation', async (env, p, rep) => {
    // Change events that never reached impact analysis (an interrupted run, a lost job) are analyzed now.
    const { results } = await env.DB.prepare(`SELECT id, subject FROM mk_events WHERE kind IN ('source_modified','source_removed','blueprint_superseded') AND stage NOT IN ('impact_determined','validated')
      AND created < ? AND subject NOT IN (SELECT subject FROM mk_jobs WHERE kind = 'impact' AND state IN ('queued','running')) LIMIT 40`).bind(new Date(Date.now() - 3600e3).toISOString()).all();
    for (const r of results) await queue(env, 'impact', r.subject, { event_id: r.id }, 2);
    rep.propagation = { impact_requeued: results.length };
    return true;
  }],
  ['integrity', async (env, p, rep) => {
    // Every object's current version has its version row (history is complete and rollback works).
    const { results } = await env.DB.prepare('SELECT o.id, o.version, o.hash, o.body, o.updated FROM mk_objects o LEFT JOIN mk_versions v ON v.id = o.id AND v.version = o.version WHERE v.id IS NULL LIMIT 100').all();
    for (const r of results) await env.DB.prepare("INSERT OR IGNORE INTO mk_versions (id, version, hash, body, at, event_id, actor) VALUES (?, ?, ?, ?, ?, NULL, 'reconcile')").bind(r.id, r.version, r.hash || '', r.body, r.updated).run();
    rep.integrity = { versions_restored: results.length, objects: await n(env, 'SELECT COUNT(*) AS n FROM mk_objects'), versions: await n(env, 'SELECT COUNT(*) AS n FROM mk_versions'),
      unscored: await n(env, "SELECT COUNT(*) AS n FROM mk_objects WHERE json_extract(body, '$.scores') IS NULL") };
    return true;
  }],
];

/* One slice of the day's pass. Returns true when the whole pass is finished. p: job payload {step, rep, ...cursors}. */
export async function reconcileStep(env, deps, p) {
  p.rep = p.rep || { started: nowIso() }; p.step = p.step || 0;
  while (p.step < STEPS.length) {
    const [name, fn] = STEPS[p.step];
    const done = await fn(env, p, p.rep);
    if (!done) return false;
    p.step++;
  }
  p.rep.finished = nowIso();
  await setSetting(env, 'reconcile_report', JSON.stringify(p.rep));
  await audit(env, 'reconcile', 'daily_reconciliation', null, null, null, p.rep);
  return true;
}

// Due once a day at the Life OS refresh hour, or at the next run if that hour was missed.
export async function reconcileDue(env) {
  const day = nowIso().slice(0, 10), last = await getSetting(env, 'reconcile_day');
  if (last === day) return null;
  const hour = new Date().getUTCHours(), lastRun = last ? Date.parse(last + 'T00:00:00Z') : 0;
  if (hour === (R.utc_hour ?? 4) || Date.now() - lastRun > 2 * 864e5) { await setSetting(env, 'reconcile_day', day); return day; }
  return null;
}
