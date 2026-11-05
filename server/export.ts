// Ledger exports: CSV, Excel, PDF, and a zip of all receipts for a period.
// The app opens exports in a browser/download, so it can't send the Authorization header:
// it asks for a short-lived HMAC-signed link instead (same idea as the file links).
import type { Express, Request, Response, RequestHandler } from 'express';
import type { Pool } from 'mysql2/promise';
import { ADVANCE_OUTSTANDING, REPORTS, visibleSql } from './core.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';

const KINDS = ['csv', 'xlsx', 'pdf', 'receipts'] as const;
const sign = (payload: string) => createHmac('sha256', process.env.JWT_SECRET!).update(`export:${payload}`).digest('base64url');

const COLS = [
  ['entry_date', 'Date'], ['type', 'Type'], ['channel', 'Channel'], ['category', 'Category'], ['vendor', 'Vendor'], ['title', 'Description'],
  ['payer', 'Submitted by'], ['holder', 'Given to'], ['status', 'Status'], ['currency', 'Currency'], ['amount', 'Amount'], ['fx_rate', 'FX rate'],
  ['base_amount', 'Base amount'], ['paid', 'Paid'], ['accounted', 'Accounted for'], ['outstanding', 'Outstanding'],
] as const;
const MONEY = ['amount', 'base_amount', 'paid', 'accounted', 'outstanding'];
const LABELS: Record<string, string> = { submitted: 'Submitted', under_review: 'Under review', needs_info: 'Needs info', approved: 'Approved', unpaid: 'Unpaid', paid: 'Paid', rejected: 'Rejected', closed: 'Closed', draft: 'Draft' };
const fmt = (n: unknown) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // quote, and neutralise spreadsheet formula injection
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n']/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportRoutes(app: Express, pool: Pool, auth: RequestHandler, json: RequestHandler, base: (req: Request) => string) {

  app.post('/export-link', auth, json, (req: Request, res: Response) => {
    const { kind, ...filters } = req.body ?? {};
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad export kind' });
    const payload = Buffer.from(JSON.stringify({ uid: (req as Request & { uid: string }).uid, kind, filters, exp: Date.now() + 5 * 60e3 })).toString('base64url');
    res.json({ url: `${base(req)}/export?p=${payload}&sig=${sign(payload)}` });
  });

  app.get('/export', async (req: Request, res: Response) => {
    const p = String(req.query.p ?? ''), sig = String(req.query.sig ?? ''), good = sign(p);
    if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return res.status(403).json({ error: 'bad link' });
    const { uid, kind, filters, exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (exp < Date.now()) return res.status(403).json({ error: 'link expired' });

    const report = REPORTS[filters.report] ?? REPORTS.all;
    const where = ['t.status IN (?)', visibleSql()]; const params: unknown[] = [uid, report.statuses, uid];
    const day = 'COALESCE(t.expense_date, SUBSTR(t.created_at, 1, 10))';
    if (filters.workspace) { where.push('ch.workspace_id = ?'); params.push(filters.workspace); }
    if (filters.channel) { where.push('(t.channel_id = ? OR ch.parent_id = ?)'); params.push(filters.channel, filters.channel); } // a channel's report includes its sub-channels
    if (filters.from) { where.push(`${day} >= ?`); params.push(filters.from); }
    if (filters.to) { where.push(`${day} <= ?`); params.push(filters.to); }
    if (filters.category) { where.push('t.category_id = ?'); params.push(filters.category); }
    if (filters.member) { where.push('t.created_by = ?'); params.push(filters.member); }
    if (report.advances) where.push(`t.kind = 'advance' AND ${ADVANCE_OUTSTANDING} > 0.005`);
    const [raw] = await pool.query(`SELECT t.id AS thread_id, ${day} AS entry_date, t.kind, ch.name AS channel, COALESCE(c.name, '') AS category,
        t.vendor, t.title, u.full_name AS payer, h.full_name AS holder, t.status, t.currency, t.amount, t.fx_rate, w.base_currency, w.name AS workspace,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.thread_id = t.id), 0) AS paid,
        COALESCE((SELECT SUM(CASE WHEN s.kind = 'reimbursed' THEN -s.amount WHEN s.review_status = 'rejected' THEN 0 ELSE s.amount END) FROM settlements s WHERE s.thread_id = t.id), 0) AS accounted
      FROM threads t JOIN channel_members cm ON cm.channel_id = t.channel_id AND cm.user_id = ?
      JOIN channels ch ON ch.id = t.channel_id JOIN workspaces w ON w.id = ch.workspace_id JOIN users u ON u.id = t.created_by
      LEFT JOIN users h ON h.id = t.assigned_to LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${where.join(' AND ')} ORDER BY entry_date, t.created_at`, params) as [any[], unknown];
    const rows = raw.map((r: any) => {
      const advance = r.kind === 'advance', fx = r.currency === r.base_currency ? 1 : Number(r.fx_rate) || 1;
      return { ...r, type: advance ? 'Advance' : 'Expense', status: advance && r.status === 'paid' ? 'Handed over' : LABELS[r.status] ?? r.status, raw_status: r.status, fx_rate: fx,
        base_amount: Math.round(Number(r.amount ?? 0) * fx * 100) / 100,
        accounted: advance ? Number(r.accounted) : null, outstanding: advance ? Math.round((Number(r.paid) - Number(r.accounted)) * 100) / 100 : null };
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const period = `${filters.from || 'Beginning'} to ${filters.to || stamp}`;
    const name = `${(filters.report ?? 'all')}-report-${filters.from ?? 'all'}-${filters.to ?? stamp}`;
    const base_currency = rows[0]?.base_currency ?? '';
    const orgName = rows[0]?.workspace ?? 'ExpenseChat';
    // an advance is money handed over, not spending: never added into the expense total
    const expenseRows = rows.filter((r: any) => r.kind !== 'advance'), advanceRows = rows.filter((r: any) => r.kind === 'advance');
    const total = expenseRows.reduce((s: number, r: any) => s + r.base_amount, 0);
    const advanceTotal = advanceRows.reduce((s: number, r: any) => s + r.base_amount, 0);
    const byStatus = [...expenseRows.reduce((m: Map<string, { n: number; total: number }>, r: any) => {
      const e = m.get(r.status) ?? { n: 0, total: 0 }; e.n++; e.total += r.base_amount; return m.set(r.status, e);
    }, new Map()) as Map<string, { n: number; total: number }>];
    const outstanding = rows.reduce((s: number, r: any) => s + Math.max(r.outstanding ?? 0, 0) * r.fx_rate, 0);
    const [{ full_name: preparedBy }] = (await pool.query('SELECT full_name FROM users WHERE id = ?', [uid]) as [any[], unknown])[0];

    if (kind === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
      // BOM so Excel opens Urdu text correctly
      return res.send('\ufeff' + [COLS.map(c => c[1]).join(','), ...rows.map((r: any) => COLS.map(c => csvCell(r[c[0]])).join(','))].join('\n'));
    }
    if (kind === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const head = (row: ExcelJS.Row) => { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1673D9' } }; };
      const sum = wb.addWorksheet('Summary');
      sum.columns = [{ width: 30 }, { width: 12 }, { width: 20 }];
      sum.addRow([orgName]).font = { bold: true, size: 16 };
      sum.addRow([`${report.title} report`]).font = { bold: true, size: 12 };
      sum.addRow([`Period: ${period}`]);
      sum.addRow([`Prepared by ${preparedBy ?? ''} on ${stamp}`]);
      sum.addRow([]);
      head(sum.addRow(['Status', 'Entries', `Amount (${base_currency})`]));
      byStatus.forEach(([st, e]) => sum.addRow([st, e.n, e.total]));
      sum.addRow(['Total expenses', expenseRows.length, total]).font = { bold: true };
      if (advanceRows.length) sum.addRow(['Advances (not included above)', advanceRows.length, advanceTotal]).font = { bold: true };
      if (outstanding) sum.addRow(['Advances not yet accounted for', '', outstanding]).font = { bold: true };
      sum.getColumn(3).numFmt = '#,##0.00';
      const ws = wb.addWorksheet('Detail', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = COLS.map(([key, header]) => ({ key, header, width: key === 'title' ? 34 : key === 'fx_rate' ? 9 : 15, style: MONEY.includes(key) ? { numFmt: '#,##0.00' } : {} }));
      rows.forEach((r: any) => ws.addRow({ ...r, amount: Number(r.amount ?? 0), paid: Number(r.paid) }));
      head(ws.getRow(1));
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };
      ws.addRow({ title: `Total expenses (${base_currency})`, base_amount: total }).font = { bold: true };
      if (advanceRows.length) ws.addRow({ title: `Total advances (${base_currency})`, base_amount: advanceTotal }).font = { bold: true };
      const advIds = rows.filter((r: any) => r.kind === 'advance').map((r: any) => r.thread_id);
      if (advIds.length) {
        const [ev] = await pool.query(`SELECT t.title, s.spent_on, s.kind, s.description, t.currency, s.amount, s.review_status, a.file_name FROM settlements s JOIN threads t ON t.id = s.thread_id
          LEFT JOIN attachments a ON a.id = s.attachment_id WHERE s.thread_id IN (?) ORDER BY t.title, s.spent_on`, [advIds]) as [any[], unknown];
        const es = wb.addWorksheet('Advance evidence', { views: [{ state: 'frozen', ySplit: 1 }] });
        es.columns = [{ header: 'Advance', key: 'title', width: 30 }, { header: 'Date', key: 'spent_on', width: 12 }, { header: 'Type', key: 'kind', width: 12 }, { header: 'Description', key: 'description', width: 36 },
          { header: 'Currency', key: 'currency', width: 9 }, { header: 'Amount', key: 'amount', width: 15, style: { numFmt: '#,##0.00' } }, { header: 'Review', key: 'review_status', width: 11 }, { header: 'Evidence file', key: 'file_name', width: 30 }];
        ev.forEach((e: any) => es.addRow({ ...e, kind: e.kind === 'returned' ? 'Cash returned' : e.kind === 'reimbursed' ? 'Paid back' : 'Spent' }));
        head(es.getRow(1));
      }
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}.xlsx"` });
      await wb.xlsx.write(res);
      return res.end();
    }
    if (kind === 'pdf') {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"` });
      // ponytail: built-in Helvetica has no Urdu glyphs; embed a Noto Nastaliq font when Urdu PDFs matter.
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
      doc.pipe(res);
      const GREEN = '#1673D9', L = 36, W = 770;
      doc.rect(0, 0, 842, 70).fill(GREEN);
      doc.fill('#fff').font('Helvetica-Bold').fontSize(18).text(orgName, L, 16, { width: 500, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(11).text(`${report.title} report`, L, 42);
      doc.fontSize(9).text(`Period: ${period}`, 500, 20, { width: 306, align: 'right' }).text(`Prepared by ${preparedBy ?? ''} on ${stamp}`, 500, 34, { width: 306, align: 'right' });
      // summary
      doc.fill('#171D1A');
      let y = 84;
      const box = (label: string, value: string, x: number, w: number) => {
        doc.rect(x, y, w, 44).fill('#EDF3FA'); doc.fill('#404943').font('Helvetica').fontSize(8).text(label, x + 8, y + 7, { width: w - 16, lineBreak: false, ellipsis: true });
        doc.fill('#171D1A').font('Helvetica-Bold').fontSize(12).text(value, x + 8, y + 21, { width: w - 16, lineBreak: false, ellipsis: true });
      };
      const boxes: [string, string][] = [];
      if (expenseRows.length || !advanceRows.length) boxes.push([`Total expenses (${expenseRows.length})`, `${base_currency} ${fmt(total)}`], ...byStatus.slice(0, 3).map(([st, e]): [string, string] => [`${st} (${e.n})`, `${base_currency} ${fmt(e.total)}`]));
      if (advanceRows.length) boxes.push([`Advances given (${advanceRows.length})`, `${base_currency} ${fmt(advanceTotal)}`]);
      if (outstanding) boxes.push(['Advances not accounted for', `${base_currency} ${fmt(outstanding)}`]);
      const bw = (W - (boxes.length - 1) * 6) / boxes.length;
      boxes.forEach(([a, b], i) => box(a, b, L + i * (bw + 6), bw));
      y += 58;
      // table
      const cols: [string, number, string, boolean?][] = [['Date', 58, 'entry_date'], ['Type', 46, 'type'], ['Channel', 72, 'channel'], ['Category', 70, 'category'], ['Description', 170, 'desc'],
        ['By', 84, 'who'], ['Status', 64, 'status'], ['Amount', 76, 'amt', true], ['Paid', 65, 'paid_s', true], ['Outstanding', 65, 'out_s', true]];
      const header = () => {
        doc.rect(L, y, W, 18).fill(GREEN); let x = L;
        doc.fill('#fff').font('Helvetica-Bold').fontSize(8);
        cols.forEach(([h, w, , right]) => { doc.text(h, x + 4, y + 5, { width: w - 8, align: right ? 'right' : 'left', lineBreak: false }); x += w; });
        y += 18;
      };
      header();
      rows.forEach((r: any, i: number) => {
        if (y > 530) { doc.addPage(); y = 36; header(); }
        if (i % 2) doc.rect(L, y, W, 16).fill('#F5F9FD');
        const vals: Record<string, string> = { ...r, desc: [r.title, r.vendor].filter(Boolean).join(' / '), who: r.holder ?? r.payer ?? '', amt: `${r.currency} ${fmt(r.amount)}`, paid_s: fmt(r.paid), out_s: r.outstanding == null ? '' : fmt(r.outstanding) };
        let x = L;
        doc.fill('#171D1A').font('Helvetica').fontSize(8);
        cols.forEach(([, w, k, right]) => { doc.text(String(vals[k] ?? ''), x + 4, y + 4, { width: w - 8, align: right ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += w; });
        y += 16;
      });
      if (!rows.length) { doc.fill('#404943').font('Helvetica').fontSize(10).text('No entries match this report.', L, y + 10); y += 30; }
      if (y > 480) { doc.addPage(); y = 36; }
      doc.rect(L, y, W, 18).fill('#E1EFFF');
      doc.fill('#171D1A').font('Helvetica-Bold').fontSize(9).text(`Total expenses: ${base_currency} ${fmt(total)}${advanceRows.length ? `      Total advances: ${base_currency} ${fmt(advanceTotal)}` : ''}`, L + 4, y + 5, { width: W - 8, align: 'right' });
      y += 52;
      // sign-off
      ['Prepared by', 'Reviewed by', 'Approved by'].forEach((label, i) => {
        const x = L + i * 260;
        doc.moveTo(x, y).lineTo(x + 220, y).strokeColor('#707973').stroke();
        doc.fill('#404943').font('Helvetica').fontSize(8).text(label, x, y + 5);
      });
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0; // footer sits below the text area; without this it spills onto a blank page
        doc.fill('#707973').font('Helvetica').fontSize(8).text(`Page ${i + 1} of ${pages.count}`, L, 572, { width: W, align: 'right', lineBreak: false });
      }
      doc.end();
      return;
    }
    // receipts: every attachment on the exported entries, foldered by date + thread
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}-receipts.zip"` });
    const zip = new ZipArchive();
    zip.pipe(res);
    const ids = rows.map((r: any) => r.thread_id);
    if (ids.length) {
      const [atts] = await pool.query<any[]>(`SELECT a.thread_id, a.storage_path, a.file_name FROM attachments a WHERE a.thread_id IN (?)`, [ids]);
      const uploads = process.env.UPLOAD_DIR ?? join(import.meta.dirname, 'uploads');
      for (const a of atts) {
        const row = rows.find((r: any) => r.thread_id === a.thread_id)!;
        const file = join(uploads, a.storage_path);
        if (existsSync(file)) zip.file(file, { name: `${row.entry_date}_${String(row.vendor ?? row.title ?? 'expense').replace(/[^\w-]/g, '_')}_${a.thread_id.slice(0, 8)}/${a.file_name}` });
      }
    }
    zip.append([COLS.map(c => c[1]).join(','), ...rows.map((r: any) => COLS.map(c => csvCell(r[c[0]])).join(','))].join('\n'), { name: 'report.csv' });
    await zip.finalize();
  });
}
