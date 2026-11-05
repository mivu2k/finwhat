import { useCallback, useEffect, useState } from 'react';
import { Share, FlatList, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MODE, api, errMsg, type Member } from '../../../lib/api';
import { useUserId } from '../../../lib/auth';
import { isApprover } from '../../../lib/workflow';
import { useChannel } from '../../../lib/useChannel';
import { useT } from '../../../lib/i18n';
import { Avatar, Chips, DateField, confirmAsync, Alert, Button, Field, Screen, useTheme } from '../../../lib/ui';
import type { Role } from '../../../lib/workflow';

const ROLES: Role[] = ['owner', 'approver', 'member', 'viewer'];
const ROLE_HELP: Record<Role, string> = {
  owner: 'Manages the channel and members; gives final approval above the limit.',
  approver: 'Approves, rejects and records payments.',
  member: 'Adds expenses and replies.',
  viewer: 'Can read everything, cannot change anything.',
};
const cap = (r: string) => r[0].toUpperCase() + r.slice(1);

export default function Members() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const tr = useT();
  const { role } = useChannel(id);
  const isOwner = role === 'owner';
  const [rows, setRows] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');

  const load = useCallback(async () => {
    setRows(await api<Member[]>('GET', `/channels/${id}/members`).catch(() => []));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function run(method: string, path: string, body?: object) {
    try { await api(method, path, body); load(); return true; } catch (e) { Alert.alert('Error', errMsg(e)); return false; }
  }
  const uid = useUserId();
  const [invite, setInvite] = useState<{ token: string; role: string; expires_on: string } | null>(null);
  const [delegations, setDelegations] = useState<any[]>([]);
  const [delegateTo, setDelegateTo] = useState<string | null>(null);
  const [until, setUntil] = useState('');
  const loadDelegations = useCallback(() => { api<any[]>('GET', `/channels/${id}/delegation`).then(setDelegations).catch(() => {}); }, [id]);
  useEffect(() => { loadDelegations(); }, [loadDelegations]);
  const mine = delegations.find(d => d.from_user === uid);
  async function makeInvite() {
    try {
      const r = await api('POST', `/channels/${id}/invites`, { role: newRole === 'owner' ? 'member' : newRole });
      setInvite(r);
      Share.share({ message: `Join my channel on ExpenseChat. Tap + on the Channels screen, choose "Join with a code" and enter: ${r.token}\n\nOr open expensechat://invite/${r.token}` }).catch(() => {});
    } catch (e) { Alert.alert('Error', errMsg(e)); }
  }
  async function delegate() {
    if (await run('POST', `/channels/${id}/delegation`, { to_user: delegateTo, until })) { setDelegateTo(null); setUntil(''); loadDelegations(); }
  }
  async function endDelegation() { if (await run('DELETE', `/channels/${id}/delegation`)) loadDelegations(); }
  const [scopes, setScopes] = useState<{ user_id: string; can_see: string }[]>([]);
  const loadScopes = useCallback(() => { api('GET', `/channels/${id}/scopes`).then(setScopes).catch(() => {}); }, [id]);
  useEffect(() => { loadScopes(); }, [loadScopes]);
  async function setScope(user: string, scope: string | null, users: string[] = scopes.filter(x => x.user_id === user).map(x => x.can_see)) {
    if (scope && (await run('PATCH', `/channels/${id}/members/${user}/scope`, { scope, users }))) loadScopes();
  }
  const add = async () => { if (await run('POST', `/channels/${id}/members`, { email, role: newRole })) setEmail(''); };
  const setRole = (user_id: string, role: Role) => run('PATCH', `/channels/${id}/members/${user_id}`, { role });
  const remove = async (user_id: string, who: string) => {
    if (await confirmAsync(tr('Remove'), `Remove ${who} from this channel? They will lose access to its expenses.`, tr('Remove'), tr('Cancel')))
      run('DELETE', `/channels/${id}/members/${user_id}`);
  };

  const RolePicker = ({ value, onChange }: { value: Role; onChange: (r: Role) => void }) => (
    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {ROLES.map(r => (
        <Pressable key={r} accessibilityRole="radio" accessibilityState={{ checked: r === value }} onPress={() => onChange(r)}
          style={{ minHeight: 38, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 19,
            backgroundColor: r === value ? t.text : t.surface }}>
          <Text style={{ color: r === value ? t.card : t.text, fontSize: 13, fontWeight: '600' }}>{cap(r)}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={m => m.user_id}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListHeaderComponent={isOwner ? (
          <View style={{ gap: 8, marginBottom: 16 }}>
            <Field label={tr('Add member by email')} icon="mail-outline" placeholder="name@company.com" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <RolePicker value={newRole} onChange={setNewRole} />
            <Text style={{ color: t.muted, fontSize: 13 }}>{cap(newRole)}: {ROLE_HELP[newRole]}</Text>
            <Button title={tr('Add')} onPress={add} disabled={!email.includes('@')} />
            {MODE === 'server' && <Button kind="ghost" icon="link-outline" title="Invite with a code (for people not signed up yet)" onPress={makeInvite} />}
            {invite && (
              <View style={{ backgroundColor: t.card, borderRadius: 12, padding: 12, gap: 4 }}>
                <Text selectable style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{invite.token}</Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>Joins as {invite.role}. Valid until {invite.expires_on}.</Text>
              </View>
            )}
          </View>
        ) : undefined}
        ListFooterComponent={MODE === 'server' && isApprover(role) && rows.length > 1 ? (
          <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 14, gap: 12, marginTop: 8 }}>
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Away? Hand over your approvals</Text>
            {delegations.map(d => <Text key={d.from_user} style={{ color: t.muted, fontSize: 13 }}>{d.from_name} → {d.to_name}, until {String(d.until_date).slice(0, 10)}</Text>)}
            {mine ? <Button small kind="danger" title="End my delegation" onPress={endDelegation} /> : <>
              <Chips label="Hand over to" value={delegateTo} onChange={setDelegateTo}
                options={rows.filter(m => m.user_id !== uid && m.role !== 'viewer').map(m => ({ id: m.user_id, name: m.profile?.full_name ?? m.profile?.email ?? '' }))} />
              <DateField optional label="Until" value={until} onChangeText={setUntil} />
              <Button small title="Hand over" disabled={!delegateTo || !until} onPress={delegate} />
            </>}
          </View>
        ) : undefined}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: t.card, padding: 14, borderRadius: 16, gap: 10, borderWidth: 1, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar name={item.profile?.full_name ?? '?'} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{item.profile?.full_name ?? item.profile?.email}</Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>{item.profile?.email}</Text>
              </View>
              {isOwner && (
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.profile?.full_name ?? 'member'}`} hitSlop={8}
                  onPress={() => remove(item.user_id, item.profile?.full_name ?? item.profile?.email ?? 'this member')}
                  style={{ minHeight: 40, paddingHorizontal: 8, justifyContent: 'center' }}>
                  <Text style={{ color: t.danger, fontWeight: '600' }}>{tr('Remove')}</Text>
                </Pressable>
              )}
            </View>
            {isOwner ? (
              <View style={{ gap: 10 }}>
                <RolePicker value={item.role} onChange={r => setRole(item.user_id, r)} />
                {(item.role === 'member' || item.role === 'viewer') && (
                  <View style={{ gap: 8 }}>
                    <Chips label="Can see records of" value={item.record_scope ?? 'all'} onChange={s => setScope(item.user_id, s)}
                      options={[{ id: 'all', name: 'Everyone' }, { id: 'own', name: 'Only themselves' }, { id: 'selected', name: 'Chosen people' }]} />
                    {item.record_scope === 'selected' && (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {rows.filter(o => o.user_id !== item.user_id).map(o => {
                          const chosen = scopes.filter(x => x.user_id === item.user_id).map(x => x.can_see);
                          const on = chosen.includes(o.user_id);
                          return (
                            <Pressable key={o.user_id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setScope(item.user_id, 'selected', on ? chosen.filter(u => u !== o.user_id) : [...chosen, o.user_id])}
                              style={{ minHeight: 38, paddingHorizontal: 12, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? t.primarySoft : t.surface }}>
                              <Ionicons name={on ? 'checkbox' : 'square-outline'} size={16} color={on ? t.primaryDark : t.muted} />
                              <Text style={{ color: on ? t.primaryDark : t.text, fontSize: 13, fontWeight: '600' }}>{o.profile?.full_name ?? o.profile?.email}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                  </View>
                )}
                <Field label="Monthly spending limit" placeholder="No limit" defaultValue={item.monthly_limit != null ? String(item.monthly_limit) : ''} keyboardType="decimal-pad"
                  onEndEditing={e => run('PATCH', `/channels/${id}/members/${item.user_id}/limit`, { monthly_limit: e.nativeEvent.text.trim() || null })} />
              </View>
            ) : <Text style={{ color: t.text, fontSize: 13 }}>{cap(item.role)} · <Text style={{ color: t.muted }}>{ROLE_HELP[item.role]}</Text></Text>}
          </View>
        )}
      />
    </Screen>
  );
}
