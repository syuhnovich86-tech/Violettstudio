import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import { Alert, AppState, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { authorizedSource, listCalendarUsers, listMedia, listVisits, syncVisits, type MediaFile } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { saveToGallery } from '../media/saveToGallery';
import { Busy, Empty, ErrorState, PrimaryButton, Sheet } from '../components/Common';
import { PageHeader } from '../components/PageHeader';
import { ProtectedImage } from '../components/ProtectedImage';
import { ProtectedVideo } from '../components/ProtectedVideo';
import { Screen } from '../components/Screen';
import { colors, typography } from '../theme';
import type { RootTabs } from '../navigation/types';

const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const weekdays = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const isoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function VisitMedia({ visitId }: { visitId: number }) {
  const [selectedFile, setSelectedFile] = useState<MediaFile | null>(null);
  const [sharing, setSharing] = useState(false);
  const media = useInfiniteQuery({
    queryKey: ['media', 'visit', visitId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => listMedia({ yclients_record_id: visitId, limit: 100, offset: pageParam }),
    getNextPageParam: (lastPage, pages) => lastPage.length === 100 ? pages.length * 100 : undefined,
  });
  const files = media.data?.pages.flat() ?? [];

  async function shareFile(file: MediaFile) {
    try {
      setSharing(true);
      const source = await authorizedSource(`/media/${file.id}/download`);
      const safeName = file.original_name.replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_');
      const downloaded = await File.downloadFileAsync(source.uri, new File(Paths.cache, `${file.id}-${safeName}`), { headers: source.headers, idempotent: true });
      if (!(await Sharing.isAvailableAsync())) throw new Error('Системное меню отправки недоступно');
      await Sharing.shareAsync(downloaded.uri, { mimeType: file.mime_type, dialogTitle: 'Скачать или отправить файл' });
    } catch (error) {
      Alert.alert('Не удалось скачать', error instanceof Error ? error.message : 'Ошибка файла');
    } finally { setSharing(false); }
  }

  return <View style={styles.visitMedia}>
    {media.isLoading ? <Busy label="Загружаю материалы визита…" /> : media.isError && !files.length ? <ErrorState message={(media.error as Error).message} onRetry={() => void media.refetch()} /> : files.length ? <>
      <View style={styles.mediaGrid}>{files.map((file, index) => <Pressable accessibilityRole="button" accessibilityLabel={`${file.media_type === 'video' ? 'Видео' : 'Фото'} ${index + 1}`} key={file.id} onPress={() => setSelectedFile(file)} style={styles.mediaTile}>
        <ProtectedImage path={`/media/${file.id}/thumbnail`} style={styles.mediaThumb} />
        {file.media_type === 'video' ? <View style={styles.videoBadge}><Ionicons name="play" size={17} color={colors.white} /></View> : null}
      </Pressable>)}</View>
      {media.isFetchNextPageError ? <Text style={styles.mediaMessage}>Не удалось загрузить остальные файлы. Попробуйте ещё раз.</Text> : null}
      {media.hasNextPage ? <PrimaryButton title={media.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'} disabled={media.isFetchingNextPage} onPress={() => void media.fetchNextPage()} /> : null}
    </> : <Text style={styles.mediaMessage}>К этому визиту пока не прикреплены файлы.</Text>}
    <Sheet visible={!!selectedFile} title="Материал визита" onClose={() => setSelectedFile(null)}>
      {selectedFile ? <>
        {selectedFile.media_type === 'video' ? <ProtectedVideo path={`/media/${selectedFile.id}/preview`} /> : <ProtectedImage path={`/media/${selectedFile.id}/preview`} style={styles.preview} />}
        <PrimaryButton title="Скачать или отправить" icon="share-outline" tone="ink" disabled={sharing} onPress={() => void shareFile(selectedFile)} />
        {Platform.OS === 'android' ? <PrimaryButton title={selectedFile.media_type === 'video' ? 'Сохранить видео в галерею' : 'Сохранить фото в галерею'} icon="download-outline" disabled={sharing} onPress={() => { setSharing(true); void saveToGallery(selectedFile).then(() => Alert.alert('Готово', `${selectedFile.media_type === 'video' ? 'Видео сохранено' : 'Фото сохранено'} в альбом VIOLETTA на телефоне`)).catch((error) => Alert.alert('Не удалось сохранить', error instanceof Error ? error.message : 'Ошибка файла')).finally(() => setSharing(false)); }} /> : null}
      </> : null}
    </Sheet>
  </View>;
}

export function CalendarScreen({ navigation }: BottomTabScreenProps<RootTabs, 'Visits'>) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => isoDate(new Date()));
  const [calendarUser, setCalendarUser] = useState(user?.id ?? '');
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [expandedVisits, setExpandedVisits] = useState<Set<number>>(() => new Set());
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const users = useQuery({ queryKey: ['calendar-users'], queryFn: listCalendarUsers, refetchInterval: focused && foreground ? 30_000 : false });
  const visits = useQuery({ queryKey: ['visits', isoDate(start), isoDate(end), calendarUser], queryFn: () => listVisits(isoDate(start), isoDate(end), calendarUser || undefined), refetchInterval: focused && foreground ? 30_000 : false });
  useEffect(() => { const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => { if (focused && foreground) { void client.invalidateQueries({ queryKey: ['calendar-users'] }); void client.invalidateQueries({ queryKey: ['visits'] }); } }, [client, focused, foreground]);
  useEffect(() => { if (users.isSuccess && calendarUser && calendarUser !== user?.id && !users.data.some((item) => item.user_id === calendarUser)) setCalendarUser(user?.id ?? ''); }, [calendarUser, user?.id, users.data, users.isSuccess]);
  const selectedVisits = useMemo(() => (visits.data ?? []).filter((visit) => visit.starts_at.slice(0, 10) === selected && (!search.trim() || `${visit.client_name ?? ''} ${visit.staff_name ?? ''} ${visit.services.join(' ')}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU')))), [visits.data, selected, search]);
  const counts = useMemo(() => { const result: Record<string, number> = {}; (visits.data ?? []).forEach((visit) => { const key = visit.starts_at.slice(0, 10); result[key] = (result[key] ?? 0) + 1; }); return result; }, [visits.data]);
  const datesWithMedia = useMemo(() => new Set((visits.data ?? []).filter((visit) => visit.media_count > 0).map((visit) => visit.starts_at.slice(0, 10))), [visits.data]);
  const cells = useMemo(() => {
    const prefix = (start.getDay() + 6) % 7;
    return [...Array(prefix).fill(null), ...Array(end.getDate()).fill(null).map((_, index) => new Date(cursor.getFullYear(), cursor.getMonth(), index + 1))];
  }, [cursor.getFullYear(), cursor.getMonth()]);
  function changeMonth(delta: number) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
    setCursor(next); setSelected(isoDate(next));
  }
  async function sync() {
    try { setSyncing(true); const result = await syncVisits(isoDate(start), isoDate(end)); await client.invalidateQueries({ queryKey: ['visits'] }); Alert.alert('Синхронизация завершена', `Обработано: ${result.processed}\nСвязано: ${result.linked}\nБез связи: ${result.unlinked}`); }
    catch (error) { Alert.alert('Ошибка синхронизации', error instanceof Error ? error.message : 'Не удалось обновить визиты'); }
    finally { setSyncing(false); }
  }
  return <Screen>
    <PageHeader kicker="Календарь" title="Визиты" subtitle="Расписание и привязанные материалы с сервера" action={user?.role === 'owner' ? 'sync-outline' : undefined} onAction={() => void sync()} />
    {(users.data?.length ?? 0) > 1 ? <View style={styles.users}>
      <Pressable onPress={() => setCalendarUser('')} style={[styles.userPill, !calendarUser && styles.activePill]}><Text style={[styles.userText, !calendarUser && styles.activeText]}>Все</Text></Pressable>
      {users.data?.map((item) => <Pressable key={item.user_id} onPress={() => setCalendarUser(item.user_id)} style={[styles.userPill, calendarUser === item.user_id && styles.activePill]}><Text style={[styles.userText, calendarUser === item.user_id && styles.activeText]}>{item.display_name}</Text></Pressable>)}
    </View> : null}
    <View style={styles.monthRow}><Pressable accessibilityLabel="Предыдущий месяц" onPress={() => changeMonth(-1)} style={styles.circle}><Ionicons name="chevron-back" size={19} color={colors.ink} /></Pressable><Text style={styles.month}>{monthNames[cursor.getMonth()]} {cursor.getFullYear()}</Text><Pressable accessibilityLabel="Следующий месяц" onPress={() => changeMonth(1)} style={styles.circle}><Ionicons name="chevron-forward" size={19} color={colors.ink} /></Pressable></View>
    <View style={styles.calendar}>
      {weekdays.map((day) => <Text key={day} style={styles.weekday}>{day}</Text>)}
      {cells.map((date, index) => date ? <Pressable key={isoDate(date)} onPress={() => setSelected(isoDate(date))} style={[styles.day, selected === isoDate(date) && styles.dayActive]}><Text style={[styles.dayText, selected === isoDate(date) && styles.activeText]}>{date.getDate()}</Text>{counts[isoDate(date)] ? <View style={[styles.count, selected === isoDate(date) && styles.countActive, datesWithMedia.has(isoDate(date)) && { backgroundColor: colors.green }]}><Text style={styles.countText}>{counts[isoDate(date)]}</Text></View> : null}</Pressable> : <View key={`empty-${index}`} style={styles.day} />)}
    </View>
    <View style={styles.search}><Ionicons name="search" size={18} color={colors.muted} /><TextInput value={search} onChangeText={setSearch} placeholder="Клиент, мастер или услуга" placeholderTextColor={colors.muted} style={styles.searchInput} /></View>
    <Text style={styles.dateTitle}>{new Date(`${selected}T12:00:00`).getDate()} {months[new Date(`${selected}T12:00:00`).getMonth()]} · {selectedVisits.length} визитов</Text>
    {visits.isLoading || syncing ? <Busy label={syncing ? 'Синхронизирую с YCLIENTS…' : 'Загружаю визиты…'} /> : visits.error ? <ErrorState message={(visits.error as Error).message} onRetry={() => void visits.refetch()} /> : selectedVisits.length === 0 ? <Empty icon="calendar-outline" title="На этот день визитов нет" text="Выберите другую дату или календарь сотрудника." /> : selectedVisits.map((visit) => {
      const time = new Date(visit.starts_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return <View key={visit.record_id} style={styles.visit}>
        <View style={styles.visitTop}><View style={styles.time}><Text style={styles.timeText}>{time}</Text></View><View style={styles.visitCopy}><Text style={styles.client}>{visit.client_name || 'Клиент не указан'}</Text><Text style={styles.service}>{visit.services.join(' · ') || 'Услуга не указана'}</Text>{visit.staff_name ? <Text style={styles.staff}>{visit.staff_name}</Text> : null}</View></View>
        {visit.comment ? <Text style={styles.comment}>{visit.comment}</Text> : null}
        <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityState={{ expanded: expandedVisits.has(visit.record_id) }} onPress={() => setExpandedVisits((current) => { const next = new Set(current); if (next.has(visit.record_id)) next.delete(visit.record_id); else next.add(visit.record_id); return next; })} style={styles.action}><Ionicons name="images-outline" size={17} color={colors.gold} /><Text style={styles.actionText}>{expandedVisits.has(visit.record_id) ? 'Скрыть файлы' : visit.media_count ? `Показать файлы (${visit.media_count})` : 'Материалов нет'}</Text><Ionicons name={expandedVisits.has(visit.record_id) ? 'chevron-up' : 'chevron-down'} size={15} color={colors.gold} /></Pressable><Pressable onPress={() => navigation.navigate('Add', { visitId: visit.record_id, visitName: visit.client_name ?? undefined })} style={[styles.action, styles.add]}><Ionicons name="camera-outline" size={17} color={colors.ink} /><Text style={styles.addText}>Добавить</Text></Pressable></View>
        {expandedVisits.has(visit.record_id) ? <VisitMedia visitId={visit.record_id} /> : null}
      </View>;
    })}
  </Screen>;
}

const styles = StyleSheet.create({
  users: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 }, userPill: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, activePill: { backgroundColor: colors.ink, borderColor: colors.ink }, userText: { color: colors.muted, fontSize: 11, fontWeight: '800' }, activeText: { color: colors.white },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }, circle: { width: 39, height: 39, borderRadius: 20, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }, month: { color: colors.ink, fontFamily: typography.serif, fontSize: 21 },
  calendar: { flexDirection: 'row', flexWrap: 'wrap', padding: 8, borderRadius: 20, backgroundColor: colors.white, marginBottom: 12 }, weekday: { width: '14.285%', textAlign: 'center', color: colors.muted, fontSize: 9, fontWeight: '900', paddingVertical: 7 }, day: { width: '14.285%', aspectRatio: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, dayActive: { backgroundColor: colors.ink }, dayText: { color: colors.ink, fontSize: 13, fontWeight: '800' }, count: { position: 'absolute', right: 2, top: 2, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, countActive: { backgroundColor: colors.coral }, countText: { color: colors.ink, fontSize: 8, fontWeight: '900' },
  search: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 15, paddingHorizontal: 13 }, searchInput: { flex: 1, color: colors.ink, fontSize: 13 }, dateTitle: { color: colors.ink, fontFamily: typography.serif, fontSize: 22, marginVertical: 15 },
  visit: { padding: 15, borderRadius: 20, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, marginBottom: 11 }, visitTop: { flexDirection: 'row', gap: 12 }, time: { width: 57, height: 57, borderRadius: 17, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, timeText: { color: colors.ink, fontSize: 13, fontWeight: '900' }, visitCopy: { flex: 1 }, client: { color: colors.ink, fontSize: 15, fontWeight: '900' }, service: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 }, staff: { color: colors.gold, fontSize: 10, fontWeight: '800', marginTop: 5 }, comment: { color: colors.muted, fontSize: 11, lineHeight: 16, backgroundColor: colors.creamStrong, borderRadius: 12, padding: 10, marginTop: 11 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 11, marginTop: 12 }, action: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 }, actionText: { color: colors.gold, fontSize: 11, fontWeight: '800' }, add: { backgroundColor: colors.creamStrong, borderRadius: 13, paddingHorizontal: 12 }, addText: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  visitMedia: { marginTop: 12 }, mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, mediaTile: { width: '31.5%', aspectRatio: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.creamStrong }, mediaThumb: { width: '100%', height: '100%' }, videoBadge: { position: 'absolute', top: 7, right: 7, width: 27, height: 27, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.65)' }, mediaMessage: { color: colors.muted, fontSize: 11, lineHeight: 16, paddingVertical: 8 }, preview: { width: '100%', aspectRatio: 1, borderRadius: 18, backgroundColor: colors.ink },
});
