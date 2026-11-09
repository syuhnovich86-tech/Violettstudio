import * as BackgroundTask from 'expo-background-task';
import * as Crypto from 'expo-crypto';
import { File, FileMode, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, AssetField, AssetUriVersion, getPermissionsAsync, MediaType, Query, requestPermissionsAsync } from 'expo-media-library';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { allowBackgroundAccessToSession, authorizedSource, finishAndroidImport, androidImportProgress, androidImportStatus, listWorkspaces, makeAndroidBackupPrivate, restoreSession, type ApiUser, type Workspace } from '../api/client';
import { canUserImportAndroidLibrary } from '../auth/importAuthorization';
import { backupCounts, claimBackupItem, completeBackupItem, configureBackup, continueBackupItem, disableBackup, enqueueBackupPage, failBackupItem, getBackupSettings, setBackupError } from './androidBackupStore';

export const ANDROID_BACKUP_TASK = 'violetta-android-photo-backup-v1';
const DEVICE_ID = 'violetta.android-backup-device-v1';
const PAGE_SIZE = 100;
const STUDIO_PHONE_ID = '7277b107-5194-4337-b62a-7fb96d053f05';
const CHUNK_SIZE = 4 * 1024 * 1024;
let running: Promise<number> | null = null;
let activeUpload: FileSystem.UploadTask | null = null;
let stopRequested = false;
let foregroundEnabled = false;
const resolved = new Map<number, { uri: string; temporary: boolean }>();

async function forgetResolved(id: number) {
  const value = resolved.get(id);
  resolved.delete(id);
  if (value?.temporary) await FileSystem.deleteAsync(value.uri, { idempotent: true }).catch(() => undefined);
}

async function deviceId() {
  let id = await SecureStore.getItemAsync(DEVICE_ID);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID, id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  }
  return id;
}
async function keyFor(assetId: string, version: number, part: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${await deviceId()}\n${assetId}\n${version}\n${part}`);
}
async function fullPhotoPermission(request: boolean) {
  const permission = request ? await requestPermissionsAsync(false, ['photo', 'video']) : await getPermissionsAsync(false, ['photo', 'video']);
  if (!permission.granted || permission.accessPrivileges !== 'all') throw new Error('Для копирования всей медиатеки разрешите полный доступ ко всем фото и видео в настройках Android.');
}
async function allowedNetwork(allowCellular: boolean) {
  const network = await Network.getNetworkStateAsync();
  if (!network.isConnected || network.isInternetReachable === false) return false;
  return allowCellular || network.type === Network.NetworkStateType.WIFI || network.type === Network.NetworkStateType.ETHERNET;
}
async function clearErrorIfResolved(userId: string, workspaceId: string) {
  if ((await backupCounts(userId, workspaceId)).failed === 0) await setBackupError(userId, null);
}

export async function enableAndroidBackup(user: ApiUser, workspace: Workspace, allowCellular: boolean) {
  if (Platform.OS !== 'android' || !canUserImportAndroidLibrary(user)) throw new Error('Нет разрешения на синхронизацию медиатеки Android.');
  const current = (await restoreSession()).user;
  if (current.id !== user.id || !canUserImportAndroidLibrary(current)) throw new Error('Права пользователя изменились. Войдите снова.');
  const workspaces = await listWorkspaces();
  if (!workspaces.some((item) => item.id === workspace.id)) throw new Error('Выбранная папка недоступна.');
  await fullPhotoPermission(true);
  if (workspace.kind !== 'private' && workspace.id !== STUDIO_PHONE_ID) {
    const updated = await makeAndroidBackupPrivate(workspace.id);
    if (updated.kind !== 'private') throw new Error('Не удалось сделать папку приватной. Синхронизация не включена.');
  }
  try { await androidImportProgress(workspace.id, '0'.repeat(64), 1); }
  catch { throw new Error('Сервер пока не готов к синхронизации Android или доступ к папке запрещён. Обратитесь к администратору.'); }
  await allowBackgroundAccessToSession();
  await deviceId();
  await configureBackup(user.id, workspace.id, workspace.display_name, allowCellular);
  stopRequested = false;
  foregroundEnabled = true;
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(ANDROID_BACKUP_TASK))) await BackgroundTask.registerTaskAsync(ANDROID_BACKUP_TASK, { minimumInterval: 15 });
  } catch (error) {
    await disableBackup(user.id);
    foregroundEnabled = false;
    throw error;
  }
  void runAndroidBackup(20).catch(() => undefined);
}

export async function pauseAndroidBackup(userId: string) {
  stopRequested = true;
  foregroundEnabled = false;
  await disableBackup(userId);
  if (activeUpload) await activeUpload.cancelAsync().catch(() => undefined);
  await Promise.all(Array.from(resolved.keys(), (id) => forgetResolved(id)));
  if (await TaskManager.isTaskRegisteredAsync(ANDROID_BACKUP_TASK)) await BackgroundTask.unregisterTaskAsync(ANDROID_BACKUP_TASK);
}

export async function resumeAndroidBackup(user: ApiUser) {
  if (Platform.OS !== 'android' || !canUserImportAndroidLibrary(user)) return;
  const settings = await getBackupSettings(user.id);
  if (!settings.enabled || !settings.workspaceId) return;
  stopRequested = false;
  foregroundEnabled = true;
  if (!(await TaskManager.isTaskRegisteredAsync(ANDROID_BACKUP_TASK))) await BackgroundTask.registerTaskAsync(ANDROID_BACKUP_TASK, { minimumInterval: 15 });
  void runAndroidBackup(5).catch((error) => setBackupError(user.id, error instanceof Error ? error.message : 'Синхронизация временно недоступна.'));
}

async function performBackup(limit: number) {
  if (Platform.OS !== 'android') return 0;
  const user = (await restoreSession()).user;
  if (!canUserImportAndroidLibrary(user)) return 0;
  let settings = await getBackupSettings(user.id);
  if (!settings.enabled || !settings.workspaceId || stopRequested) return 0;
  const workspaceId = settings.workspaceId;
  if (!(await allowedNetwork(settings.allowCellular))) return 0;
  await fullPhotoPermission(false);
  const destination = (await listWorkspaces()).find((workspace) => workspace.id === workspaceId);
  if (!destination) throw new Error('Папка для синхронизации недоступна. Выберите другую в настройках.');
  if (destination.kind !== 'private' && destination.id !== STUDIO_PHONE_ID) throw new Error('Папка синхронизации общая. Откройте настройки и подтвердите перевод в приватную.');
  if (settings.scanOffset > 0 || Date.now() >= settings.nextScanAt) {
    const page = await new Query().within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO]).orderBy({ key: AssetField.CREATION_TIME, ascending: true }).offset(settings.scanOffset).limit(PAGE_SIZE).exeForMetadata();
    await enqueueBackupPage(user.id, workspaceId, page, settings.scanOffset + page.length, page.length < PAGE_SIZE);
  }
  let done = 0;
  for (let i = 0; i < limit; i++) {
    settings = await getBackupSettings(user.id);
    if (stopRequested || !settings.enabled || settings.workspaceId !== workspaceId || !(await allowedNetwork(settings.allowCellular))) break;
    const current = (await restoreSession()).user;
    if (current.id !== user.id || !canUserImportAndroidLibrary(current)) break;
    const item = await claimBackupItem(user.id, workspaceId);
    if (!item) break;
    let temporaryChunk: File | null = null;
    try {
      const importKey = await keyFor(item.assetId, item.version, item.part);
      if ((await androidImportStatus(workspaceId, importKey)).exists) {
        await completeBackupItem(item.id);
        await forgetResolved(item.id);
        await clearErrorIfResolved(user.id, workspaceId);
        done++;
        continue;
      }
      let cached = resolved.get(item.id);
      if (cached && !new File(cached.uri).exists) { resolved.delete(item.id); cached = undefined; }
      if (!cached) {
        const asset = new Asset(item.assetId);
        const uri = item.part === 'live-video' ? await asset.getLivePhotoVideoUri() : await asset.getUri({ version: AssetUriVersion.ORIGINAL });
        if (!uri || !uri.startsWith('file://')) throw new Error('Оригинал ещё недоступен. Приложение повторит попытку.');
        cached = { uri, temporary: item.part === 'live-video' || uri.includes('/MediaLibraryUriExtractorDirectory/') };
        resolved.set(item.id, cached);
      }
      const uri = cached.uri;
      if (!uri || !uri.startsWith('file://')) throw new Error('Оригинал ещё недоступен. Приложение повторит попытку.');
      const original = new File(uri);
      const total = original.size;
      if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Не удалось определить размер оригинала.');
      const progress = await androidImportProgress(workspaceId, importKey, total);
      if (progress.exists) { await completeBackupItem(item.id); await forgetResolved(item.id); await clearErrorIfResolved(user.id, workspaceId); done++; continue; }
      if (!Number.isSafeInteger(progress.offset) || progress.offset < 0 || progress.offset > total) throw new Error('Сервер вернул неверное состояние передачи.');
      const afterResolve = await getBackupSettings(user.id);
      const verifiedUser = (await restoreSession()).user;
      if (stopRequested || !afterResolve.enabled || afterResolve.workspaceId !== workspaceId || verifiedUser.id !== user.id || !canUserImportAndroidLibrary(verifiedUser) || !(await allowedNetwork(afterResolve.allowCellular))) throw new Error('Синхронизация приостановлена.');
      if (progress.offset === total) {
        await finishAndroidImport(workspaceId, importKey, total);
        await completeBackupItem(item.id); await forgetResolved(item.id); await clearErrorIfResolved(user.id, workspaceId); done++; continue;
      }
      const handle = original.open(FileMode.ReadOnly);
      let bytes: Uint8Array<ArrayBuffer>;
      try { handle.offset = progress.offset; bytes = await handle.readBytes(Math.min(CHUNK_SIZE, total - progress.offset)); }
      finally { handle.close(); }
      if (!bytes.length) throw new Error('Не удалось прочитать часть оригинала.');
      temporaryChunk = new File(Paths.cache, `violetta-android-part-${Crypto.randomUUID()}`);
      temporaryChunk.create(); temporaryChunk.write(bytes);
      const source = await authorizedSource(`/media/android-import/chunk?workspace_id=${encodeURIComponent(workspaceId)}&total=${total}&offset=${progress.offset}`);
      if (!source.headers?.Authorization) throw new Error('Войдите в приложение снова.');
      const filename = item.part === 'live-video' ? `${item.filename || 'live-photo'}.mov` : item.filename || `android-${item.id}`;
      activeUpload = FileSystem.createUploadTask(source.uri, temporaryChunk.uri, { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, sessionType: FileSystem.FileSystemSessionType.BACKGROUND, headers: { ...source.headers, 'Content-Type': 'application/octet-stream', 'X-Android-Import-Key': importKey, 'X-Android-Filename': encodeURIComponent(filename) } });
      const response = await activeUpload.uploadAsync();
      activeUpload = null;
      if (!response || response.status < 200 || response.status >= 300) {
        let detail = '';
        try { const body = JSON.parse(response?.body ?? '{}') as { detail?: unknown }; if (typeof body.detail === 'string') detail = `: ${body.detail}`; } catch { /* Some servers return plain text. */ }
        throw new Error(`Не удалось сохранить файл на сервере (${response?.status ?? 'нет ответа'})${detail}.`);
      }
      const acknowledged = JSON.parse(response.body) as { exists?: boolean; offset?: number };
      if (acknowledged.exists) { await completeBackupItem(item.id); await forgetResolved(item.id); }
      else if (acknowledged.offset === total) {
        const currentSettings = await getBackupSettings(user.id);
        if (stopRequested || !currentSettings.enabled || currentSettings.workspaceId !== workspaceId) { await continueBackupItem(item.id); break; }
        const finalUser = (await restoreSession()).user;
        if (finalUser.id !== user.id || !canUserImportAndroidLibrary(finalUser)) { await continueBackupItem(item.id); break; }
        await finishAndroidImport(workspaceId, importKey, total); await completeBackupItem(item.id); await forgetResolved(item.id);
      }
      else if (acknowledged.offset === progress.offset + bytes.length) await continueBackupItem(item.id);
      else throw new Error('Сервер не подтвердил переданную часть файла.');
      await clearErrorIfResolved(user.id, workspaceId);
      done++;
    } catch (error) {
      activeUpload = null;
      const message = error instanceof Error ? error.message : 'Не удалось передать файл.';
      await failBackupItem(item.id, item.attempts, message);
      await setBackupError(user.id, message);
      const latest = await getBackupSettings(user.id);
      if (stopRequested || !latest.enabled || latest.workspaceId !== workspaceId) { await forgetResolved(item.id); break; }
    } finally {
      if (temporaryChunk?.exists) { try { temporaryChunk.delete(); } catch {} }
    }
  }
  return done;
}

export function runAndroidBackup(limit = 3) {
  if (!running) running = performBackup(limit).finally(() => { running = null; });
  return running;
}
export function runAndroidBackupIfEnabled() { return foregroundEnabled ? runAndroidBackup(5) : Promise.resolve(0); }
export async function getAndroidBackupState(userId: string) {
  const settings = await getBackupSettings(userId);
  return { settings, counts: settings.workspaceId ? await backupCounts(userId, settings.workspaceId) : { waiting: 0, complete: 0, failed: 0 } };
}

if (Platform.OS === 'android' && !TaskManager.isTaskDefined(ANDROID_BACKUP_TASK)) {
  TaskManager.defineTask(ANDROID_BACKUP_TASK, async () => {
    try { await runAndroidBackup(); return BackgroundTask.BackgroundTaskResult.Success; }
    catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
}
