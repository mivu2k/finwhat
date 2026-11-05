import { useCallback, useState, type ReactNode } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, type Field as AiField, type LineItem, type Thread } from '../lib/api';
import { useT } from '../lib/i18n';
import { amountText, Button, Chips, DateField, Field, IconButton, useTheme, type IconName } from '../lib/ui';

export type FormValues = Pick<Thread, 'title' | 'amount' | 'currency' | 'expense_date' | 'category_id' | 'vendor'
  | 'payment_method' | 'tag' | 'notes' | 'due_date' | 'fx_rate' | 'line_items'>;

const METHODS: [string, string, IconName][] = [['cash', 'Cash', 'cash-outline'], ['bank_transfer', 'Bank', 'business-outline'],
  ['card', 'Card', 'card-outline'], ['wallet', 'Wallet', 'wallet-outline']];
function Section({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
      <View style={{ backgroundColor: t.card, borderRadius: 18, padding: 16, gap: 16, borderWidth: 1, borderColor: t.border }}>{children}</View>
    </View>
  );
}
const LOW = 0.7; // confidence below this is highlighted for review

export function ExpenseForm({ workspaceId, baseCurrency, initial, confidence, submitLabel, onSubmit, secondary, advance, extras }: {
  workspaceId: string; baseCurrency: string; initial: Partial<FormValues>; confidence?: Record<string, AiField>;
  submitLabel: string; onSubmit: (v: FormValues) => Promise<void>;
  secondary?: { label: string; onPress: (v: FormValues) => Promise<void> }; advance?: boolean; extras?: { label: string; icon: IconName; onPress: (v: FormValues) => Promise<void> }[];
}) {
  const t = useTheme();
  const tr = useT();
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(!!(initial.tag || initial.due_date));
  const [v, setV] = useState({
    title: initial.title ?? '', amount: initial.amount != null ? Number(initial.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
    currency: initial.currency ?? baseCurrency, expense_date: initial.expense_date ?? new Date().toISOString().slice(0, 10),
    category_id: initial.category_id ?? null, vendor: initial.vendor ?? '', payment_method: initial.payment_method ?? null,
    tag: initial.tag ?? '', notes: initial.notes ?? '', due_date: initial.due_date ?? '', fx_rate: initial.fx_rate != null ? String(initial.fx_rate) : '',
  });
  const set = (k: keyof typeof v) => (x: string | null) => setV(s => ({ ...s, [k]: x }));
  // line items: strings while editing; the amount becomes their total
  type Row = { key: string; description: string; qty: string; amount: string; category_id: string | null };
  const toRow = (i: LineItem, n: number): Row => ({ key: `r${n}`, description: i.description, qty: String(i.qty ?? 1), amount: i.amount == null ? '' : Number(i.amount).toFixed(2), category_id: i.category_id ?? null });
  const [items, setItems] = useState<Row[]>((initial.line_items ?? []).map(toRow));
  const cleanNum = (x: string) => x.replace(/[^\d.,]/g, '');
  const pretty = (x: string) => (x && Number.isFinite(Number(x.replace(/,/g, ''))) ? amountText(Number(x.replace(/,/g, ''))) : x);
  const num = (x: string) => Number(x.replace(/,/g, ''));
  const itemsTotal = Math.round(items.reduce((s, i) => s + (num(i.qty || '1') || 0) * (num(i.amount) || 0), 0) * 100) / 100;
  const itemsOk = items.every(i => i.description.trim() && i.amount !== '' && num(i.amount) >= 0 && num(i.qty || '1') > 0);
  const setItem = (key: string, k: keyof Row) => (x: string) => setItems(r => r.map(i => (i.key === key ? { ...i, [k]: x } : i)));
  const addItem = () => setItems(r => [...r, { key: `n${Date.now()}`, description: '', qty: '1', amount: '', category_id: null }]);

  // on focus, so categories added on the Categories screen show up on return
  useFocusEffect(useCallback(() => {
    api('GET', `/workspaces/${workspaceId}/categories`).then(setCats).catch(() => {});
  }, [workspaceId]));

  const amount = items.length ? itemsTotal : Number(v.amount.replace(/,/g, ''));
  const foreign = v.currency.toUpperCase() !== baseCurrency;
  const valid = (items.length ? itemsOk : v.amount !== '') && Number.isFinite(amount) && amount >= 0 && /^[A-Za-z]{3}$/.test(v.currency)
    && /^\d{4}-\d{2}-\d{2}$/.test(v.expense_date) && (!v.due_date || /^\d{4}-\d{2}-\d{2}$/.test(v.due_date))
    && (!v.fx_rate || Number(v.fx_rate) > 0);

  // AI-prefilled fields show their confidence; low ones get a warning border + label
  const conf = (k: string) => confidence?.[k]?.confidence;
  const low = (k: string) => conf(k) != null && conf(k)! < LOW;
  const hint = (k: string) => conf(k) == null ? '' : `  ·  AI ${Math.round(conf(k)! * 100)}%${low(k) ? ' ⚠' : ''}`;
  const warn = (k: string) => (low(k) ? { borderColor: t.warn } : undefined);

  const values = (): FormValues => ({
    title: v.title.trim() || null, amount, currency: v.currency.toUpperCase(), expense_date: v.expense_date,
    category_id: v.category_id, vendor: v.vendor.trim() || null, payment_method: v.payment_method, tag: v.tag.trim() || null,
    notes: v.notes.trim() || null, due_date: v.due_date || null, fx_rate: foreign && v.fx_rate ? Number(v.fx_rate) : null,
    line_items: items.length ? items.map(i => ({ description: i.description.trim(), qty: num(i.qty || '1'), amount: num(i.amount), category_id: i.category_id })) : null,
  });
  const run = (fn: (x: FormValues) => Promise<void>) => async () => { setBusy(true); try { await fn(values()); } finally { setBusy(false); } };

  const problem = items.length && !itemsOk ? 'Each item needs a description and a price.' : !items.length && v.amount === '' ? 'Enter the amount to continue.' : !(Number.isFinite(amount) && amount >= 0) ? 'The amount must be a number.'
    : !/^[A-Za-z]{3}$/.test(v.currency) ? 'Currency must be a 3-letter code, like PKR.' : !/^\d{4}-\d{2}-\d{2}$/.test(v.expense_date) ? 'Pick the date of the expense.'
    : v.fx_rate && !(Number(v.fx_rate) > 0) ? 'The exchange rate must be above 0.' : '';
  const web = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null;

  return (
    <View style={{ gap: 24 }}>
      {confidence && Object.values(confidence).some(f => f.confidence < LOW) && (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: t.warnSoft, padding: 12, borderRadius: 14 }} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={18} color={t.warn} />
          <Text style={{ color: t.warn, fontWeight: '600', flex: 1 }}>{tr('Low confidence: please check')}</Text>
        </View>
      )}

      {/* the amount is the point of the form: biggest thing, first focus */}
      <View style={[{ gap: 6, paddingVertical: 8, borderBottomWidth: 2, borderColor: low('amount') ? t.warn : v.amount ? t.primary : t.border }]}>
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{tr('Amount')}{hint('amount')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TextInput accessibilityLabel={tr('Currency')} value={v.currency} onChangeText={x => set('currency')(x.toUpperCase())} maxLength={3} autoCapitalize="characters"
            selectTextOnFocus style={[{ color: t.text, fontSize: 18, fontWeight: '700', backgroundColor: t.surface, borderRadius: 10, paddingHorizontal: 10,
              paddingVertical: 8, width: 70, textAlign: 'center' }, web]} />
          {items.length ? (
            <Text accessibilityLabel={`${tr('Amount')}: total of ${items.length} items`} style={{ flex: 1, color: t.text, fontSize: 44, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'] }}>
              {amountText(itemsTotal)}
            </Text>
          ) : <TextInput accessibilityLabel={tr('Amount')} value={v.amount} onChangeText={x => set('amount')(cleanNum(x))} onBlur={() => set('amount')(pretty(v.amount))} onFocus={() => set('amount')(v.amount.replace(/,/g, ''))}
            keyboardType="decimal-pad" inputMode="decimal" placeholder="0.00"
            autoFocus={!initial.amount} placeholderTextColor={t.faint}
            style={[{ flex: 1, minWidth: 0, width: 0, color: t.text, fontSize: 44, fontWeight: '800', letterSpacing: -1, fontVariant: ['tabular-nums'], paddingVertical: 4 }, web]} />}
        </View>
        {items.length > 0 && <Text style={{ color: t.muted, fontSize: 13 }}>Total of {items.length} {items.length === 1 ? 'item' : 'items'}, worked out from the list below</Text>}
        {foreign && (
          <View style={{ marginTop: 8 }}>
            <Field icon="swap-horizontal" label={`1 ${v.currency.toUpperCase()} = how many ${baseCurrency}?`} value={v.fx_rate} onChangeText={set('fx_rate')} keyboardType="decimal-pad" />
          </View>
        )}
      </View>

      <Section title={advance ? 'What is the advance for?' : 'What was it?'}>
        <Field icon="create-outline" label={(advance ? 'Purpose' : tr('What was it for?')) + hint('title')} placeholder={advance ? 'Site visit to Lahore' : 'Fuel for site visit'} value={v.title} onChangeText={set('title')} style={warn('title')} />
        {!advance && <Field icon="storefront-outline" label={tr('Vendor / payee') + hint('vendor')} placeholder="Shop, person or company" value={v.vendor} onChangeText={set('vendor')} style={warn('vendor')} />}
        {advance && <DateField optional label="Evidence due by" value={v.due_date} onChangeText={set('due_date')} />}
        <DateField label={(advance ? 'Date given' : tr('Date')) + hint('expense_date')} value={v.expense_date} onChangeText={set('expense_date')} style={warn('expense_date')} />
      </Section>

      <Section title={advance ? 'Details' : 'How was it paid?'}>
        <Chips label={tr('Category') + hint('category')} options={cats} value={v.category_id} onChange={set('category_id')} />
        <Pressable accessibilityRole="link" onPress={() => router.push(`/workspace/${workspaceId}/categories`)} style={{ minHeight: 36, justifyContent: 'center' }}>
          <Text style={{ color: t.primary, fontWeight: '700', fontSize: 13 }}>Manage categories</Text>
        </Pressable>
        {!advance && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{tr('Payment method')}{hint('payment_method')}</Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', backgroundColor: t.surface, borderRadius: 14, padding: 4, gap: 4 }}>
            {METHODS.map(([id, name, icon]) => {
              const on = v.payment_method === id;
              return (
                <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => set('payment_method')(on ? null : id)}
                  style={{ flex: 1, minHeight: 56, borderRadius: 11, alignItems: 'center', justifyContent: 'center', gap: 3,
                    backgroundColor: on ? t.card : 'transparent', borderWidth: on ? 1 : 0, borderColor: t.border }}>
                  <Ionicons name={icon} size={18} color={on ? t.primary : t.muted} />
                  <Text style={{ color: on ? t.text : t.muted, fontSize: 12, fontWeight: on ? '700' : '500' }}>{name}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        )}
      </Section>

      {!advance && <Section title={items.length ? `Items (${items.length})` : 'Items'}>
        {items.map((i, n) => (
          <View key={i.key} style={{ gap: 8, paddingBottom: n < items.length - 1 ? 14 : 0, borderBottomWidth: n < items.length - 1 ? 1 : 0, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><Field label="Description" placeholder="Cement bag" value={i.description} onChangeText={setItem(i.key, 'description')} accessibilityLabel={`Item ${n + 1} description`} /></View>
              <IconButton name="trash-outline" label={`Remove item ${n + 1}`} color={t.danger} onPress={() => setItems(r => r.filter(x => x.key !== i.key))} />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
              <View style={{ width: 72 }}><Field label="Qty" placeholder="1" value={i.qty} onChangeText={x => setItem(i.key, 'qty')(cleanNum(x))} keyboardType="decimal-pad" accessibilityLabel={`Item ${n + 1} quantity`} /></View>
              <View style={{ flex: 1 }}><Field label="Unit price" placeholder="0.00" value={i.amount} onChangeText={x => setItem(i.key, 'amount')(cleanNum(x))}
                onBlur={() => setItem(i.key, 'amount')(pretty(i.amount))} onFocus={() => setItem(i.key, 'amount')(i.amount.replace(/,/g, ''))} keyboardType="decimal-pad" accessibilityLabel={`Item ${n + 1} unit price`} /></View>
              <Text style={{ color: t.text, fontWeight: '700', minWidth: 84, textAlign: 'right', paddingBottom: 18, fontVariant: ['tabular-nums'] }}>
                {amountText((num(i.qty || '1') || 0) * (num(i.amount) || 0))}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
              {cats.map(c => {
                const on = i.category_id === c.id;
                return (
                  <Pressable key={c.id} accessibilityRole="radio" accessibilityLabel={`Item ${n + 1} category ${c.name}`} accessibilityState={{ checked: on }}
                    onPress={() => setItems(r => r.map(x => (x.key === i.key ? { ...x, category_id: on ? null : c.id } : x)))}
                    style={{ minHeight: 40, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', borderWidth: 1,
                      borderColor: on ? t.primarySoft : t.border, backgroundColor: on ? t.primarySoft : 'transparent' }}>
                    <Text style={{ color: on ? t.primaryDark : t.muted, fontSize: 13, fontWeight: '600' }}>{c.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ))}
        {items.length > 0 && <Text style={{ color: t.muted, fontSize: 12 }}>Items with no category count under the expense category above.</Text>}
        <Pressable accessibilityRole="button" onPress={addItem} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40 }}>
          <Ionicons name="add-circle-outline" size={18} color={t.primary} />
          <Text style={{ color: t.primary, fontWeight: '700' }}>{items.length ? 'Add another item' : 'Add line items'}</Text>
        </Pressable>
        {items.length > 0 && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10, borderTopWidth: 1, borderColor: t.border }}>
            <Text style={{ color: t.text, fontWeight: '700' }}>Total</Text>
            <Text style={{ color: t.text, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{v.currency.toUpperCase()} {amountText(itemsTotal)}</Text>
          </View>
        )}
      </Section>}

      <Section title="Anything else?">
        <Field icon="chatbox-ellipses-outline" label={tr('Notes') + hint('notes')} placeholder="Optional: who it was for, why it was needed" value={v.notes} onChangeText={set('notes')} multiline style={warn('notes')} />
        {advance ? null : more ? <>
          <Field icon="folder-outline" label={tr('Project / cost-center tag')} placeholder="Optional" value={v.tag} onChangeText={set('tag')} />
          <DateField optional label={tr('Due date (optional)')} value={v.due_date} onChangeText={set('due_date')} />
        </> : (
          <Pressable accessibilityRole="button" onPress={() => setMore(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40 }}>
            <Ionicons name="add-circle-outline" size={18} color={t.primary} />
            <Text style={{ color: t.primary, fontWeight: '700' }}>Add a project tag or due date</Text>
          </Pressable>
        )}
      </Section>

      <View style={{ gap: 10 }}>
        {problem ? <Text accessibilityLiveRegion="polite" style={{ color: t.muted, fontSize: 13, textAlign: 'center' }}>{problem}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {secondary && <Button kind="ghost" title={secondary.label} disabled={!valid} busy={busy} onPress={run(secondary.onPress)} style={{ flex: 1 }} />}
          <Button icon="checkmark-circle" title={submitLabel} disabled={!valid} busy={busy} onPress={run(onSubmit)} style={{ flex: secondary ? 1.4 : 1 }} />
        </View>
        {extras?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
            {extras.map(x => <Button key={x.label} small kind="text" icon={x.icon} title={x.label} disabled={!valid} onPress={run(x.onPress)} />)}
          </View>
        ) : null}
      </View>
    </View>
  );
}
