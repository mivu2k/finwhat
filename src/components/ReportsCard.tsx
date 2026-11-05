import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { MODE, api, errMsg } from '../lib/api';
import { localReportRows } from '../lib/localBridge';
import { Alert, Button, Card, Chips, H, amountText, useTheme } from '../lib/ui';

const CHOICES = [{ id: 'all', name: 'All' }, { id: 'pending', name: 'Pending' }, { id: 'approved', name: 'Approved' }, { id: 'unpaid', name: 'Unpaid' },
  { id: 'paid', name: 'Paid' }, { id: 'rejected', name: 'Rejected' }, { id: 'advances', name: 'Open advances' }];
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const cell = (v: unknown) => { const s = String(v ?? ''); const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };

/** Choose what to include, then download. Server mode gets the server's reports; offline mode builds PDF/CSV on the phone. */
export function ReportsCard({ filters, hint }: { filters: Record<string, string>; hint: string }) {
  const t = useTheme();
  const [report, setReport] = useState('all');
  const offline = MODE === 'local';
  async function server(kind: string) {
    try { Linking.openURL((await api<{ url: string }>('POST', '/export-link', { kind, report, ...filters })).url); }
    catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  async function phone(kind: 'pdf' | 'csv') {
    try {
      const { title, rows } = await localReportRows(report, filters.channel, filters.from, filters.to);
      const total = rows.filter(r => r.kind !== 'advance').reduce((s, r) => s + Number(r.amount), 0);
      let uri: string;
      if (kind === 'pdf') {
        const html = `<html><body style="font-family:sans-serif;font-size:11px"><h2 style="color:#1673D9">${esc(title)} report</h2><p>${esc(filters.from || 'Beginning')} to ${esc(filters.to || new Date().toISOString().slice(0, 10))}</p>
          <table width="100%" cellspacing="0" cellpadding="5"><tr style="background:#1673D9;color:#fff"><th align="left">Date</th><th align="left">Type</th><th align="left">Channel</th><th align="left">Category</th><th align="left">Description</th><th align="left">Status</th><th align="right">Amount</th><th align="right">Paid</th></tr>
          ${rows.map(r => `<tr><td>${esc(r.date)}</td><td>${r.kind === 'advance' ? 'Advance' : 'Expense'}</td><td>${esc(r.channel)}</td><td>${esc(r.category)}</td><td>${esc([r.title, r.vendor].filter(Boolean).join(' / '))}</td><td>${esc(r.status)}</td><td align="right">${esc(r.currency)} ${amountText(Number(r.amount))}</td><td align="right">${amountText(Number(r.paid))}</td></tr>`).join('')}
          </table><h3 style="text-align:right">Total expenses: ${amountText(total)}</h3></body></html>`;
        uri = (await Print.printToFileAsync({ html })).uri;
      } else {
        const f = new File(Paths.cache, `${report}-report.csv`);
        f.create({ overwrite: true });
        f.write('﻿' + [['Date', 'Type', 'Channel', 'Category', 'Title', 'Vendor', 'Status', 'Currency', 'Amount', 'Paid'].join(','),
          ...rows.map(r => [r.date, r.kind, r.channel, r.category, r.title, r.vendor, r.status, r.currency, r.amount, r.paid].map(cell).join(','))].join('\n'));
        uri = f.uri;
      }
      await Sharing.shareAsync(uri);
    } catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  return (
    <Card>
      <H>Reports</H>
      <Chips label="What to include" value={report} onChange={r => r && setReport(r)} options={CHOICES} />
      <Text style={{ color: t.muted, fontSize: 13 }}>{hint}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {offline ? <>
          <Button small kind="ghost" icon="document-outline" title="PDF" onPress={() => phone('pdf')} />
          <Button small kind="ghost" icon="grid-outline" title="Excel (CSV)" onPress={() => phone('csv')} />
        </> : <>
          <Button small kind="ghost" icon="document-outline" title="PDF" onPress={() => server('pdf')} />
          <Button small kind="ghost" icon="grid-outline" title="Excel" onPress={() => server('xlsx')} />
          <Button small kind="ghost" icon="document-text-outline" title="CSV" onPress={() => server('csv')} />
          <Button small kind="ghost" icon="archive-outline" title="Receipts" onPress={() => server('receipts')} />
        </>}
      </View>
    </Card>
  );
}
