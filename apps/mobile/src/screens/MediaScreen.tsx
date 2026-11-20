import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authorizedSource, createWorkspace, deleteMedia, deleteWorkspace, getMediaFilterOptions, listMedia, listWorkspaces, moveMedia, setMediaComment, setMediaContentMark, setMediaPublication, type MediaFile, type Workspace } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { saveToGallery } from '../media/saveToGallery';
import { nextMediaPage } from '../media/yearNavigation';
import { Busy, Empty, ErrorState, Field, PrimaryButton, Sheet, formatBytes } from '../components/Common';
import { PageHeader } from '../components/PageHeader';
import { ProtectedImage } from '../components/ProtectedImage';
import { ProtectedVideo } from '../components/ProtectedVideo';
import { Screen } from '../components/Screen';
import { YearRail } from '../components/YearRail';
import { colors, typography } from '../theme';
import type { RootTabs } from '../navigation/types';

export function MediaScreen({ route, navigation }: BottomTabScreenProps<RootTabs, 'Archive'>) {
  const { user } = useAuth();
  const client = useQueryClient();
  const focused = useIsFocused();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces, refetchInterval: focused ? 30_000 : false });
  const [workspaceId, setWorkspaceId] = useState(route.params?.workspaceId ?? '');
  const [search, setSearch] = useState('');
  const [year, setYear] = useState<number | undefined>();
  const [month, setMonth] = useState<number | undefined>();
  const [place, setPlace] = useState<string | undefined>();
  const [clientName, setClientName] = useState('');
  const [procedure, setProcedure] = useState('');
  const [compactGallery, setCompactGallery] = useState(false);
  const [filterSheet, setFilterSheet] = useState(false);
  const [extraFilters, setExtraFilters] = useState(false);
  const [browseYear, setBrowseYear] = useState<number | undefined>();
  const yearsRef = useRef<number[]>([]);
  const [selected, setSelected] = useState<MediaFile | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [folderSheet, setFolderSheet] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderKind, setFolderKind] = useState<Workspace['kind']>('private');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const resultsY = useRef(0);
  const filterY = useRef(0);
  useEffect(() => { if (route.params?.workspaceId) setWorkspaceId(route.params.workspaceId); }, [route.params?.workspaceId]);
  useEffect(() => { if (workspaces.isSuccess && workspaceId && !workspaces.data.some((item) => item.id === workspaceId)) { setWorkspaceId(''); setSelected(null); } }, [workspaceId, workspaces.data, workspaces.isSuccess]);
  useEffect(() => { setYear(undefined); setMonth(undefined); setPlace(undefined); setClientName(''); setProcedure(''); setBrowseYear(undefined); setFilterSheet(false); }, [workspaceId]);
  useEffect(() => { if (route.params?.visitId) { setWorkspaceId(''); setSearch(''); } }, [route.params?.visitId]);
  useEffect(() => { setComment(selected?.comment ?? ''); }, [selected]);
  const media = useInfiniteQuery({
    queryKey: ['media', workspaceId, route.params?.visitId, year, month, place, clientName, procedure, search, browseYear],
    initialPageParam: { offset: 0, browseYear },
    queryFn: ({ pageParam }) => listMedia({ workspace_id: workspaceId || undefined, yclients_record_id: route.params?.visitId, capture_year: workspaceId ? year ?? pageParam.browseYear : undefined, capture_month: workspaceId ? month : undefined, location_key: workspaceId ? place : undefined, client: workspaceId ? clientName.trim() || undefined : undefined, procedure: workspaceId ? procedure.trim() || undefined : undefined, q: search.trim() || undefined, limit: 100, offset: pageParam.offset }),
    getNextPageParam: (lastPage, _pages, lastParam) => nextMediaPage(lastPage.length, lastParam, year, yearsRef.current),
  });
  const filterOptions = useQuery({ queryKey: ['media-filter-options', workspaceId, year, month], queryFn: () => getMediaFilterOptions(workspaceId, year, month), enabled: (Platform.OS === 'android' || Platform.OS === 'ios') && !!workspaceId, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === workspaceId ? previous : undefined });
  yearsRef.current = filterOptions.data?.years ?? [];
  const monthOptions = useMemo(() => Array.from(new Set((filterOptions.data?.months ?? []).filter((entry) => !year || entry.year === year).map((entry) => entry.month))).sort((a, b) => a - b), [filterOptions.data, year]);
  const allMedia = useMemo(() => media.data?.pages.flat() ?? [], [media.data]);
  const visible = useMemo(() => (Platform.OS === 'android' || Platform.OS === 'ios') ? allMedia : allMedia.filter((item) => !search.trim() || `${item.original_name} ${item.owner_name} ${item.workspace_name} ${item.comment ?? ''}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'))), [allMedia, search]);
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['media'] }), client.invalidateQueries({ queryKey: ['workspaces'] })]); };
  async function perform(action: () => Promise<unknown>, success?: string) {
    try { setBusy(true); await action(); await invalidate(); if (success) Alert.alert('Готово', success); }
    catch (error) { Alert.alert('Ошибка', error instanceof Error ? error.message : 'Операция не выполнена'); }
    finally { setBusy(false); }
  }
  async function createFolder() {
    if (folderName.trim().length < 2) return;
    await perform(async () => { const folder = await createWorkspace(folderName.trim(), folderKind); setWorkspaceId(folder.id); setFolderSheet(false); setFolderName(''); }, 'Папка создана');
  }
  async function shareFile(item: MediaFile) {
    try {
      setBusy(true);
      const source = await authorizedSource(`/media/${item.id}/download`);
      const safeName = item.original_name.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_');
      const file = new File(Paths.cache, `${item.id}-${safeName}`);
      const downloaded = await File.downloadFileAsync(source.uri, file, { headers: source.headers, idempotent: true });
      if (!(await Sharing.isAvailableAsync())) throw new Error('Системное меню отправки недоступно');
      await Sharing.shareAsync(downloaded.uri, { mimeType: item.mime_type, dialogTitle: 'Скачать или отправить файл' });
    } catch (error) { Alert.alert('Не удалось скачать', error instanceof Error ? error.message : 'Ошибка файла'); }
    finally { setBusy(false); }
  }
  return <Screen scrollRef={scrollRef} onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; if (contentOffset.y + layoutMeasurement.height > contentSize.height - 600 && media.hasNextPage && !media.isFetchingNextPage) void media.fetchNextPage(); }} overlay={workspaceId && !year && !month && !place && !clientName && !procedure && !search && !filterSheet ? <YearRail years={yearsRef.current} selected={browseYear} onSelect={(value) => { setBrowseYear(value); scrollRef.current?.scrollTo({ y: Math.max(0, resultsY.current - 12), animated: false }); }} /> : undefined}>
    <PageHeader editorial title="Архив" subtitle={route.params?.visitId ? 'Материалы выбранного визита' : 'Папки и файлы студии'} action="add-outline" onAction={() => setFolderSheet(true)} />
    <View style={styles.search}><Ionicons name="search" size={18} color={colors.muted} /><TextInput value={search} onChangeText={(value) => { setBrowseYear(undefined); setSearch(value); }} placeholder="Поиск по файлам и комментариям" placeholderTextColor={colors.muted} style={styles.searchInput} /></View>
    {workspaces.isLoading ? <Busy label="Загружаю папки…" /> : workspaces.error ? <ErrorState message={(workspaces.error as Error).message} onRetry={() => void workspaces.refetch()} /> : <View style={styles.folders}>
      <Pressable onPress={() => setWorkspaceId('')} style={[styles.folder, !workspaceId && styles.folderActive]}><Ionicons name="albums-outline" size={18} color={!workspaceId ? colors.white : colors.gold} /><Text numberOfLines={1} style={[styles.folderText, !workspaceId && styles.folderTextActive]}>Все</Text></Pressable>
      {(workspaces.data ?? []).filter((folder) => !workspaceId || folder.id === workspaceId).map((folder) => <Pressable key={folder.id} onPress={() => setWorkspaceId(folder.id)} style={[styles.folder, workspaceId === folder.id && styles.folderActive]}><Ionicons name={folder.kind === 'private' ? 'lock-closed-outline' : 'folder-open-outline'} size={18} color={workspaceId === folder.id ? colors.white : colors.gold} /><View style={styles.folderCopy}><Text numberOfLines={1} style={[styles.folderText, workspaceId === folder.id && styles.folderTextActive]}>{folder.display_name}</Text><Text style={[styles.folderCount, workspaceId === folder.id && styles.folderTextActive]}>{folder.file_count} · {formatBytes(folder.size_bytes)}</Text></View></Pressable>)}
    </View>}
    {(Platform.OS === 'android' || Platform.OS === 'ios') && workspaceId ? <View onLayout={(event) => { filterY.current = event.nativeEvent.layout.y; }}><PrimaryButton title={`Фильтры архива${year || month || place || clientName || procedure ? ' • выбраны' : ''}${filterSheet ? ' ↑' : ' ↓'}`} icon="filter-outline" tone="quiet" onPress={() => { const opening = !filterSheet; setFilterSheet(opening); if (opening) setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, filterY.current - 8), animated: true }), 120); }} /></View> : null}
    {workspaceId && browseYear !== undefined && !year ? <Pressable onPress={() => setBrowseYear(undefined)} style={styles.browseNote}><Text style={styles.kindText}>Переход к {browseYear} году · показать все годы</Text></Pressable> : null}
    {filterSheet && workspaceId ? <View style={styles.filterPanel}>
      {filterOptions.isLoading ? <Busy label="Загружаю фильтры…" /> : filterOptions.error ? <ErrorState message={(filterOptions.error as Error).message} onRetry={() => void filterOptions.refetch()} /> : <>
        <Text style={styles.label}>Год</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}><Pressable style={[styles.filterChip, !year && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setYear(undefined); setMonth(undefined); setPlace(undefined); }}><Text style={styles.kindText}>Все</Text></Pressable>{filterOptions.data?.years.map((value) => <Pressable key={value} style={[styles.filterChip, year === value && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setYear(value); setMonth(undefined); setPlace(undefined); }}><Text style={styles.kindText}>{value}</Text></Pressable>)}</ScrollView>
        <Text style={styles.label}>Месяц</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}><Pressable style={[styles.filterChip, !month && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setMonth(undefined); setPlace(undefined); }}><Text style={styles.kindText}>Все</Text></Pressable>{monthOptions.map((value) => <Pressable key={value} style={[styles.filterChip, month === value && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setMonth(value); setPlace(undefined); }}><Text style={styles.kindText}>{new Date(2020, value - 1, 1).toLocaleString('ru-RU', { month: 'long' })}</Text></Pressable>)}</ScrollView>
        <Text style={styles.label}>Место</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}><Pressable style={[styles.filterChip, !place && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setPlace(undefined); }}><Text style={styles.kindText}>Все места</Text></Pressable>{filterOptions.data?.places.map((entry) => <Pressable key={entry.key} style={[styles.filterChip, place === entry.key && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setPlace(entry.key); }}><Text style={styles.kindText}>{entry.label}</Text></Pressable>)}{(filterOptions.data?.without_location_count ?? 0) > 0 ? <Pressable style={[styles.filterChip, place === '__none__' && styles.kindActive]} onPress={() => { setBrowseYear(undefined); setPlace('__none__'); }}><Text style={styles.kindText}>Без геолокации ({filterOptions.data?.without_location_count})</Text></Pressable> : null}</ScrollView>
        <Pressable onPress={() => setExtraFilters(!extraFilters)} style={styles.extraToggle}><Text style={styles.kindText}>{extraFilters ? 'Скрыть' : 'Клиент и услуга'} {extraFilters ? '↑' : '↓'}</Text></Pressable>
        {extraFilters ? <>
        <Field label="Клиент визита" value={clientName} onChangeText={(value) => { setBrowseYear(undefined); setClientName(value); }} placeholder="Имя клиента" />
        <Field label="Услуга визита" value={procedure} onChangeText={(value) => { setBrowseYear(undefined); setProcedure(value); }} placeholder="Например, брови" />
        </> : null}
        {year || month || place || clientName || procedure ? <Pressable style={styles.extraToggle} onPress={() => { setBrowseYear(undefined); setYear(undefined); setMonth(undefined); setPlace(undefined); setClientName(''); setProcedure(''); }}><Text style={styles.kindText}>Сбросить фильтры</Text></Pressable> : null}

      </>}
    </View> : null}
    {(Platform.OS === 'android' || Platform.OS === 'ios') && workspaceId && !filterSheet && user?.can_upload_media ? <PrimaryButton title="Добавить фото из галереи" tone="ink" icon="images-outline" onPress={() => navigation.navigate('Add', { workspaceId })} /> : null}
    {(Platform.OS === 'android' || Platform.OS === 'ios') && workspaceId && !filterSheet && user?.can_delete_workspaces ? <PrimaryButton title="Удалить выбранную папку" icon="trash-outline" tone="danger" disabled={busy} onPress={() => {
      const folder = workspaces.data?.find((entry) => entry.id === workspaceId);
      if (!folder) return;
      Alert.alert(`Удалить папку «${folder.display_name}»?`, `Папка и все её файлы (${folder.file_count}) будут удалены. Файлы будут перемещены в корзину сервера.`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: () => void perform(async () => { await deleteWorkspace(folder.id); setWorkspaceId(''); }, 'Папка и её файлы удалены') }]);
    }} /> : null}
    <View onLayout={(event) => { resultsY.current = event.nativeEvent.layout.y; }}>
    {visible.length > 0 && <View style={styles.galleryToolbar}>
      <Text accessibilityRole="header" style={styles.galleryTitle}>Фото и видео</Text>
      <View style={styles.densityGroup}>{[false, true].map((compact) => <Pressable key={String(compact)} accessibilityRole="button" accessibilityLabel={compact ? 'Компактные миниатюры' : 'Крупные миниатюры'} accessibilityState={{ selected: compact === compactGallery }} onPress={() => setCompactGallery(compact)} style={[styles.densityButton, compact === compactGallery && styles.densityActive]}><Ionicons name={compact ? 'apps-outline' : 'grid-outline'} size={18} color={compact === compactGallery ? colors.cream : colors.ink} /></Pressable>)}</View>
    </View>}
    {media.isLoading ? <Busy label="Загружаю фотографии и видео…" /> : media.error ? <ErrorState message={(media.error as Error).message} onRetry={() => void media.refetch()} /> : visible.length === 0 ? <Empty title="Файлов пока нет" text="Добавьте материалы через центральную кнопку камеры или выберите другую папку." /> : <View style={styles.grid}>
      {visible.map((item) => <Pressable accessibilityRole="button" key={item.id} onPress={() => setSelected(item)} style={[styles.tile, compactGallery && styles.compactTile]}>
        <ProtectedImage path={`/media/${item.id}/thumbnail`} style={styles.thumb} />
        {item.media_type === 'video' ? <View style={styles.videoMark}><Ionicons name="play" size={15} color={colors.white} /></View> : null}
        {item.content_marked ? <View style={styles.contentMark}><Ionicons name="sparkles" size={13} color={colors.ink} /></View> : null}
        <View style={styles.tileFooter}><Text numberOfLines={1} style={styles.tileName}>{item.original_name}</Text><Text numberOfLines={1} style={styles.tileMeta}>{item.workspace_name} · {formatBytes(item.size_bytes)}</Text></View>
      </Pressable>)}
    </View>}
    {media.hasNextPage ? <View style={styles.more}><PrimaryButton title={media.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'} disabled={media.isFetchingNextPage} onPress={() => void media.fetchNextPage()} /></View> : null}
    </View>

    <Sheet visible={folderSheet} title="Новая папка" onClose={() => setFolderSheet(false)}>
      <Field label="Название * (не менее 2 символов)" value={folderName} onChangeText={setFolderName} placeholder="Например: До и после" />
      <Text style={styles.label}>Тип папки</Text><View style={styles.kindRow}><Pressable onPress={() => setFolderKind('private')} style={[styles.kind, folderKind === 'private' && styles.kindActive]}><Text style={styles.kindText}>Личная</Text></Pressable><Pressable onPress={() => setFolderKind('studio')} style={[styles.kind, folderKind === 'studio' && styles.kindActive]}><Text style={styles.kindText}>Общая</Text></Pressable></View>
      <PrimaryButton title="Создать папку" icon="folder-open-outline" disabled={busy || folderName.trim().length < 2} onPress={() => void createFolder()} />
    </Sheet>

    <Sheet visible={!!selected} title="Материал" onClose={() => setSelected(null)}>
      {selected ? <>
        {selected.media_type === 'video' ? <ProtectedVideo path={`/media/${selected.id}/preview`} /> : <>
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={() => setPhotoOpen(true)}>
            <ProtectedImage path={`/media/${selected.id}/preview`} style={styles.preview} />
            <View style={styles.expandPhoto}><Ionicons name="expand-outline" size={21} color={colors.white} /></View>
          </Pressable>
          <Modal visible={photoOpen} animationType="fade" onRequestClose={() => setPhotoOpen(false)}>
            <SafeAreaView style={styles.photoViewer} edges={['top', 'bottom']}>
              <View style={styles.photoHeader}><Pressable accessibilityRole="button" accessibilityLabel="Закрыть фотографию" onPress={() => setPhotoOpen(false)} style={styles.closePhoto}><Ionicons name="close" size={26} color={colors.white} /></Pressable></View>
              <ProtectedImage path={`/media/${selected.id}/preview`} resizeMode="contain" style={styles.fullPhoto} />
              <View style={styles.photoActions}><PrimaryButton title="Скачать или отправить" icon="share-outline" disabled={busy} onPress={() => void shareFile(selected)} /></View>
            </SafeAreaView>
          </Modal>
        </>}
        <PrimaryButton title="Скачать или отправить" icon="share-outline" tone="ink" disabled={busy} onPress={() => void shareFile(selected)} />
        {(Platform.OS === 'android' || Platform.OS === 'ios') ? <PrimaryButton title={selected.media_type === 'video' ? 'Сохранить видео в галерею' : 'Сохранить фото в галерею'} icon="download-outline" disabled={busy} onPress={() => void perform(() => saveToGallery(selected), `${selected.media_type === 'video' ? 'Видео сохранено' : 'Фото сохранено'} ${Platform.OS === 'ios' ? 'в Фото' : 'в альбом VIOLETTA на телефоне'}`)} /> : null}
        {user?.can_access_content && selected.publication_allowed ? <PrimaryButton title={selected.media_type === 'image' ? 'Создать контент / обработать фото' : 'Создать контент с видео'} icon="sparkles-outline" disabled={busy} onPress={() => { const sourceMedia = { id: selected.id, mediaType: selected.media_type }; setSelected(null); navigation.navigate('Content', { sourceMedia }); }} /> : null}
        {(Platform.OS === 'android' || Platform.OS === 'ios') && user?.can_access_chats ? <PrimaryButton title="Создать чат с этим файлом" icon="chatbubbles-outline" disabled={busy} onPress={() => { const sourceMedia = { id: selected.id, name: selected.original_name }; setSelected(null); navigation.navigate('Chats', { sourceMedia }); }} /> : null}
        <Text style={styles.details}>{selected.owner_name} · {selected.workspace_name} · {formatBytes(selected.size_bytes)}{selected.captured_at ? `\nСнято: ${new Date(selected.captured_at).toLocaleString('ru-RU')}` : ''}</Text>
        <Field label="Комментарий" value={comment} onChangeText={setComment} multiline placeholder="Добавьте комментарий к материалу" />
        <PrimaryButton title="Сохранить комментарий" icon="chatbox-outline" disabled={busy} onPress={() => void perform(async () => { const updated = await setMediaComment(selected.id, comment.trim() || null); setSelected(updated); }, 'Комментарий сохранён')} />
        <View style={styles.toggleRow}><View style={styles.toggleCopy}><Text style={styles.toggleTitle}>Разрешено к публикации</Text><Text style={styles.toggleText}>Материал можно использовать в контенте</Text></View><Switch value={selected.publication_allowed} onValueChange={(value) => void perform(async () => { const updated = await setMediaPublication(selected.id, value); setSelected(updated); })} /></View>
        <View style={styles.toggleRow}><View style={styles.toggleCopy}><Text style={styles.toggleTitle}>Отметить для контента</Text><Text style={styles.toggleText}>Показывать редактору в первую очередь</Text></View><Switch value={selected.content_marked} onValueChange={(value) => void perform(async () => { const updated = await setMediaContentMark(selected.id, value); setSelected(updated); })} /></View>
        <Text style={styles.label}>Переместить в папку</Text><View style={styles.moveList}>{(workspaces.data ?? []).map((folder) => <Pressable disabled={folder.id === selected.workspace_id || busy} key={folder.id} onPress={() => void perform(async () => { const updated = await moveMedia(selected.id, folder.id); setSelected(updated); }, `Файл перемещён в «${folder.display_name}»`)} style={[styles.move, folder.id === selected.workspace_id && styles.moveCurrent]}><Ionicons name="folder-outline" size={17} color={colors.gold} /><Text numberOfLines={1} style={styles.moveText}>{folder.display_name}</Text>{folder.id === selected.workspace_id ? <Ionicons name="checkmark" size={18} color={colors.green} /> : null}</Pressable>)}</View>
        {selected.can_delete ? <PrimaryButton title="Удалить файл" icon="trash-outline" tone="danger" disabled={busy} onPress={() => Alert.alert('Удалить файл?', 'Файл будет перемещён в корзину сервера.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: () => void perform(async () => { await deleteMedia(selected.id); setSelected(null); }, 'Файл удалён') }])} /> : null}
      </> : null}
    </Sheet>
  </Screen>;
}

const styles = StyleSheet.create({
  search: { height: 49, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.white, borderRadius: 16, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, marginBottom: 12 },
  searchInput: { flex: 1, color: colors.ink, fontSize: 13 },
  folders: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  folder: { minHeight: 54, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  folderActive: { backgroundColor: colors.ink, borderColor: colors.ink }, folderCopy: { maxWidth: 150 },
  folderText: { color: colors.ink, fontSize: 12, fontWeight: '800' }, folderTextActive: { color: colors.white }, folderCount: { color: colors.muted, fontSize: 9, marginTop: 2 },
  galleryToolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 10 },
  galleryTitle: { fontFamily: typography.serif, fontSize: 23, color: colors.ink },
  densityGroup: { flexDirection: 'row', borderRadius: 22, padding: 2, backgroundColor: colors.creamStrong },
  densityButton: { minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  densityActive: { backgroundColor: colors.ink }, compactTile: { width: '31.5%', borderRadius: 11 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  more: { width: '100%' },
  tile: { width: '48.4%', borderRadius: 18, overflow: 'hidden', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  thumb: { width: '100%', aspectRatio: 1 },
  tileFooter: { padding: 9 }, tileName: { color: colors.ink, fontSize: 11, fontWeight: '800' }, tileMeta: { color: colors.muted, fontSize: 9, marginTop: 3 },
  videoMark: { position: 'absolute', top: 8, left: 8, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(25,24,24,0.72)', alignItems: 'center', justifyContent: 'center' },
  contentMark: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.muted, fontSize: 11, fontWeight: '800', margin: 3 }, kindRow: { flexDirection: 'row', gap: 8, marginBottom: 14 }, kind: { flex: 1, padding: 14, backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: 'center' }, kindActive: { backgroundColor: colors.honey, borderColor: colors.gold }, kindText: { color: colors.ink, fontWeight: '800' },
  browseNote: { alignSelf: 'flex-start', padding: 9, marginBottom: 8, borderRadius: 12, backgroundColor: colors.greenSoft },
  filterPanel: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 12, marginVertical: 8 },
  extraToggle: { alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 4 },
  filterRow: { flexDirection: 'row', gap: 8, paddingVertical: 7 },
  filterChip: { minHeight: 42, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  preview: { width: '100%', aspectRatio: 1, borderRadius: 18, backgroundColor: colors.ink }, details: { color: colors.muted, fontSize: 11, lineHeight: 17, marginVertical: 13 },
  expandPhoto: { position: 'absolute', right: 12, bottom: 12, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center' },
  photoViewer: { flex: 1, backgroundColor: '#111111' }, photoHeader: { height: 52, alignItems: 'flex-end', paddingHorizontal: 14 }, closePhoto: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  fullPhoto: { width: '100%', flex: 1 }, photoActions: { paddingHorizontal: 18, paddingBottom: 10 },
  toggleRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.line }, toggleCopy: { flex: 1 }, toggleTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' }, toggleText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  moveList: { gap: 7, marginVertical: 8 }, move: { minHeight: 47, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, backgroundColor: colors.white, borderRadius: 13, borderWidth: 1, borderColor: colors.line }, moveCurrent: { backgroundColor: colors.greenSoft }, moveText: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '700' },
});
