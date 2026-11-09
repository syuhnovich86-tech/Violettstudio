"""Channel stories sent through the explicitly connected administrator account."""
import asyncio
import hashlib
import json
import subprocess
import tempfile
import threading
from pathlib import Path

from PIL import Image, ImageOps, ImageFilter
from telethon import TelegramClient, errors, functions, types
from telethon.sessions import StringSession

from vita29.api.telegram_story_login import resolve_channel, telegram_credentials
from vita29.db.models import MediaType
from vita29.integrations.store import read_secret
from vita29.media.storage import original_path


class TelegramStoryNotPublishedError(ValueError):
    """A failure known to have occurred before any story was posted."""


class TelegramStoryUncertainError(RuntimeError):
    """A send may have succeeded or some stories were already confirmed."""


_session_lock = threading.Lock()
MAX_BYTES = 30 * 1024 * 1024


def _prepare_media(settings, media, directory: Path, index: int):
    source = original_path(settings, media.storage_key)
    if not source.is_file():
        raise TelegramStoryNotPublishedError('Исходный файл для истории недоступен')
    if media.media_type == MediaType.IMAGE:
        target = directory / f'{index}.jpg'
        try:
            with Image.open(source) as image:
                image = ImageOps.exif_transpose(image).convert('RGB')
                target_size = (1080, 1920)
                if abs(image.width / image.height - 9 / 16) < 0.01:
                    canvas = ImageOps.fit(image, target_size, Image.Resampling.LANCZOS)
                else:
                    canvas = ImageOps.fit(image, target_size, Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(36))
                    foreground = ImageOps.contain(image, target_size, Image.Resampling.LANCZOS)
                    canvas.paste(foreground, ((1080 - foreground.width) // 2, (1920 - foreground.height) // 2))
                canvas.save(target, 'JPEG', quality=90, optimize=True)
        except (OSError, ValueError) as error:
            raise TelegramStoryNotPublishedError('Не удалось подготовить фото для истории') from error
        return target, 0.0
    if media.media_type != MediaType.VIDEO:
        raise TelegramStoryNotPublishedError('Для истории нужно фото или видео')
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(source)], capture_output=True, text=True, timeout=30, check=True)
        duration = float(probe.stdout.strip())
        if not 0 < duration <= 60:
            raise TelegramStoryNotPublishedError('Видео для истории должно быть не длиннее 60 секунд')
        target = directory / f'{index}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(source), '-filter_complex', '[0:v]split[bg][fg];[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:10[back];[fg]scale=720:1280:force_original_aspect_ratio=decrease[front];[back][front]overlay=(W-w)/2:(H-h)/2,setsar=1[v]', '-map', '[v]', '-map', '0:a?', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '6000k', '-g', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', str(target)], capture_output=True, timeout=300, check=True)
        if target.stat().st_size > MAX_BYTES:
            raise TelegramStoryNotPublishedError('Подготовленное видео превышает лимит Telegram 30 МБ')
        return target, duration
    except TelegramStoryNotPublishedError:
        raise
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise TelegramStoryNotPublishedError('Не удалось подготовить видео для истории') from error


async def _send(db, settings, publication, caption, files, prepared):
    try:
        api_id, api_hash, bot, channel = telegram_credentials(settings)
        session = read_secret(settings, 'telegram_story_session', settings.integration_secrets_path / 'unused', 'Аккаунт Telegram для историй')
    except Exception as error:
        raise TelegramStoryNotPublishedError('Подключите аккаунт администратора Telegram в настройках интеграции') from error
    client = TelegramClient(StringSession(session), api_id, api_hash, timeout=15, connection_retries=1, retry_delay=1)
    confirmed = []
    sending = False
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise TelegramStoryNotPublishedError('Сессия Telegram истекла. Подключите аккаунт заново.')
        peer = await resolve_channel(client, bot, channel)
        await client(functions.stories.CanSendStoryRequest(peer=peer))
        uploads = [await client.upload_file(str(path)) for path, _ in prepared]
        for index, ((path, duration), uploaded, media) in enumerate(zip(prepared, uploads, files, strict=True)):
            if media.media_type == MediaType.IMAGE:
                payload = types.InputMediaUploadedPhoto(file=uploaded)
            else:
                payload = types.InputMediaUploadedDocument(file=uploaded, mime_type='video/mp4', attributes=[types.DocumentAttributeVideo(duration=duration, w=720, h=1280, supports_streaming=True)])
            random_id = int.from_bytes(hashlib.sha256(f'{publication.id}:{index}'.encode()).digest()[:8], 'big', signed=True)
            sending = True
            response = await client(functions.stories.SendStoryRequest(peer=peer, media=payload, privacy_rules=[types.InputPrivacyValueAllowAll()], caption=caption if index == 0 else None, random_id=random_id, period=86400))
            story_id = next((entry.id for entry in getattr(response, 'updates', []) if isinstance(entry, types.UpdateStoryID) and entry.random_id == random_id), None)
            if story_id is None:
                raise TelegramStoryUncertainError('Telegram не подтвердил номер истории. Проверьте канал перед повтором.')
            confirmed.append(story_id)
            publication.external_id = json.dumps(confirmed)
            db.commit()
            sending = False
        return json.dumps(confirmed)
    except TelegramStoryNotPublishedError:
        raise
    except errors.RPCError as error:
        name = getattr(error, 'message', '')
        messages = {'BOOSTS_REQUIRED': 'Каналу не хватает бустов для публикации историй.', 'CHAT_ADMIN_REQUIRED': 'У подключённого аккаунта нет права публиковать истории канала.', 'STORIES_TOO_MUCH': 'Достигнут лимит активных историй канала.', 'PREMIUM_ACCOUNT_REQUIRED': 'Telegram требует Premium для этого действия.'}
        if not confirmed:
            raise TelegramStoryNotPublishedError(messages.get(name, 'Telegram отклонил историю. Проверьте права и формат файла.')) from error
        raise TelegramStoryUncertainError('Часть историй уже размещена. Проверьте канал перед повтором.') from error
    except Exception as error:
        if confirmed or sending:
            raise TelegramStoryUncertainError('Результат отправки истории неизвестен. Проверьте канал перед повтором.') from error
        raise TelegramStoryNotPublishedError('Не удалось подготовить подключение к Telegram. История не отправлена.') from error
    finally:
        await client.disconnect()


def publish_telegram_stories(db, settings, publication, caption, files):
    if not 1 <= len(files) <= 10:
        raise TelegramStoryNotPublishedError('Выберите от одного до десяти фото или видео для историй')
    with _session_lock, tempfile.TemporaryDirectory(prefix='vita29-telegram-story-') as directory:
        prepared = [_prepare_media(settings, media, Path(directory), index) for index, media in enumerate(files)]
        return asyncio.run(_send(db, settings, publication, caption, files, prepared))
