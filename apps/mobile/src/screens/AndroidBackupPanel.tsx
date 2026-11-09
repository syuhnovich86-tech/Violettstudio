import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { createWorkspace, listWorkspaces, type ApiUser, type Workspace } from '../api/client';
import { canUserImportAndroidLibrary } from '../auth/importAuthorization';
import { Busy, Field, PrimaryButton, Sheet } from '../components/Common';
import type { BackupCounts, BackupSettings } from '../media/androidBackupStore';
import { colors, typography } from '../theme';

export function AndroidBackupPanel({ user }: { user: ApiUser }) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [allowCellular, setAllowCellular] = useState(false);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [counts, setCounts] = useState<BackupCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allowed = Platform.OS === 'android' && canUserImportAndroidLibrary(user);

  async function refresh() {
    if (!allowed) return;
    try {
      const module = await import('../media/androidBackup');
      const state = await module.getAndroidBackupState(user.id);
      setSettings(state.settings); setCounts(state.counts);
      return state.settings;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось прочитать состояние.'); }
  }
  useEffect(() => {
    if (!allowed) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [user.id, allowed]);

  async function show() {
    try {
      setOpen(true); setBusy(true); setError('');
      const [available, state] = await Promise.all([listWorkspaces(), refresh()]);
      setFolders(available); setSelected(state?.workspaceId ?? null); setAllowCellular(state?.allowCellular ?? false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось загрузить папки.'); }
    finally { setBusy(false); }
  }
  async function addFolder() {
    if (newName.trim().length < 2) return;
    try {
      setBusy(true); setError('');
      const folder = await createWorkspace(newName.trim(), 'private');
      setFolders((current) => [...current, folder]); setSelected(folder.id); setNewName('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать папку.'); }
    finally { setBusy(false); }
  }
  async function enable() {
    const folder = folders.find((item) => item.id === selected);
    if (!folder) return;
    try {
      setBusy(true); setError('');
      const module = await import('../media/androidBackup');
      await module.enableAndroidBackup(user, folder, allowCellular);
      await refresh();
      setFolders(await listWorkspaces());
      Alert.alert('Синхронизация включена', 'Медиатека будет копироваться в выбранную папку. Оригиналы на Android останутся на месте.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось включить синхронизацию.'); }
    finally { setBusy(false); }
  }
  function confirmEnable() {
    const folder = folders.find((item) => item.id === selected);
    if (!folder) return;
    Alert.alert('Копировать всю медиатеку?', `Фото и видео с устройства будут автоматически копироваться в папку «${folder.display_name}». ${folder.id === '7277b107-5194-4337-b62a-7fb96d053f05' ? 'Это общая папка: файлы будут видны сотрудникам с доступом к медиатеке. ' : folder.kind === 'studio' ? 'Общая папка и уже находящиеся в ней файлы станут приватными: доступ останется у её владельца, выбранных участников и вашего аккаунта. ' : ''}Оригиналы не удаляются; публикация материалов не разрешается автоматически. ${allowCellular ? 'Мобильный интернет разрешён.' : 'Передача только по Wi-Fi.'}`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Включить', onPress: () => void enable() }]);
  }
  async function pause() {
    try { setBusy(true); const module = await import('../media/androidBackup'); await module.pauseAndroidBackup(user.id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось остановить синхронизацию.'); }
    finally { setBusy(false); }
  }
  if (!allowed) return null;
  return <>
    <Text style={styles.heading}>Медиатека Android</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Синхронизация медиатеки Android" onPress={() => void show()} style={styles.row}>
      <View style={styles.icon}><Ionicons name="cloud-upload-outline" size={22} color={colors.gold} /></View>
      <View style={styles.copy}><Text style={styles.title}>Синхронизация Фото</Text><Text style={styles.hint}>{settings?.enabled ? `Включена · ${settings.workspaceName ?? 'папка'}` : 'Выключена · выберите папку'}</Text></View><Ionicons name="chevron-forward" size={21} color={colors.muted} />
    </Pressable>
    <Sheet visible={open} title="Медиатека Android" onClose={() => setOpen(false)}>
      <Text style={styles.hint}>Оригиналы фото и видео с этого устройства копируются в выбранную папку. После обрыва сети приложение повторит незавершённые файлы. Android определяет время фоновой работы.</Text>
      {settings?.enabled ? <View style={styles.status}><Text style={styles.title}>Включено · {settings.workspaceName}</Text><Text style={styles.hint}>Скопировано или найдено: {counts?.complete ?? 0} · В очереди: {counts?.waiting ?? 0} · Повтор: {counts?.failed ?? 0}</Text>{settings.scanOffset > 0 ? <Text style={styles.hint}>Поиск в медиатеке: просмотрено {settings.scanOffset}</Text> : null}{settings.lastError ? <Text style={styles.error}>{settings.lastError}</Text> : null}<PrimaryButton title="Остановить синхронизацию" disabled={busy} onPress={() => void pause()} /></View> : <Text style={styles.hint}>Синхронизация выключена, файлы не копируются.</Text>}
      <Text style={styles.label}>Папка на сервере</Text>
      {busy && !folders.length ? <Busy /> : folders.map((folder) => <Pressable key={folder.id} accessibilityRole="radio" accessibilityState={{ checked: selected === folder.id }} onPress={() => setSelected(folder.id)} style={[styles.folder, selected === folder.id && styles.folderSelected]}><Ionicons name={folder.kind === 'private' ? 'lock-closed-outline' : 'folder-outline'} size={20} color={colors.gold} /><Text style={styles.folderName}>{folder.display_name}</Text><Ionicons name={selected === folder.id ? 'radio-button-on' : 'radio-button-off'} size={21} color={colors.gold} /></Pressable>)}
      {user.can_create_private_workspaces || user.role === 'owner' ? <><Field label="Создать личную папку" value={newName} onChangeText={setNewName} placeholder="Например, Android Виолетты" /><PrimaryButton title="Создать папку" icon="folder-open-outline" disabled={busy || newName.trim().length < 2} onPress={() => void addFolder()} /></> : null}
      <View style={styles.toggle}><View style={styles.copy}><Text style={styles.title}>Мобильный интернет</Text><Text style={styles.hint}>По умолчанию передача только по Wi-Fi</Text></View><Switch accessibilityLabel="Разрешить мобильный интернет" value={allowCellular} onValueChange={setAllowCellular} disabled={busy} /></View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton title={settings?.enabled ? 'Сохранить и продолжить' : 'Включить синхронизацию'} icon="cloud-upload-outline" disabled={busy || !selected} onPress={confirmEnable} />
    </Sheet>
  </>;
}

const styles = StyleSheet.create({
  heading: { color: colors.ink, fontFamily: typography.serif, fontSize: 21, marginTop: 21, marginBottom: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 20, padding: 14, backgroundColor: colors.white },
  icon: { width: 45, height: 45, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  copy: { flex: 1 }, title: { color: colors.ink, fontSize: 15, fontWeight: '800' }, hint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  status: { borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 14, gap: 8, marginTop: 12 }, label: { color: colors.ink, fontSize: 15, fontWeight: '800', marginTop: 18, marginBottom: 8 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 14, padding: 13, marginBottom: 8 }, folderSelected: { borderColor: colors.gold }, folderName: { flex: 1, color: colors.ink, fontWeight: '700' }, toggle: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 }, error: { color: colors.coral, marginVertical: 8 },
});
