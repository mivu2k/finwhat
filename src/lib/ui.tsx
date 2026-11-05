import { ActivityIndicator, Animated, Easing, Modal, Platform, Pressable, ScrollView, Text, TextInput, View, useColorScheme,
  type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { createElement, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, onOutboxChange } from './api';
import { useT } from './i18n';
import type { Status } from './workflow';
import { LABEL } from './workflow';

// ───── design system ─────
// Colour: sky blue primary, navy for "selected", pale blue-white ground. Radius: 10/14/20/pill. Spacing: multiples of 4.
// Type: 28 title, 20 section, 16 list title, 15 body, 13 secondary, 12 caption. Icons: 16/20/24.
const light = {
  bg: '#F3F8FE', card: '#FFFFFF', surface: '#EDF3FA', text: '#0F2540', muted: '#55677D', faint: '#7C8DA3', border: '#DFE8F2',
  primary: '#1673D9', primaryDark: '#0E4E94', primarySoft: '#E1EFFF', primaryText: '#FFFFFF',
  accent: '#3E6373', danger: '#C9252D', dangerSoft: '#FDE7E8', warn: '#8A6100', warnSoft: '#FFF1CC',
  bubbleMe: '#E1EFFF', bubble: '#FFFFFF', chatBg: '#F3F8FE', shadow: '#1E4E86',
  container: '#FFFFFF', containerHigh: '#EDF3FA', primaryContainer: '#1673D9', onPrimaryContainer: '#FFFFFF',
  navy: '#1B5A93', onNavy: '#FFFFFF', hero: ['#3B9BF5', '#1673D9'] as [string, string], onHero: '#FFFFFF',
};
const dark: typeof light = {
  bg: '#0B1524', card: '#132238', surface: '#1B2D46', text: '#EAF2FB', muted: '#A4B4C8', faint: '#7A8BA1', border: '#24374F',
  primary: '#5AAEFF', primaryDark: '#BFDDFF', primarySoft: '#173A5E', primaryText: '#04233F',
  accent: '#A6CCDF', danger: '#FF8A8A', dangerSoft: '#4A1C22', warn: '#F5BF48', warnSoft: '#4A3A10',
  bubbleMe: '#173A5E', bubble: '#132238', chatBg: '#0B1524', shadow: '#000000',
  container: '#132238', containerHigh: '#1B2D46', primaryContainer: '#5AAEFF', onPrimaryContainer: '#04233F',
  navy: '#2F6FAB', onNavy: '#FFFFFF', hero: ['#1C4F85', '#123763'], onHero: '#FFFFFF',
};
export type Theme = typeof light;
export const useTheme = () => (useColorScheme() === 'dark' ? dark : light);
export const radius = { sm: 10, md: 14, lg: 20, pill: 999 };
/** Card surface with a soft blue shadow. */
export const shadow = (t: Theme): ViewStyle => ({ backgroundColor: t.card, shadowColor: t.shadow, shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 2 });
export const glass = shadow;
const float = (t: Theme): ViewStyle => ({ shadowColor: t.shadow, shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 });

/** The rounded blue panel used at the top of key screens. */
export function HeroPanel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <LinearGradient colors={t.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: 24, padding: 18, gap: 14 }, style]}>{children}</LinearGradient>;
}

/** Section title with a count badge, as in lists. */
export function SectionTitle({ title, count, right }: { title: string; count?: number; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 17, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>{title}</Text>
      {count != null && <View style={{ minWidth: 22, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: t.navy, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: t.onNavy, fontSize: 11, fontWeight: '700' }}>{count}</Text>
      </View>}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

/** Placeholder rows while data loads, so screens don't jump or sit blank. */
export function Skeleton({ rows = 4, height = 72 }: { rows?: number; height?: number }) {
  const t = useTheme();
  const [pulse] = useState(() => new Animated.Value(0.5));
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulse]);
  return (
    <View accessibilityLabel="Loading" style={{ gap: 10, padding: 16 }}>
      {Array.from({ length: rows }, (_, i) => <Animated.View key={i} style={{ height, borderRadius: radius.lg, backgroundColor: t.surface, opacity: pulse }} />)}
    </View>
  );
}

export type IconName = ComponentProps<typeof Ionicons>['name'];
export const Icon = ({ name, size = 20, color }: { name: IconName; size?: number; color?: string }) => {
  const t = useTheme();
  return <Ionicons name={name} size={size} color={color ?? t.text} />;
};

export const STATUS_COLOR: Record<Status, string> = {
  draft: '#64748B', submitted: '#2563EB', under_review: '#7C3AED', approved: '#059669', rejected: '#E11D48',
  needs_info: '#EA580C', unpaid: '#D97706', paid: '#0D9488', closed: '#475569',
};

export function StatusPill({ status, small, advance }: { status: Status; small?: boolean; advance?: boolean }) {
  // for an advance, "paid" means the money was handed over, not that the matter is settled
  const tr = useT();
  const c = STATUS_COLOR[status];
  const text = advance && status === 'paid' ? 'Handed over' : tr(LABEL[status]);
  return (
    <View accessibilityLabel={`Status ${text}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c + '1A', borderRadius: radius.pill,
        paddingHorizontal: small ? 8 : 10, paddingVertical: small ? 2 : 4, alignSelf: 'flex-start' }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c }} />
      <Text style={{ color: c, fontSize: small ? 11 : 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

// deterministic soft color per name
const AVATAR = ['#0E9F6E', '#6366F1', '#EC4899', '#F59E0B', '#06B6D4', '#8B5CF6', '#EF4444', '#14B8A6'];
export function Avatar({ name, size = 44, icon }: { name: string; size?: number; icon?: IconName }) {
  const n = name || '?';
  const c = AVATAR[[...n].reduce((s, ch) => s + ch.charCodeAt(0), 0) % AVATAR.length];
  const initials = n.replace(/\(.*?\)|^#/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <View accessibilityElementsHidden style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c + '22',
      alignItems: 'center', justifyContent: 'center' }}>
      {icon ? <Ionicons name={icon} size={size * 0.45} color={c} />
        : <Text style={{ color: c, fontWeight: '800', fontSize: size * 0.36 }}>{initials}</Text>}
    </View>
  );
}

type BtnKind = 'primary' | 'ghost' | 'danger' | 'text';
export function Button({ title, onPress, kind = 'primary', disabled, busy, icon, small, style }: {
  title: string; onPress: () => void; kind?: BtnKind; disabled?: boolean; busy?: boolean; icon?: IconName; small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = { primary: 'transparent', ghost: t.primarySoft, danger: t.dangerSoft, text: 'transparent' }[kind];
  const fg = { primary: t.onHero, ghost: t.primaryDark, danger: t.danger, text: t.primary }[kind];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [{ minHeight: small ? 40 : 52, paddingHorizontal: small ? 14 : 20, borderRadius: radius.md, overflow: 'hidden',
        flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: bg,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}>
      {kind === 'primary' && <LinearGradient colors={t.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />}
      {busy ? <ActivityIndicator color={fg} /> : <>
        {icon && <Ionicons name={icon} size={small ? 16 : 18} color={fg} />}
        <Text style={{ color: fg, fontWeight: '700', fontSize: small ? 13 : 15, flexShrink: 1 }}>{title}</Text>
      </>}
    </Pressable>
  );
}

export function IconButton({ name, onPress, label, color, size = 22, bg }: { name: IconName; onPress: () => void; label: string; color?: string; size?: number; bg?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
        backgroundColor: bg ?? (pressed ? t.surface : 'transparent') })}>
      <Ionicons name={name} size={size} color={color ?? t.text} />
    </Pressable>
  );
}

export function Field({ label, icon, right, ...props }: TextInputProps & { label?: string; icon?: IconName; right?: ReactNode }) {
  const t = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.3 }}>{label}</Text> : null}
      <View style={[{ flexDirection: 'row', alignItems: props.multiline ? 'flex-start' : 'center', gap: 10, minHeight: 56,
        backgroundColor: t.containerHigh, borderRadius: radius.md, paddingHorizontal: 14,
        borderWidth: 1.5, borderColor: focus ? t.primary : 'transparent' }, props.style as ViewStyle]}>
        {icon && <Ionicons name={icon} size={18} color={t.faint} style={props.multiline ? { marginTop: 14 } : undefined} />}
        <TextInput accessibilityLabel={label ?? props.placeholder} placeholderTextColor={t.faint} {...props}
          onFocus={e => { setFocus(true); props.onFocus?.(e); }} onBlur={e => { setFocus(false); props.onBlur?.(e); }}
          style={[{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 12 },
            Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null, props.multiline ? { minHeight: 80, textAlignVertical: 'top' } : null]} />
        {right}
      </View>
    </View>
  );
}

const isoDay = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const toDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date());
const fromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const pretty = (v: string) => (v ? toDate(v).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
/** Date picker: native calendar on phones, the browser's date input on web, plus one-tap Today / Yesterday. */
export function DateField({ label, value, onChangeText, optional, style }: {
  label: string; value: string; onChangeText: (v: string) => void; optional?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const quick: [string, string][] = [['Today', isoDay(0)], ['Yesterday', isoDay(-1)], ...(optional ? [['In 7 days', isoDay(7)] as [string, string]] : [])];
  const box: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, backgroundColor: t.containerHigh, borderRadius: radius.md, paddingHorizontal: 14 };
  const onPick = (_: unknown, d?: Date) => d && onChangeText(fromDate(d));
  let input: ReactNode;
  if (Platform.OS === 'web') {
    input = (
      <View style={[box, style]}>
        <Ionicons name="calendar-outline" size={18} color={t.faint} />
        {createElement('input', { type: 'date', value, 'aria-label': label, onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
          style: { flex: 1, minWidth: 0, width: '100%', border: 'none', outline: 'none', background: 'transparent', color: t.text, fontSize: 15, fontFamily: 'inherit', padding: '12px 0', colorScheme: 'light dark' } })}
      </View>
    );
  } else if (Platform.OS === 'ios') {
    input = (
      <View style={[box, style]}>
        <Ionicons name="calendar-outline" size={18} color={t.faint} />
        <Text style={{ color: t.muted, flex: 1 }}>{value ? '' : 'Pick a date'}</Text>
        <DateTimePicker value={toDate(value)} mode="date" display="compact" onValueChange={onPick} accessibilityLabel={label} />
      </View>
    );
  } else {
    input = (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${pretty(value) || 'not set'}`}
        onPress={() => DateTimePickerAndroid.open({ value: toDate(value), mode: 'date', onValueChange: onPick })} style={[box, style]}>
        <Ionicons name="calendar-outline" size={18} color={t.faint} />
        <Text style={{ color: value ? t.text : t.faint, fontSize: 15, flex: 1 }}>{pretty(value) || 'Pick a date'}</Text>
        <Ionicons name="chevron-down" size={16} color={t.faint} />
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      {input}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {quick.map(([name, d]) => {
          const on = value === d;
          return (
            <Pressable key={name} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChangeText(d)}
              style={{ minHeight: 36, paddingHorizontal: 14, borderRadius: radius.sm, justifyContent: 'center', backgroundColor: on ? t.navy : t.surface }}>
              <Text style={{ color: on ? t.onNavy : t.text, fontSize: 13, fontWeight: '600' }}>{name}</Text>
            </Pressable>
          );
        })}
        {optional && value ? (
          <Pressable accessibilityRole="button" onPress={() => onChangeText('')} style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: 'center' }}>
            <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function Screen({ children, bg }: { children: ReactNode; bg?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: bg ?? t.bg }}>
      <View style={{ flex: 1, width: '100%', maxWidth: 960, alignSelf: 'center' }}>{children}</View>
    </View>
  );
}

export const money = (amount: number | null, currency: string) =>
  amount == null ? '—' : `${currency} ${amountText(Number(amount))}`;
/** Standard money format everywhere: 1,250.00 */
export const amountText = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const t = useTheme();
  const base: ViewStyle = { backgroundColor: t.card, borderRadius: radius.lg, padding: 16, gap: 10, ...shadow(t) };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.9 : 1 }, style]}>{children}</Pressable>
  );
}

export function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 17, fontWeight: '800' }}>{children}</Text>
      {right}
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0, marginTop: 8 }}>{children}</Text>;
}

export function Empty({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: 40, gap: 10 }}>
      <Ionicons name={icon} size={36} color={t.faint} />
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>{title}</Text>
      {hint ? <Text style={{ color: t.muted, textAlign: 'center', maxWidth: 300 }}>{hint}</Text> : null}
    </View>
  );
}

/** Floating action button. */
export function Fab({ icon = 'add', onPress, label }: { icon?: IconName; onPress: () => void; label: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ position: 'absolute', right: 16, bottom: 16, height: 56, paddingHorizontal: 20, borderRadius: 16,
        backgroundColor: t.primary, flexDirection: 'row', alignItems: 'center', gap: 12, ...float(t),
        transform: [{ scale: pressed ? 0.96 : 1 }] })}>
      <Ionicons name={icon} size={24} color={t.primaryText} />
      <Text style={{ color: t.primaryText, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

const native = Platform.OS !== 'web';
/** Bottom sheet: the dim background fades while the panel slides, in and out. */
export function BottomSheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(visible);
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(anim, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: native }).start(({ finished }) => { if (finished) setMounted(false); });
    }
  }, [visible, anim]);
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0B152480', opacity: anim }}>
          <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1 }} />
        </Animated.View>
        <Animated.View style={{ backgroundColor: t.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 24 + insets.bottom, gap: 12, width: '100%', maxWidth: 560, alignSelf: 'center',
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }] }}>
          <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: t.border, alignSelf: 'center' }} />
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** Bottom sheet with large tappable options. */
export function Sheet({ visible, onClose, title, options }: {
  visible: boolean; onClose: () => void; title: string;
  options: { icon: IconName; label: string; hint?: string; color?: string; onPress: () => void }[];
}) {
  const t = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '800', marginBottom: 8 }}>{title}</Text>
          {options.map(o => (
            <Pressable key={o.label} accessibilityRole="button" onPress={() => { onClose(); o.onPress(); }}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderRadius: radius.md,
                backgroundColor: pressed ? t.surface : 'transparent' })}>
              <Ionicons name={o.icon} size={24} color={o.color ?? t.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{o.label}</Text>
                {o.hint ? <Text style={{ color: t.muted, fontSize: 13 }}>{o.hint}</Text> : null}
              </View>
              <Ionicons name="chevron-forward" size={18} color={t.faint} />
            </Pressable>
          ))}
    </BottomSheet>
  );
}

/** Horizontal bar list: label, proportional bar, value. Values share one scale per list. */
export function Bars({ rows, format }: { rows: { label: string; total: number }[]; format: (n: number) => string }) {
  const t = useTheme();
  const max = Math.max(...rows.map(r => Number(r.total)), 1);
  return (
    <View style={{ gap: 12 }}>
      {rows.map(r => (
        <View key={r.label} accessible accessibilityLabel={`${r.label}: ${format(Number(r.total))}`} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '500', flex: 1 }} numberOfLines={1}>{r.label}</Text>
            <Text style={{ color: t.text, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{format(Number(r.total))}</Text>
          </View>
          <View style={{ height: 8, backgroundColor: t.surface, borderRadius: 4, overflow: 'hidden' }}>
            <View style={{ height: 8, width: `${Math.max((Number(r.total) / max) * 100, 2)}%`, backgroundColor: t.primary, borderRadius: 4 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Shows how many offline actions are waiting to sync. */
export function OutboxBanner() {
  const t = useTheme();
  const [n, setN] = useState(0);
  const tr = useT();
  useEffect(() => onOutboxChange(setN), []);
  if (!n) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: t.warnSoft, paddingVertical: 8, paddingHorizontal: 16, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="cloud-offline-outline" size={16} color={t.warn} />
      <Text style={{ color: t.warn, fontSize: 13, fontWeight: '600' }}>{tr('Offline: will sync when back online')} ({n})</Text>
    </View>
  );
}

// one line that scrolls sideways (filters on small screens), or wrapped lines
const ChipsWrap = ({ children }: { children: ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">{children}</View>;
const ChipsScroll = ({ children }: { children: ReactNode }) => <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }} accessibilityRole="radiogroup">{children}</ScrollView>;
export function Chips<T extends string>({ options, value, onChange, label, scroll }: {
  options: { id: T; name: string; icon?: IconName }[]; value: T | null; onChange: (v: T | null) => void; label?: string; scroll?: boolean;
}) {
  const t = useTheme();
  const Wrap = scroll ? ChipsScroll : ChipsWrap;
  return (
    <View style={{ gap: 8 }}>
      {label ? <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.3 }}>{label}</Text> : null}
      <Wrap>
        {options.map(o => {
          const on = o.id === value;
          return (
            <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => onChange(on ? null : o.id)}
              style={{ minHeight: 36, flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 14, borderRadius: radius.sm,
                backgroundColor: on ? t.navy : t.surface }}>
              {o.icon && <Ionicons name={o.icon} size={16} color={on ? t.onNavy : t.muted} />}
              <Text style={{ color: on ? t.onNavy : t.text, fontWeight: '600', fontSize: 13 }}>{o.name}</Text>
              {on && <Ionicons name="checkmark-circle" size={15} color={t.onNavy} />}
              
            </Pressable>
          );
        })}
      </Wrap>
    </View>
  );
}

// ───── feedback: toasts and confirm dialogs, one look on every platform (rendered by <FeedbackHost/>) ─────
type Toast = { title: string; message?: string; error: boolean };
type Ask = { title: string; message: string; ok: string; cancel: string; resolve: (v: boolean) => void };
let showToast: (t: Toast) => void = () => {};
let showAsk: (a: Ask) => void = a => a.resolve(false);
export const Alert = {
  alert(title: string, message?: string) { showToast({ title, message: message && message[0].toUpperCase() + message.slice(1), error: /error|خرابی|could not|denied/i.test(title) }); },
};
export const confirmAsync = (title: string, message: string, okLabel = 'OK', cancelLabel = 'Cancel') =>
  new Promise<boolean>(resolve => showAsk({ title, message, ok: okLabel, cancel: cancelLabel, resolve }));

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => { Animated.timing(anim, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start(); }, [anim]);
  return (
    <Animated.View style={{ position: 'absolute', top: insets.top + 10, left: 16, right: 16, zIndex: 1000, alignItems: 'center', opacity: anim,
      transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] }}>
      <Pressable accessibilityRole="alert" accessibilityLiveRegion="assertive" onPress={onClose}
        style={{ width: '100%', maxWidth: 520, flexDirection: 'row', gap: 10, alignItems: 'center', padding: 14, borderRadius: radius.md, backgroundColor: toast.error ? t.danger : t.text, ...float(t) }}>
        <Ionicons name={toast.error ? 'alert-circle' : 'checkmark-circle'} size={20} color={t.bg} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.bg, fontWeight: '700' }}>{toast.title}</Text>
          {toast.message ? <Text style={{ color: t.bg, fontSize: 13 }}>{toast.message}</Text> : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

export function FeedbackHost() {
  const t = useTheme();
  const [toast, setToast] = useState<Toast | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    showToast = x => { setToast(x); clearTimeout(timer); timer = setTimeout(() => setToast(null), x.error ? 7000 : 3500); };
    showAsk = setAsk;
    return () => clearTimeout(timer);
  }, []);
  const answer = (v: boolean) => { ask?.resolve(v); setAsk(null); };
  const danger = ask ? /delete|remove|reject|stop|restore|close/i.test(ask.ok) : false;
  return <>
    {toast && <ToastView key={toast.title + toast.message} toast={toast} onClose={() => setToast(null)} />}
    <Modal visible={!!ask} transparent animationType="fade" onRequestClose={() => answer(false)}>
      <View style={{ flex: 1, backgroundColor: '#0B152499', justifyContent: 'center', padding: 24 }}>
        <View accessibilityRole="alert" style={{ backgroundColor: t.card, borderRadius: radius.lg, padding: 20, gap: 12, width: '100%', maxWidth: 420, alignSelf: 'center' }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{ask?.title}</Text>
          <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21 }}>{ask?.message}</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
            <Button kind="ghost" title={ask?.cancel ?? 'Cancel'} onPress={() => answer(false)} style={{ flex: 1 }} />
            <Button kind={danger ? 'danger' : 'primary'} title={ask?.ok ?? 'OK'} onPress={() => answer(true)} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  </>;
}

/** Warn about likely duplicates (same amount+vendor+date, or identical file) before submitting. False = user backed out. */
export async function okToSubmit(threadId: string, tr: (s: string) => string) {
  const dups = await api<{ title: string | null; vendor: string | null; amount: number; currency: string; expense_date: string | null }[]>(
    'GET', `/threads/${threadId}/duplicates`).catch(() => []);
  if (!dups.length) return true;
  return confirmAsync(tr('Possible duplicate'),
    dups.map(d => `• ${d.title ?? d.vendor ?? '—'} · ${d.currency} ${d.amount} · ${d.expense_date ?? ''}`).join('\n'),
    tr('Submit anyway'), tr('Cancel'));
}

/** Relative time: "now", "5m", "3h", "Mon", "12 Jan". */
export function ago(s: string) {
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  const m = (Date.now() - d.getTime()) / 60000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 10080) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
