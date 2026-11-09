import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { apiRequest } from '../api/client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

async function register(token: string) {
  await apiRequest<void>('/mobile/push/token', { method: 'PUT', body: JSON.stringify({ token }) }, true);
}

export async function enableAndroidPush(requestPermission = true) {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Сообщения VIOLETTA', importance: Notifications.AndroidImportance.HIGH,
  });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return;
  const token = await Notifications.getDevicePushTokenAsync();
  if (token.type === 'android' && typeof token.data === 'string') await register(token.data);
}

export function listenForAndroidPushTokens() {
  if (Platform.OS !== 'android') return () => undefined;
  const subscription = Notifications.addPushTokenListener((token) => {
    if (token.type === 'android' && typeof token.data === 'string') void register(token.data).catch(() => undefined);
  });
  return () => subscription.remove();
}

export async function disableAndroidPush() {
  if (Platform.OS === 'android') await apiRequest<void>('/mobile/push/token', { method: 'DELETE' }, true);
}
