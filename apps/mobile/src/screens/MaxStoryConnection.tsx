import { useEffect, useState } from 'react';
import { Alert, Image, Text, View } from 'react-native';
import { apiRequest } from '../api/client';
import { Field, PrimaryButton } from '../components/Common';
import { colors } from '../theme';

type Attempt = { attempt_id: string; status: string; message?: string; qr_image?: string | null };

export function MaxStoryConnection({ configured, onChange }: { configured: boolean; onChange: () => void }) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [phone, setPhone] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!attempt || !['connecting', 'checking', 'qr'].includes(attempt.status)) return;
    const timer = setInterval(() => {
      void apiRequest<Omit<Attempt, 'attempt_id'>>(`/integrations/max-story/status/${attempt.attempt_id}`).then((next) => {
        setAttempt((current) => current?.attempt_id === attempt.attempt_id ? { ...current, ...next } : current);
        if (next.status === 'connected' || next.status === 'error') setAnswer('');
        if (next.status === 'connected') onChange();
      }).catch(() => setError('Не удалось проверить подключение.'));
    }, 1500);
    return () => clearInterval(timer);
  }, [attempt?.attempt_id, attempt?.status]);
  async function start() {
    try { setBusy(true); setError(''); setAnswer(''); setAttempt(await apiRequest<Attempt>('/integrations/max-story/start', { method: 'POST', body: JSON.stringify({ phone }) }, true)); setPhone(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось начать вход.'); } finally { setBusy(false); }
  }
  async function startQr() {
    try { setBusy(true); setError(''); setAnswer(''); setAttempt(await apiRequest<Attempt>('/integrations/max-story/start-qr', { method: 'POST' }, true)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось создать QR-код.'); } finally { setBusy(false); }
  }
  async function submit() {
    if (!attempt || !answer) return;
    try { setBusy(true); setError(''); await apiRequest(`/integrations/max-story/answer/${attempt.attempt_id}`, { method: 'POST', body: JSON.stringify({ value: answer }) }, true); setAnswer(''); setAttempt({ ...attempt, status: 'checking' }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить вход.'); } finally { setBusy(false); }
  }
  async function disconnect() {
    try { setBusy(true); await apiRequest('/integrations/max-story/disconnect', { method: 'POST' }, true); setAttempt(null); onChange(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отключить аккаунт.'); } finally { setBusy(false); }
  }
  return <View style={{ gap: 10, marginVertical: 12 }}>
    <Text style={{ color: colors.ink, fontWeight: '800' }}>Истории MAX · {configured ? 'аккаунт подключён' : 'аккаунт не подключён'}</Text>
    <Text style={{ color: colors.muted }}>Истории размещаются от аккаунта студии, а не от имени сообщества. Сервер получит доступ к аккаунту MAX.</Text>
    <PrimaryButton title="Подключить по QR-коду" disabled={busy} onPress={() => void startQr()} />
    <Field label="Номер аккаунта студии с кодом страны" value={phone} onChangeText={setPhone} placeholder="+7…" />
    <PrimaryButton title="Подключить аккаунт MAX" disabled={busy || !phone} onPress={() => void start()} />
    {configured ? <PrimaryButton title="Отключить аккаунт" disabled={busy} onPress={() => Alert.alert('Отключить аккаунт?', 'Сервер удалит сохранённую сессию.', [{ text: 'Отмена' }, { text: 'Отключить', onPress: () => void disconnect() }])} /> : null}
    {attempt?.message ? <Text style={{ color: colors.ink }}>{attempt.message}</Text> : null}
    {attempt?.status === 'qr' && attempt.qr_image ? <Image source={{ uri: attempt.qr_image }} accessibilityLabel="QR-код для подключения MAX" style={{ width: 240, height: 240, alignSelf: 'center' }} /> : null}
    {attempt && ['qr', 'code', 'password'].includes(attempt.status) ? <><Field label={attempt.status === 'code' ? 'Код из MAX' : 'Пароль двухэтапной защиты MAX'} value={answer} onChangeText={setAnswer} secureTextEntry />{attempt.status === 'qr' ? <Text style={{ color: colors.muted }}>Сначала отсканируйте QR-код; если MAX запросит пароль, нажмите кнопку подтверждения.</Text> : null}<PrimaryButton title="Подтвердить вход" disabled={busy || !answer || attempt.status === 'qr'} onPress={() => void submit()} /></> : null}
    {error ? <Text style={{ color: colors.coral }}>{error}</Text> : null}
  </View>;
}
