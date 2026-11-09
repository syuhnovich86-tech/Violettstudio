"""MAX bot publishing for explicitly approved posts."""
from urllib.parse import urlparse
from pathlib import Path
import ssl

import certifi
import httpx

from vita29.db.models import MediaType
from vita29.integrations.store import config_value, read_secret
from vita29.media.storage import original_path


def max_ssl_context() -> ssl.SSLContext:
    """Trust the official MAX CA only for requests made by this publisher."""
    context = ssl.create_default_context(cafile=certifi.where())
    context.load_verify_locations(cafile=str(Path(__file__).with_name('russian-trusted-root.crt')))
    return context


def publish_to_max(settings, caption, media_files):
    token = read_secret(settings, "max_bot_token", settings.integration_secrets_path / "unused", "MAX bot token")
    channel = config_value(settings, "max_channel_id")
    if not channel:
        raise ValueError("Не указан канал MAX")
    attachments = []
    tls = max_ssl_context()
    headers = {"Authorization": token}
    for media in media_files:
        kind = "image" if media.media_type == MediaType.IMAGE else "video"
        size_limit = 50 * 1024 * 1024 if kind == "image" else 250 * 1024 * 1024
        if media.size_bytes > size_limit:
            raise ValueError("Файл превышает допустимый размер MAX")
        path = original_path(settings, media.storage_key)
        if not path.is_file():
            raise ValueError("Выбранный файл больше не доступен")
        response = httpx.post("https://platform-api2.max.ru/uploads", params={"type": kind}, headers=headers, timeout=30, verify=tls)
        response.raise_for_status()
        upload = response.json()
        url = upload.get("url", "")
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if parsed.scheme != "https" or not any(host.endswith("." + domain) for domain in ("oneme.ru", "okcdn.ru", "max.ru")):
            raise ValueError("MAX вернул неподходящий адрес загрузки")
        with path.open("rb") as handle:
            sent = httpx.post(url, files={"data": (media.original_name, handle, media.mime_type)}, timeout=120, follow_redirects=False, verify=tls)
        sent.raise_for_status()
        attachment_token = upload.get("token")
        if kind == "image":
            data = sent.json()
            photos = data.get("photos", {})
            attachment_token = next((entry.get("token") for entry in photos.values() if entry.get("token")), None)
        if not attachment_token:
            raise ValueError("MAX не вернул идентификатор загруженного файла")
        attachments.append({"type": kind, "payload": {"token": attachment_token}})
    response = httpx.post("https://platform-api2.max.ru/messages", params={"chat_id": channel}, headers=headers, json={"text": caption, "attachments": attachments}, timeout=90, verify=tls)
    response.raise_for_status()
    message = response.json().get("message", {})
    message_id = message.get("body", {}).get("mid")
    if not message_id:
        raise ValueError("MAX не вернул идентификатор сообщения; проверьте канал перед повтором")
    return str(message_id)
