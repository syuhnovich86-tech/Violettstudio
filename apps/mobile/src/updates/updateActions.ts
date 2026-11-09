import * as Updates from 'expo-updates';
import { Alert } from 'react-native';

export async function installAvailableUpdate(pending: boolean): Promise<void> {
  if (!Updates.isEnabled) { Alert.alert('Обновления', 'Проверка доступна в установленной release-версии приложения.'); return; }
  try {
    if (!pending) {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) { Alert.alert('Обновлений нет', 'Установлена последняя версия приложения.'); return; }
      await Updates.fetchUpdateAsync();
    }
    Alert.alert('Обновление загружено', 'Перезапустить приложение и применить новую версию?', [{ text: 'Позже' }, { text: 'Перезапустить', onPress: () => void Updates.reloadAsync() }]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('No update for this runtime') && message.includes('404')) Alert.alert('Обновления пока недоступны', 'Для установленной версии пакет обновления ещё не опубликован.');
    else Alert.alert('Не удалось проверить обновления', 'Проверьте подключение к интернету и повторите попытку.');
  }
}
