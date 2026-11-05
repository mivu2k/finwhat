import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, View, useColorScheme } from 'react-native';
import { AuthProvider, useAuth } from '../lib/auth';
import { flushOutbox } from '../lib/api';
import { setLang, useT } from '../lib/i18n';
import { FeedbackHost, IconButton, useTheme } from '../lib/ui';

function Root() {
  const { user, loading } = useAuth();
  const t = useTheme();
  const tr = useT();
  const base = useColorScheme() === 'dark' ? DarkTheme : DefaultTheme;
  // every screen paints its own solid background so screens never show through each other during transitions
  const navTheme = { ...base, colors: { ...base.colors, background: t.bg, card: t.bg, primary: t.primary, text: t.text, border: t.border } };

  useEffect(() => { if (user?.language) setLang(user.language); }, [user?.language]);
  // replay offline actions: on start, when the app returns to the foreground, and every 15s
  useEffect(() => {
    if (!user) return;
    flushOutbox();
    const timer = setInterval(flushOutbox, 15000);
    const sub = AppState.addEventListener('change', s => { if (s === 'active') flushOutbox(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [user]);

  if (loading) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator /></View>;
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ animation: 'ios_from_right', headerStyle: { backgroundColor: t.bg }, headerTintColor: t.text, headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '700', fontSize: 18 }, contentStyle: { backgroundColor: t.bg },
        // Always offer a way out, even on a page opened from a link (no history to go back to).
        headerLeft: () => <IconButton name="arrow-back" label={tr('Back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} /> }}>
        <Stack.Protected guard={!user}>
          <Stack.Screen name="login" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!!user}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="channel/[id]/index" options={{ title: tr('Channels') }} />
          <Stack.Screen name="channel/[id]/new" options={{ title: tr('New expense'), animation: 'slide_from_bottom' }} />
          <Stack.Screen name="channel/[id]/voice" options={{ title: tr('Voice note'), animation: 'slide_from_bottom' }} />
          <Stack.Screen name="channel/[id]/members" options={{ title: tr('Members') }} />
          <Stack.Screen name="channel/[id]/settings" options={{ title: tr('Settings') }} />
          <Stack.Screen name="channel/[id]/audit" options={{ title: tr('Audit log') }} />
          <Stack.Screen name="workspace/[id]/categories" options={{ title: 'Categories' }} />
          <Stack.Screen name="workspace/[id]/budgets" options={{ title: 'Budgets' }} />
          <Stack.Screen name="workspace/[id]/ai" options={{ title: 'AI settings' }} />
          <Stack.Screen name="channel/[id]/reports" options={{ title: 'Channel reports' }} />
          <Stack.Screen name="channel/[id]/recurring" options={{ title: 'Recurring expenses' }} />
          <Stack.Screen name="invite/[token]" options={{ title: 'Join channel' }} />
          <Stack.Screen name="thread/[id]" options={{ title: '' }} />
        </Stack.Protected>
      </Stack>
      <FeedbackHost />
    </ThemeProvider>
  );
}

export default function Layout() {
  return <AuthProvider><Root /></AuthProvider>;
}
