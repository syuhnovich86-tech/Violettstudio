import { useEffect, useState } from 'react';
import { Alert, Image, Text, View } from 'react-native';
import { apiRequest } from '../api/client';
import { Field, PrimaryButton } from '../components/Common';
import { colors } from '../theme';

type Attempt = { attempt_id: string; status: string; qr?: string | null; message?: string | null };

export function TelegramStoryConnection({ configured, onChange }: { configured: boolean; onChange: () => void }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!attempt || !['waiting', 'checking'].includes(attempt.status)) return;
    const timer = setInterval(() => {
      void apiRequest<Omit<Attempt, 'attempt_id'>>(`/integrations/telegram-story/status/${attempt.attempt_id}`).then((next) => {
        setAttempt((current) => current?.attempt_id === attempt.attempt_id ? { ...current, ...next } : current);
        if (next.status === 'connected') onChange();
      }).catch(() => setError('Не удалось проверить подключение.'));
    }, 2500);
    return () => clearInterval(timer);
  }, [attempt?.attempt_id, attempt?.status]);
  async function start() {
    try { setBusy(true); setError(''); setPassword(''); setAttempt(await apiRequest<Attempt>('/integrations/telegram-story/start', { method: 'POST' }, true)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось начать вход.'); } finally { setBusy(false); }
  }
  async function submitPassword() {
    if (!attempt || !password) return;
    try { setBusy(true); setError(''); await apiRequest(`/integrations/telegram-story/password/${attempt.attempt_id}`, { method: 'POST', body: JSON.stringify({ password }) }, true); setPassword(''); setAttempt({ ...attempt, status: 'checking', qr: null }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить вход.'); } finally { setBusy(false); }
  }
  async function disconnect() {
    try { setBusy(true); await apiRequest('/integrations/telegram-story/disconnect', { method: 'POST' }, true); setAttempt(null); onChange(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отключить аккаунт.'); } finally { setBusy(false); }
  }
  return <View style={{ gap: 10, marginVertical: 12 }}>
    <Text style={{ color: colors.ink, fontWeight: '800' }}>Истории Telegram-канала · {configured ? 'аккаунт подключён' : 'аккаунт не подключён'}</Text>
    <Text style={{ color: colors.muted }}>Подключите аккаунт администратора канала. Сервер получит доступ к аккаунту Telegram. Отключить его можно здесь и в Telegram → Настройки → Устройства.</Text>
    <PrimaryButton title={configured ? 'Подключить другой аккаунт по QR' : 'Подключить аккаунт по QR'} disabled={busy} onPress={() => void start()} />
    {configured ? <PrimaryButton title="Отключить аккаунт" disabled={busy} onPress={() => Alert.alert('Отключить аккаунт?', 'Сервер удалит сохранённую сессию. Также завершите сеанс в Telegram → Настройки → Устройства.', [{ text: 'Отмена' }, { text: 'Отключить', onPress: () => void disconnect() }])} /> : null}
    {attempt?.status === 'waiting' && attempt.qr ? <><Image source={{ uri: attempt.qr }} style={{ width: 240, height: 240, alignSelf: 'center' }} /><Text style={{ color: colors.muted }}>С другого устройства в Telegram откройте «Настройки → Устройства → Подключить устройство» и отсканируйте код. Или откройте этот раздел на сайте с компьютера.</Text></> : null}
    {attempt?.message ? <Text style={{ color: colors.ink }}>{attempt.message}</Text> : null}
    {attempt?.status === 'password' ? <><Field label="Пароль двухэтапной защиты Telegram" value={password} onChangeText={setPassword} secureTextEntry /><PrimaryButton title="Подтвердить вход" disabled={busy || !password} onPress={() => void submitPassword()} /></> : null}
    {error ? <Text style={{ color: colors.coral }}>{error}</Text> : null}
  </View>;
}
