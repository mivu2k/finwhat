import { useCallback, useState } from 'react';
import { Pressable, SectionList, Text, View } from 'react-native';
import { router, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MODE, api, errMsg } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Alert, Avatar, Button, Chips, Empty, Field, HeroPanel, IconButton, Screen, SectionTitle, Sheet, Skeleton, StatusPill, ago, money, radius, shadow, useTheme } from '../../lib/ui';
import type { Status } from '../../lib/workflow';

type Ch = { parent_id?: string | null; id: string; workspace_id: string; name: string; approval_required: boolean; role: string; pending_count: number; unpaid_count: number;
  last: { title: string; amount: number | null; currency: string; status: Status; at: string } | null };
type WS = { id: string; name: string; role: string; channels: Ch[] };

export default function Channels() {
  const t = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<WS[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [creating, setCreating] = useState<null | { kind: 'workspace' } | { kind: 'join' } | { kind: 'channel'; ws: WS }>(null);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'unpaid'>('all');
  const [wsMenu, setWsMenu] = useState<WS | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<WS[]>('GET', '/workspaces')); } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setLoaded(true);
  }, [tr]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function create() {
    if (!creating || !name.trim()) return;
    if (creating.kind === 'join') { const code = name.trim(); setCreating(null); setName(''); return router.push(`/invite/${encodeURIComponent(code)}`); }
    try {
      if (creating.kind === 'workspace') await api('POST', '/workspaces', { name: name.trim() });
      else await api('POST', `/workspaces/${creating.ws.id}/channels`, { name: name.trim() });
      setCreating(null); setName(''); load();
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  const all = data.flatMap(w => w.channels);
  const waiting = data.flatMap(w => w.channels).filter(c => c.role === 'owner' || c.role === 'approver').reduce((n, c) => n + Number(c.pending_count || 0), 0);
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingHorizontal: 20, paddingTop: insets.top + 12, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, flex: 1 }}>ExpenseChat<Text style={{ color: t.primary }}>.</Text></Text>
        <IconButton name="add" color={t.onHero} bg={t.primary} label="New workspace, channel or join" onPress={() => setSheet(true)} />
      </View>
      {creating && (
        <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 14, gap: 10, backgroundColor: t.card, borderRadius: 20 }}>
          <Text style={{ color: t.text, fontWeight: '800' }}>
            {creating.kind === 'workspace' ? tr('New workspace') : creating.kind === 'join' ? 'Join with a code' : `${tr('New channel')} · ${creating.ws.name}`}
          </Text>
          <Field autoFocus placeholder={creating.kind === 'workspace' ? 'Organization name' : creating.kind === 'join' ? 'Invite code' : 'e.g. Site expenses'} autoCapitalize={creating.kind === 'join' ? 'characters' : 'sentences'} value={name} onChangeText={setName} onSubmitEditing={create} />
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
            <Button kind="text" small title={tr('Cancel')} onPress={() => { setCreating(null); setName(''); }} />
            <Button small title={creating.kind === 'join' ? 'Continue' : tr('Add')} disabled={!name.trim()} onPress={create} />
          </View>
        </View>
      )}
      <SectionList
        sections={data.map(w => {
          const shown = w.channels.filter(c => filter === 'all' || (filter === 'pending' ? Number(c.pending_count) > 0 : Number(c.unpaid_count) > 0));
          const has = new Set(shown.map(c => c.id));
          // each sub-channel directly under its parent (at top level if the parent isn't visible to this person)
          return { ws: w, data: shown.filter(c => !c.parent_id || !has.has(c.parent_id)).flatMap(c => [c, ...shown.filter(x => x.parent_id === c.id)]) };
        })}
        keyExtractor={c => c.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: 16, gap: 14 }}>
            <HeroPanel>
              <Pressable accessibilityRole="link" disabled={!waiting} onPress={() => router.push('/search')} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: t.onHero, fontSize: 13, fontWeight: '600', opacity: 0.9 }}>{waiting ? 'Waiting for your approval' : 'Nothing waiting for you'}</Text>
                  <Text style={{ color: t.onHero, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 }}>{waiting} {waiting === 1 ? 'expense' : 'expenses'}</Text>
                </View>
                {waiting > 0 && <Ionicons name="chevron-forward-circle" size={30} color={t.onHero} />}
              </Pressable>
              <Pressable accessibilityRole="search" accessibilityLabel="Search expenses" onPress={() => router.push('/search')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.card, borderRadius: radius.md, paddingHorizontal: 14, height: 48 }}>
                <Ionicons name="search" size={20} color={t.muted} />
                <Text style={{ color: t.faint, flex: 1 }} numberOfLines={1}>Search vendors, notes, transcripts…</Text>
                <Ionicons name="options-outline" size={20} color={t.primary} />
              </Pressable>
            </HeroPanel>
            <Chips value={filter} onChange={f => setFilter(f ?? 'all')} options={[{ id: 'all', name: 'All' },
              { id: 'pending', name: `Pending (${all.reduce((n, c) => n + Number(c.pending_count || 0), 0)})` }, { id: 'unpaid', name: `Unpaid (${all.reduce((n, c) => n + Number(c.unpaid_count || 0), 0)})` }]} />
          </View>
        }
        renderSectionHeader={({ section: { ws, data: rows } }) => (
          <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
            <SectionTitle title={ws.name} count={rows.length} right={<IconButton name="ellipsis-horizontal" size={20} color={t.muted} label={`${ws.name} options`} onPress={() => setWsMenu(ws)} />} />
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="link" accessibilityLabel={`Open channel ${item.name}`} onPress={() => router.push(`/channel/${item.id}`)}
            style={({ pressed }) => ({ flexDirection: 'row', gap: 14, alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12,
              marginHorizontal: 16, marginLeft: item.parent_id ? 40 : 16, marginBottom: 8, borderRadius: radius.lg, ...shadow(t), backgroundColor: pressed ? t.surface : t.card })}>
            <Avatar name={item.name} size={item.parent_id ? 40 : 52} />
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '700', flex: 1 }} numberOfLines={1}>{item.parent_id ? '↳ ' : '# '}{item.name}</Text>
                {item.last && <Text style={{ color: item.pending_count ? t.primary : t.faint, fontSize: 12, fontWeight: '600' }}>{ago(item.last.at)}</Text>}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: t.muted, fontSize: 14, flex: 1 }} numberOfLines={1}>
                  {item.last ? (item.last.amount != null ? `${item.last.title} · ${money(item.last.amount, item.last.currency)}` : `${item.last.title} · no amount yet`) : tr('No expenses yet.')}
                </Text>
                {item.pending_count > 0 ? (
                  <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
                    <Text style={{ color: t.primaryText, fontSize: 12, fontWeight: '800' }}>{item.pending_count}</Text>
                  </View>
                ) : item.last ? <StatusPill status={item.last.status} small /> : null}
              </View>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={loaded ? (
          <View style={{ gap: 16, paddingHorizontal: 20 }}>
            <Empty icon="chatbubbles-outline" title="No channels yet" hint="Create a workspace for your organization, or ask a channel owner to add you." />
            <Button icon="business-outline" title={tr('Create workspace')} onPress={() => setCreating({ kind: 'workspace' })} />
            <Button kind="ghost" icon="enter-outline" title="Join with a code" onPress={() => setCreating({ kind: 'join' })} />
          </View>
        ) : <Skeleton rows={3} />}
      />
      <Sheet visible={!!wsMenu} onClose={() => setWsMenu(null)} title={wsMenu?.name ?? ''} options={wsMenu ? [
        { icon: 'add-circle-outline', label: tr('New channel'), onPress: () => setCreating({ kind: 'channel', ws: wsMenu }) },
        { icon: 'pricetags-outline', label: 'Categories', onPress: () => router.push(`/workspace/${wsMenu.id}/categories`) },
        { icon: 'speedometer-outline', label: 'Budgets', onPress: () => router.push(`/workspace/${wsMenu.id}/budgets`) },
        ...(MODE === 'server' && wsMenu.role === 'admin' ? [{ icon: 'sparkles-outline' as const, label: 'AI settings', hint: 'Cloud API or your own local AI', onPress: () => router.push(`/workspace/${wsMenu.id}/ai`) }] : []),
      ] : []} />
      <Sheet visible={sheet} onClose={() => setSheet(false)} title="Create" options={[
        ...data.map(w => ({ icon: 'chatbubble-ellipses-outline' as const, label: `${tr('New channel')} in ${w.name}`, onPress: () => setCreating({ kind: 'channel', ws: w }) })),
        { icon: 'enter-outline', label: 'Join with a code', hint: 'You were given an invite code', onPress: () => setCreating({ kind: 'join' }) },
        { icon: 'business-outline', label: tr('New workspace'), hint: 'A separate organization with its own categories', color: t.accent, onPress: () => setCreating({ kind: 'workspace' }) },
      ]} />
    </Screen>
  );
}
