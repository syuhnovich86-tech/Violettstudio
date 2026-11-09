import * as BackgroundTask from 'expo-background-task';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { Asset, AssetField, AssetUriVersion, getPermissionsAsync, MediaType, Query, requestPermissionsAsync } from 'expo-media-library';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { allowBackgroundAccessToSession, authorizedSource, finishIphoneImport, iphoneImportProgress, iphoneImportStatus, listWorkspaces, restoreSession, type ApiUser, type Workspace } from '../api/client';
import { canUserImportIphoneLibrary } from '../auth/importAuthorization';
import { backupCounts, claimBackupItem, completeBackupItem, configureBackup, continueBackupItem, disableBackup, enqueueBackupPage, failBackupItem, getBackupSettings, setBackupError } from './iphoneBackupStore';

export const IPHONE_BACKUP_TASK = 'violetta-iphone-photo-backup-v2';
const DEVICE_ID = 'violetta.iphone-backup-device-v2';
const PAGE_SIZE = 100;
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
  if (!permission.granted || permission.accessPrivileges !== 'all') throw new Error('Для копирования всей медиатеки разрешите полный доступ ко всем фото и видео в настройках iPhone.');
}
async function allowedNetwork(allowCellular: boolean) {
  const network = await Network.getNetworkStateAsync();
  if (!network.isConnected || network.isInternetReachable === false) return false;
  return allowCellular || network.type === Network.NetworkStateType.WIFI || network.type === Network.NetworkStateType.ETHERNET;
}

export async function enableIphoneBackup(user: ApiUser, workspace: Workspace, allowCellular: boolean) {
  if (Platform.OS !== 'ios' || !canUserImportIphoneLibrary(user)) throw new Error('Нет разрешения на синхронизацию медиатеки iPhone.');
  const current = (await restoreSession()).user;
  if (current.id !== user.id || !canUserImportIphoneLibrary(current)) throw new Error('Права пользователя изменились. Войдите снова.');
  const workspaces = await listWorkspaces();
  if (!workspaces.some((item) => item.id === workspace.id)) throw new Error('Выбранная папка недоступна.');
  if (workspace.kind !== 'private' && workspace.id !== '7277b107-5194-4337-b62a-7fb96d053f05') throw new Error('Выберите личную папку или общую папку «Телефон студии».');
  await fullPhotoPermission(true);
  try { await iphoneImportProgress(workspace.id, '0'.repeat(64), 1); }
  catch { throw new Error('Сервер пока не готов к синхронизации iPhone или доступ к папке запрещён. Обратитесь к администратору.'); }
  await allowBackgroundAccessToSession();
  await deviceId();
  await configureBackup(user.id, workspace.id, workspace.display_name, allowCellular);
  stopRequested = false;
  foregroundEnabled = true;
  try {
    if (!(await TaskManager.isTaskRegisteredAsync(IPHONE_BACKUP_TASK))) await BackgroundTask.registerTaskAsync(IPHONE_BACKUP_TASK, { minimumInterval: 15 });
  } catch (error) {
    await disableBackup(user.id);
    foregroundEnabled = false;
    throw error;
  }
  void runIphoneBackup(20).catch(() => undefined);
}

export async function pauseIphoneBackup(userId: string) {
  stopRequested = true;
  foregroundEnabled = false;
  await disableBackup(userId);
  if (activeUpload) await activeUpload.cancelAsync().catch(() => undefined);
  await Promise.all(Array.from(resolved.keys(), (id) => forgetResolved(id)));
  if (await TaskManager.isTaskRegisteredAsync(IPHONE_BACKUP_TASK)) await BackgroundTask.unregisterTaskAsync(IPHONE_BACKUP_TASK);
}

export async function resumeIphoneBackup(user: ApiUser) {
  if (Platform.OS !== 'ios' || !canUserImportIphoneLibrary(user)) return;
  const settings = await getBackupSettings(user.id);
  if (!settings.enabled || !settings.workspaceId) return;
  stopRequested = false;
  foregroundEnabled = true;
  if (!(await TaskManager.isTaskRegisteredAsync(IPHONE_BACKUP_TASK))) await BackgroundTask.registerTaskAsync(IPHONE_BACKUP_TASK, { minimumInterval: 15 });
  void runIphoneBackup(5).catch((error) => setBackupError(user.id, error instanceof Error ? error.message : 'Синхронизация временно недоступна.'));
}

async function performBackup(limit: number) {
  if (Platform.OS !== 'ios') return 0;
  const user = (await restoreSession()).user;
  if (!canUserImportIphoneLibrary(user)) return 0;
  let settings = await getBackupSettings(user.id);
  if (!settings.enabled || !settings.workspaceId || stopRequested) return 0;
  const workspaceId = settings.workspaceId;
  if (!(await allowedNetwork(settings.allowCellular))) return 0;
  await fullPhotoPermission(false);
  if (!(await listWorkspaces()).some((workspace) => workspace.id === workspaceId)) throw new Error('Папка для синхронизации недоступна. Выберите другую в настройках.');
  if (settings.scanOffset > 0 || Date.now() >= settings.nextScanAt) {
    const page = await new Query().within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO]).orderBy({ key: AssetField.CREATION_TIME, ascending: true }).offset(settings.scanOffset).limit(PAGE_SIZE).exeForMetadata();
    await enqueueBackupPage(user.id, workspaceId, page, settings.scanOffset + page.length, page.length < PAGE_SIZE);
  }
  let done = 0;
  for (let i = 0; i < limit; i++) {
    settings = await getBackupSettings(user.id);
    if (stopRequested || !settings.enabled || settings.workspaceId !== workspaceId || !(await allowedNetwork(settings.allowCellular))) break;
    const current = (await restoreSession()).user;
    if (current.id !== user.id || !canUserImportIphoneLibrary(current)) break;
    const item = await claimBackupItem(user.id, workspaceId);
    if (!item) break;
    let temporaryChunk: File | null = null;
    try {
      const importKey = await keyFor(item.assetId, item.version, item.part);
      if ((await iphoneImportStatus(workspaceId, importKey)).exists) {
        await completeBackupItem(item.id);
        await forgetResolved(item.id);
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
      const progress = await iphoneImportProgress(workspaceId, importKey, total);
      if (progress.exists) { await completeBackupItem(item.id); await forgetResolved(item.id); done++; continue; }
      if (!Number.isSafeInteger(progress.offset) || progress.offset < 0 || progress.offset > total) throw new Error('Сервер вернул неверное состояние передачи.');
      const afterResolve = await getBackupSettings(user.id);
      const verifiedUser = (await restoreSession()).user;
      if (stopRequested || !afterResolve.enabled || afterResolve.workspaceId !== workspaceId || verifiedUser.id !== user.id || !canUserImportIphoneLibrary(verifiedUser) || !(await allowedNetwork(afterResolve.allowCellular))) throw new Error('Синхронизация приостановлена.');
      if (progress.offset === total) {
        await finishIphoneImport(workspaceId, importKey, total);
        await completeBackupItem(item.id); await forgetResolved(item.id); await setBackupError(user.id, null); done++; continue;
      }
      const handle = original.open();
      let bytes: Uint8Array<ArrayBuffer>;
      try { handle.offset = progress.offset; bytes = await handle.readBytes(Math.min(CHUNK_SIZE, total - progress.offset)); }
      finally { handle.close(); }
      if (!bytes.length) throw new Error('Не удалось прочитать часть оригинала.');
      temporaryChunk = new File(Paths.cache, `violetta-iphone-part-${Crypto.randomUUID()}`);
      temporaryChunk.create(); temporaryChunk.write(bytes);
      const source = await authorizedSource(`/media/ios-import/chunk?workspace_id=${encodeURIComponent(workspaceId)}&total=${total}&offset=${progress.offset}`);
      if (!source.headers?.Authorization) throw new Error('Войдите в приложение снова.');
      const filename = item.part === 'live-video' ? `${item.filename || 'live-photo'}.mov` : item.filename || `iphone-${item.id}`;
      activeUpload = FileSystem.createUploadTask(source.uri, temporaryChunk.uri, { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, sessionType: FileSystem.FileSystemSessionType.BACKGROUND, headers: { ...source.headers, 'Content-Type': 'application/octet-stream', 'X-Ios-Import-Key': importKey, 'X-Ios-Filename': encodeURIComponent(filename) } });
      const response = await activeUpload.uploadAsync();
      activeUpload = null;
      if (!response || response.status < 200 || response.status >= 300) throw new Error(`Не удалось сохранить файл на сервере (${response?.status ?? 'нет ответа'}).`);
      const acknowledged = JSON.parse(response.body) as { exists?: boolean; offset?: number };
      if (acknowledged.exists) { await completeBackupItem(item.id); await forgetResolved(item.id); }
      else if (acknowledged.offset === total) {
        const currentSettings = await getBackupSettings(user.id);
        if (stopRequested || !currentSettings.enabled || currentSettings.workspaceId !== workspaceId) { await continueBackupItem(item.id); break; }
        const finalUser = (await restoreSession()).user;
        if (finalUser.id !== user.id || !canUserImportIphoneLibrary(finalUser)) { await continueBackupItem(item.id); break; }
        await finishIphoneImport(workspaceId, importKey, total); await completeBackupItem(item.id); await forgetResolved(item.id);
      }
      else if (acknowledged.offset === progress.offset + bytes.length) await continueBackupItem(item.id);
      else throw new Error('Сервер не подтвердил переданную часть файла.');
      await setBackupError(user.id, null);
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

export function runIphoneBackup(limit = 3) {
  if (!running) running = performBackup(limit).finally(() => { running = null; });
  return running;
}
export function runIphoneBackupIfEnabled() { return foregroundEnabled ? runIphoneBackup(5) : Promise.resolve(0); }
export async function getIphoneBackupState(userId: string) {
  const settings = await getBackupSettings(userId);
  return { settings, counts: settings.workspaceId ? await backupCounts(userId, settings.workspaceId) : { waiting: 0, complete: 0, failed: 0 } };
}

if (Platform.OS === 'ios' && !TaskManager.isTaskDefined(IPHONE_BACKUP_TASK)) {
  TaskManager.defineTask(IPHONE_BACKUP_TASK, async () => {
    try { await runIphoneBackup(); return BackgroundTask.BackgroundTaskResult.Success; }
    catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
}
