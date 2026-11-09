import * as SecureStore from 'expo-secure-store';

import type { ApiUser } from '../api/client';

const IMPORT_PERMISSION_KEY = 'violetta.can-import-ios-library';

export function canUserImportAndroidLibrary(user: ApiUser | null) {
  return !!user && user.is_active && user.can_upload_media &&
    (user.role === 'owner' || user.can_import_android_photo_library === true);
}

export function canUserImportIphoneLibrary(user: ApiUser | null) {
  return !!user && user.is_active && user.can_upload_media &&
    (user.role === 'owner' || user.role === 'admin') &&
    user.can_import_ios_photo_library === true;
}

export async function persistImportPermission(user: ApiUser | null) {
  await SecureStore.setItemAsync(IMPORT_PERMISSION_KEY, canUserImportIphoneLibrary(user) ? '1' : '0', {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function hasPersistedImportPermission() {
  return (await SecureStore.getItemAsync(IMPORT_PERMISSION_KEY)) === '1';
}
