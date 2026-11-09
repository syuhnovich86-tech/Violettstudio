import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../theme';
import { useAppChrome } from './AppChrome';

export function PageHeader({ kicker, title, subtitle, action, onAction }: { kicker: string; title: string; subtitle: string; action?: keyof typeof Ionicons.glyphMap; onAction?: () => void }) {
  const { openProfile } = useAppChrome();
  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      <View style={styles.actions}>
        {action ? <Pressable accessibilityRole="button" onPress={onAction} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
          <Ionicons name={action} size={20} color={colors.ink} />
        </Pressable> : null}
        <Pressable accessibilityLabel="Настройки и администрирование" accessibilityRole="button" onPress={openProfile} style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}>
          <Ionicons name="settings-outline" size={21} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 },
  copy: { flex: 1 },
  kicker: { color: colors.gold, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase', marginBottom: 4 },
  title: { color: colors.ink, fontFamily: typography.serif, fontSize: 34, lineHeight: 38, letterSpacing: -1 },
  subtitle: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 5 },
  action: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 7 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.honey, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
