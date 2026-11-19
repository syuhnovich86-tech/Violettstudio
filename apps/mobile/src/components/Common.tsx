import { Ionicons } from '@expo/vector-icons';
import type { ComponentRef, PropsWithChildren, RefObject } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, typography } from '../theme';
import { HelpButton } from './HelpGuide';

export function PrimaryButton({ title, icon, onPress, disabled = false, tone = 'gold' }: { title: string; icon?: keyof typeof Ionicons.glyphMap; onPress: () => void; disabled?: boolean; tone?: 'gold' | 'ink' | 'danger' }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, tone === 'ink' && styles.buttonInk, tone === 'danger' && styles.buttonDanger, (pressed || disabled) && styles.faded]}>
    {icon ? <Ionicons name={icon} size={18} color={tone === 'ink' ? colors.white : colors.ink} /> : null}
    <Text style={[styles.buttonText, tone === 'ink' && styles.buttonTextLight]}>{title}</Text>
  </Pressable>;
}

export function Field({ label, value, onChangeText, placeholder, secureTextEntry = false, multiline = false, keyboardType }: { label?: string; value: string; onChangeText: (value: string) => void; placeholder?: string; secureTextEntry?: boolean; multiline?: boolean; keyboardType?: 'default' | 'email-address' | 'numeric' }) {
  return <View style={styles.fieldWrap}>{label ? <Text style={styles.label}>{label}</Text> : null}<TextInput accessibilityLabel={label ?? placeholder} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} secureTextEntry={secureTextEntry} multiline={multiline} keyboardType={keyboardType} style={[styles.input, multiline && styles.multiline]} /></View>;
}

export function Busy({ label = 'Загрузка данных…' }: { label?: string }) {
  return <View style={styles.state}><ActivityIndicator color={colors.gold} /><Text style={styles.stateText}>{label}</Text></View>;
}
export function Empty({ icon = 'folder-open-outline', title, text }: { icon?: keyof typeof Ionicons.glyphMap; title: string; text: string }) {
  return <View style={styles.empty}><Ionicons name={icon} size={38} color={colors.gold} /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.stateText}>{text}</Text></View>;
}
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <View style={styles.empty}><Ionicons name="alert-circle-outline" size={38} color={colors.coral} /><Text style={styles.emptyTitle}>Не удалось загрузить</Text><Text style={styles.stateText}>{message}</Text><PrimaryButton title="Повторить" onPress={onRetry} /></View>;
}

export function Sheet({ visible, title, onClose, children, scrollRef, helpTopic }: PropsWithChildren<{ visible: boolean; title: string; onClose: () => void; scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>; helpTopic?: string }>) {
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView edges={['top', 'bottom']} style={styles.sheetSafe}>
      <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>{title}</Text><HelpButton topic={helpTopic ?? title} /><Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose} style={styles.close}><Ionicons name="close" size={23} color={colors.ink} /></Pressable></View>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </SafeAreaView>
  </Modal>;
}

export function formatBytes(bytes: number) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

const styles = StyleSheet.create({
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.honey, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginVertical: 5 },
  buttonInk: { backgroundColor: colors.ink },
  buttonDanger: { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: '#DEBAB2' },
  buttonText: { flexShrink: 1, color: colors.ink, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  buttonTextLight: { color: colors.white },
  faded: { opacity: 0.55 },
  fieldWrap: { gap: 6, marginBottom: 11 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '800', marginLeft: 3 },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 15, paddingHorizontal: 14, color: colors.ink, fontSize: 14 },
  multiline: { minHeight: 95, paddingTop: 13, textAlignVertical: 'top' },
  state: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: 12 },
  stateText: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  empty: { minHeight: 210, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: colors.white, borderRadius: 22, borderWidth: 1, borderColor: colors.line },
  emptyTitle: { color: colors.ink, fontFamily: typography.serif, fontSize: 20, textAlign: 'center' },
  sheetSafe: { flex: 1, backgroundColor: colors.cream },
  sheetHeader: { minHeight: 68, paddingVertical: 8, gap: 6, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.line },
  sheetTitle: { flex: 1, color: colors.ink, fontFamily: typography.serif, fontSize: 24 },
  close: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  sheetContent: { padding: 18, paddingBottom: 42 },
});
