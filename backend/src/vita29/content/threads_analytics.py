"""Read-only Threads account and publication metrics."""
import asyncio
from datetime import UTC, datetime, timedelta

import httpx

from vita29.integrations.store import read_secret


async def threads_overview(settings, days=30):
    try:
        token = read_secret(settings, 'threads_access_token', settings.integration_secrets_path / 'unused', 'Threads')
    except Exception:
        return {'status': 'not_connected', 'message': 'Подключите токен Threads в настройках интеграции.'}
    now = datetime.now(UTC)
    end = int(now.timestamp())
    metrics = 'views,likes,replies,reposts,quotes'
    try:
        async with httpx.AsyncClient(base_url='https://graph.threads.net/v1.0', headers={'Authorization': f'Bearer {token}'}, timeout=15) as client:
            current, previous, follower, media, profile = await asyncio.gather(
                client.get('/me/threads_insights', params={'metric': metrics, 'since': end-days*86400, 'until': end}),
                client.get('/me/threads_insights', params={'metric': metrics, 'since': end-2*days*86400, 'until': end-days*86400}),
                client.get('/me/threads_insights', params={'metric': 'followers_count'}),
                client.get('/me/threads', params={'fields': 'id,text,timestamp,permalink,media_type', 'limit': 100}),
                client.get('/me', params={'fields': 'id,username'}),
            )
            if current.status_code != 200:
                return {'status': 'limited', 'message': 'Threads не предоставил статистику. Проверьте право threads_manage_insights у токена.'}

            def parse(response, start=None, end=None):
                if response.status_code != 200:
                    return {}, []
                values, points = {}, []
                for row in response.json().get('data', []):
                    name = row.get('name')
                    if name == 'views':
                        for point in row.get('values', []):
                            try:
                                ts = datetime.fromisoformat(point['end_time'].replace('Z', '+00:00'))
                                if (start is None or ts.timestamp() >= start) and (end is None or ts.timestamp() < end):
                                    points.append({'time': int(ts.timestamp() * 1000), 'value': point['value']})
                            except (KeyError, TypeError, ValueError):
                                continue
                        if points:
                            values[name] = sum(p['value'] for p in points)
                    else:
                        value = row.get('total_value', {}).get('value')
                        if isinstance(value, (int, float)):
                            values[name] = value
                return values, points

            cur, points = parse(current, end-days*86400, end)
            prev, prev_points = parse(previous, end-2*days*86400, end-days*86400)
            stats = {name: {'current': cur.get(name), 'previous': prev.get(name)} for name in metrics.split(',')}
            if len(points) < days - 1 or len(prev_points) < days - 1:
                stats['views']['previous'] = None
            follow, _ = parse(follower)
            posts, truncated = [], False
            if media.status_code == 200:
                payload = media.json()
                cutoff = now - timedelta(days=days)
                for post in payload.get('data', []):
                    try:
                        at = datetime.fromisoformat(post['timestamp'].replace('Z', '+00:00'))
                    except (ValueError, KeyError, TypeError):
                        continue
                    if at >= cutoff:
                        posts.append({key: post.get(key) for key in ('id', 'text', 'timestamp', 'permalink', 'media_type')})
                truncated = bool(payload.get('paging', {}).get('next')) or len(posts) > 10
                posts = posts[:10]
                async def details(post):
                    response = await client.get(f"/{post['id']}/insights", params={'metric': 'views,likes,replies,reposts,quotes,shares'})
                    if response.status_code == 200:
                        for row in response.json().get('data', []):
                            values = row.get('values', [])
                            if values and isinstance(values[0].get('value'), (int, float)):
                                post[row.get('name')] = values[0]['value']
                await asyncio.gather(*(details(post) for post in posts), return_exceptions=True)
            return {'status': 'ok', 'account': 'Threads', 'account_id': profile.json().get('id') if profile.status_code == 200 else None, 'updated_at': now.isoformat(), 'followers': follow.get('followers_count'), 'stats': stats, 'charts': {'views': points}, 'posts': posts, 'posts_truncated': truncated, 'posts_status': 'ok' if media.status_code == 200 else 'unavailable', 'views_partial': len(points) < days - 1}
    except Exception:
        return {'status': 'error', 'message': 'Не удалось получить статистику Threads. Повторите попытку позже.'}
