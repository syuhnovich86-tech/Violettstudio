import * as SQLite from 'expo-sqlite';
import { MediaSubtype, MediaType, type AssetMetadata } from 'expo-media-library';

export type BackupSettings = { userId: string; enabled: boolean; workspaceId: string | null; workspaceName: string | null; allowCellular: boolean; scanOffset: number; nextScanAt: number; lastError: string | null };
export type BackupItem = { id: number; assetId: string; version: number; part: 'original' | 'live-video'; filename: string | null; mediaType: 'image' | 'video'; attempts: number };
export type BackupCounts = { waiting: number; complete: number; failed: number };

let dbPromise: Promise<SQLite.SQLiteDatabase> | undefined;
async function db() {
  if (!dbPromise) dbPromise = (async () => {
    const result = await SQLite.openDatabaseAsync('violetta-iphone-backup-v2.db');
    await result.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, workspace_id TEXT, workspace_name TEXT, allow_cellular INTEGER NOT NULL DEFAULT 0, scan_offset INTEGER NOT NULL DEFAULT 0, next_scan_at INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      CREATE TABLE IF NOT EXISTS assets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, asset_id TEXT NOT NULL, version INTEGER NOT NULL, part TEXT NOT NULL, filename TEXT, media_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, UNIQUE(user_id, workspace_id, asset_id, version, part));
      CREATE INDEX IF NOT EXISTS assets_queue ON assets(user_id, workspace_id, status, next_attempt, id);`);
    return result;
  })();
  return dbPromise;
}

export async function getBackupSettings(userId: string): Promise<BackupSettings> {
  const database = await db();
  await database.runAsync('INSERT OR IGNORE INTO settings (user_id) VALUES (?)', userId);
  const row = await database.getFirstAsync<{ user_id: string; enabled: number; workspace_id: string | null; workspace_name: string | null; allow_cellular: number; scan_offset: number; next_scan_at: number; last_error: string | null }>('SELECT * FROM settings WHERE user_id = ?', userId);
  if (!row) throw new Error('Не удалось открыть настройки синхронизации.');
  return { userId: row.user_id, enabled: !!row.enabled, workspaceId: row.workspace_id, workspaceName: row.workspace_name, allowCellular: !!row.allow_cellular, scanOffset: row.scan_offset, nextScanAt: row.next_scan_at, lastError: row.last_error };
}

export async function configureBackup(userId: string, workspaceId: string, workspaceName: string, allowCellular: boolean) {
  const database = await db();
  await database.runAsync(`INSERT INTO settings(user_id, enabled, workspace_id, workspace_name, allow_cellular, scan_offset, next_scan_at, last_error) VALUES (?, 1, ?, ?, ?, 0, 0, NULL)
    ON CONFLICT(user_id) DO UPDATE SET enabled=1, workspace_id=excluded.workspace_id, workspace_name=excluded.workspace_name, allow_cellular=excluded.allow_cellular, scan_offset=CASE WHEN settings.workspace_id=excluded.workspace_id THEN settings.scan_offset ELSE 0 END, next_scan_at=CASE WHEN settings.workspace_id=excluded.workspace_id THEN settings.next_scan_at ELSE 0 END, last_error=NULL`, userId, workspaceId, workspaceName, allowCellular ? 1 : 0);
}

export async function disableBackup(userId: string) { await (await db()).runAsync('UPDATE settings SET enabled=0 WHERE user_id=?', userId); }
export async function setBackupError(userId: string, error: string | null) { await (await db()).runAsync('UPDATE settings SET last_error=? WHERE user_id=?', error?.slice(0, 500) ?? null, userId); }

export async function enqueueBackupPage(userId: string, workspaceId: string, items: AssetMetadata[], nextOffset: number, finished: boolean) {
  const database = await db();
  await database.withTransactionAsync(async () => {
    const current = await database.getFirstAsync<{ enabled: number; workspace_id: string | null }>('SELECT enabled, workspace_id FROM settings WHERE user_id=?', userId);
    if (!current?.enabled || current.workspace_id !== workspaceId) return;
    for (const item of items) {
      if (item.mediaType !== MediaType.IMAGE && item.mediaType !== MediaType.VIDEO) continue;
      const version = Math.floor(item.modificationTime ?? item.creationTime ?? 0);
      await database.runAsync('INSERT OR IGNORE INTO assets(user_id,workspace_id,asset_id,version,part,filename,media_type) VALUES(?,?,?,?,?,?,?)', userId, workspaceId, item.id, version, 'original', item.filename, item.mediaType);
      if (item.mediaType === MediaType.IMAGE && item.mediaSubtypes?.includes(MediaSubtype.LIVE_PHOTO)) {
        await database.runAsync('INSERT OR IGNORE INTO assets(user_id,workspace_id,asset_id,version,part,filename,media_type) VALUES(?,?,?,?,?,?,?)', userId, workspaceId, item.id, version, 'live-video', item.filename, 'video');
      }
    }
    await database.runAsync('UPDATE settings SET scan_offset=?, next_scan_at=? WHERE user_id=? AND enabled=1 AND workspace_id=?', finished ? 0 : nextOffset, finished ? Date.now() + 6 * 60 * 60 * 1000 : 0, userId, workspaceId);
  });
}

export async function claimBackupItem(userId: string, workspaceId: string): Promise<BackupItem | null> {
  const database = await db();
  const now = Date.now();
  const row = await database.getFirstAsync<{ id: number; asset_id: string; version: number; part: 'original' | 'live-video'; filename: string | null; media_type: 'image' | 'video'; attempts: number }>(`UPDATE assets SET status='uploading', lease_until=?, attempts=attempts+1 WHERE id=(SELECT id FROM assets WHERE user_id=? AND workspace_id=? AND ((status IN ('pending','failed') AND next_attempt<=?) OR (status='uploading' AND lease_until<=?)) ORDER BY id LIMIT 1) RETURNING id,asset_id,version,part,filename,media_type,attempts`, now + 2 * 60 * 1000, userId, workspaceId, now, now);
  return row ? { id: row.id, assetId: row.asset_id, version: row.version, part: row.part, filename: row.filename, mediaType: row.media_type, attempts: row.attempts } : null;
}

export async function completeBackupItem(id: number) { await (await db()).runAsync("UPDATE assets SET status='complete',last_error=NULL,lease_until=0 WHERE id=?", id); }
export async function continueBackupItem(id: number) { await (await db()).runAsync("UPDATE assets SET status='pending',attempts=0,next_attempt=0,last_error=NULL,lease_until=0 WHERE id=?", id); }
export async function failBackupItem(id: number, attempts: number, message: string) {
  const delay = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts, 9));
  await (await db()).runAsync("UPDATE assets SET status='failed',last_error=?,next_attempt=?,lease_until=0 WHERE id=?", message.slice(0, 500), Date.now() + delay, id);
}
export async function backupCounts(userId: string, workspaceId: string): Promise<BackupCounts> {
  const row = await (await db()).getFirstAsync<{ waiting: number; complete: number; failed: number }>("SELECT COALESCE(SUM(CASE WHEN status IN ('pending','uploading') THEN 1 ELSE 0 END),0) AS waiting, COALESCE(SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END),0) AS complete, COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM assets WHERE user_id=? AND workspace_id=?", userId, workspaceId);
  return row ?? { waiting: 0, complete: 0, failed: 0 };
}
