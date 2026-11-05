import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { api, errMsg, send, uuid, type Member } from '../../../lib/api';
import { useUserId } from '../../../lib/auth';
import { useChannel } from '../../../lib/useChannel';
import { useT } from '../../../lib/i18n';
import { ExpenseForm, type FormValues } from '../../../components/ExpenseForm';
import { Alert, Chips, Screen, confirmAsync, okToSubmit, useTheme } from '../../../lib/ui';

export default function NewExpense() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>();
  const advance = kind === 'advance';
  const uid = useUserId();
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [holder, setHolder] = useState<string | null>(null);
  useEffect(() => {
    if (advance) api<Member[]>('GET', `/channels/${id}/members`).then(r => setMembers(r.map(m => ({ id: m.user_id, name: m.profile?.full_name ?? m.profile?.email ?? '' })))).catch(() => {});
  }, [advance, id]);
  const tr = useT();
  const { channel } = useChannel(id);
  const insets = useSafeAreaInsets();
  const t = useTheme();
  const [templates, setTemplates] = useState<{ id: string; name: string; data: Partial<FormValues> }[]>([]);
  const [initial, setInitial] = useState<{ key: string; values: Partial<FormValues> }>({ key: 'blank', values: {} });
  const loadTemplates = () => { api('GET', `/channels/${id}/templates`).then(setTemplates).catch(() => {}); };
  useEffect(loadTemplates, [id]);
  if (!channel) return null;

  async function saveTemplate(v: FormValues) {
    const name = v.title || v.vendor || 'Template';
    try { await api('POST', `/channels/${id}/templates`, { name, data: { ...v, expense_date: null } }); loadTemplates(); Alert.alert('Template saved', `"${name}" is now at the top of this form.`); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }
  async function deleteTemplate(tid: string, name: string) {
    if (!(await confirmAsync('Delete template', `Delete "${name}"?`, 'Delete', 'Cancel'))) return;
    await api('DELETE', `/channels/${id}/templates/${tid}`).catch(() => {}); loadTemplates();
  }
  async function repeat(v: FormValues) {
    const day = Math.min(Number(String(v.expense_date).slice(8, 10)) || 1, 28);
    if (!(await confirmAsync('Repeat monthly', `Create "${v.title ?? v.vendor ?? 'this expense'}" as a draft on day ${day} of every month? You still review and submit each one.`, 'Repeat', 'Cancel'))) return;
    try { const r = await api('POST', `/channels/${id}/recurring`, { day_of_month: day, data: { ...v, expense_date: null } }); Alert.alert('Repeating', `First one on ${r.next_run}.`); router.back(); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }
  async function create(v: FormValues, submit: boolean) {
    const threadId = uuid();
    try {
      const r = await send('POST', `/channels/${id}/threads`, { ...v, id: threadId, source_type: 'form', ...(advance ? { kind: 'advance', assigned_to: holder ?? uid } : {}) });
      if (r.queued) {
        if (submit) await send('POST', `/threads/${threadId}/transition`, { to: 'submitted' });
        Alert.alert(tr('Offline: will sync when back online'));
        return router.back();
      }
      if (submit && (await okToSubmit(threadId, tr)))
        await api('POST', `/threads/${threadId}/transition`, { to: 'submitted' }).catch(e => Alert.alert(tr('Draft'), errMsg(e)));
      router.replace(`/thread/${threadId}`);
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'web' ? undefined : 'padding'} keyboardVerticalOffset={insets.top + 56}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 + insets.bottom, maxWidth: 640, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        {advance && <Stack.Screen options={{ title: 'New advance' }} />}
        {advance && members.length > 1 && (
          <View style={{ marginBottom: 20 }}>
            <Chips label="Given to" options={members} value={holder ?? uid} onChange={h => h && setHolder(h)} />
          </View>
        )}
        {!advance && templates.length > 0 && (
          <View style={{ gap: 8, marginBottom: 20 }}>
            <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Start from a template (long press to delete)</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {templates.map(x => (
                <Pressable key={x.id} accessibilityRole="button" onPress={() => setInitial({ key: x.id + Date.now(), values: x.data })} onLongPress={() => deleteTemplate(x.id, x.name)}
                  style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 8, justifyContent: 'center', backgroundColor: t.primarySoft }}>
                  <Text style={{ color: t.primaryDark, fontWeight: '600' }}>{x.name}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        <ExpenseForm key={initial.key} advance={advance} extras={advance ? undefined : [{ label: 'Save as template', icon: 'bookmark-outline', onPress: saveTemplate }, { label: 'Repeat monthly', icon: 'repeat-outline', onPress: repeat }]} workspaceId={channel.workspace_id} baseCurrency={channel.base_currency} initial={initial.values}
          submitLabel={tr('Create & submit')} onSubmit={v => create(v, true)}
          secondary={{ label: tr('Save draft'), onPress: v => create(v, false) }} />
      </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
