import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Empty, Screen, ago, radius, useTheme, type IconName } from '../../lib/ui';

type N = { id: number; thread_id: string | null; kind: string; body: string; read_at: string | null; created_at: string };
const KIND: Record<string, { icon: IconName; color: string }> = {
  mention: { icon: 'at', color: '#2563EB' }, approval_request: { icon: 'checkmark-done', color: '#7C3AED' },
  status: { icon: 'swap-horizontal', color: '#0E9F6E' }, comment: { icon: 'chatbubble', color: '#0891B2' }, overdue: { icon: 'alarm', color: '#E11D48' },
};

export default function Alerts() {
  const t = useTheme();
  const tr = useT();
  const [items, setItems] = useState<N[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => { api<{ items: N[] }>('GET', '/notifications').then(r => setItems(r.items)).catch(() => {}).finally(() => setLoaded(true)); }, []);
  useFocusEffect(load);

  async function open(n: N) {
    if (!n.read_at) api('POST', '/notifications/read', { ids: [n.id] }).then(load).catch(() => {});
    if (n.thread_id) router.push(`/thread/${n.thread_id}`);
  }

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={n => String(n.id)}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListHeaderComponent={items.some(n => !n.read_at)
          ? <View style={{ alignItems: 'flex-end' }}><Button small kind="text" icon="checkmark-done" title={tr('Mark all read')} onPress={() => api('POST', '/notifications/read', {}).then(load)} /></View>
          : undefined}
        renderItem={({ item: n }) => {
          const k = KIND[n.kind] ?? { icon: 'notifications' as IconName, color: t.muted };
          return (
            <Pressable accessibilityRole="link" onPress={() => open(n)}
              style={({ pressed }) => ({ backgroundColor: n.read_at ? 'transparent' : t.card, borderRadius: radius.lg, padding: 14, flexDirection: 'row', gap: 12,
                alignItems: 'center', opacity: pressed ? 0.8 : 1 })}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: k.color + '1F', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={k.icon} size={20} color={k.color} />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: t.text, fontWeight: n.read_at ? '400' : '700', lineHeight: 20 }} numberOfLines={3}>{n.body}</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>{ago(n.created_at)}</Text>
              </View>
              {!n.read_at && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.primary }} />}
            </Pressable>
          );
        }}
        ListEmptyComponent={loaded ? <Empty icon="notifications-outline" title={tr('No notifications.')} hint="Mentions, approval requests and status changes show up here." /> : undefined}
      />
    </Screen>
  );
}
