import { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../../lib/api';
import { Alert, Button, Chips, Empty, Field, IconButton, Screen, amountText, confirmAsync, radius, useTheme } from '../../../lib/ui';

export type Budget = { id: string; scope: string; target: string; label: string; amount: number; spent: number };

export default function Budgets() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [rows, setRows] = useState<Budget[]>([]);
  const [admin, setAdmin] = useState(false);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [chans, setChans] = useState<{ id: string; name: string }[]>([]);
  const [scope, setScope] = useState<string>('category');
  const [target, setTarget] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const [amount, setAmount] = useState('');
  const load = useCallback(() => api<Budget[]>('GET', `/workspaces/${id}/budgets`).then(setRows).catch(() => {}), [id]);
  useEffect(() => {
    load();
    api('GET', `/workspaces/${id}/categories`).then(setCats).catch(() => {});
    api<any[]>('GET', '/workspaces').then(w => { const me = w.find(x => x.id === id); setAdmin(me?.role === 'admin'); setChans(me?.channels ?? []); }).catch(() => {});
  }, [id, load]);
  const value = scope === 'tag' ? tag.trim() : target;
  async function add() {
    try { await api('POST', `/workspaces/${id}/budgets`, { scope, target: value, amount: Number(amount.replace(/,/g, '')) }); setAmount(''); setTag(''); setTarget(null); load(); }
    catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  async function remove(b: Budget) {
    if (!(await confirmAsync('Delete budget', `Delete the budget for ${b.label}?`, 'Delete', 'Cancel'))) return;
    try { await api('DELETE', `/workspaces/${id}/budgets/${b.id}`); load(); } catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  return (
    <Screen>
      <FlatList data={rows} keyExtractor={b => b.id} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 48 }}
        ListHeaderComponent={admin ? (
          <View style={{ gap: 12, marginBottom: 12 }}>
            <Chips label="Monthly budget for" value={scope} onChange={s => { if (s) { setScope(s); setTarget(null); } }}
              options={[{ id: 'category', name: 'Category' }, { id: 'channel', name: 'Channel' }, { id: 'tag', name: 'Project' }]} />
            {scope === 'tag' ? <Field label="Project tag" placeholder="Same text as the expense's project tag" value={tag} onChangeText={setTag} />
              : <Chips value={target} onChange={setTarget} options={scope === 'category' ? cats : chans.map(c => ({ id: c.id, name: `#${c.name}` }))} />}
            <Field label="Amount per month" placeholder="0.00" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
            <Button icon="add" title="Add budget" disabled={!value || !(Number(amount.replace(/,/g, '')) > 0)} onPress={add} />
          </View>
        ) : <Text style={{ color: t.muted, marginBottom: 8 }}>Only a workspace admin can change budgets.</Text>}
        ListEmptyComponent={<Empty icon="speedometer-outline" title="No budgets yet" hint="You'll be alerted at 80% and when a budget is exceeded." />}
        renderItem={({ item: b }) => <BudgetRow b={b} onRemove={admin ? () => remove(b) : undefined} />} />
    </Screen>
  );
}

export function BudgetRow({ b, onRemove }: { b: Budget; onRemove?: () => void }) {
  const t = useTheme();
  const pct = b.amount ? b.spent / b.amount : 0;
  const color = pct > 1 ? t.danger : pct >= 0.8 ? t.warn : t.primary;
  return (
    <View style={{ backgroundColor: t.card, borderRadius: radius.md, padding: 14, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: t.text, fontWeight: '700', flex: 1 }} numberOfLines={1}>{b.label}</Text>
        <Text style={{ color: t.text, fontSize: 13, fontVariant: ['tabular-nums'] }}>{amountText(b.spent)} / {amountText(b.amount)}</Text>
        {onRemove && <IconButton name="trash-outline" size={18} color={t.danger} label={`Delete budget ${b.label}`} onPress={onRemove} />}
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surface, overflow: 'hidden' }}>
        <View style={{ height: 8, width: `${Math.min(pct, 1) * 100}%`, backgroundColor: color }} />
      </View>
    </View>
  );
}
