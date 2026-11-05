import { useCallback, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../../lib/api';
import { Alert, Empty, IconButton, Screen, confirmAsync, money, radius, useTheme } from '../../../lib/ui';

type Rec = { id: string; title: string | null; data: any; day_of_month: number; next_run: string; by_name: string };

export default function Recurring() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [rows, setRows] = useState<Rec[]>([]);
  const load = useCallback(() => { api<Rec[]>('GET', `/channels/${id}/recurring`).then(setRows).catch(e => Alert.alert('Error', errMsg(e))); }, [id]);
  useFocusEffect(load);
  async function stop(r: Rec) {
    if (!(await confirmAsync('Stop repeating', `Stop creating "${r.title ?? 'this expense'}" each month? Expenses already created stay.`, 'Stop', 'Cancel'))) return;
    try { await api('DELETE', `/channels/${id}/recurring/${r.id}`); load(); } catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  return (
    <Screen>
      <FlatList data={rows} keyExtractor={r => r.id} contentContainerStyle={{ padding: 16, gap: 8 }}
        ListEmptyComponent={<Empty icon="repeat-outline" title="Nothing repeats yet" hint="In the new-expense form, fill it in and tap Repeat monthly." />}
        renderItem={({ item: r }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.card, borderRadius: radius.md, paddingLeft: 16, paddingRight: 4, paddingVertical: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{r.title ?? 'Expense'}</Text>
              <Text style={{ color: t.text }}>{money(r.data?.amount ?? null, r.data?.currency ?? '')}</Text>
              <Text style={{ color: t.muted, fontSize: 13 }}>Day {r.day_of_month} of each month · next {String(r.next_run).slice(0, 10)} · {r.by_name}</Text>
            </View>
            <IconButton name="trash-outline" color={t.danger} label={`Stop ${r.title ?? 'expense'}`} onPress={() => stop(r)} />
          </View>
        )} />
    </Screen>
  );
}
