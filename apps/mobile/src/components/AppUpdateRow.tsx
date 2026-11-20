import * as Application from 'expo-application';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';

export function AppUpdateRow(_props: { busy: boolean; setBusy: (value: boolean) => void }) {
  return <View style={styles.row}><View style={styles.rowIcon}><Ionicons name="phone-portrait-outline" size={20} color={colors.gold} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>VIOLETTA {Application.nativeApplicationVersion ?? '0.3.0'}</Text><Text style={styles.rowText}>Сборка {Application.nativeBuildVersion ?? 'не определена'} · обновление устанавливается только новой подписанной версией</Text></View></View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 17, padding: 12, marginBottom: 8 },
  rowIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.creamStrong, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 13, fontWeight: '900' },
  rowText: { color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 3 },
});
