import { ApiError, listWorkspaces, uploadMedia } from '../api/client';
import { MediaType } from 'expo-media-library';
import { resolveOriginal, type LibraryAsset } from './photoLibraryImporter';
import {
  claimNextQueuedAsset,
  markQueuedAssetCompleted,
  markQueuedAssetFailed,
  markQueuedAssetUploading,
} from './uploadQueue';

export type UploadRunResult = { completed: number; failed: number; authenticationRequired: boolean };

export async function drainUploadQueue(maxFiles = 3): Promise<UploadRunResult> {
  const result: UploadRunResult = { completed: 0, failed: 0, authenticationRequired: false };
  const workspaces = await listWorkspaces();

  for (let index = 0; index < maxFiles; index += 1) {
    const queued = await claimNextQueuedAsset();
    if (!queued) break;
    try {
      const workspace = workspaces.find((item) => item.display_name === queued.targetWorkspaceName);
      if (!workspace) throw new Error(`На сервере не найдена папка «${queued.targetWorkspaceName}».`);

      let uri = queued.localUri;
      if (!uri && queued.photoAssetId) {
        const asset: LibraryAsset = {
          id: queued.photoAssetId,
          filename: queued.filename,
          mediaType: queued.mediaType === 'video' ? MediaType.VIDEO : MediaType.IMAGE,
          creationTime: queued.creationTime,
          width: queued.width,
          height: queued.height,
          duration: queued.duration,
        };
        uri = (await resolveOriginal(asset)).uri;
      }
      if (!uri) throw new Error('Не удалось получить локальный оригинал файла.');
      await markQueuedAssetUploading(queued.id, uri);
      await uploadMedia({
        uri,
        filename: queued.filename || `${queued.photoAssetId || queued.id}.${queued.mediaType === 'video' ? 'mp4' : 'jpg'}`,
        mediaType: queued.mediaType,
        workspaceId: workspace.id,
      });
      await markQueuedAssetCompleted(queued.id);
      result.completed += 1;
    } catch (error) {
      await markQueuedAssetFailed(queued.id, error instanceof Error ? error.message : 'Неизвестная ошибка загрузки');
      result.failed += 1;
      if (error instanceof ApiError && error.status === 401) {
        result.authenticationRequired = true;
        break;
      }
    }
  }
  return result;
}
