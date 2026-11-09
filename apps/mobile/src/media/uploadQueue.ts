import * as SQLite from 'expo-sqlite';

import type { LibraryAsset } from './photoLibraryImporter';

export type LocalMediaFile = {
  uri: string;
  filename?: string | null;
  mediaType: 'image' | 'video';
};

export type QueueSummary = {
  pending: number;
  resolving: number;
  uploading: number;
  completed: number;
  failed: number;
};

export type IphoneSyncSettings = {
  enabled: boolean;
  targetWorkspaceName: string;
  lastIncrementalScan: number | null;
  lastFullScan: number | null;
};

export type QueuedAsset = {
  id: number;
  jobId: string;
  targetWorkspaceName: string;
  photoAssetId: string | null;
  localUri: string | null;
  filename: string | null;
  mediaType: 'image' | 'video';
  creationTime: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  attemptCount: number;
};

export const IPHONE_WORKSPACE_NAME = 'Фото с iPhone';

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | undefined;

function database() {
  databasePromise ??= SQLite.openDatabaseAsync('violetta-mobile.db');
  return databasePromise;
}

export async function initializeUploadQueue() {
  const db = await database();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      target_workspace_name TEXT NOT NULL DEFAULT 'Фото с iPhone',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      client_asset_key TEXT NOT NULL UNIQUE,
      photo_asset_id TEXT,
      local_uri TEXT,
      filename TEXT,
      media_type TEXT NOT NULL,
      creation_time INTEGER,
      width INTEGER,
      height INTEGER,
      duration REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS import_assets_status_idx ON import_assets(status, created_at);
    CREATE TABLE IF NOT EXISTS iphone_sync_settings (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      target_workspace_name TEXT NOT NULL DEFAULT 'Фото с iPhone',
      last_incremental_scan INTEGER,
      last_full_scan INTEGER,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO iphone_sync_settings (singleton, updated_at) VALUES (1, 0);
  `);

  const jobColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(import_jobs)');
  if (!jobColumns.some((column) => column.name === 'target_workspace_name')) {
    await db.execAsync("ALTER TABLE import_jobs ADD COLUMN target_workspace_name TEXT NOT NULL DEFAULT 'Фото с iPhone'");
  }
}

function jobId(source: string) {
  return `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function enqueuePhotoLibrary(assets: LibraryAsset[]) {
  await initializeUploadQueue();
  const db = await database();
  const id = jobId('ios-library');
  const now = Date.now();

  await db.withTransactionAsync(async () => {
    await db.runAsync('INSERT INTO import_jobs (id, source, target_workspace_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, 'ios-photo-library', IPHONE_WORKSPACE_NAME, now, now);
    for (const asset of assets) {
      await db.runAsync(
        `INSERT OR IGNORE INTO import_assets
          (job_id, client_asset_key, photo_asset_id, filename, media_type, creation_time, width, height, duration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        `photokit:${asset.id}`,
        asset.id,
        asset.filename,
        asset.mediaType,
        asset.creationTime,
        asset.width,
        asset.height,
        asset.duration,
        now,
        now,
      );
    }
  });
  return id;
}

export async function enqueueLocalFiles(files: LocalMediaFile[], source: 'camera' | 'picker') {
  await initializeUploadQueue();
  const db = await database();
  const id = jobId(source);
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync('INSERT INTO import_jobs (id, source, created_at, updated_at) VALUES (?, ?, ?, ?)', id, source, now, now);
    for (const file of files) {
      await db.runAsync(
        `INSERT OR IGNORE INTO import_assets
          (job_id, client_asset_key, local_uri, filename, media_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        `${source}:${file.uri}`,
        file.uri,
        file.filename ?? null,
        file.mediaType,
        now,
        now,
      );
    }
  });
  return id;
}

export async function getQueueSummary(): Promise<QueueSummary> {
  await initializeUploadQueue();
  const db = await database();
  const rows = await db.getAllAsync<{ status: keyof QueueSummary; count: number }>(
    'SELECT status, COUNT(*) AS count FROM import_assets GROUP BY status',
  );
  const summary: QueueSummary = { pending: 0, resolving: 0, uploading: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in summary) summary[row.status] = row.count;
  }
  return summary;
}

export async function getIphoneSyncSettings(): Promise<IphoneSyncSettings> {
  await initializeUploadQueue();
  const db = await database();
  const rows = await db.getAllAsync<{
    enabled: number;
    target_workspace_name: string;
    last_incremental_scan: number | null;
    last_full_scan: number | null;
  }>('SELECT enabled, target_workspace_name, last_incremental_scan, last_full_scan FROM iphone_sync_settings WHERE singleton = 1');
  const row = rows[0];
  return {
    enabled: row?.enabled === 1,
    targetWorkspaceName: row?.target_workspace_name ?? IPHONE_WORKSPACE_NAME,
    lastIncrementalScan: row?.last_incremental_scan ?? null,
    lastFullScan: row?.last_full_scan ?? null,
  };
}

export async function setIphoneSyncEnabled(enabled: boolean) {
  await initializeUploadQueue();
  const db = await database();
  await db.runAsync(
    'UPDATE iphone_sync_settings SET enabled = ?, target_workspace_name = ?, updated_at = ? WHERE singleton = 1',
    enabled ? 1 : 0,
    IPHONE_WORKSPACE_NAME,
    Date.now(),
  );
}

export async function recordIphoneScan(kind: 'incremental' | 'full', timestamp: number) {
  await initializeUploadQueue();
  const db = await database();
  const column = kind === 'full' ? 'last_full_scan' : 'last_incremental_scan';
  await db.runAsync(`UPDATE iphone_sync_settings SET ${column} = ?, updated_at = ? WHERE singleton = 1`, timestamp, Date.now());
}

export async function claimNextQueuedAsset(): Promise<QueuedAsset | null> {
  await initializeUploadQueue();
  const db = await database();
  const rows = await db.getAllAsync<{
    id: number;
    job_id: string;
    target_workspace_name: string;
    photo_asset_id: string | null;
    local_uri: string | null;
    filename: string | null;
    media_type: 'image' | 'video';
    creation_time: number | null;
    width: number | null;
    height: number | null;
    duration: number | null;
    attempt_count: number;
  }>(
    `SELECT a.id, a.job_id, j.target_workspace_name, a.photo_asset_id, a.local_uri, a.filename,
            a.media_type, a.creation_time, a.width, a.height, a.duration, a.attempt_count
       FROM import_assets a JOIN import_jobs j ON j.id = a.job_id
      WHERE a.status IN ('pending', 'failed') AND a.attempt_count < 6
      ORDER BY a.created_at, a.id LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  await db.runAsync(
    "UPDATE import_assets SET status = 'resolving', attempt_count = attempt_count + 1, last_error = NULL, updated_at = ? WHERE id = ?",
    Date.now(),
    row.id,
  );
  return {
    id: row.id,
    jobId: row.job_id,
    targetWorkspaceName: row.target_workspace_name,
    photoAssetId: row.photo_asset_id,
    localUri: row.local_uri,
    filename: row.filename,
    mediaType: row.media_type,
    creationTime: row.creation_time,
    width: row.width,
    height: row.height,
    duration: row.duration,
    attemptCount: row.attempt_count + 1,
  };
}

export async function markQueuedAssetUploading(id: number, localUri: string) {
  const db = await database();
  await db.runAsync("UPDATE import_assets SET status = 'uploading', local_uri = ?, updated_at = ? WHERE id = ?", localUri, Date.now(), id);
}

export async function markQueuedAssetCompleted(id: number) {
  const db = await database();
  await db.runAsync("UPDATE import_assets SET status = 'completed', last_error = NULL, updated_at = ? WHERE id = ?", Date.now(), id);
}

export async function markQueuedAssetFailed(id: number, error: string) {
  const db = await database();
  await db.runAsync("UPDATE import_assets SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", error.slice(0, 1000), Date.now(), id);
}
