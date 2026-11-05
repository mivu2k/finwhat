import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../../lib/api';
import { useChannel } from '../../../lib/useChannel';
import { useT } from '../../../lib/i18n';
import { Alert, Button, Field, Screen, useTheme } from '../../../lib/ui';

export default function ChannelSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const tr = useT();
  const { channel } = useChannel(id);
  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [limit, setLimit] = useState('');
  const [receipt, setReceipt] = useState('');
  const [blockAdv, setBlockAdv] = useState(false);
  useEffect(() => {
    if (!channel) return;
    setName(channel.name); setRequired(channel.approval_required);
    setLimit(channel.owner_approval_limit != null ? String(channel.owner_approval_limit) : '');
    setReceipt(channel.receipt_required_above != null ? String(channel.receipt_required_above) : '');
    setBlockAdv(channel.block_new_advance);
  }, [channel]);

  async function save() {
    try {
      await api('PATCH', `/channels/${id}`, { name: name.trim(), approval_required: required, owner_approval_limit: limit.trim() || null, receipt_required_above: receipt.trim() || null, block_new_advance: blockAdv });
      router.back();
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Field label={tr('Channel name')} value={name} onChangeText={setName} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{tr('Approval required')}</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>{required ? 'An approver must OK each expense before it can be paid.' : 'Expenses are approved automatically when submitted.'}</Text>
          </View>
          <Switch accessibilityLabel={tr('Approval required')} value={required} onValueChange={setRequired} />
        </View>
        {required && (
          <View style={{ gap: 6 }}>
            <Field label={`Also need the owner's OK above (${channel?.base_currency ?? ''})`} placeholder="No limit"
              value={limit} onChangeText={setLimit} keyboardType="decimal-pad" aria-describedby="limit-help" />
            <Text nativeID="limit-help" style={{ color: t.muted, fontSize: 13 }}>
              {limit ? `Above ${limit}, an approver's OK is not enough: an owner must approve too.` : 'Leave empty if one approver is always enough.'}
            </Text>
          </View>
        )}
        <Text style={{ color: t.muted, fontSize: 13 }}>
          An admin can change this under the workspace menu → AI settings. Voice transcription is {channel?.ai.transcribe ? 'on' : 'off'}; reading receipts with AI is {channel?.ai.extract ? 'on' : 'off'}.
        </Text>
        <Field label={`Require a receipt above (${channel?.base_currency ?? ''})`} placeholder="No requirement" value={receipt} onChangeText={setReceipt} keyboardType="decimal-pad" />
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>One open advance per person</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Block a new advance until the last one is accounted for.</Text>
          </View>
          <Switch accessibilityLabel="One open advance per person" value={blockAdv} onValueChange={setBlockAdv} />
        </View>
        <Text style={{ color: t.muted, fontSize: 13 }}>Monthly spending limits per person are set on the Members screen.</Text>
        <Button title={tr('Save')} onPress={save} disabled={!name.trim()} />
      </ScrollView>
    </Screen>
  );
}
