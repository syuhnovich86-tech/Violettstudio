import { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { apiRequest } from '../api/client';
import { PrimaryButton } from '../components/Common';
import { colors } from '../theme';

type State = { status: string; qr?: string | null };

export function WhatsAppStoryConnection() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    try { setState(await apiRequest<State>('/integrations/whatsapp-story/status')); setError(''); }
    catch { setError('Сервис WhatsApp пока недоступен.'); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, []);
  async function start() {
    try { setBusy(true); setError(''); await apiRequest('/integrations/whatsapp-story/start', { method: 'POST' }, true); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось начать подключение.'); }
    finally { setBusy(false); }
  }
  return <View style={{ gap: 10, marginVertical: 12 }}>
    <Text style={{ color: colors.ink, fontWeight: '800' }}>WhatsApp статусы студии · {state?.status === 'connected' ? 'подключён' : 'не подключён'}</Text>
    <Text style={{ color: colors.muted }}>Неофициальное связанное устройство; публикация подчиняется настройкам видимости статусов WhatsApp.</Text>
    {state?.status !== 'connected' ? <PrimaryButton title="Подключить WhatsApp по QR" disabled={busy} onPress={() => void start()} /> : null}
    {state?.qr ? <><Image source={{ uri: state.qr }} style={{ width: 240, height: 240, alignSelf: 'center' }} /><Text>В WhatsApp студии откройте «Связанные устройства → Привязка устройства» и отсканируйте код.</Text></> : null}
    {state?.status === 'connecting' ? <Text>Создаём QR-код…</Text> : null}
    {state?.status === 'error' ? <Text style={{ color: colors.coral }}>Подключение не удалось. Попробуйте снова.</Text> : null}
    {error ? <Text style={{ color: colors.coral }}>{error}</Text> : null}
  </View>;
}
