import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useChannel } from '../../../lib/useChannel';
import { Card, DateField, Screen } from '../../../lib/ui';
import { ReportsCard } from '../../../components/ReportsCard';

export default function ChannelReports() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { channel } = useChannel(id);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filters = Object.fromEntries(Object.entries({ channel: id, from, to }).filter(([, v]) => v)) as Record<string, string>;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48 }}>
        <Card style={{ gap: 14 }}>
          <DateField optional label="From (optional)" value={from} onChangeText={setFrom} />
          <DateField optional label="To (optional)" value={to} onChangeText={setTo} />
        </Card>
        <ReportsCard filters={filters} hint={`#${channel?.name ?? 'This channel'}${channel?.subchannels?.length ? ' and its sub-channels' : ''}, for the dates above.`} />
      </ScrollView>
    </Screen>
  );
}
