import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../lib/api';
import { Button, Card, Screen, useTheme } from '../../lib/ui';

export default function Invite() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const t = useTheme();
  const [info, setInfo] = useState<{ channel: string; workspace: string; role: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/invites/${token}`).then(setInfo).catch(e => setError(errMsg(e))); }, [token]);
  async function join() {
    try { const r = await api('POST', `/invites/${token}/accept`); router.replace(`/channel/${r.channel_id}`); }
    catch (e) { setError(errMsg(e)); }
  }
  return (
    <Screen>
      <View style={{ padding: 16 }}>
        <Card>
          {error ? <Text style={{ color: t.danger }}>{error}</Text> : info ? <>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}># {info.channel}</Text>
            <Text style={{ color: t.muted }}>{info.workspace} · you join as {info.role}</Text>
            <Button icon="enter-outline" title="Join channel" onPress={join} />
          </> : <Text style={{ color: t.muted }}>Checking invite…</Text>}
        </Card>
      </View>
    </Screen>
  );
}
