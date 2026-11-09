import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentRef, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { createDiscussion, deleteDiscussion, getNotifications, likeMessage, listChatMedia, listDiscussions, listMessages, listParticipants, markAllNotificationsRead, markDiscussionRead, reactToMessage, sendMessage, type Discussion, type DiscussionMessage } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Busy, Empty, ErrorState, Field, PrimaryButton, Sheet } from '../components/Common';
import { PageHeader } from '../components/PageHeader';
import { ProtectedImage } from '../components/ProtectedImage';
import { Screen } from '../components/Screen';
import { colors, typography } from '../theme';
import type { RootTabs } from '../navigation/types';
import { filterAndroidDiscussions } from '../chats/discussionFilters';

type ChatFilter = 'all' | 'comments' | 'private';

export function ChatsScreen({ route, navigation }: BottomTabScreenProps<RootTabs, 'Chats'>) {
  const { user } = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [chatSearch, setChatSearch] = useState('');
  const [mentionsOnly, setMentionsOnly] = useState(false);
  const [messageSearch, setMessageSearch] = useState('');
  const [messageClient, setMessageClient] = useState('');
  const [messageAuthor, setMessageAuthor] = useState('');
  const [messageBatchOnly, setMessageBatchOnly] = useState(false);
  const [messageFiltersOpen, setMessageFiltersOpen] = useState(false);
  const [active, setActive] = useState<Discussion | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<DiscussionMessage | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [initialMedia, setInitialMedia] = useState<string | null>(null);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const messageScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const messageListTop = useRef(0);
  const unreadTop = useRef(0);
  const discussions = useQuery({ queryKey: ['discussions', (Platform.OS === 'android' || Platform.OS === 'ios') ? '' : chatSearch], queryFn: () => listDiscussions((Platform.OS === 'android' || Platform.OS === 'ios') ? undefined : chatSearch), enabled: !!user?.can_access_chats });
  const participants = useQuery({ queryKey: ['discussion-participants'], queryFn: listParticipants, enabled: createOpen || !!active, staleTime: 0, refetchInterval: createOpen || !!active ? 30_000 : false });
  useEffect(() => { if (!participants.isSuccess) return; const activeIds = new Set(participants.data.map((person) => person.id)); setMembers((current) => current.filter((id) => activeIds.has(id))); if (messageAuthor && !activeIds.has(messageAuthor)) setMessageAuthor(''); }, [participants.data, participants.isSuccess, messageAuthor]);
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: getNotifications, enabled: !!user?.can_access_chats });
  const messages = useQuery({ queryKey: ['messages', active?.id, messageSearch, messageClient, messageAuthor, messageBatchOnly], queryFn: () => listMessages(active!.id, { q: messageSearch.trim() || undefined, client: messageClient.trim() || undefined, author_id: messageAuthor || undefined, batch_id: messageBatchOnly ? active!.batch_id ?? undefined : undefined }), enabled: !!active });
  const chatMedia = useQuery({ queryKey: ['chat-media'], queryFn: listChatMedia, enabled: mediaOpen });
  useEffect(() => {
    const source = route.params?.sourceMedia;
    if (!source || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
    setInitialMedia(source.id); setTitle(source.name.slice(0, 120)); setMembers([]); setCreateOpen(true);
    navigation.setParams({ sourceMedia: undefined });
  }, [route.params?.sourceMedia, navigation]);
  useEffect(() => {
    const latest = messages.data?.at(-1);
    if (active && latest && !messageSearch.trim() && !messageClient.trim() && !messageAuthor && !messageBatchOnly) void markDiscussionRead(active.id, latest.id).then(() => client.invalidateQueries({ queryKey: ['discussions'] })).catch(() => undefined);
  }, [active, client, messages.data, messageSearch, messageClient, messageAuthor, messageBatchOnly]);
  const filtered = useMemo(() => (Platform.OS === 'android' || Platform.OS === 'ios') ? filterAndroidDiscussions(discussions.data ?? [], filter, chatSearch, mentionsOnly) : (discussions.data ?? []).filter((item) => filter === 'all' || (filter === 'comments' ? item.kind === 'batch' : item.is_private)), [discussions.data, filter, chatSearch, mentionsOnly]);
  const mentionTerm = message.match(/(?:^|\s)@([^@\n]*)$/)?.[1];
  const mentionOptions = mentionTerm === undefined ? [] : (participants.data ?? []).filter((person) => person.id !== user?.id && (!active?.is_private || active.member_ids.includes(person.id)) && person.display_name.toLocaleLowerCase('ru-RU').includes(mentionTerm.toLocaleLowerCase('ru-RU'))).slice(0, 8);
  async function mutate(action: () => Promise<unknown>, success?: string) {
    try { setBusy(true); await action(); await Promise.all([client.invalidateQueries({ queryKey: ['discussions'] }), client.invalidateQueries({ queryKey: ['messages'] }), client.invalidateQueries({ queryKey: ['notifications'] })]); if (success) Alert.alert('Готово', success); }
    catch (error) { Alert.alert('Ошибка', error instanceof Error ? error.message : 'Операция не выполнена'); }
    finally { setBusy(false); }
  }
  async function create() {
    if (title.trim().length < 2) return;
    await mutate(async () => {
      const created = await createDiscussion(title.trim(), members);
      setCreateOpen(false); setTitle(''); setMembers([]); setActive(created);
      if (initialMedia) {
        setAttachments([initialMedia]); setInitialMedia(null);
        await sendMessage(created.id, null, [initialMedia]);
        setAttachments([]);
      }
    }, 'Чат создан');
  }
  async function send() {
    if (!active || (!message.trim() && !attachments.length)) return;
    const body = message.trim() || null; const selectedAttachments = [...attachments]; const replyId = reply?.id;
    await mutate(async () => { await sendMessage(active.id, body, selectedAttachments, replyId, active.batch_id); setMessage(''); setAttachments([]); setReply(null); });
  }
  if (!user?.can_access_chats) return <Screen><PageHeader kicker="Общение" title="Чаты" subtitle="Командные обсуждения и комментарии" /><Empty icon="lock-closed-outline" title="Нет доступа к чатам" text="Администратор может включить это право в настройках пользователя." /></Screen>;
  return <Screen>
    <PageHeader kicker="Общение" title="Чаты" subtitle={`${notifications.data?.unread_count ?? 0} непрочитанных уведомлений`} action="create-outline" onAction={() => setCreateOpen(true)} />
    {(Platform.OS === 'android' || Platform.OS === 'ios') ? <Field label="Поиск чата или клиента" value={chatSearch} onChangeText={setChatSearch} placeholder="Название или клиент" /> : null}
    <View style={styles.filters}>{([['all', (Platform.OS === 'android' || Platform.OS === 'ios') ? 'Чаты' : 'Все'], ['comments', 'Комментарии'], ['private', (Platform.OS === 'android' || Platform.OS === 'ios') ? 'Приватные' : 'Личные']] as const).map(([key, label]) => <Pressable key={key} onPress={() => setFilter(key)} style={[styles.filter, filter === key && styles.filterActive]}><Text style={[styles.filterText, filter === key && styles.filterTextActive]}>{label}</Text></Pressable>)}</View>
    {(Platform.OS === 'android' || Platform.OS === 'ios') && filter === 'comments' ? <View style={styles.composerNote}><Text style={styles.replyAuthor}>Упомянули меня</Text><Switch accessibilityLabel="Показывать только упоминания" value={mentionsOnly} onValueChange={setMentionsOnly} /></View> : null}
    {(notifications.data?.unread_count ?? 0) > 0 ? <Pressable onPress={() => void mutate(markAllNotificationsRead)} style={styles.readAll}><Ionicons name="checkmark-done" size={17} color={colors.gold} /><Text style={styles.readAllText}>Отметить все уведомления прочитанными</Text></Pressable> : null}
    {discussions.isLoading ? <Busy label="Загружаю чаты…" /> : discussions.error ? <ErrorState message={(discussions.error as Error).message} onRetry={() => void discussions.refetch()} /> : filtered.length === 0 ? <Empty icon="chatbubbles-outline" title="Обсуждений нет" text={(Platform.OS === 'android' || Platform.OS === 'ios') && (filter !== 'all' || chatSearch.trim()) ? 'По выбранным условиям ничего не найдено.' : 'Создайте чат кнопкой в правом верхнем углу.'} /> : <View style={styles.list}>{filtered.map((chat) => <Pressable key={chat.id} onPress={() => setActive(chat)} style={styles.chat}>
      <View style={[styles.avatar, chat.kind === 'batch' ? styles.avatarCoral : chat.is_private ? styles.avatarGreen : null]}><Text style={styles.avatarText}>{chat.title.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase('ru-RU')}</Text></View>
      <View style={styles.chatCopy}><View style={styles.chatTop}><Text numberOfLines={1} style={styles.chatTitle}>{chat.title}</Text><Text style={styles.time}>{new Date(chat.updated_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</Text></View><View style={styles.chatBottom}><Text numberOfLines={2} style={styles.last}>{chat.last_message || 'Сообщений пока нет'}</Text>{chat.unread_count ? <View style={styles.unread}><Text style={styles.unreadText}>{chat.unread_count}</Text></View> : null}</View></View>
    </Pressable>)}</View>}

    <Sheet visible={createOpen} title="Новый чат" onClose={() => { setCreateOpen(false); setInitialMedia(null); }}>
      <Field label="Название" value={title} onChangeText={setTitle} placeholder="Например: Контент на неделю" />
      <Text style={styles.section}>Участники</Text>{participants.isLoading ? <Busy /> : participants.data?.map((person) => <Pressable key={person.id} onPress={() => setMembers((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id])} style={styles.person}><View style={styles.smallAvatar}><Text style={styles.smallAvatarText}>{person.display_name[0]}</Text></View><Text style={styles.personName}>{person.display_name}</Text><Ionicons name={members.includes(person.id) ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={members.includes(person.id) ? colors.green : colors.muted} /></Pressable>)}
      <PrimaryButton title="Создать чат" icon="chatbubbles-outline" disabled={busy || title.trim().length < 2} onPress={() => void create()} />
    </Sheet>

    <Sheet visible={!!active} title={active?.title ?? 'Чат'} scrollRef={messageScroll} onClose={() => { setActive(null); setReply(null); setAttachments([]); setMessageSearch(''); setMessageClient(''); setMessageAuthor(''); setMessageBatchOnly(false); setMessageFiltersOpen(false); }}>
      {(Platform.OS === 'android' || Platform.OS === 'ios') ? <PrimaryButton title={`Поиск и фильтры${messageSearch || messageClient || messageAuthor || messageBatchOnly ? ' • выбраны' : ''}`} icon="search-outline" onPress={() => setMessageFiltersOpen((open) => !open)} /> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') && messageFiltersOpen ? <><Field label="Поиск в сообщениях" value={messageSearch} onChangeText={setMessageSearch} placeholder="Текст сообщения" /><Field label="Клиент" value={messageClient} onChangeText={setMessageClient} placeholder="Имя клиента" /><Text style={styles.section}>Автор</Text><View style={styles.authorFilters}><Pressable style={[styles.filter, !messageAuthor && styles.filterActive]} onPress={() => setMessageAuthor('')}><Text style={[styles.filterText, !messageAuthor && styles.filterTextActive]}>Все</Text></Pressable>{participants.data?.map((person) => <Pressable key={person.id} style={[styles.filter, messageAuthor === person.id && styles.filterActive]} onPress={() => setMessageAuthor(person.id)}><Text style={[styles.filterText, messageAuthor === person.id && styles.filterTextActive]}>{person.display_name}</Text></Pressable>)}</View>{active?.batch_id ? <View style={styles.composerNote}><Text style={styles.replyAuthor}>Только эта серия</Text><Switch accessibilityLabel="Только эта серия" value={messageBatchOnly} onValueChange={setMessageBatchOnly} /></View> : null}<PrimaryButton title="Сбросить фильтры" onPress={() => { setMessageSearch(''); setMessageClient(''); setMessageAuthor(''); setMessageBatchOnly(false); }} /></> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') && !messageSearch && active?.first_unread_message_id && messages.data?.some((item) => item.id === active.first_unread_message_id) ? <PrimaryButton title="К первому непрочитанному" icon="arrow-down-outline" onPress={() => messageScroll.current?.scrollTo({ y: Math.max(0, messageListTop.current + unreadTop.current - 12), animated: true })} /> : null}
      {messages.isLoading ? <Busy label="Загружаю сообщения…" /> : messages.data?.length ? <View style={styles.messages} onLayout={(event) => { messageListTop.current = event.nativeEvent.layout.y; }}>{messages.data.map((item) => <Pressable key={item.id} onLayout={item.id === active?.first_unread_message_id ? (event) => { unreadTop.current = event.nativeEvent.layout.y; } : undefined} onLongPress={() => setReply(item)} style={[styles.bubble, item.author_id === user.id && styles.myBubble]}>
        <Text style={styles.author}>{item.author_name} · {new Date(item.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
        {item.reply_to ? <View style={styles.replyPreview}><Text style={styles.replyAuthor}>{item.reply_to.author_name}</Text><Text numberOfLines={2} style={styles.replyText}>{item.reply_to.body || 'Вложение'}</Text></View> : null}
        {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
        {item.attachments.map((attachment) => <ProtectedImage key={attachment.media_id} path={attachment.thumbnail_url} style={styles.attachment} />)}
        <View style={styles.reactions}><Pressable onPress={() => void mutate(() => likeMessage(active!.id, item.id))} style={[styles.reaction, item.liked_by_me && styles.reactionActive]}><Ionicons name={item.liked_by_me ? 'heart' : 'heart-outline'} size={15} color={item.liked_by_me ? colors.coral : colors.muted} /><Text style={styles.reactionText}>{item.like_count || ''}</Text></Pressable>{['👍', '❤️', '🔥'].map((emoji) => <Pressable key={emoji} onPress={() => void mutate(() => reactToMessage(active!.id, item.id, emoji))} style={[styles.reaction, item.my_reactions.includes(emoji) && styles.reactionActive]}><Text>{emoji} {item.reactions[emoji] || ''}</Text></Pressable>)}</View>
      </Pressable>)}</View> : <Empty icon="chatbubble-outline" title="Сообщений нет" text="Напишите первое сообщение в этот чат." />}
      {reply ? <View style={styles.composerNote}><Text style={styles.replyAuthor}>Ответ для {reply.author_name}</Text><Pressable onPress={() => setReply(null)}><Ionicons name="close" size={19} color={colors.muted} /></Pressable></View> : null}
      {attachments.length ? <View style={styles.composerNote}><Text style={styles.replyAuthor}>Прикреплено файлов: {attachments.length}</Text><Pressable onPress={() => setAttachments([])}><Ionicons name="close" size={19} color={colors.muted} /></Pressable></View> : null}
      {(Platform.OS === 'android' || Platform.OS === 'ios') ? mentionOptions.map((person) => <Pressable key={person.id} style={styles.person} onPress={() => setMessage((text) => text.replace(/@[^@\n]*$/, `@${person.display_name} `))}><Text style={styles.personName}>@{person.display_name}</Text></Pressable>) : null}
      <View style={styles.composer}><Pressable accessibilityLabel="Прикрепить медиа" onPress={() => setMediaOpen(true)} style={styles.attachButton}><Ionicons name="attach" size={23} color={colors.gold} /></Pressable><TextInput value={message} onChangeText={setMessage} multiline placeholder="Сообщение · @ для упоминания" placeholderTextColor={colors.muted} style={styles.messageInput} /><Pressable disabled={busy || (!message.trim() && !attachments.length)} onPress={() => void send()} style={styles.send}><Ionicons name="send" size={19} color={colors.ink} /></Pressable></View>
      {active?.can_delete ? <PrimaryButton title="Удалить чат" icon="trash-outline" tone="danger" disabled={busy} onPress={() => Alert.alert('Удалить чат?', 'История обсуждения будет удалена.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: () => void mutate(async () => { await deleteDiscussion(active.id); setActive(null); }, 'Чат удалён') }])} /> : null}
    </Sheet>

    <Sheet visible={mediaOpen} title="Прикрепить из архива" onClose={() => setMediaOpen(false)}>
      {chatMedia.isLoading ? <Busy /> : <View style={styles.mediaGrid}>{chatMedia.data?.map((item) => <Pressable key={item.media_id} onPress={() => setAttachments((current) => current.includes(item.media_id) ? current.filter((id) => id !== item.media_id) : [...current, item.media_id])} style={[styles.mediaItem, attachments.includes(item.media_id) && styles.mediaSelected]}><ProtectedImage path={item.thumbnail_url} style={styles.mediaThumb} />{attachments.includes(item.media_id) ? <View style={styles.mediaCheck}><Ionicons name="checkmark" size={17} color={colors.ink} /></View> : null}</Pressable>)}</View>}
      <PrimaryButton title={`Прикрепить (${attachments.length})`} disabled={!attachments.length} onPress={() => setMediaOpen(false)} />
    </Sheet>
  </Screen>;
}

const styles = StyleSheet.create({
  authorFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, filters: { flexDirection: 'row', gap: 7 }, filter: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 15, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, filterActive: { backgroundColor: colors.ink }, filterText: { color: colors.muted, fontSize: 11, fontWeight: '800' }, filterTextActive: { color: colors.white }, readAll: { flexDirection: 'row', gap: 7, alignItems: 'center', paddingVertical: 13 }, readAllText: { color: colors.gold, fontSize: 11, fontWeight: '800' },
  list: { backgroundColor: colors.white, borderRadius: 20, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 13, marginTop: 14 }, chat: { minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 11 }, avatar: { width: 51, height: 51, borderRadius: 17, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, avatarCoral: { backgroundColor: colors.coral }, avatarGreen: { backgroundColor: '#B9CFB6' }, avatarText: { color: colors.ink, fontWeight: '900' }, chatCopy: { flex: 1 }, chatTop: { flexDirection: 'row', gap: 8 }, chatTitle: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '900' }, time: { color: colors.muted, fontSize: 9 }, chatBottom: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5 }, last: { flex: 1, color: colors.muted, fontSize: 10, lineHeight: 14 }, unread: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.coral }, unreadText: { color: colors.ink, fontSize: 9, fontWeight: '900' },
  section: { color: colors.ink, fontFamily: typography.serif, fontSize: 20, marginVertical: 10 }, person: { minHeight: 59, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: colors.line }, smallAvatar: { width: 39, height: 39, borderRadius: 13, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, smallAvatarText: { color: colors.ink, fontWeight: '900' }, personName: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' },
  messages: { gap: 9, marginBottom: 14 }, bubble: { alignSelf: 'flex-start', maxWidth: '92%', minWidth: '58%', padding: 12, borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, myBubble: { alignSelf: 'flex-end', backgroundColor: colors.creamStrong }, author: { color: colors.gold, fontSize: 9, fontWeight: '900', marginBottom: 5 }, body: { color: colors.ink, fontSize: 13, lineHeight: 18 }, replyPreview: { borderLeftWidth: 3, borderLeftColor: colors.gold, paddingLeft: 8, marginBottom: 8 }, replyAuthor: { color: colors.gold, fontSize: 10, fontWeight: '900' }, replyText: { color: colors.muted, fontSize: 10, marginTop: 2 }, attachment: { width: 190, height: 150, borderRadius: 13, marginTop: 8 }, reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 }, reaction: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, borderRadius: 14, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, reactionActive: { backgroundColor: colors.creamStrong, borderColor: colors.honey }, reactionText: { color: colors.muted, fontSize: 9 },
  composerNote: { minHeight: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.creamStrong, paddingHorizontal: 10, borderRadius: 11, marginBottom: 6 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 7, marginTop: 7 }, attachButton: { width: 43, height: 43, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white }, messageInput: { flex: 1, minHeight: 45, maxHeight: 120, color: colors.ink, fontSize: 13, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 13, paddingVertical: 11 }, send: { width: 45, height: 45, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.honey },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, mediaItem: { width: '31.8%', aspectRatio: 1, borderRadius: 13, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' }, mediaSelected: { borderColor: colors.gold }, mediaThumb: { width: '100%', height: '100%' }, mediaCheck: { position: 'absolute', right: 5, top: 5, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' },
});
