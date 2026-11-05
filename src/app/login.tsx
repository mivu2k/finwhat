import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { API_URL, LOCAL_TOKEN, api, errMsg, pingApi, setApiUrl, setMode, setToken, type User } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Button, Field, HeroPanel, IconButton, radius, shadow, useTheme, type IconName } from '../lib/ui';

/** Which server this app talks to. Lets a test APK point at whatever machine runs the API. */
function ServerSetting() {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(API_URL);
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  async function save() {
    setState('checking');
    const ok = await pingApi(url);
    setState(ok ? 'ok' : 'fail');
    if (ok) { await setApiUrl(url); setOpen(false); }
  }
  if (!open) return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Server ${API_URL}. Change`} onPress={() => { setUrl(API_URL); setState('idle'); setOpen(true); }}
      style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, minHeight: 40 }}>
      <Ionicons name="server-outline" size={14} color={t.faint} />
      <Text style={{ color: t.faint, fontSize: 13 }} numberOfLines={1}>Server: {API_URL}</Text>
      <Text style={{ color: t.primary, fontSize: 13, fontWeight: '700' }}>Change</Text>
    </Pressable>
  );
  return (
    <View style={{ gap: 10, backgroundColor: t.card, borderRadius: radius.lg, padding: 16 }}>
      <Field label="Server address" icon="server-outline" value={url} onChangeText={x => { setUrl(x); setState('idle'); }}
        placeholder="http://192.168.0.10:4000" autoCapitalize="none" autoCorrect={false} keyboardType="url" onSubmitEditing={save} />
      {state === 'fail' && <Text style={{ color: t.danger, fontSize: 13 }}>Can’t reach that server. Check the address, that the API is running, and that the phone is on the same Wi-Fi.</Text>}
      {state === 'ok' && <Text style={{ color: t.primary, fontSize: 13 }}>Connected.</Text>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button kind="ghost" title="Cancel" onPress={() => setOpen(false)} style={{ flex: 1 }} />
        <Button title="Test & save" busy={state === 'checking'} disabled={!/^https?:\/\/\S+$/.test(url.trim())} onPress={save} style={{ flex: 1.4 }} />
      </View>
    </View>
  );
}

/** Forgot password: an emailed code, then a new password. */
function ForgotPassword({ email: initial, onDone }: { email: string; onDone: (email: string) => void }) {
  const t = useTheme();
  const [email, setEmail] = useState(initial);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(errMsg(e)); } setBusy(false); };
  return (
    <View style={{ backgroundColor: t.card, borderRadius: radius.lg, padding: 20, gap: 14 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Reset your password</Text>
      <Field label="Email" icon="mail-outline" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      {sent && <>
        <Text style={{ color: t.muted, fontSize: 13 }}>If that email has an account, a 6-digit code is on its way. It works for 15 minutes.</Text>
        <Field label="Code" icon="keypad-outline" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
        <Field label="New password" icon="lock-closed-outline" placeholder="At least 8 characters" secureTextEntry value={password} onChangeText={setPassword} />
      </>}
      {error ? <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text> : null}
      {sent
        ? <Button title="Set new password" busy={busy} disabled={code.length !== 6 || password.length < 8} onPress={() => run(async () => { await api('POST', '/auth/reset', { email, code, password }); onDone(email); })} />
        : <Button title="Send code" busy={busy} disabled={!email.includes('@')} onPress={() => run(async () => { await setMode('server'); await api('POST', '/auth/forgot', { email }); setSent(true); })} />}
      <Button kind="text" small title="Back to sign in" onPress={() => onDone(initial)} />
    </View>
  );
}

const FEATURES: [IconName, string][] = [
  ['chatbubbles-outline', 'Every expense is a thread your team can discuss'],
  ['checkmark-done-outline', 'Approve, reject or ask for info in one tap'],
  ['sparkles-outline', 'Snap a receipt or say it: AI fills the form'],
];

// ponytail: email+password only; phone OTP / Google login need an SMS provider / OAuth client (phase 4).
export default function Login() {
  const t = useTheme();
  const tr = useT();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [signup, setSignup] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);

  const ready = !!email.trim() && password.length >= (signup ? 8 : 1) && (!signup || !!name.trim());
  async function go() {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await setMode('server');
      const r = await api('POST', signup ? '/auth/signup' : '/auth/login', { email: email.trim(), password, full_name: name.trim() });
      await signIn(r.token, r.user);
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  }
  const switchMode = () => { setSignup(!signup); setError(''); };
  /** Offline: no account, no server; everything is stored in SQLite on this phone. */
  async function useOffline() {
    setBusy(true); setError('');
    try {
      await setMode('local'); await setToken(LOCAL_TOKEN);
      await signIn(LOCAL_TOKEN, await api<User>('GET', '/me'));
    } catch (e) { await setMode('server'); setError(errMsg(e)); }
    setBusy(false);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'web' ? undefined : 'padding'} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 20, paddingVertical: 40 }} keyboardShouldPersistTaps="handled">
        <View style={{ width: '100%', maxWidth: 400, alignSelf: 'center', gap: 24 }}>
          <HeroPanel style={{ padding: 22 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name="receipt" size={24} color={t.onHero} />
              <Text style={{ color: t.onHero, fontSize: 18, fontWeight: '800' }}>ExpenseChat.</Text>
            </View>
            <View style={{ gap: 4 }}>
              <Text accessibilityRole="header" style={{ color: t.onHero, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>{signup ? 'Create your account' : 'Welcome back'}</Text>
              <Text style={{ color: t.onHero, fontSize: 15, opacity: 0.92 }}>{signup ? 'Start tracking and approving expenses with your team.' : 'Sign in to see your team’s expense threads.'}</Text>
            </View>
          </HeroPanel>

          <View style={{ backgroundColor: t.card, borderRadius: radius.lg, padding: 20, gap: 14, ...shadow(t) }}>
            {signup && <Field label={tr('Full name')} icon="person-outline" placeholder="Ayesha Khan" value={name} onChangeText={setName} autoComplete="name" />}
            <Field label={tr('Email')} icon="mail-outline" placeholder="you@company.com" value={email} onChangeText={setEmail}
              autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
            <Field label={tr('Password')} icon="lock-closed-outline" placeholder={signup ? 'At least 8 characters' : '••••••••'} value={password}
              onChangeText={setPassword} secureTextEntry={!show} autoComplete={signup ? 'new-password' : 'current-password'} onSubmitEditing={go}
              right={<IconButton name={show ? 'eye-off-outline' : 'eye-outline'} label={show ? 'Hide password' : 'Show password'} size={18} color={t.muted} onPress={() => setShow(!show)} />} />
            {signup && password.length > 0 && password.length < 8 && (
              <Text style={{ color: t.warn, fontSize: 12 }}>{8 - password.length} more characters needed</Text>
            )}
            {error ? (
              <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: t.dangerSoft, padding: 12, borderRadius: radius.sm }}>
                <Ionicons name="alert-circle" size={18} color={t.danger} />
                <Text style={{ color: t.danger, flex: 1, fontSize: 13, fontWeight: '600' }}>{error}</Text>
              </View>
            ) : null}
            <Button title={tr(signup ? 'Create account' : 'Sign in')} onPress={go} busy={busy} disabled={!ready} style={{ marginTop: 4 }} />
          </View>

          {!signup && !forgot && (
            <Pressable accessibilityRole="button" onPress={() => setForgot(true)} style={{ alignSelf: 'center', minHeight: 36, justifyContent: 'center' }}>
              <Text style={{ color: t.primary, fontWeight: '700', fontSize: 13 }}>Forgot password?</Text>
            </Pressable>
          )}
          {forgot && <ForgotPassword email={email} onDone={e => { setEmail(e); setForgot(false); }} />}
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ color: t.muted }}>{signup ? 'Already have an account?' : 'New here?'}</Text>
            <Pressable accessibilityRole="button" onPress={switchMode} hitSlop={8}>
              <Text style={{ color: t.primary, fontWeight: '700' }}>{tr(signup ? 'Sign in' : 'Create account')}</Text>
            </Pressable>
          </View>

          {signup && (
            <View style={{ gap: 10, paddingTop: 4 }}>
              {FEATURES.map(([icon, text]) => (
                <View key={text} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <Ionicons name={icon} size={18} color={t.primary} />
                  <Text style={{ color: t.muted, fontSize: 14, flex: 1 }}>{text}</Text>
                </View>
              ))}
            </View>
          )}
          {Platform.OS !== 'web' && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
                <Text style={{ color: t.muted, fontSize: 13 }}>or</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
              </View>
              <Button kind="ghost" icon="phone-portrait-outline" title="Use offline on this phone" busy={busy} onPress={useOffline} />
              <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>
                No account or server. Your data stays on this phone. Just you: no shared channels or AI.
              </Text>
            </View>
          )}
          <ServerSetting />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
