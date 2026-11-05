// MySQL → SQLite translation for the few MySQL-only bits the server's SQL uses. Pure (no Node imports):
// used by the server's SQLite backend (node:sqlite) and by the phone's offline mode (expo-sqlite).
const NOW = `strftime('%Y-%m-%d %H:%M:%f','now')`;
const UUID = `(lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(2))||'-'||hex(randomblob(6))))`;
// columns whose values are JSON (built with JSON_OBJECT or stored as JSON); mysql2 parses these itself
const JSON_COLS = new Set(['data', 'author', 'holder', 'category', 'reply', 'preview_att', 'last_reply', 'profile', 'channel', 'payer', 'last',
  'line_items', 'fields', 'mentions', 'reactions', 'old_row', 'new_row']);

/** CONCAT(a, b, c) → (a || b || c), respecting nested parentheses and quotes. */
function concat(sql: string) {
  let i: number;
  while ((i = sql.search(/\bCONCAT\(/)) !== -1) {
    let depth = 0, q = false, start = i + 7, args: string[] = [], last = start, j = start;
    for (; j < sql.length; j++) {
      const ch = sql[j];
      if (ch === "'") q = !q;
      if (q) continue;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) { args.push(sql.slice(last, j)); last = j + 1; }
    }
    args.push(sql.slice(last, j));
    sql = `${sql.slice(0, i)}(${args.map(a => a.trim()).join(' || ')})${sql.slice(j + 1)}`;
  }
  return sql;
}

const cache = new Map<string, string>();
export function translate(sql: string) {
  let out = cache.get(sql);
  if (out) return out;
  out = concat(sql)
    .replace(/\bUUID\(\)/g, UUID)
    .replace(/\bJSON_OBJECT\(/g, 'json_object(')
    .replace(/\bIF\(/g, 'IIF(')
    .replace(/\s+FOR UPDATE\b/g, '')
    .replace(/\bCURDATE\(\)/g, `date('now')`)
    .replace(/\bNOW\(\)/g, NOW)
    .replace(/\bDATE_FORMAT\(([^,]+),\s*('[^']*')\)/g, 'strftime($2, $1)')
    .replace(/<=>/g, 'IS') // null-safe equality
    .replace(/\bINSERT IGNORE\b/g, 'INSERT OR IGNORE')
    .replace(/\bON DUPLICATE KEY UPDATE\b/g, 'ON CONFLICT DO UPDATE SET')
    .replace(/\bVALUES\((\w+)\)/g, 'excluded.$1')
    .replace(/"([^"'\n]*)"/g, "'$1'"); // MySQL "string" literals; SQLite reads double quotes as identifiers
  cache.set(sql, out);
  return out;
}

/** schema.sql (MySQL DDL) → SQLite DDL: indexes become CREATE INDEX, types and defaults mapped. */
export function translateSchema(ddl: string) {
  const indexes: string[] = [];
  const tables = ddl.split(/;\s*\n/).map(stmt => {
    const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt)?.[1];
    if (!table) return stmt;
    const lines = stmt.split('\n').filter(l => {
      const m = /^\s*INDEX \(([^)]+)\),?\s*$/.exec(l);
      if (m) indexes.push(`CREATE INDEX IF NOT EXISTS ix_${table}_${m[1].replace(/\W+/g, '_')} ON ${table} (${m[1]})`);
      return !m;
    });
    return lines.join('\n').replace(/,(\s*(--[^\n]*)?\s*\n\s*\))\s*$/, '$1');
  });
  const body = tables.join(';\n')
    .replace(/\bBIGINT AUTO_INCREMENT PRIMARY KEY\b/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bENUM\([^)]*\)/g, 'TEXT')
    .replace(/\bJSON\b/g, 'TEXT')
    .replace(/\s+ON UPDATE CURRENT_TIMESTAMP/g, '')
    .replace(/DEFAULT CURRENT_TIMESTAMP\(3\)/g, `DEFAULT (${NOW})`)
    .replace(/DEFAULT \(UUID\(\)\)/g, `DEFAULT ${UUID}`);
  return `${body};\n${indexes.join(';\n')};
CREATE TRIGGER IF NOT EXISTS threads_touch AFTER UPDATE ON threads WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;`;
}

export type Param = unknown;
/** mysql2-style params: arrays expand to ?,?,? (IN (?)), arrays of arrays to (?,?),(?,?) (VALUES ?). */
export function expand(sql: string, params: Param[]) {
  const flat: unknown[] = [];
  let k = 0;
  const text = sql.replace(/\?/g, () => {
    const p = params[k++];
    if (!Array.isArray(p)) { flat.push(p); return '?'; }
    if (Array.isArray(p[0])) { (p as unknown[][]).forEach(row => flat.push(...row)); return (p as unknown[][]).map(row => `(${row.map(() => '?').join(',')})`).join(','); }
    flat.push(...p);
    return p.length ? p.map(() => '?').join(',') : 'NULL';
  });
  const values = flat.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0)
    : v instanceof Date ? v.toISOString().replace('T', ' ').replace('Z', '')
    : v && typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v) : v);
  return { text, values: values as (string | number | null | bigint | Uint8Array)[] };
}

export function parseRow(r: Record<string, unknown>) {
  const o: Record<string, unknown> = { ...r };
  for (const k in o) if (JSON_COLS.has(k) && typeof o[k] === 'string') { try { o[k] = JSON.parse(o[k] as string); } catch { /* plain text */ } }
  return o;
}

