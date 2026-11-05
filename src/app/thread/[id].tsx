import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VoicePlayer } from '../../components/VoicePlayer';
import { ImageViewer, openFile } from '../../components/AttachmentViewer';
import { AdvancePanel } from '../../components/AdvancePanel';
import { Composer, MentionText, type Mentionable } from '../../components/Composer';
import { api, errMsg, send, uploadFile, uuid, type Field as AiField, type Member, type Message, type Thread } from '../../lib/api';
import { useUserId } from '../../lib/auth';
import { useChannel } from '../../lib/useChannel';
import { useT } from '../../lib/i18n';
import { ExpenseForm, type FormValues } from '../../components/ExpenseForm';
import { BottomSheet, HeroPanel, Empty, Skeleton, Alert, Avatar, DateField, Button, Chips, Field, OutboxBanner, STATUS_COLOR, StatusPill, money, okToSubmit, confirmAsync, amountText, radius, shadow, useTheme, ago,
  type IconName } from '../../lib/ui';
import { LABEL, allowedTransitions, canComment, canEditFields, isApprover, type Status } from '../../lib/workflow';

const ACTION: Partial<Record<Status, { label: string; icon: IconName }>> = {
  submitted: { label: 'Submit', icon: 'send' }, under_review: { label: 'Start review', icon: 'eye' },
  approved: { label: 'Approve', icon: 'checkmark-circle' }, rejected: { label: 'Reject', icon: 'close-circle' },
  needs_info: { label: 'Ask for info', icon: 'help-circle' }, unpaid: { label: 'Mark unpaid', icon: 'time' }, closed: { label: 'Close', icon: 'lock-closed' },
};
const REACTIONS = ['👍', '✅', '❓', '🙏', '🔥', '😀'];

function PaymentForm({ thread, onDone }: { thread: Thread; onDone: () => void }) {
  const t = useTheme();
  const tr = useT();
  const remaining = Number(thread.amount) - Number(thread.paid_total ?? 0);
  const [amount, setAmount] = useState(remaining.toFixed(2));
  const [method, setMethod] = useState<string | null>(thread.payment_method ?? 'cash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [proof, setProof] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function attachProof() {
    const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'] });
    if (r.canceled) return;
    const f = r.assets[0];
    try {
      const up = await uploadFile(thread.id, f.uri, f.name, f.mimeType ?? 'application/pdf');
      if (up.queued) Alert.alert(tr('Offline: will sync when back online')); else setProof({ id: (up as { id?: string }).id!, name: f.name });
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }
  async function save() {
    setBusy(true);
    try { await api('POST', `/threads/${thread.id}/payments`, { amount: Number(amount), method, reference, paid_on: paidOn, attachment_id: proof?.id }); onDone(); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false);
  }
  return (
    <View style={{ gap: 14, backgroundColor: t.surface, borderRadius: radius.md, padding: 14 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{thread.kind === 'advance' ? 'Record handover' : tr('Record payment')}</Text>
      <Field icon="cash-outline" label={`${tr('Amount')} (up to ${money(remaining, thread.currency)})`} placeholder="0.00" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <Chips label="Paid by" options={[['cash', 'Cash', 'cash-outline'], ['bank_transfer', 'Bank', 'business-outline'], ['card', 'Card', 'card-outline'], ['wallet', 'Wallet', 'wallet-outline']]
        .map(([id, name, icon]) => ({ id, name, icon: icon as IconName }))} value={method} onChange={setMethod} />
      <Field label={tr('Reference no.')} placeholder="Optional" value={reference} onChangeText={setReference} />
      <DateField label={tr('Paid on')} value={paidOn} onChangeText={setPaidOn} />
      <Button kind="ghost" icon="attach" title={proof ? proof.name : 'Attach proof (optional)'} onPress={attachProof} />
      <Button icon="checkmark" title={tr('Record payment')} busy={busy} disabled={!(Number(amount) > 0) || !method} onPress={save} />
    </View>
  );
}


export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const uid = useUserId();
  const t = useTheme();
  const tr = useT();
  const [thread, setThread] = useState<Thread | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<null | { initial: Partial<FormValues>; confidence?: Record<string, AiField> }>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState('');
  const list = useRef<FlatList<Message>>(null);
  const { channel, role, ready } = useChannel(thread?.channel_id);
  const [viewing, setViewing] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState<Mentionable[]>([]);
  useEffect(() => {
    if (!thread?.channel_id) return;
    api<Member[]>('GET', `/channels/${thread.channel_id}/members`)
      .then(r => setMembers(r.filter(m => m.user_id !== uid).map(m => ({ id: m.user_id, name: m.profile?.full_name ?? '', email: m.profile?.email ?? '' }))))
      .catch(() => {});
  }, [thread?.channel_id, uid]);

  const loadThread = useCallback(async () => {
    try { const n = await api<Thread>('GET', `/threads/${id}`); setThread(o => (JSON.stringify(o) === JSON.stringify(n) ? o : n)); setError(''); } catch (e) { setError(errMsg(e)); }
  }, [id]);
  // a failed refresh keeps what's on screen; an unchanged one doesn't re-render
  const loadMsgs = useCallback(async () => { const n = await api<Message[]>('GET', `/threads/${id}/messages`).catch(() => null); if (n) setMsgs(o => (JSON.stringify(o) === JSON.stringify(n) ? o : n)); }, [id]);

  useEffect(() => {
    loadThread(); loadMsgs();
    // ponytail: 5s polling instead of push; swap for WebSocket/SSE if load or latency matters.
    const timer = setInterval(() => { loadThread(); loadMsgs(); }, 5000);
    return () => clearInterval(timer);
  }, [loadThread, loadMsgs]);

  if (!thread) return error ? <Empty icon="alert-circle-outline" title="Couldn't open this expense" hint={error} /> : <Skeleton rows={4} height={110} />;
  if (!ready) return <Skeleton rows={4} height={110} />; // so the buttons don't pop in after the page
  const isAuthor = thread.created_by === uid;
  const editable = canEditFields(thread.status, role, isAuthor);
  const actions = allowedTransitions(thread.status, role, isAuthor).filter(a => a.to !== 'paid'); // paid comes from payments
  const canPay = isApprover(role) && ['approved', 'unpaid'].includes(thread.status);
  const needsForm = editable && (thread.amount == null || (thread.source_type !== 'form' && !thread.extraction));
  const refresh = () => { loadThread(); loadMsgs(); };
  const paidPct = thread.amount ? Math.min(Number(thread.paid_total ?? 0) / Number(thread.amount), 1) : 0;

  async function transition(to: Status, reasonRequired?: boolean) {
    if (reasonRequired && !text.trim()) return Alert.alert(tr('Reopen'), 'Type the reason in the reply box first.');
    // error prevention: these end the discussion for the author, so ask first
    if ((to === 'rejected' || to === 'closed') && !(await confirmAsync(tr(to === 'rejected' ? 'Reject' : 'Close'),
      `${to === 'rejected' ? 'Reject' : 'Close'} "${thread!.title ?? 'this expense'}"?${text.trim() ? `\n\nNote: ${text.trim()}` : ' Tip: type a reason in the reply box first.'}`,
      tr(to === 'rejected' ? 'Reject' : 'Close'), tr('Cancel')))) return;
    if (to === 'submitted' && !(await okToSubmit(id, tr))) return;
    setBusy(true);
    try { await api('POST', `/threads/${id}/transition`, { to, comment: text.trim() || null }); setText(''); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false); refresh();
  }

  async function convertToForm() {
    setBusy(true);
    try {
      const r = await api<{ fields: Record<string, AiField>; category_id: string | null; line_items?: { description: string; amount: number | null }[] }>('POST', `/threads/${id}/extract`);
      const f = r.fields, val = (k: string) => f[k]?.value ?? null;
      const method = ['cash', 'bank_transfer', 'card', 'wallet'].includes(String(val('payment_method'))) ? String(val('payment_method')) : null;
      setEditing({
        confidence: f,
        initial: {
          title: (val('title') as string) ?? thread!.title, amount: val('amount') as number | null, currency: (val('currency') as string) ?? thread!.currency,
          expense_date: (val('expense_date') as string) ?? thread!.expense_date, vendor: val('vendor') as string | null,
          category_id: r.category_id, payment_method: method,
          line_items: r.line_items?.filter(i => i.description && i.amount != null).map(i => ({ description: i.description, qty: 1, amount: i.amount! })) || thread!.line_items,
          notes: [val('notes'), f.tax?.value != null ? `Tax: ${f.tax.value}` : null].filter(Boolean).join('\n') || null,
        },
      });
    } catch (e) {
      Alert.alert('AI', `${errMsg(e)}\n\nYou can fill the form manually.`);
      setEditing({ initial: thread! });
    }
    setBusy(false);
  }

  async function sendComment() {
    const body = text.trim();
    if (!body) return;
    try {
      const r = await send('POST', `/threads/${id}/messages`, { id: uuid(), body, reply_to: replyTo?.id });
      setText(''); setReplyTo(null);
      if (r.queued) Alert.alert(tr('Offline: will sync when back online')); else { await loadMsgs(); setTimeout(() => list.current?.scrollToEnd(), 100); }
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  async function attach() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], multiple: true });
    if (res.canceled) return;
    setBusy(true);
    try { for (const f of res.assets) await uploadFile(id, f.uri, f.name, f.mimeType ?? 'application/octet-stream'); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false); loadMsgs();
  }

  async function react(m: Message, emoji: string) {
    setPicked(null);
    await api('POST', `/messages/${m.id}/react`, { emoji }).catch(e => Alert.alert(tr('Error'), errMsg(e)));
    loadMsgs();
  }

  if (editing && channel) {
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'web' ? undefined : 'padding'} keyboardVerticalOffset={insets.top + 56}>
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: tr(editing.confidence ? 'Convert to form' : 'Edit') }} />
        {editing.confidence && (
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: t.primarySoft, padding: 14, borderRadius: radius.md }}>
            <Ionicons name="sparkles" size={20} color={t.primaryDark} />
            <Text style={{ color: t.primaryDark, flex: 1, fontWeight: '600' }}>AI filled this form. Review highlighted fields, then save.</Text>
          </View>
        )}
        <ExpenseForm workspaceId={channel.workspace_id} baseCurrency={channel.base_currency} initial={editing.initial}
          confidence={editing.confidence} submitLabel={tr('Save changes')} onSubmit={async v => {
            try { await api('PATCH', `/threads/${id}`, { ...v, if_updated_at: thread!.updated_at }); }
            catch (e) { return Alert.alert(tr('Error'), errMsg(e)); }
            await api('POST', `/threads/${id}/messages`, { body: editing.confidence ? 'converted to form (reviewed)' : 'edited the expense details' }).catch(() => {});
            setEditing(null); refresh();
          }} />
        <Button kind="text" title={tr('Cancel edit')} onPress={() => setEditing(null)} />
      </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  const title = thread.title || thread.vendor || (thread.source_type === 'voice' ? 'Voice note' : thread.source_type === 'photo' ? 'Receipt photo' : tr('Draft'));
  // Voice/photo expenses: the author's opening media (and its transcript) is the body of post #1, chat-style, not a reply.
  const origin = new Set<string>();
  if (thread.source_type !== 'form') {
    for (const m of msgs) {
      const media = ['image', 'voice', 'file'].includes(m.type) && m.author_id === thread.created_by;
      const transcript = m.type === 'system' && /^(\S+ )?Transcri/.test(m.body ?? '');
      if (media || transcript) origin.add(m.id);
      else if (m.type === 'text') break; // the discussion has started
    }
  }
  const originMsgs = msgs.filter(m => origin.has(m.id));
  // evidence files live in the advance account, not in the discussion
  const evidence = new Set((thread.settlements ?? []).map(s => s.attachment_id));
  const feed = msgs.filter(m => !origin.has(m.id) && !(m.attachment_id && evidence.has(m.attachment_id)));
  const replies = feed.filter(m => m.type !== 'system').length;
  const myTurn = actions.length > 0 || canPay;
  const NEXT: Record<Status, [string, string]> = { // [your turn, someone else's turn]
    draft: ['Fill in the details, then submit it for approval.', 'Draft: the author has not submitted it yet.'],
    submitted: ['Review this expense: approve it, reject it or ask for info.', 'Submitted. Waiting for an approver.'],
    under_review: ['Approve it, reject it or ask for more info.', 'Under review by an approver.'],
    needs_info: ['The approver needs more info. Reply below or edit, then submit again.', 'Waiting for the author to add the info asked for.'],
    approved: ['Approved. Record the payment when it is paid.', 'Approved. Waiting for payment.'],
    unpaid: ['Approved but unpaid. Record the payment when it is paid.', 'Approved. Waiting for payment.'],
    paid: ['Paid in full. Close it when nothing else is needed.', 'Paid in full.'],
    rejected: ['Rejected. You can reopen it with a reason.', 'Rejected.'],
    closed: ['Closed. Reopen it if something changed.', 'Closed.'],
  };
  const isAdvance = thread.kind === 'advance';
  const canAccount = isAdvance && (isApprover(role) || (thread.assigned_to ?? thread.created_by) === uid);
  const owing = (thread.balance?.outstanding ?? 0) > 0.005;
  const nextStep = !isAdvance || !['approved', 'unpaid', 'paid'].includes(thread.status) ? NEXT[thread.status][myTurn ? 0 : 1]
    : thread.status === 'approved' ? (canPay ? 'Approved. Hand over the money, then record it.' : 'Approved. Waiting for the handover.')
    : (thread.balance?.pending ?? 0) > 0 && isApprover(role) ? 'Review the evidence below: accept or reject each item.'
    : (thread.balance?.outstanding ?? 0) < -0.005 ? (isApprover(role) ? 'The holder spent more than was given. Record the amount paid back to them.' : 'You spent more than you were given. Waiting for the amount to be paid back.')
    : owing ? (canAccount ? 'Add evidence for what was spent, or record cash returned.' : 'Waiting for the holder to provide evidence.')
    : isApprover(role) ? 'Everything is accounted for. Review the evidence, then close.' : 'Everything is accounted for. Waiting for an approver to close.';
  const statusText = (s: string | null) => (s ?? '').replace(/\b(draft|submitted|under_review|approved|rejected|needs_info|unpaid|paid|closed)\b/g,
    k => tr(LABEL[k as Status]));
  const details = ([
    ['person-outline', 'Given to', isAdvance ? thread.holder?.full_name ?? thread.author?.full_name : null],
    ['alarm-outline', 'Evidence due', isAdvance ? thread.due_date : null],
    ['storefront-outline', 'Vendor', thread.vendor],
    ['pricetag-outline', 'Category', thread.category?.name],
    ['calendar-outline', 'Date', thread.expense_date],
    ['card-outline', 'Payment', thread.payment_method?.replace('_', ' ')],
    ['folder-outline', 'Tag', thread.tag],
    ['alarm-outline', 'Due', isAdvance ? null : thread.due_date],
    ['swap-horizontal', 'Rate', thread.fx_rate && thread.currency !== thread.base_currency ? `1 ${thread.currency} = ${thread.fx_rate} ${thread.base_currency}` : null],
  ] as [IconName, string, string | null | undefined][]).filter((d): d is [IconName, string, string] => !!d[2]);
  const Summary = (
    <View style={{ gap: 14, paddingBottom: 4 }}>
      <View style={{ borderRadius: 24, ...shadow(t) }}>
        <HeroPanel style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ borderRadius: 19, backgroundColor: t.card }}><Avatar name={thread.author?.full_name ?? '?'} size={38} /></View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.onHero, fontWeight: '700' }} numberOfLines={1}>{thread.author?.full_name}</Text>
              <Text style={{ color: t.onHero, fontSize: 12, opacity: 0.9 }} numberOfLines={1}>{isAdvance ? 'Advance · ' : ''}{ago(thread.created_at)}{channel ? ` · #${channel.name}` : ''}</Text>
            </View>
            <View style={{ backgroundColor: t.card, borderRadius: radius.pill }}><StatusPill status={thread.status} advance={thread.kind === 'advance'} /></View>
          </View>
          <View style={{ gap: 2 }}>
            <Text accessibilityRole="header" style={{ color: t.onHero, fontSize: 18, fontWeight: '600' }}>{title}</Text>
            {thread.amount != null
              ? <Text style={{ color: t.onHero, fontSize: 32, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] }} numberOfLines={1} adjustsFontSizeToFit>{money(thread.amount, thread.currency)}</Text>
              : <Text style={{ color: t.onHero, fontSize: 14 }}>No amount yet</Text>}
          </View>
        </HeroPanel>
        <View style={{ padding: 16, gap: 14 }}>
        {originMsgs.length > 0 && (
          <View style={{ gap: 10 }}>
            {originMsgs.map(m => {
              const url = m.attachment?.url;
              if (m.type === 'system') return (
                <View key={m.id} style={{ backgroundColor: t.surface, borderRadius: radius.md, padding: 12, gap: 4 }}>
                  <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700' }}>{(m.body ?? '').split(':')[0].replace(/^\S+ (?=Transcri)/, '')}</Text>
                  <Text style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{(m.body ?? '').split(':').slice(1).join(':').trim()}</Text>
                </View>
              );
              if (m.type === 'image' && url) return (
                <Pressable key={m.id} accessibilityRole="imagebutton" accessibilityLabel={`Open receipt ${m.body ?? ''}`} onPress={() => setViewing(url)}>
                  <Image source={{ uri: url }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: radius.md, backgroundColor: t.surface }} resizeMode="cover" />
                </Pressable>
              );
              if (m.type === 'voice' && url) return (
                <View key={m.id} style={{ backgroundColor: t.surface, borderRadius: radius.md, padding: 10 }}><VoicePlayer url={url} mine={false} /></View>
              );
              return url ? (
                <Pressable key={m.id} accessibilityRole="link" onPress={() => openFile(url, m.attachment?.mime ?? 'application/pdf', m.body ?? 'attachment.pdf')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface, padding: 12, borderRadius: radius.md, minHeight: 48 }}>
                  <Ionicons name="document-text" size={24} color={t.danger} />
                  <Text style={{ color: t.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>{m.body}</Text>
                  <Ionicons name="open-outline" size={18} color={t.muted} />
                </Pressable>
              ) : null;
            })}
          </View>
        )}
        <>
          {details.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
              {details.map(([icon, label, value]) => (
                <View key={label} style={{ width: '50%', flexDirection: 'row', gap: 8, paddingRight: 8 }}>
                  <Ionicons name={icon} size={16} color={t.primary} style={{ marginTop: 1 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.muted, fontSize: 12 }}>{label}</Text>
                    <Text style={{ color: t.text, fontSize: 14, fontWeight: '600' }}>{value}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
          {!!thread.line_items?.length && (
            <View accessibilityLabel={`${thread.line_items.length} line items`} style={{ borderRadius: radius.md, backgroundColor: t.surface, padding: 12, gap: 8 }}>
              {thread.line_items.map((i, n) => (
                <View key={n} style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}>
                  <Text style={{ color: t.text, fontSize: 14, flex: 1 }}>{i.description}{i.qty !== 1 ? <Text style={{ color: t.muted }}>  {i.qty} × {amountText(Number(i.amount))}</Text> : null}{i.category_name ? <Text style={{ color: t.muted }}>{'\n'}{i.category_name}</Text> : null}</Text>
                  <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{money(i.qty * i.amount, thread.currency)}</Text>
                </View>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderColor: t.border }}>
                <Text style={{ color: t.text, fontWeight: '700' }}>Total · {thread.line_items.length} items</Text>
                <Text style={{ color: t.text, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{money(thread.amount, thread.currency)}</Text>
              </View>
            </View>
          )}
          {thread.notes ? <Text style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{thread.notes}</Text> : null}
          {isAdvance && thread.balance && (
            <AdvancePanel thread={thread} canAct={canAccount} canReview={isApprover(role)} uid={uid} isOwner={role === 'owner'} onChanged={refresh}
              onOpen={s => { if (s.attachment) { if (s.attachment.mime.startsWith('image/')) setViewing(s.attachment.url); else openFile(s.attachment.url, s.attachment.mime, s.description + '.pdf'); } }} />
          )}
          {!!thread.paid_total && thread.kind !== 'advance' && (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>{tr('Paid so far')}</Text>
                <Text style={{ color: t.text, fontSize: 12, fontWeight: '700' }}>{money(thread.paid_total, thread.currency)} / {money(thread.amount, thread.currency)}</Text>
              </View>
              <View style={{ height: 8, borderRadius: 4, backgroundColor: t.surface }}>
                <View style={{ height: 8, borderRadius: 4, width: `${paidPct * 100}%`, backgroundColor: STATUS_COLOR.paid }} />
              </View>
            </View>
          )}
          {!!thread.approvals?.length && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Ionicons name="shield-checkmark" size={14} color={STATUS_COLOR.approved} />
              <Text style={{ color: t.muted, fontSize: 12 }}>Approved by {thread.approvals.map(a => `${a.full_name} (${a.role})`).join(' → ')}</Text>
            </View>
          )}
          {needsForm && (
            <Pressable onPress={convertToForm} accessibilityRole="button"
              style={{ flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: t.primarySoft, padding: 14, borderRadius: radius.md }}>
              <Ionicons name="sparkles" size={22} color={t.primaryDark} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.primaryDark, fontWeight: '800' }}>{tr('Convert to form')}</Text>
                <Text style={{ color: t.primaryDark, fontSize: 12 }}>AI reads the voice note / receipt and fills the details</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={t.primaryDark} />
            </Pressable>
          )}
          <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: radius.md,
            backgroundColor: myTurn ? t.primarySoft : t.surface }}>
            <Ionicons name={myTurn ? 'arrow-forward-circle' : 'time-outline'} size={20} color={myTurn ? t.primaryDark : t.muted} />
            <Text style={{ color: myTurn ? t.primaryDark : t.text, fontSize: 14, flex: 1, fontWeight: myTurn ? '700' : '500' }}>{nextStep}</Text>
          </View>
          {(actions.length > 0 || canPay || editable) && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderTopWidth: 1, borderColor: t.border, paddingTop: 12 }}>
              {actions.map(a => {
                const act = thread.status === 'closed' ? { label: 'Reopen', icon: 'refresh' as IconName } : ACTION[a.to] ?? { label: LABEL[a.to], icon: 'arrow-forward' as IconName };
                return <Button key={a.to} small busy={busy} icon={act.icon} kind={a.to === 'rejected' ? 'danger' : a.to === 'approved' || a.to === 'submitted' ? 'primary' : 'ghost'}
                  title={tr(act.label)} onPress={() => transition(a.to, a.reasonRequired)} />;
              })}
              {canPay && <Button small kind={paying ? 'primary' : 'ghost'} icon="cash" title={isAdvance ? 'Record handover' : tr('Record payment')} onPress={() => setPaying(!paying)} />}
              {editable && <Button small kind="ghost" icon="create-outline" title={tr('Edit')} onPress={() => setEditing({ initial: thread })} />}
            </View>
          )}
          {paying && canPay && <PaymentForm thread={thread} onDone={() => { setPaying(false); refresh(); }} />}
        </>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
        <Ionicons name="chatbubbles-outline" size={16} color={t.muted} />
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', }}>
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: t.border }} />
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === 'web' ? undefined : 'padding'} keyboardVerticalOffset={insets.top + 56}>
      <ImageViewer url={viewing} onClose={() => setViewing(null)} />
      {(() => { const m = msgs.find(x => x.id === picked); return (
        <BottomSheet visible={!!m} onClose={() => setPicked(null)}>
          {m && <View style={{ backgroundColor: t.primary, borderRadius: radius.md, padding: 12 }}><Text style={{ color: t.primaryText }} numberOfLines={3}>{m.body}</Text></View>}
          <Text style={{ color: t.text, fontWeight: '700' }}>React</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {REACTIONS.map(e => <Pressable key={e} onPress={() => m && react(m, e)} accessibilityLabel={`React ${e}`} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 26 }}>{e}</Text></Pressable>)}
          </View>
          <Pressable accessibilityRole="button" onPress={() => { if (m) setReplyTo(m); setPicked(null); }} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48 }}>
            <Text style={{ color: t.text, fontSize: 15 }}>{tr('Reply')}</Text><Ionicons name="arrow-undo-outline" size={20} color={t.text} />
          </Pressable>
        </BottomSheet>); })()}
      <Stack.Screen options={{ headerTitle: () => (
        <View>
          <Text style={{ color: t.text, fontWeight: '800', fontSize: 16 }} numberOfLines={1}>{title}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>{channel ? `#${channel.name} · ` : ''}{replies} {replies === 1 ? 'reply' : 'replies'}</Text>
        </View>) }} />
      <OutboxBanner />
      <View style={{ flex: 1, width: '100%', maxWidth: 860, alignSelf: 'center' }}>
        <FlatList
          ref={list}
          data={feed}
          keyExtractor={m => m.id}
          ListHeaderComponent={Summary}
          ListFooterComponent={replies === 0 ? (
            <View style={{ alignItems: 'center', padding: 24, gap: 6 }}>
              <Ionicons name="chatbubble-ellipses-outline" size={28} color={t.faint} />
              <Text style={{ color: t.muted, fontWeight: '600' }}>No replies yet</Text>
              <Text style={{ color: t.faint, fontSize: 13 }}>Ask a question or add a note below.</Text>
            </View>) : undefined}
          contentContainerStyle={{ gap: 10, padding: 12, paddingBottom: 24 }}
          renderItem={({ item: m }) => {
            if (m.type === 'system') return (
              <View style={{ alignSelf: 'center', maxWidth: '92%', backgroundColor: t.surface, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center' }}>{statusText(m.body)} · {ago(m.created_at)}</Text>
              </View>
            );
            const mine = m.author_id === uid;
            const url = m.attachment?.url;
            return (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Avatar name={m.author?.full_name ?? '?'} size={34} />
                <View style={{ flex: 1, gap: 2 }}>
                <View style={{ backgroundColor: mine ? t.primarySoft : t.card, borderRadius: radius.lg, borderTopLeftRadius: 6, padding: 12, gap: 6, ...(mine ? {} : shadow(t)), shadowOpacity: mine ? 0 : 0.05 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                    <Text style={{ color: t.text, fontWeight: '700', flex: 1 }} numberOfLines={1}>{mine ? 'You' : m.author?.full_name}</Text>
                    <Text style={{ color: t.muted, fontSize: 12 }}>{ago(m.created_at)}</Text>
                  </View>
                  {m.reply && (
                    <View style={{ borderLeftWidth: 3, borderColor: t.primary, paddingLeft: 8, paddingVertical: 4, backgroundColor: t.surface + 'AA', borderRadius: 8 }}>
                      <Text style={{ color: t.primary, fontSize: 11, fontWeight: '700' }}>↳ {tr('Reply')} · {m.reply.author ?? ''}</Text>
                      <Text style={{ color: t.text, fontSize: 12 }} numberOfLines={2}>{m.reply.body}</Text>
                    </View>
                  )}
                  {m.type === 'image' && url ? (
                    <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open image ${m.body}`} onPress={() => setViewing(url)}>
                      <Image source={{ uri: url }} style={{ width: 240, height: 240, borderRadius: 14 }} resizeMode="cover" />
                    </Pressable>
                  ) : m.type === 'voice' && url ? <VoicePlayer url={url} mine={mine} />
                    : m.type === 'file' && url ? (
                    <Pressable accessibilityRole="link" onPress={() => openFile(url, m.attachment?.mime ?? 'application/pdf', m.body ?? 'attachment.pdf')}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface, padding: 10, borderRadius: 12 }}>
                      <Ionicons name="document" size={26} color={t.danger} />
                      <Text style={{ color: t.text, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>{m.body}</Text>
                    </Pressable>
                  ) : <MentionText body={m.body ?? ''} style={{ color: t.text, fontSize: 15, lineHeight: 22 }} />}
                </View>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {Object.entries(m.reactions ?? {}).map(([e, users]) => (
                      <Pressable key={e} onPress={() => canComment(role) && react(m, e)} accessibilityLabel={`${e} ${users.length}`}
                        style={{ backgroundColor: users.includes(uid) ? t.primarySoft : t.card, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2,
                          borderWidth: 1, borderColor: t.border }}>
                        <Text style={{ fontSize: 12, color: t.text }}>{e} {users.length}</Text>
                      </Pressable>
                    ))}
                    {canComment(role) && <>
                      <Pressable accessibilityRole="button" accessibilityLabel="Add reaction" onPress={() => setPicked(picked === m.id ? null : m.id)}
                        hitSlop={8} style={{ minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="happy-outline" size={20} color={t.muted} /></Pressable>
                      <Pressable accessibilityRole="button" onPress={() => setReplyTo(m)} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 8 }}>
                        <Ionicons name="arrow-undo-outline" size={16} color={t.primary} />
                        <Text style={{ color: t.primary, fontWeight: '700', fontSize: 13 }}>{tr('Reply')}</Text>
                      </Pressable>
                    </>}
                  </View>
                </View>
              </View>
            );
          }}
        />
        {canComment(role) && !paying && !picked && (
          <Composer value={text} onChange={setText} onSend={sendComment} members={members}
            onAttach={thread.status !== 'closed' ? attach : undefined}
            placeholder={tr('Write a reply')}
            replyTo={replyTo ? { author: replyTo.author?.full_name ?? '', body: replyTo.body ?? '' } : null} onCancelReply={() => setReplyTo(null)} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
