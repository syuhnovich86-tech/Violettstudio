import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import { authorizedSource, type MediaFile } from '../api/client';

export async function saveToGallery(item: MediaFile): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) throw new Error('Разрешите приложению сохранять файлы в галерею в настройках телефона.');
  const source = await authorizedSource(`/media/${item.id}/download`);
  const safeName = item.original_name.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_');
  const extension = /\.[a-z0-9]{2,5}$/i.test(safeName) ? '' : item.media_type === 'video' ? '.mp4' : '.jpg';
  const file = new File(Paths.cache, `${item.id}-${safeName}${extension}`);
  const downloaded = await File.downloadFileAsync(source.uri, file, { headers: source.headers, idempotent: true });
  // Creating directly from the downloaded file avoids a second copy in DCIM.
  // Photos and videos then appear together in the VIOLETTA album.
  await MediaLibrary.createAlbumAsync('VIOLETTA', undefined, false, downloaded.uri);
}
