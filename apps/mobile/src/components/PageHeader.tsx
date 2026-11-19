import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../theme';
import { useAppChrome } from './AppChrome';
import { StudioRule } from './StudioRule';
import { HelpButton } from './HelpGuide';

export function PageHeader({ title, subtitle, action, onAction, editorial = false }: { editorial?: boolean; title: string; subtitle: string; action?: keyof typeof Ionicons.glyphMap; onAction?: () => void }) {
  const { openProfile } = useAppChrome();
  return (
    <View style={[styles.header, editorial && styles.editorial]}>
      <View style={styles.toolbar}>
        <Text style={[styles.wordmark, editorial && styles.gold]} accessibilityLabel="Violetta">VIOLETTA</Text>
        <View style={styles.actions}>
        <HelpButton topic={title} />
        {action ? <Pressable accessibilityLabel={action === 'sync-outline' ? 'Обновить расписание' : action === 'create-outline' ? 'Создать чат' : 'Добавить папку'} accessibilityRole="button" onPress={onAction} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Ionicons name={action} size={20} color={colors.ink} />
        </Pressable> : null}
        <Pressable accessibilityLabel="Настройки и администрирование" accessibilityRole="button" onPress={openProfile} style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}>
          <Ionicons name="settings-outline" size={21} color={colors.ink} />
        </Pressable>
        </View>
      </View>
      <Text accessibilityRole="header" style={[styles.title, editorial && styles.light]}>{title}</Text>
      <Text style={[styles.subtitle, editorial && styles.soft]}>{subtitle}</Text>
      {editorial && <StudioRule />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: 18, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.gold },
  editorial: { backgroundColor: '#27231F', borderRadius: 20, borderBottomWidth: 0, paddingHorizontal: 18, paddingTop: 13, paddingBottom: 17 },
  gold: { color: colors.honey }, light: { color: colors.cream }, soft: { color: '#DFD7CC' },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  wordmark: { color: colors.ink, fontFamily: typography.serif, fontSize: 15, letterSpacing: 2.4 },
  title: { color: colors.ink, fontFamily: typography.serif, fontSize: 36, letterSpacing: -1 },
  subtitle: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  action: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 7 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
