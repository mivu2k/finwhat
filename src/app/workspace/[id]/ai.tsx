import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, errMsg } from '../../../lib/api';
import { Alert, Button, Card, Chips, Field, H, Screen, Skeleton, radius, useTheme } from '../../../lib/ui';

type Conf = { provider: string; url: string; model: string; key: string; has_key?: boolean; clear_key?: boolean };
// choices fill in sensible values; everything stays editable
const READ = [
  { id: 'none', name: 'Off', provider: 'none', url: '', model: '', hint: 'People fill in expenses by hand.' },
  { id: 'claude', name: 'Claude', provider: 'anthropic', url: '', model: 'claude-opus-5-5', hint: 'Cloud. Reads photos and PDFs. Needs an Anthropic API key. Receipts are sent to Anthropic.' },
  { id: 'openai', name: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1', model: '', hint: 'Cloud. Needs an OpenAI API key and a vision model name. Receipts are sent to OpenAI.' },
  { id: 'ollama', name: 'Ollama (local)', provider: 'openai', url: 'http://localhost:11434/v1', model: 'llava', hint: 'Runs on your own machine; nothing leaves it. Use a vision model to read photos. PDFs are not supported.' },
  { id: 'lmstudio', name: 'LM Studio (local)', provider: 'openai', url: 'http://localhost:1234/v1', model: '', hint: 'Runs on your own machine; nothing leaves it. Use the model name shown in LM Studio. PDFs are not supported.' },
  { id: 'custom', name: 'Other', provider: 'openai', url: '', model: '', hint: 'Any OpenAI-compatible server: address ending in /v1, a model name, and a key if it needs one.' },
];
const HEAR = [
  { id: 'none', name: 'Off', provider: 'none', url: '', model: '', hint: 'Voice notes stay playable, with no text.' },
  { id: 'openai', name: 'OpenAI Whisper', provider: 'openai', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', hint: 'Cloud. Needs an OpenAI API key. Audio is sent to OpenAI.' },
  { id: 'custom', name: 'Local or other', provider: 'openai', url: 'http://localhost:8000/v1/audio/transcriptions', model: 'whisper-1', hint: 'Any Whisper-compatible server, such as speaches or whisper.cpp. Use its full transcription address.' },
];
const guess = (c: Conf, list: typeof READ) => list.find(x => x.provider === c.provider && x.url === c.url && x.id !== 'custom')?.id
  ?? (c.provider === 'none' ? 'none' : c.provider === 'anthropic' ? 'claude' : 'custom');

function Section({ title, list, conf, choice, onChoose, onChange, keyPlaceholder }: {
  title: string; list: typeof READ; conf: Conf; choice: string; onChoose: (id: string) => void; onChange: (c: Conf) => void; keyPlaceholder: string;
}) {
  const t = useTheme();
  const opt = list.find(x => x.id === choice)!;
  return (
    <Card style={{ gap: 14 }}>
      <H>{title}</H>
      <Chips value={choice} onChange={v => v && onChoose(v)} options={list.map(x => ({ id: x.id, name: x.name }))} />
      <Text style={{ color: t.muted, fontSize: 13 }}>{opt.hint}</Text>
      {conf.provider !== 'none' && <>
        {choice !== 'claude' && <Field label="Server address" icon="server-outline" autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://192.168.0.10:11434/v1" value={conf.url} onChangeText={url => onChange({ ...conf, url })} />}
        <Field label="Model" icon="hardware-chip-outline" autoCapitalize="none" autoCorrect={false} placeholder="Model name" value={conf.model} onChangeText={model => onChange({ ...conf, model })} />
        <Field label="API key" icon="key-outline" autoCapitalize="none" autoCorrect={false} secureTextEntry
          placeholder={conf.has_key && !conf.clear_key ? 'Saved. Leave empty to keep it' : keyPlaceholder} value={conf.key} onChangeText={key => onChange({ ...conf, key, clear_key: false })} />
        {conf.has_key && !conf.clear_key && <Button small kind="text" title="Remove saved key" onPress={() => onChange({ ...conf, key: '', clear_key: true })} />}
      </>}
    </Card>
  );
}

export default function AiSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [read, setRead] = useState<Conf | null>(null);
  const [hear, setHear] = useState<Conf | null>(null);
  const [readChoice, setReadChoice] = useState('none');
  const [hearChoice, setHearChoice] = useState('none');
  const [fromEnv, setFromEnv] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api('GET', `/workspaces/${id}/ai`).then(r => {
      const a = { ...r.extract, key: '' }, b = { ...r.transcribe, key: '' };
      setRead(a); setHear(b); setFromEnv(r.from_env);
      setReadChoice(guess(a, READ)); setHearChoice(b.provider === 'none' ? 'none' : b.url && !b.url.includes('api.openai.com') ? 'custom' : 'openai');
    }).catch(e => setError(errMsg(e)));
  }, [id]);
  if (error) return <Screen><Text style={{ color: t.danger, padding: 16 }}>{error}</Text></Screen>;
  if (!read || !hear) return <Screen><Skeleton rows={3} height={140} /></Screen>;

  const pick = (list: typeof READ, conf: Conf, cid: string): Conf => {
    const o = list.find(x => x.id === cid)!;
    return { ...conf, provider: o.provider, url: o.url, model: o.model };
  };
  const body = { extract: read, transcribe: hear };
  async function runTest() {
    setBusy(true); setTest(null);
    try {
      const r = await api('POST', `/workspaces/${id}/ai/test`, body);
      setTest(r.ok ? { ok: true, text: `Connected. The AI answered in ${(r.ms / 1000).toFixed(1)} seconds.` } : { ok: false, text: `Not working: ${r.error}.` });
    } catch (e) { setTest({ ok: false, text: errMsg(e) }); }
    setBusy(false);
  }
  async function save() {
    setBusy(true);
    try { await api('PUT', `/workspaces/${id}/ai`, body); setFromEnv(false); Alert.alert('AI settings saved'); }
    catch (e) { Alert.alert('Error', errMsg(e)); }
    setBusy(false);
  }
  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          The server makes these calls, so &quot;localhost&quot; means the computer running the API, not your phone.{fromEnv ? ' Currently using the server\'s default settings.' : ''}
        </Text>
        <Section title="Reading receipts and voice text" list={READ} conf={read} choice={readChoice} keyPlaceholder={readChoice === 'ollama' || readChoice === 'lmstudio' ? 'Usually not needed' : 'Paste your key'}
          onChoose={c => { setReadChoice(c); setRead(pick(READ, read, c)); setTest(null); }} onChange={c => { setRead(c); setTest(null); }} />
        {read.provider !== 'none' && <Button kind="ghost" icon="flash-outline" title="Test connection" busy={busy} onPress={runTest} />}
        {test && (
          <View accessibilityLiveRegion="polite" style={{ backgroundColor: test.ok ? t.primarySoft : t.dangerSoft, borderRadius: radius.md, padding: 12 }}>
            <Text style={{ color: test.ok ? t.primaryDark : t.danger, fontWeight: '600' }}>{test.text}</Text>
          </View>
        )}
        <Section title="Voice to text" list={HEAR} conf={hear} choice={hearChoice} keyPlaceholder={hearChoice === 'custom' ? 'Usually not needed' : 'Paste your key'}
          onChoose={c => { setHearChoice(c); setHear(pick(HEAR, hear, c)); }} onChange={setHear} />
        <Button icon="save-outline" title="Save" busy={busy} onPress={save} />
      </ScrollView>
    </Screen>
  );
}
