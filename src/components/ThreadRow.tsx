import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Thread } from '../lib/api';
import { Avatar, StatusPill, ago, money, radius, shadow, useTheme } from '../lib/ui';

/** One record in a list. Two short lines that hold up at 320px wide: what and how much, then status and who. */
export function ThreadRow({ item, showChannel }: { item: Thread; showChannel?: boolean }) {
  const t = useTheme();
  const replies = Number(item.reply_count ?? 0);
  const who = [showChannel && item.channel ? `#${item.channel.name}` : null, item.author?.full_name?.split(' ')[0], ago(item.created_at), replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null].filter(Boolean).join(' · ');
  return (
    <Pressable accessibilityRole="link" onPress={() => router.push(`/thread/${item.id}`)}
      style={({ pressed }) => ({ flexDirection: 'row', gap: 12, padding: 14, marginBottom: 8, borderRadius: radius.lg, ...shadow(t), backgroundColor: pressed ? t.surface : t.card })}>
      <Avatar name={item.author?.full_name ?? '?'} size={36} />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 15, flex: 1, minWidth: 0 }} numberOfLines={2}>
            {item.title || item.vendor || (item.source_type === 'voice' ? 'Voice note' : item.source_type === 'photo' ? 'Receipt photo' : 'Untitled expense')}
          </Text>
          <Text style={{ color: item.amount != null ? t.text : t.faint, fontWeight: item.amount != null ? '800' : '400', fontSize: item.amount != null ? 14 : 12, fontVariant: ['tabular-nums'] }}>
            {item.amount != null ? money(item.amount, item.currency) : 'No amount'}
          </Text>
        </View>
        <StatusPill status={item.status} small advance={item.kind === 'advance'} />
        <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>{who}</Text>
      </View>
    </Pressable>
  );
}
