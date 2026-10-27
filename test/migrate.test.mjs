import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateTick, isWrite, readOnly } from '../src/migrate.js';

/* A small D1 over node:sqlite (prepare/bind/first/all/run, batch as one transaction). */
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } });
  return { raw: db, prepare: sql => stmt(sql), batch: async list => { db.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const SCHEMA = `CREATE TABLE mk_objects (id TEXT PRIMARY KEY, body TEXT NOT NULL, trust REAL NOT NULL DEFAULT 0);
CREATE TABLE mk_change (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE mk_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, detail TEXT);
CREATE TABLE docs (user_id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (user_id, path));
CREATE INDEX mk_objects_trust ON mk_objects (trust);
CREATE VIEW v_obj AS SELECT id FROM mk_objects;
CREATE TRIGGER mk_objects_chg_i AFTER INSERT ON mk_objects BEGIN UPDATE mk_change SET n = n + 1 WHERE k = 'objects'; END;
CREATE TRIGGER mk_objects_chg_u AFTER UPDATE ON mk_objects BEGIN UPDATE mk_change SET n = n + 1 WHERE k = 'objects'; END;
INSERT INTO mk_change VALUES ('objects', 41);`;
const dump = (db, t) => JSON.stringify(db.raw.prepare(`SELECT rowid AS r, * FROM ${t} ORDER BY rowid`).all());
const set = (dst, v) => dst.raw.prepare("INSERT INTO _migration (k, v) VALUES ('cfg', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(JSON.stringify(v));

test('copies schema and data, catches up, verifies in the freeze, then adds triggers and mk_change', async () => {
  const DB = d1(), NEW_DB = d1(), DRILL_DB = d1(), NEW_DRILL = d1();
  DB.raw.exec(SCHEMA); DRILL_DB.raw.exec(SCHEMA);
  for (let i = 0; i < 700; i++) DB.raw.prepare('INSERT INTO mk_objects (id, body, trust) VALUES (?, ?, ?)').run('o' + i, 'x'.repeat(i * 7) + '"\\é', i / 3);
  DB.raw.prepare('INSERT INTO mk_audit (at, detail) VALUES (?, ?)').run('t', null);
  DB.raw.prepare('INSERT INTO docs VALUES (?, ?, ?)').run('u', 'med/state', JSON.stringify({ big: 9007199254740993n.toString(), r: 0.1 + 0.2 }));
  DB.raw.exec("DELETE FROM mk_audit; INSERT INTO mk_audit (at) VALUES ('t2')");   // sqlite_sequence 2, one row
  const env = { DB, NEW_DB, DRILL_DB, NEW_DRILL };
  const before = dump(DB, 'mk_objects');
  for (let i = 0; i < 6; i++) { await migrateTick(env); NEW_DB.raw.exec("UPDATE _migration SET v = '0' WHERE k = 'lease'"); }
  assert.equal(dump(NEW_DB, 'mk_objects'), before);
  assert.equal(dump(DB, 'mk_objects'), before);   // the source is untouched
  assert.equal(NEW_DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n, 0);   // not before the end
  assert.ok(NEW_DB.raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mk_objects_trust'").get());
  // live changes: an update, a delete, a new row, then catch-up passes
  DB.raw.exec("UPDATE mk_objects SET body = 'changed' WHERE id = 'o5'; DELETE FROM mk_objects WHERE id = 'o9'; INSERT INTO mk_objects (id, body) VALUES ('new', 'n'); INSERT INTO mk_audit (at) VALUES ('t3')");
  for (let i = 0; i < 4; i++) { await migrateTick(env); NEW_DB.raw.exec("UPDATE _migration SET v = '0' WHERE k = 'lease'"); }
  for (const t of ['mk_objects', 'mk_audit', 'docs', 'sqlite_sequence']) assert.equal(dump(NEW_DB, t), dump(DB, t), t);
  let st = JSON.parse(NEW_DB.raw.prepare("SELECT v FROM _migration WHERE k = 'state'").get().v);
  assert.ok(!st.ready && !st.error, st.error);
  set(NEW_DB, { freeze: true, freeze_at: Date.now() - 60e3 });
  for (let i = 0; i < 4 && !st.ready; i++) { await migrateTick(env); NEW_DB.raw.exec("UPDATE _migration SET v = '0' WHERE k = 'lease'"); st = JSON.parse(NEW_DB.raw.prepare("SELECT v FROM _migration WHERE k = 'state'").get().v); }
  assert.ok(st.ready, JSON.stringify(st.passes));
  assert.equal(NEW_DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n, 2);
  assert.equal(dump(NEW_DB, 'mk_change'), dump(DB, 'mk_change'));
  assert.equal(st.final.report.mk_objects.rows, 700);
  const sch = db => JSON.stringify(db.raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '_migration' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").all());
  assert.equal(sch(NEW_DB), sch(DB));
  const ds = JSON.parse(NEW_DRILL.raw.prepare("SELECT v FROM _migration WHERE k = 'state'").get().v);
  assert.ok(ds.passes.length >= 1 && !ds.error);
});

test('the freeze refuses writes but lets reads and harmless schema statements through', async () => {
  const DB = d1(); DB.raw.exec(SCHEMA); const R = readOnly(DB);
  assert.equal(isWrite('SELECT 1'), false); assert.equal(isWrite('INSERT INTO docs VALUES (1,2,3)'), true);
  assert.equal(isWrite('CREATE TABLE IF NOT EXISTS docs (a)'), false); assert.equal(isWrite("INSERT OR IGNORE INTO mk_change (k, n) VALUES ('objects', 1)"), false);
  assert.equal(isWrite('UPDATE drive_accounts SET lease = 1 RETURNING *'), true);
  assert.ok(await R.prepare('SELECT COUNT(*) AS n FROM mk_objects').first());
  await assert.rejects(R.prepare('INSERT INTO docs VALUES (?, ?, ?)').bind('a', 'b', 'c').run(), /Updating/);
  await assert.rejects(R.batch([R.prepare('SELECT 1'), R.prepare('DELETE FROM docs')]), /Updating/);
  await R.batch([R.prepare('CREATE TABLE IF NOT EXISTS docs (a)'), R.prepare('SELECT 1')]);
});
