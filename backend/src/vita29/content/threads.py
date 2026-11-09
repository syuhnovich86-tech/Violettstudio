"""Threads publication using its own token and short-lived media links."""
import time

import httpx

from vita29.content.public_links import create_temporary_public_link, revoke_public_links
from vita29.db.models import MediaType
from vita29.integrations.store import read_secret


class ThreadsNotPublishedError(RuntimeError):
    """The request failed before publication was attempted."""


def publish_to_threads(db, settings, publication, caption, media_files):
    publishing = False
    try:
        token = read_secret(settings, "threads_access_token", settings.integration_secrets_path / "unused", "Threads access token")
        headers = {"Authorization": f"Bearer {token}"}
        base = "https://graph.threads.net/v1.0"
        payload = {"media_type": "TEXT", "text": caption}
        if len(media_files) > 1:
            raise ValueError("Threads: выберите не более одного файла")
        if media_files:
            media = media_files[0]
            link = create_temporary_public_link(db, settings, media, publication)
            db.commit()
            payload["media_type"] = "IMAGE" if media.media_type == MediaType.IMAGE else "VIDEO"
            payload["image_url" if media.media_type == MediaType.IMAGE else "video_url"] = link
        with httpx.Client(headers=headers, timeout=settings.openai_http_timeout_seconds) as client:
            response = client.post(f"{base}/me/threads", data=payload)
            response.raise_for_status()
            container = response.json().get("id")
            if not container:
                raise ValueError("Threads не создал публикацию")
            if media_files:
                for _ in range(30):
                    status_response = client.get(f"{base}/{container}", params={"fields": "status"})
                    status_response.raise_for_status()
                    state = status_response.json().get("status", "")
                    if state in ("FINISHED", "PUBLISHED"):
                        break
                    if state in ("ERROR", "EXPIRED"):
                        raise ValueError("Threads не смог обработать файл")
                    time.sleep(3)
                else:
                    raise ValueError("Threads не успел обработать файл")
            publishing = True
            response = client.post(f"{base}/me/threads_publish", data={"creation_id": container})
            response.raise_for_status()
            result = response.json().get("id")
            if not result:
                raise RuntimeError("Threads не подтвердил отправку")
            return str(result)
    except Exception as exc:
        if not publishing:
            raise ThreadsNotPublishedError("Threads не подготовил публикацию. Проверьте подключение и формат файла.") from exc
        raise
    finally:
        if media_files:
            revoke_public_links(db, publication)
            db.commit()
