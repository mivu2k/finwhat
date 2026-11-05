import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ReportsCard } from '../../components/ReportsCard';
import { BudgetRow, type Budget } from '../workspace/[id]/budgets';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { DateField, HeroPanel, Skeleton, Bars, Card, Chips, H, Screen, SectionLabel, StatusPill, money, radius, shadow, useTheme, type IconName } from '../../lib/ui';
import type { Status } from '../../lib/workflow';

type WS = { id: string; name: string; channels: { id: string; name: string }[] };
type Dash = { advances_outstanding: number; advances_open: number; spent: number; paid: number; unpaid: number; pending: number; pending_count: number; entries: number; base_currency: string;
  byCategory: { label: string; total: number }[]; byMember: { label: string; total: number }[]; byMonth: { label: string; total: number }[] };
type Entry = { id: string; thread_id: string; entry_date: string; amount: number; currency: string; status: Status;
  channel: { name: string } | null; category: { name: string } | null; payer: { full_name: string | null } | null };
const PAGE = 50;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const range = (p: string): [string, string] => {
  const n = new Date(), y = n.getUTCFullYear(), m = n.getUTCMonth();
  if (p === 'month') return [iso(new Date(Date.UTC(y, m, 1))), ''];
  if (p === 'last') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
  if (p === 'year') return [`${y}-01-01`, ''];
  return ['', ''];
};

export default function Dashboard() {
  const t = useTheme();
  const tr = useT();
  const [wss, setWss] = useState<WS[]>([]);
  const [ws, setWs] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState('');
  const [d, setD] = useState<Dash | null>(null);
  const [rows, setRows] = useState<Entry[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => { api<WS[]>('GET', '/workspaces').then(w => { setWss(w); setWs(id => id ?? w[0]?.id ?? null); }).catch(() => {}); }, []);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [period, setPeriod] = useState('year');
  const { width } = useWindowDimensions();
  const filters = Object.fromEntries(Object.entries({ workspace: ws, channel, from, to }).filter(([, v]) => v)) as Record<string, string>;
  const qs = new URLSearchParams(filters).toString();

  const fetchPage = useCallback(async (offset: number) => {
    const page = await api<Entry[]>('GET', `/ledger?${qs}&offset=${offset}&limit=${PAGE}`).catch(() => []);
    setRows(r => (offset ? [...r, ...page] : page));
    setDone(page.length < PAGE);
  }, [qs]);
  const load = useCallback(() => {
    if (!ws) return;
    api<Dash>('GET', `/dashboard?${qs}`).then(setD).catch(() => {});
    if (ws) api<Budget[]>('GET', `/workspaces/${ws}/budgets`).then(setBudgets).catch(() => {});
    fetchPage(0);
  }, [qs, ws, fetchPage]);
  useEffect(() => { const h = setTimeout(load, 300); return () => clearTimeout(h); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const cur = d?.base_currency ?? 'PKR';
  const fmt = (n: number) => money(n, cur);
  const Stat = ({ label, value, icon, color, sub }: { label: string; value: string; icon: IconName; color: string; sub?: string }) => (
    <View style={{ backgroundColor: t.card, borderRadius: radius.lg, padding: 14, flexGrow: 1, flexBasis: '45%', minWidth: 130, gap: 6, ...shadow(t) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name={icon} size={15} color={color} />
        <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 }}>{label}</Text>
      </View>
      <Text style={{ color: t.text, fontSize: width < 360 ? 15 : 18, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
      {sub ? <Text style={{ color: t.faint, fontSize: 11 }}>{sub}</Text> : null}
    </View>
  );
  const channels = wss.find(w => w.id === ws)?.channels ?? [];

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true }} />
      <FlatList
        data={rows}
        keyExtractor={r => r.id}
        onEndReached={() => !done && fetchPage(rows.length)}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 8 }}>
            {wss.length > 1 && <Chips options={wss.map(w => ({ id: w.id, name: w.name }))} value={ws} onChange={v => { setWs(v); setChannel(null); }} />}
            {channels.length > 1 && <Chips options={channels.map(c => ({ id: c.id, name: `#${c.name}` }))} value={channel} onChange={setChannel} />}
            <Chips scroll value={period} onChange={p => { const v = p ?? 'all'; setPeriod(v); if (v !== 'custom') { const r = range(v); setFrom(r[0]); setTo(r[1]); } }}
              options={[{ id: 'month', name: 'This month' }, { id: 'last', name: 'Last month' }, { id: 'year', name: 'This year' }, { id: 'all', name: 'All time' }, { id: 'custom', name: 'Custom' }]} />
            {period === 'custom' && (
              <Card style={{ gap: 14 }}>
                <DateField optional label={tr('From')} value={from} onChangeText={setFrom} />
                <DateField optional label={tr('To')} value={to} onChangeText={setTo} />
              </Card>
            )}
            {d && (
              <>
                <HeroPanel>
                  <Text style={{ color: t.onHero, fontSize: 13, fontWeight: '600', opacity: 0.92 }}>{tr('Total spent')}</Text>
                  <Text style={{ color: t.onHero, fontSize: width < 360 ? 26 : 32, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] }}>{fmt(d.spent)}</Text>
                  <Text style={{ color: t.onHero, fontSize: 13, opacity: 0.92 }}>{d.entries} approved {d.entries === 1 ? 'entry' : 'entries'}{d.spent > 0 ? ` · ${Math.round((d.paid / d.spent) * 100)}% paid` : ''}</Text>
                  {d.spent > 0 && (
                    <View style={{ height: 8, borderRadius: 4, backgroundColor: '#FFFFFF40', overflow: 'hidden' }}>
                      <View style={{ height: 8, width: `${Math.min(d.paid / d.spent, 1) * 100}%`, backgroundColor: t.onHero }} />
                    </View>
                  )}
                </HeroPanel>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  <Stat icon="checkmark-done" color="#0D9488" label={tr('Paid')} value={fmt(d.paid)} />
                  <Stat icon="time" color="#D97706" label={tr('Unpaid')} value={fmt(d.unpaid)} />
                  {d.advances_open > 0 && <Stat icon="wallet-outline" color="#BA1A1A" label="Advances to account for" value={fmt(d.advances_outstanding)} sub={`${d.advances_open} open`} />}
                  <Stat icon="hourglass" color="#7C3AED" label={tr('Pending approval')} value={fmt(d.pending)} sub={`${d.pending_count} ${d.pending_count === 1 ? 'expense' : 'expenses'}`} />
                </View>
                {d.byCategory.length > 0 && <Card><H>{tr('By category')}</H><Bars rows={d.byCategory} format={fmt} /></Card>}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {d.byMember.length > 0 && <Card style={{ flexGrow: 1, flexBasis: 280 }}><H>{tr('By member')}</H><Bars rows={d.byMember} format={fmt} /></Card>}
                  {d.byMonth.length > 0 && <Card style={{ flexGrow: 1, flexBasis: 280 }}><H>{tr('By month')}</H><Bars rows={d.byMonth} format={fmt} /></Card>}
                </View>
              </>
            )}
            {!d && <Skeleton rows={3} height={100} />}
            {budgets.length > 0 && (
              <Card>
                <H>This month's budgets</H>
                {budgets.map(b => <BudgetRow key={b.id} b={b} />)}
              </Card>
            )}
            <ReportsCard filters={filters} hint="Uses the workspace, channel and dates chosen above." />
            <SectionLabel>{tr('Ledger')}</SectionLabel>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable accessibilityRole="link" onPress={() => router.push(`/thread/${item.thread_id}`)}
            style={({ pressed }) => ({ borderRadius: radius.lg, padding: 14, gap: 6, ...shadow(t), backgroundColor: pressed ? t.surface : t.card })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ color: t.text, fontWeight: '800', fontSize: 15, fontVariant: ['tabular-nums'] }}>{money(item.amount, item.currency)}</Text>
              <StatusPill status={item.status} small />
            </View>
            <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={2}>{[item.entry_date, `#${item.channel?.name}`, item.category?.name, item.payer?.full_name].filter(Boolean).join(' · ')}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={{ color: t.muted }}>—</Text>}
      />
    </Screen>
  );
}
