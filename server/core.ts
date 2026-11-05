// Portable core of the ExpenseChat API: domain rules + the route handlers that only need a database.
// No Node or Express imports, so the same code runs in the server (MySQL or SQLite) and on the phone (expo-sqlite, offline mode).
import { canTransition, canEditFields, canComment, isApprover, type Role, type Status } from '../src/lib/workflow.ts';

/** The slice of a mysql2/promise pool the core uses; server/sqlite.ts and the phone (src/lib/local.ts) provide the same shape. */
export type Conn = { query(sql: string, params?: unknown[]): Promise<any> };
export type PoolConnection = Conn & { beginTransaction(): Promise<unknown>; commit(): Promise<unknown>; rollback(): Promise<unknown>; release(): void };
export type Pool = Conn & { getConnection(): Promise<PoolConnection> };

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
export const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

let newId: () => string = () => globalThis.crypto.randomUUID();
/** The phone has no crypto.randomUUID; it plugs its own generator in. */
export const setIdGenerator = (fn: () => string) => { newId = fn; };
const randomUUID = () => newId();

export const DEFAULT_CATEGORIES = ['Travel', 'Meals', 'Office supplies', 'Utilities', 'Fuel', 'Salaries', 'Rent', 'Software', 'Other'];

export type Q = Pool | PoolConnection;
export async function rows<T = any>(db: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await db.query(sql, params);
  return r as T[];
}
export const one = async <T = any>(db: Q, sql: string, params: unknown[] = []) => (await rows<T>(db, sql, params))[0];

const realRole = async (db: Q, uid: string, channelId: string) =>
  (await one<{ role: Role }>(db, 'SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?', [channelId, uid]))?.role ?? null;
/** The user's role, raised to approver while someone has delegated their approvals to them. */
/**
 * THE rule for who sees which record; every query returning records uses it (one ? = the viewer).
 * Owners, approvers and active delegates see all. Others by their record_scope: 'all', 'own' (made by or given to them),
 * or 'selected' (own plus the people assigned to them).
 */
export const visibleSql = (a = 't') => `EXISTS (SELECT 1 FROM channel_members vm WHERE vm.channel_id = ${a}.channel_id AND vm.user_id = ? AND (
  vm.role IN ('owner','approver') OR vm.record_scope = 'all' OR ${a}.created_by = vm.user_id OR ${a}.assigned_to = vm.user_id
  OR (vm.record_scope = 'selected' AND EXISTS (SELECT 1 FROM scope_users su WHERE su.channel_id = vm.channel_id AND su.user_id = vm.user_id AND su.can_see IN (${a}.created_by, ${a}.assigned_to)))
  OR EXISTS (SELECT 1 FROM delegations vd WHERE vd.channel_id = vm.channel_id AND vd.to_user = vm.user_id AND vd.until_date >= CURDATE())))`;
export const channelRole = async (db: Q, uid: string, channelId: string) => {
  const role = await realRole(db, uid, channelId);
  if (role !== 'member') return role;
  const d = await one(db, 'SELECT 1 AS y FROM delegations WHERE channel_id = ? AND to_user = ? AND until_date >= CURDATE()', [channelId, uid]);
  return d ? ('approver' as Role) : role;
};
export const wsRole = async (db: Q, uid: string, wsId: string) =>
  (await one<{ role: string }>(db, 'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [wsId, uid]))?.role ?? null;

export async function audit(db: Q, actor: string | null, channelId: string | null, table: string, rowId: string, action: string, oldRow: unknown, newRow: unknown) {
  await db.query('INSERT INTO audit_logs (channel_id, table_name, row_id, action, actor, old_row, new_row) VALUES (?,?,?,?,?,?,?)',
    [channelId, table, rowId, action, actor, oldRow ? JSON.stringify(oldRow) : null, newRow ? JSON.stringify(newRow) : null]);
}

export async function tx<T>(pool: Pool, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool.getConnection();
  try { await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
  catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}

// ───────────── domain operations (also used by seed) ─────────────
export async function createWorkspace(pool: Pool, uid: string, name: string) {
  if (!name?.trim() || name.length > 80) fail(400, 'workspace name required');
  return tx(pool, async c => {
    const id = randomUUID();
    await c.query('INSERT INTO workspaces (id, name, created_by) VALUES (?,?,?)', [id, name.trim(), uid]);
    await c.query('INSERT INTO workspace_members VALUES (?,?,?)', [id, uid, 'admin']);
    await c.query('INSERT INTO categories (workspace_id, name) VALUES ?', [DEFAULT_CATEGORIES.map(n => [id, n])]);
    return id;
  });
}

export async function createChannel(pool: Pool, uid: string, wsId: string, name: string, approvalRequired = true, parentId?: string | null) {
  if (parentId) {
    const parent = await one(pool, 'SELECT workspace_id, parent_id FROM channels WHERE id = ?', [parentId]);
    if (!parent || parent.workspace_id !== wsId) fail(400, 'parent channel not found in this workspace');
    if (parent.parent_id) fail(400, 'a sub-channel cannot have its own sub-channels');
    if ((await realRole(pool, uid, parentId)) !== 'owner') fail(403, 'only the channel owner can add sub-channels');
  }
  if (!(await wsRole(pool, uid, wsId))) fail(403, 'not a workspace member');
  if (!name?.trim() || name.length > 80) fail(400, 'channel name required');
  return tx(pool, async c => {
    const id = randomUUID();
    await c.query('INSERT INTO channels (id, workspace_id, name, approval_required, created_by, parent_id) VALUES (?,?,?,?,?,?)',
      [id, wsId, name.trim(), approvalRequired, uid, parentId ?? null]);
    await c.query('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?,?,?)', [id, uid, 'owner']);
    await audit(c, uid, id, 'channel_members', uid, 'INSERT', null, { role: 'owner' });
    if (parentId) await c.query(`INSERT INTO channel_members (channel_id, user_id, role, monthly_limit)
      SELECT ?, user_id, role, monthly_limit FROM channel_members WHERE channel_id = ? AND user_id <> ?`, [id, parentId, uid]); // same people as the parent
    if (parentId) {
      for (const m of await rows(c, 'SELECT user_id, record_scope FROM channel_members WHERE channel_id = ? AND user_id <> ?', [parentId, uid]))
        await c.query('UPDATE channel_members SET record_scope = ? WHERE channel_id = ? AND user_id = ?', [m.record_scope, id, m.user_id]);
      await c.query('INSERT INTO scope_users (channel_id, user_id, can_see) SELECT ?, user_id, can_see FROM scope_users WHERE channel_id = ?', [id, parentId]);
    }
    return id;
  });
}

export const ROLES: Role[] = ['owner', 'approver', 'member', 'viewer'];
export async function addChannelMember(pool: Pool, uid: string, channelId: string, email: string, role: Role) {
  if ((await channelRole(pool, uid, channelId)) !== 'owner') fail(403, 'only the channel owner can add members');
  if (!ROLES.includes(role)) fail(400, 'bad role');
  const u = await one(pool, 'SELECT id FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
  if (!u) fail(404, 'no user with that email has signed up yet');
  const ch = await one(pool, 'SELECT workspace_id FROM channels WHERE id = ?', [channelId]);
  await tx(pool, async c => {
    await c.query('INSERT IGNORE INTO workspace_members VALUES (?,?,?)', [ch.workspace_id, u.id, 'member']);
    await c.query('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?,?,?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [channelId, u.id, role]);
    await audit(c, uid, channelId, 'channel_members', u.id, 'UPSERT', null, { role });
  });
}

const FIELDS = ['title', 'amount', 'currency', 'category_id', 'vendor', 'expense_date', 'payment_method', 'tag', 'notes', 'due_date', 'fx_rate', 'line_items'] as const;
export function cleanFields(body: any) {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (f in body) out[f] = body[f] === '' ? null : body[f];
  if ('fx_rate' in out && out.fx_rate != null && !(Number(out.fx_rate) > 0)) fail(400, 'bad exchange rate');
  if ('amount' in out && out.amount != null && !(Number.isFinite(Number(out.amount)) && Number(out.amount) >= 0)) fail(400, 'bad amount');
  if ('currency' in out && !/^[A-Z]{3}$/.test(String(out.currency))) fail(400, 'currency must be a 3-letter code');
  for (const d of ['expense_date', 'due_date']) if (out[d] != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(out[d]))) fail(400, `bad ${d}`);
  if ('line_items' in out) out.line_items = cleanItems(out.line_items, out);
  return out;
}

/** Line items: [{ description, amount, qty? }]. When present, the expense amount is their total (server is the source of truth). */
export function cleanItems(raw: unknown, out: Record<string, unknown>) {
  if (raw == null || (Array.isArray(raw) && !raw.length)) return null;
  if (!Array.isArray(raw) || raw.length > 100) fail(400, 'line_items must be a list of at most 100 items');
  const items = (raw as any[]).map(i => {
    const description = String(i?.description ?? '').trim().slice(0, 200);
    const amount = Number(i?.amount), qty = i?.qty == null || i.qty === '' ? 1 : Number(i.qty);
    if (!description) fail(400, 'every line item needs a description');
    if (!(Number.isFinite(amount) && amount >= 0)) fail(400, `bad amount for "${description}"`);
    if (!(Number.isFinite(qty) && qty > 0)) fail(400, `bad quantity for "${description}"`);
    return { description, qty, amount: Math.round(amount * 100) / 100, category_id: i?.category_id ? String(i.category_id) : null }; // amount = unit price
  });
  out.amount = Math.round(items.reduce((s, i) => s + i.qty * i.amount, 0) * 100) / 100;
  return JSON.stringify(items);
}

/** Every item category must belong to the channel's workspace. */
async function assertItemCategories(db: Q, channelId: string, lineItems: unknown) {
  if (typeof lineItems !== 'string') return;
  const ids = [...new Set((JSON.parse(lineItems) as { category_id: string | null }[]).map(i => i.category_id).filter(Boolean))];
  if (!ids.length) return;
  const found = await rows(db, 'SELECT k.id FROM categories k JOIN channels ch ON ch.workspace_id = k.workspace_id WHERE ch.id = ? AND k.id IN (?)', [channelId, ids]);
  if (found.length !== ids.length) fail(400, 'unknown item category');
}

/** Advance money trail: handed over (payments) minus spent with evidence minus cash returned. Negative = the holder is owed. */
export async function advanceBalance(db: Q, threadId: string) {
  const sum = async (cond: string) => Number((await one(db, `SELECT COALESCE(SUM(amount),0) AS s FROM settlements WHERE thread_id = ? AND ${cond}`, [threadId])).s);
  const issued = Number((await one(db, 'SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE thread_id = ?', [threadId])).s);
  const spent = await sum(`kind = 'expense' AND review_status <> 'rejected'`), returned = await sum(`kind = 'returned'`), reimbursed = await sum(`kind = 'reimbursed'`);
  const pending = await sum(`kind = 'expense' AND review_status = 'pending'`);
  return { issued, spent, returned, reimbursed, pending, outstanding: Math.round((issued - spent - returned + reimbursed) * 100) / 100 };
}

async function syncAdvanceLedger(c: Q, t: any, spent: number) {
  if (!spent) { await c.query('DELETE FROM ledger_entries WHERE thread_id = ?', [t.id]); return; }
  const ch = await one(c, 'SELECT c.id, c.workspace_id, w.base_currency FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?', [t.channel_id]);
  const fx = t.currency === ch.base_currency ? 1 : Number(t.fx_rate) || 1;
  await c.query(`INSERT INTO ledger_entries (id, thread_id, workspace_id, channel_id, entry_date, category_id, amount, currency, fx_rate, payer, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount = VALUES(amount), entry_date = VALUES(entry_date), status = VALUES(status)`,
    [randomUUID(), t.id, ch.workspace_id, ch.id, t.expense_date ?? new Date().toISOString().slice(0, 10), t.category_id, spent, t.currency, fx, t.assigned_to ?? t.created_by, 'paid']);
}

/** The holder (or an approver) accounts for an advance: spending needs an evidence file; returned cash cannot exceed what is outstanding. */
export async function addSettlement(pool: Pool, uid: string, threadId: string, body: any) {
  const kind = ['returned', 'reimbursed'].includes(body.kind) ? body.kind as string : 'expense';
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!(amount > 0)) fail(400, 'amount must be more than 0');
  const defaults: Record<string, string> = { returned: 'Cash returned', reimbursed: 'Overspend paid back to holder', expense: '' };
  const description = String(body.description ?? defaults[kind]).trim().slice(0, 200) || defaults[kind];
  if (!description) fail(400, 'say what the money was spent on');
  const spentOn = body.spent_on ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) fail(400, 'bad date');
  if (kind === 'expense' && !body.attachment_id) fail(400, 'attach the receipt or other evidence');
  return tx(pool, async c => {
    const t = await settlementThread(c, uid, threadId);
    if (kind === 'reimbursed' && !isApprover(await channelRole(c, uid, t.channel_id))) fail(403, 'only an approver can record a reimbursement');
    if (body.attachment_id && !(await one(c, 'SELECT 1 FROM attachments WHERE id = ? AND thread_id = ?', [body.attachment_id, threadId]))) fail(400, 'evidence must be attached to this advance');
    const b = await advanceBalance(c, threadId);
    if (kind === 'returned' && amount > b.outstanding + 0.005) fail(400, `only ${t.currency} ${b.outstanding.toFixed(2)} is outstanding`);
    if (kind === 'reimbursed' && amount > -b.outstanding + 0.005) fail(400, `only ${t.currency} ${Math.max(-b.outstanding, 0).toFixed(2)} is owed to the holder`);
    const id = randomUUID();
    await c.query('INSERT INTO settlements (id, thread_id, kind, description, amount, spent_on, attachment_id, created_by, review_status) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, threadId, kind, description, amount, spentOn, body.attachment_id ?? null, uid, kind === 'expense' ? 'pending' : 'accepted']);
    await syncAdvanceLedger(c, t, b.spent + (kind === 'expense' ? amount : 0));
    const who = await userName(c, uid);
    const said = kind === 'expense' ? `added evidence for ${t.currency} ${amount.toFixed(2)} (${description})` : kind === 'returned' ? `recorded cash returned: ${t.currency} ${amount.toFixed(2)}` : `paid back the holder: ${t.currency} ${amount.toFixed(2)}`;
    await systemMessage(c, threadId, `${who} ${said}`);
    if (kind === 'expense') await notify(c, await approverIds(c, t.channel_id), uid, threadId, 'approval_request', `${who} ${said} on ${t.title ?? 'an advance'}: review it`);
    await audit(c, uid, t.channel_id, 'settlements', id, 'INSERT', null, { kind, description, amount, spent_on: spentOn });
    return { id };
  });
}

/** Approver accepts or rejects one piece of evidence. Rejected spending goes back to "still to account for". */
export async function reviewSettlement(pool: Pool, uid: string, threadId: string, id: string, body: any) {
  const decision = body.decision === 'rejected' ? 'rejected' : 'accepted';
  const note = String(body.note ?? '').trim().slice(0, 200) || null;
  if (decision === 'rejected' && !note) fail(400, 'say why the evidence is rejected');
  await tx(pool, async c => {
    const t = await settlementThread(c, uid, threadId);
    const role = await channelRole(c, uid, t.channel_id);
    if (!isApprover(role)) fail(403, 'only an approver can review evidence');
    const s = await one(c, `SELECT * FROM settlements WHERE id = ? AND thread_id = ? AND kind = 'expense'`, [id, threadId]);
    if (!s) fail(404, 'not found');
    if (s.created_by === uid && role !== 'owner') fail(403, 'someone else has to review your own evidence');
    await c.query('UPDATE settlements SET review_status = ?, review_note = ? WHERE id = ?', [decision, note, id]);
    await syncAdvanceLedger(c, t, (await advanceBalance(c, threadId)).spent);
    await systemMessage(c, threadId, `${await userName(c, uid)} ${decision} evidence: ${s.description}${note ? ` (${note})` : ''}`);
    await notify(c, [s.created_by], uid, threadId, 'status', `Evidence ${decision}: ${s.description}${note ? ` (${note})` : ''}`);
    await audit(c, uid, t.channel_id, 'settlements', id, 'REVIEW', { review_status: s.review_status }, { review_status: decision, note });
  });
}

async function settlementThread(c: Q, uid: string, threadId: string) {
  const t = await one(c, 'SELECT * FROM threads WHERE id = ? FOR UPDATE', [threadId]);
  const role = t ? await channelRole(c, uid, t.channel_id) : null;
  if (!role) fail(404, 'thread not found');
  if (t.kind !== 'advance') fail(400, 'this is not an advance');
  if (!isApprover(role) && (t.assigned_to ?? t.created_by) !== uid) fail(403, 'only the person holding the advance or an approver can do this');
  if (!['unpaid', 'paid'].includes(t.status)) fail(400, 'record the handover first; closed advances cannot change');
  return t;
}

export async function removeSettlement(pool: Pool, uid: string, threadId: string, id: string) {
  await tx(pool, async c => {
    const t = await settlementThread(c, uid, threadId);
    const s = await one(c, 'SELECT * FROM settlements WHERE id = ? AND thread_id = ?', [id, threadId]);
    if (!s) fail(404, 'not found');
    if (s.review_status === 'accepted' && !isApprover(await channelRole(c, uid, t.channel_id))) fail(403, 'accepted evidence can only be removed by an approver');
    await c.query('DELETE FROM settlements WHERE id = ?', [id]);
    await syncAdvanceLedger(c, t, (await advanceBalance(c, threadId)).spent);
    await audit(c, uid, t.channel_id, 'settlements', id, 'DELETE', s, null);
  });
}

export async function createThread(pool: Pool, uid: string, channelId: string, body: any) {
  const role = await channelRole(pool, uid, channelId);
  if (!role || role === 'viewer') fail(403, 'permission denied');
  const f = cleanFields(body);
  await assertItemCategories(pool, channelId, f.line_items);
  const source = body.source_type ?? 'form';
  if (body.kind === 'advance') {
    f.kind = 'advance';
    if (body.assigned_to) {
      if (!(await channelRole(pool, String(body.assigned_to), channelId))) fail(400, 'the person given the advance must be a channel member');
      f.assigned_to = String(body.assigned_to);
    }
  }
  if (!['form', 'voice', 'photo'].includes(source)) fail(400, 'bad source_type');
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.id)) ? String(body.id).toLowerCase() : randomUUID();
  const existing = await one(pool, 'SELECT created_by FROM threads WHERE id = ?', [id]);
  if (existing) { if (existing.created_by !== uid) fail(409, 'id already used'); return id; } // offline retry
  const cols = Object.keys(f);
  await tx(pool, async c => {
    await c.query(`INSERT INTO threads (id, channel_id, created_by, status, source_type${cols.map(k => `, ${k}`).join('')})
      VALUES (?,?,?,'draft',?${cols.map(() => ',?').join('')})`, [id, channelId, uid, source, ...Object.values(f)]);
    await audit(c, uid, channelId, 'threads', id, 'INSERT', null, f);
  });
  return id;
}

export async function updateThread(pool: Pool, uid: string, threadId: string, body: any) {
  const f = cleanFields(body);
  if (!Object.keys(f).length) fail(400, 'nothing to update');
  await tx(pool, async c => {
    const t = await one(c, 'SELECT * FROM threads WHERE id = ? FOR UPDATE', [threadId]);
    if (!t) fail(404, 'thread not found');
    const role = await channelRole(c, uid, t.channel_id);
    if (!role) fail(404, 'thread not found');
    if (!canEditFields(t.status, role, t.created_by === uid)) fail(403, 'this expense is locked for you');
    // offline edits carry the version they were based on; reject if someone else saved since
    if (body.if_updated_at && body.if_updated_at !== t.updated_at) fail(409, 'this expense was changed by someone else; reload and re-apply');
    await assertItemCategories(c, t.channel_id, f.line_items);
    if (f.category_id && !(await one(c, `SELECT 1 FROM categories k JOIN channels ch ON ch.workspace_id = k.workspace_id
      WHERE k.id = ? AND ch.id = ?`, [f.category_id, t.channel_id]))) fail(400, 'unknown category');
    await c.query(`UPDATE threads SET ${Object.keys(f).map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), threadId]);
    // keep a posted ledger entry in step with approver edits
    // keep the ledger row in step with the edited expense (portable SQL: runs on MySQL and SQLite)
    const nt = await one(c, 'SELECT amount, currency, category_id, expense_date FROM threads WHERE id = ?', [threadId]);
    if (t.kind !== 'advance') await c.query('UPDATE ledger_entries SET amount = ?, currency = ?, category_id = ?, entry_date = COALESCE(?, entry_date) WHERE thread_id = ?',
      [nt.amount, nt.currency, nt.category_id, nt.expense_date, threadId]);
    await audit(c, uid, t.channel_id, 'threads', threadId, 'UPDATE', t, f);
  });
}

export /** Best effort through Expo's push service: a failed push must never fail the action, the in-app alert still exists. */
function sendPush(tokens: { token: string }[], body: string, threadId: string | null) {
  if (!tokens.length) return;
  fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map(t => ({ to: t.token, title: 'ExpenseChat', body: body.slice(0, 180), data: { threadId }, sound: 'default' }))) }).catch(() => {});
}

async function notify(c: Q, userIds: string[], actor: string, threadId: string | null, kind: string, body: string) {
  const ids = [...new Set(userIds)].filter(u => u && u !== actor);
  if (ids.length) await c.query('INSERT INTO notifications (user_id, thread_id, kind, body) VALUES ?',
    [ids.map(u => [u, threadId, kind, body.slice(0, 500)])]);
  if (ids.length) sendPush(await rows(c, 'SELECT token FROM push_tokens WHERE user_id IN (?)', [ids]), body, threadId);
}
export const approverIds = async (c: Q, channelId: string, owners = false) => (await rows(c,
  `SELECT user_id FROM channel_members WHERE channel_id = ? AND role IN (${owners ? "'owner'" : "'owner','approver'"})`, [channelId])).map(r => r.user_id);

export async function systemMessage(c: Q, threadId: string, body: string) {
  await c.query('INSERT INTO thread_messages (id, thread_id, type, body) VALUES (?,?,"system",?)', [randomUUID(), threadId, body]);
}
export const userName = async (c: Q, uid: string) => (await one(c, 'SELECT COALESCE(full_name, email) AS n FROM users WHERE id = ?', [uid])).n as string;

/** Channel rules checked when an expense is submitted. */
async function submitRules(c: Q, t: any, ch: any) {
  if (ch.receipt_required_above != null && Number(t.amount) > Number(ch.receipt_required_above)
    && !(await one(c, 'SELECT 1 AS y FROM attachments WHERE thread_id = ?', [t.id])) && t.kind !== 'advance')
    fail(400, `a receipt is required above ${ch.base_currency} ${Number(ch.receipt_required_above).toFixed(2)}: attach one first`);
  const holder = t.assigned_to ?? t.created_by;
  if (t.kind === 'advance' && ch.block_new_advance && (await one(c, `SELECT 1 AS y FROM threads t WHERE t.channel_id = ? AND t.kind = 'advance' AND t.id <> ?
    AND COALESCE(t.assigned_to, t.created_by) = ? AND t.status IN ('approved','unpaid','paid') AND ${ADVANCE_OUTSTANDING} > 0.005`, [t.channel_id, t.id, holder])))
    fail(400, 'this person still has an advance to account for; settle it before asking for another');
  const m = await one(c, 'SELECT monthly_limit FROM channel_members WHERE channel_id = ? AND user_id = ?', [t.channel_id, holder]);
  if (m?.monthly_limit != null) {
    const month = new Date().toISOString().slice(0, 7);
    const used = Number((await one(c, `SELECT COALESCE(SUM(amount * COALESCE(fx_rate, 1)),0) AS s FROM threads WHERE channel_id = ? AND COALESCE(assigned_to, created_by) = ? AND id <> ?
      AND status NOT IN ('draft','rejected') AND SUBSTR(COALESCE(expense_date, created_at), 1, 7) = ?`, [t.channel_id, holder, t.id, month])).s);
    const fx = t.currency === ch.base_currency ? 1 : Number(t.fx_rate) || 1;
    if (used + Number(t.amount) * fx > Number(m.monthly_limit) + 0.005)
      fail(400, `over the monthly limit of ${ch.base_currency} ${Number(m.monthly_limit).toFixed(2)} (${used.toFixed(2)} already used this month)`);
  }
}

/** Budgets with what is spent this month. Spending = the ledger (approved money, evidenced advances). */
export async function budgetStatus(db: Q, workspaceId: string) {
  const month = new Date().toISOString().slice(0, 7);
  const list = await rows(db, 'SELECT * FROM budgets WHERE workspace_id = ?', [workspaceId]);
  const out = [];
  for (const b of list) {
    const col = b.scope === 'category' ? 'l.category_id' : b.scope === 'channel' ? 'l.channel_id' : 't.tag';
    const spent = Number((await one(db, `SELECT COALESCE(SUM(l.base_amount),0) AS s FROM ledger_entries l JOIN threads t ON t.id = l.thread_id
      WHERE l.workspace_id = ? AND ${col} = ? AND SUBSTR(l.entry_date, 1, 7) = ?`, [workspaceId, b.target, month])).s);
    const label = b.scope === 'category' ? (await one(db, 'SELECT name FROM categories WHERE id = ?', [b.target]))?.name
      : b.scope === 'channel' ? `#${(await one(db, 'SELECT name FROM channels WHERE id = ?', [b.target]))?.name}` : b.target;
    out.push({ id: b.id, scope: b.scope, target: b.target, label: label ?? 'Removed', amount: Number(b.amount), spent });
  }
  return out;
}

/** Tell admins once per budget, per month, per level, when spending reaches 80% and 100%. */
async function budgetWarnings(c: Q, workspaceId: string, threadId: string) {
  const month = new Date().toISOString().slice(0, 7);
  const admins = (await rows(c, `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'admin'`, [workspaceId])).map(r => r.user_id);
  for (const b of await budgetStatus(c, workspaceId)) {
    const level = b.spent > b.amount ? 'is over' : b.spent >= b.amount * 0.8 ? 'has reached 80% of' : null;
    if (!level) continue;
    const body = `${b.label} ${level} its ${month} budget (${b.spent.toFixed(2)} of ${b.amount.toFixed(2)})`.replace(/\(.*/, '');
    if (await one(c, `SELECT 1 AS y FROM notifications WHERE kind = 'budget' AND body LIKE ?`, [`${body}%`])) continue;
    await notify(c, admins, '', threadId, 'budget', `${body}(${b.spent.toFixed(2)} of ${b.amount.toFixed(2)})`);
  }
}

const addMonth = (iso: string, day: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}`;
};
const firstRun = (today: string, day: number) => {
  const here = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`;
  return here >= today ? here : addMonth(today, day);
};

/** Daily housekeeping: recurring expenses become drafts, reminders go out. Runs at most once a day (hourly timer on the server; on app use offline). */
export async function runDaily(pool: Pool, today = new Date().toISOString().slice(0, 10)) {
  const last = await one(pool, `SELECT v FROM app_state WHERE k = 'daily'`);
  if (last?.v === today) return;
  await pool.query(`INSERT INTO app_state (k, v) VALUES ('daily', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)`, [today]);
  for (const r of await rows(pool, 'SELECT * FROM recurring WHERE next_run <= ?', [today])) {
    let next = String(r.next_run).slice(0, 10);
    for (let i = 0; i < 12 && next <= today; i++) { // catches up if nothing ran for a while
      try {
        const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        const id = await createThread(pool, r.created_by, r.channel_id, { ...data, expense_date: next, source_type: 'form', id: undefined });
        await systemMessage(pool, id, 'Created automatically from a monthly recurring expense');
        await notify(pool, [r.created_by], '', id, 'status', `Recurring expense ready to submit: ${r.title ?? 'expense'}`);
      } catch { break; } // the person left the channel: leave the schedule, it can be removed in the app
      next = addMonth(next, r.day_of_month);
    }
    await pool.query('UPDATE recurring SET next_run = ? WHERE id = ?', [next, r.id]);
  }
  const waiting = await rows(pool, `SELECT channel_id, COUNT(*) AS n FROM threads WHERE status IN ('submitted','under_review') AND updated_at < ? GROUP BY channel_id`, [`${today} 00:00:00`]);
  for (const w of waiting) await notify(pool, await approverIds(pool, w.channel_id), '', null, 'reminder', `Reminder: ${w.n} ${Number(w.n) === 1 ? 'expense is' : 'expenses are'} waiting for approval`);
  const late = await rows(pool, `SELECT t.id, t.title, t.channel_id, t.created_by, t.assigned_to FROM threads t WHERE t.kind = 'advance' AND t.status IN ('unpaid','paid')
    AND t.due_date < ? AND ${ADVANCE_OUTSTANDING} > 0.005`, [today]);
  for (const a of late) await notify(pool, [a.assigned_to ?? a.created_by, ...(await approverIds(pool, a.channel_id))], '', a.id, 'reminder', `Reminder: evidence is overdue for ${a.title ?? 'an advance'}`);
}

export async function transition(pool: Pool, uid: string, threadId: string, to: Status, comment?: string | null) {
  return tx(pool, async c => {
    const t = await one(c, 'SELECT * FROM threads WHERE id = ? FOR UPDATE', [threadId]);
    if (!t) fail(404, 'thread not found');
    const role = await channelRole(c, uid, t.channel_id);
    if (!role) fail(404, 'thread not found');
    if (!canTransition(t.status, to, role, t.created_by === uid, comment ?? undefined))
      fail(403, `transition ${t.status} -> ${to} not allowed${t.status === 'closed' ? ' (reopen needs a reason)' : ''}`);
    if (to === 'submitted' && !(Number(t.amount) > 0)) fail(400, 'amount is required before submitting');
    if (to === 'closed' && t.kind === 'advance' && t.status !== 'rejected') {
      const b = await advanceBalance(c, threadId);
      if (b.outstanding > 0.005) fail(400, `${t.currency} ${b.outstanding.toFixed(2)} of this advance is not accounted for yet: add evidence or record the cash returned`);
      if (b.outstanding < -0.005) fail(400, `${t.currency} ${(-b.outstanding).toFixed(2)} is owed to the holder: record the reimbursement first`);
      if (b.pending > 0) fail(400, 'some evidence has not been reviewed yet');
    }
    const ch = await one(c, `SELECT c.*, w.base_currency FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`, [t.channel_id]);
    if (to === 'submitted') await submitRules(c, t, ch);
    if (to === 'submitted' && !ch.approval_required) to = 'approved';
    if (to === 'approved' && t.currency !== ch.base_currency && !(Number(t.fx_rate) > 0))
      fail(400, `set the exchange rate ${t.currency} → ${ch.base_currency} before approving`);
    const actor = await userName(c, uid);
    const note = comment?.trim() ? `: ${comment.trim()}` : '';

    // Multi-step: above the channel's owner limit, an approver's OK is step 1; an owner must give step 2.
    if (to === 'approved' && ch.approval_required) {
      await c.query('INSERT INTO approvals (id, thread_id, approver_id, role) VALUES (?,?,?,?)', [randomUUID(), threadId, uid, role]);
      const ownerDelegate = await one(c, `SELECT 1 AS y FROM delegations d JOIN channel_members m ON m.channel_id = d.channel_id AND m.user_id = d.from_user AND m.role = 'owner'
        WHERE d.channel_id = ? AND d.to_user = ? AND d.until_date >= CURDATE()`, [t.channel_id, uid]);
      const needsOwner = ch.owner_approval_limit != null && Number(t.amount) > Number(ch.owner_approval_limit) && role !== 'owner' && !ownerDelegate;
      if (needsOwner) {
        await c.query('UPDATE threads SET status = "under_review" WHERE id = ?', [threadId]);
        await systemMessage(c, threadId, `${actor} approved (step 1)${note}. Over ${ch.base_currency} ${ch.owner_approval_limit}: awaiting owner approval`);
        await notify(c, await approverIds(c, ch.id, true), uid, threadId, 'approval_request', `Owner approval needed: ${t.title ?? t.vendor ?? 'expense'} (${t.currency} ${t.amount})`);
        await audit(c, uid, t.channel_id, 'threads', threadId, 'APPROVE_STEP', { status: t.status }, { status: 'under_review' });
        return 'under_review' as Status;
      }
    }

    await c.query('UPDATE threads SET status = ?, closed_at = IF(? = "closed", NOW(), NULL) WHERE id = ?', [to, to, threadId]);
    await systemMessage(c, threadId, `${actor} ${t.status === 'closed' ? 'reopened the thread' : `changed status to ${to}`}${note}`);
    if (to === 'approved' && t.kind === 'advance') {
      // an advance is not an expense: only evidenced spending reaches the ledger (syncAdvanceLedger)
    } else if (to === 'approved') {
      const fx = t.currency === ch.base_currency ? 1 : Number(t.fx_rate);
      await c.query(`INSERT INTO ledger_entries (id, thread_id, workspace_id, channel_id, entry_date, category_id, amount, currency, fx_rate, payer, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE entry_date = VALUES(entry_date), category_id = VALUES(category_id),
        amount = VALUES(amount), currency = VALUES(currency), fx_rate = VALUES(fx_rate), status = VALUES(status)`,
        [randomUUID(), t.id, ch.workspace_id, ch.id, t.expense_date ?? new Date().toISOString().slice(0, 10), t.category_id, t.amount, t.currency, fx, t.created_by, to]);
    } else {
      await c.query('UPDATE ledger_entries SET status = ? WHERE thread_id = ?', [to, threadId]);
    }
    const label = t.title ?? t.vendor ?? 'expense';
    if (to === 'submitted') await notify(c, await approverIds(c, ch.id), uid, threadId, 'approval_request', `${actor} submitted ${label} (${t.currency} ${t.amount}) for approval`);
    else await notify(c, [t.created_by], uid, threadId, 'status', `${label}: ${actor} → ${to}${note}`);
    await audit(c, uid, t.channel_id, 'threads', threadId, 'STATUS', { status: t.status }, { status: to, comment: comment ?? null });
    if (to === 'approved' && t.kind !== 'advance') await budgetWarnings(c, ch.workspace_id, threadId);
    return to;
  });
}

/** Record a (partial) payment; full coverage moves the thread to paid, partial to unpaid. */
export async function addPayment(pool: Pool, uid: string, threadId: string, body: any) {
  const amount = Number(body.amount);
  if (!(amount > 0)) fail(400, 'payment amount must be > 0');
  if (!['cash', 'bank_transfer', 'card', 'wallet'].includes(body.method)) fail(400, 'bad payment method');
  const paidOn = body.paid_on ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) fail(400, 'bad paid_on');
  const toStatus = await tx(pool, async c => {
    const t = await one(c, 'SELECT * FROM threads WHERE id = ? FOR UPDATE', [threadId]);
    if (!t) fail(404, 'thread not found');
    const role = await channelRole(c, uid, t.channel_id);
    if (!role) fail(404, 'thread not found');
    if (!isApprover(role)) fail(403, 'only approvers can record payments');
    if (!['approved', 'unpaid'].includes(t.status)) fail(400, 'only approved/unpaid expenses can be paid');
    const paid = Number((await one(c, 'SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE thread_id = ?', [threadId])).s);
    if (paid + amount > Number(t.amount) + 0.005) fail(400, `payment exceeds the remaining ${t.currency} ${(Number(t.amount) - paid).toFixed(2)}`);
    if (body.attachment_id && !(await one(c, 'SELECT 1 FROM attachments WHERE id = ? AND thread_id = ?', [body.attachment_id, threadId])))
      fail(400, 'proof attachment must belong to this thread');
    await c.query('INSERT INTO payments (id, thread_id, amount, method, reference, paid_on, attachment_id, recorded_by) VALUES (?,?,?,?,?,?,?,?)',
      [randomUUID(), threadId, amount, body.method, String(body.reference ?? '').slice(0, 120) || null, paidOn, body.attachment_id ?? null, uid]);
    await systemMessage(c, threadId, `${await userName(c, uid)} recorded payment ${t.currency} ${amount} via ${body.method.replace('_', ' ')}${body.reference ? ` (ref ${body.reference})` : ''}`);
    await audit(c, uid, t.channel_id, 'payments', threadId, 'INSERT', null, { amount, method: body.method, reference: body.reference ?? null });
    const full = paid + amount >= Number(t.amount) - 0.005;
    return full ? 'paid' : (t.status === 'approved' ? 'unpaid' : null);
  });
  if (toStatus) await transition(pool, uid, threadId, toStatus as Status, toStatus === 'paid' ? 'fully paid' : 'partially paid');
}


export const SEARCH_SELECT = `SELECT t.*, JSON_OBJECT('full_name', u.full_name) AS author,
  IF(c.id IS NULL, NULL, JSON_OBJECT('name', c.name)) AS category, `;

/** WHERE clause over ledger_entries l for the dashboard/export filters; first param is the viewer (channel_members join). */
export function ledgerFilter(uid: string, q: any) {
  const where = [`EXISTS (SELECT 1 FROM threads t WHERE t.id = l.thread_id AND ${visibleSql()})`]; const params: unknown[] = [uid, uid];
  if (q.workspace) { where.push('l.workspace_id = ?'); params.push(q.workspace); }
  if (q.channel) { where.push('l.channel_id = ?'); params.push(q.channel); }
  if (q.from) { where.push('l.entry_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('l.entry_date <= ?'); params.push(q.to); }
  if (q.category) { where.push('l.category_id = ?'); params.push(q.category); }
  if (q.member) { where.push('l.payer = ?'); params.push(q.member); }
  if (q.status) { where.push('l.status IN (?)'); params.push(String(q.status).split(',')); }
  return { where: where.join(' AND '), params };
}

/** SQL: money of advance t still unaccounted for. */
export const ADVANCE_OUTSTANDING = `((SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.thread_id = t.id) - (SELECT COALESCE(SUM(CASE WHEN s.kind = 'reimbursed' THEN -s.amount WHEN s.review_status = 'rejected' THEN 0 ELSE s.amount END),0) FROM settlements s WHERE s.thread_id = t.id))`;
export const THREAD_SELECT = `SELECT t.*, JSON_OBJECT('full_name', u.full_name) AS author,
  IF(c.id IS NULL, NULL, JSON_OBJECT('name', c.name)) AS category,
  (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id AND m.type = 'text') AS reply_count,
  (SELECT MAX(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id) AS last_activity,
  (SELECT JSON_OBJECT('full_name', h.full_name) FROM users h WHERE h.id = t.assigned_to) AS holder,
  (SELECT COALESCE(SUM(CASE WHEN s.kind = 'reimbursed' THEN -s.amount WHEN s.review_status = 'rejected' THEN 0 ELSE s.amount END),0) FROM settlements s WHERE s.thread_id = t.id) AS accounted
  FROM threads t JOIN users u ON u.id = t.created_by LEFT JOIN categories c ON c.id = t.category_id`;


export const threadRoleOf = async (pool: Pool, uid: string, threadId: string) => {
  const t = await one(pool, `SELECT t.channel_id, t.status FROM threads t WHERE t.id = ? AND ${visibleSql()}`, [threadId, uid]);
  const role = t ? await channelRole(pool, uid, t.channel_id) : null;
  if (!role) fail(404, 'thread not found');
  return { role: role as Role, ...t };
};

export const userOut = (u: any) => ({ id: u.id, email: u.email, full_name: u.full_name, default_currency: u.default_currency, language: u.language });

/** Report choices shared by the server export and the phone's offline reports. "all" leaves out drafts. */
export const REPORTS: Record<string, { title: string; statuses: string[]; advances?: boolean }> = {
  all: { title: 'All expenses', statuses: ['submitted', 'under_review', 'needs_info', 'approved', 'unpaid', 'paid', 'rejected', 'closed'] },
  pending: { title: 'Pending approval', statuses: ['submitted', 'under_review', 'needs_info'] },
  approved: { title: 'Approved', statuses: ['approved', 'unpaid', 'paid', 'closed'] },
  unpaid: { title: 'Approved, not yet paid', statuses: ['approved', 'unpaid'] },
  paid: { title: 'Paid', statuses: ['paid', 'closed'] },
  rejected: { title: 'Rejected', statuses: ['rejected'] },
  advances: { title: 'Open advances', statuses: ['approved', 'unpaid', 'paid'], advances: true },
};

/** What a route handler sees: the signed-in user plus the parsed request. */
type LineItemRow = { qty: number; amount: number; category_id?: string | null };
export type Ctx = { uid: string; params: Record<string, string>; query: Record<string, any>; body: any };
export type Route = { m: 'GET' | 'POST' | 'PATCH' | 'DELETE'; p: string; h: (req: Ctx) => Promise<unknown> };
export type CoreEnv = { ai: (workspaceId: string) => Promise<{ transcribe: boolean; extract: boolean }>; fileUrl: (req: Ctx, attachmentId: string) => string };

export function coreRoutes(pool: Pool, env: CoreEnv): Route[] {
  const base = (req: Ctx) => req;
  const signedFileUrl = (req: Ctx, id: string) => env.fileUrl(req, id);
  /** Totals per category; an item with its own category counts there, the rest under the expense's category. */
  const splitByCategory = async (entries: any[]) => {
    const names = new Map((await rows(pool, 'SELECT id, name FROM categories')).map(k => [k.id, k.name]));
    const totals = new Map<string, number>();
    const add = (label: string, n: number) => totals.set(label, (totals.get(label) ?? 0) + n);
    for (const e of entries) {
      const items: LineItemRow[] = (typeof e.line_items === 'string' ? JSON.parse(e.line_items) : e.line_items) ?? [];
      if (!items.some(i => i.category_id)) { add(e.label, Number(e.base)); continue; }
      const rate = Number(e.amount) ? Number(e.base) / Number(e.amount) : 1;
      for (const i of items) add(names.get(i.category_id) ?? e.label, i.qty * i.amount * rate);
    }
    return [...totals].map(([label, total]) => ({ label, total: Math.round(total * 100) / 100 })).sort((a, b) => b.total - a.total);
  };
  const categoryInput = async (req: Ctx, wsId: string, self?: string) => {
    if ((await wsRole(pool, req.uid, wsId)) !== 'admin') fail(403, 'only a workspace admin can change categories');
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) fail(400, 'category name required (max 80 characters)');
    const same = await one(pool, 'SELECT id FROM categories WHERE workspace_id = ? AND LOWER(name) = LOWER(?)', [wsId, name]);
    if (same && same.id !== self) fail(409, 'that category already exists');
    return name;
  };
  const threadRole = (uid: string, threadId: string) => threadRoleOf(pool, uid, threadId);
  async function assertNotLastOwner(channelId: string, user: string) {
    const owners = await rows(pool, 'SELECT user_id FROM channel_members WHERE channel_id = ? AND role = "owner"', [channelId]);
    if (owners.length === 1 && owners[0].user_id === user) fail(400, 'a channel needs at least one owner');
  }

  return [
  { m: 'GET', p: '/me', h: async req => userOut(await one(pool, 'SELECT * FROM users WHERE id = ?', [req.uid])) },
  { m: 'PATCH', p: '/me', h: async req => {
    const name = String(req.body.full_name ?? '').trim().slice(0, 120);
    const cur = String(req.body.default_currency ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) fail(400, 'currency must be a 3-letter code');
    const lang = req.body.language === 'ur' ? 'ur' : 'en';
    await pool.query('UPDATE users SET full_name = ?, default_currency = ?, language = ? WHERE id = ?', [name || null, cur, lang, req.uid]);
  } },
  { m: 'GET', p: '/workspaces', h: async req => {
    const ws = await rows(pool, `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.name`, [req.uid]);
    const chs = await rows(pool, `SELECT c.id, c.workspace_id, c.parent_id, c.name, c.approval_required, cm.role,
        (SELECT COUNT(*) FROM threads t WHERE t.channel_id = c.id AND t.status IN ('submitted','under_review') AND ${visibleSql()}) AS pending_count,
        (SELECT COUNT(*) FROM threads t WHERE t.channel_id = c.id AND t.status IN ('approved','unpaid') AND ${visibleSql()}) AS unpaid_count,
        (SELECT JSON_OBJECT('title', COALESCE(t.title, t.vendor, 'Expense'), 'amount', t.amount, 'currency', t.currency,
          'status', t.status, 'at', t.updated_at) FROM threads t WHERE t.channel_id = c.id AND ${visibleSql()} ORDER BY t.updated_at DESC LIMIT 1) AS last
      FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE cm.user_id = ?
      ORDER BY (SELECT MAX(t.updated_at) FROM threads t WHERE t.channel_id = c.id) DESC, c.name`, [req.uid, req.uid, req.uid, req.uid]);
    return ws.map(w => ({ ...w, channels: chs.filter(c => c.workspace_id === w.id) }));
  } },
  { m: 'POST', p: '/workspaces', h: async req => ({ id: await createWorkspace(pool, req.uid, req.body.name) }) },
  { m: 'POST', p: '/workspaces/:id/channels', h: async req =>
    ({ id: await createChannel(pool, req.uid, req.params.id as string, req.body.name, req.body.approval_required !== false, req.body.parent_id) }) },
  { m: 'GET', p: '/workspaces/:id/categories', h: async req => {
    if (!(await wsRole(pool, req.uid, req.params.id as string))) fail(404, 'not found');
    return rows(pool, 'SELECT id, name FROM categories WHERE workspace_id = ? ORDER BY name', [req.params.id]);
  } },
  { m: 'POST', p: '/workspaces/:id/categories', h: async req => {
    const name = await categoryInput(req, req.params.id);
    const id = randomUUID();
    await pool.query('INSERT INTO categories (id, workspace_id, name) VALUES (?,?,?)', [id, req.params.id, name]);
    return { id, name };
  } },
  { m: 'PATCH', p: '/workspaces/:id/categories/:cat', h: async req => {
    const name = await categoryInput(req, req.params.id, req.params.cat);
    await pool.query('UPDATE categories SET name = ? WHERE id = ? AND workspace_id = ?', [name, req.params.cat, req.params.id]);
  } },
  { m: 'DELETE', p: '/workspaces/:id/categories/:cat', h: async req => {
    if ((await wsRole(pool, req.uid, req.params.id)) !== 'admin') fail(403, 'only a workspace admin can change categories');
    // expenses keep existing and become uncategorized (FK: ON DELETE SET NULL)
    await pool.query('UPDATE ledger_entries SET category_id = NULL WHERE category_id = ?', [req.params.cat]);
    await pool.query('DELETE FROM categories WHERE id = ? AND workspace_id = ?', [req.params.cat, req.params.id]);
  } },
  { m: 'GET', p: '/channels/:id', h: async req => {
    const role = await channelRole(pool, req.uid, req.params.id as string);
    if (!role) fail(404, 'channel not found');
    const ch = await one(pool, `SELECT c.id, c.workspace_id, c.parent_id, c.name, c.approval_required, c.owner_approval_limit, c.receipt_required_above, c.block_new_advance, w.base_currency
      FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?`, [req.params.id]);
    const subchannels = await rows(pool, 'SELECT c.id, c.name FROM channels c JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ? WHERE c.parent_id = ? ORDER BY c.name', [req.uid, req.params.id]);
    const mine = await one(pool, 'SELECT record_scope FROM channel_members WHERE channel_id = ? AND user_id = ?', [req.params.id, req.uid]);
    return { ...ch, my_scope: isApprover(role) ? 'all' : mine?.record_scope ?? 'all', subchannels, block_new_advance: !!ch.block_new_advance, approval_required: !!ch.approval_required, my_role: role, ai: await env.ai(ch.workspace_id) };
  } },
  { m: 'PATCH', p: '/channels/:id', h: async req => {
    const id = req.params.id as string;
    if ((await channelRole(pool, req.uid, id)) !== 'owner') fail(403, 'only the owner can change channel settings');
    const limit = req.body.owner_approval_limit === '' || req.body.owner_approval_limit == null ? null : Number(req.body.owner_approval_limit);
    if (limit != null && !(limit >= 0)) fail(400, 'bad approval limit');
    const name = String(req.body.name ?? '').trim();
    if (!name || name.length > 80) fail(400, 'channel name required');
    const receipt = req.body.receipt_required_above === '' || req.body.receipt_required_above == null ? null : Number(req.body.receipt_required_above);
    if (receipt != null && !(receipt >= 0)) fail(400, 'bad receipt limit');
    await pool.query('UPDATE channels SET name = ?, approval_required = ?, owner_approval_limit = ?, receipt_required_above = ?, block_new_advance = ? WHERE id = ?',
      [name, req.body.approval_required !== false, limit, receipt, !!req.body.block_new_advance, id]);
    await audit(pool, req.uid, id, 'channels', id, 'UPDATE', null, { name, approval_required: req.body.approval_required !== false, owner_approval_limit: limit });
  } },
  { m: 'GET', p: '/channels/:id/members', h: async req => {
    if (!(await channelRole(pool, req.uid, req.params.id as string))) fail(404, 'channel not found');
    return rows(pool, `SELECT cm.user_id, cm.role, cm.monthly_limit, cm.record_scope, JSON_OBJECT('full_name', u.full_name, 'email', u.email) AS profile
      FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? ORDER BY u.full_name`, [req.params.id]);
  } },
  { m: 'POST', p: '/channels/:id/members', h: async req =>
    addChannelMember(pool, req.uid, req.params.id as string, req.body.email, req.body.role) },
  { m: 'PATCH', p: '/channels/:id/members/:user', h: async req => {
    const { id, user } = req.params as Record<string, string>;
    if ((await channelRole(pool, req.uid, id)) !== 'owner') fail(403, 'only the channel owner can change roles');
    if (!ROLES.includes(req.body.role)) fail(400, 'bad role');
    if (req.body.role !== 'owner') await assertNotLastOwner(id, user);
    await pool.query('UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?', [req.body.role, id, user]);
    await audit(pool, req.uid, id, 'channel_members', user, 'UPDATE', null, { role: req.body.role });
  } },
  { m: 'DELETE', p: '/channels/:id/members/:user', h: async req => {
    const { id, user } = req.params as Record<string, string>;
    if ((await channelRole(pool, req.uid, id)) !== 'owner') fail(403, 'only the channel owner can remove members');
    await assertNotLastOwner(id, user);
    await pool.query('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', [id, user]);
    await audit(pool, req.uid, id, 'channel_members', user, 'DELETE', null, null);
  } },
  { m: 'GET', p: '/channels/:id/threads', h: async req => {
    if (!(await channelRole(pool, req.uid, req.params.id as string))) fail(404, 'channel not found');
    const limit = Math.min(Number(req.query.limit) || 30, 100), offset = Math.max(Number(req.query.offset) || 0, 0);
    // channel feed: each expense is a message, with its first photo/voice note, transcript and latest reply as preview
    const list = await rows(pool, `SELECT x.*,
        (SELECT JSON_OBJECT('id', m.attachment_id, 'type', m.type, 'mime', a.mime) FROM thread_messages m JOIN attachments a ON a.id = m.attachment_id
          WHERE m.thread_id = x.id AND m.type IN ('image','voice','file') AND m.author_id = x.created_by ORDER BY m.created_at LIMIT 1) AS preview_att,
        (SELECT m.body FROM thread_messages m WHERE m.thread_id = x.id AND m.type = 'system' AND m.body LIKE '%Transcript%' ORDER BY m.created_at LIMIT 1) AS transcript,
        (SELECT JSON_OBJECT('body', m.body, 'author', u.full_name, 'at', m.created_at) FROM thread_messages m JOIN users u ON u.id = m.author_id
          WHERE m.thread_id = x.id AND m.type = 'text' ORDER BY m.created_at DESC LIMIT 1) AS last_reply
      FROM (${THREAD_SELECT} WHERE t.channel_id = ? AND ${visibleSql()} ORDER BY t.created_at DESC LIMIT ? OFFSET ?) x`, [req.params.id, req.uid, limit, offset]);
    return list.map(({ preview_att: p, ...t }) => ({ ...t,
      preview: p ? { type: p.type, mime: p.mime, url: signedFileUrl(base(req), p.id) } : null,
      transcript: t.transcript ? String(t.transcript).replace(/^[^:]*:\s*/, '') : null }));
  } },
  { m: 'POST', p: '/channels/:id/threads', h: async req => ({ id: await createThread(pool, req.uid, req.params.id as string, req.body) }) },
  { m: 'GET', p: '/threads/:id', h: async req => {
    const t = await one(pool, `${THREAD_SELECT} WHERE t.id = ? AND ${visibleSql()}`, [req.params.id, req.uid]);
    if (!t || !(await channelRole(pool, req.uid, t.channel_id))) fail(404, 'thread not found');
    const [payments, approvals, ext, ws] = await Promise.all([
      rows(pool, `SELECT p.id, p.amount, p.method, p.reference, p.paid_on, p.attachment_id, u.full_name AS recorded_by
        FROM payments p JOIN users u ON u.id = p.recorded_by WHERE p.thread_id = ? ORDER BY p.created_at`, [t.id]),
      rows(pool, `SELECT a.role, a.created_at, u.full_name FROM approvals a JOIN users u ON u.id = a.approver_id
        WHERE a.thread_id = ? ORDER BY a.created_at`, [t.id]),
      one(pool, 'SELECT fields, line_items, created_at FROM extractions WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', [t.id]),
      one(pool, 'SELECT w.base_currency FROM channels c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?', [t.channel_id]),
    ]);
    const parsed: any[] | null = typeof t.line_items === 'string' ? JSON.parse(t.line_items) : t.line_items;
    const itemCats = new Map((parsed?.some(i => i.category_id) ? await rows(pool, 'SELECT k.id, k.name FROM categories k JOIN channels ch ON ch.workspace_id = k.workspace_id WHERE ch.id = ?', [t.channel_id]) : []).map(k => [k.id, k.name]));
    const settlements = t.kind !== 'advance' ? [] : (await rows(pool, `SELECT s.id, s.kind, s.description, s.amount, s.spent_on, s.attachment_id, s.review_status, s.review_note, s.created_by, a.mime AS att_mime, u.full_name AS by_name
      FROM settlements s JOIN users u ON u.id = s.created_by LEFT JOIN attachments a ON a.id = s.attachment_id WHERE s.thread_id = ? ORDER BY s.spent_on, s.created_at`, [t.id]))
      .map(({ att_mime, ...s }) => ({ ...s, attachment: s.attachment_id ? { url: signedFileUrl(base(req), s.attachment_id), mime: att_mime } : null }));
    return { ...t, settlements, balance: t.kind === 'advance' ? await advanceBalance(pool, t.id) : null, line_items: parsed?.map(i => ({ ...i, category_name: itemCats.get(i.category_id) ?? null })) ?? null, payments, approvals, extraction: ext ?? null, base_currency: ws.base_currency,
      paid_total: payments.reduce((s, p) => s + Number(p.amount), 0) };
  } },
  { m: 'POST', p: '/threads/:id/settlements/:sid/review', h: async req => reviewSettlement(pool, req.uid, req.params.id, req.params.sid, req.body) },
  { m: 'POST', p: '/threads/bulk-transition', h: async req => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 50).map(String) : [];
    if (!['approved', 'rejected'].includes(req.body?.to)) fail(400, 'bulk action must be approve or reject');
    const results = [];
    for (const id of ids) { // each one keeps its own permission and rule checks; one failure doesn't stop the rest
      try { results.push({ id, ok: true, status: await transition(pool, req.uid, id, req.body.to, req.body.comment) }); }
      catch (e) { results.push({ id, ok: false, error: (e as Error).message }); }
    }
    return { results };
  } },
  { m: 'POST', p: '/me/push-token', h: async req => {
    const token = String(req.body?.token ?? '').slice(0, 255);
    if (!/^Expo(nent)?PushToken\[/.test(token)) fail(400, 'bad push token');
    await pool.query('INSERT INTO push_tokens (token, user_id) VALUES (?,?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)', [token, req.uid]);
  } },
  { m: 'DELETE', p: '/me/push-token', h: async req => { await pool.query('DELETE FROM push_tokens WHERE user_id = ? AND token = ?', [req.uid, String(req.body?.token ?? '')]); } },
  // invites: a code the owner shares; whoever signs in and enters it joins the channel
  { m: 'POST', p: '/channels/:id/invites', h: async req => {
    if ((await realRole(pool, req.uid, req.params.id)) !== 'owner') fail(403, 'only the channel owner can invite');
    const role = ['approver', 'member', 'viewer'].includes(req.body?.role) ? req.body.role : 'member';
    const token = (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 20).toUpperCase();
    const expires = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    await pool.query('INSERT INTO invites (token, channel_id, role, created_by, expires_on) VALUES (?,?,?,?,?)', [token, req.params.id, role, req.uid, expires]);
    return { token, role, expires_on: expires };
  } },
  { m: 'GET', p: '/invites/:token', h: async req => {
    const i = await one(pool, `SELECT i.role, i.expires_on, c.name AS channel, w.name AS workspace FROM invites i JOIN channels c ON c.id = i.channel_id JOIN workspaces w ON w.id = c.workspace_id
      WHERE i.token = ? AND i.expires_on >= CURDATE()`, [req.params.token.toUpperCase()]);
    if (!i) fail(404, 'this invite is not valid or has expired');
    return i;
  } },
  { m: 'POST', p: '/invites/:token/accept', h: async req => {
    const i = await one(pool, `SELECT i.*, c.workspace_id FROM invites i JOIN channels c ON c.id = i.channel_id WHERE i.token = ? AND i.expires_on >= CURDATE()`, [req.params.token.toUpperCase()]);
    if (!i) fail(404, 'this invite is not valid or has expired');
    await tx(pool, async c => {
      await c.query('INSERT IGNORE INTO workspace_members VALUES (?,?,?)', [i.workspace_id, req.uid, 'member']);
      await c.query('INSERT IGNORE INTO channel_members (channel_id, user_id, role) VALUES (?,?,?)', [i.channel_id, req.uid, i.role]);
      await audit(c, req.uid, i.channel_id, 'channel_members', req.uid, 'JOIN', null, { role: i.role, via: 'invite' });
    });
    return { channel_id: i.channel_id };
  } },
  // who this member can see: everyone, only themselves, or chosen people. Channel owner or workspace admin decides.
  { m: 'GET', p: '/channels/:id/scopes', h: async req => {
    if (!(await realRole(pool, req.uid, req.params.id))) fail(404, 'channel not found');
    const list = await rows(pool, 'SELECT user_id, can_see FROM scope_users WHERE channel_id = ?', [req.params.id]);
    return isApprover(await realRole(pool, req.uid, req.params.id)) ? list : list.filter(x => x.user_id === req.uid);
  } },
  { m: 'PATCH', p: '/channels/:id/members/:user/scope', h: async req => {
    const { id, user } = req.params;
    const ch = await one(pool, 'SELECT workspace_id FROM channels WHERE id = ?', [id]);
    if (!ch) fail(404, 'channel not found');
    if ((await realRole(pool, req.uid, id)) !== 'owner' && (await wsRole(pool, req.uid, ch.workspace_id)) !== 'admin') fail(403, 'only the channel owner or a workspace admin can change this');
    if (!(await realRole(pool, user, id))) fail(404, 'not a member of this channel');
    const scope = String(req.body?.scope);
    if (!['all', 'own', 'selected'].includes(scope)) fail(400, 'bad scope');
    const users: string[] = scope === 'selected' && Array.isArray(req.body?.users) ? [...new Set<string>(req.body.users.map(String))].filter(u => u !== user) : [];
    for (const u of users) if (!(await realRole(pool, u, id))) fail(400, 'everyone chosen must be a member of this channel');
    await tx(pool, async c => {
      await c.query('UPDATE channel_members SET record_scope = ? WHERE channel_id = ? AND user_id = ?', [scope, id, user]);
      await c.query('DELETE FROM scope_users WHERE channel_id = ? AND user_id = ?', [id, user]);
      if (users.length) await c.query('INSERT INTO scope_users (channel_id, user_id, can_see) VALUES ?', [users.map(u => [id, user, u])]);
      await audit(c, req.uid, id, 'channel_members', user, 'UPDATE', null, { record_scope: scope, can_see: users.length });
    });
  } },
  { m: 'PATCH', p: '/channels/:id/members/:user/limit', h: async req => {
    if ((await realRole(pool, req.uid, req.params.id)) !== 'owner') fail(403, 'only the channel owner can set limits');
    const raw = req.body?.monthly_limit;
    const limit = raw === '' || raw == null ? null : Number(raw);
    if (limit != null && !(limit >= 0)) fail(400, 'bad limit');
    await pool.query('UPDATE channel_members SET monthly_limit = ? WHERE channel_id = ? AND user_id = ?', [limit, req.params.id, req.params.user]);
    await audit(pool, req.uid, req.params.id, 'channel_members', req.params.user, 'UPDATE', null, { monthly_limit: limit });
  } },
  { m: 'GET', p: '/channels/:id/delegation', h: async req => {
    if (!(await realRole(pool, req.uid, req.params.id))) fail(404, 'channel not found');
    return rows(pool, `SELECT d.from_user, d.to_user, d.until_date, f.full_name AS from_name, x.full_name AS to_name FROM delegations d JOIN users f ON f.id = d.from_user JOIN users x ON x.id = d.to_user
      WHERE d.channel_id = ? AND d.until_date >= CURDATE()`, [req.params.id]);
  } },
  { m: 'POST', p: '/channels/:id/delegation', h: async req => {
    if (!isApprover(await realRole(pool, req.uid, req.params.id))) fail(403, 'only approvers can delegate their approvals');
    const to = String(req.body?.to_user ?? ''), until = String(req.body?.until ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < new Date().toISOString().slice(0, 10)) fail(400, 'pick an end date from today on');
    const target = await realRole(pool, to, req.params.id);
    if (!target || target === 'viewer' || to === req.uid) fail(400, 'pick another member of this channel who is not a viewer');
    await pool.query('INSERT INTO delegations (channel_id, from_user, to_user, until_date) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE to_user = VALUES(to_user), until_date = VALUES(until_date)', [req.params.id, req.uid, to, until]);
    await audit(pool, req.uid, req.params.id, 'delegations', to, 'UPSERT', null, { until });
    await notify(pool, [to], req.uid, null, 'status', `${await userName(pool, req.uid)} asked you to handle their approvals until ${until}`);
  } },
  { m: 'DELETE', p: '/channels/:id/delegation', h: async req => { await pool.query('DELETE FROM delegations WHERE channel_id = ? AND from_user = ?', [req.params.id, req.uid]); } },
  { m: 'GET', p: '/workspaces/:id/budgets', h: async req => {
    if (!(await wsRole(pool, req.uid, req.params.id))) fail(404, 'not found');
    // a total could reveal records someone isn't allowed to see
    if (await one(pool, `SELECT 1 AS y FROM channel_members m JOIN channels c ON c.id = m.channel_id WHERE c.workspace_id = ? AND m.user_id = ? AND m.record_scope <> 'all' AND m.role NOT IN ('owner','approver')`, [req.params.id, req.uid])) return [];
    return budgetStatus(pool, req.params.id);
  } },
  { m: 'POST', p: '/workspaces/:id/budgets', h: async req => {
    if ((await wsRole(pool, req.uid, req.params.id)) !== 'admin') fail(403, 'only a workspace admin can set budgets');
    const { scope, target } = req.body ?? {}; const amount = Number(req.body?.amount);
    if (!['category', 'channel', 'tag'].includes(scope) || !String(target ?? '').trim() || !(amount > 0)) fail(400, 'pick what the budget is for and an amount above 0');
    const id = randomUUID();
    await pool.query('INSERT INTO budgets (id, workspace_id, scope, target, amount) VALUES (?,?,?,?,?)', [id, req.params.id, scope, String(target).trim().slice(0, 120), amount]);
    return { id };
  } },
  { m: 'DELETE', p: '/workspaces/:id/budgets/:bid', h: async req => {
    if ((await wsRole(pool, req.uid, req.params.id)) !== 'admin') fail(403, 'only a workspace admin can change budgets');
    await pool.query('DELETE FROM budgets WHERE id = ? AND workspace_id = ?', [req.params.bid, req.params.id]);
  } },
  { m: 'GET', p: '/channels/:id/templates', h: async req => {
    if (!(await realRole(pool, req.uid, req.params.id))) fail(404, 'channel not found');
    return rows(pool, 'SELECT id, name, data FROM templates WHERE channel_id = ? AND user_id = ? ORDER BY name', [req.params.id, req.uid]);
  } },
  { m: 'POST', p: '/channels/:id/templates', h: async req => {
    if (!canComment(await realRole(pool, req.uid, req.params.id))) fail(403, 'permission denied');
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    const data = JSON.stringify(req.body?.data ?? {});
    if (!name || data.length > 20000) fail(400, 'template needs a name');
    const id = randomUUID();
    await pool.query('INSERT INTO templates (id, channel_id, user_id, name, data) VALUES (?,?,?,?,?)', [id, req.params.id, req.uid, name, data]);
    return { id };
  } },
  { m: 'DELETE', p: '/channels/:id/templates/:tid', h: async req => { await pool.query('DELETE FROM templates WHERE id = ? AND channel_id = ? AND user_id = ?', [req.params.tid, req.params.id, req.uid]); } },
  { m: 'GET', p: '/channels/:id/recurring', h: async req => {
    if (!(await realRole(pool, req.uid, req.params.id))) fail(404, 'channel not found');
    const m = await one(pool, 'SELECT role, record_scope FROM channel_members WHERE channel_id = ? AND user_id = ?', [req.params.id, req.uid]);
    const list = await rows(pool, `SELECT r.id, r.title, r.data, r.day_of_month, r.next_run, r.created_by, u.full_name AS by_name FROM recurring r JOIN users u ON u.id = r.created_by WHERE r.channel_id = ? ORDER BY r.next_run`, [req.params.id]);
    return isApprover(m.role) || m.record_scope === 'all' ? list : list.filter(r => r.created_by === req.uid);
  } },
  { m: 'POST', p: '/channels/:id/recurring', h: async req => {
    if (!canComment(await realRole(pool, req.uid, req.params.id))) fail(403, 'permission denied');
    const day = Number(req.body?.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 28) fail(400, 'pick a day from 1 to 28');
    const data = req.body?.data ?? {};
    cleanFields(data); // same validation as a real expense, now rather than next month
    const id = randomUUID(), next = firstRun(new Date().toISOString().slice(0, 10), day);
    await pool.query('INSERT INTO recurring (id, channel_id, created_by, title, data, day_of_month, next_run) VALUES (?,?,?,?,?,?,?)',
      [id, req.params.id, req.uid, data.title ?? data.vendor ?? null, JSON.stringify(data), day, next]);
    return { id, next_run: next };
  } },
  { m: 'DELETE', p: '/channels/:id/recurring/:rid', h: async req => {
    const r = await one(pool, 'SELECT created_by FROM recurring WHERE id = ? AND channel_id = ?', [req.params.rid, req.params.id]);
    if (!r) fail(404, 'not found');
    if (r.created_by !== req.uid && (await realRole(pool, req.uid, req.params.id)) !== 'owner') fail(403, 'only its creator or the channel owner can stop this');
    await pool.query('DELETE FROM recurring WHERE id = ?', [req.params.rid]);
  } },
  { m: 'POST', p: '/threads/:id/settlements', h: async req => addSettlement(pool, req.uid, req.params.id, req.body) },
  { m: 'DELETE', p: '/threads/:id/settlements/:sid', h: async req => removeSettlement(pool, req.uid, req.params.id, req.params.sid) },
  { m: 'POST', p: '/threads/:id/payments', h: async req => addPayment(pool, req.uid, req.params.id as string, req.body) },
  { m: 'GET', p: '/threads/:id/duplicates', h: async req => {
    const t = await one(pool, `SELECT t.* FROM threads t WHERE t.id = ? AND ${visibleSql()}`, [req.params.id, req.uid]);
    if (!t || !(await channelRole(pool, req.uid, t.channel_id))) fail(404, 'thread not found');
    return rows(pool, `SELECT DISTINCT o.id, o.title, o.vendor, o.amount, o.currency, o.expense_date, o.status FROM threads o
      LEFT JOIN attachments oa ON oa.thread_id = o.id
      WHERE ${visibleSql('o')} AND o.channel_id = ? AND o.id <> ? AND (
        (o.amount = ? AND LOWER(COALESCE(o.vendor,'')) = LOWER(COALESCE(?,'')) AND o.expense_date <=> ?)
        OR oa.sha256 IN (SELECT sha256 FROM attachments WHERE thread_id = ?)) LIMIT 10`,
      [req.uid, t.channel_id, t.id, t.amount, t.vendor, t.expense_date, t.id]);
  } },
  { m: 'PATCH', p: '/threads/:id', h: async req => updateThread(pool, req.uid, req.params.id as string, req.body) },
  { m: 'POST', p: '/threads/:id/transition', h: async req =>
    ({ status: await transition(pool, req.uid, req.params.id as string, req.body.to, req.body.comment) }) },
  { m: 'GET', p: '/threads/:id/messages', h: async req => {
    await threadRole(req.uid, req.params.id as string);
    const msgs = await rows(pool, `SELECT m.*, IF(u.id IS NULL, NULL, JSON_OBJECT('full_name', u.full_name)) AS author,
        a.mime AS att_mime, IF(r.id IS NULL, NULL, JSON_OBJECT('body', r.body, 'author', ru.full_name)) AS reply
        FROM thread_messages m LEFT JOIN users u ON u.id = m.author_id
        LEFT JOIN attachments a ON a.id = m.attachment_id
        LEFT JOIN thread_messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.author_id
        WHERE m.thread_id = ? ORDER BY m.created_at`, [req.params.id]);
    return msgs.map(({ att_mime, ...m }) => ({ ...m, attachment: m.attachment_id ? { url: signedFileUrl(base(req), m.attachment_id), mime: att_mime } : null }));
  } },
  { m: 'POST', p: '/threads/:id/messages', h: async req => {
    const { role } = await threadRole(req.uid, req.params.id as string);
    if (!canComment(role)) fail(403, 'viewers cannot comment');
    const body = String(req.body.body ?? '').trim();
    if (!body || body.length > 4000) fail(400, 'message must be 1-4000 characters');
    const threadId = req.params.id as string;
    const reply = req.body.reply_to ? await one(pool, 'SELECT id FROM thread_messages WHERE id = ? AND thread_id = ?', [req.body.reply_to, threadId]) : null;
    // @mentions: match a member's first name or email name, case-insensitive
    const t = await one(pool, 'SELECT channel_id, created_by, title, vendor FROM threads WHERE id = ?', [threadId]);
    const members = await rows(pool, `SELECT u.id, u.full_name, u.email FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ?`, [t.channel_id]);
    const tags = [...body.matchAll(/@([\p{L}\w.-]+)/gu)].map(m => m[1].toLowerCase());
    const mentioned = members.filter(m => tags.some(tag => tag === String(m.full_name ?? '').split(' ')[0].toLowerCase() || tag === m.email.split('@')[0]))
      .map(m => m.id);
    const msgId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.body.id)) ? String(req.body.id).toLowerCase() : randomUUID();
    if (await one(pool, 'SELECT 1 FROM thread_messages WHERE id = ?', [msgId])) return; // offline retry
    await pool.query('INSERT INTO thread_messages (id, thread_id, author_id, type, body, reply_to, mentions) VALUES (?,?,?,"text",?,?,?)',
      [msgId, threadId, req.uid, body, reply?.id ?? null, JSON.stringify(mentioned)]);
    const who = await userName(pool, req.uid);
    const label = t.title ?? t.vendor ?? 'an expense';
    await notify(pool, mentioned, req.uid, threadId, 'mention', `${who} mentioned you on ${label}: ${body}`);
    await notify(pool, [t.created_by].filter(u => !mentioned.includes(u)), req.uid, threadId, 'comment', `${who} commented on ${label}: ${body}`);
  } },
  { m: 'POST', p: '/messages/:id/react', h: async req => {
    const m = await one(pool, 'SELECT thread_id, reactions FROM thread_messages WHERE id = ?', [req.params.id]);
    if (!m) fail(404, 'message not found');
    const { role } = await threadRole(req.uid, m.thread_id);
    if (!canComment(role)) fail(403, 'viewers cannot react');
    const emoji = String(req.body.emoji ?? '');
    if (![...emoji].length || [...emoji].length > 2) fail(400, 'one emoji');
    const rx: Record<string, string[]> = m.reactions ?? {};
    const list = rx[emoji] ?? [];
    rx[emoji] = list.includes(req.uid) ? list.filter(u => u !== req.uid) : [...list, req.uid];
    if (!rx[emoji].length) delete rx[emoji];
    await pool.query('UPDATE thread_messages SET reactions = ? WHERE id = ?', [JSON.stringify(rx), req.params.id]);
  } },
  { m: 'GET', p: '/notifications', h: async req => {
    await runDaily(pool);
    // ponytail: overdue reminders generated lazily on read, not by a scheduler; add a cron when push lands.
    await pool.query(`INSERT INTO notifications (user_id, thread_id, kind, body)
      SELECT ?, t.id, 'overdue', CONCAT('Overdue: ', COALESCE(t.title, t.vendor, 'expense'), ' was due ', t.due_date)
      FROM threads t JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.user_id = ?
      WHERE t.due_date < CURDATE() AND (t.status IN ('approved','unpaid') OR (t.kind = 'advance' AND t.status = 'paid' AND ${ADVANCE_OUTSTANDING} > 0.005)) AND (t.created_by = ? OR t.assigned_to = ? OR cm.role IN ('owner','approver'))
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ? AND n.thread_id = t.id AND n.kind = 'overdue')`,
      [req.uid, req.uid, req.uid, req.uid, req.uid]);
    const [items, unread] = await Promise.all([
      rows(pool, 'SELECT id, thread_id, kind, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.uid]),
      one(pool, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.uid]),
    ]);
    return { items, unread: Number(unread.n) };
  } },
  { m: 'POST', p: '/notifications/read', h: async req => {
    const ids: number[] = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    await pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL${ids.length ? ' AND id IN (?)' : ''}`,
      ids.length ? [req.uid, ids] : [req.uid]);
  } },
  { m: 'GET', p: '/dashboard', h: async req => {
    const { where, params } = ledgerFilter(req.uid, req.query);
    const q = (sel: string, group = '') => rows(pool, `SELECT ${sel} FROM ledger_entries l
      JOIN channel_members cm ON cm.channel_id = l.channel_id AND cm.user_id = ?
      LEFT JOIN categories c ON c.id = l.category_id JOIN users u ON u.id = l.payer
      LEFT JOIN (SELECT thread_id, SUM(amount) AS paid FROM payments GROUP BY thread_id) p ON p.thread_id = l.thread_id
      WHERE ${where} ${group}`, params);
    const [totals, byCategory, byMember, byMonth, pending] = await Promise.all([
      q(`COALESCE(SUM(l.base_amount),0) AS spent,
         COALESCE(SUM(CASE WHEN l.status IN ('paid','closed') THEN l.base_amount ELSE COALESCE(p.paid,0) * l.fx_rate END),0) AS paid,
         COALESCE(SUM(CASE WHEN l.status IN ('approved','unpaid') THEN (l.amount - COALESCE(p.paid,0)) * l.fx_rate ELSE 0 END),0) AS unpaid,
         COUNT(*) AS entries`),
      q(`COALESCE(c.name, 'Uncategorized') AS label, l.base_amount AS base, l.amount AS amount,
        (SELECT x.line_items FROM threads x WHERE x.id = l.thread_id AND x.kind <> 'advance') AS line_items`),
      q(`u.full_name AS label, SUM(l.base_amount) AS total`, 'GROUP BY l.payer, label ORDER BY total DESC'),
      q(`DATE_FORMAT(l.entry_date, '%Y-%m') AS label, SUM(l.base_amount) AS total`, 'GROUP BY label ORDER BY label'),
      one(pool, `SELECT COALESCE(SUM(t.amount),0) AS amount, COUNT(*) AS n FROM threads t
        JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.user_id = ?
        JOIN channels ch ON ch.id = t.channel_id
        WHERE ${visibleSql()} AND t.status IN ('submitted','under_review','needs_info') ${req.query.channel ? 'AND t.channel_id = ?' : ''} ${req.query.workspace ? 'AND ch.workspace_id = ?' : ''}`,
        [req.uid, req.uid, ...(req.query.channel ? [req.query.channel] : []), ...(req.query.workspace ? [req.query.workspace] : [])]),
    ]);
    const adv = await one(pool, `SELECT COALESCE(SUM(o.out_amt),0) AS amount, COUNT(*) AS n FROM (SELECT ${ADVANCE_OUTSTANDING} AS out_amt
        FROM threads t JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.user_id = ? JOIN channels ch ON ch.id = t.channel_id
        WHERE ${visibleSql()} AND t.kind = 'advance' AND t.status IN ('unpaid','paid') ${req.query.channel ? 'AND t.channel_id = ?' : ''} ${req.query.workspace ? 'AND ch.workspace_id = ?' : ''}) o WHERE o.out_amt > 0.005`,
      [req.uid, req.uid, ...(req.query.channel ? [req.query.channel] : []), ...(req.query.workspace ? [req.query.workspace] : [])]);
    const ws = req.query.workspace ? await one(pool, 'SELECT base_currency FROM workspaces WHERE id = ?', [req.query.workspace]) : null;
    return { ...totals[0], pending: Number(pending.amount), pending_count: Number(pending.n), base_currency: ws?.base_currency ?? 'PKR',
      advances_outstanding: Number(adv.amount), advances_open: Number(adv.n),
      byCategory: await splitByCategory(byCategory), byMember, byMonth };
  } },
  { m: 'GET', p: '/search', h: async req => {
    const q = req.query as Record<string, string | undefined>;
    const where = [visibleSql()]; const params: unknown[] = [req.uid, req.uid];
    // ponytail: LIKE scan; add a FULLTEXT index on (title, vendor, notes) + transcripts(text) past ~100k threads.
    if (q.q) { where.push(`(t.title LIKE ? OR t.vendor LIKE ? OR t.notes LIKE ? OR t.tag LIKE ?
      OR EXISTS (SELECT 1 FROM transcripts tr WHERE tr.thread_id = t.id AND tr.text LIKE ?))`); params.push(...Array(5).fill(`%${q.q}%`)); }
    if (q.status) { where.push('t.status IN (?)'); params.push(q.status.split(',')); }
    if (q.from) { where.push('t.expense_date >= ?'); params.push(q.from); }
    if (q.to) { where.push('t.expense_date <= ?'); params.push(q.to); }
    if (q.min) { where.push('t.amount >= ?'); params.push(Number(q.min)); }
    if (q.max) { where.push('t.amount <= ?'); params.push(Number(q.max)); }
    if (q.member) { where.push('t.created_by = ?'); params.push(q.member); }
    if (q.category) { where.push('t.category_id = ?'); params.push(q.category); }
    if (q.tag) { where.push('t.tag = ?'); params.push(q.tag); }
    if (q.channel) { where.push('t.channel_id = ?'); params.push(q.channel); }
    if (q.view === 'mine_unpaid') { where.push(`t.created_by = ? AND t.status IN ('approved','unpaid')`); params.push(req.uid); }
    if (q.view === 'awaiting_me') { where.push(`t.status IN ('submitted','under_review') AND (cm.role IN ('owner','approver') OR EXISTS (SELECT 1 FROM delegations d WHERE d.channel_id = t.channel_id AND d.to_user = ? AND d.until_date >= CURDATE()))`); params.push(req.uid); }
    if (q.view === 'closed_month') where.push(`t.status = 'closed' AND t.closed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`);
    if (q.view === 'overdue') where.push(`t.due_date < CURDATE() AND t.status NOT IN ('paid','closed','rejected')`);
    if (q.view === 'advances') where.push(`t.kind = 'advance' AND t.status IN ('approved','unpaid','paid') AND ${ADVANCE_OUTSTANDING} > 0.005`);
    if (q.view === 'drafts') { where.push(`t.status = 'draft' AND t.created_by = ?`); params.push(req.uid); }
    const limit = Math.min(Number(q.limit) || 30, 100), offset = Math.max(Number(q.offset) || 0, 0);
    return rows(pool, `${SEARCH_SELECT} JSON_OBJECT('name', ch.name) AS channel
      FROM threads t JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.user_id = ?
      JOIN users u ON u.id = t.created_by LEFT JOIN categories c ON c.id = t.category_id JOIN channels ch ON ch.id = t.channel_id
      WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  } },
  { m: 'GET', p: '/ledger', h: async req => {
    const limit = Math.min(Number(req.query.limit) || 50, 200), offset = Math.max(Number(req.query.offset) || 0, 0);
    const { where, params } = ledgerFilter(req.uid, req.query);
    return rows(pool, `SELECT l.id, l.thread_id, l.entry_date, l.amount, l.currency, l.status,
        JSON_OBJECT('name', ch.name) AS channel, IF(c.id IS NULL, NULL, JSON_OBJECT('name', c.name)) AS category,
        JSON_OBJECT('full_name', u.full_name) AS payer
      FROM ledger_entries l JOIN channel_members cm ON cm.channel_id = l.channel_id AND cm.user_id = ?
      JOIN channels ch ON ch.id = l.channel_id JOIN users u ON u.id = l.payer LEFT JOIN categories c ON c.id = l.category_id
      WHERE ${where} ORDER BY l.entry_date DESC, l.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  } },
  { m: 'GET', p: '/audit/:channelId', h: async req => {
    if (!isApprover(await channelRole(pool, req.uid, req.params.channelId as string))) fail(403, 'approvers only');
    return rows(pool, `SELECT a.id, a.table_name, a.row_id, a.action, a.old_row, a.new_row, a.at, u.full_name AS actor
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor WHERE a.channel_id = ? ORDER BY a.at DESC LIMIT 200`, [req.params.channelId]);
  } },
  ];
}

/** Shared by the server upload route and the phone: record an already-stored file and post it in the thread. */
export async function recordAttachment(pool: Pool, uid: string, threadId: string, channelId: string,
  a: { id: string; name: string; mime: string; size: number; sha256: string | null; storagePath: string }) {
  await tx(pool, async c => {
    await c.query('INSERT INTO attachments (id, thread_id, storage_path, file_name, mime, size_bytes, sha256, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
      [a.id, threadId, a.storagePath, a.name, a.mime, a.size, a.sha256, uid]);
    await c.query('INSERT INTO thread_messages (id, thread_id, author_id, type, body, attachment_id) VALUES (?,?,?,?,?,?)',
      [randomUUID(), threadId, uid, a.mime.startsWith('image/') ? 'image' : a.mime.startsWith('audio/') ? 'voice' : 'file', a.name, a.id]);
    await audit(c, uid, channelId, 'attachments', a.id, 'INSERT', null, { name: a.name, mime: a.mime, sha256: a.sha256 });
    if (a.sha256) {
      const dup = await one(c, `SELECT t.id, COALESCE(t.title, t.vendor, 'another expense') AS label FROM attachments x JOIN threads t ON t.id = x.thread_id
        WHERE x.sha256 = ? AND x.id <> ? AND t.channel_id = ? LIMIT 1`, [a.sha256, a.id, channelId]);
      if (dup) await systemMessage(c, threadId, `Possible duplicate: this exact file is already attached to "${dup.label}"`);
    }
  });
}
