"""Read-only VK analytics using a separately configured user token."""
from datetime import UTC, datetime

import httpx

from vita29.integrations.store import config_value, read_secret


def _number(row, section, key):
    value = (row.get(section) or {}).get(key)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def _message(code):
    if code == 27:
        return 'VK отклонил ключ сообщества: для статистики нужен пользовательский токен администратора.'
    if code in (5, 7, 15, 1051):
        return 'VK отклонил доступ. Проверьте тип токена, разрешения и права администратора.'
    return 'VK не предоставил данные. Проверьте подключение и права.'


async def vk_overview(settings, days=30):
    group = config_value(settings, 'vk_group_id').lstrip('-')
    if not group.isdecimal() or int(group) <= 0:
        return {'status': 'not_connected', 'message': 'Укажите числовой ID сообщества ВКонтакте.'}
    try:
        token = read_secret(settings, 'vk_analytics_token', settings.integration_secrets_path / 'unused', 'VK analytics')
    except Exception:
        return {'status': 'not_connected', 'message': 'Добавьте отдельный пользовательский токен VK для аналитики в настройках интеграции.'}
    now = datetime.now(UTC)
    stop = int(now.timestamp())
    start, previous = stop - days * 86400, stop - days * 172800
    result = {'status': 'unavailable', 'updated_at': now.isoformat(), 'posts': [], 'posts_status': 'unavailable', 'stats_status': 'unavailable', 'stats': {}, 'charts': {}, 'posts_truncated': False}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            async def call(method, params):
                response = await client.post('https://api.vk.com/method/' + method, data={**params, 'access_token': token, 'v': '5.199'})
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict): return None, None
                if 'error' in body: return None, (body['error'] or {}).get('error_code')
                return body.get('response'), None

            profile, _ = await call('groups.getById', {'group_id': group, 'fields': 'members_count'})
            groups = profile.get('groups', []) if isinstance(profile, dict) else profile if isinstance(profile, list) else []
            if groups and isinstance(groups[0], dict):
                count = groups[0].get('members_count')
                result['followers'] = count if isinstance(count, int) and count >= 0 else None

            periods, errors = [], []
            for begin, end in ((start, stop), (previous, start)):
                data, error = await call('stats.get', {'group_id': group, 'timestamp_from': begin, 'timestamp_to': end, 'interval': 'all', 'extended': 1})
                periods.append(data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else {})
                errors.append(error)
            daily, _ = await call('stats.get', {'group_id': group, 'timestamp_from': start, 'timestamp_to': stop, 'interval': 'day', 'extended': 1})
            if any(periods):
                result['stats_status'] = 'ok' if all(periods) else 'limited'
                for label, section, key in [('reach', 'reach', 'reach'), ('visitors', 'visitors', 'visitors'), ('views', 'visitors', 'views'), ('subscribed', 'activity', 'subscribed'), ('unsubscribed', 'activity', 'unsubscribed'), ('likes', 'activity', 'likes'), ('comments', 'activity', 'comments'), ('reposts', 'activity', 'copies')]:
                    result['stats'][label] = {'current': _number(periods[0], section, key), 'previous': _number(periods[1], section, key)}
            if isinstance(daily, list):
                for label, section, key in [('reach', 'reach', 'reach'), ('visitors', 'visitors', 'visitors'), ('views', 'visitors', 'views')]:
                    points = []
                    for row in daily:
                        if not isinstance(row, dict): continue
                        at, value = row.get('period_from'), _number(row, section, key)
                        if isinstance(at, (int, float)) and value is not None: points.append({'time': int(at * 1000), 'value': value})
                    result['charts'][label] = sorted(points, key=lambda point: point['time'])
            else:
                result['charts_status'] = 'unavailable'

            post_error = None
            for offset in range(0, 300, 100):
                page, post_error = await call('wall.get', {'owner_id': '-' + group, 'count': 100, 'offset': offset})
                if not isinstance(page, dict) or not isinstance(page.get('items'), list): break
                result['posts_status'] = 'ok'
                items = page['items']
                for post in items:
                    if not isinstance(post, dict): continue
                    date = post.get('date')
                    if not isinstance(date, (int, float)) or date < start or date > stop: continue
                    result['posts'].append({'id': post.get('id'), 'text': post.get('text'), 'timestamp': date, 'views': (post.get('views') or {}).get('count'), 'likes': (post.get('likes') or {}).get('count'), 'comments': (post.get('comments') or {}).get('count'), 'reposts': (post.get('reposts') or {}).get('count')})
                dated = [x for x in items if isinstance(x, dict) and not x.get('is_pinned')]
                if len(items) < 100 or (dated and all(isinstance(x.get('date'), (int, float)) and x['date'] < start for x in dated)): break
                if offset == 200: result['posts_truncated'] = True
            if post_error is not None and result['posts_status'] == 'ok': result['posts_truncated'] = True
            if result['stats_status'] != 'unavailable' or result['posts_status'] == 'ok':
                result['status'] = 'ok' if result['stats_status'] == 'ok' and result['posts_status'] == 'ok' else 'limited'
            error = next((value for value in errors if value is not None), post_error)
            if result['stats_status'] == 'unavailable': result['message'] = _message(error)
            elif result['posts_status'] != 'ok': result['message'] = 'Статистика сообщества доступна, но VK не предоставил список публикаций.'
            return result
    except (httpx.HTTPError, ValueError, TypeError):
        return {'status': 'error', 'message': 'Не удалось получить статистику ВКонтакте. Повторите попытку позже.'}
