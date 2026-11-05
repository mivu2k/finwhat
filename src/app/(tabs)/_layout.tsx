import { useEffect, useState } from 'react';
import { Tabs, type BottomTabBarProps } from 'expo-router/tabs';
import { LayoutAnimation, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { OutboxBanner, useTheme, type IconName } from '../../lib/ui';

const icon = (on: IconName, off: IconName) => ({ focused, color }: { focused: boolean; color: unknown }) =>
  <Ionicons name={focused ? on : off} size={22} color={color as string} />;

/** Phone: a rounded bottom bar where the active tab is a blue pill with its label. Tablet/desktop: a slim sidebar with labels. */
function NavBar({ state, descriptors, emitter, navigateToTab, vertical }: BottomTabBarProps & { vertical?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const items = state.routes.map((r, i) => {
    const on = state.index === i;
    const o = descriptors[r.key].options;
    const go = () => { const e = emitter.emit({ type: 'tabPress', target: r.key, canPreventDefault: true }); if (!on && !e.defaultPrevented) { if (!vertical) LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity')); navigateToTab(r.key); } };
    const showLabel = on || vertical;
    const color = on ? t.onHero : t.muted;
    const inner = <>
      {o.tabBarIcon?.({ focused: on, color, size: 22 })}
      {showLabel && <Text style={{ color: on ? t.onHero : t.text, fontWeight: on ? '700' : '500', fontSize: vertical ? 15 : 13 }} numberOfLines={1}>{o.title}</Text>}
      {!!o.tabBarBadge && <View style={{ position: vertical ? 'relative' : 'absolute', top: vertical ? 0 : 6, right: vertical ? 0 : 10, marginLeft: vertical ? 'auto' : 0, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{o.tabBarBadge}</Text></View>}
    </>;
    const box = { flexDirection: 'row', gap: vertical ? 12 : 6, height: 50, alignItems: 'center', justifyContent: vertical ? 'flex-start' : 'center', paddingHorizontal: vertical ? 14 : 0, borderRadius: 16, overflow: 'hidden' } as const;
    return (
      <Pressable key={r.key} accessibilityRole="tab" accessibilityLabel={o.title} accessibilityState={{ selected: on }} onPress={go} style={vertical ? undefined : { flex: on ? 2.3 : 1 }}>
        {on ? <LinearGradient colors={t.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={box}>{inner}</LinearGradient> : <View style={box}>{inner}</View>}
      </Pressable>
    );
  });
  if (vertical) return (
    <View style={{ width: 240, backgroundColor: t.card, padding: 16, gap: 6, borderRightWidth: 1, borderColor: t.border }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '800', paddingHorizontal: 14, paddingVertical: 12 }}>ExpenseChat<Text style={{ color: t.primary }}>.</Text></Text>
      {items}
    </View>
  );
  return (
    <View style={{ backgroundColor: t.bg, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 + insets.bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.card, borderRadius: 24, padding: 6, shadowColor: t.shadow, shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>{items}</View>
    </View>
  );
}

// Phones: bottom tabs. Tablets/desktop web: left sidebar.
export default function TabsLayout() {
  const wide = useWindowDimensions().width >= 768;
  const t = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    // ponytail: unread badge polls every 30s; switch to push (expo-notifications) once an EAS project exists.
    const poll = () => api<{ unread: number }>('GET', '/notifications').then(r => setUnread(r.unread)).catch(() => {});
    poll();
    const timer = setInterval(poll, 30000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <OutboxBanner />
      <Tabs tabBar={props => <NavBar {...props} vertical={wide} />} screenOptions={{
        tabBarPosition: wide ? 'left' : 'bottom',
        tabBarVariant: wide ? 'material' : 'uikit',
        tabBarLabelPosition: wide ? 'beside-icon' : 'below-icon',
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        tabBarLabelStyle: { fontWeight: '600', fontSize: 12, marginTop: 4 },
        tabBarStyle: { backgroundColor: t.container, borderTopWidth: 0, borderRightWidth: wide ? 1 : 0, borderColor: t.border,
          ...(wide ? { width: 220, paddingTop: 16 } : { height: 80 + insets.bottom, paddingBottom: 12 + insets.bottom, paddingTop: 12 }) },
        headerStyle: { backgroundColor: t.bg, shadowOpacity: 0, elevation: 0, borderBottomWidth: 0 },
        headerTitleStyle: { fontWeight: '700', fontSize: 26, color: t.text },
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: t.bg },
      }}>
        <Tabs.Screen name="index" options={{ title: tr('Channels'), tabBarIcon: icon('chatbubbles', 'chatbubbles-outline') }} />
        <Tabs.Screen name="search" options={{ title: tr('Search'), tabBarIcon: icon('search', 'search-outline') }} />
        <Tabs.Screen name="dashboard" options={{ title: tr('Dashboard'), tabBarIcon: icon('pie-chart', 'pie-chart-outline') }} />
        <Tabs.Screen name="alerts" options={{ title: tr('Alerts'), tabBarIcon: icon('notifications', 'notifications-outline'),
          tabBarBadge: unread || undefined, tabBarBadgeStyle: { backgroundColor: t.danger, fontSize: 10 } }}
          listeners={{ focus: () => setUnread(0) }} />
        <Tabs.Screen name="profile" options={{ title: tr('Profile'), tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
      </Tabs>
    </View>
  );
}
