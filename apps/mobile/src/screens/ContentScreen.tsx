import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { ApiError, confirmContentNotPublished, createContent, createContentBulk, deleteContent, getContentLibrary, listAvailabilityStaff, listContent, listContentArchive, prepareContent, publishSelectedContent, publishTelegram, removeContentPlatform, reuseContentArchive, scheduleContent, startContentPlan, updateContent, updatePublicationCaption, updatePublicationMedia, uploadMedia, type ContentArchiveEntry, type ContentItem, type ContentPublication } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { fitDailySlot } from '../content/dayPlan';
import { AnalyticsPanel } from '../content/AnalyticsPanel';
import { Busy, Empty, ErrorState, Field, PrimaryButton, Sheet } from '../components/Common';
import { PageHeader } from '../components/PageHeader';
import { ProtectedImage } from '../components/ProtectedImage';
import { FullPhotoViewer } from '../components/FullPhotoViewer';
import { AvailabilityScheduleSheet } from '../components/AvailabilityScheduleSheet';
import { Screen } from '../components/Screen';
import { colors, typography } from '../theme';
import type { RootTabs } from '../navigation/types';

const ARCHIVE_CHANNELS = ['telegram', 'telegram_studio', 'whatsapp_studio', 'max', 'instagram', 'threads'] as const;
type ArchiveFormat = 'post' | 'story' | 'reel';
function archiveFormats(platform: string): ArchiveFormat[] {
  if (platform === 'telegram_studio' || platform === 'whatsapp_studio') return ['story'];
  if (platform === 'instagram') return ['post', 'story', 'reel'];
  if (platform === 'telegram' || platform === 'max') return ['post', 'story'];
  return ['post'];
}
function archiveDefaultFormat(platform: string, original: string): ArchiveFormat {
  const available = archiveFormats(platform);
  return available.includes(original as ArchiveFormat) ? original as ArchiveFormat : (available[0] ?? 'post');
}
const archiveFormatLabel: Record<ArchiveFormat, string> = {post: 'Пост', story: 'История', reel: 'Reels'};
const archiveChannelLabel: Record<string, string> = {telegram:'Telegram · канал', telegram_studio:'Telegram · аккаунт студии', whatsapp_studio:'WhatsApp · статус студии', max:'MAX', instagram:'Instagram', vk:'ВКонтакте · стена', threads:'Threads'};
const statusLabels: Record<string, string> = { draft: 'Черновик', review: 'Ожидает утверждения', approved: 'Утверждено', generating: 'Генерация', ready: 'Готово', scheduled: 'Запланировано', published: 'Опубликовано', failed: 'Ошибка', pending: 'Не отправлено', publishing: 'Отправляется' };
const publicationStatusLabels: Record<string, string> = { pending: 'Не отправлено', scheduled: 'Запланировано', publishing: 'Отправляется', cancelled: 'Снято с публикации', published: 'Опубликовано', failed: 'Не опубликовано / проверить' };
const formatLabels: Record<string, string> = { post: 'Пост', story: 'История', availability: 'Окошки' };
const monday = (date: Date) => { const copy = new Date(date); const day = (copy.getDay() + 6) % 7; copy.setDate(copy.getDate() - day); copy.setHours(0, 0, 0, 0); return copy; };
const isoDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const isoTime = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
function scheduledDate(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const result = new Date(`${date}T${time}:00`);
  return !Number.isNaN(result.getTime()) && isoDate(result) === date && isoTime(result) === time ? result : null;
}
type VoiceTarget = 'title' | 'instruction';

function appendDictatedText(current: string, spoken: string) {
  const prefix = current.trim();
  const addition = spoken.replace(/\s+/g, ' ').trim();
  if (!addition) return current;
  return `${prefix}${prefix ? ' ' : ''}${addition}`;
}

function voiceErrorMessage(code: string) {
  if (code === 'not-allowed') return 'Разрешите приложению доступ к микрофону.';
  if (code === 'no-speech' || code === 'nomatch') return 'Речь не распознана. Нажмите микрофон и повторите.';
  if (code === 'network') return 'Для распознавания речи сейчас требуется интернет.';
  if (code === 'language-not-supported') return 'Русский язык не поддерживается выбранной службой распознавания.';
  if (code === 'service-not-allowed') return 'На устройстве недоступна служба распознавания речи.';
  return 'Не удалось распознать речь. Попробуйте ещё раз.';
}

function VoiceField({ target, label, value, onChangeText, placeholder, multiline = false, activeTarget, disabled, onToggle }: { target: VoiceTarget; label: string; value: string; onChangeText: (value: string) => void; placeholder?: string; multiline?: boolean; activeTarget: VoiceTarget | null; disabled: boolean; onToggle: (target: VoiceTarget) => void }) {
  const listening = activeTarget === target;
  const anotherFieldIsListening = activeTarget !== null && !listening;
  return <View style={styles.voiceField}>
    <Field label={label} value={value} onChangeText={onChangeText} placeholder={placeholder} multiline={multiline} />
    <View style={styles.voiceActions}>
    <Pressable accessibilityRole="button" accessibilityLabel={listening ? `Остановить голосовой ввод: ${label}` : `Надиктовать: ${label}`} disabled={disabled || anotherFieldIsListening} onPress={() => onToggle(target)} style={({ pressed }) => [styles.voiceButton, listening && styles.voiceButtonActive, (pressed || disabled || anotherFieldIsListening) && styles.voiceButtonDisabled]}>
      <Ionicons name={listening ? 'stop' : 'mic-outline'} size={17} color={listening ? colors.white : colors.ink} />
      <Text style={[styles.voiceButtonText, listening && styles.voiceButtonTextActive]}>{listening ? 'Стоп · слушаю' : 'Надиктовать'}</Text>
    </Pressable>
    {target === 'instruction' && <Pressable accessibilityRole="button" accessibilityLabel="Правила генерации" style={styles.generationHelpButton} onPress={() => Alert.alert('Правила генерации', "КАК ОПИСАТЬ ЗАДАЧУ\nУкажите процедуру, стиль, нужные детали и выберите фото. Например: «Создай светлый баннер о перманенте губ. Надпись: Запись открыта».\n\nКОМАНДЫ ДЛЯ КАРТИНКИ\nСлова «создай», «сгенерируй», «картинка», «изображение», «макет», «баннер», «ретушь», «надпись», «фон», «логотип», «добавь», «убери» и «замени» помогают распознать запрос на изображение.\n\nКОЛЛАЖ И ДО/ПОСЛЕ\nНапишите «коллаж», «несколько фото вместе» или «фото вместе» и выберите снимки. Для сравнения напишите «до и после», выберите сначала фото до, затем после. Без запроса на коллаж несколько выбранных файлов для сторис могут стать отдельными историями.\n\nСТИЛЬ\nВ режиме «Авто» слова «светлый», «белый», «бежевый», «нюд» подсказывают светлое оформление; «тёмный», «чёрный», «графит» — тёмное. Явный выбор стиля имеет преимущество.\n\nНАДПИСИ\nНапишите точный текст после «Надпись:» или «Текст на фото:», например «Надпись: Запись открыта». Проверьте орфографию и результат перед публикацией: ИИ может ошибаться. Сокращение ПМ сохраняется заглавными буквами.\n\nОБРАБОТКА ФОТО\nВыберите фото и включите «Обработать выбранное фото с ИИ», затем опишите изменения: «Убери маску, сделай мягкую ретушь». Оригинал сохранится.\n\nДВЕ ГАЛОЧКИ\n«Не включать название в изображение» исключает название карточки, но оставляет надписи из пожеланий; для новой картинки укажите пожелания. «Без подписи под публикацией» отключает текст под постом, а не надписи на изображении. Настройки изображения действуют при следующей генерации. Reels требует готовое видео; генерация видео не поддерживается.")}><Text style={styles.voiceButtonText}>? Правила генерации</Text></Pressable>}
    </View>
  </View>;
}

function PhotoEditOption({ enabled, disabled, onChange }: { enabled: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <View style={styles.editOption}>
    <View style={styles.editCopy}><Text style={styles.editTitle}>Обработать выбранное фото с ИИ</Text><Text style={styles.editDescription}>Ретушь, добавление или удаление деталей, надпись и логотип. Результат сохранится отдельно, оригиналы не изменятся.</Text></View>
    <Switch accessibilityLabel="Обработать выбранное фото с ИИ" value={enabled} disabled={disabled} onValueChange={onChange} />
  </View>;
}

function MediaLimitPicker({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <View><Text style={styles.label}>Количество фотографий для подбора</Text><View style={styles.options}>{Array.from({ length: 10 }, (_, index) => index + 1).map((number) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: value === number }} key={number} onPress={() => onChange(number)} style={[styles.option, value === number && styles.optionActive]}><Text style={styles.optionText}>{number}</Text></Pressable>)}</View></View>;
}

export function ContentScreen({ navigation, route }: BottomTabScreenProps<RootTabs, 'Content'>) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [week, setWeek] = useState(() => monday(new Date()));
  const [createOpen, setCreateOpen] = useState(false);
  const [windowsOpen, setWindowsOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [archiveSelected, setArchiveSelected] = useState<ContentArchiveEntry | null>(null);
  const [archivePhotoPath, setArchivePhotoPath] = useState<string | null>(null);
  const [archiveTargets, setArchiveTargets] = useState<string[]>([]);
  const [archiveFormatsSelected, setArchiveFormatsSelected] = useState<Record<string, ArchiveFormat>>({});
  const [dayPlan, setDayPlan] = useState(false);
  const [weekEntries, setWeekEntries] = useState<Array<{ day: number; title: string; format: 'post' | 'story'; mediaLimit: number }>>([{ day: 0, title: '', format: 'post', mediaLimit: 1 }]);
  const [platformFormats, setPlatformFormats] = useState<Record<string, 'post' | 'story' | 'reel'>>({ telegram: 'post', instagram: 'post', max: 'post', vk: 'post', threads: 'post' });
  const [weekPlatformFormats, setWeekPlatformFormats] = useState<Record<string, ('post' | 'story' | 'reel')[]>>({ telegram: ['post'], instagram: ['post'], max: ['post'], vk: ['post'], threads: ['post'] });
  const [active, setActive] = useState<ContentItem | null>(null);
  const [uncertainItemId, setUncertainItemId] = useState<string | null>(null);
  const generationUncertain = !!active && uncertainItemId === active.id;
  const [mediaOpen, setMediaOpen] = useState(false);
  const [phoneVideoUploading, setPhoneVideoUploading] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [mediaFolder, setMediaFolder] = useState<string | null>(null);
  const [cardPhotoId, setCardPhotoId] = useState<string | null>(null);
  const [sheetPhotoId, setSheetPhotoId] = useState<string | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [dateCursor, setDateCursor] = useState(() => new Date());
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [noCaption, setNoCaption] = useState(false);
  const [noTitleOnImage, setNoTitleOnImage] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [date, setDate] = useState(() => isoDate(new Date()));
  const [time, setTime] = useState('12:00');
  const [dateAssigned, setDateAssigned] = useState(false);
  const [format, setFormat] = useState<'post' | 'story' | 'availability'>('post');
  const [availabilityStaff, setAvailabilityStaff] = useState<number | null>(null);
  const [platforms, setPlatforms] = useState<string[]>((Platform.OS === 'android' || Platform.OS === 'ios') ? [] : ['telegram']);
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [formatTarget, setFormatTarget] = useState<ContentPublication | null>(null);
  const [savedSourceIds, setSavedSourceIds] = useState<string[]>([]);
  const [mediaLimit, setMediaLimit] = useState(1);
  const [mediaTypes, setMediaTypes] = useState<Record<string, 'image' | 'video'>>({});
  const [editPhoto, setEditPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<VoiceTarget | null>(null);
  const [voiceError, setVoiceError] = useState('');
  const voiceTargetRef = useRef<VoiceTarget | null>(null);

  useSpeechRecognitionEvent('start', () => setVoiceError(''));
  useSpeechRecognitionEvent('end', () => {
    voiceTargetRef.current = null;
    setVoiceTarget(null);
  });
  useSpeechRecognitionEvent('result', (event) => {
    if (!event.isFinal) return;
    const spoken = event.results[0]?.transcript?.trim();
    const target = voiceTargetRef.current;
    if (!spoken || !target) return;
    if (target === 'title') setTitle((current) => appendDictatedText(current, spoken));
    if (target === 'instruction') setInstruction((current) => appendDictatedText(current, spoken));
    setVoiceError('');
  });
  useSpeechRecognitionEvent('nomatch', () => setVoiceError(voiceErrorMessage('nomatch')));
  useSpeechRecognitionEvent('error', (event) => {
    voiceTargetRef.current = null;
    setVoiceTarget(null);
    if (event.error !== 'aborted') setVoiceError(voiceErrorMessage(event.error));
  });

  useEffect(() => () => ExpoSpeechRecognitionModule.abort(), []);

  const availabilityOptions = useQuery({ queryKey: ['availability-staff'], queryFn: listAvailabilityStaff, enabled: (Platform.OS === 'android' || Platform.OS === 'ios') && ((createOpen && format === 'availability') || active?.content_format === 'availability'), staleTime: 0, refetchInterval: foreground ? 30_000 : false });
  useEffect(() => { if (createOpen && format === 'availability' && availabilityStaff !== null && availabilityOptions.isSuccess && !availabilityOptions.data.some((entry) => entry.staff_id === availabilityStaff)) setAvailabilityStaff(null); }, [availabilityOptions.data, availabilityOptions.isSuccess, availabilityStaff, createOpen, format]);
  const items = useQuery({ queryKey: ['content', isoDate(week)], queryFn: () => listContent(isoDate(week)), enabled: !!user?.can_access_content });
  const archive = useInfiniteQuery({ queryKey: ['content-archive'], initialPageParam: 0, queryFn: ({ pageParam }) => listContentArchive(pageParam), getNextPageParam: (page) => page.next_offset ?? undefined, enabled: (Platform.OS === 'android' || Platform.OS === 'ios') && archiveOpen && !!user?.can_access_content });
  const libraryFolders = useQuery({ queryKey: ['content-library-folders'], queryFn: () => getContentLibrary(undefined, undefined, 0), enabled: mediaOpen, staleTime: 0, refetchOnMount: 'always', refetchInterval: mediaOpen && foreground ? 30_000 : false });
  const library = useInfiniteQuery({ queryKey: ['content-library', mediaFolder], initialPageParam: 0, queryFn: ({ pageParam }) => getContentLibrary(mediaFolder ?? undefined, undefined, pageParam), getNextPageParam: (lastPage) => lastPage.next_offset ?? undefined, enabled: mediaOpen && !!mediaFolder, staleTime: 0, refetchOnMount: 'always', refetchInterval: mediaOpen && !!mediaFolder && foreground ? 30_000 : false });
  const libraryItems = useMemo(() => { const seen = new Set<string>(); return (library.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; }); }, [library.data]);
  useEffect(() => { const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active')); return () => subscription.remove(); }, []);
  useEffect(() => { if (mediaOpen && foreground) { void client.invalidateQueries({ queryKey: ['content-library-folders'] }); if (mediaFolder) void client.invalidateQueries({ queryKey: ['content-library', mediaFolder], exact: true }); } }, [client, foreground, mediaFolder, mediaOpen]);
  const weekEnd = useMemo(() => { const value = new Date(week); value.setDate(value.getDate() + 6); return value; }, [week]);
  function moveWeek(delta: number) { const value = new Date(week); value.setDate(value.getDate() + delta * 7); setWeek(value); }
  function cancelVoiceInput() {
    if (voiceTargetRef.current) ExpoSpeechRecognitionModule.abort();
    voiceTargetRef.current = null;
    setVoiceTarget(null);
    setVoiceError('');
  }
  function closeMediaPicker() { setMediaOpen(false); if (formatTarget) { setMediaIds(savedSourceIds); setFormatTarget(null); } }
  async function finishMediaPicker() {
    if (!formatTarget || !active) { setMediaOpen(false); return; }
    if (!mediaIds.length) { Alert.alert('Выберите файл', 'Для этого формата нужен хотя бы один материал.'); return; }
    try { setBusy(true); const result = await updatePublicationMedia(active.id, formatTarget.platform, formatTarget.id, mediaIds); setActive(result); setMediaIds(savedSourceIds); setFormatTarget(null); setMediaOpen(false); await client.invalidateQueries({ queryKey: ['content'] }); }
    catch (error) { Alert.alert('Не удалось сохранить материалы', error instanceof Error ? error.message : 'Повторите попытку.'); }
    finally { setBusy(false); }
  }
  async function uploadPhoneVideo() {
    if (!mediaFolder || !user?.can_upload_media || phoneVideoUploading) return;
    const reel = createOpen ? platforms.includes('instagram') && platformFormats.instagram === 'reel' : active?.publications.some((item) => item.platform === 'instagram' && item.publication_format === 'reel');
    if (!reel && mediaIds.length >= 10) { Alert.alert('Достигнут лимит', 'Можно выбрать не более 10 файлов.'); return; }
    const instagramSelected = createOpen ? platforms.includes('instagram') : active?.publications.some((item) => item.platform === 'instagram');
    try {
      const selection = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsMultipleSelection: false, quality: 1, exif: false });
      if (selection.canceled || !selection.assets[0]) return;
      const asset = selection.assets[0];
      setPhoneVideoUploading(true);
      const uploaded = await uploadMedia({ uri: asset.uri, filename: asset.fileName || `video-${Date.now()}.mp4`, mediaType: 'video', mimeType: asset.mimeType, workspaceId: mediaFolder, publicationAllowed: true });
      setMediaTypes((current) => ({ ...current, [uploaded.id]: 'video' }));
      setMediaIds((current) => reel ? [uploaded.id] : [...current, uploaded.id].slice(0, 10));
      await client.invalidateQueries({ queryKey: ['content-library', mediaFolder] });
      await client.invalidateQueries({ queryKey: ['workspaces'] });
    } catch (error) {
      Alert.alert('Не удалось загрузить видео', error instanceof Error ? error.message : 'Повторите попытку.');
    } finally { setPhoneVideoUploading(false); }
  }
  async function toggleVoiceInput(target: VoiceTarget) {
    if (voiceTargetRef.current === target) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    if (voiceTargetRef.current) return;
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setVoiceError('На устройстве не найдена служба распознавания речи. Можно использовать микрофон клавиатуры.');
      return;
    }
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setVoiceError('Доступ к микрофону не разрешён. Включите его в настройках Android.');
        return;
      }
      setVoiceError('');
      voiceTargetRef.current = target;
      setVoiceTarget(target);
      ExpoSpeechRecognitionModule.start({ lang: 'ru-RU', interimResults: false, continuous: false, addsPunctuation: true, maxAlternatives: 1 });
    } catch {
      voiceTargetRef.current = null;
      setVoiceTarget(null);
      setVoiceError('Микрофон уже занят или распознавание временно недоступно.');
    }
  }
  function resetForm() { cancelVoiceInput(); setTitle(''); setCaption(''); setNoCaption(false); setNoTitleOnImage(false); setInstruction(''); setDate(isoDate(new Date())); setTime('12:00'); setDateAssigned(false); setDateOpen(false); setMediaFolder(null); setFormat('post'); setAvailabilityStaff(null); setPlatforms((Platform.OS === 'android' || Platform.OS === 'ios') ? [] : ['telegram']); setPlatformFormats({ telegram: 'post', instagram: 'post', max: 'post', vk: 'post' }); setMediaIds([]); setMediaLimit(1); setMediaTypes({}); setEditPhoto(false); }
  useEffect(() => {
    const source = route.params?.sourceMedia;
    if (!source || !user?.can_access_content) return;
    resetForm();
    setMediaIds([source.id]);
    setMediaTypes({ [source.id]: source.mediaType });
    setEditPhoto(source.mediaType === 'image');
    setCreateOpen(true);
    navigation.setParams({ sourceMedia: undefined });
  }, [route.params?.sourceMedia, user?.can_access_content]);
  function validatePhotoSelection() {
    if (!editPhoto) return true;
    if (!mediaIds.length || mediaIds.every((id) => mediaTypes[id] === 'video')) {
      Alert.alert('Выберите фото', 'Для обработки ИИ нужно выбрать хотя бы одно фото. Видео можно добавить отдельно.');
      return false;
    }
    return true;
  }
  async function mutate(action: () => Promise<unknown>, success?: string, generation = false) {
    try { setBusy(true); const result = await action(); await client.invalidateQueries({ queryKey: ['content'] }); if (result && typeof result === 'object' && 'id' in result && active) setActive(result as ContentItem); if (success) Alert.alert('Готово', success); }
    catch (error) { await client.invalidateQueries({ queryKey: ['content'] }); if (generation && error instanceof ApiError && error.status === 0) { setUncertainItemId(active?.id ?? null); Alert.alert('Связь прервалась', 'Генерация могла продолжиться на сервере. Восстановите интернет и нажмите «Обновить результат». Не запускайте генерацию повторно, пока не проверите результат.'); } else Alert.alert('Ошибка', error instanceof Error ? error.message : 'Операция не выполнена'); }
    finally { setBusy(false); }
  }
  async function create() {
    const scheduled = dateAssigned ? scheduledDate(date, time) : new Date(Date.now() + 60 * 60 * 1000);
    if (!scheduled) { Alert.alert('Проверьте дату и время', 'Введите время в формате ЧЧ:ММ и выберите дату в календаре.'); return; }
    if (format === 'availability') {
      const staff = availabilityOptions.data?.find((entry) => entry.staff_id === availabilityStaff);
      if (!staff || !platforms.length) return;
      let created: ContentItem | undefined;
      try {
        setBusy(true);
        created = await createContent({ title: `${staff.staff_name} — свободные окна`, no_caption: noCaption, scheduled_at: scheduled.toISOString(), publication_date_assigned: dateAssigned, platforms, platform_formats: Object.fromEntries(platforms.map((platform) => [platform, (platform === 'telegram_studio' || platform === 'whatsapp_studio') ? 'story' : platform === 'instagram' ? platformFormats.instagram : (Platform.OS === 'android' || Platform.OS === 'ios') && (platform === 'telegram' || platform === 'max') ? platformFormats[platform] : 'post'])), media_ids: [], content_format: 'availability', media_limit: 1, availability_staff_id: staff.staff_id });
        setCreateOpen(false); openItem(created); setWeek(monday(new Date(created.scheduled_at)));
        const prepared = await prepareContent(created.id);
        setActive(prepared); setCaption(prepared.publications.find((publication) => publication.caption)?.caption ?? prepared.caption ?? '');
        Alert.alert('Готово', 'Карточка свободных окон создана.');
      } catch (error) { Alert.alert('Не удалось создать карточку', `${created ? 'Запись сохранена в плане. ' : ''}${error instanceof Error ? error.message : 'Повторите попытку.'}`); }
      finally { await client.invalidateQueries({ queryKey: ['content'] }); setBusy(false); }
      return;
    }
    if (title.trim().length < 2 || !platforms.length || !validatePhotoSelection()) return;
    if (!editPhoto) {
      await mutate(async () => { const created = await createContent({ title: title.trim(), caption: caption.trim() || null, no_caption: noCaption, no_title_on_image: noTitleOnImage, editor_instruction: instruction.trim() || null, visual_edit_requested: false, scheduled_at: scheduled.toISOString(), publication_date_assigned: dateAssigned, platforms, platform_formats: Object.fromEntries(platforms.map((platform) => [platform, (platform === 'telegram_studio' || platform === 'whatsapp_studio') ? 'story' : platform === 'instagram' ? platformFormats.instagram : (Platform.OS === 'android' || Platform.OS === 'ios') && (platform === 'telegram' || platform === 'max') ? platformFormats[platform] : 'post'])), media_ids: mediaIds, content_format: format, media_limit: Math.max(mediaLimit, mediaIds.length) }); setWeek(monday(new Date(created.scheduled_at))); setCreateOpen(false); resetForm(); }, 'Элемент добавлен в контент-план');
      return;
    }
    let created: ContentItem | undefined;
    try {
      setBusy(true);
      created = await createContent({ title: title.trim(), caption: caption.trim() || null, no_caption: noCaption, no_title_on_image: noTitleOnImage, editor_instruction: instruction.trim() || null, visual_edit_requested: true, scheduled_at: scheduled.toISOString(), publication_date_assigned: dateAssigned, platforms, platform_formats: Object.fromEntries(platforms.map((platform) => [platform, (platform === 'telegram_studio' || platform === 'whatsapp_studio') ? 'story' : platform === 'instagram' ? platformFormats.instagram : (Platform.OS === 'android' || Platform.OS === 'ios') && (platform === 'telegram' || platform === 'max') ? platformFormats[platform] : 'post'])), media_ids: mediaIds, content_format: format, media_limit: Math.max(1, mediaIds.length) });
      setCreateOpen(false); cancelVoiceInput(); openItem(created); setWeek(monday(new Date(created.scheduled_at)));
      const prepared = await prepareContent(created.id);
      setActive(prepared);
      setCaption(prepared.publications.find((publication) => publication.caption)?.caption ?? prepared.caption ?? '');
      Alert.alert('Готово', 'Обработанная версия создана. Оригинал не изменён.');
    } catch (error) {
      Alert.alert(created ? 'Не удалось обработать фото' : 'Не удалось создать запись', `${created ? 'Запись сохранена в контент-плане. ' : ''}${error instanceof Error ? error.message : 'Повторите попытку.'}`);
    } finally { await client.invalidateQueries({ queryKey: ['content'] }); setBusy(false); }
  }
  async function createWeek(start = false) {
    const entries = weekEntries.filter((entry) => entry.title.trim());
    if (!entries.length || !platforms.length) return;
    await mutate(async () => {
      let next = new Date(Date.now() + 30 * 60 * 1000);
      const items = entries.map((entry, index) => {
        let scheduled = dayPlan ? scheduledDate(date, `${String(10 + index % 3).padStart(2, '0')}:00`) : new Date(week);
        if (!scheduled) throw new Error('Выберите дату плана в календаре.');
        if (!dayPlan) { scheduled.setDate(scheduled.getDate() + entry.day); scheduled.setHours(10 + index % 3, 0, 0, 0); }
        if (dayPlan) scheduled = fitDailySlot(scheduled, next, date);
        else if (scheduled < next) scheduled.setTime(next.getTime());
        next = new Date(scheduled.getTime() + 30 * 60 * 1000);
        return { title: entry.title.trim(), scheduled_at: scheduled.toISOString(), platforms, platform_formats: Object.fromEntries(platforms.map((platform) => [platform, (platform === 'telegram_studio' || platform === 'whatsapp_studio') ? ['story'] : (Platform.OS === 'android' || Platform.OS === 'ios') ? (weekPlatformFormats[platform]?.length ? weekPlatformFormats[platform] : ['post']) : platformFormats[platform] ?? 'post'])), media_ids: [], content_format: entry.format, media_limit: entry.mediaLimit };
      });
      const created = await createContentBulk(items); if (dayPlan) { const planned = scheduledDate(date, '12:00'); if (planned) setWeek(monday(planned)); } setWeekOpen(false); setWeekEntries([{ day: 0, title: '', format: 'post', mediaLimit: 1 }]);
      if (start) {
        Alert.alert('План создан', 'Готовим материалы и ставим их в расписание. Это может занять несколько минут.');
        const response = await startContentPlan(created.map((item) => item.id));
        const failed = response.results.filter((entry) => !entry.scheduled);
        if (failed.length) throw new Error(`План сохранён. Запланировано: ${response.results.length - failed.length} из ${response.results.length}. ${failed.map((entry) => `${created.find((item) => item.id === entry.id)?.title || 'Публикация'}: ${entry.error || 'не удалось запланировать'}`).join('\n')}`);
      }
    }, start ? 'Все материалы плана поставлены в расписание.' : dayPlan ? 'План на день создан' : 'Недельный план создан');
  }
  function openItem(item: ContentItem) { const scheduled = new Date(item.scheduled_at); setActive(item); setTitle(item.title); setNoCaption(!!item.no_caption); setNoTitleOnImage(!!item.no_title_on_image); setCaption(item.publications.find((publication) => publication.caption)?.caption ?? item.caption ?? ''); setInstruction(item.editor_instruction ?? ''); setDate(isoDate(scheduled)); setTime(isoTime(scheduled)); setDateAssigned(item.publication_date_assigned ?? true); setMediaIds(item.media_ids); setMediaLimit(item.media_limit); setMediaTypes({}); setEditPhoto(!!item.visual_edit_requested); }
  async function reuseArchived() {
    if (!archiveSelected || !archiveTargets.length) return;
    await mutate(async () => {
      const copy = await reuseContentArchive(archiveSelected.publication_id, archiveTargets, Object.fromEntries(archiveTargets.map(platform => [platform, archiveFormatsSelected[platform] ?? archiveDefaultFormat(platform, archiveSelected.publication_format)])));
      setArchiveOpen(false); setArchiveSelected(null); setWeek(monday(new Date(copy.scheduled_at))); openItem(copy);
    }, 'Создана новая карточка. Выберите дату или опубликуйте её сейчас.');
  }
  async function persistItem(item: ContentItem) {
    const scheduled = dateAssigned ? scheduledDate(date, time) : null;
    if (dateAssigned && !scheduled) throw new Error('Проверьте дату и время: введите время в формате ЧЧ:ММ.');
    const original = new Date(item.scheduled_at);
    const scheduleChanged = dateAssigned && (date !== isoDate(original) || time !== isoTime(original) || item.publication_date_assigned === false);
    let result = await updateContent(item.id, { title: title.trim(), caption: caption.trim() || null, no_caption: noCaption, no_title_on_image: noTitleOnImage, editor_instruction: instruction.trim() || null, visual_edit_requested: editPhoto, publication_date_assigned: dateAssigned, ...(scheduleChanged && scheduled ? { scheduled_at: scheduled.toISOString() } : {}), media_ids: mediaIds, media_limit: Math.max(mediaLimit, mediaIds.length, 1) });
    const previousCaption = item.publications.find((publication) => publication.caption)?.caption ?? item.caption ?? '';
    if (!noCaption && previousCaption !== caption.trim()) {
      for (const publication of result.publications) {
        if (publication.status !== 'published' && (publication.caption ?? '') !== caption.trim()) result = await updatePublicationCaption(item.id, publication.platform, caption.trim() || null, publication.id);
      }
    }
    setWeek(monday(new Date(result.scheduled_at)));
    setDate(isoDate(new Date(result.scheduled_at)));
    setTime(isoTime(new Date(result.scheduled_at)));
    return result;
  }
  async function saveItem() { if (!active || !validatePhotoSelection()) return; await mutate(() => persistItem(active), 'Публикация сохранена в контент-плане'); }
  async function approveItem() {
    if (!active || !validatePhotoSelection()) return;
    if (!dateAssigned) { Alert.alert('Выберите дату и время', 'Для автоматической публикации укажите будущее время.'); return; }
    await mutate(async () => { await persistItem(active); return scheduleContent(active.id); }, 'Утверждено: публикация будет отправлена в указанное время');
  }
  async function publishNow() {
    if (!active || dateAssigned || !validatePhotoSelection()) return;
    if (!noCaption && !caption.trim()) { Alert.alert('Добавьте текст', 'Сначала подготовьте подпись к публикации.'); return; }
    try {
      setBusy(true);
      await persistItem(active);
      const response = await publishSelectedContent(active.id);
      setActive(response.item);
      const failures = response.results.filter((result) => !result.published);
      if (failures.length) Alert.alert('Проверьте результаты', failures.map((result) => `${result.platform.toUpperCase()}: ${result.error || 'не отправлено'}`).join('\n'));
      else Alert.alert('Опубликовано', 'Выбранные площадки подтвердили публикацию.');
    } catch (error) { Alert.alert('Не удалось завершить отправку', error instanceof Error ? error.message : 'Проверьте статус публикации.'); }
    finally { await client.invalidateQueries({ queryKey: ['content'] }); setBusy(false); }
  }
  async function publishTelegramIOS() { if (active && !dateAssigned) await mutate(async () => { await persistItem(active); return publishTelegram(active.id); }, 'Отправлено в Telegram'); }
  async function confirmNotPublished(publication: ContentPublication) {
    if (!active) return;
    await mutate(() => confirmContentNotPublished(active.id, publication.platform, publication.id), 'Статус восстановлен. Теперь можно отправить или запланировать публикацию.');
  }
  async function generate() {
    if (!active || !validatePhotoSelection()) return;
    await mutate(async () => {
      const visualRequest = 'Создать фирменное изображение для публикации.';
      const isReel = active.publications.some((publication) => publication.platform === 'instagram' && publication.publication_format === 'reel');
      const wantsCollage = /кол+аж|калаж|нескольк\p{L}*(?:\s+\S+){0,3}\s+(?:фото|снимк|кадр)/iu.test(`${title}\n${instruction}`);
      const isStorySeries = !wantsCollage && mediaIds.length > 1 && active.publications.some((publication) => (publication.platform === 'instagram' || ((Platform.OS === 'android' || Platform.OS === 'ios') && (publication.platform === 'telegram' || publication.platform === 'telegram_studio' || publication.platform === 'whatsapp_studio' || publication.platform === 'max'))) && publication.publication_format === 'story');
      const generationInstruction = noTitleOnImage || editPhoto || isReel || isStorySeries ? instruction.trim() : instruction.includes(visualRequest) ? instruction.trim() : [instruction.trim().slice(0, 1000 - visualRequest.length - 1), visualRequest].filter(Boolean).join('\n');
      const scheduled = dateAssigned ? scheduledDate(date, time) : null;
      if (dateAssigned && !scheduled) throw new Error('Проверьте дату и время: введите время в формате ЧЧ:ММ.');
      const original = new Date(active.scheduled_at);
      const scheduleChanged = dateAssigned && (date !== isoDate(original) || time !== isoTime(original) || active.publication_date_assigned === false);
      await updateContent(active.id, { title: title.trim(), caption: caption.trim() || null, no_caption: noCaption, no_title_on_image: noTitleOnImage, editor_instruction: generationInstruction || null, visual_edit_requested: editPhoto, publication_date_assigned: dateAssigned, ...(scheduleChanged && scheduled ? { scheduled_at: scheduled.toISOString() } : {}), media_ids: mediaIds, media_limit: Math.max(1, active.media_limit, mediaIds.length) });
      setInstruction(generationInstruction);
      const result = await prepareContent(active.id, true);
      setCaption(result.publications.find((publication) => publication.caption)?.caption ?? result.caption ?? '');
      setDate(isoDate(new Date(result.scheduled_at)));
      setTime(isoTime(new Date(result.scheduled_at)));
      return result;
    }, 'Материал подготовлен заново', true);
  }
  async function refreshGeneratedResult() {
    if (!active) return;
    try {
      setBusy(true);
      const rows = await listContent(isoDate(monday(new Date(active.scheduled_at))));
      const refreshed = rows.find((item) => item.id === active.id);
      if (!refreshed) { Alert.alert('Карточка не найдена', 'Обновите контент-план и откройте публикацию заново.'); return; }
      setActive(refreshed);
      setCaption(refreshed.publications.find((publication) => publication.caption)?.caption ?? refreshed.caption ?? '');
      await client.invalidateQueries({ queryKey: ['content'] });
      if (['ready', 'failed'].includes(refreshed.status)) { setUncertainItemId(null); Alert.alert('Результат обновлён', refreshed.status === 'ready' ? 'Проверьте изображение и подпись.' : 'Сервер сообщил об ошибке. Проверьте карточку перед повтором.'); }
      else Alert.alert('Результат пока не готов', 'Подождите и снова нажмите «Обновить результат».');
    } catch (error) { Alert.alert('Не удалось обновить', error instanceof Error ? error.message : 'Проверьте соединение с сервером.'); }
    finally { setBusy(false); }
  }
  const dateControls = (locked: boolean, compact = false) => <View>
    <View style={styles.scheduleToggle}><View style={styles.flex}><Text style={styles.label}>Назначить дату публикации</Text>{!compact ? <Text style={styles.voiceHint}>{locked ? 'Дата опубликованного материала недоступна для изменения.' : dateAssigned ? 'Для публикации сейчас сначала уберите дату.' : 'Без даты можно опубликовать сразу.'}</Text> : null}</View><Switch accessibilityLabel="Назначить дату публикации" value={dateAssigned} disabled={locked || busy} onValueChange={setDateAssigned} /></View>
    {dateAssigned ? <View style={styles.twoFields}><View style={styles.flex}><Text style={styles.label}>Дата публикации</Text><Pressable accessibilityRole="button" accessibilityLabel="Выбрать дату публикации" disabled={locked || busy} onPress={() => { setDateCursor(new Date(`${date}T12:00:00`)); setDateOpen(true); }} style={[styles.option, { minHeight: 50, justifyContent: 'center' }]}><Text style={styles.optionText}>{new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU')}  📅</Text></Pressable></View><View style={styles.timeField}>{locked ? <><Text style={styles.label}>Время</Text><Text style={styles.optionText}>{time}</Text></> : <Field label="Время" value={time} onChangeText={setTime} placeholder="ЧЧ:ММ" />}</View></View> : null}
  </View>;
  const datePicker = (visible: boolean) => <Sheet visible={visible} title="Выберите дату" onClose={() => setDateOpen(false)}>
    <View style={styles.weekRow}><Pressable accessibilityLabel="Предыдущий месяц" style={styles.circle} onPress={() => setDateCursor(new Date(dateCursor.getFullYear(), dateCursor.getMonth() - 1, 1))}><Ionicons name="chevron-back" size={20} color={colors.ink} /></Pressable><Text style={styles.weekTitle}>{dateCursor.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</Text><Pressable accessibilityLabel="Следующий месяц" style={styles.circle} onPress={() => setDateCursor(new Date(dateCursor.getFullYear(), dateCursor.getMonth() + 1, 1))}><Ionicons name="chevron-forward" size={20} color={colors.ink} /></Pressable></View>
    <View style={styles.dateGrid}>{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => <Text key={day} style={styles.dateCell}>{day}</Text>)}{Array.from({ length: (new Date(dateCursor.getFullYear(), dateCursor.getMonth(), 1).getDay() + 6) % 7 }, (_, i) => <View key={`empty-${i}`} style={styles.dateCell} />)}{Array.from({ length: new Date(dateCursor.getFullYear(), dateCursor.getMonth() + 1, 0).getDate() }, (_, i) => { const value = isoDate(new Date(dateCursor.getFullYear(), dateCursor.getMonth(), i + 1)); return <Pressable key={value} accessibilityRole="button" accessibilityLabel={`Дата ${value}`} style={[styles.dateCell, value === date && styles.optionActive]} onPress={() => { setDate(value); setDateOpen(false); }}><Text style={styles.optionText}>{i + 1}</Text></Pressable>; })}</View>
  </Sheet>;
  const mediaPicker = (visible: boolean) => <Sheet visible={visible} title={mediaFolder ? 'Выберите фото и видео' : 'Выберите папку'} onClose={closeMediaPicker}>
    <Text style={styles.voiceHint}>{Platform.OS === 'android' ? 'Можно выбрать до 10 материалов. Файлы с запретом видны; изменить разрешение можно в архиве.' : 'Можно выбрать до 10 материалов из одной или нескольких папок. Доступны материалы, разрешённые для публикации.'}</Text>
    {(Platform.OS === 'android' || Platform.OS === 'ios') && user?.can_upload_media ? <>{mediaFolder ? <PrimaryButton title={phoneVideoUploading ? 'Загружаю видео…' : 'Загрузить видео с телефона'} icon="cloud-upload-outline" disabled={phoneVideoUploading} onPress={() => void uploadPhoneVideo()} /> : <Text style={styles.voiceHint}>Чтобы загрузить видео с телефона, сначала откройте папку, куда его сохранить.</Text>}</> : null}
    <PrimaryButton title={(mediaFolder ? library.isRefetching : libraryFolders.isRefetching) ? 'Обновляю…' : 'Обновить список'} icon="refresh-outline" disabled={mediaFolder ? library.isFetching : libraryFolders.isFetching} onPress={() => { if (mediaFolder) void library.refetch(); else void libraryFolders.refetch(); }} />
    {(mediaFolder ? library.isRefetchError : libraryFolders.isRefetchError) ? <Text style={styles.voiceError}>Не удалось обновить список. Проверьте связь и попробуйте ещё раз.</Text> : null}
    {!mediaFolder ? libraryFolders.isLoading ? <Busy label="Загружаю папки…" /> : libraryFolders.isError && !libraryFolders.data ? <ErrorState message={(libraryFolders.error as Error).message} onRetry={() => void libraryFolders.refetch()} /> : libraryFolders.data?.workspaces.length ? <View style={styles.folderList}>{libraryFolders.data.workspaces.map((folder) => <Pressable accessibilityRole="button" accessibilityLabel={`Открыть папку ${folder.display_name}`} key={folder.id} style={styles.folderRow} onPress={() => setMediaFolder(folder.id)}><Ionicons name={folder.kind === 'private' ? 'lock-closed-outline' : 'folder-open-outline'} size={20} color={colors.gold} /><Text style={styles.folderName}>{folder.display_name}</Text><Ionicons name="chevron-forward" size={18} color={colors.muted} /></Pressable>)}</View> : <Text style={styles.voiceHint}>Доступных папок нет.</Text> : <>
      <Pressable accessibilityRole="button" accessibilityLabel="Назад к папкам" onPress={() => setMediaFolder(null)} style={styles.folderBack}><Ionicons name="chevron-back" size={18} color={colors.gold} /><Text style={styles.folderBackText}>{libraryFolders.data?.workspaces.find((folder) => folder.id === mediaFolder)?.display_name ?? 'Папки'}</Text></Pressable>
      {library.data?.pages[0] ? <Text style={styles.voiceHint}>{Platform.OS === 'android' ? 'Порядок как в архиве.' : 'Сначала недавно добавленные.'} Показано {libraryItems.length} из {library.data.pages[0].total} материалов.</Text> : null}
      {library.isLoading ? <Busy /> : library.isError && !libraryItems.length ? <ErrorState message={(library.error as Error).message} onRetry={() => void library.refetch()} /> : <><View style={styles.mediaGrid}>{libraryItems.map((item) => <Pressable accessibilityRole="checkbox" accessibilityLabel={`${item.media_type === 'image' ? 'Фото' : 'Видео'}: ${item.original_name}`} accessibilityState={{ checked: mediaIds.includes(item.id) }} key={item.id} onPress={() => { if (item.publication_allowed === false) { Alert.alert('Публикация запрещена', 'Этот файл виден в архиве, но его использование в контенте запрещено. Изменить разрешение можно в карточке файла в архиве.'); return; } setMediaTypes((current) => ({ ...current, [item.id]: item.media_type })); setMediaIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id].slice(0, 10)); }} style={[styles.mediaItem, mediaIds.includes(item.id) && styles.mediaSelected]}><ProtectedImage path={item.thumbnail_url} style={styles.mediaThumb} /><Text numberOfLines={1} style={styles.mediaName}>{item.media_type === 'video' ? 'Видео · ' : ''}{item.original_name}</Text>{item.publication_allowed === false ? <Text style={styles.voiceError}>Публикация запрещена</Text> : null}{mediaIds.includes(item.id) ? <View style={styles.check}><Text style={styles.checkText}>{mediaIds.indexOf(item.id) + 1}</Text></View> : null}</Pressable>)}</View>{!libraryItems.length ? <Text style={styles.voiceHint}>В этой папке нет материалов, разрешённых для публикации.</Text> : null}{library.hasNextPage ? <PrimaryButton title={library.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'} disabled={library.isFetchingNextPage} onPress={() => void library.fetchNextPage()} /> : null}{library.isFetchNextPageError ? <Text style={styles.voiceError}>Не удалось загрузить следующие материалы. Нажмите «Показать ещё».</Text> : null}</>}
    </>}
    <PrimaryButton title={`Готово (${mediaIds.length})`} disabled={busy} onPress={() => void finishMediaPicker()} />
  </Sheet>;
  if (!user?.can_access_content) return <Screen><PageHeader kicker="Публикации" title="Контент" subtitle="Контент-план студии" /><Empty icon="lock-closed-outline" title="Нет доступа к контенту" text="Администратор может включить это право для вашего аккаунта." /></Screen>;
  return <Screen>
    <PageHeader kicker="Публикации" title="Контент" subtitle="Реальный контент-план и публикации сервера" />
    <PrimaryButton title="Окошки" icon="calendar-outline" onPress={() => setWindowsOpen(true)} />
    <AvailabilityScheduleSheet visible={windowsOpen} onClose={() => setWindowsOpen(false)} onCreateOnce={() => { setWindowsOpen(false); resetForm(); setFormat('availability'); setTimeout(() => setCreateOpen(true), 300); }} />
    <PrimaryButton title="Создать публикацию" icon="add-circle-outline" onPress={() => { resetForm(); setCreateOpen(true); }} />
    {(Platform.OS === 'android' || Platform.OS === 'ios') ? <PrimaryButton title="Создать план на день" icon="calendar-outline" onPress={() => { setDayPlan(true); setDate(isoDate(new Date())); setPlatforms([]); setWeekOpen(true); }} /> : null}
    <PrimaryButton title="Создать план на неделю" icon="calendar-outline" onPress={() => { setDayPlan(false); setPlatforms((Platform.OS === 'android' || Platform.OS === 'ios') ? [] : ['telegram']); setWeekOpen(true); }} />
    {(Platform.OS === 'android' || Platform.OS === 'ios') && user.can_access_analytics ? <><PrimaryButton title="Аналитика" icon="stats-chart-outline" onPress={() => setAnalyticsOpen(true)} /><AnalyticsPanel visible={analyticsOpen} onClose={() => setAnalyticsOpen(false)} /></> : null}
    {(Platform.OS === 'android' || Platform.OS === 'ios') ? <PrimaryButton title="Архив публикаций" icon="archive-outline" tone="ink" onPress={() => { setArchiveSelected(null); setArchiveOpen(true); }} /> : null}
    <Sheet visible={(Platform.OS === 'android' || Platform.OS === 'ios') && archiveOpen} title="Архив публикаций" onClose={() => { setArchiveOpen(false); setArchiveSelected(null); setArchivePhotoPath(null); }}>
      <Text style={styles.voiceHint}>Здесь сохранены опубликованные материалы. Для повторного размещения создаётся новая карточка; прежняя публикация остаётся в архиве.</Text>
      {archive.isLoading ? <Busy label="Загружаю архив…" /> : archive.error ? <ErrorState message={(archive.error as Error).message} onRetry={() => void archive.refetch()} /> : !(archive.data?.pages.some((page) => page.items.length)) ? <Empty icon="archive-outline" title="Архив пока пуст" text="Здесь появятся опубликованные материалы." /> : archive.data.pages.flatMap((page) => page.items).map((entry) => <View key={entry.publication_id} style={styles.publication}>
        <View style={styles.options}>{(['telegram', 'instagram', 'max', 'vk', 'threads'] as const).map(platform => <View key={platform} style={[styles.option, (entry.platforms ?? [entry.platform]).includes(platform) && styles.optionActive]}><Text style={styles.optionText}>{(entry.platforms ?? [entry.platform]).includes(platform) ? '● ' : '○ '}{platform === 'vk' ? 'ВКонтакте' : platform === 'instagram' ? 'Instagram' : platform === 'telegram' ? 'Telegram' : platform === 'threads' ? 'Threads' : 'MAX'}</Text></View>)}</View>
        {entry.publication_statuses?.map((p, index) => <Text key={index} style={[styles.itemCaption, p.status === 'failed' && styles.error, p.status === 'published' && styles.publishedStatus]}>{archiveChannelLabel[p.platform] ?? p.platform} · {p.publication_format === 'story' ? 'Сторис' : p.publication_format === 'reel' ? 'Reels' : 'Пост'} · {publicationStatusLabels[p.status] ?? p.status}</Text>)}<Text style={styles.voiceHint}>Последнее размещение: {new Date(entry.published_at).toLocaleString('ru-RU')}. Повтор использует его версию.</Text>
        <Text style={styles.itemTitle}>{entry.title}</Text>
        {entry.description ? <Text numberOfLines={3} style={styles.itemCaption}>{entry.description}</Text> : null}
        {entry.preview_media_id ? <Pressable accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={() => setArchivePhotoPath(`/content/archive/${entry.publication_id}/media/${entry.preview_media_id}`)}><ProtectedImage path={`/content/archive/${entry.publication_id}/media/${entry.preview_media_id}`} style={styles.selectedThumb} /></Pressable> : entry.media_ids.length ? <Text style={styles.voiceHint}>В публикации есть медиафайлы</Text> : null}
        <PrimaryButton title="Разместить повторно" icon="repeat-outline" onPress={() => { setArchiveSelected(entry); setArchiveTargets(entry.platform === 'vk' ? [] : [entry.platform]); setArchiveFormatsSelected(Object.fromEntries(ARCHIVE_CHANNELS.map(platform => [platform, archiveDefaultFormat(platform, entry.publication_format)]))); }} />
        {archiveSelected?.publication_id === entry.publication_id ? <><Text style={styles.label}>Куда разместить</Text><Text style={styles.voiceHint}>Выберите площадки и формат для каждой. Создастся новая карточка без немедленной публикации.</Text><View style={styles.options}>{ARCHIVE_CHANNELS.map((platform) => <Pressable key={platform} accessibilityRole="checkbox" accessibilityState={{ checked: archiveTargets.includes(platform) }} onPress={() => setArchiveTargets((current) => current.includes(platform) ? current.filter((value) => value !== platform) : [...current, platform])} style={[styles.option, archiveTargets.includes(platform) && styles.optionActive]}><Text style={styles.optionText}>{archiveChannelLabel[platform]}</Text></Pressable>)}</View>{archiveTargets.map(platform => <View key={platform}><Text style={styles.label}>{archiveChannelLabel[platform]} · формат</Text><View style={styles.options}>{archiveFormats(platform).map(choice => <Pressable key={choice} accessibilityRole="radio" accessibilityState={{checked: archiveFormatsSelected[platform] === choice}} onPress={() => setArchiveFormatsSelected(current => ({...current, [platform]: choice}))} style={[styles.option, archiveFormatsSelected[platform] === choice && styles.optionActive]}><Text style={styles.optionText}>{archiveFormatLabel[choice]}</Text></Pressable>)}</View></View>)}{archiveTargets.includes('instagram') && archiveFormatsSelected.instagram === 'reel' ? <Text style={styles.voiceHint}>Для Reels требуется одно видео; при необходимости измените файлы в карточке.</Text> : null}<PrimaryButton title="Создать карточку для повторной публикации" icon="copy-outline" disabled={busy || !archiveTargets.length} onPress={() => void reuseArchived()} /></> : null}
      </View>)}
      {archive.hasNextPage ? <PrimaryButton title={archive.isFetchingNextPage ? 'Загружаю…' : 'Показать ещё'} disabled={archive.isFetchingNextPage} onPress={() => void archive.fetchNextPage()} /> : null}
      <FullPhotoViewer mediaId={null} sourcePath={archiveOpen ? archivePhotoPath : null} onClose={() => setArchivePhotoPath(null)} />
    </Sheet>
    <View style={styles.weekRow}><Pressable onPress={() => moveWeek(-1)} style={styles.circle}><Ionicons name="chevron-back" size={19} color={colors.ink} /></Pressable><View><Text style={styles.weekTitle}>{week.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} – {weekEnd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</Text><Pressable onPress={() => setWeek(monday(new Date()))}><Text style={styles.today}>Вернуться к текущей неделе</Text></Pressable></View><Pressable onPress={() => moveWeek(1)} style={styles.circle}><Ionicons name="chevron-forward" size={19} color={colors.ink} /></Pressable></View>
    {items.isLoading ? <Busy label="Загружаю контент-план…" /> : items.error ? <ErrorState message={(items.error as Error).message} onRetry={() => void items.refetch()} /> : items.data?.some((item) => item.publications.length ? item.publications.some((publication) => publication.status !== 'published') : item.status !== 'published') ? items.data.filter((item) => item.publications.length ? item.publications.some((publication) => publication.status !== 'published') : item.status !== 'published').map((item) => <Pressable key={item.id} onPress={() => openItem(item)} style={styles.card}>
      <View style={styles.dateBox}>{item.publication_date_assigned === false ? <Text style={styles.dateDay}>БЕЗ ДАТЫ</Text> : <><Text style={styles.dateDay}>{new Date(item.scheduled_at).toLocaleDateString('ru-RU', { weekday: 'short' }).toLocaleUpperCase('ru-RU')}</Text><Text style={styles.dateNumber}>{new Date(item.scheduled_at).getDate()}</Text><Text style={styles.dateTime}>{new Date(item.scheduled_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</Text></>}</View>
      <View style={styles.cardCopy}><View style={styles.status}><View style={styles.statusDot} /><Text style={styles.statusText}>{item.publications.some((p) => p.status === 'published') && item.publications.some((p) => p.status !== 'published') ? 'Опубликовано частично' : (statusLabels[item.status] ?? item.status)}</Text></View><Text style={styles.itemTitle}>{item.title}</Text>{item.publications.find((publication) => publication.media_ids.length)?.media_ids[0] ? <Pressable accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={(event) => { event.stopPropagation(); setCardPhotoId(item.publications.find((publication) => publication.media_ids.length)?.media_ids[0] ?? null); }}><ProtectedImage path={`/media/${item.publications.find((publication) => publication.media_ids.length)!.media_ids[0]}/thumbnail`} style={{ width: '100%', height: 130, borderRadius: 12, marginTop: 8 }} /></Pressable> : null}<Text numberOfLines={3} style={styles.itemCaption}>{item.publications.find((publication) => publication.caption)?.caption || item.caption || 'Текст ещё не подготовлен'}</Text><View style={styles.meta}><Text style={styles.metaText}>{formatLabels[item.content_format] ?? item.content_format}</Text>{item.publications.map((p) => <Text key={p.id} style={[styles.metaText, p.status === 'failed' && styles.error, p.status === 'published' && styles.publishedStatus]}>{archiveChannelLabel[p.platform] ?? p.platform}: {publicationStatusLabels[p.status] ?? p.status}</Text>)}</View></View><Ionicons name="chevron-forward" size={19} color={colors.muted} />
    </Pressable>) : <Empty icon="newspaper-outline" title="На этой неделе публикаций нет" text="Добавьте публикацию или создайте план на неделю." />}

    <Sheet visible={createOpen} title={format === 'availability' ? 'Свободные окошки' : 'Новая публикация'} onClose={() => { setCreateOpen(false); cancelVoiceInput(); }}>
      <Text style={styles.voiceHint}>* Обязательно для создания. Дата, подпись и уточнения заполняются при необходимости.</Text>
      {format === 'availability' ? <><Text style={styles.label}>Мастер для свободных окон *</Text>{availabilityOptions.isLoading ? <Busy label="Загружаю мастеров…" /> : availabilityOptions.error ? <ErrorState message={(availabilityOptions.error as Error).message} onRetry={() => void availabilityOptions.refetch()} /> : availabilityOptions.data?.length ? <View style={styles.options}>{availabilityOptions.data.map((staff) => <Pressable accessibilityRole="button" key={staff.staff_id} style={[styles.option, availabilityStaff === staff.staff_id && styles.optionActive]} onPress={() => setAvailabilityStaff(staff.staff_id)}><Text style={styles.optionText}>{staff.staff_name}</Text></Pressable>)}</View> : <Text style={styles.voiceHint}>Нет мастеров с настроенным шаблоном. Проверьте шаблоны в веб-версии.</Text>}<Text style={styles.voiceHint}>Окна из YCLIENTS будут размещены на фирменном шаблоне выбранного мастера.</Text></> : null}
      {format !== 'availability' ? <VoiceField target="title" label="Название записи *" value={title} onChangeText={setTitle} placeholder="Например, результат процедуры до/после" activeTarget={voiceTarget} disabled={busy} onToggle={(target) => void toggleVoiceInput(target)} /> : null}
      <View style={styles.scheduleToggle}><View style={styles.flex}><Text style={styles.label}>Без подписи под публикацией</Text><Text style={styles.voiceHint}>Подпись не создаётся и не отправляется.</Text></View><Switch accessibilityLabel="Без подписи под публикацией" value={noCaption} disabled={busy} onValueChange={setNoCaption} /></View>{format !== 'availability' ? <View style={styles.scheduleToggle}><View style={styles.flex}><Text style={styles.label}>Не включать название в изображение</Text><Text style={styles.voiceHint}>Надписи из пожеланий сохраняются. Действует при следующей генерации.</Text></View><Switch accessibilityLabel="Не включать название в изображение" value={noTitleOnImage} disabled={busy} onValueChange={setNoTitleOnImage} /></View> : null}
      {format !== 'availability' && !noCaption ? <Field label="Подпись" value={caption} onChangeText={setCaption} placeholder="Текст публикации" multiline /> : null}
      {format !== 'availability' ? <VoiceField target="instruction" label="Пожелания к публикации" value={instruction} onChangeText={setInstruction} placeholder={editPhoto ? 'Например: убери маску, добавь чёрные перчатки, мягкую ретушь, золотую надпись и логотип VIOLETTA' : 'Например: тёмная золотая стилистика, акцент на результате'} multiline activeTarget={voiceTarget} disabled={busy} onToggle={(target) => void toggleVoiceInput(target)} /> : null}
      {format !== 'availability' ? (voiceError ? <Text style={styles.voiceError}>{voiceError}</Text> : <Text style={styles.voiceHint}>Распознавание запускается только после нажатия на микрофон и дополняет введённый текст.</Text>) : null}
      {dateControls(false, format === 'availability')}

      <Text style={styles.label}>Площадки * (выберите хотя бы одну)</Text><View style={styles.options}>{((Platform.OS === 'android' || Platform.OS === 'ios') ? ['telegram', 'telegram_studio', 'whatsapp_studio', 'max', 'instagram', ...(Platform.OS === 'ios' ? ['vk'] : []), 'threads'] : ['telegram', 'max', 'instagram']).map((value) => <Pressable key={value} accessibilityRole="checkbox" accessibilityState={{ checked: platforms.includes(value) }} onPress={() => setPlatforms((current) => current.includes(value) ? current.filter((platform) => platform !== value) : [...current, value])} style={[styles.option, platforms.includes(value) && styles.optionActive]}><Text style={styles.optionText}>{platforms.includes(value) ? '✓ ' : ''}{value === 'whatsapp_studio' ? 'WhatsApp · статус студии' : value === 'telegram_studio' ? 'Telegram · аккаунт студии' : value === 'vk' ? 'ВКонтакте · стена' : value}</Text></Pressable>)}</View>
      {(Platform.OS === 'android' || Platform.OS === 'ios') && platforms.includes('telegram') ? <View><Text style={styles.label}>Telegram · формат публикации</Text><View style={styles.options}>{(['post', 'story'] as const).map((choice) => <Pressable key={choice} accessibilityRole="radio" accessibilityState={{ checked: platformFormats.telegram === choice }} style={[styles.option, platformFormats.telegram === choice && styles.optionActive]} onPress={() => setPlatformFormats((current) => ({ ...current, telegram: choice }))}><Text style={styles.optionText}>{choice === 'post' ? 'Пост' : 'История канала'}</Text></Pressable>)}</View>{platformFormats.telegram === 'story' ? <Text style={styles.voiceHint}>Для историй подключите аккаунт администратора канала. Фото и видео выйдут отдельными историями.</Text> : null}</View> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') && platforms.includes('max') ? <View><Text style={styles.label}>MAX · формат публикации</Text><View style={styles.options}>{(['post', 'story'] as const).map((choice) => <Pressable key={choice} accessibilityRole="radio" accessibilityState={{ checked: platformFormats.max === choice }} style={[styles.option, platformFormats.max === choice && styles.optionActive]} onPress={() => setPlatformFormats((current) => ({ ...current, max: choice }))}><Text style={styles.optionText}>{choice === 'post' ? 'Пост сообщества' : 'История аккаунта'}</Text></Pressable>)}</View>{platformFormats.max === 'story' ? <Text style={styles.voiceHint}>Истории будут опубликованы от подключённого аккаунта студии MAX.</Text> : null}</View> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') && platforms.includes('instagram') ? <View><Text style={styles.label}>Instagram · формат публикации</Text><View style={styles.options}>{(['post', 'story', 'reel'] as const).map((choice) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: platformFormats.instagram === choice }} key={choice} style={[styles.option, platformFormats.instagram === choice && styles.optionActive]} onPress={() => setPlatformFormats((current) => ({ ...current, instagram: choice }))}><Text style={styles.optionText}>{choice === 'post' ? 'Пост' : choice === 'story' ? 'Сторис' : 'Reels'}</Text></Pressable>)}</View><Text style={styles.voiceHint}>{platformFormats.instagram === 'reel' ? 'Для Reels выберите одно видео из медиатеки или загрузите с телефона.' : platformFormats.instagram === 'story' ? 'Выберите до 10 фото или видео: они выйдут отдельными сторис по порядку.' : 'Пост может содержать фото или карусель.'}</Text></View> : null}
      {format !== 'availability' ? <PrimaryButton title={`Выбрать медиа (${mediaIds.length})`} icon="images-outline" tone="ink" onPress={() => { setMediaFolder(null); setMediaOpen(true); }} /> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') && format !== 'availability' && !editPhoto ? <><MediaLimitPicker value={mediaLimit} onChange={setMediaLimit} />{mediaIds.length > mediaLimit ? <Text style={styles.voiceHint}>Выбрано {mediaIds.length} файлов — все выбранные будут сохранены.</Text> : null}</> : null}
      {format !== 'availability' ? mediaIds.length || editPhoto ? <PhotoEditOption enabled={editPhoto} disabled={busy} onChange={setEditPhoto} /> : <Text style={styles.voiceHint}>Выберите одно или несколько фото, чтобы использовать их в публикации или обработать с ИИ.</Text> : null}
      {format !== 'availability' && mediaIds.length ? <View style={styles.selectedMedia}>{mediaIds.map((id) => <Pressable key={id} accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={() => setSheetPhotoId(id)}><ProtectedImage path={`/media/${id}/thumbnail`} style={styles.selectedThumb} /></Pressable>)}</View> : null}
      <PrimaryButton title={busy ? 'Обрабатываю…' : format === 'availability' ? 'Сгенерировать окна' : editPhoto ? 'Обработать фото ИИ' : 'Добавить в план'} icon={editPhoto ? 'sparkles-outline' : 'add-circle-outline'} disabled={busy || (format === 'availability' ? !availabilityStaff : title.trim().length < 2) || !platforms.length} onPress={() => void create()} />
      <FullPhotoViewer mediaId={createOpen ? sheetPhotoId : null} onClose={() => setSheetPhotoId(null)} />
      {datePicker(createOpen && dateOpen)}
      {mediaPicker(createOpen && mediaOpen)}
    </Sheet>

    <Sheet visible={weekOpen} title={dayPlan ? 'План на день' : 'План на неделю'} onClose={() => { setWeekOpen(false); setDateOpen(false); }}>
      <Text style={styles.voiceHint}>* Для плана выберите хотя бы одну площадку и заполните тему хотя бы одной публикации.</Text>
      {dayPlan ? <PrimaryButton title={`День публикаций: ${date}`} icon="calendar-outline" onPress={() => { setDateCursor(scheduledDate(date, '12:00') ?? new Date()); setDateOpen(true); }} /> : <Text style={styles.weekTitle}>{week.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} – {weekEnd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</Text>}
      <Text style={styles.label}>Площадки</Text><View style={styles.options}>{((Platform.OS === 'android' || Platform.OS === 'ios') ? ['telegram', 'telegram_studio', 'whatsapp_studio', 'max', 'instagram', ...(Platform.OS === 'ios' ? ['vk'] : []), 'threads'] : ['telegram', 'max', 'instagram']).map((value) => <Pressable key={value} accessibilityRole="checkbox" accessibilityState={{ checked: platforms.includes(value) }} onPress={() => setPlatforms((current) => current.includes(value) ? current.filter((p) => p !== value) : [...current, value])} style={[styles.option, platforms.includes(value) && styles.optionActive]}><Text style={styles.optionText}>{platforms.includes(value) ? '✓ ' : ''}{value === 'whatsapp_studio' ? 'WhatsApp · статус студии' : value === 'telegram_studio' ? 'Telegram · аккаунт студии' : value === 'vk' ? 'ВКонтакте · стена' : value}</Text></Pressable>)}</View>
      {platforms.map((platform) => <View key={platform}><Text style={styles.label}>{platform.toUpperCase()} · форматы</Text><View style={styles.options}>{(((platform === 'telegram_studio' || platform === 'whatsapp_studio')) ? (['story'] as const) : (platform === 'vk' || platform === 'threads') ? (['post'] as const) : platform === 'instagram' && (Platform.OS === 'android' || Platform.OS === 'ios') ? (['post', 'story', 'reel'] as const) : (Platform.OS === 'android' || Platform.OS === 'ios') ? (['post', 'story'] as const) : (['post', 'reel'] as const)).map((choice) => { const selected = (Platform.OS === 'android' || Platform.OS === 'ios') ? (weekPlatformFormats[platform] ?? ((platform === 'telegram_studio' || platform === 'whatsapp_studio') ? ['story'] : ['post'])).includes(choice) : platformFormats[platform] === choice; return <Pressable key={choice} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} style={[styles.option, selected && styles.optionActive]} onPress={() => { if ((Platform.OS !== 'android' && Platform.OS !== 'ios')) { setPlatformFormats((current) => ({ ...current, [platform]: choice })); return; } setWeekPlatformFormats((current) => { const values = current[platform] ?? ['post']; const next = selected ? values.filter((value) => value !== choice) : [...values, choice]; if (!next.length) { setPlatforms((active) => active.filter((value) => value !== platform)); return { ...current, [platform]: ['post'] }; } return { ...current, [platform]: next }; }); }}><Text style={styles.optionText}>{selected ? '✓ ' : ''}{choice === 'post' ? 'Пост' : choice === 'story' ? (platform === 'telegram' ? 'История канала' : platform === 'max' ? 'История аккаунта' : 'Сторис') : 'Reels'}</Text></Pressable>; })}</View></View>)}
      {platforms.includes('instagram') && ((Platform.OS === 'android' || Platform.OS === 'ios') ? weekPlatformFormats.instagram?.includes('reel') : platformFormats.instagram === 'reel') ? <Text style={styles.voiceHint}>Для Reels выберите одно готовое видео из медиатеки или загрузите с телефона перед запуском плана.</Text> : null}
      {weekEntries.map((entry, index) => <View key={index} style={styles.publication}>{!dayPlan ? <><Text style={styles.label}>День недели</Text><View style={styles.options}>{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day, dayIndex) => <Pressable key={day} style={[styles.option, entry.day === dayIndex && styles.optionActive]} onPress={() => setWeekEntries((current) => current.map((item, i) => i === index ? { ...item, day: dayIndex } : item))}><Text style={styles.optionText}>{day}</Text></Pressable>)}</View></> : null}<Field label="Тема (заполните хотя бы одну)" value={entry.title} onChangeText={(value) => setWeekEntries((current) => current.map((item, i) => i === index ? { ...item, title: value } : item))} /><View style={styles.options}>{(['post', 'story'] as const).map((formatValue) => <Pressable key={formatValue} style={[styles.option, entry.format === formatValue && styles.optionActive]} onPress={() => setWeekEntries((current) => current.map((item, i) => i === index ? { ...item, format: formatValue } : item))}><Text style={styles.optionText}>{formatLabels[formatValue]}</Text></Pressable>)}</View>{(Platform.OS === 'android' || Platform.OS === 'ios') ? <MediaLimitPicker value={entry.mediaLimit} onChange={(value) => setWeekEntries((current) => current.map((item, i) => i === index ? { ...item, mediaLimit: value } : item))} /> : null}{weekEntries.length > 1 ? <PrimaryButton title="Убрать строку" onPress={() => setWeekEntries((current) => current.filter((_, i) => i !== index))} /> : null}</View>)}
      <PrimaryButton title="Добавить публикацию" onPress={() => setWeekEntries((current) => [...current, { day: 0, title: '', format: 'post', mediaLimit: 1 }])} /><PrimaryButton title="Создать план" disabled={busy || !platforms.length || !weekEntries.some((entry) => entry.title.trim())} onPress={() => void createWeek(false)} />{(Platform.OS === 'android' || Platform.OS === 'ios') ? <PrimaryButton title="Создать и запустить план" icon="calendar-outline" disabled={busy || !platforms.length || !weekEntries.some((entry) => entry.title.trim())} onPress={() => void createWeek(true)} /> : null}
      {datePicker(weekOpen && dayPlan && dateOpen)}
    </Sheet>

    <Sheet visible={!!active} title="Публикация" onClose={() => { setActive(null); resetForm(); }}>
      {active ? <><View style={styles.activeHeading}><View style={styles.status}><View style={styles.statusDot} /><Text style={styles.statusText}>{active.publications.some((p) => p.status === 'published') && active.publications.some((p) => p.status !== 'published') ? 'Опубликовано частично' : (statusLabels[active.status] ?? active.status)}</Text></View><Text style={styles.activeDate}>{active.publication_date_assigned === false ? 'Дата не назначена' : new Date(active.scheduled_at).toLocaleString('ru-RU')}</Text></View>
        {(Platform.OS === 'android' || Platform.OS === 'ios') && active.content_format === 'availability' ? <Text style={styles.label}>Мастер: {availabilityOptions.data?.find((staff) => staff.staff_id === active.availability_staff_id)?.staff_name ?? active.title.replace(/\s*—\s*свободные окна$/i, '')}</Text> : <>
          <VoiceField target="title" label="Название записи *" value={title} onChangeText={setTitle} activeTarget={voiceTarget} disabled={busy} onToggle={(target) => void toggleVoiceInput(target)} />
          <View style={styles.scheduleToggle}><View style={styles.flex}><Text style={styles.label}>Без подписи под публикацией</Text><Text style={styles.voiceHint}>Подпись не создаётся и не отправляется.</Text></View><Switch accessibilityLabel="Без подписи под публикацией" value={noCaption} disabled={busy} onValueChange={setNoCaption} /></View>{active.content_format !== 'availability' ? <View style={styles.scheduleToggle}><View style={styles.flex}><Text style={styles.label}>Не включать название в изображение</Text><Text style={styles.voiceHint}>Надписи из пожеланий сохраняются. Действует при следующей генерации.</Text></View><Switch accessibilityLabel="Не включать название в изображение" value={noTitleOnImage} disabled={busy} onValueChange={setNoTitleOnImage} /></View> : null}
          {!noCaption ? <Field label="Подпись" value={caption} onChangeText={setCaption} multiline /> : null}
          <VoiceField target="instruction" label="Пожелания к публикации" value={instruction} onChangeText={setInstruction} placeholder={editPhoto ? 'Например: мягкая ретушь, золотая надпись и логотип VIOLETTA' : undefined} multiline activeTarget={voiceTarget} disabled={busy} onToggle={(target) => void toggleVoiceInput(target)} />
          {voiceError ? <Text style={styles.voiceError}>{voiceError}</Text> : <Text style={styles.voiceHint}>Надиктованный текст добавляется к текущему содержимому поля.</Text>}
          {(Platform.OS === 'android' || Platform.OS === 'ios') ? <><PrimaryButton title={active.status === 'ready' ? 'Сгенерировать заново' : editPhoto ? 'Обработать фото и подготовить текст' : 'Сгенерировать текст и изображение'} icon="refresh-outline" onPress={() => void generate()} disabled={busy || generationUncertain || title.trim().length < 2 || !['draft', 'review', 'approved', 'failed', 'ready'].includes(active.status) || active.publications.some((publication) => ['published', 'publishing'].includes(publication.status))} />{active.status === 'scheduled' ? <Text style={styles.voiceHint}>Публикация уже запланирована. Для новой версии создайте отдельную публикацию.</Text> : active.publications.some((publication) => ['published', 'publishing'].includes(publication.status)) ? <Text style={styles.voiceHint}>Уже размещённую публикацию можно повторно создать из архива.</Text> : null}</> : null}
        </>}
        {generationUncertain ? <><Text style={styles.voiceHint}>Связь прервалась. Генерация могла продолжиться на сервере — сначала обновите результат.</Text><PrimaryButton title="Обновить результат" icon="refresh-outline" disabled={busy} onPress={() => void refreshGeneratedResult()} /></> : null}
        {dateControls(active.publications.some((publication) => publication.status === 'published'), (Platform.OS === 'android' || Platform.OS === 'ios') && active.content_format === 'availability')}
        {(Platform.OS === 'android' || Platform.OS === 'ios') && active.content_format === 'availability' ? null : <><PrimaryButton title={`Медиа (${mediaIds.length})`} icon="images-outline" tone="ink" onPress={() => { setMediaFolder(null); setMediaOpen(true); }} />{(Platform.OS === 'android' || Platform.OS === 'ios') && !editPhoto ? <MediaLimitPicker value={mediaLimit} onChange={setMediaLimit} /> : null}{mediaIds.length || editPhoto ? <PhotoEditOption enabled={editPhoto} disabled={busy} onChange={setEditPhoto} /> : null}{mediaIds.length && !active.publications.some((publication) => publication.media_ids.length) ? <View style={styles.selectedMedia}>{mediaIds.map((id) => <Pressable key={id} accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={() => setSheetPhotoId(id)}><ProtectedImage path={`/media/${id}/thumbnail`} style={styles.selectedThumb} /></Pressable>)}</View> : null}</>}
        <Text style={styles.section}>Публикация</Text>{busy ? <Busy label="Генерация или сохранение… Это может занять несколько минут." /> : null}<View style={styles.actions}>{(Platform.OS !== 'android' && Platform.OS !== 'ios') || active.content_format === 'availability' ? <PrimaryButton title={active.content_format === 'availability' ? 'Сгенерировать окошки' : editPhoto ? 'Обработать фото и подготовить текст' : 'Сгенерировать текст и изображение'} onPress={() => void generate()} disabled={busy || generationUncertain || title.trim().length < 2 || active.status === 'scheduled' || active.publications.some((publication) => ['published', 'publishing'].includes(publication.status))} /> : null}{(Platform.OS === 'android' || Platform.OS === 'ios') ? (dateAssigned ? <PrimaryButton title="Запланировать выбранные площадки" icon="calendar-outline" disabled={busy || title.trim().length < 2} onPress={() => void approveItem()} /> : <Text style={styles.voiceHint}>Выберите кнопку под нужной площадкой, чтобы разместить материал сейчас.</Text>) : <PrimaryButton title="Сохранить для размещения" icon="checkmark-circle-outline" disabled={busy || title.trim().length < 2} onPress={() => void saveItem()} />}</View>
        {active.publications.find((publication) => publication.media_ids.length)?.media_ids[0] ? <Pressable accessibilityRole="button" accessibilityLabel="Открыть фотографию целиком" onPress={() => setSheetPhotoId(active.publications.find((publication) => publication.media_ids.length)?.media_ids[0] ?? null)}><ProtectedImage path={`/media/${active.publications.find((publication) => publication.media_ids.length)!.media_ids[0]}/preview`} style={{ width: '100%', aspectRatio: 1, borderRadius: 12, marginTop: 10 }} /></Pressable> : null}
        <View style={styles.publication}><Text style={styles.publicationTitle}>Выбранные площадки</Text>{active.publications.map((publication) => <View key={publication.id}><Text style={[styles.itemCaption, publication.status === 'failed' && styles.error, publication.status === 'published' && styles.publishedStatus]}>{archiveChannelLabel[publication.platform] ?? publication.platform} · {publication.publication_format === 'reel' ? 'Reels / видео' : publication.publication_format === 'story' ? 'Сторис' : 'Пост'} · {publicationStatusLabels[publication.status] ?? publication.status}</Text>{publication.error ? <Text style={styles.error}>{publication.error}</Text> : null}{publication.status === 'failed' && !publication.external_id && /проверьте|неизвестен/i.test(publication.error ?? '') ? <PrimaryButton title="Я проверил: публикации нет" disabled={busy} onPress={() => Alert.alert('Вы проверили площадку?', 'Подтвердите только если публикации там действительно нет.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Публикации нет', onPress: () => void confirmNotPublished(publication) }])} /> : null}</View>)}</View>

        {(Platform.OS === 'android' || Platform.OS === 'ios') && !dateAssigned ? <PrimaryButton title={active.publications.length > 1 ? 'Разместить на выбранных площадках' : `Разместить в ${active.publications[0]?.platform === 'instagram' ? 'Instagram' : active.publications[0]?.platform === 'vk' ? 'ВКонтакте' : active.publications[0]?.platform === 'max' ? 'MAX' : active.publications[0]?.platform === 'threads' ? 'Threads' : 'Telegram'} · ${active.publications[0]?.publication_format === 'story' ? 'Сторис' : active.publications[0]?.publication_format === 'reel' ? 'Reels' : 'Пост'}`} icon="paper-plane-outline" tone="ink" disabled={busy || !['ready', 'failed'].includes(active.status) || !active.publications.some((publication) => ['pending', 'failed'].includes(publication.status))} onPress={() => void publishNow()} /> : null}
        <PrimaryButton title={active.publications.some((p) => p.status === 'published') ? "Перенести в архив" : "Удалить из плана"} icon="archive-outline" tone="danger" onPress={() => Alert.alert('Убрать карточку из плана?', active.publications.some((p) => p.status === 'published') ? 'Опубликованные материалы и статусы сохранятся в архиве.' : 'Карточка будет убрана из контент-плана.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Убрать', style: 'destructive', onPress: () => void mutate(async () => { await deleteContent(active.id); setActive(null); }, 'Карточка убрана из плана') }])} disabled={busy} />
        <FullPhotoViewer mediaId={sheetPhotoId} onClose={() => setSheetPhotoId(null)} />
        {datePicker(!!active && dateOpen)}
        {mediaPicker(!!active && mediaOpen)}
      </> : null}
    </Sheet>
    <FullPhotoViewer mediaId={archiveOpen ? null : cardPhotoId} onClose={() => setCardPhotoId(null)} />
  </Screen>;
}

const styles = StyleSheet.create({
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 15 }, circle: { width: 39, height: 39, borderRadius: 20, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }, weekTitle: { color: colors.ink, fontFamily: typography.serif, fontSize: 17, textAlign: 'center' }, today: { color: colors.gold, fontSize: 9, fontWeight: '800', textAlign: 'center', marginTop: 3 },
  card: { minHeight: 132, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 13, marginBottom: 10 }, dateBox: { width: 62, minHeight: 85, borderRadius: 17, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, dateDay: { color: colors.ink, fontSize: 9, fontWeight: '900' }, dateNumber: { color: colors.ink, fontSize: 25, fontWeight: '900', marginVertical: 2 }, dateTime: { color: colors.ink, fontSize: 9, fontWeight: '800' }, cardCopy: { flex: 1 }, status: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.creamStrong, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 }, statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.gold }, statusText: { color: colors.ink, fontSize: 9, fontWeight: '900' }, itemTitle: { color: colors.ink, fontSize: 14, fontWeight: '900', marginTop: 7 }, itemCaption: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 }, meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 7 }, metaText: { color: colors.gold, fontSize: 8, fontWeight: '800' },
  twoFields: { flexDirection: 'row', gap: 8 }, flex: { flex: 1 }, timeField: { width: 100 }, label: { color: colors.muted, fontSize: 11, fontWeight: '800', margin: 3 }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 12 }, option: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 13, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, optionActive: { backgroundColor: colors.honey, borderColor: colors.gold }, optionText: { color: colors.ink, fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  scheduleToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }, folderList: { gap: 8, marginBottom: 12 }, folderRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 15 }, folderName: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' }, folderBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 10 }, folderBackText: { color: colors.gold, fontWeight: '800', fontSize: 13 },
  dateGrid: { flexDirection: 'row', flexWrap: 'wrap' }, dateCell: { width: '14.285%', height: 46, textAlign: 'center', textAlignVertical: 'center', alignItems: 'center', justifyContent: 'center', borderRadius: 12, color: colors.muted },
  voiceField: { marginBottom: 4 }, voiceActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: -6, marginBottom: 9 }, voiceButton: { minHeight: 42, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, borderRadius: 14, borderWidth: 1, borderColor: colors.gold, backgroundColor: colors.creamStrong }, generationHelpButton: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 8 }, voiceButtonActive: { backgroundColor: colors.gold, borderColor: colors.gold }, voiceButtonDisabled: { opacity: 0.45 }, voiceButtonText: { color: colors.ink, fontSize: 11, fontWeight: '900' }, voiceButtonTextActive: { color: colors.white }, voiceHint: { color: colors.muted, fontSize: 9, lineHeight: 13, marginTop: -2, marginBottom: 11 }, voiceError: { color: '#A1372B', fontSize: 10, lineHeight: 14, marginTop: -2, marginBottom: 11 },
  editOption: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, marginVertical: 8, borderRadius: 14, backgroundColor: colors.creamStrong }, editCopy: { flex: 1 }, editTitle: { color: colors.ink, fontWeight: '900', fontSize: 12 }, editDescription: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 4 }, selectedMedia: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginVertical: 8 }, selectedThumb: { width: 64, height: 64, borderRadius: 9 }, checkText: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  activeHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 13 }, activeDate: { color: colors.muted, fontSize: 10 }, section: { color: colors.ink, fontFamily: typography.serif, fontSize: 20, marginTop: 15, marginBottom: 8 }, actions: { gap: 2 }, publication: { padding: 13, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, marginVertical: 8 }, publicationTitle: { color: colors.ink, fontSize: 12, fontWeight: '900' }, error: { color: '#A1372B', fontSize: 10, lineHeight: 14, marginTop: 5 },
  publishedStatus: { color: '#287347' },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, mediaItem: { width: '31.8%', borderRadius: 13, overflow: 'hidden', borderWidth: 2, borderColor: colors.line, backgroundColor: colors.white }, mediaSelected: { borderColor: colors.gold }, mediaThumb: { width: '100%', aspectRatio: 1 }, mediaName: { color: colors.ink, fontSize: 8, fontWeight: '700', padding: 6 }, check: { position: 'absolute', top: 5, right: 5, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' },
});
