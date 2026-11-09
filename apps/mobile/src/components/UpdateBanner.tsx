import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';
import { installAvailableUpdate } from '../updates/updateActions';

export function UpdateBanner() {
  const { isUpdateAvailable, isUpdatePending, availableUpdate, downloadedUpdate } = Updates.useUpdates();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checking = useRef(false);
  const updateId = downloadedUpdate?.updateId ?? availableUpdate?.updateId ?? 'available';
  useEffect(() => {
    if (Platform.OS !== 'android' || !Updates.isEnabled) return;
    const check = async () => {
      if (checking.current || AppState.currentState !== 'active') return;
      checking.current = true;
      try { await Updates.checkForUpdateAsync(); } catch { /* Retry on the next foreground check. */ }
      finally { checking.current = false; }
    };
    void check();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void check(); });
    const timer = setInterval(() => void check(), 5 * 60 * 1000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, []);
  if (Platform.OS !== 'android' || !(isUpdateAvailable || isUpdatePending) || dismissed === updateId) return null;
  return <View accessibilityLiveRegion="polite" style={[styles.banner, { top: insets.top + 8 }]}>
    <Ionicons name="cloud-download-outline" size={23} color={colors.green} />
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setBusy(true); void installAvailableUpdate(isUpdatePending).finally(() => setBusy(false)); }} style={styles.copy}>
      <Text style={styles.title}>{isUpdatePending ? 'Обновление загружено' : 'Доступно обновление'}</Text>
      <Text style={styles.hint}>{busy ? 'Проверяем…' : isUpdatePending ? 'Нажмите, чтобы перезапустить приложение' : 'Нажмите, чтобы установить'}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Закрыть уведомление об обновлении" onPress={() => setDismissed(updateId)} hitSlop={12}><Ionicons name="close" size={21} color={colors.green} /></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  banner: { position: 'absolute', zIndex: 100, elevation: 12, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: '#EAF8EF', borderWidth: 1, borderColor: '#9AD5AD' },
  copy: { flex: 1 }, title: { color: colors.green, fontSize: 14, fontWeight: '800' }, hint: { color: '#326448', fontSize: 11, marginTop: 3 },
});
