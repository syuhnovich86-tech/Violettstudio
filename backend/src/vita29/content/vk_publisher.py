"""Publish a post on a VK community wall using a user access token."""
from urllib.parse import urlparse

import httpx

from vita29.db.models import MediaType
from vita29.integrations.store import config_value, read_secret
from vita29.media.storage import original_path

VK_API = "https://api.vk.com/method/"
VK_VERSION = "5.199"


class VKNotPublishedError(RuntimeError):
    """The VK request failed before creating a wall post."""


def _call(method, token, **params):
    response = httpx.post(VK_API + method, data={**params, "access_token": token, "v": VK_VERSION}, timeout=60)
    response.raise_for_status()
    payload = response.json()
    if "error" in payload:
        # Never include VK's response or request URL: it could contain a token.
        raise ValueError(f"ВКонтакте отклонил {method}; проверьте права токена и ID сообщества")
    if "response" not in payload:
        raise ValueError(f"ВКонтакте не подтвердил {method}")
    return payload["response"]


def _upload_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(host == domain or host.endswith("." + domain) for domain in ("vk.com", "vk.ru", "userapi.com", "vkuseraudio.net")):
        raise ValueError("ВКонтакте вернул неподходящий адрес загрузки")
    return url


def _prepare_vk(settings, media_files):
    token = read_secret(settings, "vk_user_token", settings.integration_secrets_path / "unused", "VK user token")
    group_value = config_value(settings, "vk_group_id").lstrip("-")
    if not group_value.isdigit() or int(group_value) <= 0:
        raise ValueError("Укажите числовой ID сообщества ВКонтакте")
    group_id = int(group_value)
    attachments = []
    for media in media_files:
        path = original_path(settings, media.storage_key)
        if not path.is_file():
            raise ValueError("Выбранный файл больше не доступен")
        if media.media_type == MediaType.IMAGE:
            target = _call("photos.getWallUploadServer", token, group_id=group_id)
            with path.open("rb") as handle:
                response = httpx.post(_upload_url(target["upload_url"]), files={"photo": (media.original_name, handle, media.mime_type)}, timeout=120, follow_redirects=False)
            response.raise_for_status()
            upload = response.json()
            photos = _call("photos.saveWallPhoto", token, group_id=group_id, server=upload["server"], photo=upload["photo"], hash=upload["hash"])
            photo = photos[0]
            attachments.append(f"photo{int(photo['owner_id'])}_{int(photo['id'])}")
        else:
            video = _call("video.save", token, group_id=group_id, name=media.original_name)
            with path.open("rb") as handle:
                response = httpx.post(_upload_url(video["upload_url"]), files={"video_file": (media.original_name, handle, media.mime_type)}, timeout=300, follow_redirects=False)
            response.raise_for_status()
            attachments.append(f"video{int(video['owner_id'])}_{int(video['video_id'])}")
    return token, group_id, attachments


def publish_to_vk(settings, caption, media_files, guid):
    try:
        token, group_id, attachments = _prepare_vk(settings, media_files)
    except Exception as error:
        detail = str(error) if isinstance(error, ValueError) else "Не удалось подготовить файлы для ВКонтакте. Проверьте ключ и права."
        raise VKNotPublishedError(detail[:200]) from error
    post = _call("wall.post", token, owner_id=-group_id, from_group=1, message=caption, attachments=",".join(attachments), guid=guid)
    if not post.get("post_id"):
        raise ValueError("ВКонтакте не подтвердил публикацию; проверьте стену перед повтором")
    return str(post["post_id"])
