"""Publish MAX stories using the explicitly connected studio account."""
import asyncio
import base64
import json
import os
import tempfile
import threading
from pathlib import Path

from vita29.content.telegram_stories import _prepare_media, TelegramStoryNotPublishedError
from vita29.db.models import MediaType
from vita29.integrations.store import read_secret


class MaxStoryNotPublishedError(ValueError):
    """A failure confirmed to have happened before any story was sent."""


class MaxStoryUncertainError(RuntimeError):
    """The last request may have reached MAX or a series was partially sent."""


_session_lock = threading.Lock()


class _NoInteractiveLogin:
    async def get_code(self, _phone):
        raise MaxStoryNotPublishedError('Сессия MAX истекла. Подключите аккаунт заново.')

    async def get_password(self, hint=None):
        raise MaxStoryNotPublishedError('Сессия MAX истекла. Подключите аккаунт заново.')

    async def show_qr(self, _qr_url):
        raise MaxStoryNotPublishedError('Сессия MAX истекла. Подключите аккаунт заново.')


async def _send(db, settings, publication, files, prepared):
    from pymax import Client, ExtraConfig, Photo, Video, WebClient
    try:
        raw = read_secret(settings, 'max_story_session', settings.integration_secrets_path / 'unused', 'Аккаунт MAX')
        saved = json.loads(raw)
        session = base64.b64decode(saved['session'], validate=True)
        phone = saved['phone']
    except Exception as error:
        raise MaxStoryNotPublishedError('Подключите аккаунт студии MAX в настройках интеграции.') from error
    with tempfile.TemporaryDirectory(prefix='vita29-max-session-') as directory:
        path = Path(directory, 'session.db')
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(session)
        config = ExtraConfig(persist_session=True, telemetry=False, reconnect=False, relogin=False, log_level='CRITICAL')
        if saved.get('transport') == 'web':
            from pymax.auth.qr import QrAuthFlow
            client = WebClient(work_dir=directory, extra_config=config,
                               auth_flow=QrAuthFlow(_NoInteractiveLogin(), _NoInteractiveLogin()))
        else:
            client = Client(phone=phone, work_dir=directory, extra_config=config, sms_code_provider=_NoInteractiveLogin(), password_provider=_NoInteractiveLogin())
        confirmed = []
        sending = False
        try:
            await asyncio.wait_for(client.connect(), 45)
            if not client.me or str(client.me.contact.id) != saved['account_id']:
                raise MaxStoryNotPublishedError('Не удалось подтвердить подключённый аккаунт MAX.')
            for media, (path, duration) in zip(files, prepared, strict=True):
                payload = Photo(path=str(path)) if media.media_type == MediaType.IMAGE else Video(path=str(path))
                sending = True
                story = await asyncio.wait_for(client.send_story(payload, duration=round(duration * 1000) if duration else None), 180)
                confirmed.append(story.id)
                publication.external_id = json.dumps(confirmed)
                db.commit()
                sending = False
            return json.dumps(confirmed)
        except MaxStoryNotPublishedError:
            raise
        except Exception as error:
            if sending or confirmed:
                raise MaxStoryUncertainError('Проверьте MAX перед повтором: история могла быть опубликована.') from error
            raise MaxStoryNotPublishedError('Подключение к MAX не удалось. История не отправлена.') from error
        finally:
            await client.close()


def publish_max_stories(db, settings, publication, caption, files):
    if not 1 <= len(files) <= 10:
        raise MaxStoryNotPublishedError('Выберите от одного до десяти фото или видео для историй MAX.')
    try:
        with _session_lock, tempfile.TemporaryDirectory(prefix='vita29-max-story-') as directory:
            prepared = [_prepare_media(settings, media, Path(directory), index) for index, media in enumerate(files)]
            return asyncio.run(_send(db, settings, publication, files, prepared))
    except TelegramStoryNotPublishedError as error:
        raise MaxStoryNotPublishedError(str(error)) from error
