import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api, errMsg, type Thread } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { LABEL, type Status } from '../../lib/workflow';
import { Skeleton, Alert, Button, Chips, Empty, Field, Screen, confirmAsync, useTheme, type IconName } from '../../lib/ui';
import { Ionicons } from '@expo/vector-icons';
import { ThreadRow } from '../../components/ThreadRow';

const VIEWS = [['awaiting_me', 'Awaiting my approval', 'hourglass-outline'], ['mine_unpaid', 'My unpaid', 'time-outline'], ['overdue', 'Overdue', 'alarm-outline'],
  ['advances', 'Open advances', 'wallet-outline'], ['closed_month', 'Closed this month', 'lock-closed-outline'], ['drafts', 'My drafts', 'create-outline']] as const;
type View_ = (typeof VIEWS)[number][0];
const PAGE = 30;

export default function Search() {
  const t = useTheme();
  const tr = useT();
  const [view, setView] = useState<View_ | null>('awaiting_me');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [more, setMore] = useState(false);
  const [rows, setRows] = useState<Thread[]>([]);
  const [done, setDone] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const selecting = view === 'awaiting_me';
  const toggle = (id: string) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  async function bulk() {
    if (!(await confirmAsync('Approve expenses', `Approve ${selected.length} ${selected.length === 1 ? 'expense' : 'expenses'}?`, 'Approve', 'Cancel'))) return;
    setBusy(true);
    try {
      const { results } = await api<{ results: { id: string; ok: boolean; error?: string }[] }>('POST', '/threads/bulk-transition', { ids: selected, to: 'approved' });
      const failed = results.filter(r => !r.ok);
      if (failed.length) Alert.alert(`${results.length - failed.length} approved, ${failed.length} not`, [...new Set(failed.map(f => f.error))].join('\n'));
      setSelected([]); fetchPage(0);
    } catch (e) { Alert.alert('Error', errMsg(e)); }
    setBusy(false);
  }

  const params = new URLSearchParams(Object.entries({ view, q: q.trim(), status, from, to, min, max })
    .filter(([, v]) => v) as [string, string][]).toString();
  const fetchPage = useCallback(async (offset: number) => {
    const page = await api<Thread[]>('GET', `/search?${params}&offset=${offset}&limit=${PAGE}`).catch(() => []);
    setRows(r => (offset ? [...r, ...page] : page));
    setDone(page.length < PAGE);
    setLoaded(true);
  }, [params]);
  useEffect(() => { const h = setTimeout(() => fetchPage(0), 250); return () => clearTimeout(h); }, [fetchPage]);
  useFocusEffect(useCallback(() => { fetchPage(0); }, [fetchPage]));

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={r => r.id}
        onEndReached={() => !done && fetchPage(rows.length)}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 12 }}>
            <Field icon="search" placeholder={tr('Search vendors, notes, transcripts')} value={q} onChangeText={setQ} />
            <Chips scroll options={VIEWS.map(([id, name, icon]) => ({ id, name: tr(name), icon: icon as IconName }))} value={view} onChange={setView} />
            <Pressable accessibilityRole="button" onPress={() => setMore(!more)} hitSlop={8}>
              <Text style={{ color: t.primary, fontWeight: '700' }}>{more ? '−' : '+'} Filters</Text>
            </Pressable>
            {more && (
              <View style={{ gap: 8 }}>
                <Chips options={(Object.keys(LABEL) as Status[]).map(s => ({ id: s, name: tr(LABEL[s]) }))} value={status} onChange={setStatus} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}><Field label={tr('From')} placeholder="YYYY-MM-DD" value={from} onChangeText={setFrom} /></View>
                  <View style={{ flex: 1 }}><Field label={tr('To')} placeholder="YYYY-MM-DD" value={to} onChangeText={setTo} /></View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}><Field label="Min" value={min} onChangeText={setMin} keyboardType="decimal-pad" /></View>
                  <View style={{ flex: 1 }}><Field label="Max" value={max} onChangeText={setMax} keyboardType="decimal-pad" /></View>
                </View>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => !selecting ? <ThreadRow item={item} showChannel /> : (
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.card }}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(item.id) }} accessibilityLabel={`Select ${item.title ?? item.vendor ?? 'expense'}`}
              onPress={() => toggle(item.id)} style={{ width: 48, minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={selected.includes(item.id) ? 'checkbox' : 'square-outline'} size={24} color={selected.includes(item.id) ? t.primary : t.muted} />
            </Pressable>
            <View style={{ flex: 1 }}><ThreadRow item={item} showChannel /></View>
          </View>
        )}
        ListEmptyComponent={!loaded ? <Skeleton /> : <Empty icon="search-outline" title="Nothing here" hint="Try another view or search term." />}
      />
      {selecting && selected.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 8, padding: 12, backgroundColor: t.container }}>
          <Button kind="ghost" title="Clear" onPress={() => setSelected([])} />
          <Button style={{ flex: 1 }} icon="checkmark-done" busy={busy} title={`Approve ${selected.length}`} onPress={bulk} />
        </View>
      )}
    </Screen>
  );
}
