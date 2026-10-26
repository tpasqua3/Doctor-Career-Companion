// A Cloudflare D1-compatible binding over node:sqlite, for running the MKOS engine locally (tests and dry runs).
import { DatabaseSync } from 'node:sqlite';

// strict: behave like D1 where it is stricter than SQLite (at most 100 bound parameters; undefined is refused).
export function d1(file = ':memory:', { strict = false } = {}) {
  const db = new DatabaseSync(file);
  const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const stmt = (sql, args = []) => ({
    bind: (...a) => { if (strict && a.length > 100) throw new Error('D1: too many bound parameters (' + a.length + ') in ' + sql.slice(0, 80)); if (strict && a.some((v) => v === undefined)) throw new Error('D1: undefined bound in ' + sql.slice(0, 80)); return stmt(sql, a); },
    first: async (col) => { const r = db.prepare(sql).get(...norm(args)); return r == null ? null : col ? r[col] : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...norm(args)).map((r) => ({ ...r })), success: true }),
    run: async () => { const r = db.prepare(sql).run(...norm(args)); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
    raw: async () => db.prepare(sql).all(...norm(args)).map((r) => Object.values(r)),
    // In a batch, D1 returns each statement's rows (empty for writes) beside its meta.
    _exec: () => /^\s*(select|with)\b/i.test(sql) ? { results: db.prepare(sql).all(...norm(args)).map((r) => ({ ...r })), meta: { changes: 0 } } : { results: [], meta: db.prepare(sql).run(...norm(args)) },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { const out = list.map((s) => ({ success: true, ...s._exec() })); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
    _db: db,
  };
}
