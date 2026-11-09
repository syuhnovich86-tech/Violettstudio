import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../auth/AuthProvider';
import { colors, typography } from '../theme';

const emblemAsset = require('../../assets/violetta-emblem-circle-v3.png');

export function LoginScreen() {
  const { signIn } = useAuth();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!login.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      await signIn(login.trim(), password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.brand}><Image source={Platform.OS === 'android' ? { uri: 'assets_violettaemblemcirclev3' } : emblemAsset} resizeMode="cover" style={styles.mark} /><Text style={styles.kicker}>МЕДИАЦЕНТР СТУДИИ</Text><Text style={styles.title}>VIOLETTA</Text><Text style={styles.subtitle}>Календарь, съёмка и вся медиатека в одном приложении</Text></View>
        <View style={styles.form}>
          <View style={styles.field}><Ionicons name="person-outline" size={19} color={colors.gold} /><TextInput value={login} onChangeText={setLogin} autoCapitalize="none" autoCorrect={false} placeholder="Логин" placeholderTextColor={colors.muted} style={styles.input} /></View>
          <View style={styles.field}><Ionicons name="lock-closed-outline" size={19} color={colors.gold} /><TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" placeholder="Пароль" placeholderTextColor={colors.muted} style={styles.input} onSubmitEditing={() => void submit()} /></View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Войти" disabled={busy} onPress={() => void submit()} style={({ pressed }) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.ink} /> : <><Text style={styles.buttonText}>Войти</Text><Ionicons name="arrow-forward" size={19} color={colors.ink} /></>}</Pressable>
        </View>
        <Text style={styles.security}>Защищённое подключение · файлы студии не публикуются автоматически</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  brand: { alignItems: 'center', marginBottom: 38 },
  mark: { width: 78, height: 78, borderRadius: 39, backgroundColor: colors.white, marginBottom: 18 },
  kicker: { color: colors.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  title: { color: colors.ink, fontFamily: typography.serif, fontSize: 42, letterSpacing: 2, marginTop: 5 },
  subtitle: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', maxWidth: 280, marginTop: 8 },
  form: { gap: 11 },
  field: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 18, paddingHorizontal: 16 },
  input: { flex: 1, color: colors.ink, fontSize: 15 },
  error: { color: '#A1372B', fontSize: 12, textAlign: 'center' },
  button: { height: 58, borderRadius: 18, backgroundColor: colors.honey, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  buttonText: { color: colors.ink, fontSize: 15, fontWeight: '900' },
  security: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 24 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.55 },
});
