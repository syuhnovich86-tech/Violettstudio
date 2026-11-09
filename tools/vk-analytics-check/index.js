import bridge from '@vkontakte/vk-bridge';
const message = document.getElementById('status');
const button = document.getElementById('test');
const codeInput = document.getElementById('code');
const groupInput = document.getElementById('group');
const pause = () => new Promise(resolve => setTimeout(resolve, 400));
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const definitions = {reach:['reach','reach'],visitors:['visitors','visitors'],views:['visitors','views'],subscribed:['activity','subscribed'],unsubscribed:['activity','unsubscribed'],likes:['activity','likes'],comments:['activity','comments'],reposts:['activity','copies']};
async function call(method, params, token) { await pause(); const data=await bridge.send('VKWebAppCallAPIMethod',{method,params:{...params,v:'5.199',access_token:token}}); return data.response; }
bridge.send('VKWebAppInit').catch(() => { message.textContent = 'Откройте страницу внутри мини-приложения ВКонтакте.'; });
button.addEventListener('click', async () => {
  const code=codeInput.value.trim(), group=groupInput.value.trim();
  if (!code || !/^\d+$/.test(group)) { message.textContent='Введите код и ID сообщества, показанные в аналитике студии.'; return; }
  button.disabled=true; message.textContent='Подключаем VK и загружаем показатели…';
  try {
    const auth=await bridge.send('VKWebAppGetAuthToken',{app_id:54886089,scope:'stats,groups'});
    const profile=await call('groups.getById',{group_id:group,fields:'members_count'},auth.access_token);
    const groups=Array.isArray(profile)?profile:profile?.groups;
    if (!groups?.length || groups[0].is_admin !== 1) throw new Error('VK не подтвердил права администратора сообщества.');
    const now=Math.floor(Date.now()/1000), periods={};
    for (const days of [7,30,90]) {
      const ranges=[];
      for(const [from,to] of [[now-days*86400,now],[now-days*172800,now-days*86400]]) {
        const rows=await call('stats.get',{group_id:Number(group),timestamp_from:from,timestamp_to:to,interval:'all',extended:1},auth.access_token);
        if(!Array.isArray(rows)) throw new Error('VK не вернул статистику за выбранный период.');
        ranges.push(rows[0]||{});
      }
      periods[String(days)]={};
      for (const [name,[section,key]] of Object.entries(definitions)) periods[String(days)][name]={current:number(ranges[0]?.[section]?.[key]),previous:number(ranges[1]?.[section]?.[key])};
    }
    const raw=await call('stats.get',{group_id:Number(group),timestamp_from:now-90*86400,timestamp_to:now,interval:'day',extended:1},auth.access_token);
    if(!Array.isArray(raw)) throw new Error('VK не вернул статистику по дням.');
    const daily=raw.slice(-200).filter(row=>Number.isInteger(row.period_from)).map(row=>({time:row.period_from,reach:number(row.reach?.reach),visitors:number(row.visitors?.visitors),views:number(row.visitors?.views)}));
    const res=await fetch('/api/v1/content/analytics/vk-bridge/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,group,followers:number(groups[0].members_count),periods,daily}),credentials:'omit',cache:'no-store'});
    if(!res.ok) throw new Error(res.status===403?'Код истёк или не подходит к сообществу. Получите новый код в аналитике студии.':'Не удалось сохранить данные на сервере студии.');
    codeInput.value=''; message.textContent='Готово! Статистика сохранена. Вернитесь в аналитику студии и обновите страницу.';
  } catch(e) { const n=e?.error_data?.error_code || e?.error_data?.error?.error_code; message.textContent=n?`VK вернул ошибку ${String(n).replace(/[^0-9]/g,'')}. Убедитесь, что вы администратор сообщества.`:(e instanceof Error?e.message:'Не удалось получить данные VK. Попробуйте ещё раз.'); }
  finally {button.disabled=false;}
});
