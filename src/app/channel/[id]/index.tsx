import { useCallback, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { api, errMsg, send, uploadFile, uuid, type Thread } from '../../../lib/api';
import { useChannel } from '../../../lib/useChannel';
import { useT } from '../../../lib/i18n';
import { isApprover, type Status } from '../../../lib/workflow';
import { Button, Field, Skeleton, Alert, Chips, Empty, IconButton, Screen, Sheet, useTheme } from '../../../lib/ui';
import { FeedMessage } from '../../../components/FeedMessage';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PAGE = 30;
function dayLabel(s: string) {
  const d = new Date(s.replace(' ', 'T') + 'Z'), today = new Date();
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
const FILTERS: { id: 'open' | 'pending' | 'unpaid' | 'done'; name: string; statuses: Status[] }[] = [
  { id: 'open', name: 'Open', statuses: ['draft', 'submitted', 'under_review', 'needs_info', 'approved', 'unpaid'] },
  { id: 'pending', name: 'Pending', statuses: ['submitted', 'under_review'] },
  { id: 'unpaid', name: 'Unpaid', statuses: ['approved', 'unpaid'] },
  { id: 'done', name: 'Done', statuses: ['paid', 'closed', 'rejected'] },
];

export default function ChannelThreads() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const { channel, role } = useChannel(id);
  const [rows, setRows] = useState<Thread[]>([]);
  const [done, setDone] = useState(false);
  const [photoSheet, setPhotoSheet] = useState(false);
  const [menu, setMenu] = useState(false);
  const [subName, setSubName] = useState<string | null>(null);
  async function addSub() {
    if (!channel || !subName?.trim()) return;
    try { const r = await api('POST', `/workspaces/${channel.workspace_id}/channels`, { name: subName.trim(), parent_id: id }); setSubName(null); router.push(`/channel/${r.id}`); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id'] | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchPage = useCallback(async (from: number) => {
    const page = await api<Thread[]>('GET', `/channels/${id}/threads?offset=${from}&limit=${PAGE}`).catch(() => []);
    setRows(r => (from === 0 ? (JSON.stringify(r.slice(0, page.length)) === JSON.stringify(page) && r.length === page.length ? r : page) : [...r, ...page]));
    setLoaded(true);
    setDone(page.length < PAGE);
  }, [id]);
  // ponytail: list refreshes on focus; add polling/WebSocket push if live channel updates matter.
  useFocusEffect(useCallback(() => { fetchPage(0); }, [fetchPage]));

  /** Photo/PDF capture: thread is created as a Draft, files attached, then "Convert to form" runs inside the thread. */
  async function capture(source: 'camera' | 'gallery' | 'file') {
    let files: { uri: string; name: string; mime: string }[] = [];
    if (source === 'file') {
      const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], multiple: true });
      if (r.canceled) return;
      files = r.assets.map(a => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/pdf' }));
    } else {
      if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return Alert.alert(tr('Error'), 'Camera permission denied');
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: source === 'gallery' };
      const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      if (r.canceled) return;
      files = r.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `receipt-${Date.now()}-${i}.jpg`, mime: a.mimeType ?? 'image/jpeg' }));
    }
    setBusy(true);
    try {
      const threadId = uuid();
      const created = await send('POST', `/channels/${id}/threads`, { id: threadId, source_type: 'photo' });
      let queued = created.queued;
      for (const f of files) queued = (await uploadFile(threadId, f.uri, f.name, f.mime)).queued || queued;
      if (queued) Alert.alert(tr('Offline: will sync when back online'));
      else router.push(`/thread/${threadId}`);
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false);
  }

  const shown = filter ? rows.filter(r => FILTERS.find(f => f.id === filter)!.statuses.includes(r.status)) : rows;
  const canCreate = role && role !== 'viewer';
  return (
    <Screen>
      <Stack.Screen options={{ title: channel ? `# ${channel.name}` : '', headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <IconButton name="bar-chart-outline" label="Channel reports" onPress={() => router.push(`/channel/${id}/reports`)} />
          <IconButton name="ellipsis-vertical" label="More" onPress={() => setMenu(true)} />
        </View>) }} />
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.card }}>
        <Chips scroll options={FILTERS} value={filter} onChange={setFilter} />
        {channel?.my_scope && channel.my_scope !== 'all' && (
          <Text style={{ color: t.muted, fontSize: 12, paddingTop: 8 }}>{channel.my_scope === 'own' ? 'You see only your own records here.' : 'You see your own records and those of the people assigned to you.'}</Text>
        )}
        {!!channel?.subchannels?.length && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 10 }}>
            {channel.subchannels.map(c => (
              <Pressable key={c.id} accessibilityRole="link" onPress={() => router.push(`/channel/${c.id}`)}
                style={{ minHeight: 36, paddingHorizontal: 12, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: t.primarySoft }}>
                <Ionicons name="return-down-forward" size={14} color={t.primaryDark} />
                <Text style={{ color: t.primaryDark, fontWeight: '600', fontSize: 13 }}>{c.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        {subName !== null && (
          <View style={{ gap: 8, paddingTop: 10 }}>
            <Field autoFocus label="Sub-channel name" placeholder="Lahore site" value={subName} onChangeText={setSubName} onSubmitEditing={addSub} />
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
              <Button small kind="ghost" title="Cancel" onPress={() => setSubName(null)} />
              <Button small title="Create" disabled={!subName.trim()} onPress={addSub} />
            </View>
          </View>
        )}
      </View>
      <FlatList
        inverted // chat order: newest at the bottom, scroll up for older
        data={shown}
        keyExtractor={r => r.id}
        onEndReached={() => !done && fetchPage(rows.length)}
        contentContainerStyle={{ paddingVertical: 12 }}
        renderItem={({ item, index }) => {
          const older = shown[index + 1]; // inverted: next item is the older one
          const day = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toDateString();
          const newDay = !older || day(older.created_at) !== day(item.created_at);
          const grouped = !newDay && older.created_by === item.created_by
            && Math.abs(new Date(item.created_at.replace(' ', 'T') + 'Z').getTime() - new Date(older.created_at.replace(' ', 'T') + 'Z').getTime()) < 10 * 60e3;
          return (
            <View>
              {newDay && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, marginTop: 16, marginBottom: 2 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
                  <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>{dayLabel(item.created_at)}</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
                </View>
              )}
              <FeedMessage item={item} grouped={grouped} />
            </View>
          );
        }}
        ListEmptyComponent={!loaded ? <Skeleton rows={3} height={120} /> : <View style={{ transform: [{ scaleY: -1 }] }}><Empty icon="receipt-outline" title={tr('No expenses yet.')} hint="Post the first one below: fill a form, record a voice note or snap a receipt." /></View>}
      />
      {canCreate ? (
        <View style={{ flexDirection: 'row', gap: 8, padding: 10, paddingBottom: 14 + insets.bottom, backgroundColor: t.card, borderTopWidth: 1, borderColor: t.border }}>
          {([['document-text-outline', 'Form', t.primary, () => router.push(`/channel/${id}/new`)],
            ['mic-outline', 'Voice', t.primary, () => router.push(`/channel/${id}/voice`)],
            ['camera-outline', 'Photo', t.primary, () => setPhotoSheet(true)],
            ['wallet-outline', 'Advance', t.primary, () => router.push(`/channel/${id}/new?kind=advance`)]] as const).map(([icon, label, color, go]) => (
            <Pressable key={label} accessibilityRole="button" accessibilityLabel={label === 'Advance' ? 'New advance' : `New expense by ${label.toLowerCase()}`} disabled={busy} onPress={go}
              style={({ pressed }) => ({ flex: 1, minHeight: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 2,
                backgroundColor: pressed ? t.border : t.surface, opacity: busy ? 0.5 : 1 })}>
              <Ionicons name={icon} size={20} color={color} />
              <Text style={{ color: t.text, fontWeight: '600', fontSize: 12 }}>{tr(label)}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={{ padding: 14, paddingBottom: 14 + insets.bottom, backgroundColor: t.card, borderTopWidth: 1, borderColor: t.border }}>
          <Text style={{ color: t.muted, textAlign: 'center' }}>You can read this channel but not post in it.</Text>
        </View>
      )}
      <Sheet visible={menu} onClose={() => setMenu(false)} title={channel ? `# ${channel.name}` : ''} options={[
        { icon: 'bar-chart-outline', label: 'Reports', hint: 'PDF and Excel for this channel', onPress: () => router.push(`/channel/${id}/reports`) },
        { icon: 'people-outline', label: tr('Members'), hint: 'Invites, limits, delegation', onPress: () => router.push(`/channel/${id}/members`) },
        { icon: 'repeat-outline', label: 'Recurring expenses', onPress: () => router.push(`/channel/${id}/recurring`) },
        ...(isApprover(role) ? [{ icon: 'shield-checkmark-outline' as const, label: tr('Audit log'), onPress: () => router.push(`/channel/${id}/audit`) }] : []),
        ...(role === 'owner' && channel && !channel.parent_id ? [{ icon: 'git-branch-outline' as const, label: 'New sub-channel', hint: 'Starts with the same members', onPress: () => setSubName('') }] : []),
        ...(role === 'owner' ? [{ icon: 'settings-outline' as const, label: tr('Settings'), onPress: () => router.push(`/channel/${id}/settings`) }] : []),
      ]} />
      <Sheet visible={photoSheet} onClose={() => setPhotoSheet(false)} title={tr('Photo')} options={[
        ...(Platform.OS !== 'web' ? [{ icon: 'camera-outline' as const, label: tr('Camera'), onPress: () => capture('camera') }] : []),
        { icon: 'images-outline', label: tr('Gallery'), hint: 'Pick one or more images', onPress: () => capture('gallery') },
        { icon: 'document-attach-outline', label: tr('PDF / file'), hint: 'Invoices as PDF', onPress: () => capture('file') },
      ]} />
    </Screen>
  );
}
