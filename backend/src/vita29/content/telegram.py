import json

import httpx

from vita29.db.models import MediaFile, MediaType
from vita29.integrations.store import IntegrationConfigurationError, config_value, read_secret
from vita29.media.storage import original_path
from vita29.settings import Settings


class TelegramPublishError(RuntimeError):
    """A safe, user-visible failure from Telegram publishing."""


MAX_BOT_UPLOAD_BYTES = 50 * 1024 * 1024


def _call(token: str, method: str, *, timeout: float, **kwargs: object) -> dict:
    try:
        response = httpx.post(
            f"https://api.telegram.org/bot{token}/{method}", timeout=timeout, **kwargs
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise TelegramPublishError("Telegram did not accept the publication") from error
    if not payload.get("ok"):
        raise TelegramPublishError("Telegram rejected the publication")
    return payload["result"]


def publish_to_channel(
    settings: Settings, caption: str, media_files: list[MediaFile]
) -> str:
    """Publish text, one file, or a Telegram media group and return its message ids."""
    try:
        token = read_secret(settings, "telegram_bot_token", settings.telegram_bot_token_file, "Telegram bot access")
        channel = config_value(settings, "telegram_channel") or read_secret(
            settings, "telegram_channel", settings.telegram_channel_file, "Telegram channel"
        )
    except IntegrationConfigurationError as error:
        raise TelegramPublishError(str(error)) from error
    if len(media_files) > 10:
        raise TelegramPublishError("Telegram accepts at most 10 files in one post")
    for media in media_files:
        if media.size_bytes > MAX_BOT_UPLOAD_BYTES:
            raise TelegramPublishError(
                f"File ‘{media.original_name}’ is too large for Telegram bot publishing"
            )
    if not media_files:
        result = _call(
            token,
            "sendMessage",
            timeout=settings.telegram_http_timeout_seconds,
            data={"chat_id": channel, "text": caption},
        )
        return str(result["message_id"])
    if len(media_files) == 1:
        media = media_files[0]
        path = original_path(settings, media.storage_key)
        if not path.is_file():
            raise TelegramPublishError("The selected file is no longer available")
        field = "photo" if media.media_type == MediaType.IMAGE else "video"
        method = "sendPhoto" if field == "photo" else "sendVideo"
        with path.open("rb") as file_handle:
            result = _call(
                token,
                method,
                timeout=settings.telegram_http_timeout_seconds,
                data={"chat_id": channel, "caption": caption},
                files={field: (media.original_name, file_handle, media.mime_type)},
            )
        return str(result["message_id"])

    file_handles: list[object] = []
    try:
        attachments: list[dict[str, str]] = []
        files: dict[str, tuple[str, object, str]] = {}
        for index, media in enumerate(media_files):
            path = original_path(settings, media.storage_key)
            if not path.is_file():
                raise TelegramPublishError("One of the selected files is no longer available")
            name = f"media{index}"
            file_handle = path.open("rb")
            file_handles.append(file_handle)
            attachments.append(
                {
                    "type": "photo" if media.media_type == MediaType.IMAGE else "video",
                    "media": f"attach://{name}",
                    **({"caption": caption} if index == 0 else {}),
                }
            )
            files[name] = (media.original_name, file_handle, media.mime_type)
        result = _call(
            token,
            "sendMediaGroup",
            timeout=settings.telegram_http_timeout_seconds,
            data={"chat_id": channel, "media": json.dumps(attachments, ensure_ascii=False)},
            files=files,
        )
        return ",".join(str(message["message_id"]) for message in result)
    finally:
        for file_handle in file_handles:
            file_handle.close()
