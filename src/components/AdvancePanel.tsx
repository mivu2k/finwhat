import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { api, errMsg, uploadFile, type Settlement, type Thread } from '../lib/api';
import { Alert, Button, Chips, DateField, Field, IconButton, confirmAsync, money, radius, useTheme } from '../lib/ui';

type Picked = { uri: string; name: string; mime: string };

function Row({ label, value, cur, strong, color }: { label: string; value: number; cur: string; strong?: boolean; color?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
      <Text style={{ color: strong ? t.text : t.muted, fontSize: 14, fontWeight: strong ? '700' : '400' }}>{label}</Text>
      <Text style={{ color: color ?? t.text, fontSize: 14, fontWeight: strong ? '800' : '600', fontVariant: ['tabular-nums'] }}>{money(value, cur)}</Text>
    </View>
  );
}

/** The money trail of an advance: issued, spent with evidence, returned, balance; and how the holder accounts for it. */
export function AdvancePanel({ thread, canAct, canReview, uid, isOwner, onChanged, onOpen }: {
  thread: Thread; canAct: boolean; canReview: boolean; uid: string; isOwner: boolean; onChanged: () => void; onOpen: (s: Settlement) => void;
}) {
  const t = useTheme();
  const b = thread.balance!;
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'expense' | 'returned' | null>('expense');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [file, setFile] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  async function review(s: Settlement, decision: 'accepted' | 'rejected') {
    try { await api('POST', `/threads/${thread.id}/settlements/${s.id}/review`, { decision, note }); setRejecting(null); setNote(''); onChanged(); }
    catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  async function reimburse() {
    const owed = -b.outstanding;
    if (!(await confirmAsync('Pay back the holder', `Record that ${money(owed, cur)} was paid back to the holder?`, 'Record', 'Cancel'))) return;
    try { await api('POST', `/threads/${thread.id}/settlements`, { kind: 'reimbursed', amount: owed }); onChanged(); }
    catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  const cur = thread.currency;
  const open = ['unpaid', 'paid'].includes(thread.status);
  const n = Number(amount.replace(/,/g, ''));
  const returned = kind === 'returned';
  const problem = !(n > 0) ? 'Enter the amount.' : returned ? (n > b.outstanding + 0.005 ? `Only ${money(b.outstanding, cur)} is outstanding.` : '')
    : !description.trim() ? 'Say what it was spent on.' : !file ? 'Attach the receipt or other evidence.' : '';

  async function pickFile() {
    const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'] });
    if (!r.canceled) { const f = r.assets[0]; setFile({ uri: f.uri, name: f.name, mime: f.mimeType ?? 'application/pdf' }); }
  }
  async function takePhoto() {
    if (!(await ImagePicker.requestCameraPermissionsAsync()).granted) return Alert.alert('Camera permission denied');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!r.canceled) { const f = r.assets[0]; setFile({ uri: f.uri, name: f.fileName ?? `evidence-${Date.now()}.jpg`, mime: f.mimeType ?? 'image/jpeg' }); }
  }
  async function save() {
    setBusy(true);
    try {
      let attachment_id: string | undefined;
      if (!returned && file) {
        const up = await uploadFile(thread.id, file.uri, file.name, file.mime);
        if (up.queued) throw new Error('You need a connection to submit evidence.');
        attachment_id = (up as { id?: string }).id;
      }
      await api('POST', `/threads/${thread.id}/settlements`, { kind: returned ? 'returned' : 'expense', description: returned ? 'Cash returned' : description, amount: n, spent_on: day, attachment_id });
      setAdding(false); setDescription(''); setAmount(''); setFile(null); onChanged();
    } catch (e) { Alert.alert('Error', errMsg(e)); }
    setBusy(false);
  }
  async function remove(s: Settlement) {
    if (!(await confirmAsync('Remove entry', `Remove "${s.description}" (${money(s.amount, cur)})?`, 'Remove', 'Cancel'))) return;
    try { await api('DELETE', `/threads/${thread.id}/settlements/${s.id}`); onChanged(); } catch (e) { Alert.alert('Error', errMsg(e)); }
  }

  const over = b.outstanding < -0.005;
  return (
    <View style={{ gap: 12, backgroundColor: t.surface, borderRadius: radius.md, padding: 12 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>Advance account</Text>
      <View style={{ gap: 6 }}>
        <Row cur={cur} label="Handed over" value={b.issued} />
        <Row cur={cur} label="Spent, with evidence" value={b.spent} />
        <Row cur={cur} label="Cash returned" value={b.returned} />
        {b.reimbursed > 0 && <Row cur={cur} label="Paid back to holder" value={b.reimbursed} />}
        <View style={{ height: 1, backgroundColor: t.border, marginVertical: 2 }} />
        <Row cur={cur} strong label={over ? 'Owed to the holder' : 'Still to account for'} value={Math.abs(b.outstanding)} color={b.outstanding > 0.005 ? t.danger : over ? t.warn : t.primary} />
      </View>
      {(thread.settlements ?? []).map(s => (
        <View key={s.id} style={{ backgroundColor: t.card, borderRadius: radius.sm, paddingLeft: 10, gap: 4, paddingBottom: s.kind === 'expense' ? 8 : 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52 }}>
            <Pressable disabled={!s.attachment} accessibilityRole={s.attachment ? 'link' : undefined} accessibilityLabel={`Open evidence for ${s.description}`} onPress={() => onOpen(s)}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}>
              <Ionicons name={s.kind !== 'expense' ? 'return-down-back' : s.attachment?.mime === 'application/pdf' ? 'document-text' : 'image'} size={20} color={t.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', textDecorationLine: s.review_status === 'rejected' ? 'line-through' : 'none' }} numberOfLines={1}>{s.description}</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>{s.spent_on} · {s.by_name}</Text>
              </View>
              <Text style={{ color: t.text, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{money(s.amount, cur)}</Text>
            </Pressable>
            {canAct && open && (s.review_status !== 'accepted' || canReview) ? <IconButton name="trash-outline" size={18} color={t.danger} label={`Remove ${s.description}`} onPress={() => remove(s)} /> : <View style={{ width: 8 }} />}
          </View>
          {s.kind === 'expense' && (
            <View style={{ paddingRight: 10, gap: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: s.review_status === 'accepted' ? t.primary : s.review_status === 'rejected' ? t.danger : t.warn }}>
                {s.review_status === 'accepted' ? 'Accepted' : s.review_status === 'rejected' ? `Rejected: ${s.review_note ?? ''}` : 'Waiting for review'}
              </Text>
              {canReview && open && (s.created_by !== uid || isOwner) && (rejecting === s.id ? (
                <View style={{ gap: 8 }}>
                  <Field label="Why is it rejected?" placeholder="Receipt is not readable" value={note} onChangeText={setNote} />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button small kind="ghost" title="Cancel" onPress={() => { setRejecting(null); setNote(''); }} />
                    <Button small kind="danger" title="Reject" disabled={!note.trim()} onPress={() => review(s, 'rejected')} />
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {s.review_status !== 'accepted' && <Button small icon="checkmark" title="Accept" onPress={() => review(s, 'accepted')} />}
                  {s.review_status !== 'rejected' && <Button small kind="danger" title="Reject" onPress={() => { setNote(''); setRejecting(s.id); }} />}
                </View>
              ))}
            </View>
          )}
        </View>
      ))}
      {canReview && open && over && <Button small icon="cash-outline" title={`Record ${money(-b.outstanding, cur)} paid back to holder`} onPress={reimburse} />}
      {b.pending > 0 && <Text style={{ color: t.warn, fontSize: 13, fontWeight: '600' }}>{money(b.pending, cur)} of evidence is waiting for review.</Text>}
      {canAct && open && !adding && <Button small icon="add" title="Add evidence or returned cash" onPress={() => { setAmount(b.outstanding > 0 ? b.outstanding.toFixed(2) : ''); setAdding(true); }} />}
      {adding && (
        <View style={{ gap: 12 }}>
          <Chips options={[{ id: 'expense' as const, name: 'Spent', icon: 'receipt-outline' as const }, { id: 'returned' as const, name: 'Cash returned', icon: 'cash-outline' as const }]}
            value={kind} onChange={k => k && setKind(k)} />
          {!returned && <Field label="What was it spent on?" placeholder="Fuel, site visit" value={description} onChangeText={setDescription} />}
          <Field label={`Amount (${cur})`} placeholder="0.00" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <DateField label="Date" value={day} onChangeText={setDay} />
          {!returned && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>Evidence (required)</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {Platform.OS !== 'web' && <Button small kind="ghost" icon="camera-outline" title="Take photo" onPress={takePhoto} />}
                <Button small kind="ghost" icon="attach" title="Choose file" onPress={pickFile} />
              </View>
              {file && <Text style={{ color: t.primary, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>Attached: {file.name}</Text>}
            </View>
          )}
          {problem ? <Text style={{ color: t.muted, fontSize: 13 }}>{problem}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button small kind="ghost" title="Cancel" onPress={() => setAdding(false)} />
            <Button small title="Save" busy={busy} disabled={!!problem} onPress={save} />
          </View>
        </View>
      )}
    </View>
  );
}
