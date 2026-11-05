// SQLite backend (node:sqlite, built into Node 22.5+) behind the small slice of the mysql2/promise pool API the server uses:
// pool.query(sql, params) → [rows | { affectedRows, insertId }], pool.getConnection() with begin/commit/rollback/release, pool.end().
// The server's SQL is written for MySQL; translate() rewrites the few MySQL-only bits it uses.
import { DatabaseSync } from 'node:sqlite';
import { expand, parseRow, translate, type Param } from './sqlDialect.ts';
export { translateSchema } from './sqlDialect.ts';

export function createSqlitePool(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // One connection, so a transaction must not interleave with other requests' queries: a promise lock serialises them.
  // ponytail: single writer, fine for testing / small teams; use MySQL for real concurrency.
  let lock: Promise<void> = Promise.resolve();
  let owner: object | null = null;

  const run = (sql: string, params: Param[] = []) => {
    const { text, values } = expand(translate(sql), params);
    let stmt;
    try { stmt = db.prepare(text); } catch (e: any) { e.sql = text; throw e; }
    if (stmt.columns().length) return [stmt.all(...values).map(r => parseRow(r as Record<string, unknown>))] as [any[]];
    const res = stmt.run(...values);
    return [{ affectedRows: Number(res.changes), insertId: Number(res.lastInsertRowid) }] as [any];
  };
  const wrap = (e: any) => {
    if (/duplicate column name/.test(e?.message)) e.errno = 1060; // same signal openDb uses for MySQL
    if (/UNIQUE constraint failed/.test(e?.message)) { e.code = 'ER_DUP_ENTRY'; e.errno = 1062; }
    if (process.env.SQLITE_DEBUG && /syntax error/.test(e?.message)) console.error('SQLITE SQL:', e.sql);
    return e;
  };
  const query = async (sql: string, params?: Param[]) => {
    while (owner) await lock; // wait for any open transaction to finish
    try { return run(sql, params); } catch (e) { throw wrap(e); }
  };

  return {
    query,
    async getConnection() {
      while (owner) await lock;
      const me = {};
      let release!: () => void;
      owner = me;
      lock = new Promise(r => (release = r));
      const done = () => { if (owner === me) { owner = null; release(); } };
      return {
        query: async (sql: string, params?: Param[]) => { try { return run(sql, params); } catch (e) { throw wrap(e); } },
        beginTransaction: async () => { db.exec('BEGIN IMMEDIATE'); },
        commit: async () => { db.exec('COMMIT'); },
        rollback: async () => { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } },
        release: done,
      };
    },
    async end() { db.close(); },
  };
}
