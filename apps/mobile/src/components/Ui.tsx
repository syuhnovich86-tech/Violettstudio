import { Ionicons } from '@expo/vector-icons';
import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, typography } from '../theme';

export function SectionTitle({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionAction}>{action}</Text> : null}
    </View>
  );
}

export function Card({ children, tone = 'white' }: PropsWithChildren<{ tone?: 'white' | 'honey' | 'coral' | 'ink' }>) {
  return <View style={[styles.card, styles[`${tone}Card`]]}>{children}</View>;
}

export function Pill({ children, active = false }: PropsWithChildren<{ active?: boolean }>) {
  return (
    <View style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{children}</Text>
    </View>
  );
}

export function ActionRow({
  icon,
  title,
  subtitle,
  badge,
  destructive = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  badge?: string;
  destructive?: boolean;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}>
      <View style={[styles.actionIcon, destructive && styles.actionIconDanger]}>
        <Ionicons name={icon} size={20} color={destructive ? colors.coral : colors.gold} />
      </View>
      <View style={styles.actionCopy}>
        <Text style={styles.actionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.actionSubtitle}>{subtitle}</Text> : null}
      </View>
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, marginBottom: 12 },
  sectionTitle: { color: colors.ink, fontFamily: typography.serif, fontSize: 23, letterSpacing: -0.4 },
  sectionAction: { color: colors.gold, fontSize: 13, fontWeight: '700' },
  card: { borderRadius: 20, padding: 16, borderWidth: 1, borderColor: colors.line, marginBottom: 12 },
  whiteCard: { backgroundColor: colors.white },
  honeyCard: { backgroundColor: colors.creamStrong, borderColor: colors.honey },
  coralCard: { backgroundColor: colors.dangerSoft, borderColor: '#FFD0C4' },
  inkCard: { backgroundColor: colors.ink, borderColor: colors.ink },
  pill: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  pillActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  pillText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  pillTextActive: { color: colors.white },
  actionRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
  actionIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: colors.creamStrong, alignItems: 'center', justifyContent: 'center' },
  actionIconDanger: { backgroundColor: colors.dangerSoft },
  actionCopy: { flex: 1 },
  actionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  actionSubtitle: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 3 },
  badge: { color: colors.gold, backgroundColor: colors.creamStrong, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, fontSize: 11, fontWeight: '800' },
  pressed: { opacity: 0.68 },
});
