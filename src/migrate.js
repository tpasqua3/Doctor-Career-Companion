/* ---------- One-time database migration (temporary; removed once the app runs on the new databases) ----------
   Copies the old D1 databases into their new, empty targets, inside Cloudflare, from the five-minute timer:
     DB       (doctor-career-companion)  -> NEW_DB    (usa_doctor_career_companion_east)
     DRILL_DB (mkos-restore-drill)       -> NEW_DRILL (usa_mkos_restore_drill_east)
   The OLD databases are only ever read (SELECT). Everything this module writes goes to the targets.

   The work is a series of passes over every table, in rowid order and in chunks. For each chunk the source rows are read as
   json_array(...) text (an exact encoding: reals round-trip, big integers kept, nothing parsed in JS), the same rowid range is read
   from the target, and the two SHA-256 hashes are compared; a chunk that differs is written with INSERT OR REPLACE (rowids kept) and
   the target's rows that the source no longer has in that range are removed. The first pass therefore copies everything; later
   passes catch up with what changed meanwhile; a pass that finds nothing to change is a verification. sqlite_sequence is synced
   by name at the end of each pass. The mk_objects change-counter triggers are created only at the very end (finalize, during the
   write freeze, after a pass with no differences), and mk_change is then set to the source's value.

   State, settings and the lease live in each target's own table `_migration` (dropped at the end). Settings (main target, k = 'cfg',
   JSON) can be changed with a query: wall_s, q (statements per run), chunk_kb, stmt_kb, pause_jobs (background jobs skip their turn),
   freeze (+ freeze_at, ms): the app refuses writes, the timer runs only this module with the freeze budgets, off. */

const PAIRS = [
  { key: 'drill', src: 'DRILL_DB', dst: 'NEW_DRILL' },
  { key: 'main', src: 'DB', dst: 'NEW_DB' },
];
const DEF = { wall_s: 110, q: 150, chunk_kb: 1500, stmt_kb: 700, freeze_wall_s: 250, freeze_q: 900, n_max: 10000 };
const SKIP = n => n === '_cf_KV' || n === '_migration' || /^sqlite_/.test(n);
const qi = n => '"' + String(n).replace(/"/g, '""') + '"';
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const HI = 9e15;

const ensure = dst => dst.prepare('CREATE TABLE IF NOT EXISTS _migration (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
const getK = async (dst, k) => { const r = await dst.prepare('SELECT v FROM _migration WHERE k = ?').bind(k).first(); try { return r ? JSON.parse(r.v) : null; } catch { return null; } };
const putK = (dst, k, v) => dst.prepare('INSERT INTO _migration (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v));

/* Settings, cached a few seconds per isolate (read on requests for the freeze, and by the timer). A failed read keeps the last value. */
let CFG = { t: 0, v: null };
export async function migCfg(env, fresh) {
  if (!env.NEW_DB) return null;
  if (!fresh && CFG.v && Date.now() - CFG.t < 8000) return CFG.v;
  try { const r = await env.NEW_DB.prepare("SELECT v FROM _migration WHERE k = 'cfg'").first(); CFG = { t: Date.now(), v: { ...DEF, ...(r ? JSON.parse(r.v) : {}) } }; }
  catch { if (!CFG.v) CFG = { t: Date.now(), v: { ...DEF } }; }
  return CFG.v;
}
export const frozen = async env => { const c = await migCfg(env); return !!(c && c.freeze); };

/* During the freeze the old database is read-only for the app: any statement that would change data is refused (schema statements
   that change nothing on an existing database, CREATE ... IF NOT EXISTS and the mk_change seed, are let through). */
const WRITE = /^\s*(?:with\b[\s\S]*?\b)?(insert|update|delete|replace|alter|drop|create|vacuum|reindex)\b/i;
const HARMLESS = /^\s*(create\s+(?:unique\s+)?(?:table|index|trigger|view)\s+if\s+not\s+exists\b|insert\s+or\s+ignore\s+into\s+mk_change\b)/i;
export const isWrite = sql => WRITE.test(sql) && !HARMLESS.test(sql);
export class Frozen extends Error { constructor() { super('Updating, back in a minute.'); this.frozen = true; } }
export function readOnly(db) {
  const wrap = (st, sql) => new Proxy(st, { get(t, p) {
    if (p === '__raw') return t.__raw || t;
    if (p === '__sql') return sql;
    if (p === 'bind') return (...a) => wrap(t.bind(...a), sql);
    if (['first', 'all', 'run', 'raw'].includes(p)) return (...a) => isWrite(sql) ? Promise.reject(new Frozen()) : t[p](...a);
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
  return new Proxy(db, { get(t, p) {
    if (p === 'prepare') return sql => wrap(t.prepare(sql), sql);
    if (p === 'batch') return list => list.some(s => isWrite(s.__sql || '')) ? Promise.reject(new Frozen()) : t.batch(list.map(s => s.__raw || s));
    if (p === 'exec') return sql => isWrite(sql) ? Promise.reject(new Frozen()) : t.exec(sql);
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
}

/* Schema: tables, then indexes, then views, exactly as the source's sqlite_master text. Triggers wait for finalize. */
async function schema(src, dst, M) {
  const S = (await src.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all()).results; M.q++;
  const D = new Map((await dst.prepare("SELECT type, name, sql FROM sqlite_master").all()).results.map(r => [r.name, r])); M.q++;
  const order = { table: 0, index: 1, view: 2 }, made = [], differ = [];
  for (const o of S.filter(o => o.type in order && !SKIP(o.name) && !SKIP(o.tbl_name)).sort((a, b) => order[a.type] - order[b.type])) {
    const have = D.get(o.name);
    if (have) { if (have.sql !== o.sql) differ.push(o.name); continue; }
    await dst.prepare(o.sql).run(); M.q++; made.push(o.name);
  }
  return { tables: S.filter(o => o.type === 'table' && !SKIP(o.name)).map(o => o.name), triggers: S.filter(o => o.type === 'trigger' && !SKIP(o.tbl_name)), made, differ };
}

/* Columns of a table and whether it has an INTEGER PRIMARY KEY (rowid alias), which then carries the rowid itself. */
async function columns(src, t, M) {
  const cols = (await src.prepare('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid').bind(t).all()).results; M.q++;
  const pks = cols.filter(c => c.pk > 0), alias = pks.length === 1 && String(pks[0].type).toUpperCase() === 'INTEGER';
  const names = cols.map(c => c.name), list = (alias ? [] : ['rowid']).concat(names);
  return { names, list, sel: list.map(n => n === 'rowid' ? 'rowid' : qi(n)).join(', ') };
}

/* One chunk of one table: compare, and copy when different. Returns { done, rows, bytes, changed, hash }. */
async function chunk(src, dst, t, C, st, cfg, M) {
  const n = Math.max(1, Math.min(cfg.n_max, st.n || 200));
  let rows;
  try { rows = (await src.prepare(`SELECT rowid AS r, json_array(${C.sel}) AS j FROM ${qi(t)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(st.after, n).all()).results; M.q++; }
  catch (e) { if (n > 1 && /too (big|large)|exceed|memory|limit/i.test(String(e && e.message))) { st.n = Math.max(1, n >> 1); return { retry: true }; } throw e; }
  const last = rows.length < n, hi = last ? HI : rows[rows.length - 1].r;
  const there = (await dst.prepare(`SELECT json_array(${C.sel}) AS j FROM ${qi(t)} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`).bind(st.after, hi).all()).results; M.q++;
  const joined = rows.map(r => r.j).join('\n'), bytes = joined.length;
  const h = await sha(joined), same = there.length === rows.length && (await sha(there.map(r => r.j).join('\n'))) === h;
  M.bytes += bytes + there.reduce((s, r) => s + r.j.length, 0);
  let changed = 0;
  if (!same) {
    const stmts = [], cap = cfg.stmt_kb * 1024, ins = `INSERT OR REPLACE INTO ${qi(t)} (${C.list.map(n => n === 'rowid' ? 'rowid' : qi(n)).join(', ')}) `;
    const viaJson = ins + 'SELECT ' + C.list.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ') + ' FROM json_each(?)';
    const viaBind = ins + 'VALUES (' + C.list.map(() => '?').join(', ') + ')';
    let group = [], size = 0;
    const flush = () => { if (group.length) stmts.push(dst.prepare(viaJson).bind('[' + group.join(',') + ']')); group = []; size = 0; };
    for (const r of rows) {
      if (r.j.length > 1.8e6) { flush(); stmts.push(dst.prepare(viaBind).bind(...JSON.parse(r.j))); continue; }   // one very large row: bound values
      if (size + r.j.length > cap) flush();
      group.push(r.j); size += r.j.length + 1;
    }
    flush();
    stmts.unshift(dst.prepare(`DELETE FROM ${qi(t)} WHERE rowid > ? AND rowid <= ? AND rowid NOT IN (SELECT value FROM json_each(?))`).bind(st.after, hi, JSON.stringify(rows.map(r => r.r))));
    for (let i = 0; i < stmts.length; i += 20) { await dst.batch(stmts.slice(i, i + 20)); M.q += Math.min(20, stmts.length - i); }
    changed = Math.max(rows.length, there.length);
  }
  // Aim the next read of this table at about chunk_kb.
  st.n = Math.max(1, Math.min(cfg.n_max, Math.round(n * (cfg.chunk_kb * 1024) / Math.max(bytes, 1)), n * 4));
  return { done: last, rows: rows.length, bytes, changed, hash: h, to: last ? null : hi };
}

async function syncSequence(src, dst, M) {
  const s = (await src.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).results; M.q++;
  const has = (await dst.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").first()); M.q++;
  if (!has) return s.length ? { error: 'sqlite_sequence missing in target' } : { same: true, rows: 0 };
  const d = (await dst.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).results; M.q++;
  if (JSON.stringify(s) === JSON.stringify(d)) return { same: true, rows: s.length };
  const st = [dst.prepare('DELETE FROM sqlite_sequence WHERE name NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(s.map(r => r.name)))];
  for (const r of s) {
    st.push(dst.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').bind(r.seq, r.name));
    st.push(dst.prepare('INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)').bind(r.name, r.seq, r.name));
  }
  await dst.batch(st); M.q += st.length;
  return { same: false, rows: s.length };
}

/* After a pass with no differences that started inside the freeze: the triggers, then mk_change set to the source's value. */
async function finalize(src, dst, triggers, M) {
  const D = new Set((await dst.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).results.map(r => r.name)); M.q++;
  for (const t of triggers) if (!D.has(t.name)) { await dst.prepare(t.sql).run(); M.q++; }
  const hasChange = await src.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'mk_change'").first(); M.q++;
  if (hasChange) {
    const rows = (await src.prepare('SELECT rowid AS r, k, n FROM mk_change ORDER BY rowid').all()).results; M.q++;
    const st = [dst.prepare('DELETE FROM mk_change WHERE rowid NOT IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map(r => r.r)))];
    for (const r of rows) st.push(dst.prepare('INSERT OR REPLACE INTO mk_change (rowid, k, n) VALUES (?, ?, ?)').bind(r.r, r.k, r.n));
    await dst.batch(st); M.q += st.length;   // triggers only fire on mk_objects, so this sets the value exactly
  }
  return { triggers: triggers.map(t => t.name) };
}

async function runPair(env, P, cfg, M, until, frozenNow) {
  const src = env[P.src], dst = env[P.dst];
  if (!src || !dst) return;
  await ensure(dst); M.q++;
  const now = Date.now();
  const lease = await dst.prepare("INSERT INTO _migration (k, v) VALUES ('lease', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE CAST(_migration.v AS INTEGER) < ? RETURNING k").bind(String(now), now - 6 * 60e3).first(); M.q++;
  if (!lease) return;
  const s = (await getK(dst, 'state')) || { pass: 1, ti: 0, after: 0, tables: {}, runs: [] }; M.q++;
  const t0 = Date.now(), m0 = { q: M.q, bytes: M.bytes }; let chunks = 0, changedRows = 0;
  try {
    if (!s.pass_started) { s.pass_started = Date.now(); s.pass_frozen = frozenNow && cfg.freeze_at && Date.now() > cfg.freeze_at + 30e3; s.diff_chunks = 0; s.diff_rows = 0; s.th = {}; }
    const sc = await schema(src, dst, M);
    if (sc.made.length) (s.schema_made = s.schema_made || []).push(...sc.made);
    s.schema_differ = sc.differ;
    while (s.ti < sc.tables.length && Date.now() < until && M.q < M.max - 8) {
      const t = sc.tables[s.ti], ts = (s.tables[t] = s.tables[t] || {}), cur = { n: ts.n, after: s.after };
      const C = await columns(src, t, M);
      let r = await chunk(src, dst, t, C, cur, cfg, M);
      if (r.retry) { ts.n = cur.n; continue; }
      ts.n = cur.n; chunks++;
      s.th[t] = await sha((s.th[t] || '') + r.hash); s.rows_in_pass = (s.rows_in_pass || {}); s.rows_in_pass[t] = (s.rows_in_pass[t] || 0) + r.rows;
      if (r.changed) { s.diff_chunks++; s.diff_rows += r.changed; changedRows += r.changed; }
      if (r.done) { ts.rows = s.rows_in_pass[t]; ts.hash = s.th[t]; ts.pass = s.pass; s.ti++; s.after = 0; }
      else s.after = r.to;
      if (chunks % 10 === 0) { await putK(dst, 'state', s).run(); M.q++; }
    }
    if (s.ti >= sc.tables.length) {
      const seq = await syncSequence(src, dst, M);
      if (!seq.same) { s.diff_chunks++; s.diff_rows += seq.rows || 0; }
      const pass = { n: s.pass, started: new Date(s.pass_started).toISOString(), ended: new Date().toISOString(), ms: Date.now() - s.pass_started,
        frozen: !!s.pass_frozen, diff_chunks: s.diff_chunks, diff_rows: s.diff_rows, tables: sc.tables.length,
        rows: Object.values(s.rows_in_pass || {}).reduce((a, b) => a + b, 0), schema_differ: sc.differ, sequence: seq };
      (s.passes = s.passes || []).push(pass); s.passes = s.passes.slice(-12);
      if (pass.frozen && !pass.diff_chunks && !sc.differ.length) {
        s.final = { ...(await finalize(src, dst, sc.triggers, M)), pass: pass.n, at: pass.ended,
          report: Object.fromEntries(sc.tables.map(t => [t, { rows: s.tables[t].rows, sha256: s.tables[t].hash }])) };
        s.ready = true;
      }
      s.pass++; s.ti = 0; s.after = 0; delete s.pass_started; delete s.rows_in_pass; delete s.th;
    }
    delete s.error;
  } catch (e) { s.error = String(e && e.stack || e).slice(0, 600); s.error_at = new Date().toISOString(); console.error('migrate', P.key, e); }
  finally {
    s.runs = (s.runs || []).concat([{ at: new Date(t0).toISOString(), ms: Date.now() - t0, q: M.q - m0.q, mb: Math.round((M.bytes - m0.bytes) / 1e5) / 10, chunks, changed: changedRows, frozen: !!frozenNow }]).slice(-16);
    await putK(dst, 'state', s).run().catch(() => { });
    await dst.prepare("UPDATE _migration SET v = '0' WHERE k = 'lease'").run().catch(() => { });
  }
}

/* The timer's step. Runs after the app's own jobs, inside its own budget of time and statements. */
export async function migrateTick(env) {
  if (!env.NEW_DB && !env.NEW_DRILL) return;
  const cfg = await migCfg(env, true);
  if (!cfg || cfg.off) return;
  const fz = !!cfg.freeze, until = Date.now() + 1000 * (fz ? cfg.freeze_wall_s : cfg.wall_s);
  const M = { q: 0, bytes: 0, max: fz ? cfg.freeze_q : cfg.q };
  for (const P of PAIRS) { if (Date.now() >= until || M.q >= M.max - 8) break; await runPair(env, P, cfg, M, until, fz); }
}
