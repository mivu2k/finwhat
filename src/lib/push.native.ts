// Push alerts through Expo. Needs an EAS project id and FCM credentials (see README); until then this quietly does nothing
// and people still get alerts in the Alerts tab.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { api } from './api';

let current: string | null = null;
let listening = false;

export async function registerPush() {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    if (!listening) {
      listening = true;
      Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
      Notifications.addNotificationResponseReceivedListener(r => {
        const id = r.notification.request.content.data?.threadId;
        if (id) router.push(`/thread/${id}`);
      });
    }
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Expense alerts', importance: Notifications.AndroidImportance.HIGH });
    const { granted } = await Notifications.requestPermissionsAsync();
    if (!granted) return;
    current = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api('POST', '/me/push-token', { token: current });
  } catch (e) { console.warn('push registration skipped', e); }
}

/** Before signing out, so this phone stops getting that person's alerts. */
export async function unregisterPush() {
  if (current) await api('DELETE', '/me/push-token', { token: current }).catch(() => {});
  current = null;
}
