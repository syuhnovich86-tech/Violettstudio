import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'expo-sqlite') return { url: new URL('./test-support/mock-expo-sqlite.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === 'expo-media-library') return { url: new URL('./test-support/mock-expo-media-library.mjs', import.meta.url).href, shortCircuit: true };
  if (specifier === 'expo-secure-store') return { url: new URL('./test-support/mock-expo-secure-store.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
process.env.VIOLETTA_TEST_DB ||= join(mkdtempSync(join(tmpdir(), 'violetta-queue-')), 'queue.db');
const store = await import('../src/media/iphoneBackupStore.ts');
const { canUserImportIphoneLibrary } = await import('../src/auth/importAuthorization.ts');
const granted = { is_active: true, can_upload_media: true, can_import_ios_photo_library: true, role: 'admin' };
assert.equal(canUserImportIphoneLibrary(granted), true);
assert.equal(canUserImportIphoneLibrary({ ...granted, role: 'employee' }), false);
assert.equal(canUserImportIphoneLibrary({ ...granted, can_import_ios_photo_library: false }), false);
assert.equal(canUserImportIphoneLibrary({ ...granted, is_active: false }), false);

if (process.argv.includes('--check-restart')) {
  assert.equal((await store.getBackupSettings('admin-a')).workspaceId, 'folder-a');
  assert.deepEqual(await store.backupCounts('admin-a', 'folder-a'), { waiting: 1, complete: 1, failed: 1 });
  process.exit(0);
}

const image = { id: 'photo', filename: 'image.heic', mediaType: 'image', creationTime: 1, modificationTime: 2, width: 10, height: 10, duration: null, isFavorite: false, mediaSubtypes: ['livePhoto'] };
const video = { ...image, id: 'video', filename: 'video.mov', mediaType: 'video', mediaSubtypes: [] };
assert.equal((await store.getBackupSettings('admin-a')).enabled, false);
await store.configureBackup('admin-a', 'folder-a', 'Фото A', false);
await store.enqueueBackupPage('admin-a', 'folder-a', [image, video], 2, true);
await store.enqueueBackupPage('admin-a', 'folder-a', [image, video], 2, true);
assert.deepEqual(await store.backupCounts('admin-a', 'folder-a'), { waiting: 3, complete: 0, failed: 0 });
const first = await store.claimBackupItem('admin-a', 'folder-a');
assert.equal(first.part, 'original');
await store.completeBackupItem(first.id);
const second = await store.claimBackupItem('admin-a', 'folder-a');
assert.equal(second.part, 'live-video');
await store.failBackupItem(second.id, second.attempts, 'network');
const third = await store.claimBackupItem('admin-a', 'folder-a');
assert.equal(third.assetId, 'video');
await store.continueBackupItem(third.id);
assert.deepEqual(await store.backupCounts('admin-a', 'folder-a'), { waiting: 1, complete: 1, failed: 1 });
await store.configureBackup('admin-b', 'folder-b', 'Фото B', true);
assert.equal(await store.claimBackupItem('admin-b', 'folder-b'), null);
await store.configureBackup('admin-a', 'folder-b', 'Фото B', false);
await store.enqueueBackupPage('admin-a', 'folder-a', [video], 1, true);
assert.equal(await store.claimBackupItem('admin-a', 'folder-b'), null);
await store.configureBackup('admin-a', 'folder-a', 'Фото A', false);
const child = spawnSync(process.execPath, [process.argv[1], '--check-restart'], { env: process.env, encoding: 'utf8' });
assert.equal(child.status, 0, child.stderr);
await store.disableBackup('admin-a');
assert.equal((await store.getBackupSettings('admin-a')).enabled, false);
console.log('iPhone backup queue: isolation, Live Photo, retries and restart passed');
