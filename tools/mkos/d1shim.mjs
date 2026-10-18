// A Cloudflare D1-compatible binding over node:sqlite, for running the MKOS engine locally (tests and dry runs).
import { DatabaseSync } from 'node:sqlite';

export function d1(file = ':memory:') {
  const db = new DatabaseSync(file);
  const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async (col) => { const r = db.prepare(sql).get(...norm(args)); return r == null ? null : col ? r[col] : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...norm(args)).map((r) => ({ ...r })), success: true }),
    run: async () => { const r = db.prepare(sql).run(...norm(args)); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
    raw: async () => db.prepare(sql).all(...norm(args)).map((r) => Object.values(r)),
    _exec: () => db.prepare(sql).run(...norm(args)),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => { db.exec('BEGIN'); try { const out = list.map((s) => ({ success: true, meta: s._exec() })); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
    _db: db,
  };
}
