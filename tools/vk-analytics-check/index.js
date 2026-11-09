import bridge from '@vkontakte/vk-bridge';
const message = document.getElementById('status');
const button = document.getElementById('test');
const copy = document.getElementById('copy');
let verifiedToken = null;
copy.addEventListener('click', async () => {
 if (!verifiedToken) return;
 try { await navigator.clipboard.writeText(verifiedToken); message.textContent = 'Ключ скопирован. Вставьте его в поле «Токен VK для аналитики» в настройках студии.'; }
 catch (_) { try { await bridge.send('VKWebAppCopyText', {text: verifiedToken}); message.textContent = 'Ключ скопирован. Вставьте его в настройки аналитики студии.'; } catch (_) { message.textContent = 'Не удалось скопировать ключ. Попробуйте открыть приложение в другом браузере.'; } }
});
bridge.send('VKWebAppInit').catch(() => { message.textContent = 'Откройте эту страницу как мини-приложение во ВКонтакте.'; });
button.addEventListener('click', async () => {
 button.disabled = true; verifiedToken = null; copy.hidden = true; message.textContent = 'Запрашиваем разрешение…';
 let stage = 'получение прав', granted = '';
 try {
   const auth = await bridge.send('VKWebAppGetAuthToken', {app_id: 54886089, scope: 'stats,groups'});
   const raw = Array.isArray(auth.scope) ? auth.scope.join(',') : String(auth.scope || 'не указаны');
   granted = raw.replace(/[^a-z_, ]/gi, '').slice(0,120);
   stage = 'проверка сообщества';
   const group = await bridge.send('VKWebAppCallAPIMethod', {method:'groups.getById',params:{group_id:'141350617',fields:'members_count',v:'5.199',access_token:auth.access_token}});
   const rows = Array.isArray(group.response) ? group.response : group.response?.groups;
   const found = Array.isArray(rows) && rows.length > 0;
   if (!found) { message.textContent = `Сообщество не найдено в ответе VK. Выданные права: ${granted}.`; return; }
   const admin = rows[0]?.is_admin;
   const adminText = admin === 1 ? 'ВК подтверждает права администратора.' : admin === 0 ? 'ВК не видит права администратора.' : 'Роль в ответе не указана.';
   stage = 'чтение статистики';
   try {
     const result = await bridge.send('VKWebAppCallAPIMethod', {method:'stats.get',params:{group_id:141350617,v:'5.199',access_token:auth.access_token}});
     if (Array.isArray(result.response)) { verifiedToken = auth.access_token; copy.hidden = false; message.textContent = `Доступ подтверждён. ${adminText} Права: ${granted}. Ключ действует около часа.`; } else { message.textContent = `VK не вернул статистику в ожидаемом формате. ${adminText} Права: ${granted}.`; }
   } catch (e) {
     const code = e?.error_data?.error_code ?? e?.error_data?.error?.error_code ?? 'неизвестно';
     message.textContent = `Ошибка чтения статистики: код ${String(code).replace(/[^0-9]/g,'').slice(0,8)||'неизвестно'}. ${adminText} Права: ${granted}.`;
   }
 } catch (e) {
   const code = e?.error_data?.error_code ?? e?.error_data?.error?.error_code ?? e?.error_data?.error ?? 'неизвестно';
   message.textContent = `Ошибка: ${stage}, код ${String(code).replace(/[^0-9]/g,'').slice(0,8)||'неизвестно'}. ${granted ? `Выданные права: ${granted}.` : ''}`;
 } finally { button.disabled = false; }
});
