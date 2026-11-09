"""Short-lived, administrator-authorized Telegram QR login; no codes in logs."""
import asyncio
import base64
import io
import secrets
from typing import Annotated

import httpx
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from telethon import TelegramClient, errors, functions, types
from telethon.sessions import StringSession

from vita29.auth.dependencies import require_csrf, require_owner_or_administrator
from vita29.db.models import AuthSession, User
from vita29.integrations.store import config_value, read_secret, write_secret
from vita29.settings import Settings, get_settings

router = APIRouter(prefix='/integrations/telegram-story', tags=['integrations'])
_attempts: dict[str, dict] = {}


def telegram_credentials(settings: Settings) -> tuple[int, str, str, str]:
    api_id = config_value(settings, 'telegram_api_id')
    api_hash = read_secret(settings, 'telegram_api_hash', settings.integration_secrets_path / 'unused', 'Telegram API')
    bot = read_secret(settings, 'telegram_bot_token', settings.telegram_bot_token_file, 'Telegram bot')
    channel = config_value(settings, 'telegram_channel') or read_secret(settings, 'telegram_channel', settings.telegram_channel_file, 'Telegram channel')
    if not api_id.isdecimal() or not channel:
        raise ValueError('Не настроены Telegram API ID и канал')
    return int(api_id), api_hash, bot, channel


async def resolve_channel(client: TelegramClient, token: str, channel: str):
    async with httpx.AsyncClient(timeout=20) as http:
        response = await http.get(f'https://api.telegram.org/bot{token}/getChat', params={'chat_id': channel})
        data = response.json()
    if not data.get('ok') or data.get('result', {}).get('type') != 'channel':
        raise ValueError('Бот не видит указанный Telegram-канал')
    username = data['result'].get('username')
    if not username:
        raise ValueError('Для подключения пока необходим публичный адрес Telegram-канала')
    return await client.get_input_entity('@' + username)


def safe_state(attempt: dict) -> dict:
    return {key: attempt.get(key) for key in ('status', 'message', 'qr') if attempt.get(key) is not None}


async def finish_login(attempt: dict, client: TelegramClient, qr, bot: str, channel: str, settings: Settings):
    try:
        try:
            await qr.wait()
        except errors.SessionPasswordNeededError:
            attempt.update(status='password', qr=None, message='Введите пароль двухэтапной защиты Telegram.')
            password = await asyncio.wait_for(attempt['password'].get(), timeout=120)
            await client.sign_in(password=password)
        attempt.update(status='checking', qr=None, message='Проверяем права в канале…')
        peer = await resolve_channel(client, bot, channel)
        result = await client(functions.channels.GetParticipantRequest(channel=peer, participant=types.InputPeerSelf()))
        participant = result.participant
        if not isinstance(participant, types.ChannelParticipantCreator) and not (
            isinstance(participant, types.ChannelParticipantAdmin)
            and participant.admin_rights and participant.admin_rights.post_stories
        ):
            raise ValueError('У этого аккаунта нет права публиковать истории канала')
        await asyncio.to_thread(write_secret, settings, 'telegram_story_session', client.session.save())
        try:
            await client(functions.stories.CanSendStoryRequest(peer=peer))
            message = 'Аккаунт подключён; Telegram разрешает публикацию историй канала.'
        except errors.RPCError as error:
            if getattr(error, 'message', '') == 'BOOSTS_REQUIRED':
                message = 'Аккаунт подключён, но каналу пока не хватает бустов для историй.'
            else:
                message = 'Аккаунт подключён. Возможность публикации следует проверить отдельно.'
        attempt.update(status='connected', message=message)
    except asyncio.TimeoutError:
        attempt.update(status='expired', qr=None, message='Время входа истекло. Создайте новый QR-код.')
    except errors.PasswordHashInvalidError:
        attempt.update(status='error', qr=None, message='Неверный пароль двухэтапной защиты. Начните подключение снова.')
    except ValueError as error:
        attempt.update(status='error', qr=None, message=str(error))
    except Exception:
        attempt.update(status='error', qr=None, message='Не удалось подключить Telegram. Повторите попытку.')
    finally:
        await client.disconnect()


@router.post('/start')
async def start_login(response: Response, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    response.headers['Cache-Control'] = 'no-store'
    old = _attempts.pop(user.id, None)
    if old and old.get('task') and not old['task'].done():
        old['task'].cancel()
    try:
        api_id, api_hash, bot, channel = telegram_credentials(settings)
        client = TelegramClient(StringSession(), api_id, api_hash, timeout=10, connection_retries=1, retry_delay=1)
        await client.connect()
        qr = await client.qr_login()
        image = qrcode.make(qr.url)
        buffer = io.BytesIO(); image.save(buffer, format='PNG')
        attempt = {'id': secrets.token_urlsafe(24), 'status': 'waiting', 'qr': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode(), 'password': asyncio.Queue(maxsize=1)}
        _attempts[user.id] = attempt
        attempt['task'] = asyncio.create_task(finish_login(attempt, client, qr, bot, channel, settings))
        await asyncio.sleep(0)
        return {'attempt_id': attempt['id'], **safe_state(attempt)}
    except Exception:
        if 'client' in locals(): await client.disconnect()
        raise HTTPException(status_code=400, detail='Не удалось начать вход. Проверьте Telegram API ID, API hash и связь с Telegram.')


@router.get('/status/{attempt_id}')
async def login_status(attempt_id: str, response: Response, user: Annotated[User, Depends(require_owner_or_administrator)]):
    response.headers['Cache-Control'] = 'no-store'
    attempt = _attempts.get(user.id)
    if not attempt or not secrets.compare_digest(attempt['id'], attempt_id): raise HTTPException(status_code=404, detail='Подключение не найдено')
    return safe_state(attempt)


class PasswordRequest(BaseModel):
    password: str = Field(min_length=1, max_length=256, repr=False)


@router.post('/password/{attempt_id}')
async def login_password(attempt_id: str, payload: PasswordRequest, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)]):
    attempt = _attempts.get(user.id)
    if not attempt or not secrets.compare_digest(attempt['id'], attempt_id) or attempt['status'] != 'password': raise HTTPException(status_code=409, detail='Вход не ожидает пароль')
    attempt['status'] = 'checking'
    attempt['password'].put_nowait(payload.password)
    return {'status': 'checking'}


@router.post('/disconnect')
async def disconnect(auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(require_owner_or_administrator)], settings: Annotated[Settings, Depends(get_settings)]):
    # Removing the server copy does not revoke the Telegram session remotely;
    # the account owner can also terminate it in Telegram's Devices settings.
    for attempt in _attempts.values():
        if attempt.get('task') and not attempt['task'].done(): attempt['task'].cancel()
    _attempts.clear()
    write_secret(settings, 'telegram_story_session', '')
    return {'status': 'disconnected'}
