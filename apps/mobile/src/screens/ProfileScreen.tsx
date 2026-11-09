import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import { Query, requestPermissionsAsync } from 'expo-media-library';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { changePassword, createUser, getIntegrations, getStorage, listUsers, resetUserPassword, setUserActive, updateIntegrations, updatePermissions, updateUser, type ApiUser, type Role } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { canUserImportIphoneLibrary } from '../auth/importAuthorization';
import { IphoneBackupPanel } from './IphoneBackupPanel';
import { AndroidBackupPanel } from './AndroidBackupPanel';
import { TelegramStoryConnection } from './TelegramStoryConnection';
import { MaxStoryConnection } from './MaxStoryConnection';
import { Busy, ErrorState, Field, PrimaryButton, Sheet, formatBytes } from '../components/Common';
import { colors, typography } from '../theme';
import { installAvailableUpdate } from '../updates/updateActions';

const roleLabel: Record<Role, string> = { owner: 'Владелец', admin: 'Администратор', employee: 'Сотрудник' };
const permissionFields = [
  ['can_create_shared_workspaces', 'Создавать общие папки'], ['can_create_private_workspaces', 'Создавать личные папки'],
  ['can_add_comments', 'Добавлять комментарии'], ['can_upload_media', 'Загружать медиа'],
  ['can_view_all_calendars', 'Смотреть календари команды'], ['can_access_admin', 'Открывать администрирование'],
  ['can_access_chats', 'Открывать чаты'], ['can_access_content', 'Открывать контент-план'],
  ...((Platform.OS === 'android' || Platform.OS === 'ios') ? [['can_access_analytics', 'Открывать аналитику'] as const] : []),
  ...((Platform.OS === 'android' || Platform.OS === 'ios') ? [['can_delete_workspaces', 'Удалять папки'] as const] : []),
  ...(Platform.OS === 'android' ? [['can_import_android_photo_library', 'Копировать медиатеку Android'] as const] : []),
  ['can_import_ios_photo_library', 'Копировать медиатеку iPhone'],
] as const;

export function ProfileScreen({ onClose }: { onClose: () => void }) {
  const { user, signOut, refreshUser } = useAuth();
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const client = useQueryClient();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiUser | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [name, setName] = useState('');
  const [loginName, setLoginName] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [role, setRole] = useState<Role>('employee');
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [integrationValues, setIntegrationValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const storage = useQuery({ queryKey: ['storage'], queryFn: getStorage });
  const users = useQuery({ queryKey: ['users'], queryFn: listUsers, enabled: adminOpen && !!user?.can_access_admin });
  const integrations = useQuery({ queryKey: ['integrations'], queryFn: getIntegrations, enabled: integrationsOpen && !!user?.can_access_admin });
  useEffect(() => { if (editing) { setName(editing.display_name); setLoginName(editing.login); setRole(editing.role); setTemporaryPassword(''); setPermissions(Object.fromEntries(permissionFields.map(([field]) => [field, !!editing[field]]))); } }, [editing]);
  useEffect(() => { if (integrations.data) setIntegrationValues({ openai_model: integrations.data.openai.fields.model ?? '', openai_analytics_model: integrations.data.openai.fields.analytics_model ?? '', telegram_channel: integrations.data.telegram.fields.channel ?? '', telegram_api_id: integrations.data.telegram.fields.api_id ?? '', telegram_api_hash: '', max_channel_id: integrations.data.max.fields.channel_id ?? '', instagram_account_id: integrations.data.instagram.fields.account_id ?? '', vk_group_id: integrations.data.vk?.fields.group_id ?? '', vk_user_token: '', vk_analytics_token: '', openai_api_key: '', telegram_bot_token: '', max_bot_token: '', instagram_access_token: '' }); }, [integrations.data]);
  async function mutate(action: () => Promise<unknown>, success?: string) {
    try { setBusy(true); await action(); await Promise.all([client.invalidateQueries({ queryKey: ['users'] }), client.invalidateQueries({ queryKey: ['storage'] }), client.invalidateQueries({ queryKey: ['integrations'] }), client.invalidateQueries({ queryKey: ['calendar-users'] }), client.invalidateQueries({ queryKey: ['visits'] }), client.invalidateQueries({ queryKey: ['visits-upload'] }), client.invalidateQueries({ queryKey: ['availability-staff'] }), client.invalidateQueries({ queryKey: ['discussion-participants'] }), client.invalidateQueries({ queryKey: ['workspaces'] })]); if (success) Alert.alert('Готово', success); }
    catch (error) { Alert.alert('Ошибка', error instanceof Error ? error.message : 'Операция не выполнена'); }
    finally { setBusy(false); }
  }
  function beginCreate() { setName(''); setLoginName(''); setTemporaryPassword(''); setRole('employee'); setPermissions(Object.fromEntries(permissionFields.map(([field]) => [field, field === 'can_add_comments' || field === 'can_upload_media' || field === 'can_access_chats']))); setCreateOpen(true); }
  function permissionPayload(target: ApiUser | null) {
    return {
      role, can_create_shared_workspaces: !!permissions.can_create_shared_workspaces, can_create_private_workspaces: !!permissions.can_create_private_workspaces,
      can_delete_workspaces: (Platform.OS === 'android' || Platform.OS === 'ios') ? !!permissions.can_delete_workspaces : undefined,
      can_add_comments: !!permissions.can_add_comments, can_upload_media: !!permissions.can_upload_media, can_view_all_calendars: !!permissions.can_view_all_calendars,
      can_access_admin: !!permissions.can_access_admin, can_access_chats: !!permissions.can_access_chats, can_access_content: !!permissions.can_access_content,
      can_access_analytics: user?.role === 'owner' && (Platform.OS === 'android' || Platform.OS === 'ios') ? !!permissions.can_access_analytics : undefined,
      can_import_ios_photo_library: user?.role === 'owner' ? !!permissions.can_import_ios_photo_library : target?.can_import_ios_photo_library ?? false,
      can_import_android_photo_library: Platform.OS === 'android' && user?.role === 'owner' ? !!permissions.can_import_android_photo_library : target?.can_import_android_photo_library,
    };
  }
  async function saveEditing() {
    if (!editing) return;
    await mutate(async () => {
      await updateUser(editing.id, name.trim(), loginName.trim());
      await updatePermissions(editing.id, permissionPayload(editing));
      if (temporaryPassword) await resetUserPassword(editing.id, temporaryPassword);
      if (editing.id === user?.id) await refreshUser();
      setEditing(null);
    }, 'Пользователь и права сохранены');
  }
  async function saveNewUser() {
    await mutate(async () => {
      const created = await createUser({ display_name: name.trim(), login: loginName.trim(), password: temporaryPassword, role });
      await updatePermissions(created.id, permissionPayload(null));
      setCreateOpen(false);
    }, 'Пользователь создан');
  }
  async function saveIntegrations() {
    const payload = Object.fromEntries(Object.entries(integrationValues).map(([key, value]) => [key, value.trim() || null]));
    await mutate(() => updateIntegrations(payload), 'Настройки интеграций сохранены');
  }
  async function checkUpdates() {
    try { setBusy(true); await installAvailableUpdate(isUpdatePending); }
    finally { setBusy(false); }
  }
  async function checkPhotoLibraryAccess() {
    try {
      setBusy(true);
      const permission = await requestPermissionsAsync(false, ['photo', 'video']);
      if (!permission.granted || permission.accessPrivileges === 'none') {
        Alert.alert('Доступ к Фото не предоставлен', 'Изменить разрешение можно в настройках iPhone. Файлы не загружались.');
        return;
      }
      await new Query().limit(1).exeForMetadata();
      const access = permission.accessPrivileges === 'limited' ? 'Разрешён доступ только к выбранным фотографиям.' : 'Доступ к медиатеке Фото предоставлен.';
      Alert.alert('Проверка доступа', `${access}\n\nЭто только проверка: файлы не копируются и не отправляются на сервер.`);
    } catch (error) {
      Alert.alert('Не удалось проверить Фото', error instanceof Error ? error.message : 'Проверьте настройки доступа к Фото.');
    } finally { setBusy(false); }
  }
  return <SafeAreaView edges={['top', 'bottom']} style={styles.safe}><View style={styles.header}><View><Text style={styles.kicker}>НАСТРОЙКИ</Text><Text style={styles.title}>Профиль и управление</Text></View><Pressable accessibilityLabel="Закрыть настройки" onPress={onClose} style={styles.close}><Ionicons name="close" size={24} color={colors.ink} /></Pressable></View><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.profile}><View style={styles.avatar}><Text style={styles.avatarText}>{user?.display_name[0]?.toLocaleUpperCase('ru-RU')}</Text></View><View style={styles.profileCopy}><Text style={styles.name}>{user?.display_name}</Text><Text style={styles.role}>{roleLabel[user?.role ?? 'employee']} · @{user?.login}</Text></View><Ionicons name="checkmark-circle" size={23} color={colors.green} /></View>
    <Text style={styles.section}>Доступ аккаунта</Text><View style={styles.card}>{permissionFields.filter(([field]) => user?.[field]).map(([field, label]) => <View key={field} style={styles.permission}><Ionicons name="checkmark-circle-outline" size={19} color={colors.green} /><Text style={styles.permissionText}>{label}</Text></View>)}</View>
    {user ? <IphoneBackupPanel user={user} /> : null}
    {user ? <AndroidBackupPanel user={user} /> : null}
    {Platform.OS === 'ios' && canUserImportIphoneLibrary(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Проверить доступ к Фото" disabled={busy} onPress={() => void checkPhotoLibraryAccess()} style={styles.row}><View style={styles.rowIcon}><Ionicons name="images-outline" size={20} color={colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Проверить доступ к Фото</Text><Text style={styles.rowText}>Только проверка разрешения, без копирования на сервер</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable> : null}
    <Text style={styles.section}>Хранилище сервера</Text>{storage.isLoading ? <Busy label="Проверяю хранилище…" /> : storage.error ? <ErrorState message={(storage.error as Error).message} onRetry={() => void storage.refetch()} /> : storage.data ? <View style={styles.card}><View style={styles.storageTop}><Text style={styles.storageValue}>{formatBytes(storage.data.media_bytes)} медиа</Text><Text style={styles.storagePercent}>{storage.data.used_percent}% диска</Text></View><View style={styles.track}><View style={[styles.trackValue, { width: `${Math.min(100, storage.data.used_percent)}%` }]} /></View><Text style={styles.storageText}>Свободно {formatBytes(storage.data.free_bytes)} из {formatBytes(storage.data.total_bytes)}</Text></View> : null}
    <Text style={styles.section}>Приложение</Text>{Platform.OS === 'android' && <Text style={styles.rowText}>Android · сборка {Application.nativeBuildVersion ?? 'не определена'}</Text>}<Pressable accessibilityRole="button" disabled={busy} onPress={() => void checkUpdates()} style={styles.row}><View style={styles.rowIcon}><Ionicons name="cloud-download-outline" size={20} color={Platform.OS === 'android' && (isUpdateAvailable || isUpdatePending) ? colors.green : colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{Platform.OS === 'android' && (isUpdateAvailable || isUpdatePending) ? 'Доступно обновление' : 'Проверить обновления'}</Text>{Platform.OS === 'android' && (isUpdateAvailable || isUpdatePending) ? <Text style={styles.updateAvailable}>{isUpdatePending ? 'Загружено · нажмите, чтобы применить' : 'Нажмите, чтобы установить'}</Text> : <Text style={styles.rowText}>Новые функции загрузятся с сервера без переустановки {Platform.OS === 'ios' ? 'приложения' : 'APK'} · runtime {Updates.runtimeVersion ?? '0.2.0'}</Text>}</View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable>
    <Text style={styles.section}>Безопасность</Text><Pressable onPress={() => setPasswordOpen(true)} style={styles.row}><View style={styles.rowIcon}><Ionicons name="key-outline" size={20} color={colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Изменить пароль</Text><Text style={styles.rowText}>Текущий и новый пароль</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable>
    {user?.can_access_admin ? <><Text style={styles.section}>Администрирование</Text><Pressable onPress={() => setAdminOpen(true)} style={styles.row}><View style={styles.rowIcon}><Ionicons name="people-outline" size={20} color={colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Пользователи и права</Text><Text style={styles.rowText}>Аккаунты, роли, пароли и индивидуальные разрешения</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable><Pressable onPress={() => setIntegrationsOpen(true)} style={styles.row}><View style={styles.rowIcon}><Ionicons name="git-network-outline" size={20} color={colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>Интеграции</Text><Text style={styles.rowText}>OpenAI, Telegram, MAX и Instagram</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable></> : null}
    <PrimaryButton title="Выйти из аккаунта" icon="log-out-outline" tone="danger" disabled={busy} onPress={() => Alert.alert('Выйти?', 'Для повторного входа потребуется пароль.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Выйти', style: 'destructive', onPress: () => void signOut() }])} />
  </ScrollView>

  <Sheet visible={passwordOpen} title="Изменить пароль" onClose={() => setPasswordOpen(false)}><Field label="Текущий пароль" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry /><Field label="Новый пароль (не менее 10 символов)" value={newPassword} onChangeText={setNewPassword} secureTextEntry /><PrimaryButton title="Сохранить новый пароль" disabled={busy || !currentPassword || newPassword.length < 10} onPress={() => void mutate(async () => { await changePassword(currentPassword, newPassword); setPasswordOpen(false); setCurrentPassword(''); setNewPassword(''); }, 'Пароль изменён')} /></Sheet>

  <Sheet visible={adminOpen} title="Пользователи и права" onClose={() => setAdminOpen(false)}><PrimaryButton title="Создать пользователя" icon="person-add-outline" onPress={beginCreate} />{users.isLoading ? <Busy /> : users.error ? <ErrorState message={(users.error as Error).message} onRetry={() => void users.refetch()} /> : users.data?.map((person) => <Pressable key={person.id} onPress={() => setEditing(person)} style={styles.userRow}><View style={[styles.userAvatar, !person.is_active && styles.inactive]}><Text style={styles.userAvatarText}>{person.display_name[0]}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{person.display_name}</Text><Text style={styles.rowText}>@{person.login} · {roleLabel[person.role]} · {person.is_active ? 'активен' : 'отключён'}</Text></View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable>)}</Sheet>

  <Sheet visible={!!editing} title="Пользователь" onClose={() => setEditing(null)}>{editing ? <><Field label="Имя" value={name} onChangeText={setName} /><Field label="Логин" value={loginName} onChangeText={setLoginName} /><Field label="Новый временный пароль (необязательно)" value={temporaryPassword} onChangeText={setTemporaryPassword} secureTextEntry /><Text style={styles.label}>Роль</Text><View style={styles.roles}>{(['employee', 'admin', 'owner'] as Role[]).map((value) => <Pressable key={value} onPress={() => setRole(value)} style={[styles.roleButton, role === value && styles.roleActive]}><Text style={styles.roleButtonText}>{roleLabel[value]}</Text></Pressable>)}</View><Text style={styles.label}>Индивидуальные права</Text>{permissionFields.filter(([field]) => !['can_import_android_photo_library', 'can_import_ios_photo_library', 'can_access_analytics'].includes(field) || user?.role === 'owner').map(([field, label]) => <View key={field} style={styles.toggle}><Text style={styles.toggleText}>{label}</Text><Switch value={!!permissions[field]} onValueChange={(value) => setPermissions((current) => ({ ...current, [field]: value }))} /></View>)}<View style={styles.toggle}><View><Text style={styles.toggleText}>Аккаунт активен</Text><Text style={styles.toggleHint}>Отключённый пользователь не сможет войти</Text></View><Switch value={editing.is_active} onValueChange={(value) => void mutate(async () => { const updated = await setUserActive(editing.id, value); setEditing(updated); })} /></View><PrimaryButton title="Сохранить пользователя" disabled={busy || name.trim().length < 2 || loginName.trim().length < 3 || (!!temporaryPassword && temporaryPassword.length < 10)} onPress={() => void saveEditing()} /></> : null}</Sheet>

  <Sheet visible={createOpen} title="Новый пользователь" onClose={() => setCreateOpen(false)}><Field label="Имя" value={name} onChangeText={setName} /><Field label="Логин" value={loginName} onChangeText={setLoginName} /><Field label="Временный пароль (не менее 10 символов)" value={temporaryPassword} onChangeText={setTemporaryPassword} secureTextEntry /><Text style={styles.label}>Роль</Text><View style={styles.roles}>{(['employee', 'admin'] as Role[]).map((value) => <Pressable key={value} onPress={() => setRole(value)} style={[styles.roleButton, role === value && styles.roleActive]}><Text style={styles.roleButtonText}>{roleLabel[value]}</Text></Pressable>)}</View>{permissionFields.filter(([field]) => !['can_import_android_photo_library', 'can_import_ios_photo_library', 'can_access_analytics'].includes(field) || user?.role === 'owner').map(([field, label]) => <View key={field} style={styles.toggle}><Text style={styles.toggleText}>{label}</Text><Switch value={!!permissions[field]} onValueChange={(value) => setPermissions((current) => ({ ...current, [field]: value }))} /></View>)}<PrimaryButton title="Создать аккаунт" disabled={busy || name.trim().length < 2 || loginName.trim().length < 3 || temporaryPassword.length < 10} onPress={() => void saveNewUser()} /></Sheet>

  <Sheet visible={integrationsOpen} title="Интеграции" onClose={() => setIntegrationsOpen(false)}>{integrations.isLoading ? <Busy /> : integrations.error ? <ErrorState message={(integrations.error as Error).message} onRetry={() => void integrations.refetch()} /> : <>{((Platform.OS === 'android' || Platform.OS === 'ios') ? (['openai', 'telegram', 'max', 'instagram', 'vk', 'threads'] as const) : (['openai', 'telegram', 'max', 'instagram'] as const)).map((provider) => <View key={provider} style={styles.provider}><View style={styles.providerTop}><Text style={styles.providerName}>{provider.toLocaleUpperCase('ru-RU')}</Text><Text style={[styles.providerStatus, integrations.data?.[provider]?.configured && styles.configured]}>{integrations.data?.[provider]?.configured ? 'НАСТРОЕНО' : 'НЕ НАСТРОЕНО'}</Text></View>{provider === 'openai' ? <><Field label="Модель" value={integrationValues.openai_model ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, openai_model: value }))} /><Field label="Модель рекомендаций аналитики" value={integrationValues.openai_analytics_model ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, openai_analytics_model: value }))} /><Field label="Новый API-ключ (оставьте пустым, чтобы не менять)" value={integrationValues.openai_api_key ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, openai_api_key: value }))} secureTextEntry /></> : provider === 'telegram' ? <><Field label="Канал" value={integrationValues.telegram_channel ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, telegram_channel: value }))} /><Field label="Новый токен бота" value={integrationValues.telegram_bot_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, telegram_bot_token: value }))} secureTextEntry />{(Platform.OS === 'android' || Platform.OS === 'ios') ? <><Field label="API ID приложения Telegram" value={integrationValues.telegram_api_id ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, telegram_api_id: value }))} /><Field label="API hash Telegram (оставьте пустым, чтобы не менять)" value={integrationValues.telegram_api_hash ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, telegram_api_hash: value }))} secureTextEntry /><TelegramStoryConnection configured={integrations.data?.telegram.fields.story_session_configured === 'true'} onChange={() => void client.invalidateQueries({ queryKey: ['integrations'] })} /></> : null}</> : provider === 'max' ? <><Field label="ID канала" value={integrationValues.max_channel_id ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, max_channel_id: value }))} /><Field label="Новый токен бота" value={integrationValues.max_bot_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, max_bot_token: value }))} secureTextEntry />{(Platform.OS === 'android' || Platform.OS === 'ios') ? <MaxStoryConnection configured={integrations.data?.max.fields.story_session_configured === 'true'} onChange={() => void client.invalidateQueries({ queryKey: ['integrations'] })} /> : null}</> : provider === 'threads' ? <><Field label="Токен Threads" value={integrationValues.threads_access_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, threads_access_token: value }))} secureTextEntry /></> : provider === 'vk' ? <><Field label="ID сообщества ВКонтакте" value={integrationValues.vk_group_id ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, vk_group_id: value }))} /><Field label="Токен VK для публикаций" value={integrationValues.vk_user_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, vk_user_token: value }))} secureTextEntry /><Field label="Отдельный пользовательский токен VK для аналитики" value={integrationValues.vk_analytics_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, vk_analytics_token: value }))} secureTextEntry /><Text style={styles.toggleHint}>Токен аналитики сохранён: {integrations.data?.vk?.fields.analytics_token_configured === 'true' ? 'да' : 'нет'}. Ключ публикаций не меняется.</Text><Text style={styles.toggleHint}>Токен администратора сообщества с правами стены, фото и видео.</Text></> : <><Field label="ID аккаунта" value={integrationValues.instagram_account_id ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, instagram_account_id: value }))} /><Field label="Новый access token" value={integrationValues.instagram_access_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, instagram_access_token: value }))} secureTextEntry /><Field label="Отдельный маркер аналитики Instagram" value={integrationValues.instagram_analytics_access_token ?? ''} onChangeText={(value) => setIntegrationValues((current) => ({ ...current, instagram_analytics_access_token: value }))} secureTextEntry /></>}</View>)}<PrimaryButton title="Сохранить интеграции" disabled={busy} onPress={() => void saveIntegrations()} /></>}</Sheet>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream }, header: { minHeight: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: colors.line }, kicker: { color: colors.gold, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 }, title: { color: colors.ink, fontFamily: typography.serif, fontSize: 25, marginTop: 3 }, close: { width: 43, height: 43, borderRadius: 22, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }, content: { padding: 18, paddingBottom: 42 },
  profile: { minHeight: 93, flexDirection: 'row', alignItems: 'center', gap: 13, padding: 16, borderRadius: 23, backgroundColor: colors.ink }, avatar: { width: 58, height: 58, borderRadius: 19, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: colors.ink, fontFamily: typography.serif, fontSize: 28 }, profileCopy: { flex: 1 }, name: { color: colors.white, fontFamily: typography.serif, fontSize: 22 }, role: { color: '#C7C0BA', fontSize: 10, marginTop: 4 }, section: { color: colors.ink, fontFamily: typography.serif, fontSize: 21, marginTop: 21, marginBottom: 9 },
  card: { padding: 14, borderRadius: 18, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }, permission: { minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 8 }, permissionText: { color: colors.ink, fontSize: 11, fontWeight: '700' }, storageTop: { flexDirection: 'row', justifyContent: 'space-between' }, storageValue: { color: colors.ink, fontSize: 13, fontWeight: '900' }, storagePercent: { color: colors.gold, fontSize: 11, fontWeight: '900' }, track: { height: 9, borderRadius: 5, backgroundColor: colors.line, overflow: 'hidden', marginVertical: 11 }, trackValue: { height: '100%', backgroundColor: colors.honey }, storageText: { color: colors.muted, fontSize: 10 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 17, padding: 12, marginBottom: 8 }, rowIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.creamStrong, alignItems: 'center', justifyContent: 'center' }, rowCopy: { flex: 1 }, rowTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' }, rowText: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 }, userRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: colors.line }, userAvatar: { width: 43, height: 43, borderRadius: 14, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' }, inactive: { opacity: 0.35 }, userAvatarText: { color: colors.ink, fontWeight: '900' },
  updateAvailable: { color: colors.green, fontSize: 11, fontWeight: '800', marginTop: 4 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '800', margin: 3 }, roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 13 }, roleButton: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 13 }, roleActive: { backgroundColor: colors.honey, borderColor: colors.gold }, roleButtonText: { color: colors.ink, fontSize: 11, fontWeight: '800' }, toggle: { minHeight: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottomWidth: 1, borderBottomColor: colors.line }, toggleText: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '800' }, toggleHint: { color: colors.muted, fontSize: 9, marginTop: 3 },
  provider: { padding: 13, borderRadius: 17, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, marginBottom: 10 }, providerTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }, providerName: { color: colors.ink, fontSize: 13, fontWeight: '900' }, providerStatus: { color: colors.coral, fontSize: 8, fontWeight: '900' }, configured: { color: colors.green },
});
