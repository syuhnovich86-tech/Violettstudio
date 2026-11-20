import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { installAvailableUpdate } from '../updates/updateActions';

export function AppUpdateRow({ busy, setBusy }: { busy: boolean; setBusy: (value: boolean) => void }) {
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const checkUpdates = async () => {
    try { setBusy(true); await installAvailableUpdate(isUpdatePending); }
    finally { setBusy(false); }
  };
  return <><Text style={styles.build}>Android · сборка {Application.nativeBuildVersion ?? 'не определена'}</Text><Pressable accessibilityRole="button" disabled={busy} onPress={() => void checkUpdates()} style={styles.row}><View style={styles.rowIcon}><Ionicons name="cloud-download-outline" size={20} color={(isUpdateAvailable || isUpdatePending) ? colors.green : colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{(isUpdateAvailable || isUpdatePending) ? 'Доступно обновление' : 'Проверить обновления'}</Text>{(isUpdateAvailable || isUpdatePending) ? <Text style={styles.updateAvailable}>{isUpdatePending ? 'Загружено · нажмите, чтобы применить' : 'Нажмите, чтобы установить'}</Text> : <Text style={styles.rowText}>Новые функции загрузятся с сервера без переустановки APK · runtime {Updates.runtimeVersion ?? '0.5.0'}</Text>}</View><Ionicons name="chevron-forward" size={19} color={colors.muted} /></Pressable></>;
}

const styles = StyleSheet.create({
  build: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 17, padding: 12, marginBottom: 8 },
  rowIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.creamStrong, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  rowText: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 },
  updateAvailable: { color: colors.green, fontSize: 11, fontWeight: '800', marginTop: 4 },
});
