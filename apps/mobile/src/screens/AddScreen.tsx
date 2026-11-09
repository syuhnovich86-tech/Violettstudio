import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { createMediaBatch, listVisits, listWorkspaces, uploadMedia, type Visit } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Busy, Empty, Field, PrimaryButton, Sheet } from '../components/Common';
import { PageHeader } from '../components/PageHeader';
import { Screen } from '../components/Screen';
import { colors, typography } from '../theme';
import type { RootTabs } from '../navigation/types';

type PendingFile = { id: string; uri: string; filename: string; mediaType: 'image' | 'video'; mimeType?: string | null; status: 'ready' | 'uploading' | 'done' | 'failed'; error?: string };
const iso = (date: Date) => date.toISOString().slice(0, 10);

export function AddScreen({ route, navigation }: BottomTabScreenProps<RootTabs, 'Add'>) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const camera = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [visit, setVisit] = useState<Visit | null>(null);
  const [visitSheet, setVisitSheet] = useState(false);
  const [batchComment, setBatchComment] = useState('');
  const [publicationAllowed, setPublicationAllowed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const focused = useIsFocused();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: listWorkspaces, refetchInterval: focused ? 30_000 : false });
  useEffect(() => { if (route.params?.workspaceId) setWorkspaceId(route.params.workspaceId); }, [route.params?.workspaceId]);
  const now = new Date(); const rangeStart = new Date(now); rangeStart.setDate(now.getDate() - 31); const rangeEnd = new Date(now); rangeEnd.setDate(now.getDate() + 62);
  const visits = useQuery({ queryKey: ['visits-upload', iso(rangeStart), iso(rangeEnd)], queryFn: () => listVisits(iso(rangeStart), iso(rangeEnd)), staleTime: 0, refetchInterval: visitSheet ? 30_000 : false });
  useEffect(() => {
    const first = workspaces.data?.find((item) => !/(iphone|айфон)/i.test(item.display_name)) ?? workspaces.data?.[0];
    if (!workspaceId && first && !route.params?.workspaceId) setWorkspaceId(first.id);
  }, [workspaceId, workspaces.data, route.params?.workspaceId]);
  useEffect(() => { if (route.params?.visitId && visits.data) setVisit(visits.data.find((item) => item.record_id === route.params?.visitId) ?? { record_id: route.params.visitId, client_name: route.params.visitName ?? null, starts_at: '', services: [], comment: null, media_count: 0, staff_name: null, user_id: null }); }, [route.params?.visitId, route.params?.visitName, visits.data]);
  const complete = files.filter((file) => file.status === 'done').length;
  async function openCamera() {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) return Alert.alert('Нет доступа к камере', 'Разрешите камеру в системных настройках Android.');
    setCameraOpen(true);
  }
  function addFiles(assets: ImagePicker.ImagePickerAsset[]) {
    const additions: PendingFile[] = assets.map((asset, index) => ({ id: `${Date.now()}-${index}-${asset.assetId ?? ''}`, uri: asset.uri, filename: asset.fileName || `media-${Date.now()}-${index}.${asset.type === 'video' ? 'mp4' : 'jpg'}`, mediaType: asset.type === 'video' ? 'video' : 'image', mimeType: asset.mimeType, status: 'ready' }));
    setFiles((current) => [...current, ...additions].slice(0, 20));
  }
  async function pick() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: Math.max(1, 20 - files.length), quality: 1, exif: false });
    if (!result.canceled) addFiles(result.assets);
  }
  async function capture() {
    const picture = await camera.current?.takePictureAsync({ quality: 1 });
    if (!picture) return;
    setCameraOpen(false);
    addFiles([{ ...picture, type: 'image', fileName: `camera-${Date.now()}.jpg`, mimeType: 'image/jpeg', assetId: null, width: picture.width, height: picture.height }]);
  }
  async function startUpload() {
    if (!workspaceId || !files.some((file) => file.status !== 'done')) return;
    try {
      setUploading(true);
      const batch = await createMediaBatch(workspaceId, visit?.record_id ?? null, batchComment.trim() || null);
      let uploadedCount = 0;
      let failedCount = 0;
      for (const file of files) {
        if (file.status === 'done') continue;
        setFiles((current) => current.map((item) => item.id === file.id ? { ...item, status: 'uploading', error: undefined } : item));
        try {
          await uploadMedia({ uri: file.uri, filename: file.filename, mediaType: file.mediaType, mimeType: file.mimeType, workspaceId, visitId: visit?.record_id, batchId: batch.id, publicationAllowed });
          setFiles((current) => current.map((item) => item.id === file.id ? { ...item, status: 'done' } : item));
          uploadedCount += 1;
        } catch (error) {
          setFiles((current) => current.map((item) => item.id === file.id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : 'Ошибка загрузки' } : item));
          failedCount += 1;
        }
      }
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['media'] }), queryClient.invalidateQueries({ queryKey: ['workspaces'] }), queryClient.invalidateQueries({ queryKey: ['visits'] })]);
      if (failedCount === 0) {
        Alert.alert('Загрузка завершена', `${uploadedCount} материалов уже видны в архиве.`, [{ text: 'Открыть архив', onPress: () => navigation.navigate('Archive', { workspaceId }) }, { text: 'Остаться' }]);
      } else if (uploadedCount > 0) {
        Alert.alert('Загружено не всё', `Успешно: ${uploadedCount}. Не удалось: ${failedCount}. Неудачные файлы можно повторить.`, [{ text: 'Открыть архив', onPress: () => navigation.navigate('Archive', { workspaceId }) }, { text: 'Повторить позже' }]);
      } else {
        Alert.alert('Файлы не загружены', 'Сервер не получил выбранные материалы. Проверьте ошибку у файла и повторите загрузку.');
      }
    } catch (error) { Alert.alert('Не удалось создать серию', error instanceof Error ? error.message : 'Ошибка сервера'); }
    finally { setUploading(false); }
  }
  if (cameraOpen) return <View style={styles.cameraScreen}><CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" /><Pressable accessibilityLabel="Закрыть камеру" onPress={() => setCameraOpen(false)} style={styles.closeCamera}><Ionicons name="close" size={29} color={colors.white} /></Pressable><Pressable accessibilityLabel="Сделать снимок" onPress={() => void capture()} style={styles.shutter}><View style={styles.shutterInner} /></Pressable></View>;
  return <Screen>
    <PageHeader kicker="Загрузка" title="Добавить" subtitle="Камера и файлы Android сразу загружаются в выбранную папку сервера" />
    {!user?.can_upload_media ? <Empty icon="lock-closed-outline" title="Загрузка запрещена" text="Администратор не выдал вашему аккаунту право добавлять материалы." /> : <>
      <View style={styles.sourceRow}><Pressable onPress={() => void openCamera()} style={[styles.source, styles.cameraSource]}><Ionicons name="camera" size={36} color={colors.ink} /><Text style={styles.sourceTitle}>Камера</Text><Text style={styles.sourceText}>Снять фото</Text></Pressable><Pressable onPress={() => void pick()} style={[styles.source, styles.gallerySource]}><Ionicons name="images" size={36} color={colors.ink} /><Text style={styles.sourceTitle}>Галерея</Text><Text style={styles.sourceText}>До 20 файлов</Text></Pressable></View>
      <Text style={styles.section}>Папка на сервере</Text>
      {workspaces.isLoading ? <Busy label="Загружаю папки…" /> : <View style={styles.folders}>{workspaces.data?.map((folder) => <Pressable key={folder.id} onPress={() => setWorkspaceId(folder.id)} style={[styles.folder, workspaceId === folder.id && styles.folderActive]}><Ionicons name={folder.kind === 'private' ? 'lock-closed-outline' : 'folder-open-outline'} size={17} color={workspaceId === folder.id ? colors.white : colors.gold} /><Text numberOfLines={1} style={[styles.folderText, workspaceId === folder.id && styles.folderTextActive]}>{folder.display_name}</Text></Pressable>)}</View>}
      <Text style={styles.section}>Привязка к визиту</Text>
      <Pressable onPress={() => setVisitSheet(true)} style={styles.visitPick}><Ionicons name="calendar-outline" size={21} color={colors.gold} /><View style={styles.visitCopy}><Text style={styles.visitTitle}>{visit?.client_name || 'Без привязки к визиту'}</Text><Text style={styles.visitText}>{visit ? `${visit.starts_at ? new Date(visit.starts_at).toLocaleString('ru-RU') : ''} ${visit.services.join(' · ')}` : 'Можно выбрать реальный визит из YCLIENTS'}</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable>
      <Field label="Комментарий ко всей серии" value={batchComment} onChangeText={setBatchComment} placeholder="Что было снято" multiline />
      <View style={styles.toggle}><View style={styles.toggleCopy}><Text style={styles.toggleTitle}>Разрешить публикацию</Text><Text style={styles.toggleText}>Можно изменить позже для каждого файла</Text></View><Switch value={publicationAllowed} onValueChange={setPublicationAllowed} /></View>
      <Text style={styles.section}>Выбрано: {files.length}/20 {complete ? `· загружено ${complete}` : ''}</Text>
      {files.length ? <View style={styles.files}>{files.map((file) => <View key={file.id} style={styles.file}><Image source={{ uri: file.uri }} style={styles.fileImage} /><View style={styles.fileCopy}><Text numberOfLines={1} style={styles.fileName}>{file.filename}</Text><Text style={[styles.fileStatus, file.status === 'failed' && styles.failed]}>{file.status === 'ready' ? 'Готов к загрузке' : file.status === 'uploading' ? 'Загружается…' : file.status === 'done' ? 'Загружен' : file.error}</Text></View>{!uploading && file.status !== 'done' ? <Pressable onPress={() => setFiles((current) => current.filter((item) => item.id !== file.id))}><Ionicons name="close-circle" size={23} color={colors.muted} /></Pressable> : file.status === 'done' ? <Ionicons name="checkmark-circle" size={23} color={colors.green} /> : null}</View>)}</View> : <Empty icon="images-outline" title="Файлы не выбраны" text="Сделайте снимок или выберите фото и видео из галереи Android." />}
      <PrimaryButton title={uploading ? 'Загрузка…' : files.some((file) => file.status === 'failed') ? 'Повторить неудачные' : `Загрузить ${files.filter((file) => file.status !== 'done').length} файлов`} icon="cloud-upload-outline" disabled={uploading || !workspaceId || !files.some((file) => file.status !== 'done')} onPress={() => void startUpload()} />
    </>}
    <Sheet visible={visitSheet} title="Выбрать визит" onClose={() => setVisitSheet(false)}>
      <Pressable onPress={() => { setVisit(null); setVisitSheet(false); }} style={styles.visitOption}><Text style={styles.visitTitle}>Без привязки</Text><Ionicons name="remove-circle-outline" size={20} color={colors.muted} /></Pressable>
      {visits.isLoading ? <Busy /> : visits.data?.map((item) => <Pressable key={item.record_id} onPress={() => { setVisit(item); setVisitSheet(false); }} style={styles.visitOption}><View style={styles.visitCopy}><Text style={styles.visitTitle}>{item.client_name || 'Клиент не указан'}</Text><Text style={styles.visitText}>{new Date(item.starts_at).toLocaleString('ru-RU')} · {item.services.join(' · ')}</Text></View>{visit?.record_id === item.record_id ? <Ionicons name="checkmark-circle" size={22} color={colors.green} /> : null}</Pressable>)}
    </Sheet>
  </Screen>;
}

const styles = StyleSheet.create({
  sourceRow: { flexDirection: 'row', gap: 10 }, source: { flex: 1, minHeight: 150, borderRadius: 23, padding: 17, justifyContent: 'flex-end' }, cameraSource: { backgroundColor: colors.honey }, gallerySource: { backgroundColor: colors.coral }, sourceTitle: { color: colors.ink, fontFamily: typography.serif, fontSize: 21, marginTop: 14 }, sourceText: { color: colors.ink, opacity: 0.6, fontSize: 10, fontWeight: '800', marginTop: 3 },
  section: { color: colors.ink, fontFamily: typography.serif, fontSize: 20, marginTop: 20, marginBottom: 9 }, folders: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, folder: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 14, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, folderActive: { backgroundColor: colors.ink }, folderText: { color: colors.ink, fontSize: 11, fontWeight: '800', maxWidth: 160 }, folderTextActive: { color: colors.white },
  visitPick: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderRadius: 17, borderWidth: 1, borderColor: colors.line, padding: 13 }, visitCopy: { flex: 1 }, visitTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, visitText: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 }, visitOption: { minHeight: 67, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  toggle: { minHeight: 65, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, toggleCopy: { flex: 1 }, toggleTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, toggleText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  files: { gap: 8 }, file: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, fileImage: { width: 50, height: 50, borderRadius: 12, backgroundColor: colors.creamStrong }, fileCopy: { flex: 1 }, fileName: { color: colors.ink, fontSize: 11, fontWeight: '800' }, fileStatus: { color: colors.muted, fontSize: 9, marginTop: 4 }, failed: { color: '#A1372B' },
  cameraScreen: { flex: 1, backgroundColor: colors.ink }, closeCamera: { position: 'absolute', top: 54, left: 20, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(25,24,24,0.55)' }, shutter: { position: 'absolute', bottom: 52, alignSelf: 'center', width: 88, height: 88, borderRadius: 44, borderWidth: 5, borderColor: colors.white, alignItems: 'center', justifyContent: 'center' }, shutterInner: { width: 67, height: 67, borderRadius: 34, backgroundColor: colors.honey },
});
