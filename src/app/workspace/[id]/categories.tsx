import { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../../lib/api';
import { Alert, Button, Empty, Field, IconButton, Screen, confirmAsync, radius, useTheme } from '../../../lib/ui';

type Cat = { id: string; name: string };

export default function Categories() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [cats, setCats] = useState<Cat[]>([]);
  const [admin, setAdmin] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => api<Cat[]>('GET', `/workspaces/${id}/categories`).then(setCats).catch(e => Alert.alert('Error', errMsg(e))), [id]);
  useEffect(() => {
    load();
    api<{ id: string; role: string }[]>('GET', '/workspaces').then(w => setAdmin(w.find(x => x.id === id)?.role === 'admin')).catch(() => {});
  }, [id, load]);

  async function run(method: string, path: string, body?: unknown) {
    try { await api(method, path, body); await load(); return true; }
    catch (e) { Alert.alert('Error', errMsg(e)); return false; }
  }
  const add = async () => { if (name.trim() && (await run('POST', `/workspaces/${id}/categories`, { name }))) setName(''); };
  const rename = async () => { if (editing && (await run('PATCH', `/workspaces/${id}/categories/${editing.id}`, { name: editing.name }))) setEditing(null); };
  const remove = async (c: Cat) => {
    if (await confirmAsync('Delete category', `Delete "${c.name}"? Expenses using it stay, but become uncategorized.`, 'Delete', 'Cancel'))
      run('DELETE', `/workspaces/${id}/categories/${c.id}`);
  };

  return (
    <Screen>
      <FlatList
        data={cats}
        keyExtractor={c => c.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 48 }}
        ListHeaderComponent={admin ? (
          <View style={{ gap: 8, marginBottom: 8 }}>
            <Field label="New category" icon="pricetag-outline" placeholder="e.g. Site materials" value={name} onChangeText={setName} onSubmitEditing={add} />
            <Button title="Add category" icon="add" disabled={!name.trim()} onPress={add} />
          </View>
        ) : <Text style={{ color: t.muted, marginBottom: 8 }}>Only a workspace admin can change categories.</Text>}
        ListEmptyComponent={<Empty icon="pricetags-outline" title="No categories yet" />}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: t.card, borderRadius: radius.md, paddingLeft: 16, paddingRight: 4, minHeight: 56, justifyContent: 'center' }}>
            {editing?.id === item.id ? (
              <View style={{ gap: 8, paddingVertical: 10, paddingRight: 12 }}>
                <Field autoFocus label="Name" value={editing.name} onChangeText={x => setEditing({ id: item.id, name: x })} onSubmitEditing={rename} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button small kind="ghost" title="Cancel" onPress={() => setEditing(null)} />
                  <Button small title="Save" disabled={!editing.name.trim()} onPress={rename} />
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ color: t.text, fontSize: 15, flex: 1 }}>{item.name}</Text>
                {admin && <IconButton name="create-outline" label={`Rename ${item.name}`} size={20} color={t.muted} onPress={() => setEditing(item)} />}
                {admin && <IconButton name="trash-outline" label={`Delete ${item.name}`} size={20} color={t.danger} onPress={() => remove(item)} />}
              </View>
            )}
          </View>
        )}
      />
    </Screen>
  );
}
