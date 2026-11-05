// End-to-end permission + workflow tests over HTTP against a throwaway MySQL database (<db>_test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';

try { process.loadEnvFile(); } catch { /* env from host */ }
const main = process.env.DATABASE_URL ?? 'sqlite:./data/expensechat.db';
const url = process.env.TEST_DATABASE_URL ?? (main.startsWith('sqlite:') ? 'sqlite:./data/expensechat_test.db' : main.replace(/\/(\w+)$/, '/$1_test'));
process.env.UPLOAD_DIR = `${import.meta.dirname}/uploads_test`;

// reset test db
if (url.startsWith('sqlite:')) {
  for (const ext of ['', '-wal', '-shm']) rmSync(url.slice('sqlite:'.length) + ext, { force: true });
} else {
  const c = await mysql.createConnection({ uri: url });
  await c.query('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await c.query<any[]>('SHOW TABLES');
  for (const t of tables) await c.query(`DROP TABLE \`${Object.values(t)[0]}\``);
  await c.end();
}

const { openDb, createApp } = await import('./app.ts');
const pool = await openDb(url);
const server = createApp(pool).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); pool.end(); });

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}
const ok = async (...a: Parameters<typeof call>) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const denied = async (...a: Parameters<typeof call>) => { const r = await call(...a); assert.ok(r.status >= 400, `${a[1]} ${a[2]} should fail, got ${r.status}`); return r; };

const tok: Record<string, string> = {};
for (const u of ['head', 'acct', 'mem', 'view', 'outsider'])
  tok[u] = (await ok(null, 'POST', '/auth/signup', { email: `${u}@x.com`, password: 'password123', full_name: u })).token;
const ws = (await ok(tok.head, 'POST', '/workspaces', { name: 'Acme' })).id;
const ch = (await ok(tok.head, 'POST', `/workspaces/${ws}/channels`, { name: 'Channel A' })).id;
for (const [u, role] of [['acct', 'approver'], ['mem', 'member'], ['view', 'viewer']])
  await ok(tok.head, 'POST', `/channels/${ch}/members`, { email: `${u}@x.com`, role });

test('auth: bad token and bad password rejected', async () => {
  await denied(null, 'GET', '/workspaces');
  await denied('abc.def.ghi', 'GET', '/workspaces');
  await denied(null, 'POST', '/auth/login', { email: 'head@x.com', password: 'nope' });
  assert.ok((await ok(null, 'POST', '/auth/login', { email: 'HEAD@x.com', password: 'password123' })).token);
});

test('outsiders and viewers are kept out', async () => {
  assert.equal((await ok(tok.outsider, 'GET', '/workspaces')).length, 0);
  await denied(tok.outsider, 'GET', `/channels/${ch}/threads`);
  await denied(tok.view, 'POST', `/channels/${ch}/threads`, { amount: 5 });
  await denied(tok.mem, 'POST', `/channels/${ch}/members`, { email: 'outsider@x.com', role: 'owner' });
  await denied(tok.head, 'DELETE', `/channels/${ch}/members/${(await ok(tok.head, 'GET', '/me')).id}`); // last owner
});

test('full lifecycle with permissions, ledger and lock', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 2000, vendor: 'PSO', status: 'paid' });
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).status, 'draft');
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  await denied(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  await denied(tok.view, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved', comment: 'ok' });
  const ledger = async () => (await ok(tok.mem, 'GET', '/ledger')).find((l: any) => l.thread_id === id);
  assert.equal((await ledger()).amount, 2000);
  await denied(tok.mem, 'PATCH', `/threads/${id}`, { amount: 1 });           // author locked after approval
  await ok(tok.acct, 'PATCH', `/threads/${id}`, { amount: 2100 });
  assert.equal((await ledger()).amount, 2100);                               // ledger synced
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'paid' });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'closed' });
  await denied(tok.acct, 'PATCH', `/threads/${id}`, { amount: 9 });          // closed = locked
  await denied(tok.head, 'POST', `/threads/${id}/transition`, { to: 'under_review' }); // reason required
  await ok(tok.head, 'POST', `/threads/${id}/transition`, { to: 'under_review', comment: 'wrong vendor' });
  const sys = (await ok(tok.mem, 'GET', `/threads/${id}/messages`)).filter((m: any) => m.type === 'system');
  assert.equal(sys.length, 5);
  assert.match(sys[4].body, /reopened.*wrong vendor/);
  assert.ok((await ok(tok.acct, 'GET', `/audit/${ch}`)).length >= 6);
  await denied(tok.mem, 'GET', `/audit/${ch}`);
});

test('comments, uploads and signed file links', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 10 });
  await ok(tok.mem, 'POST', `/threads/${id}/messages`, { body: 'hi' });
  await denied(tok.view, 'POST', `/threads/${id}/messages`, { body: 'hi' });
  const up = await fetch(`${base}/threads/${id}/attachments?name=r.pdf`, { method: 'POST',
    headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'application/pdf' }, body: '%PDF-1.4 test' });
  assert.equal(up.status, 200);
  const bad = await fetch(`${base}/threads/${id}/attachments?name=x.html`, { method: 'POST',
    headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'text/html' }, body: '<script>' });
  assert.equal(bad.status, 415);
  const file = (await ok(tok.view, 'GET', `/threads/${id}/messages`)).find((m: any) => m.type === 'file');
  assert.equal(await (await fetch(file.attachment.url)).text(), '%PDF-1.4 test');
  assert.equal((await fetch(file.attachment.url.replace(/sig=./, 'sig=X'))).status, 403);
});

test('submit needs an amount', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, {});
  const r = await denied(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  assert.match(r.data.error, /amount is required/);
});

test('line items set the total and are validated', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { line_items: [
    { description: 'Cement bag', qty: 3, amount: 1250.5 }, { description: 'Delivery', amount: 400 }] });
  const t = await ok(tok.mem, 'GET', `/threads/${id}`);
  assert.equal(Number(t.amount), 4151.5);
  assert.equal(t.line_items.length, 2);
  await denied(tok.mem, 'PATCH', `/threads/${id}`, { line_items: [{ description: '', amount: 5 }] });
  await denied(tok.mem, 'PATCH', `/threads/${id}`, { line_items: [{ description: 'x', amount: -1 }] });
  await denied(tok.mem, 'PATCH', `/threads/${id}`, { line_items: [{ description: 'x', amount: 1, category_id: 'nope' }] });
  await ok(tok.mem, 'PATCH', `/threads/${id}`, { line_items: [] });
});

test('advance: handover, evidence required, cannot close until accounted, reports', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { kind: 'advance', title: 'Site trip', amount: 1000, currency: 'PKR' });
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  await denied(tok.mem, 'POST', `/threads/${id}/settlements`, { kind: 'returned', amount: 10 }); // not handed over yet
  await ok(tok.acct, 'POST', `/threads/${id}/payments`, { amount: 1000, method: 'cash' });
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).status, 'paid');
  const before = await ok(tok.acct, 'GET', `/dashboard?channel=${ch}`);

  const bad = await denied(tok.mem, 'POST', `/threads/${id}/settlements`, { description: 'Fuel', amount: 600 });
  assert.match(bad.data.error, /evidence/);
  const res = await fetch(`${base}/threads/${id}/attachments?name=r.png`, { method: 'POST', headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'image/png' }, body: 'x' });
  const att = await res.json() as any;
  const s = await ok(tok.mem, 'POST', `/threads/${id}/settlements`, { description: 'Fuel', amount: 600, attachment_id: att.id });
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).balance.outstanding, 400);
  assert.equal(Number((await ok(tok.acct, 'GET', `/dashboard?channel=${ch}`)).spent), Number(before.spent) + 600); // only evidenced spend counts
  assert.match((await denied(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'closed' })).data.error, /not accounted/);
  await denied(tok.mem, 'POST', `/threads/${id}/settlements`, { kind: 'returned', amount: 401 });

  for (const report of ['advances', 'pending', 'all']) for (const kind of ['pdf', 'xlsx', 'csv']) {
    const r = await fetch((await ok(tok.acct, 'POST', '/export-link', { kind, report, channel: ch })).url);
    assert.equal(r.status, 200, `${report} ${kind}`);
    const body = Buffer.from(await r.arrayBuffer());
    assert.ok(body.length > 50);
    if (kind === 'csv' && report === 'advances') assert.match(body.toString(), /Site trip.*400/);
  }

  await ok(tok.mem, 'POST', `/threads/${id}/settlements`, { kind: 'returned', amount: 400 });
  assert.match((await denied(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'closed' })).data.error, /reviewed/);
  await denied(tok.mem, 'POST', `/threads/${id}/settlements/${s.id}/review`, { decision: 'accepted' });      // not an approver
  await denied(tok.acct, 'POST', `/threads/${id}/settlements/${s.id}/review`, { decision: 'rejected' });     // needs a reason
  await ok(tok.acct, 'POST', `/threads/${id}/settlements/${s.id}/review`, { decision: 'rejected', note: 'blurry' });
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).balance.outstanding, 600);                       // rejected spend counts again
  await ok(tok.acct, 'POST', `/threads/${id}/settlements/${s.id}/review`, { decision: 'accepted' });
  // overspend: 500 more than was left must be paid back before closing
  const res2 = await fetch(`${base}/threads/${id}/attachments?name=r2.png`, { method: 'POST', headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'image/png' }, body: 'y' });
  const s2 = await ok(tok.mem, 'POST', `/threads/${id}/settlements`, { description: 'Hotel', amount: 500, attachment_id: ((await res2.json()) as any).id });
  await ok(tok.acct, 'POST', `/threads/${id}/settlements/${s2.id}/review`, { decision: 'accepted' });
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).balance.outstanding, -500);
  assert.match((await denied(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'closed' })).data.error, /owed/);
  await denied(tok.mem, 'POST', `/threads/${id}/settlements`, { kind: 'reimbursed', amount: 500 });
  await denied(tok.acct, 'POST', `/threads/${id}/settlements`, { kind: 'reimbursed', amount: 501 });
  await ok(tok.acct, 'POST', `/threads/${id}/settlements`, { kind: 'reimbursed', amount: 500 });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'closed' });
  await denied(tok.mem, 'DELETE', `/threads/${id}/settlements/${s.id}`);
});

test('invites, delegation, limits, receipt rule, advance block', async () => {
  // a fresh owner channel, so these rules don't disturb the shared one
  const owner = (await ok(null, 'POST', '/auth/signup', { email: `o${Date.now()}@x.co`, password: 'password123', full_name: 'Olga' })).token;
  const joinerU = await ok(null, 'POST', '/auth/signup', { email: `j${Date.now()}@x.co`, password: 'password123', full_name: 'Jan' });
  const joiner = joinerU.token;
  const w = (await ok(owner, 'POST', '/workspaces', { name: 'W' })).id;
  const c2 = (await ok(owner, 'POST', `/workspaces/${w}/channels`, { name: 'C' })).id;
  await denied(joiner, 'POST', `/channels/${c2}/invites`, {});
  const inv = await ok(owner, 'POST', `/channels/${c2}/invites`, { role: 'member' });
  await denied(joiner, 'GET', `/channels/${c2}`);
  assert.equal((await ok(joiner, 'GET', `/invites/${inv.token}`)).channel, 'C');
  assert.equal((await ok(joiner, 'POST', `/invites/${inv.token}/accept`)).channel_id, c2);
  await denied(joiner, 'POST', '/invites/NOPE/accept');

  // delegation lifts a member to approver, only until the date
  const exp = (await ok(joiner, 'POST', `/channels/${c2}/threads`, { title: 'x', amount: 100, currency: 'PKR' })).id;
  await ok(joiner, 'POST', `/threads/${exp}/transition`, { to: 'submitted' });
  await denied(joiner, 'POST', `/threads/${exp}/transition`, { to: 'approved' });
  await denied(joiner, 'POST', `/channels/${c2}/delegation`, { to_user: joinerU.user.id, until: '2099-01-01' });
  await ok(owner, 'POST', `/channels/${c2}/delegation`, { to_user: joinerU.user.id, until: '2099-01-01' });
  assert.ok((await ok(joiner, 'GET', '/search?view=awaiting_me')).some((t: any) => t.id === exp));
  await denied(joiner, 'PATCH', `/channels/${c2}`, { name: 'hack' });          // approvals only, not ownership
  const bulk = await ok(joiner, 'POST', '/threads/bulk-transition', { ids: [exp, 'missing'], to: 'approved' });
  assert.deepEqual(bulk.results.map((r: any) => r.ok), [true, false]);
  await ok(owner, 'DELETE', `/channels/${c2}/delegation`);
  await denied(joiner, 'POST', '/threads/bulk-transition', { ids: [exp], to: 'closed' });

  // rules at submit
  await ok(owner, 'PATCH', `/channels/${c2}`, { name: 'C', receipt_required_above: 500, block_new_advance: true });
  const big = (await ok(joiner, 'POST', `/channels/${c2}/threads`, { title: 'big', amount: 600, currency: 'PKR' })).id;
  assert.match((await denied(joiner, 'POST', `/threads/${big}/transition`, { to: 'submitted' })).data.error, /receipt/);
  await ok(owner, 'PATCH', `/channels/${c2}/members/${joinerU.user.id}/limit`, { monthly_limit: 150 });
  const l = (await ok(joiner, 'POST', `/channels/${c2}/threads`, { title: 'l', amount: 100, currency: 'PKR', expense_date: new Date().toISOString().slice(0, 10) })).id;
  assert.match((await denied(joiner, 'POST', `/threads/${l}/transition`, { to: 'submitted' })).data.error, /monthly limit/);
  await ok(owner, 'PATCH', `/channels/${c2}/members/${joinerU.user.id}/limit`, { monthly_limit: null });
  const a1 = (await ok(joiner, 'POST', `/channels/${c2}/threads`, { kind: 'advance', title: 'a1', amount: 50, currency: 'PKR' })).id;
  await ok(joiner, 'POST', `/threads/${a1}/transition`, { to: 'submitted' });
  await ok(owner, 'POST', `/threads/${a1}/transition`, { to: 'approved' });
  await ok(owner, 'POST', `/threads/${a1}/payments`, { amount: 50, method: 'cash' });
  const a2 = (await ok(joiner, 'POST', `/channels/${c2}/threads`, { kind: 'advance', title: 'a2', amount: 50, currency: 'PKR' })).id;
  assert.match((await denied(joiner, 'POST', `/threads/${a2}/transition`, { to: 'submitted' })).data.error, /still has an advance/);
});

test('budgets warn, templates, recurring drafts, daily job runs once', async () => {
  const owner = (await ok(null, 'POST', '/auth/signup', { email: `b${Date.now()}@x.co`, password: 'password123', full_name: 'Bea' })).token;
  const w = (await ok(owner, 'POST', '/workspaces', { name: 'B' })).id;
  const c3 = (await ok(owner, 'POST', `/workspaces/${w}/channels`, { name: 'C', approval_required: false })).id;
  await ok(owner, 'POST', `/workspaces/${w}/budgets`, { scope: 'channel', target: c3, amount: 100 });
  const e = (await ok(owner, 'POST', `/channels/${c3}/threads`, { title: 'e', amount: 90, currency: 'PKR', expense_date: new Date().toISOString().slice(0, 10) })).id;
  await ok(owner, 'POST', `/threads/${e}/transition`, { to: 'submitted' });
  assert.equal((await ok(owner, 'GET', `/workspaces/${w}/budgets`))[0].spent, 90);
  const notes = (await ok(owner, 'GET', '/notifications')).items;
  // the actor is told too: this is a warning for admins, not a message from someone else
  assert.ok(notes.some((n: any) => n.kind === 'budget' && /80%/.test(n.body)));

  const tpl = await ok(owner, 'POST', `/channels/${c3}/templates`, { name: 'Fuel', data: { title: 'Fuel', amount: 10, currency: 'PKR' } });
  assert.equal((await ok(owner, 'GET', `/channels/${c3}/templates`))[0].data.title, 'Fuel');
  await ok(owner, 'DELETE', `/channels/${c3}/templates/${tpl.id}`);

  await denied(owner, 'POST', `/channels/${c3}/recurring`, { day_of_month: 31, data: {} });
  await denied(owner, 'POST', `/channels/${c3}/recurring`, { day_of_month: 5, data: { amount: -1 } });
  await ok(owner, 'POST', `/channels/${c3}/recurring`, { day_of_month: 5, data: { title: 'Rent', amount: 1000, currency: 'PKR' } });
  const count = async () => (await ok(owner, 'GET', `/channels/${c3}/threads`)).filter((t: any) => t.title === 'Rent').length;
  const { runDaily } = await import('./core.ts');
  await runDaily(pool, '2099-03-05');
  const made = await count();
  assert.ok(made >= 12 || made >= 1);
  await runDaily(pool, '2099-03-05');
  assert.equal(await count(), made);                                           // same day: nothing new
});

test('forgot password and account deletion', async () => {
  const email = `f${Date.now()}@x.co`;
  const u = await ok(null, 'POST', '/auth/signup', { email, password: 'password123', full_name: 'Fay' });
  const logs: string[] = []; const orig = console.log; console.log = (m: string) => { logs.push(String(m)); };
  await ok(null, 'POST', '/auth/forgot', { email });
  await ok(null, 'POST', '/auth/forgot', { email: 'nobody@x.co' });            // same answer for unknown emails
  console.log = orig;
  const code = /Code for .*: (\d{6})/.exec(logs.join('\n'))![1];
  await denied(null, 'POST', '/auth/reset', { email, code: '000000', password: 'newpassword1' });
  await denied(null, 'POST', '/auth/reset', { email, code, password: 'short' });
  await ok(null, 'POST', '/auth/reset', { email, code, password: 'newpassword1' });
  await denied(null, 'POST', '/auth/reset', { email, code, password: 'again12345' }); // one use
  const t = (await ok(null, 'POST', '/auth/login', { email, password: 'newpassword1' })).token;
  await denied(t, 'DELETE', '/me', { password: 'wrong' });
  await ok(t, 'DELETE', '/me', { password: 'newpassword1' });
  await denied(null, 'POST', '/auth/login', { email, password: 'newpassword1' });
  assert.ok(u.user.id);
});

test('two-step approval above owner limit', async () => {
  await ok(tok.head, 'PATCH', `/channels/${ch}`, { name: 'Channel A', approval_required: true, owner_approval_limit: 50000 });
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 90000, vendor: 'Laptop shop' });
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  assert.equal((await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved' })).status, 'under_review');
  assert.ok(!(await ok(tok.mem, 'GET', '/ledger')).some((l: any) => l.thread_id === id));      // not posted yet
  assert.ok((await ok(tok.head, 'GET', '/notifications')).items.some((n: any) => n.kind === 'approval_request' && n.thread_id === id));
  assert.equal((await ok(tok.head, 'POST', `/threads/${id}/transition`, { to: 'approved' })).status, 'approved');
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}`)).approvals.length, 2);
  await ok(tok.head, 'PATCH', `/channels/${ch}`, { name: 'Channel A', approval_required: true, owner_approval_limit: null });
});

test('partial then full payment', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 1000, vendor: 'Printer' });
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  await denied(tok.mem, 'POST', `/threads/${id}/payments`, { amount: 400, method: 'cash' });      // members can't pay
  await ok(tok.acct, 'POST', `/threads/${id}/payments`, { amount: 400, method: 'cash' });
  let t = await ok(tok.mem, 'GET', `/threads/${id}`);
  assert.equal(t.status, 'unpaid'); assert.equal(t.paid_total, 400);
  await denied(tok.acct, 'POST', `/threads/${id}/payments`, { amount: 700, method: 'card' });     // overpay
  await ok(tok.acct, 'POST', `/threads/${id}/payments`, { amount: 600, method: 'bank_transfer', reference: 'TX-9' });
  t = await ok(tok.mem, 'GET', `/threads/${id}`);
  assert.equal(t.status, 'paid'); assert.equal(t.payments.length, 2);
});

test('foreign currency needs an exchange rate', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 100, currency: 'USD', vendor: 'AWS' });
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  await denied(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  await ok(tok.acct, 'PATCH', `/threads/${id}`, { fx_rate: 280 });
  await ok(tok.acct, 'POST', `/threads/${id}/transition`, { to: 'approved' });
  const d = await ok(tok.acct, 'GET', `/dashboard?workspace=${ws}`);
  assert.ok(d.byCategory.length && Number(d.spent) >= 28000);
});

test('mentions notify, reactions toggle, search views, duplicates, export link', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 2000, vendor: 'PSO', expense_date: '2026-01-05' });
  const { id: id2 } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { amount: 2000, vendor: 'pso', expense_date: '2026-01-05' });
  assert.ok((await ok(tok.mem, 'GET', `/threads/${id2}/duplicates`)).some((d: any) => d.id === id));
  await ok(tok.mem, 'POST', `/threads/${id}/messages`, { body: 'please check @acct' });
  assert.ok((await ok(tok.acct, 'GET', '/notifications')).items.some((n: any) => n.kind === 'mention'));
  const msg = (await ok(tok.mem, 'GET', `/threads/${id}/messages`)).find((m: any) => m.type === 'text');
  await ok(tok.acct, 'POST', `/messages/${msg.id}/react`, { emoji: '👍' });
  assert.deepEqual(Object.keys((await ok(tok.mem, 'GET', `/threads/${id}/messages`)).find((m: any) => m.id === msg.id).reactions), ['👍']);
  await ok(tok.mem, 'POST', `/threads/${id}/transition`, { to: 'submitted' });
  assert.ok((await ok(tok.acct, 'GET', '/search?view=awaiting_me')).some((t: any) => t.id === id));
  assert.ok(!(await ok(tok.mem, 'GET', '/search?view=awaiting_me')).some((t: any) => t.id === id));
  assert.ok((await ok(tok.mem, 'GET', '/search?q=pso')).length >= 2);
  assert.equal((await ok(tok.outsider, 'GET', '/search?q=pso')).length, 0);
  const { url } = await ok(tok.acct, 'POST', '/export-link', { kind: 'csv', workspace: ws });
  const csv = await (await fetch(url)).text();
  assert.match(csv, /Date,Type,Channel/);
  assert.equal((await fetch(url.replace(/sig=./, 'sig=X'))).status, 403);
  for (const kind of ['xlsx', 'pdf', 'receipts']) {
    const r = await fetch((await ok(tok.acct, 'POST', '/export-link', { kind, workspace: ws })).url);
    assert.equal(r.status, 200, kind); assert.ok((await r.arrayBuffer()).byteLength > 100, kind);
  }
});

test('files support range requests, links stay stable while refreshing', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { source_type: 'voice' });
  await fetch(`${base}/threads/${id}/attachments?name=note.wav`, { method: 'POST', headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'audio/wav' }, body: 'abcdefghij' });
  const url = (await ok(tok.mem, 'GET', `/threads/${id}/messages`)).find((m: any) => m.attachment).attachment.url;
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await ok(tok.mem, 'GET', `/threads/${id}/messages`)).find((m: any) => m.attachment).attachment.url, url);
  const part = await fetch(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'cde');
});

test('sub-channels: same members, one level, owner only, included in the parent report', async () => {
  const w2 = ws;
  await denied(tok.mem, 'POST', `/workspaces/${w2}/channels`, { name: 'Nope', parent_id: ch });
  const owner = tok.head;
  const sub = (await ok(owner, 'POST', `/workspaces/${w2}/channels`, { name: 'Lahore', parent_id: ch })).id;
  await denied(owner, 'POST', `/workspaces/${w2}/channels`, { name: 'Deep', parent_id: sub });
  assert.ok((await ok(tok.mem, 'GET', `/channels/${ch}`)).subchannels.some((c: any) => c.id === sub));
  assert.equal((await ok(tok.mem, 'GET', `/channels/${sub}`)).my_role, 'member');
  const e = (await ok(tok.mem, 'POST', `/channels/${sub}/threads`, { title: 'SubOnlyItem', amount: 5, currency: 'PKR' })).id;
  await ok(tok.mem, 'POST', `/threads/${e}/transition`, { to: 'submitted' });
  const csv = await (await fetch((await ok(tok.acct, 'POST', '/export-link', { kind: 'csv', report: 'pending', channel: ch })).url)).text();
  assert.match(csv, /SubOnlyItem/);
});

test('AI settings: admin only, keys hidden, a local OpenAI-compatible server fills the form', async () => {
  const calls: any[] = [];
  const local = createServer((rq, rs) => {
    let b = ''; rq.on('data', d => { b += d; }); rq.on('end', () => {
      calls.push({ url: rq.url, auth: rq.headers.authorization, body: JSON.parse(b || '{}') });
      rs.setHeader('Content-Type', 'application/json');
      rs.end(JSON.stringify({ choices: [{ message: { content: 'Sure! ```json\n{"title":"Fuel","amount":1500,"currency":"PKR","line_items":[{"description":"Petrol","amount":1500}]}\n```' } }] }));
    });
  }).listen(0);
  const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/v1`;
  const settings = { extract: { provider: 'openai', url, model: 'llava', key: 'sk-secret-123' }, transcribe: { provider: 'none' } };
  await denied(tok.mem, 'PUT', `/workspaces/${ws}/ai`, settings);
  await denied(tok.mem, 'GET', `/workspaces/${ws}/ai`);
  await denied(tok.head, 'PUT', `/workspaces/${ws}/ai`, { extract: { provider: 'openai', url: 'ftp://x' }, transcribe: {} });
  assert.equal((await ok(tok.head, 'POST', `/workspaces/${ws}/ai/test`, settings)).ok, true);
  assert.equal((await ok(tok.head, 'POST', `/workspaces/${ws}/ai/test`, { extract: { provider: 'openai', url: 'http://127.0.0.1:1/v1', model: 'x' }, transcribe: {} })).ok, false);
  await ok(tok.head, 'PUT', `/workspaces/${ws}/ai`, settings);
  const got = await ok(tok.head, 'GET', `/workspaces/${ws}/ai`);
  assert.ok(!JSON.stringify(got).includes('sk-secret-123'));
  assert.equal(got.extract.has_key, true);
  assert.equal((await ok(tok.mem, 'GET', `/channels/${ch}`)).ai.extract, true);

  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { source_type: 'photo' });
  await fetch(`${base}/threads/${id}/attachments?name=r.png`, { method: 'POST', headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'image/png' }, body: 'img' });
  const r = await ok(tok.mem, 'POST', `/threads/${id}/extract`);
  assert.equal(r.fields.amount.value, 1500);
  assert.equal(r.fields.vendor.value, null);
  assert.equal(r.line_items[0].description, 'Petrol');
  const last = calls.at(-1);
  assert.equal(last.auth, 'Bearer sk-secret-123');                     // saved key decrypted and used
  assert.equal(last.body.model, 'llava');
  assert.ok(last.body.messages[0].content.some((p: any) => p.type === 'image_url'));

  // saving again with a blank key keeps it; off means off
  await ok(tok.head, 'PUT', `/workspaces/${ws}/ai`, { extract: { provider: 'openai', url, model: 'llava' }, transcribe: {} });
  assert.equal((await ok(tok.head, 'GET', `/workspaces/${ws}/ai`)).extract.has_key, true);
  await ok(tok.head, 'PUT', `/workspaces/${ws}/ai`, { extract: { provider: 'none' }, transcribe: {} });
  assert.match((await denied(tok.mem, 'POST', `/threads/${id}/extract`)).data.error, /not set up/);
  local.close();
});

test('record scope: own / selected hide others everywhere; only owner or admin can set it', async () => {
  const who = async (n: string) => ({ token: tok[n], user: await ok(tok[n], 'GET', '/me') });
  const [own, a, b, c] = [await who('head'), await who('mem'), await who('acct'), await who('view')];
  const w = (await ok(own.token, 'POST', '/workspaces', { name: 'S' })).id;
  const cid = (await ok(own.token, 'POST', `/workspaces/${w}/channels`, { name: 'C', approval_required: false })).id;
  const inv = await ok(own.token, 'POST', `/channels/${cid}/invites`, { role: 'member' });
  for (const u of [a, b, c]) await ok(u.token, 'POST', `/invites/${inv.token}/accept`);
  const today = new Date().toISOString().slice(0, 10);
  const make = async (u: any, title: string) => { const { id } = await ok(u.token, 'POST', `/channels/${cid}/threads`, { title, amount: 100, currency: 'PKR', expense_date: today });
    await ok(u.token, 'POST', `/threads/${id}/transition`, { to: 'submitted' }); return id; };
  const ta = await make(a, 'AnaItem'), tb = await make(b, 'BoItem'), tc = await make(c, 'CyItem');
  const feed = async (u: any) => (await ok(u.token, 'GET', `/channels/${cid}/threads`)).map((t: any) => t.title).sort();
  assert.equal((await feed(a)).length, 3);                             // default: everyone

  await denied(a.token, 'PATCH', `/channels/${cid}/members/${a.user.id}/scope`, { scope: 'all' });
  await ok(own.token, 'PATCH', `/channels/${cid}/members/${a.user.id}/scope`, { scope: 'own' });
  assert.deepEqual(await feed(a), ['AnaItem']);
  await denied(a.token, 'GET', `/threads/${tb}`);
  await denied(a.token, 'GET', `/threads/${tb}/messages`);
  await denied(a.token, 'POST', `/threads/${tb}/messages`, { body: 'hi' });
  await denied(a.token, 'GET', `/threads/${tb}/duplicates`);
  await denied(a.token, 'POST', `/threads/${tb}/transition`, { to: 'closed' });
  await ok(a.token, 'GET', `/threads/${ta}`);
  assert.deepEqual((await ok(a.token, 'GET', `/search?q=Item&channel=${cid}`)).map((t: any) => t.title), ['AnaItem']);
  assert.equal((await ok(a.token, 'GET', `/ledger?channel=${cid}`)).length, 1);
  assert.equal(Number((await ok(a.token, 'GET', `/dashboard?channel=${cid}`)).spent), 100);
  const wsRow = (await ok(a.token, 'GET', '/workspaces')).find((x: any) => x.id === w).channels[0];
  assert.equal(wsRow.last.title, 'AnaItem');
  const csv = await (await fetch((await ok(a.token, 'POST', '/export-link', { kind: 'csv', channel: cid })).url)).text();
  assert.ok(csv.includes('AnaItem') && !csv.includes('BoItem'));

  await ok(own.token, 'PATCH', `/channels/${cid}/members/${a.user.id}/scope`, { scope: 'selected', users: [b.user.id] });
  assert.deepEqual(await feed(a), ['AnaItem', 'BoItem']);
  await ok(a.token, 'GET', `/threads/${tb}`);
  await denied(a.token, 'GET', `/threads/${tc}`);
  await denied(own.token, 'PATCH', `/channels/${cid}/members/${a.user.id}/scope`, { scope: 'selected', users: ['nobody'] });
  assert.equal((await feed(own)).length, 3);                           // the owner always sees all
  // an advance given to someone is visible to them, even with scope "own"
  await ok(own.token, 'PATCH', `/channels/${cid}/members/${b.user.id}/scope`, { scope: 'own' });
  await ok(own.token, 'POST', `/channels/${cid}/threads`, { kind: 'advance', title: 'ForBo', amount: 5, currency: 'PKR', assigned_to: b.user.id });
  assert.deepEqual(await feed(b), ['BoItem', 'ForBo']);
});

test('voice upload accepted; stale offline edit rejected', async () => {
  const { id } = await ok(tok.mem, 'POST', `/channels/${ch}/threads`, { source_type: 'voice' });
  const up = await fetch(`${base}/threads/${id}/attachments?name=note.m4a`, { method: 'POST',
    headers: { Authorization: `Bearer ${tok.mem}`, 'Content-Type': 'audio/mp4' }, body: 'fake-audio' });
  assert.equal(up.status, 200);
  const t = await ok(tok.mem, 'GET', `/threads/${id}`);
  assert.equal(t.source_type, 'voice');
  const r = await call(tok.mem, 'POST', `/threads/${id}/extract`);
  if (!process.env.ANTHROPIC_API_KEY) assert.equal(r.status, 503);
  await ok(tok.mem, 'PATCH', `/threads/${id}`, { amount: 5, if_updated_at: t.updated_at });
  await new Promise(res => setTimeout(res, 1100));
  await ok(tok.mem, 'PATCH', `/threads/${id}`, { amount: 6 });
  assert.equal((await call(tok.mem, 'PATCH', `/threads/${id}`, { amount: 7, if_updated_at: t.updated_at })).status, 409);
});
