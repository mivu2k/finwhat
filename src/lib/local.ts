// Offline mode: the whole API runs on the phone. Same route handlers as the server (server/core.ts), over expo-sqlite,
// with the server's MySQL-dialect SQL translated by the same code the server's SQLite backend uses (server/sqlDialect.ts).
// Single user ("you", owner of everything); no login, no AI, no exports.
import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import { HttpError, coreRoutes, createChannel, createWorkspace, one, recordAttachment, setIdGenerator, threadRoleOf, type Route } from '../../server/core.ts';
import { expand, parseRow, translate, translateSchema, type Param } from '../../server/sqlDialect.ts';
import { MIGRATIONS, SCHEMA } from '../../server/schema.ts';
import { canComment } from './workflow.ts';
import { REPORTS } from '../../server/core.ts';

export const LOCAL_UID = 'local-user';
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
setIdGenerator(uuid);

const files = () => { const d = new Directory(Paths.document, 'attachments'); d.create({ idempotent: true, intermediates: true }); return d; };
const fileFor = (id: string) => new File(files(), id);

/** mysql2-shaped pool over expo-sqlite (what core.ts expects). One connection: a lock keeps transactions from interleaving. */
function makePool(db: SQLite.SQLiteDatabase) {
  let lock: Promise<void> = Promise.resolve();
  let busy = false;
  const run = async (sql: string, params: Param[] = []) => {
    const { text, values: raw } = expand(translate(sql), params);
    const values = raw as SQLite.SQLiteBindValue[]; // expand() never yields bigint here
    if (/^\s*(SELECT|WITH)\b/i.test(text)) return [(await db.getAllAsync<Record<string, unknown>>(text, values)).map(parseRow)] as [any[]];
    const r = await db.runAsync(text, values);
    return [{ affectedRows: r.changes, insertId: r.lastInsertRowId }] as [any];
  };
  const wrap = (e: any) => { if (/duplicate column name/.test(e?.message)) e.errno = 1060; return e; };
  return {
    async query(sql: string, params?: Param[]) {
      while (busy) await lock;
      try { return await run(sql, params); } catch (e) { throw wrap(e); }
    },
    async getConnection() {
      while (busy) await lock;
      let release!: () => void;
      busy = true; lock = new Promise(r => (release = r));
      return {
        query: async (sql: string, params?: Param[]) => { try { return await run(sql, params); } catch (e) { throw wrap(e); } },
        beginTransaction: () => db.execAsync('BEGIN'),
        commit: () => db.execAsync('COMMIT'),
        rollback: async () => { try { await db.execAsync('ROLLBACK'); } catch { /* none open */ } },
        release: () => { busy = false; release(); },
      };
    },
  };
}

let ready: Promise<{ pool: any; routes: Route[]; db: SQLite.SQLiteDatabase }> | null = null;
/** Open (and on first use create) the on-device database: schema, you as the only user, a starter workspace and channel. */
function engine() {
  ready ??= (async () => {
    const db = await SQLite.openDatabaseAsync('expensechat.db');
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const pool = makePool(db);
    for (const stmt of translateSchema(SCHEMA).split(/;\s*\n(?!\s*BEGIN|\s*END)/).filter(x => x.trim())) await pool.query(stmt);
    for (const m of MIGRATIONS) await pool.query(m.replace(/JSON NULL/, 'TEXT NULL')).catch((e: any) => { if (e.errno !== 1060) throw e; });
    if (!(await one(pool as any, 'SELECT 1 FROM users WHERE id = ?', [LOCAL_UID]))) {
      await pool.query('INSERT INTO users (id, email, password_hash, full_name) VALUES (?,?,?,?)', [LOCAL_UID, 'you@this.phone', '-', 'You']);
      const ws = await createWorkspace(pool as any, LOCAL_UID, 'My expenses');
      await createChannel(pool as any, LOCAL_UID, ws, 'General', false); // no second person to approve: submit = approved
    }
    const routes = coreRoutes(pool as any, { ai: async () => ({ transcribe: false, extract: false }), fileUrl: (_req, id) => fileFor(id).uri });
    return { pool, routes, db };
  })();
  return ready;
}

const OFFLINE_ONLY: Record<string, string> = {
  '/threads/:id/extract': 'Reading receipts with AI needs server mode.',
  '/export-link': 'Exports need server mode.',
};

/** Answer one API request on the device, exactly as the server would (same handlers, same errors). */
export async function localRequest(method: string, fullPath: string, body?: unknown) {
  const { routes } = await engine();
  const [path, qs = ''] = fullPath.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  for (const route of routes) {
    if (route.m !== method) continue;
    const keys: string[] = [];
    const re = new RegExp('^' + route.p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return (await route.h({ uid: LOCAL_UID, params, query, body: body ?? {} })) ?? { ok: true };
  }
  const known = Object.keys(OFFLINE_ONLY).find(p => new RegExp('^' + p.replace(/:\w+/g, '[^/]+') + '$').test(path));
  throw new HttpError(known ? 503 : 404, known ? OFFLINE_ONLY[known] : `not available offline: ${method} ${path}`);
}

/** Keep a picked/recorded file in the app's storage and attach it to the thread. */
export async function localUpload(threadId: string, uri: string, name: string, mime: string, id: string) {
  const { pool } = await engine();
  const { role, channel_id, status } = await threadRoleOf(pool, LOCAL_UID, threadId);
  if (!canComment(role)) throw new HttpError(403, 'viewers cannot upload');
  if (status === 'closed') throw new HttpError(403, 'thread is closed');
  if (await one(pool, 'SELECT 1 FROM attachments WHERE id = ?', [id])) return { id, transcript: null };
  const dest = fileFor(id);
  await new File(uri).copy(dest, { overwrite: true });
  await recordAttachment(pool, LOCAL_UID, threadId, channel_id, {
    id, name: name.replace(/[^\w.-]/g, '_').slice(0, 120), mime, size: dest.size ?? 0, sha256: null, storagePath: dest.uri,
  });
  return { id, transcript: null };
}

const BACKUP_FORMAT = 'expensechat-backup-1';
/** Everything offline mode holds, as one JSON string: every table plus the attachment files. */
export async function dumpBackup() {
  const { db } = await engine();
  const names = (await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`, [])).map(t => t.name);
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const n of names) tables[n] = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${n}`, []);
  const attachments: Record<string, string> = {};
  for (const a of tables.attachments ?? []) {
    const f = fileFor(String(a.id));
    if (f.exists) attachments[String(a.id)] = await f.base64();
  }
  return JSON.stringify({ format: BACKUP_FORMAT, created_at: new Date().toISOString(), tables, attachments });
}

/** Replaces all offline data with a backup. Validated before anything is touched; all-or-nothing for the database. */
export async function restoreBackup(json: string) {
  const data = JSON.parse(json);
  if (data?.format !== BACKUP_FORMAT || !data.tables?.users) throw new HttpError(400, 'That is not an ExpenseChat backup file.');
  const { db } = await engine();
  const known = (await db.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`, [])).map(t => t.name);
  await db.execAsync('PRAGMA foreign_keys = OFF; BEGIN');
  try {
    for (const n of known) await db.execAsync(`DELETE FROM ${n}`);
    for (const n of known) for (const row of data.tables[n] ?? []) {
      const cols = Object.keys(row).filter(c => c !== 'base_amount'); // computed by the database
      await db.runAsync(`INSERT INTO ${n} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row[c]) as SQLite.SQLiteBindValue[]);
    }
    await db.execAsync('COMMIT');
  } catch (e) { await db.execAsync('ROLLBACK'); throw e; } finally { await db.execAsync('PRAGMA foreign_keys = ON'); }
  for (const [id, b64] of Object.entries<string>(data.attachments ?? {})) fileFor(id).write(b64, { encoding: 'base64' });
}

/** Offline reports: rows for the phone's PDF and spreadsheet (CSV). */
export async function localReportRows(report: string, channel?: string, from?: string, to?: string) {
  const { pool } = await engine();
  const r = REPORTS[report] ?? REPORTS.all;
  const where = ['t.status IN (?)']; const params: unknown[] = [r.statuses];
  const day = 'COALESCE(t.expense_date, SUBSTR(t.created_at, 1, 10))';
  if (channel) { where.push('(t.channel_id = ? OR ch.parent_id = ?)'); params.push(channel, channel); }
  if (from) { where.push(`${day} >= ?`); params.push(from); }
  if (to) { where.push(`${day} <= ?`); params.push(to); }
  if (r.advances) where.push(`t.kind = 'advance'`);
  const [rows] = await pool.query(`SELECT ${day} AS date, t.kind, ch.name AS channel, COALESCE(c.name, '') AS category, t.title, t.vendor, t.status, t.currency, COALESCE(t.amount, 0) AS amount,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.thread_id = t.id), 0) AS paid
    FROM threads t JOIN channels ch ON ch.id = t.channel_id LEFT JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')} ORDER BY date`, params);
  return { title: r.title, rows: rows as Record<string, any>[] };
}
