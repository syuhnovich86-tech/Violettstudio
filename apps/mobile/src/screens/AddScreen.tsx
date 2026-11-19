import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Alert, Image, Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { createMediaBatch, listVisits, listWorkspaces, uploadMedia, type Visit } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Busy, Empty, ErrorState, Field, PrimaryButton, Sheet } from '../components/Common';
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
  const [cameraReady, setCameraReady] = useState(false);
  const capturing = useRef(false);
  const [folderSheet, setFolderSheet] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [visit, setVisit] = useState<Visit | null>(null);
  const [visitSheet, setVisitSheet] = useState(false);
  const [batchComment, setBatchComment] = useState('');
  const [publicationAllowed, setPublicationAllowed] = useState(true);
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
    setCameraReady(false);
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
    if (!cameraReady || capturing.current || files.length >= 20) return;
    capturing.current = true;
    const device = camera.current;
    try {
      const picture = await device?.takePictureAsync({ quality: 1 });
      if (!picture || camera.current !== device) return;
      setCameraOpen(false);
      addFiles([{ ...picture, type: 'image', fileName: 'camera-' + Date.now() + '.jpg', mimeType: 'image/jpeg', assetId: null, width: picture.width, height: picture.height }]);
    } catch {
      if (camera.current === device) Alert.alert('Не удалось сделать снимок', 'Попробуйте ещё раз или выберите файл из галереи.');
    } finally { capturing.current = false; }
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
  const folder = workspaces.data?.find((item) => item.id === workspaceId);
  const sourceDisabled = uploading || files.length >= 20;
  if (cameraOpen && focused && user?.can_upload_media) return <Modal visible onRequestClose={() => setCameraOpen(false)} animationType="none">
    <SafeAreaView style={styles.cameraScreen}>
      <View style={styles.cameraHeader}>
        <View style={styles.visitCopy}><Text style={styles.cameraTitle}>Съёмка фото</Text><Text numberOfLines={1} style={styles.cameraFolder}>{folder?.display_name}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Закрыть камеру" onPress={() => setCameraOpen(false)} style={styles.closeCamera}><Ionicons name="close" size={24} color={colors.white} /></Pressable>
      </View>
      <View style={styles.finder}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setCameraReady(true)} onMountError={() => { setCameraOpen(false); Alert.alert('Камера недоступна', 'Можно выбрать фото из галереи.'); }} />
        <View pointerEvents="none" style={[styles.guide, styles.guideTop]} /><View pointerEvents="none" style={[styles.guide, styles.guideBottom]} />
      </View>
      <View style={styles.shutterBar}><Pressable accessibilityRole="button" accessibilityLabel="Сделать снимок" accessibilityState={{ disabled: !cameraReady }} disabled={!cameraReady} onPress={() => void capture()} style={({pressed}) => [styles.shutter, (pressed || !cameraReady) && styles.dim]}><View style={styles.shutterInner} /></Pressable></View>
    </SafeAreaView>
  </Modal>;
  return <Screen>
    <PageHeader title="Съёмка и загрузка" helpTopic="Добавить" subtitle="До 20 фото и видео за одну загрузку" />
    {!user?.can_upload_media ? <Empty icon="lock-closed-outline" title="Загрузка запрещена" text="Администратор не выдал вашему аккаунту право добавлять материалы." /> : <>
      <Pressable accessibilityRole="button" accessibilityLabel="Снять фото" disabled={sourceDisabled} onPress={() => void openCamera()} style={({pressed}) => [styles.sourceCamera, (pressed || sourceDisabled) && styles.dim]}>
        <View style={styles.trigger}><View style={styles.triggerCore} /></View>
        <View style={styles.visitCopy}><Text style={styles.sourceTitle}>Снять фото</Text><Text style={styles.sourceHint}>Камера телефона</Text></View>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={sourceDisabled} onPress={() => void pick()} style={({pressed}) => [styles.galleryButton, (pressed || sourceDisabled) && styles.dim]}>
        <Ionicons name="images-outline" size={22} color={colors.gold} /><View style={styles.visitCopy}><Text style={styles.galleryTitle}>Из галереи</Text><Text style={styles.visitText}>Фото и видео · до 20 файлов</Text></View><Ionicons name="chevron-forward" size={18} color={colors.muted} />
      </Pressable>
      <Text accessibilityRole="header" style={styles.section}>Папка для сохранения</Text>
      {workspaces.isLoading ? <Busy label="Загружаю папки…" /> : workspaces.isError && !folder ? <ErrorState message="Не удалось загрузить папки" onRetry={() => void workspaces.refetch()} /> :
        <Pressable accessibilityRole="button" accessibilityLabel={'Выбрать папку: ' + (folder?.display_name || 'Папка не выбрана')} disabled={uploading} onPress={() => setFolderSheet(true)} style={styles.visitPick}>
          <Ionicons name={folder?.kind === 'private' ? 'lock-closed-outline' : 'folder-open-outline'} size={21} color={colors.gold} /><Text style={[styles.visitCopy, styles.visitTitle]}>{folder?.display_name || 'Выбрать папку'}</Text><Ionicons name="chevron-down" size={17} color={colors.muted} />
        </Pressable>}
      <Text style={styles.section}>Привязка к визиту</Text>
      <Pressable accessibilityRole="button" disabled={uploading} onPress={() => setVisitSheet(true)} style={styles.visitPick}><Ionicons name="calendar-outline" size={21} color={colors.gold} /><View style={styles.visitCopy}><Text style={styles.visitTitle}>{visit?.client_name || 'Без привязки к визиту'}</Text><Text style={styles.visitText}>{visit ? `${visit.starts_at ? new Date(visit.starts_at).toLocaleString('ru-RU') : ''} ${visit.services.join(' · ')}` : 'Можно выбрать реальный визит из YCLIENTS'}</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable>
      <Field label="Комментарий ко всей серии" value={batchComment} onChangeText={setBatchComment} placeholder="Что было снято" multiline />
      <View style={styles.toggle}><View style={styles.toggleCopy}><Text style={styles.toggleTitle}>Разрешить публикацию</Text><Text style={styles.toggleText}>Можно изменить позже для каждого файла</Text></View><Switch accessibilityLabel="Разрешить публикацию" disabled={uploading} value={publicationAllowed} onValueChange={setPublicationAllowed} /></View>
      <Text style={styles.section}>Выбрано: {files.length}/20 {complete ? `· загружено ${complete}` : ''}</Text>
      {files.length ? <View style={styles.files}>{files.map((file) => <View key={file.id} style={styles.file}>{file.mediaType === 'video' ? <View style={[styles.fileImage, styles.videoThumb]}><Ionicons name="videocam-outline" size={21} color={colors.gold} /></View> : <Image source={{ uri: file.uri }} style={styles.fileImage} />}<View style={styles.fileCopy}><Text numberOfLines={1} style={styles.fileName}>{file.filename}</Text><Text style={[styles.fileStatus, file.status === 'failed' && styles.failed]}>{file.status === 'ready' ? 'Готов к загрузке' : file.status === 'uploading' ? 'Загружается…' : file.status === 'done' ? 'Загружен' : file.error}</Text></View>{!uploading && file.status !== 'done' ? <Pressable accessibilityRole="button" accessibilityLabel={'Убрать ' + file.filename} style={styles.remove} onPress={() => setFiles((current) => current.filter((item) => item.id !== file.id))}><Ionicons name="close-circle" size={23} color={colors.muted} /></Pressable> : file.status === 'done' ? <Ionicons name="checkmark-circle" size={23} color={colors.green} /> : null}</View>)}</View> : null}
      <PrimaryButton title={uploading ? 'Загрузка…' : files.some((file) => file.status === 'failed') ? 'Повторить неудачные' : `Загрузить ${files.filter((file) => file.status !== 'done').length} файлов`} tone="ink" icon="cloud-upload-outline" disabled={uploading || !workspaceId || !files.some((file) => file.status !== 'done')} onPress={() => void startUpload()} />
    </>}
    <Sheet visible={folderSheet} title="Папка для сохранения" onClose={() => setFolderSheet(false)}>
      {workspaces.data?.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: workspaceId === item.id }} style={styles.visitOption} onPress={() => { setWorkspaceId(item.id); setFolderSheet(false); }}>
        <Ionicons name={item.kind === 'private' ? 'lock-closed-outline' : 'folder-open-outline'} color={colors.gold} size={21} /><Text style={[styles.visitCopy, styles.visitTitle]}>{item.display_name}</Text>{workspaceId === item.id && <Ionicons name="checkmark" color={colors.gold} size={21} />}
      </Pressable>)}
    </Sheet>
    <Sheet visible={visitSheet} title="Выбрать визит" onClose={() => setVisitSheet(false)}>
      <Pressable onPress={() => { setVisit(null); setVisitSheet(false); }} style={styles.visitOption}><Text style={styles.visitTitle}>Без привязки</Text><Ionicons name="remove-circle-outline" size={20} color={colors.muted} /></Pressable>
      {visits.isLoading ? <Busy /> : visits.data?.map((item) => <Pressable key={item.record_id} onPress={() => { setVisit(item); setVisitSheet(false); }} style={styles.visitOption}><View style={styles.visitCopy}><Text style={styles.visitTitle}>{item.client_name || 'Клиент не указан'}</Text><Text style={styles.visitText}>{new Date(item.starts_at).toLocaleString('ru-RU')} · {item.services.join(' · ')}</Text></View>{visit?.record_id === item.record_id ? <Ionicons name="checkmark-circle" size={22} color={colors.green} /> : null}</Pressable>)}
    </Sheet>
  </Screen>;
}

const styles = StyleSheet.create({
  sourceCamera: { minHeight: 126, flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20, borderRadius: 18, backgroundColor: '#262320' },
  trigger: { width: 56, height: 56, borderWidth: 2, borderColor: colors.honey, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  triggerCore: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#F0DEBE' },
  sourceTitle: { color: colors.cream, fontFamily: typography.serif, fontSize: 28 }, sourceHint: { color: '#DDCCB3', fontSize: 13, marginTop: 4 },
  galleryButton: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 14, marginTop: 8 },
  galleryTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  section: { color: colors.ink, fontFamily: typography.serif, fontSize: 21, marginTop: 18, marginBottom: 8 },
  visitPick: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderRadius: 17, borderWidth: 1, borderColor: colors.line, padding: 13 }, visitCopy: { flex: 1 }, visitTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, visitText: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 }, visitOption: { minHeight: 67, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
  toggle: { minHeight: 65, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line }, toggleCopy: { flex: 1 }, toggleTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, toggleText: { color: colors.muted, fontSize: 10, marginTop: 3 },
  files: { gap: 8 }, file: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, fileImage: { width: 50, height: 50, borderRadius: 12, backgroundColor: colors.creamStrong }, fileCopy: { flex: 1 }, fileName: { color: colors.ink, fontSize: 13, fontWeight: '800' }, fileStatus: { color: colors.muted, fontSize: 12, marginTop: 4 }, failed: { color: '#A1372B' },
  cameraScreen: { flex: 1, backgroundColor: '#1F1C19' },
  cameraHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 9 },
  cameraTitle: { fontFamily: typography.serif, fontSize: 24, color: colors.cream }, cameraFolder: { color: colors.honey, fontSize: 13 },
  closeCamera: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3D3730' },
  finder: { flex: 1, overflow: 'hidden', backgroundColor: '#100F0F' }, guide: { width: 26, height: 26, position: 'absolute', borderColor: '#F4E2C4' },
  guideTop: { top: '8%', left: '8%', borderTopWidth: 1, borderLeftWidth: 1 }, guideBottom: { bottom: '8%', right: '8%', borderBottomWidth: 1, borderRightWidth: 1 },
  shutterBar: { alignItems: 'center', paddingVertical: 16 }, shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 2, borderColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#F4E2C4' },
  dim: { opacity: 0.65 }, videoThumb: { alignItems: 'center', justifyContent: 'center' }, remove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
