"""Private transport boundary for the WhatsApp status companion service.

The companion is deliberately reached through a local Unix socket, never a
public HTTP port. A timeout after submission must be treated as uncertain.
"""
from pathlib import Path
import base64
import json
import tempfile
import threading

import httpx

from vita29.content.telegram_stories import _prepare_media, TelegramStoryNotPublishedError
from vita29.db.models import MediaType

_send_lock = threading.Lock()


class WhatsAppNotPublishedError(ValueError):
    """The service rejected a request before attempting publication."""


class WhatsAppUncertainError(RuntimeError):
    """The service could have sent the status; do not retry automatically."""


class WhatsAppBridge:
    def __init__(self, socket_path: Path, timeout: float = 90):
        self.socket_path = socket_path
        self.timeout = timeout

    def request(self, method: str, path: str, *, json: dict | None = None) -> dict:
        if path not in {'/status', '/pair', '/publish', '/confirm-not-sent'}:
            raise ValueError('Invalid WhatsApp bridge operation')
        transport = httpx.HTTPTransport(uds=str(self.socket_path), retries=0)
        try:
            with httpx.Client(transport=transport, base_url='http://whatsapp-bridge', timeout=self.timeout) as client:
                response = client.request(method, path, json=json)
                result = response.json()
        except (httpx.HTTPError, ValueError) as error:
            if path == '/publish':
                raise WhatsAppUncertainError('Не удалось подтвердить публикацию. Проверьте WhatsApp перед повтором.') from error
            raise WhatsAppNotPublishedError('Сервис WhatsApp недоступен') from error
        if not isinstance(result, dict):
            raise WhatsAppUncertainError('Некорректный ответ WhatsApp; проверьте статус перед повтором.')
        if response.is_error:
            if result.get('outcome') == 'not_sent':
                raise WhatsAppNotPublishedError(str(result.get('message') or 'WhatsApp не принял запрос')[:200])
            raise WhatsAppUncertainError('Не удалось подтвердить публикацию. Проверьте WhatsApp перед повтором.')
        return result


def publish_whatsapp_stories(db, settings, publication, caption, files):
    if not 1 <= len(files) <= 10:
        raise WhatsAppNotPublishedError('Выберите от одного до десяти файлов для статусов WhatsApp')
    confirmed = []
    socket = settings.integration_secrets_path.parent / 'whatsapp' / 'bridge.sock'
    with _send_lock, tempfile.TemporaryDirectory(prefix='vita29-whatsapp-status-') as directory:
        try:
            prepared = [_prepare_media(settings, media, Path(directory), index) for index, media in enumerate(files)]
        except TelegramStoryNotPublishedError as error:
            raise WhatsAppNotPublishedError(str(error)) from error
        client = WhatsAppBridge(socket, timeout=360)
        for index, ((path, _), media) in enumerate(zip(prepared, files, strict=True)):
            try:
                data = base64.b64encode(path.read_bytes()).decode('ascii')
                result = client.request('POST', '/publish', json={
                    'id': f'{publication.id}:{index}',
                    'mime': 'image/jpeg' if media.media_type == MediaType.IMAGE else 'video/mp4',
                    'data': data,
                    'caption': caption if index == 0 else '',
                })
            except WhatsAppNotPublishedError as error:
                if confirmed:
                    raise WhatsAppUncertainError('Часть статусов отправлена. Проверьте WhatsApp перед повтором.') from error
                raise
            if result.get('outcome') != 'sent' or not result.get('id'):
                raise WhatsAppUncertainError('WhatsApp не подтвердил статус. Проверьте его перед повтором.')
            confirmed.append(result['id'])
            publication.external_id = json.dumps(confirmed)
            db.commit()
    return json.dumps(confirmed)
