import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { hasPersistedImportPermission } from '../auth/importAuthorization';
import { scanPhotoLibrary } from './photoLibraryImporter';
import {
  enqueuePhotoLibrary,
  getIphoneSyncSettings,
  recordIphoneScan,
  setIphoneSyncEnabled,
} from './uploadQueue';
import { drainUploadQueue } from './uploadWorker';

export const IPHONE_SYNC_TASK = 'violetta-iphone-library-sync';
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FULL_RECONCILIATION_MS = 7 * 24 * 60 * 60 * 1000;

export async function runIphoneLibrarySync() {
  const settings = await getIphoneSyncSettings();
  if (!settings.enabled || !(await hasPersistedImportPermission())) return 0;

  const now = Date.now();
  const needsFullScan = !settings.lastFullScan || now - settings.lastFullScan > FULL_RECONCILIATION_MS;
  const sinceMilliseconds = needsFullScan || !settings.lastIncrementalScan
    ? undefined
    : Math.max(0, settings.lastIncrementalScan - FIVE_MINUTES_MS);
  const assets = await scanPhotoLibrary(undefined, { sinceMilliseconds, requestPermission: false });
  if (assets.length) await enqueuePhotoLibrary(assets);
  await drainUploadQueue(3);
  await recordIphoneScan('incremental', now);
  if (needsFullScan) await recordIphoneScan('full', now);
  return assets.length;
}

if (!TaskManager.isTaskDefined(IPHONE_SYNC_TASK)) {
  TaskManager.defineTask(IPHONE_SYNC_TASK, async () => {
    try {
      await runIphoneLibrarySync();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function enableIphoneBackgroundSync() {
  if (!(await hasPersistedImportPermission())) throw new Error('У пользователя нет специального права импорта.');
  await setIphoneSyncEnabled(true);
  if (!(await TaskManager.isTaskRegisteredAsync(IPHONE_SYNC_TASK))) {
    await BackgroundTask.registerTaskAsync(IPHONE_SYNC_TASK, { minimumInterval: 15 });
  }
}

export async function disableIphoneBackgroundSync() {
  await setIphoneSyncEnabled(false);
  if (await TaskManager.isTaskRegisteredAsync(IPHONE_SYNC_TASK)) {
    await BackgroundTask.unregisterTaskAsync(IPHONE_SYNC_TASK);
  }
}
