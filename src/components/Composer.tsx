import { useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, Text, TextInput, View, type TextInputKeyPressEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, IconButton, radius, useTheme } from '../lib/ui';

export type Mentionable = { id: string; name: string; email: string };
/** The handle the server matches: first name, else the email's local part (see POST /threads/:id/messages). */
export const handle = (m: Mentionable) => (m.name.split(' ')[0] || m.email.split('@')[0]).replace(/[^\p{L}\w.-]/gu, '');

/** "Hi @Ali, see this" → Text with the @mentions highlighted. */
export function MentionText({ body, style }: { body: string; style: object }) {
  const t = useTheme();
  return (
    <Text style={style}>
      {body.split(/(@[\p{L}\w.-]+)/u).map((part, i) =>
        part.startsWith('@') ? <Text key={i} style={{ color: t.primary, fontWeight: '700', backgroundColor: t.primarySoft }}>{part}</Text> : part)}
    </Text>
  );
}

/** Reply box: grows with the text, @ suggests channel members, Enter sends on web (Shift+Enter = new line). */
export function Composer({ value, onChange, onSend, onAttach, members, placeholder, replyTo, onCancelReply }: {
  value: string; onChange: (s: string) => void; onSend: () => Promise<void> | void; onAttach?: () => void;
  members: Mentionable[]; placeholder: string; replyTo?: { author: string; body: string } | null; onCancelReply?: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [height, setHeight] = useState(24);
  const [sending, setSending] = useState(false);
  const query = /(?:^|\s)@([\p{L}\w.-]*)$/u.exec(value)?.[1]; // an @word being typed at the end
  const matches = query === undefined ? [] : members
    .filter(m => handle(m).toLowerCase().startsWith(query.toLowerCase()) || m.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5);
  const pick = (m: Mentionable) => { onChange(value.replace(/@([\p{L}\w.-]*)$/u, `@${handle(m)} `)); input.current?.focus(); };
  const canSend = !!value.trim() && !sending;
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try { await onSend(); } finally { setSending(false); setHeight(24); }
  };
  const onKey = (e: TextInputKeyPressEvent) => {
    if (Platform.OS !== 'web') return;
    if (e.nativeEvent.key === 'Enter' && !(e.nativeEvent as { shiftKey?: boolean }).shiftKey) {
      e.preventDefault();
      if (matches.length) pick(matches[0]); else send();
    }
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 + insets.bottom, gap: 8, backgroundColor: t.container }}>
      {matches.length > 0 && (
        <View accessibilityRole="menu" style={{ backgroundColor: t.containerHigh, borderRadius: radius.md, paddingVertical: 6 }}>
          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 4 }}>Mention someone</Text>
          {matches.map(m => (
            <Pressable key={m.id} accessibilityRole="menuitem" onPress={() => pick(m)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 48, backgroundColor: pressed ? t.surface : 'transparent' })}>
              <Avatar name={m.name} size={30} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={1}>{m.name}</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>@{handle(m)}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      {replyTo && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, gap: 8, backgroundColor: t.containerHigh, borderRadius: radius.md, borderLeftWidth: 4, borderColor: t.primary }}>
          <View style={{ flex: 1, paddingVertical: 8 }}>
            <Text style={{ color: t.primary, fontSize: 12, fontWeight: '700' }}>Replying to {replyTo.author}</Text>
            <Text style={{ color: t.muted }} numberOfLines={1}>{replyTo.body}</Text>
          </View>
          <IconButton name="close" label="Cancel reply" size={18} onPress={() => onCancelReply?.()} />
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', backgroundColor: t.containerHigh, borderRadius: 24, paddingHorizontal: 4, paddingVertical: 4 }}>
          {onAttach && <IconButton name="attach" label="Attach receipt or file" color={t.muted} onPress={onAttach} />}
          <TextInput ref={input} accessibilityLabel={placeholder} value={value} onChangeText={onChange} placeholder={placeholder}
            placeholderTextColor={t.faint} multiline onKeyPress={onKey} blurOnSubmit={false}
            onContentSizeChange={e => setHeight(Math.min(Math.max(24, e.nativeEvent.contentSize.height), 120))}
            style={[{ flex: 1, minWidth: 0, color: t.text, fontSize: 16, lineHeight: 22, height: Math.max(24, height), marginVertical: 10, paddingHorizontal: 4, paddingVertical: 0 },
              Platform.OS === 'web' ? ({ outlineStyle: 'none', resize: 'none' } as object) : { textAlignVertical: 'top' }]} />
          <IconButton name="at" label="Mention someone" color={query !== undefined ? t.primary : t.muted}
            onPress={() => { onChange(value && !/\s$/.test(value) ? `${value} @` : `${value}@`); input.current?.focus(); }} />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={send} disabled={!canSend}
          style={({ pressed }) => ({ width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
            backgroundColor: canSend ? (pressed ? t.primaryDark : t.primary) : t.surface })}>
          <Ionicons name="send" size={20} color={canSend ? t.primaryText : t.faint} />
        </Pressable>
      </View>
    </View>
  );
}
