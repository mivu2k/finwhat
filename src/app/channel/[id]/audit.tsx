import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../../lib/api';
import { Avatar, Screen, ago, money, useTheme } from '../../../lib/ui';
import { LABEL, type Status } from '../../../lib/workflow';

type Row = { id: number; table_name: string; row_id: string; action: string; old_row: any; new_row: any; at: string; actor: string | null };

const SKIP = (k: string) => k.endsWith('_id') || ['updated_at', 'created_at', 'id', 'created_by', 'password_hash', 'source_type', 'currency'].includes(k);
const NAME: Record<string, string> = { title: 'Title', amount: 'Amount', vendor: 'Vendor', expense_date: 'Date', payment_method: 'Payment', status: 'Status',
  notes: 'Notes', tag: 'Tag', due_date: 'Due', fx_rate: 'Rate', comment: 'Note', method: 'Method', reference: 'Reference', paid_on: 'Paid on', role: 'Role', name: 'Name' };
const val = (k: string, v: unknown) => v == null || v === '' ? '—' : k === 'line_items' ? `${(typeof v === 'string' ? JSON.parse(v) : v as unknown[]).length} items` : k === 'status' && typeof v === 'string' && v in LABEL ? LABEL[v as Status] : String(v);
/** Plain-language summary of the change, e.g. "changed the status" + "Status: Submitted → Under review". */
function describe(r: Row): { what: string; lines: string[] } {
  const n = r.new_row ?? {}, o = r.old_row ?? {};
  const noun = { threads: 'expense', payments: 'payment', channel_members: 'member', channels: 'channel' }[r.table_name] ?? r.table_name.replace(/_/g, ' ');
  const what = r.action === 'STATUS' ? 'changed the status' : r.action === 'INSERT' ? (noun === 'payment' ? `recorded a payment` : `added ${noun === 'expense' ? 'an' : 'a'} ${noun}`)
    : r.action === 'DELETE' ? `removed a ${noun}` : `edited the ${noun}`;
  const lines = Object.keys(n).filter(k => !SKIP(k) && String(o[k] ?? '') !== String(n[k] ?? ''))
    .map(k => `${NAME[k] ?? k.replace(/_/g, ' ')}: ${r.old_row && k in o ? `${val(k, o[k])} → ` : ''}${k === 'amount' && n.currency ? money(n[k], n.currency) : val(k, n[k])}`);
  return { what, lines };
}

export default function Audit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { api<Row[]>('GET', `/audit/${id}`).then(setRows).catch(() => {}); }, [id]);

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={r => String(r.id)}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListHeaderComponent={<Text style={{ color: t.muted, fontSize: 13, marginBottom: 4 }}>Every change in this channel, newest first. Entries cannot be edited or deleted.</Text>}
        renderItem={({ item: r }) => {
          const { what, lines } = describe(r);
          const linked = r.table_name === 'threads';
          return (
            <Pressable accessibilityRole={linked ? 'link' : undefined} disabled={!linked} onPress={() => router.push(`/thread/${r.row_id}`)}
              style={({ pressed }) => ({ backgroundColor: pressed ? t.surface : t.card, borderRadius: 14, padding: 14, gap: 6, borderWidth: 1, borderColor: t.border,
                flexDirection: 'row' })}>
              <Avatar name={r.actor ?? 'System'} size={34} />
              <View style={{ flex: 1, gap: 4, marginLeft: 12 }}>
                <Text style={{ color: t.text, fontSize: 14 }}>
                  <Text style={{ fontWeight: '700' }}>{r.actor ?? 'System'}</Text> {what}
                  <Text style={{ color: t.faint }}> · {ago(r.at)}</Text>
                </Text>
                {lines.map(line => <Text key={line} style={{ color: t.muted, fontSize: 13 }}>{line}</Text>)}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={{ color: t.muted }}>No changes recorded yet.</Text>}
      />
    </Screen>
  );
}
