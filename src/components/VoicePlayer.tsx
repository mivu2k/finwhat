import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { radius, useTheme } from '../lib/ui';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Voice note: loads on first play (lists stay light), with a live progress bar you can tap to jump. */
export function VoicePlayer({ url }: { url: string; mine?: boolean }) {
  const t = useTheme();
  const [src] = useState(url); // a later refreshed link for the same file must not restart playback
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const track = useRef<any>(null); // RN's View type has no usable instance type for measure()
  const player = useAudioPlayer(active ? src : null, { updateInterval: 100 });
  const st = useAudioPlayerStatus(player);
  const duration = Number.isFinite(st.duration) ? st.duration : 0;
  const pct = duration ? Math.min(st.currentTime / duration, 1) : 0;

  useEffect(() => {
    if (pending && st.isLoaded) { setPending(false); player.play(); }
  }, [pending, st.isLoaded, player]);
  useEffect(() => { if (st.didJustFinish) { player.pause(); player.seekTo(0); } }, [st.didJustFinish, player]);

  const toggle = () => {
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    if (!active) { setActive(true); setPending(true); return; }
    if (st.playing) player.pause(); else player.play();
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, minWidth: 200 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={st.playing ? 'Pause voice note' : 'Play voice note'} onPress={toggle}
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}>
        {pending ? <ActivityIndicator color={t.primaryText} /> : <Ionicons name={st.playing ? 'pause' : 'play'} size={20} color={t.primaryText} />}
      </Pressable>
      <View style={{ flex: 1, gap: 2 }}>
        <Pressable accessibilityRole="adjustable" accessibilityLabel="Voice note position" accessibilityValue={{ text: `${clock(st.currentTime)} of ${clock(duration)}` }}
          ref={track} disabled={!duration}
          onPress={e => {
            const tapX = e.nativeEvent.pageX; // relative to the screen, so it doesn't matter which part of the bar was hit
            track.current?.measure((_x: number, _y: number, w: number, _h: number, pageX: number) => { if (w && Number.isFinite(tapX)) player.seekTo(Math.max(0, Math.min((tapX - pageX) / w, 1)) * duration); });
          }}
          style={{ height: 24, justifyContent: 'center' }}>
          <View testID="voice-track" style={{ height: 6, borderRadius: radius.pill, backgroundColor: t.border }}>
            <View testID="voice-fill" style={{ height: 6, borderRadius: radius.pill, width: `${pct * 100}%`, backgroundColor: t.primary }} />
            {pct > 0 && <View style={{ position: 'absolute', left: `${pct * 100}%`, top: -3, marginLeft: -6, width: 12, height: 12, borderRadius: 6, backgroundColor: t.primary }} />}
          </View>
        </Pressable>
        <Text style={{ color: t.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{active ? `${clock(st.currentTime)} / ${clock(duration)}` : 'Voice note'}</Text>
      </View>
    </View>
  );
}
