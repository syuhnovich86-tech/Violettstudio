"""Read-only analytics for studio administrators."""
import asyncio
import json
import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field

from fastapi import APIRouter, Depends, Response, HTTPException, Query
import httpx
from telethon import TelegramClient, functions, types
from telethon.sessions import StringSession
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.api.telegram_story_login import resolve_channel, telegram_credentials
from vita29.auth.dependencies import get_current_user, require_csrf
from vita29.db.models import AnalyticsNote, AuthSession, User, UserRole
from vita29.db.session import get_db
from vita29.integrations.store import config_value, read_secret
from vita29.content.max_publisher import max_ssl_context
from vita29.content.vk_analytics import vk_overview as vk_live_overview
from vita29.content.threads_analytics import threads_overview
from vita29.content.agent import _openai_post, _response_text, read_openai_secret
from vita29.settings import Settings, get_settings

router = APIRouter(prefix='/content/analytics', tags=['content-analytics'])


def require_analytics(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role not in (UserRole.OWNER, UserRole.ADMIN) and not user.can_access_analytics:
        raise HTTPException(status_code=403, detail='Нет доступа к аналитике')
    return user


_vk_bridge_codes = {}


class VKBridgePair(BaseModel):
    current: float | None = Field(default=None, ge=0, le=100000000000)
    previous: float | None = Field(default=None, ge=0, le=100000000000)
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


async def vk_overview(settings, days=30):
    live = await vk_live_overview(settings, days)
    if live.get('stats_status') in ('ok', 'limited'):
        return live
    from vita29.content.vk_snapshots import read
    from vita29.db.session import SessionLocal
    try:
        with SessionLocal() as db:
            saved = read(db, config_value(settings, 'vk_group_id').lstrip('-'), days)
    except Exception:
        saved = None
    if not saved:
        return live
    if live.get('posts_status') == 'ok':
        saved['posts'] = live.get('posts', [])
        saved['posts_status'] = 'ok'
        saved['posts_truncated'] = live.get('posts_truncated', False)
    return saved


class VKBridgeDay(BaseModel):
    time: int = Field(ge=946684800, le=4102444800)
    reach: float | None = Field(default=None, ge=0, le=100000000000)
    visitors: float | None = Field(default=None, ge=0, le=100000000000)
    views: float | None = Field(default=None, ge=0, le=100000000000)
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class VKBridgeImport(BaseModel):
    code: str = Field(min_length=20, max_length=100, repr=False)
    group: str = Field(min_length=1, max_length=32)
    followers: int | None = Field(default=None, ge=0, le=10000000000)
    periods: dict[str, dict[str, VKBridgePair]]
    daily: list[VKBridgeDay] = Field(max_length=200)
    model_config = ConfigDict(extra='forbid')


@router.post('/vk-bridge/start')
def start_vk_bridge(_: Annotated[AuthSession, Depends(require_csrf)],
                    user: Annotated[User, Depends(require_analytics)],
                    settings: Annotated[Settings, Depends(get_settings)]):
    group = config_value(settings, 'vk_group_id').lstrip('-')
    if not group.isdecimal():
        raise HTTPException(400, 'Не настроен ID сообщества VK')
    now = time.monotonic()
    for key in list(_vk_bridge_codes):
        if _vk_bridge_codes[key]['expires'] < now:
            del _vk_bridge_codes[key]
    if len(_vk_bridge_codes) >= 100:
        raise HTTPException(429, 'Слишком много попыток')
    code = secrets.token_urlsafe(24)
    _vk_bridge_codes[code] = {'group': group, 'expires': now + 600, 'user': user.id}
    return {'code': code, 'group': group, 'expires_in': 600}


@router.post('/vk-bridge/import')
def import_vk_bridge(payload: VKBridgeImport, db: Annotated[Session, Depends(get_db)]):
    attempt = _vk_bridge_codes.pop(payload.code, None)
    if not attempt or attempt['expires'] < time.monotonic() or attempt['group'] != payload.group:
        raise HTTPException(403, 'Код недействителен, истёк или относится к другому сообществу')
    allowed = {'reach', 'visitors', 'views', 'subscribed', 'unsubscribed', 'likes', 'comments', 'reposts'}
    if set(payload.periods) != {'7', '30', '90'} or any(not set(row).issubset(allowed) for row in payload.periods.values()):
        raise HTTPException(400, 'Неверные показатели')
    from vita29.content.vk_snapshots import save
    data = payload.model_dump(exclude={'code', 'group'})
    return {'saved_at': save(db, payload.group, data)}


async def instagram_overview(settings: Settings, days: int = 30) -> dict:
    try:
        account = config_value(settings, 'instagram_account_id')
        try:
            token = read_secret(settings, 'instagram_analytics_access_token', settings.integration_secrets_path / 'unused', 'Instagram analytics')
        except Exception:
            token = read_secret(settings, 'instagram_access_token', settings.integration_secrets_path / 'unused', 'Instagram')
        if not account or not account.isdecimal():
            return {'status': 'not_connected', 'message': 'Укажите ID Instagram в настройках интеграции.'}
    except Exception:
        return {'status': 'not_connected', 'message': 'Подключите Instagram в настройках интеграции.'}
    try:
        async with httpx.AsyncClient(base_url='https://graph.facebook.com/v22.0', timeout=15, headers={'Authorization': f'Bearer {token}'}) as client:
            profile = await client.get(f'/{account}', params={'fields': 'id,username,followers_count'})
            if profile.status_code != 200:
                return {'status': 'error', 'message': 'Не удалось получить данные Instagram. Проверьте подключение.'}
            data = profile.json()
            media = []
            earliest = datetime.now(UTC) - timedelta(days=days)
            cursor = None
            media_truncated = False
            for page_number in range(5):
                params = {'fields': 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url', 'limit': 100}
                if cursor:
                    params['after'] = cursor
                media_response = await client.get(f'/{account}/media', params=params)
                if media_response.status_code != 200:
                    media_truncated = True
                    break
                payload = media_response.json()
                page_items = payload.get('data', [])
                reached_earliest = False
                for item in page_items:
                    try:
                        published = datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00'))
                    except (KeyError, ValueError, TypeError):
                        continue
                    if published >= earliest:
                        media.append({key: item.get(key) for key in ('id', 'caption', 'media_type', 'media_product_type', 'timestamp', 'like_count', 'comments_count', 'permalink', 'thumbnail_url', 'media_url')})
                    else:
                        reached_earliest = True
                cursor = (payload.get('paging') or {}).get('cursors', {}).get('after') if (payload.get('paging') or {}).get('next') else None
                if not cursor or reached_earliest:
                    break
                if page_number == 4:
                    media_truncated = True
            end = int(datetime.now(UTC).timestamp())
            ranges = []
            while len(ranges) * 29 < days * 2:
                offset = len(ranges) * 29
                ranges.append((end - min(days * 2, offset + 29) * 86400, end - offset * 86400))
            responses = await asyncio.gather(*(client.get(f'/{account}/insights', params={'metric': 'reach', 'period': 'day', 'since': start, 'until': stop}) for start, stop in ranges))
            insight = responses[0]
            if insight.status_code != 200:
                return {'status': 'limited', 'updated_at': datetime.now(UTC).isoformat(), 'followers': data.get('followers_count'), 'media': media, 'message': 'Охват недоступен: Meta не предоставила маркеру право на статистику.'}
            points = {}
            for result in responses:
                if result.status_code != 200:
                    continue
                for metric in result.json().get('data', []):
                    for point in metric.get('values', []):
                        if point.get('end_time') and isinstance(point.get('value'), (int, float)):
                            points[point['end_time']] = point['value']
            stories_response = await client.get(f'/{account}/stories', params={'fields': 'id,media_type,timestamp,thumbnail_url,media_url', 'limit': 10})
            stories = []
            if stories_response.status_code == 200:
                stories = [{key: item.get(key) for key in ('id', 'media_type', 'timestamp', 'thumbnail_url', 'media_url')} for item in stories_response.json().get('data', [])]
            limiter = asyncio.Semaphore(6)
            async def add_insights(item: dict, metrics: str):
                if not item.get('id'):
                    return
                try:
                    async with limiter:
                        result = await client.get(f"/{item['id']}/insights", params={'metric': metrics})
                except httpx.HTTPError:
                    item['insights_status'] = 'unavailable'
                    return
                if result.status_code != 200:
                    item['insights_status'] = 'unavailable'
                    return
                values = {}
                for entry in result.json().get('data', []):
                    points = entry.get('values') or []
                    value = points[-1].get('value') if points else (entry.get('total_value') or {}).get('value')
                    if isinstance(value, (float, int)) and not isinstance(value, bool):
                        values[entry.get('name')] = value
                item['insights'] = values
            await asyncio.gather(
                *(add_insights(item, 'views,reach,saved,shares,total_interactions') for item in media[:40]),
                *(add_insights(item, 'views,reach,replies,shares,total_interactions') for item in stories),
            )
            try:
                from vita29.content.instagram_history import merge_instagram_media
                from vita29.db.session import SessionLocal
                with SessionLocal() as db:
                    media = merge_instagram_media(db, account, media, days)
            except Exception:
                import logging
                logging.getLogger(__name__).exception('Instagram media history unavailable')
            return {'status': 'ok', 'updated_at': datetime.now(UTC).isoformat(), 'followers': data.get('followers_count'), 'media': media, 'media_truncated': media_truncated, 'media_insights_truncated': len(media) > 40, 'stories': stories, 'stories_status': 'ok' if stories_response.status_code == 200 else 'unavailable', 'reach': [{'values': [{'end_time': key, 'value': value} for key, value in sorted(points.items())]}], 'reach_partial': any(result.status_code != 200 for result in responses)}
    except (httpx.HTTPError, ValueError):
        return {'status': 'error', 'message': 'Не удалось получить данные Instagram. Повторите попытку позже.'}


async def max_overview(settings: Settings) -> dict:
    try:
        token = read_secret(settings, 'max_bot_token', settings.integration_secrets_path / 'unused', 'MAX')
        channel = config_value(settings, 'max_channel_id')
        if not channel:
            return {'status': 'not_connected', 'message': 'Не указан канал MAX.'}
    except Exception:
        return {'status': 'not_connected', 'message': 'Подключите MAX в настройках интеграции.'}
    try:
        async with httpx.AsyncClient(base_url='https://platform-api2.max.ru', verify=max_ssl_context(), timeout=15, headers={'Authorization': token}) as client:
            response, chat_response = await asyncio.gather(client.get('/messages', params={'chat_id': channel, 'count': 20}), client.get(f'/chats/{channel}'))
            response.raise_for_status()
            posts = []
            for post in response.json().get('messages', []):
                body = post.get('body') or {}
                posts.append({'id': body.get('mid'), 'text': body.get('text'), 'timestamp': post.get('timestamp'), 'views': (post.get('stat') or {}).get('views')})
            return {'status': 'ok', 'updated_at': datetime.now(UTC).isoformat(), 'posts': posts, 'followers': chat_response.json().get('participants_count') if chat_response.status_code == 200 else None}
    except (httpx.HTTPError, ValueError):
        return {'status': 'error', 'message': 'Не удалось получить статистику MAX. Проверьте права бота.'}


async def _legacy_vk_overview(settings: Settings) -> dict:
    try:
        token = read_secret(settings, 'vk_user_token', settings.integration_secrets_path / 'unused', 'VK')
        group = config_value(settings, 'vk_group_id').lstrip('-')
        if not group.isdecimal():
            return {'status': 'not_connected', 'message': 'Не указан ID сообщества ВКонтакте.'}
    except Exception:
        return {'status': 'not_connected', 'message': 'Подключите ВКонтакте в настройках интеграции.'}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post('https://api.vk.com/method/wall.get', data={'access_token': token, 'v': '5.199', 'owner_id': '-' + group, 'count': 20})
            response.raise_for_status()
            body = response.json()
            if 'error' in body:
                return {'status': 'unavailable', 'message': 'ВКонтакте отклонил запрос. Проверьте права токена и доступ к сообществу.'}
            posts = []
            for post in body.get('response', {}).get('items', []):
                posts.append({'id': post.get('id'), 'text': post.get('text'), 'timestamp': post.get('date'), 'views': post.get('views', {}).get('count'), 'likes': post.get('likes', {}).get('count'), 'comments': post.get('comments', {}).get('count'), 'reposts': post.get('reposts', {}).get('count')})
            return {'status': 'ok', 'updated_at': datetime.now(UTC).isoformat(), 'posts': posts}
    except (httpx.HTTPError, ValueError):
        return {'status': 'error', 'message': 'Не удалось получить статистику ВКонтакте.'}


async def telegram_overview(settings: Settings, days: int = 30) -> dict:
    try:
        api_id, api_hash, bot, channel = telegram_credentials(settings)
        session = read_secret(settings, 'telegram_story_session', settings.integration_secrets_path / 'unused', 'Telegram')
    except Exception:
        return {'status': 'not_connected', 'message': 'Подключите аккаунт администратора Telegram в настройках интеграции.'}
    try:
        async with TelegramClient(StringSession(session), api_id, api_hash, timeout=10, connection_retries=1, retry_delay=1) as client:
            if not await client.is_user_authorized():
                return {'status': 'not_connected', 'message': 'Подключите аккаунт администратора Telegram заново.'}
            peer = await resolve_channel(client, bot, channel)
            full = await client(functions.channels.GetFullChannelRequest(peer))
            if not full.full_chat.can_view_stats:
                return {'status': 'unavailable', 'message': 'Telegram пока не предоставляет статистику этого канала подключённому аккаунту.'}
            stats = await client(functions.stats.GetBroadcastStatsRequest(channel=peer))
            charts = {}
            cutoff = int((datetime.now(UTC) - timedelta(days=days * 2)).timestamp() * 1000)
            for key, attribute in [('followers', 'growth_graph'), ('post_views', 'interactions_graph'), ('story_views', 'story_interactions_graph')]:
                graph = getattr(stats, attribute, None)
                try:
                    if isinstance(graph, types.StatsGraphAsync):
                        graph = await client(functions.stats.LoadAsyncGraphRequest(token=graph.token))
                    if not isinstance(graph, types.StatsGraph):
                        continue
                    raw = json.loads(graph.json.data)
                    columns = {col[0]: col[1:] for col in raw.get('columns', []) if col}
                    x = next((name for name, kind in raw.get('types', {}).items() if kind == 'x'), None)
                    y = next((name for name, kind in raw.get('types', {}).items() if kind != 'x'), None)
                    if x in columns and y in columns:
                        charts[key] = [{'time': at, 'value': value} for at, value in zip(columns[x], columns[y]) if isinstance(at, (int, float)) and isinstance(value, (int, float)) and at >= cutoff]
                except Exception:
                    continue
            def value(name):
                obj = getattr(stats, name, None)
                return None if obj is None else {'current': obj.current, 'previous': obj.previous}
            return {
                'status': 'ok', 'updated_at': datetime.now(UTC).isoformat(),
                'period_start': stats.period.min_date.isoformat(), 'period_end': stats.period.max_date.isoformat(),
                'followers': value('followers'), 'views_per_post': value('views_per_post'),
                'shares_per_post': value('shares_per_post'), 'reactions_per_post': value('reactions_per_post'),
                'views_per_story': value('views_per_story'), 'shares_per_story': value('shares_per_story'),
                'reactions_per_story': value('reactions_per_story'),
                'charts': charts,
            }
    except Exception:
        return {'status': 'error', 'message': 'Не удалось получить статистику Telegram. Повторите попытку позже.'}


@router.get('/overview')
async def overview(response: Response, _: Annotated[User, Depends(require_analytics)], settings: Annotated[Settings, Depends(get_settings)], days: int = Query(default=30, ge=7, le=90)):
    response.headers['Cache-Control'] = 'no-store'
    telegram, instagram, max_data, vk, threads = await asyncio.gather(telegram_overview(settings, days), instagram_overview(settings, days), max_overview(settings), vk_overview(settings, days), threads_overview(settings, days))
    data = {'telegram': telegram, 'instagram': instagram, 'max': max_data, 'vk': vk, 'threads': threads}
    from vita29.content.follower_history import record_and_compare
    from vita29.db.session import SessionLocal
    try:
        await asyncio.to_thread(record_and_compare, SessionLocal, settings, data, days)
    except Exception:
        import logging
        logging.getLogger(__name__).exception('Follower history unavailable')
    return data


def _analysis_input(platform: str, data: dict, days: int) -> dict:
    """Use aggregates and public caption excerpts, never account tokens or image bytes."""
    def clean(value):
        text = str(value or '')[:300]
        text = re.sub(r'https?://\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d\s()\-]{8,}\d', '[скрыто]', text)
        return text
    result = {'platform': platform, 'days': days, 'status': data.get('status')}
    if platform == 'telegram':
        result.update({key: data.get(key) for key in ('followers', 'period_start', 'period_end', 'charts')})
    elif platform == 'instagram':
        result.update({'followers': data.get('followers'), 'reach': data.get('reach'), 'reach_partial': data.get('reach_partial'), 'media_truncated': data.get('media_truncated')})
        result['media'] = [{'format': p.get('media_product_type'), 'timestamp': p.get('timestamp'), 'caption': clean(p.get('caption')), 'insights': p.get('insights'), 'likes': p.get('like_count'), 'comments': p.get('comments_count')} for p in data.get('media', [])[:20]]
        result['active_stories'] = [{'timestamp': p.get('timestamp'), 'insights': p.get('insights')} for p in data.get('stories', [])[:10]]
    else:
        if platform in ('vk', 'threads'):
            result.update({'stats': data.get('stats'), 'stats_status': data.get('stats_status'), 'posts_truncated': data.get('posts_truncated')})
        result['posts'] = [{'text': clean(p.get('text')), 'timestamp': p.get('timestamp'), 'views': p.get('views'), 'likes': p.get('likes')} for p in data.get('posts', [])[:20]]
    return result


@router.post('/recommendations')
async def recommendations(user: Annotated[User, Depends(require_analytics)], __: Annotated[AuthSession, Depends(require_csrf)], settings: Annotated[Settings, Depends(get_settings)], db: Annotated[Session, Depends(get_db)], platform: Literal['telegram', 'instagram', 'max', 'vk', 'threads'] = 'instagram', days: int = Query(default=30, ge=7, le=90)):
    if platform == 'telegram':
        data = await telegram_overview(settings, days)
    elif platform == 'instagram':
        data = await instagram_overview(settings, days)
    elif platform == 'max':
        data = await max_overview(settings)
    elif platform == 'threads':
        data = await threads_overview(settings, days)
    else:
        data = await vk_overview(settings, days)
    if data.get('status') not in ('ok', 'limited'):
        raise HTTPException(status_code=400, detail='Нет доступной статистики для анализа этой площадки.')
    context = _analysis_input(platform, data, days)
    schema = {'type': 'object', 'additionalProperties': False, 'properties': {'summary': {'type': 'string'}, 'evidence': {'type': 'array', 'items': {'type': 'string'}}, 'ideas': {'type': 'array', 'items': {'type': 'string'}}, 'limitations': {'type': 'string'}}, 'required': ['summary', 'evidence', 'ideas', 'limitations']}
    prompt = ('Ты аналитик контента студии эстетики VIOLETTA. Проанализируй только предоставленные агрегированные данные и подписи публичных постов. '
              'Дай полезные идеи следующих публикаций и форматов. Не выдумывай просмотры, охваты, тренды или причинно-следственные связи. '
              'Отделяй факты от гипотез, учитывай разный возраст публикаций, малую выборку и отсутствие данных. '
              'Не сравнивай сумму дневного охвата с числом уникальных людей за период. Не предлагай автоматическую публикацию. '
              'Ответ на русском языке: краткий вывод, не более трёх проверяемых фактов, не более четырёх конкретных идей и ограничение данных.\n'
              + json.dumps(context, ensure_ascii=False, default=str))
    try:
        model = config_value(settings, 'openai_analytics_model', 'gpt-6-astra')
        payload = {'model': model, 'input': prompt, 'reasoning': {'effort': 'low'}, 'max_output_tokens': 1200, 'text': {'format': {'type': 'json_schema', 'name': 'content_analysis', 'strict': True, 'schema': schema}}}
        result = await asyncio.to_thread(_openai_post, 'https://api.openai.com/v1/responses', api_key=read_openai_secret(settings), payload=payload, timeout=settings.openai_http_timeout_seconds)
        result.raise_for_status()
        parsed = json.loads(_response_text(result.json()))
        result = {'platform': platform, 'days': days, 'model': model, 'summary': str(parsed['summary'])[:2000], 'evidence': [str(x)[:500] for x in parsed['evidence'][:3]], 'ideas': [str(x)[:500] for x in parsed['ideas'][:4]], 'limitations': str(parsed['limitations'])[:1000]}
        note = AnalyticsNote(author_id=user.id, platform=platform, days=days, result_json=json.dumps(result, ensure_ascii=False))
        db.add(note)
        db.commit()
        db.refresh(note)
        return {**result, 'id': note.id, 'created_at': note.created_at.replace(tzinfo=UTC).isoformat()}
    except Exception:
        db.rollback()
        raise HTTPException(status_code=502, detail='Не удалось получить рекомендации OpenAI. Попробуйте позже.')


@router.get('/notes')
def analytics_notes(response: Response, _: Annotated[User, Depends(require_analytics)], db: Annotated[Session, Depends(get_db)], offset: int = Query(default=0, ge=0), limit: int = Query(default=30, ge=1, le=100)):
    response.headers['Cache-Control'] = 'no-store'
    notes = db.scalars(select(AnalyticsNote).order_by(AnalyticsNote.id.desc()).offset(offset).limit(limit + 1)).all()
    return {'items': [{**json.loads(note.result_json), 'id': note.id, 'created_at': note.created_at.replace(tzinfo=UTC).isoformat()} for note in notes[:limit]], 'next_offset': offset + limit if len(notes) > limit else None}
