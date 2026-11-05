import { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { MODE, api, errMsg } from '../../lib/api';
import { dumpBackup, restoreBackup } from '../../lib/localBridge';
import { useAuth } from '../../lib/auth';
import { setLang, useT, type Lang } from '../../lib/i18n';
import { Alert, Avatar, Button, Card, Chips, Field, H, Screen, confirmAsync, useTheme } from '../../lib/ui';

export default function Profile() {
  const t = useTheme();
  const { user, signOut } = useAuth();
  const tr = useT();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [language, setLanguage] = useState<Lang>('en');
  useEffect(() => {
    api('GET', '/me').then(u => { setName(u.full_name ?? ''); setCurrency(u.default_currency); setLanguage(u.language); }).catch(() => {});
  }, []);

  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  async function removeAccount() {
    try { await api('DELETE', '/me', { password }); await signOut(); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }
  async function backup() {
    setBusy(true);
    try {
      const f = new File(Paths.cache, `expensechat-backup-${new Date().toISOString().slice(0, 10)}.json`);
      f.create({ overwrite: true });
      f.write(await dumpBackup());
      await Sharing.shareAsync(f.uri);
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false);
  }
  async function restore() {
    const r = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
    if (r.canceled) return;
    if (!(await confirmAsync('Restore backup', 'This replaces all offline data on this phone with the backup. Continue?', 'Restore', 'Cancel'))) return;
    setBusy(true);
    try { await restoreBackup(await new File(r.assets[0].uri).text()); Alert.alert('Restored', 'Your backup is back in place.'); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false);
  }
  async function save() {
    try {
      await api('PATCH', '/me', { full_name: name.trim(), default_currency: currency.trim().toUpperCase(), language });
      setLang(language);
      Alert.alert(tr('Saved'), Platform.OS === 'web' ? undefined : 'Restart the app to switch text direction.');
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
        <View style={{ alignItems: 'center', gap: 8, paddingVertical: 16 }}>
          <Avatar name={name || user?.email || '?'} size={88} />
          <Text style={{ color: t.text, fontSize: 22, fontWeight: '800' }}>{name || '—'}</Text>
          <Text style={{ color: t.muted }}>{user?.email}</Text>
        </View>
        <Card style={{ gap: 16 }}>
          <Field icon="person-outline" label={tr('Full name')} value={name} onChangeText={setName} />
          <Field icon="cash-outline" label={tr('Default currency (ISO code)')} value={currency} onChangeText={setCurrency} maxLength={3} autoCapitalize="characters" />
          <Chips label={tr('Language')} options={[{ id: 'en' as Lang, name: 'English', icon: 'language-outline' }, { id: 'ur' as Lang, name: 'اردو', icon: 'language-outline' }]}
            value={language} onChange={v => v && setLanguage(v)} />
          <Button icon="save-outline" title={tr('Save')} onPress={save} />
        </Card>
        {MODE === 'local' ? (
          <Card>
            <H>Backup</H>
            <Text style={{ color: t.muted, fontSize: 13 }}>Offline data lives only on this phone. Save a backup somewhere safe (Drive, email). Restoring replaces everything here.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button small icon="cloud-upload-outline" title="Save backup" busy={busy} onPress={backup} />
              <Button small kind="ghost" icon="cloud-download-outline" title="Restore backup" busy={busy} onPress={restore} />
            </View>
          </Card>
        ) : null}
        <Button kind="danger" icon="log-out-outline" title={tr('Sign out')} onPress={signOut} />
        {MODE === 'server' ? (
          deleting ? (
            <Card>
              <H>Delete my account</H>
              <Text style={{ color: t.muted, fontSize: 13 }}>You lose access and your name is removed. Expense records stay for your organization, shown as "Deleted user". This cannot be undone.</Text>
              <Field label="Your password" icon="lock-closed-outline" secureTextEntry value={password} onChangeText={setPassword} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button small kind="ghost" title="Cancel" onPress={() => { setDeleting(false); setPassword(''); }} />
                <Button small kind="danger" title="Delete permanently" disabled={!password} onPress={removeAccount} />
              </View>
            </Card>
          ) : <Button kind="text" small title="Delete my account" onPress={() => setDeleting(true)} />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
