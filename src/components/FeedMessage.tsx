import { Image, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { Thread } from '../lib/api';
import { Avatar, shadow, StatusPill, ago, money, radius, useTheme } from '../lib/ui';
import { VoicePlayer } from './VoicePlayer';

const time = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One expense in the channel stream, Discord-style: it reads like a message (author, time, what they posted),
 * and the bar under it is its thread. Tapping anywhere opens the thread.
 */
export function FeedMessage({ item, grouped }: { item: Thread; grouped?: boolean }) {
  const t = useTheme();
  const open = () => router.push(`/thread/${item.id}`);
  const replies = Number(item.reply_count ?? 0);
  const name = item.author?.full_name ?? '?';
  const title = item.title || item.vendor || (item.source_type === 'voice' ? 'Voice note' : item.source_type === 'photo' ? 'Receipt photo' : 'Untitled expense');
  const facts = [item.vendor !== title ? item.vendor : null, item.category?.name, item.expense_date,
    item.line_items?.length ? `${item.line_items.length} items` : null].filter(Boolean).join(' · ');
  const filled = item.amount != null;

  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${name} posted ${title}, ${replies} replies. Open thread`} onPress={open}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: grouped ? 4 : 14, paddingBottom: 6,
        backgroundColor: pressed || hovered ? t.surface : 'transparent' })}>
      <View style={{ width: 40 }}>{!grouped && <Avatar name={name} size={40} />}</View>
      <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
        {!grouped && (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{name}</Text>
            <Text style={{ color: t.faint, fontSize: 12 }}>{time(item.created_at)}</Text>
          </View>
        )}

        {/* what they posted: photo / voice note as a message, then the expense as an embed card */}
        {item.preview?.type === 'image' && (
          <Image source={{ uri: item.preview.url }} accessibilityLabel={`Receipt photo for ${title}`}
            style={{ width: '100%', maxWidth: 320, aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: t.surface }} resizeMode="cover" />
        )}
        {item.preview?.type === 'voice' && (
          <View style={{ maxWidth: 360, borderRadius: radius.lg, padding: 10, ...shadow(t) }}>
            <VoicePlayer url={item.preview.url} mine={false} />
          </View>
        )}
        {item.transcript ? <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }} numberOfLines={3}>“{item.transcript}”</Text> : null}
        {item.preview?.type === 'file' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 320, backgroundColor: t.card, borderRadius: radius.md, padding: 10, borderWidth: 1, borderColor: t.border }}>
            <Ionicons name="document-text" size={22} color={t.danger} />
            <Text style={{ color: t.text, fontWeight: '600' }}>PDF receipt</Text>
          </View>
        )}

        <View style={{ flexDirection: 'row', maxWidth: 440, borderRadius: radius.lg, ...shadow(t) }}>
          <View style={{ flex: 1, padding: 14, gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 15, flex: 1 }} numberOfLines={2}>{title}</Text>
              <StatusPill status={item.status} small advance={item.kind === 'advance'} />
            </View>
            {filled
              ? <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3, fontVariant: ['tabular-nums'] }}>{money(item.amount, item.currency)}</Text>
              : <Text style={{ color: t.muted, fontSize: 13 }}>No amount yet: open to fill in the details</Text>}
            {item.kind === 'advance' && (
              <Text style={{ color: t.primary, fontSize: 13, fontWeight: '700' }}>
                Advance{item.holder?.full_name ? ` to ${item.holder.full_name}` : ''} · {money(Number(item.accounted ?? 0), item.currency)} accounted for
              </Text>
            )}
            {facts ? <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>{facts}</Text> : null}
          </View>
        </View>

        {/* the thread bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 440, minHeight: 36 }}>
          <Ionicons name="return-down-forward" size={16} color={replies ? t.primary : t.faint} />
          {replies ? (
            <Text style={{ flex: 1, fontSize: 13, color: t.muted }} numberOfLines={1}>
              <Text style={{ color: t.primary, fontWeight: '700' }}>{replies} {replies === 1 ? 'reply' : 'replies'}</Text>
              {item.last_reply ? <Text>  {item.last_reply.author.split(' ')[0]}: {item.last_reply.body}</Text> : null}
            </Text>
          ) : <Text style={{ flex: 1, fontSize: 13, color: t.faint }}>Open thread</Text>}
          {item.last_activity ? <Text style={{ color: t.faint, fontSize: 12 }}>{ago(item.last_activity)}</Text> : null}
          <Ionicons name="chevron-forward" size={14} color={t.faint} />
        </View>
      </View>
    </Pressable>
  );
}
