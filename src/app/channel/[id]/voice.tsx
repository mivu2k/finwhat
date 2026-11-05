import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { errMsg, send, uploadFile, uuid } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Alert, Button, Screen, useTheme } from '../../../lib/ui';

/** Record a voice note → Draft thread with the audio; server transcribes; "Convert to form" extracts fields. */
export default function Voice() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const tr = useT();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [busy, setBusy] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    requestRecordingPermissionsAsync().then(p => { if (!p.granted) Alert.alert(tr('Error'), 'Microphone permission denied'); });
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => {});
  }, [tr]);

  useEffect(() => {
    if (!state.isRecording) { pulse.stopAnimation(); pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }));
    loop.start();
    return () => loop.stop();
  }, [state.isRecording, pulse]);

  async function start() {
    try { await recorder.prepareToRecordAsync(); recorder.record(); }
    catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
  }

  async function stopAndSend() {
    setBusy(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('No recording');
      const mime = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
      const threadId = uuid();
      const created = await send('POST', `/channels/${id}/threads`, { id: threadId, source_type: 'voice' });
      const up = await uploadFile(threadId, uri, `voice-${Date.now()}.${Platform.OS === 'web' ? 'webm' : 'm4a'}`, mime);
      if (created.queued || up.queued) { Alert.alert(tr('Offline: will sync when back online')); router.back(); }
      else router.replace(`/thread/${threadId}`);
    } catch (e) { Alert.alert(tr('Error'), errMsg(e)); }
    setBusy(false);
  }

  const secs = Math.floor((state.durationMillis ?? 0) / 1000);
  const rec = state.isRecording;
  const ring = (delay: number) => ({
    position: 'absolute' as const, width: 220, height: 220, borderRadius: 110, backgroundColor: t.danger,
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25 - delay, 0] }),
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6 + delay, 1.3] }) }],
  });
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 28, padding: 24 }}>
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'center' }}>{rec ? tr('Recording…') : 'Tell us about the expense'}</Text>
        <Text style={{ color: t.muted, textAlign: 'center', maxWidth: 320 }}>
          Say the amount, vendor, date and what it was for. English or اردو both work.
        </Text>
        <View style={{ width: 240, height: 240, alignItems: 'center', justifyContent: 'center' }}>
          {rec && <><Animated.View style={ring(0)} /><Animated.View style={ring(0.1)} /></>}
          <Pressable accessibilityRole="button" accessibilityLabel={rec ? tr('Stop & send') : tr('Start recording')} disabled={busy}
            onPress={rec ? stopAndSend : start}
            style={({ pressed }) => ({ width: 132, height: 132, borderRadius: 66, backgroundColor: rec ? t.danger : t.primary,
              alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 0.95 : 1 }] })}>
            <Ionicons name={rec ? 'stop' : 'mic'} size={56} color="#fff" />
          </Pressable>
        </View>
        <Text style={{ color: rec ? t.danger : t.faint, fontSize: 40, fontWeight: '300', fontVariant: ['tabular-nums'] }} accessibilityLabel={`${secs} seconds`}>
          {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
        </Text>
        {rec ? <Button icon="send" title={tr('Stop & send')} busy={busy} onPress={stopAndSend} />
          : <Text style={{ color: t.muted, fontSize: 13 }}>Tap the mic to start</Text>}
      </View>
    </Screen>
  );
}
