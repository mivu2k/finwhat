// Offline mode end to end, in Node: expo-sqlite is stood in for by node:sqlite (same SQL engine), files by a temp dir.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, copyFileSync, writeFileSync, statSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'expensechat-local-'));
mock.module('expo-sqlite', { namedExports: { openDatabaseAsync: async () => {
  const db = new DatabaseSync(':memory:');
  return {
    execAsync: async (sql: string) => { db.exec(sql); },
    getAllAsync: async (sql: string, v: any[]) => db.prepare(sql).all(...v),
    runAsync: async (sql: string, v: any[]) => { const r = db.prepare(sql).run(...v); return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }; },
  };
} } });
class FakeDir { uri: string; constructor(parent: { uri: string }, name: string) { this.uri = join(parent.uri, name); } create() { mkdirSync(this.uri, { recursive: true }); } }
class FakeFile {
  uri: string;
  constructor(a: { uri: string } | string, name?: string) { this.uri = typeof a === 'string' ? a : join(a.uri, name!); }
  get size() { return statSync(this.uri).size; }
  async copy(to: FakeFile) { copyFileSync(this.uri, to.uri); }
  get exists() { return existsSync(this.uri); }
  async base64() { return readFileSync(this.uri).toString('base64'); }
  write(b64: string) { writeFileSync(this.uri, Buffer.from(b64, 'base64')); }
}
mock.module('expo-file-system', { namedExports: { Directory: FakeDir, File: FakeFile, Paths: { document: { uri: dir } } } });

const { localRequest, localUpload, dumpBackup, restoreBackup, localReportRows } = await import('./local.ts');
const call = (m: string, p: string, b?: unknown) => localRequest(m, p, b) as Promise<any>;

test('offline mode: seeded workspace, full expense lifecycle, uploads, dashboard', async () => {
  const me = await call('GET', '/me');
  assert.equal(me.full_name, 'You');
  const [ws] = await call('GET', '/workspaces');
  assert.equal(ws.name, 'My expenses');
  const ch = ws.channels[0];
  assert.equal(ch.name, 'General');
  assert.equal(ch.role, 'owner');

  const cats = await call('GET', `/workspaces/${ws.id}/categories`);
  const fuel = cats.find((c: any) => c.name === 'Fuel').id, rent = cats.find((c: any) => c.name === 'Rent').id;
  const { id } = await call('POST', `/channels/${ch.id}/threads`, { title: 'Site materials', category_id: rent, vendor: 'Ittefaq', expense_date: '2026-11-03',
    line_items: [{ description: 'Cement', qty: 3, amount: 1250 }, { description: 'Delivery', amount: 600, category_id: fuel }] });
  let t = await call('GET', `/threads/${id}`);
  assert.equal(Number(t.amount), 4350);
  assert.equal(t.line_items[1].category_name, 'Fuel');
  assert.equal(t.author.full_name, 'You');                         // JSON_OBJECT columns come back parsed

  // single person, so the channel auto-approves on submit
  assert.equal((await call('POST', `/threads/${id}/transition`, { to: 'submitted' })).status, 'approved');
  await call('POST', `/threads/${id}/payments`, { amount: 4350, method: 'cash' });
  t = await call('GET', `/threads/${id}`);
  assert.equal(t.status, 'paid');
  assert.equal(t.paid_total, 4350);

  await call('POST', `/threads/${id}/messages`, { body: 'Receipt is in the drawer' });
  const src = join(dir, 'receipt.png'); writeFileSync(src, 'png-bytes');
  await localUpload(id, src, 'receipt.png', 'image/png', '11111111-1111-4111-8111-111111111111');
  const msgs = await call('GET', `/threads/${id}/messages`);
  const img = msgs.find((m: any) => m.type === 'image');
  assert.ok(img.attachment.url.endsWith('11111111-1111-4111-8111-111111111111'));
  assert.equal(statSync(img.attachment.url).size, 9);              // the file really was copied into app storage

  const feed = await call('GET', `/channels/${ch.id}/threads?offset=0&limit=30`);
  assert.equal(feed[0].reply_count, 1);
  assert.equal(feed[0].preview.type, 'image');
  const dash = await call('GET', `/dashboard?workspace=${ws.id}`);
  assert.equal(Number(dash.spent), 4350);
  assert.equal(Number(dash.paid), 4350);
  assert.deepEqual(dash.byCategory, [{ label: 'Rent', total: 3750 }, { label: 'Fuel', total: 600 }]); // split by item category
  assert.equal((await call('GET', '/search?q=Ittefaq&offset=0&limit=30')).length, 1);
  assert.ok((await call('GET', `/audit/${ch.id}`)).length >= 3);

  const added = await call('POST', `/workspaces/${ws.id}/categories`, { name: 'Tools' });
  await assert.rejects(call('POST', `/workspaces/${ws.id}/categories`, { name: 'tools' }), /already exists/);
  await call('PATCH', `/workspaces/${ws.id}/categories/${added.id}`, { name: 'Hand tools' });
  await call('DELETE', `/workspaces/${ws.id}/categories/${fuel}`); // in use: the item falls back to the expense's category
  const after = (await call('GET', `/workspaces/${ws.id}/categories`)).map((c: any) => c.name);
  assert.ok(after.includes('Hand tools') && !after.includes('Fuel'));
  assert.equal((await call('GET', `/threads/${id}`)).status, 'paid');

  await assert.rejects(call('POST', `/threads/${id}/extract`), /server mode/);
  await assert.rejects(call('POST', `/threads/${id}/transition`, { to: 'submitted' }), /not allowed/);

  // backup round trip: wipe by restoring an old copy, then the newer data and the file come back
  const backup = await dumpBackup();
  await call('POST', `/channels/${ch.id}/threads`, { title: 'Made after backup', amount: 5, currency: 'PKR' });
  rmSync(img.attachment.url);
  await restoreBackup(backup);
  const titles = (await call('GET', `/channels/${ch.id}/threads`)).map((x: any) => x.title);
  assert.ok(titles.includes('Site materials') && !titles.includes('Made after backup'));
  assert.equal(statSync(img.attachment.url).size, 9);
  await assert.rejects(restoreBackup('{"format":"nope"}'), /not an ExpenseChat backup/);

  const rep = await localReportRows('paid', ch.id);
  assert.equal(rep.rows.length, 1);
  assert.equal(Number(rep.rows[0].amount), 4350);
});
