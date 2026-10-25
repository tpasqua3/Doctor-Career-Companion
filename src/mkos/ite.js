// ITE -> BLUEPRINT OBJECTIVE MAPPING v2 (owner spec "MKOS ITE -> ABIM Mapping Architecture v2", roadmap Phase 3.2; framework
// blueprints.json ite_mapping). Four layers, kept apart:
//
//   Knowledge layer   mk_ite_map (CENTRAL, D1, mirrored to Drive registries/ite_mapping.json and restored): ITE wording -> blueprint
//                     objective(s), per blueprint family. True for everyone, so shared by every account. No user id, report id or
//                     anything else about who confirmed it: only the wording, the objective set, how it was first established, the
//                     count of confirmations and the day of the last one. Confirmations strengthen it; they never touch performance.
//   Performance layer user_ite_performance, the account's own record med/iteperf ({r: [records], reports}): one record per confirmed
//                     missed item and objective (report_id, item, objective_id, blueprint, exam_key, status missed | mastered, source
//                     ITE, confirmed, date). Kept in the account (D1 docs -> the account's own Drive folder); never central.
//   Content layer     lessons: an eligible objective reuses its shared lesson or gets one queued through the existing seed queue
//                     (genjobs.js queueObjectiveSeeds; stored centrally as an MKOS asset, so every account benefits).
//   Observability     objective_trace, the account's record med/itetrace: every missed item with each step (mapped, confirmed,
//                     stored, eligible, queued, generated), the reason a step has not happened and how long it has waited. Recomputed
//                     on each transition (change marks in ite_marks.js; the page asks after it maps, confirms or queues), written only
//                     when it changed. An item that waits on one step past its stall threshold is an audit failure (owner panel).
//
// Mapping order for a missed item (the page runs the AI step through its own "report" job, so the AI order of operations is untouched):
//   0. the physician's own confirmed mapping (med/itemap, page side) -> 1. central exact match (normalized wording, same blueprint) ->
//   2. central fuzzy match (trigram similarity >= fuzzy_min) -> 3. the discipline shortlist (shortlist_size objectives by wording) and
//   one batched AI call for what is left -> 4. the physician's review. Nothing reaches planning until it is confirmed.
//
// Eligibility: isEligible(record) = confirmed && !archived (and, for a blueprint's board queue, the record belongs to that blueprint).
// It never depends on a lesson existing: lesson generation is what makes the lesson.
import { FRAMEWORK } from './framework.js';
import { J, nowIso, audit, fwGet, overrides } from './db.js';
import { examFamily } from './education.js';
import { iteMap, gramsOf, sim, queueObjectiveSeeds } from './genjobs.js';
import { learnerFamily } from './wording.js';

export const PERF = 'med/iteperf', TRACE = 'med/itetrace', MIG = 'med/itemig', ITE = 'med/ite', MAP = 'med/itemap';
const A = (x) => Array.isArray(x) ? x : [];
const S = (x, n) => String(x == null ? '' : x).slice(0, n);
const OBJ_ID = /^bpt\.[a-z0-9_]+\.[A-Za-z0-9._-]{1,60}$/;

/* The framework numbers with the owner's overrides (settings {path: "blueprints.ite_mapping.<key>"}). */
export async function iteConfig(env) {
  let o = {}; try { o = await overrides(env); } catch { o = {}; }
  const base = FRAMEWORK.frameworks.blueprints.ite_mapping, out = {};
  for (const k of Object.keys(base)) { const v = fwGet('blueprints.ite_mapping.' + k, o); out[k] = v === undefined ? base[k] : v; }
  out.stall_hours = { ...base.stall_hours, ...(out.stall_hours || {}) };
  return out;
}

/* ---------- Wording and identities ---------- */
let STOP = null;
const stopSet = () => STOP || (STOP = new Set(String(FRAMEWORK.frameworks.blueprints.ite_mapping.stopwords || '').split(/\s+/).filter(Boolean)));
/* "Treat ITP in an adult with severe thrombocytopenia" -> "treat itp adult severe thrombocytopenia". */
export const iteNorm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !stopSet().has(w)).join(' ');
/* The blueprint family of an exam key or family id, from the blueprint data (blueprints.json families). */
export function famOf(key) {
  const f = examFamily(String(key || 'cert'));
  return { id: f.id, exam_key: f.exam_key, name: f.blueprint_name || f.board_name || f.id, app_kind: f.app_kind || null };
}
export const reportId = (d) => S(d && d.rid, 40) || ('r' + Number((d && d.t) || 0).toString(36));
const dayOf = (t) => { const n = Number(t); return n > 0 ? new Date(n).toISOString().slice(0, 10) : nowIso().slice(0, 10); };
async function sha(text) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
const objKey = (ids) => ids.length ? [...ids].sort().join('+') : '';
export async function mappingId(blueprint, norm, ids) { return 'itm.' + (await sha(blueprint + '|' + norm + '|' + objKey(ids))).slice(0, 20); }

/* ---------- Eligibility ---------- */
/* The spec's Stage 5: a confirmed, unarchived weakness. Lessons play no part. With an exam key, only that blueprint's records. */
export const isEligible = (r, examKey = null) => !!r && r.confirmed === true && !r.archived && r.status === 'missed' && (!examKey || r.exam_key === examKey);

/* ---------- Performance records (the same rules as itePerfFor() in app/companion.html; change them together) ---------- */
/* A missed item counts once it is reviewed (status ok or none); a report read before the review step existed has no status and was
   already in the plan, so it stays there (legacy). */
const reviewed = (x) => !!x && (!x.status || x.status === 'ok' || x.status === 'none');
export function recordsForItem(d, x, i, examKey, blueprint) {
  if (!reviewed(x)) return [];
  const rid = reportId(d), base = { report_id: rid, item: i, exam_key: examKey || '', blueprint: blueprint || '', status: 'missed', source: 'ITE', confirmed: true, archived: false,
    date: dayOf(x.ct || d.t), tid: S(x.tid, 120), text: S(x.text, 200), area: S(x.area, 80), ...(x.status ? {} : { legacy: 1 }) };
  const objs = x.objective ? [{ objective: x.objective, oname: x.oname, ocat: x.ocat, osub: x.osub, opri: x.opri }, ...A(x.also)] : [];
  if (objs.length) return objs.filter((o) => o && o.objective).map((o) => ({ ...base, id: `${rid}#${i}#${base.exam_key}#${o.objective}`, objective_id: S(o.objective, 80), oname: S(o.oname, 200), ocat: S(o.ocat, 80), osub: S(o.osub, 120), opri: o.opri ?? null }));
  return x.tid ? [{ ...base, id: `${rid}#${i}#${base.exam_key}#topic`, objective_id: '', kind: 'topic' }] : [];
}
export function deriveRecords(d) {
  if (!d || !Array.isArray(d.missed)) return [];
  const ek = S(d.mapped, 40), bp = ek ? famOf(ek).id : '';
  return d.missed.flatMap((x, i) => recordsForItem(d, x, i, ek, bp));
}
function cleanRecord(r, s, fam) {
  if (!r || typeof r !== 'object') return null;
  const objective = S(r.objective_id, 80); if (objective && !OBJ_ID.test(objective)) return null;
  if (!objective && !r.tid) return null;
  const item = Number(s.item), rid = S(s.report_id, 40);
  return { id: `${rid}#${item}#${fam.exam_key}#${objective || 'topic'}`, report_id: rid, item, exam_key: fam.exam_key, blueprint: fam.id, objective_id: objective, status: r.status === 'mastered' ? 'mastered' : 'missed',
    source: 'ITE', confirmed: true, archived: false, date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : nowIso().slice(0, 10), tid: S(r.tid, 120), text: S(r.text || s.text, 200), area: S(r.area || s.area, 80),
    oname: S(r.oname, 200), ocat: S(r.ocat, 80), osub: S(r.osub, 120), opri: Number.isFinite(Number(r.opri)) && r.opri !== null && r.opri !== '' ? Number(r.opri) : null, ...(objective ? {} : { kind: 'topic' }), ...(r.legacy ? { legacy: 1 } : {}) };
}
const perfOf = (doc) => ({ v: 1, r: A(doc && doc.r).filter((x) => x && x.report_id), reports: A(doc && doc.reports).map(String) });
const docStmt = (env, uid, path, obj) => { obj._t = Date.now(); return env.DB.prepare('INSERT INTO docs (user_id, path, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, path) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(String(uid), path, JSON.stringify(obj), nowIso()); };
async function readDocs(env, deps, uid, paths) {
  if (deps && deps.userDocs) return deps.userDocs(uid, paths);
  const out = {}; for (const p of paths) { const r = await env.DB.prepare('SELECT body FROM docs WHERE user_id = ? AND path = ?').bind(String(uid), p).first(); if (r) out[p] = J(r.body, null); } return out;
}

/* ---------- The central mapping library ---------- */
async function objectiveFacts(env, ids) {
  const out = {};
  for (const id of ids) {
    const o = await env.DB.prepare("SELECT json_extract(body, '$.category') AS cat FROM mk_objects WHERE id = ?").bind(id).first();
    const c = (await env.DB.prepare("SELECT dst FROM mk_edges WHERE src = ? AND rel = 'projects_objective' AND status = 'current' ORDER BY dst").bind(id).all()).results.map((r) => r.dst);
    out[id] = { category: o ? o.cat : null, canonical: c };
  }
  return out;
}
/* One confirmation as an upsert statement (built first so a migration can run it in the same batch as the account's records). */
async function centralStmt(env, { blueprint, exam_key, text, area, ids, method, confidence }) {
  const norm = iteNorm(text); if (!norm) return null;
  ids = [...new Set(A(ids).map(String).filter((id) => OBJ_ID.test(id)))].slice(0, 3);
  const id = await mappingId(blueprint, norm, ids), facts = await objectiveFacts(env, ids);
  const canon = [...new Set(ids.flatMap((x) => facts[x].canonical))], disc = ids.length ? facts[ids[0]].category || S(area, 80) || null : S(area, 80) || null;
  const conf = confidence == null || confidence === '' || !Number.isFinite(Number(confidence)) ? null : Math.round(Math.max(0, Math.min(100, Number(confidence)))) / 100;
  const now = nowIso();
  return { id, stmt: env.DB.prepare(`INSERT INTO mk_ite_map (mapping_id, blueprint, exam_key, norm, source_text, objective_id, objective_ids, canonical_objective, canonical_ids, discipline, confidence, method, verified, version, confirmations, last_confirmed, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,?,?,?)
      ON CONFLICT (mapping_id) DO UPDATE SET confirmations = mk_ite_map.confirmations + 1, last_confirmed = excluded.last_confirmed, updated = excluded.updated,
        confidence = CASE WHEN excluded.confidence IS NULL THEN mk_ite_map.confidence WHEN mk_ite_map.confidence IS NULL THEN excluded.confidence ELSE MAX(mk_ite_map.confidence, excluded.confidence) END,
        version = mk_ite_map.version + (CASE WHEN mk_ite_map.canonical_ids != excluded.canonical_ids OR COALESCE(mk_ite_map.discipline, '') != COALESCE(excluded.discipline, '') THEN 1 ELSE 0 END),
        canonical_objective = excluded.canonical_objective, canonical_ids = excluded.canonical_ids, discipline = COALESCE(excluded.discipline, mk_ite_map.discipline)`)
    .bind(id, blueprint, exam_key, norm, S(text, 300), ids[0] || '', JSON.stringify(ids), canon[0] || null, JSON.stringify(canon), disc, conf, S(method, 30) || 'human_selected', now.slice(0, 10), now, now) };
}
/* confirm: one physician confirmed this wording -> these objectives (or none). nonce: the page's token for this confirmation, so a
   retry counts once. Returns the mapping id, or null when it was a retry. */
export async function confirmCentral(env, entry, nonce = null) {
  if (nonce) { const r = await env.DB.prepare('INSERT OR IGNORE INTO mk_ite_seen (nonce, at) VALUES (?, ?)').bind(S(nonce, 64), nowIso()).run(); if (!(r.meta && r.meta.changes)) return null; }
  const c = await centralStmt(env, entry); if (!c) return null;
  await c.stmt.run(); return c.id;
}
/* Steps 1 and 2: exact, then fuzzy, against the verified central rows of one blueprint. Among rows that agree on the wording, the
   objective set confirmed most often wins (then the most recently confirmed). */
export async function centralMatch(env, blueprint, texts, cfg) {
  const rows = (await env.DB.prepare('SELECT mapping_id, norm, objective_ids, confirmations, last_confirmed, confidence, canonical_ids FROM mk_ite_map WHERE blueprint = ? AND verified = 1 ORDER BY confirmations DESC, last_confirmed DESC LIMIT 5000').bind(blueprint).all()).results;
  const byNorm = new Map(); for (const r of rows) if (!byNorm.has(r.norm)) byNorm.set(r.norm, r);
  const grams = rows.length ? [...byNorm.values()].map((r) => ({ r, g: gramsOf(r.norm) })) : [];
  const min = Number(cfg.fuzzy_min) || 0.9;
  return texts.map((t) => {
    const n = iteNorm(t); if (!n) return null;
    const hit = (r, step, score) => { const ids = J(r.objective_ids, []) || []; return { step, mapping_id: r.mapping_id, ids, none: !ids.length, score, confirmations: r.confirmations, canonical: J(r.canonical_ids, []) }; };
    const ex = byNorm.get(n); if (ex) return hit(ex, 'exact', 100);
    const g = gramsOf(n); let best = null;
    for (const x of grams) { const s = sim(g, x.g); if (s >= min && (!best || s > best.s || (s === best.s && x.r.confirmations > best.r.confirmations))) best = { s, r: x.r }; }
    return best ? hit(best.r, 'fuzzy', Math.round(best.s * 100)) : null;
  });
}

/* ite_map {family, items:[{text, area}], central: true}: the deterministic half of the mapping engine. Each item gets its central match
   (step 1 or 2) when there is one, and the discipline shortlist; `ai` lists the items still needing the AI (step 3). No AI here. */
export async function mapItems(env, u, a, deps = null) {
  const cfg = await iteConfig(env), fam = famOf(a.family === 'lka' ? 'lka' : a.family || 'cert');
  const items = A(a.items).slice(0, 150).map((x) => ({ text: S(x && x.text, 300), area: S(x && x.area, 120) })).filter((x) => x.text);
  const central = await centralMatch(env, fam.id, items.map((x) => x.text), cfg);
  const also = [...new Set(central.flatMap((c) => c ? c.ids : []))];
  const R = await iteMap(env, u, { family: fam.exam_key, items, _also: also, _sl: { near: Number(cfg.shortlist_size) || 10, extra: Number(cfg.shortlist_extra) || 4, extraNo: Number(cfg.shortlist_extra_no_discipline) || 12 } });
  const out = A(R && R.items).map((it, j) => central[j] ? { ...it, central: central[j] } : it), ai = out.map((it, j) => it.central ? -1 : j).filter((j) => j >= 0);
  const hits = out.length - ai.length;
  if (hits && deps && deps.recordDeterministic) for (let k = 0; k < hits; k++) deps.recordDeterministic('ite_objective_map', { feature: 'ite', route: 'mkos:ite_map', user_initiated: 1 });
  return { blueprint: fam.id, exam_key: fam.exam_key, blueprint_name: fam.name, whole: !!cfg.whole_discipline, pools: cfg.whole_discipline ? (R && R.pools) || {} : {}, items: out, objectives: (R && R.objectives) || {}, ai,
    steps: { exact: central.filter((c) => c && c.step === 'exact').length, fuzzy: central.filter((c) => c && c.step === 'fuzzy').length, ai: ai.length } };
}

/* ---------- Migration (once per account, idempotent): the account's confirmed mappings (med/itemap) become central mappings with no
   user identity, and its reviewed missed items (med/ite) become performance records, derived exactly as the planner reads them today.
   Everything (central rows, records, and the account's marker med/itemig) is written in one batch, so it happens once or not at all. ---------- */
export async function ensureMigrated(env, deps, uid) {
  if (!uid) return { skipped: true };
  const docs = await readDocs(env, deps, uid, [MIG, ITE, MAP, PERF]);
  if (docs[MIG]) return { already: true };
  const d = docs[ITE], M = docs[MAP] && docs[MAP].m && typeof docs[MAP].m === 'object' ? docs[MAP].m : {};
  if (!d && !Object.keys(M).length) return { none: true };
  const stmts = []; let central = 0;
  for (const e of Object.values(M)) {
    if (!e || !e.text) continue;
    for (const [k, v] of Object.entries(e)) {
      if (k === 'text' || k === 't' || !v || typeof v !== 'object') continue;
      const fam = famOf(k); if (!fam.exam_key) continue;
      const c = await centralStmt(env, { blueprint: fam.id, exam_key: fam.exam_key, text: e.text, area: '', ids: v.none ? [] : A(v.o), method: 'migrated', confidence: null });
      if (c) { stmts.push(c.stmt); central++; }
    }
  }
  const perf = perfOf(docs[PERF]), have = new Set(perf.reports), rid = d ? reportId(d) : null;
  let records = 0;
  if (d && !have.has(rid)) { const recs = deriveRecords(d); perf.r.push(...recs); perf.reports.push(rid); records = recs.length; }
  if (d) stmts.push(docStmt(env, uid, PERF, perf));
  stmts.push(docStmt(env, uid, MIG, { v: 1, at: nowIso(), central, records }));
  await env.DB.batch(stmts);
  await audit(env, 'mkos-ite', 'ite_migrate', null, null, null, { central, records }).catch(() => { });   // counts only: no account id
  return { migrated: true, central, records, perf: d ? perf : null };
}
/* Accounts that have ITE data from before v2 and have not been migrated yet, a few per engine run (the account's page also migrates
   itself on its first visit). */
export async function migrateSweep(env, deps, { max = 2 } = {}) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT user_id FROM docs WHERE path IN (?, ?) AND user_id != '_central' AND user_id NOT IN (SELECT user_id FROM docs WHERE path = ?) LIMIT ?`).bind(ITE, MAP, MIG, max).all();
  let n = 0; for (const r of results) { const m = await ensureMigrated(env, deps, r.user_id); if (m.migrated) n++; }
  return { migrated: n, waiting: results.length };
}

/* ---------- ite_confirm {items:[...]}: confirmations from the review screen ----------
   Each entry: {report_id, item, exam_key, text, area, ids, method, conf, recs, n (nonce), central (false: no new confirmation, e.g. the
   physician's own remembered mapping applied again)} or {archive: true, report_id} (a new report replaced the older ones). A confirmation
   (1) strengthens the central mapping (mapping only) and (2) replaces that item's records for that blueprint in the account. */
export async function confirmIte(env, deps, u, a) {
  const uid = String(u.id); await ensureMigrated(env, deps, uid);
  const cfg = await iteConfig(env), methods = cfg.methods || {};
  const docs = await readDocs(env, deps, uid, [PERF, ITE]), perf = perfOf(docs[PERF]);
  const before = JSON.stringify(perf); let central = 0, retries = 0;
  // A report the account's records have not seen yet starts from the stored report, read as the planner reads it; the entries below
  // then replace the items they name.
  const stored = docs[ITE], srid = stored ? reportId(stored) : null;
  if (stored && !perf.reports.includes(srid) && A(a.items).some((s) => s && S(s.report_id, 40) === srid && !s.archive)) { perf.r.push(...deriveRecords(stored)); perf.reports.push(srid); }
  for (const s of A(a.items).slice(0, 150)) {
    if (!s || typeof s !== 'object') continue;
    const rid = S(s.report_id, 40); if (!rid) continue;
    if (s.archive) {
      // A new report: every other report's records are archived. A removed report: its own records are.
      const removed = s.reason === 'removed';
      for (const r of perf.r) if (!r.archived && (removed ? r.report_id === rid : r.report_id !== rid)) { r.archived = true; r.archived_reason = removed ? 'report removed' : 'replaced by a newer report'; r.archived_at = nowIso().slice(0, 10); }
      continue;
    }
    const fam = famOf(s.exam_key), item = Number(s.item); if (!fam.exam_key || !Number.isInteger(item) || item < 0) continue;
    if (s.central !== false && s.text) {
      const id = await confirmCentral(env, { blueprint: fam.id, exam_key: fam.exam_key, text: s.text, area: s.area, ids: A(s.ids), method: methods[s.method] || S(s.method, 30) || 'human_selected', confidence: s.method === 'you' ? null : s.conf }, s.n ? 'c.' + S(s.n, 40) : null);
      if (id) central++; else retries++;
    }
    perf.r = perf.r.filter((r) => !(r.report_id === rid && r.item === item && r.exam_key === fam.exam_key));
    perf.r.push(...A(s.recs).slice(0, 3).map((r) => cleanRecord(r, { ...s, report_id: rid, item }, fam)).filter(Boolean));
    if (!perf.reports.includes(rid)) perf.reports.push(rid);
  }
  // Older reports' archived records are history; keep the most recent ones only.
  const live = perf.r.filter((r) => !r.archived), old = perf.r.filter((r) => r.archived).slice(-600); perf.r = [...live, ...old]; perf.reports = perf.reports.slice(-12);
  const changed = JSON.stringify(perf) !== before;
  if (changed) { await docStmt(env, uid, PERF, perf).run(); await env.DB.prepare('INSERT OR IGNORE INTO mk_ite_dirty (user_id, reason, marked_at) VALUES (?, ?, ?)').bind(uid, 'confirmed', nowIso()).run(); }
  return { perf, central, retries, changed };
}

/* ---------- The pipeline trace ---------- */
const STEPS = ['mapped', 'confirmed', 'stored', 'eligible', 'queued', 'generated'];
const REASON = {
  not_mapped: () => 'Not mapped yet: no objective has been proposed (use "Map again").',
  not_confirmed: () => 'Waiting for your confirmation on the review screen.',
  no_objective: () => 'Confirmed as no blueprint objective, so there is nothing to queue.',
  not_stored: () => 'Confirmed, but not yet saved to your performance record (it is sent again on the next sync).',
  wrong_blueprint: (x) => `Mapped under ${x.have}; your current blueprint is ${x.cur}. Map it again for ${x.cur} on the Progress tab.`,
  topic_only: () => 'Matched to a topic only (no blueprint objective): it moves your plan but has no objective lesson.',
  no_writer: () => 'Not queued: no server writing model is set up, so no lesson could be queued.',
  no_owner: () => 'Not queued: the site has no owner account to run the shared lesson queue.',
  no_topic: () => 'Not queued: the objective has no app topic to file its lesson under.',
  objective_missing: () => 'Not queued: the blueprint objective is no longer current.',
  manual: () => 'Not queued yet: queue it from "Build board lessons" on the Boards tab (automatic queuing is off).',
  queue_failed: (x) => 'The lesson job stopped' + (x.note ? ': ' + x.note : '.') + ' The owner can retry it.',
  writing: (x) => x.paused ? 'Queued; seeding is paused by the owner.' : 'Queued; the lesson is being written.',
};
function jobState(rows) {
  // The best job per objective: done, then active, then failed, then cancelled.
  const rank = (s) => s === 'done' ? 0 : ['running', 'writing', 'queued', 'waiting', 'paused'].includes(s) ? 1 : s === 'failed' ? 2 : 3;
  const by = {}; for (const r of rows) { const c = by[r.objective]; if (!c || rank(r.status) < rank(c.status)) by[r.objective] = r; } return by;
}
async function inChunks(env, sql, ids, extra = []) {
  const out = []; for (let i = 0; i < ids.length; i += 80) { const part = ids.slice(i, i + 80); out.push(...(await env.DB.prepare(sql.replace('(?)', '(' + part.map(() => '?').join(',') + ')')).bind(...part, ...extra).all()).results); } return out;
}
/* The account's current blueprint (exam key): the page passes it; otherwise the learner's selected family; otherwise the report's. */
async function currentExam(env, uid, family, d) {
  if (family) return famOf(family).exam_key;
  const f = await learnerFamily(env, uid).catch(() => null); if (f) return famOf(f).exam_key;
  return S(d && d.mapped, 40) || 'cert';
}

/* computeTrace: pure apart from the lookups it is handed (so tests can drive it). */
export function buildTrace(d, recs, { cur, jobs, lessons, queueErr = {}, paused = false, prev = null, now = Date.now(), cfg }) {
  const rid = reportId(d), curName = famOf(cur).name, P = new Map(A(prev && prev.report_id === rid ? prev.items : []).map((x) => [x.item, x]));
  const stallH = cfg.stall_hours || {}, items = [];
  A(d.missed).forEach((x, i) => {
    const mine = recs.filter((r) => r.item === i);
    const status = x.status || (reviewed(x) ? 'legacy' : 'pending');
    const confirmed = status === 'ok' || status === 'none' || status === 'legacy';
    // Mapped: the engine has proposed something for it (an objective, or explicitly none); a report read but never mapped has no source.
    const mapped = confirmed || !!x.src || A(x.prop).length > 0;
    const ids = confirmed ? [x.objective, ...A(x.also).map((y) => y && y.objective)].filter(Boolean) : A(x.prop);
    const stored = confirmed && (mine.length > 0 || (!ids.length && !x.tid));
    const curRecs = mine.filter((r) => isEligible(r, cur) && r.objective_id), otherRecs = mine.filter((r) => isEligible(r) && r.objective_id && r.exam_key !== cur);
    const objectives = curRecs.map((r) => {
      const j = jobs[r.objective_id], gen = !!lessons[r.objective_id] || (j && j.status === 'done');
      const active = j && ['running', 'writing', 'queued', 'waiting', 'paused'].includes(j.status), q = gen || active;
      const code = gen ? null : active ? 'writing' : j && j.status === 'failed' ? 'queue_failed' : queueErr[r.objective_id] || 'manual';
      return { id: r.objective_id, name: r.oname || r.objective_id, eligible: true, queued: !!q, generated: !!gen, lesson: lessons[r.objective_id] || null, job: j ? { id: j.id, status: j.status } : null,
        code, reason: code ? REASON[code]({ note: j && j.note, paused }) : null };
    });
    let code = null, extra = {};
    if (!mapped) code = 'not_mapped';
    else if (!confirmed) code = 'not_confirmed';
    else if (!stored) code = 'not_stored';
    else if (!ids.length) code = x.tid ? 'topic_only' : 'no_objective';
    else if (!curRecs.length) { code = otherRecs.length ? 'wrong_blueprint' : 'not_stored'; extra = { have: [...new Set(otherRecs.map((r) => famOf(r.exam_key).name))].join(', '), cur: curName }; }
    const eligible = curRecs.length > 0, queued = eligible && objectives.every((o) => o.queued), generated = eligible && objectives.every((o) => o.generated);
    let objReason = null;
    if (!code && !queued) { const o = objectives.find((y) => !y.queued); code = o.code; objReason = o.reason; }
    if (!code && !generated) { const o = objectives.find((y) => !y.generated); code = o.code || 'writing'; objReason = o.reason; }
    const flags = { mapped, confirmed, stored, eligible, queued, generated };
    const terminal = code === 'no_objective' || code === 'topic_only';
    const stage = terminal ? 'done' : STEPS.find((k) => !flags[k]) || 'done';
    const p = P.get(i), since = p && p.stage === stage && p.since ? p.since : stage === 'mapped' || stage === 'confirmed' ? new Date(Number(x.mt || d.t) || now).toISOString() : new Date(now).toISOString();
    const limit = stage === 'done' ? null : Number(stallH[stage]) || null, stallAt = limit ? new Date(Date.parse(since) + limit * 3600e3).toISOString() : null;
    items.push({ report_id: rid, item: i, text: S(x.text, 200), area: S(x.area, 80), method: S(x.src, 12) || null, confidence: x.conf ?? null, objective_ids: ids, ...flags, objectives,
      stage, code: stage === 'done' ? (terminal ? code : null) : code, reason: (stage === 'done' && !terminal) || !code ? null : objReason || REASON[code]({ ...extra, paused, note: '' }), since, stall_at: stallAt, stalled: !!stallAt && Date.parse(stallAt) <= now });
  });
  const count = (k) => items.filter((t) => t[k]).length;
  const counts = { extracted: items.length, mapped: count('mapped'), confirmed: count('confirmed'), stored: count('stored'), eligible: count('eligible'), queued: count('queued'), generated: count('generated'),
    eligible_objectives: new Set(items.flatMap((t) => t.objectives.map((o) => o.id))).size, queued_objectives: new Set(items.flatMap((t) => t.objectives.filter((o) => o.queued).map((o) => o.id))).size,
    generated_objectives: new Set(items.flatMap((t) => t.objectives.filter((o) => o.generated).map((o) => o.id))).size, no_objective: items.filter((t) => t.code === 'no_objective' || t.code === 'topic_only').length,
    stalled: count('stalled') };
  const other = {}; for (const r of recs) if (isEligible(r) && r.objective_id && r.exam_key !== cur) other[r.exam_key] = (other[r.exam_key] || 0) + 1;
  return { v: 1, report_id: rid, exam: S(d.exam, 80), exam_key: cur, blueprint: famOf(cur).id, blueprint_name: curName, mapped_under: S(d.mapped, 40) || null,
    other_blueprints: Object.entries(other).map(([k, n]) => ({ exam_key: k, name: famOf(k).name, records: n })), counts, items };
}

/* ite_trace {family, snapshot}: compute this account's trace (queuing what is eligible and has no lesson or job), store it in the account
   when it changed, and keep the derived watch list and audit summary in step. snapshot: the page's current report (it may not be saved
   yet); otherwise the account's stored med/ite. */
export async function traceFor(env, deps, uid, { family = null, snapshot = null, autoQueue = null, now = Date.now() } = {}) {
  uid = String(uid); await ensureMigrated(env, deps, uid);
  const cfg = await iteConfig(env), docs = await readDocs(env, deps, uid, [ITE, PERF, TRACE]);
  const d = snapshot && Array.isArray(snapshot.missed) ? snapshot : docs[ITE], prev = docs[TRACE] || null;
  if (!d || !A(d.missed).length) {
    if (prev && A(prev.items).length) await docStmt(env, uid, TRACE, { v: 1, report_id: null, counts: {}, items: [] }).run();
    await env.DB.batch([env.DB.prepare('DELETE FROM mk_ite_audit WHERE user_id = ?').bind(uid), env.DB.prepare('DELETE FROM mk_ite_watch WHERE user_id = ?').bind(uid), env.DB.prepare('DELETE FROM mk_ite_dirty WHERE user_id = ?').bind(uid)]);
    return { trace: null };
  }
  const cur = await currentExam(env, uid, family, d), rid = reportId(d), perf = perfOf(docs[PERF]);
  // Records for this report: the account's stored ones; a report the server has not seen yet is read as the planner reads it.
  const recs = perf.reports.includes(rid) ? perf.r.filter((r) => r.report_id === rid && !r.archived) : deriveRecords(d);
  const want = [...new Set(recs.filter((r) => isEligible(r, cur) && r.objective_id).map((r) => r.objective_id))];
  const look = async () => ({
    jobs: jobState(want.length ? await inChunks(env, "SELECT id, objective, status, note FROM mk_gen WHERE objective IN (?) AND (batch = 'seed' OR user_id = ?)", want, [uid]).catch(() => []) : []),
    lessons: Object.fromEntries((want.length ? await inChunks(env, "SELECT json_extract(body, '$.objective') AS o, id FROM mk_objects WHERE type = 'EducationalAsset' AND status = 'current' AND id LIKE 'ea.s.%' AND json_extract(body, '$.objective') IN (?)", want) : []).map((r) => [r.o, r.id])) });
  let L = await look(); const queueErr = {};
  // Stage 6: an eligible objective with no lesson and no job is queued once through the existing seed queue (shared, central).
  const aq = autoQueue == null ? cfg.auto_queue !== false : !!autoQueue;
  const missing = want.filter((id) => !L.lessons[id] && !(L.jobs[id] && L.jobs[id].status !== 'cancelled'));
  if (missing.length) {
    if (!aq) for (const id of missing) queueErr[id] = 'manual';
    else {
      const tidOf = Object.fromEntries(recs.filter((r) => r.objective_id).map((r) => [r.objective_id, r.tid]));
      const q = await queueObjectiveSeeds(env, deps, missing.map((id) => ({ objective: id, tid: tidOf[id] })), { prioBase: Number(cfg.auto_queue_priority_base) || 2 }).catch((e) => ({ error: 'queue_failed', message: String(e.message || e) }));
      if (q.error) for (const id of missing) queueErr[id] = REASON[q.error] ? q.error : 'queue_failed';
      else { for (const [id, r] of Object.entries(q.results || {})) if (r.error) queueErr[id] = REASON[r.error] ? r.error : 'queue_failed'; L = await look(); }
    }
  }
  const paused = (await env.DB.prepare("SELECT v FROM mk_settings WHERE k = 'seed_paused'").first().catch(() => null) || {}).v === '1';
  const trace = buildTrace(d, recs, { cur, jobs: L.jobs, lessons: L.lessons, queueErr, paused, prev, now, cfg });
  const body = { ...trace, computed: new Date(now).toISOString() };
  const same = prev && JSON.stringify({ ...prev, computed: null, _t: null }) === JSON.stringify({ ...body, computed: null, _t: null });
  const stmts = [];
  if (!same) stmts.push(docStmt(env, uid, TRACE, body));
  // Derived companions (per account): the objectives this trace waits on, and the owner's audit summary (counts and stall times only).
  const watch = new Set(trace.items.flatMap((t) => t.objectives.filter((o) => !o.generated).map((o) => o.id)));
  const had = new Set((await env.DB.prepare('SELECT objective_id FROM mk_ite_watch WHERE user_id = ?').bind(uid).all()).results.map((r) => r.objective_id));
  for (const id of had) if (!watch.has(id)) stmts.push(env.DB.prepare('DELETE FROM mk_ite_watch WHERE user_id = ? AND objective_id = ?').bind(uid, id));
  for (const id of watch) if (!had.has(id)) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO mk_ite_watch (user_id, objective_id) VALUES (?, ?)').bind(uid, id));
  const counts = JSON.stringify(trace.counts), stall = JSON.stringify(trace.items.filter((t) => t.stall_at).map((t) => ({ stage: t.stage, code: t.code, at: t.stall_at })));
  const a0 = await env.DB.prepare('SELECT report_id, counts_json, stall_json, exam_key FROM mk_ite_audit WHERE user_id = ?').bind(uid).all();
  const cur0 = a0.results.find((r) => r.report_id === rid);
  if (a0.results.some((r) => r.report_id !== rid)) stmts.push(env.DB.prepare('DELETE FROM mk_ite_audit WHERE user_id = ? AND report_id != ?').bind(uid, rid));
  if (!cur0 || cur0.counts_json !== counts || cur0.stall_json !== stall || cur0.exam_key !== cur)
    stmts.push(env.DB.prepare('INSERT INTO mk_ite_audit (user_id, report_id, exam_key, counts_json, stall_json, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, report_id) DO UPDATE SET exam_key = excluded.exam_key, counts_json = excluded.counts_json, stall_json = excluded.stall_json, updated = excluded.updated')
      .bind(uid, rid, cur, counts, stall, nowIso()));
  stmts.push(env.DB.prepare('DELETE FROM mk_ite_dirty WHERE user_id = ?').bind(uid));
  await env.DB.batch(stmts);
  return { trace: body, written: !same };
}

/* The audit invariant across accounts, for the owner: counts per stage and the items stalled past their thresholds, now. No account
   ids, no item text: only the owner's own trace carries detail. */
export async function auditAll(env, { now = Date.now() } = {}) {
  const rows = (await env.DB.prepare('SELECT exam_key, counts_json, stall_json FROM mk_ite_audit').all()).results;
  const totals = {}, stalledBy = {}; let stalled = 0;
  for (const r of rows) {
    for (const [k, v] of Object.entries(J(r.counts_json, {}) || {})) if (k !== 'stalled') totals[k] = (totals[k] || 0) + (Number(v) || 0);
    for (const s of A(J(r.stall_json, []))) if (s && s.at && Date.parse(s.at) <= now) { stalled++; stalledBy[s.stage] = (stalledBy[s.stage] || 0) + 1; }
  }
  const central = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(confirmations) AS c, COUNT(DISTINCT blueprint) AS b FROM mk_ite_map').first();
  return { accounts: rows.length, totals, stalled, stalled_by_stage: stalledBy, pass: stalled === 0, central: { mappings: (central && central.n) || 0, confirmations: (central && central.c) || 0, blueprints: (central && central.b) || 0 } };
}

/* The engine run: recompute the traces of accounts a transition marked, then migrate a few accounts that have not been migrated. */
export async function iteTick(env, deps, { users = null, migrate = null } = {}) {
  const cfg = await iteConfig(env), out = { traced: 0, migrated: 0 };
  const { results } = await env.DB.prepare('SELECT user_id FROM mk_ite_dirty ORDER BY marked_at LIMIT ?').bind(users ?? (Number(cfg.tick_users_per_run) || 3)).all();
  // A run whose query budget is spent stops here and keeps its marks (the next run continues); any other failure drops the mark, and
  // the account's next page visit recomputes its trace.
  for (const r of results) { try { await traceFor(env, deps, r.user_id); out.traced++; } catch (e) { if (e.budget) throw e; await env.DB.prepare('DELETE FROM mk_ite_dirty WHERE user_id = ?').bind(r.user_id).run(); console.error('ite trace', e); } }
  try { out.migrated = (await migrateSweep(env, deps, { max: migrate ?? (Number(cfg.migration_accounts_per_run) || 2) })).migrated; } catch (e) { if (e.budget) throw e; console.error('ite migrate', e); }
  if (new Date().getUTCMinutes() < 5) await env.DB.prepare('DELETE FROM mk_ite_seen WHERE at < ?').bind(new Date(Date.now() - 30 * 864e5).toISOString()).run().catch(() => { });
  return out;
}

/* Canonical storage (mirror.js, restore.js): the central library as one file, and its restore (never replacing a newer row). */
export async function mappingRows(env) { return (await env.DB.prepare('SELECT * FROM mk_ite_map ORDER BY blueprint, norm, mapping_id').all()).results.map((r) => ({ ...r, objective_ids: J(r.objective_ids, []), canonical_ids: J(r.canonical_ids, []) })); }
export function restoreMappingStmt(env, r) {
  if (!r || !r.mapping_id || !r.blueprint || !r.norm) return null;
  const arr = (v) => typeof v === 'string' ? v : JSON.stringify(A(v));
  return env.DB.prepare(`INSERT INTO mk_ite_map (mapping_id, blueprint, exam_key, norm, source_text, objective_id, objective_ids, canonical_objective, canonical_ids, discipline, confidence, method, verified, version, confirmations, last_confirmed, created, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (mapping_id) DO UPDATE SET exam_key = excluded.exam_key, norm = excluded.norm, source_text = excluded.source_text, objective_id = excluded.objective_id,
      objective_ids = excluded.objective_ids, canonical_objective = excluded.canonical_objective, canonical_ids = excluded.canonical_ids, discipline = excluded.discipline, confidence = excluded.confidence, method = excluded.method,
      verified = excluded.verified, version = excluded.version, confirmations = excluded.confirmations, last_confirmed = excluded.last_confirmed, updated = excluded.updated WHERE excluded.updated > mk_ite_map.updated`)
    .bind(r.mapping_id, r.blueprint, r.exam_key || '', r.norm, S(r.source_text, 300), r.objective_id || '', arr(r.objective_ids), r.canonical_objective || null, arr(r.canonical_ids), r.discipline || null, r.confidence ?? null, r.method || 'migrated',
      r.verified == null ? 1 : Number(r.verified) ? 1 : 0, Number(r.version) || 1, Number(r.confirmations) || 0, r.last_confirmed || null, r.created || nowIso(), r.updated || nowIso());
}
