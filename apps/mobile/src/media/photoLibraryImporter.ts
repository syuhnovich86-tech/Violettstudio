import { Asset, AssetField, AssetUriVersion, getPermissionsAsync, MediaType, Query, requestPermissionsAsync } from 'expo-media-library';

export type LibraryAsset = {
  id: string;
  filename: string | null;
  mediaType: MediaType;
  creationTime: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
};

export type ResolvedLibraryAsset = LibraryAsset & {
  uri: string;
  wasInICloud: boolean;
};

const PAGE_SIZE = 250;

export async function scanPhotoLibrary(
  onProgress?: (count: number) => void,
  options: { sinceMilliseconds?: number; requestPermission?: boolean } = {},
): Promise<LibraryAsset[]> {
  const permission = options.requestPermission === false
    ? await getPermissionsAsync(false, ['photo', 'video'])
    : await requestPermissionsAsync(false, ['photo', 'video']);
  if (!permission.granted || permission.accessPrivileges !== 'all') {
    throw new Error('Для импорта нужен полный доступ к Фото. Разрешение можно изменить в настройках iPhone.');
  }

  const result: LibraryAsset[] = [];
  let offset = 0;

  while (true) {
    let query = new Query()
      .within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
      .orderBy({ key: AssetField.MODIFICATION_TIME, ascending: true });
    if (options.sinceMilliseconds) query = query.gte(AssetField.MODIFICATION_TIME, options.sinceMilliseconds);
    const page = await query
      .offset(offset)
      .limit(PAGE_SIZE)
      .exeForMetadata();

    result.push(...page);
    onProgress?.(result.length);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  return result;
}

// getUri(ORIGINAL) заставляет PhotoKit получить оригинал, в том числе из iCloud,
// и возвращает локальный URI для последующей возобновляемой загрузки.
export async function resolveOriginal(asset: LibraryAsset): Promise<ResolvedLibraryAsset> {
  const nativeAsset = new Asset(asset.id);
  const wasInICloud = await nativeAsset.getIsInCloud();
  const uri = await nativeAsset.getUri({ version: AssetUriVersion.ORIGINAL });
  return { ...asset, uri, wasInICloud };
}
