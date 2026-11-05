import { Image, Linking, Modal, Platform, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import { startActivityAsync } from 'expo-intent-launcher';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Alert, IconButton } from '../lib/ui';

/** Opens a PDF or other file in a viewer app. Android refuses file:// links, so it gets a content:// link with read permission. */
export async function openFile(url: string, mime: string, name: string) {
  try {
    if (Platform.OS !== 'android') return await Linking.openURL(url);
    let uri = url;
    if (/^https?:/.test(url)) {
      const dest = new File(Paths.cache, name.replace(/[^\w.-]/g, '_') || 'attachment');
      uri = (await File.downloadFileAsync(url, dest, { idempotent: true })).uri;
    }
    await startActivityAsync('android.intent.action.VIEW', { data: await getContentUriAsync(uri), type: mime, flags: 1 }); // 1 = grant read access
  } catch (e) {
    Alert.alert('Could not open this file', `${(e as Error).message}\n\nIf this is a PDF, check that a PDF viewer is installed.`);
  }
}

/** Full-screen image, inside the app. */
export function ImageViewer({ url, onClose }: { url: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!url} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {url && <Image source={{ uri: url }} accessibilityLabel="Attachment" resizeMode="contain" style={{ flex: 1 }} />}
        <View style={{ position: 'absolute', top: insets.top + 8, right: 8 }}>
          <IconButton name="close" label="Close image" color="#fff" bg="#0008" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
