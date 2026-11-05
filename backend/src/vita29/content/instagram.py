"""Publishing to Instagram's Content Publishing API.

Meta downloads media itself, therefore this module creates revocable HTTPS URLs
only for the duration of the upload/publish transaction.
"""

import time
from typing import Any

import httpx
from sqlalchemy.orm import Session

from vita29.content.public_links import (
    PublicMediaLinkError,
    create_temporary_public_link,
    revoke_public_links,
)
from vita29.db.models import ContentPublication, MediaFile, MediaType
from vita29.integrations.store import IntegrationConfigurationError, config_value, read_secret
from vita29.settings import Settings


class InstagramPublishError(RuntimeError):
    """A safe message for the editor when Meta declines a publication."""


_GRAPH_BASE = "https://graph.facebook.com/v22.0"


def _call(method: str, path: str, *, token: str, timeout: float, **kwargs: Any) -> dict[str, Any]:
    try:
        response = httpx.request(
            method,
            f"{_GRAPH_BASE}{path}",
            timeout=timeout,
            params={"access_token": token, **kwargs.pop("params", {})},
            data=kwargs.pop("data", None),
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise InstagramPublishError("Instagram не принял публикацию. Проверьте подключение Meta и повторите попытку.") from error
    if payload.get("error"):
        raise InstagramPublishError("Instagram отклонил публикацию. Проверьте токен, права аккаунта и формат файла.")
    return payload


def _wait_until_ready(container_id: str, *, token: str, timeout: float) -> None:
    """Meta may download a remote video asynchronously before it can be published."""
    for _ in range(18):
        payload = _call(
            "GET", f"/{container_id}", token=token, timeout=timeout,
            params={"fields": "status_code,status"},
        )
        state = str(payload.get("status_code") or payload.get("status") or "").upper()
        if state in {"FINISHED", "PUBLISHED"}:
            return
        if state in {"ERROR", "EXPIRED"}:
            raise InstagramPublishError("Instagram не смог обработать файл. Попробуйте другое фото или видео.")
        time.sleep(3)
    raise InstagramPublishError("Instagram слишком долго готовит файл. Попробуйте опубликовать ещё раз.")


def publish_to_instagram(
    db: Session,
    settings: Settings,
    publication: ContentPublication,
    caption: str,
    media_files: list[MediaFile],
) -> str:
    """Create Meta containers, publish them, then invalidate every delivery URL."""
    try:
        token = read_secret(
            settings, "instagram_access_token", settings.integration_secrets_path / "unused", "Instagram access token"
        )
        account_id = config_value(settings, "instagram_account_id")
        if not account_id:
            raise IntegrationConfigurationError("Instagram business account ID is not configured")
        if not media_files:
            raise InstagramPublishError("Для Instagram нужен хотя бы один фото- или видеоматериал")
        if len(media_files) > 10:
            raise InstagramPublishError("Instagram принимает не более 10 материалов в одной публикации")

        delivery_urls = [
            create_temporary_public_link(db, settings, media, publication)
            for media in media_files
        ]
        # The unauthenticated delivery endpoint uses a separate request/session,
        # so commit links before Meta starts fetching them.
        db.commit()

        format_name = publication.publication_format
        if len(media_files) == 1:
            media = media_files[0]
            payload: dict[str, str] = {"caption": caption}
            if media.media_type == MediaType.IMAGE:
                payload["image_url"] = delivery_urls[0]
                if format_name == "story":
                    payload["media_type"] = "STORIES"
            else:
                payload["video_url"] = delivery_urls[0]
                payload["media_type"] = "STORIES" if format_name == "story" else "REELS"
                if format_name != "story":
                    payload["share_to_feed"] = "true"
            container = _call("POST", f"/{account_id}/media", token=token, timeout=settings.openai_http_timeout_seconds, data=payload)
            creation_id = str(container.get("id") or "")
            if not creation_id:
                raise InstagramPublishError("Instagram не вернул идентификатор подготовленной публикации")
            _wait_until_ready(creation_id, token=token, timeout=settings.openai_http_timeout_seconds)
        else:
            if format_name == "story":
                raise InstagramPublishError("История Instagram поддерживает один материал. Выберите одно фото или видео.")
            children: list[str] = []
            for media, url in zip(media_files, delivery_urls, strict=True):
                payload = {"is_carousel_item": "true"}
                if media.media_type == MediaType.IMAGE:
                    payload["image_url"] = url
                else:
                    payload["video_url"] = url
                    payload["media_type"] = "VIDEO"
                child = _call("POST", f"/{account_id}/media", token=token, timeout=settings.openai_http_timeout_seconds, data=payload)
                child_id = str(child.get("id") or "")
                if not child_id:
                    raise InstagramPublishError("Instagram не подготовил один из материалов карусели")
                _wait_until_ready(child_id, token=token, timeout=settings.openai_http_timeout_seconds)
                children.append(child_id)
            container = _call(
                "POST", f"/{account_id}/media", token=token, timeout=settings.openai_http_timeout_seconds,
                data={"media_type": "CAROUSEL", "children": ",".join(children), "caption": caption},
            )
            creation_id = str(container.get("id") or "")
            if not creation_id:
                raise InstagramPublishError("Instagram не подготовил карусель")
            _wait_until_ready(creation_id, token=token, timeout=settings.openai_http_timeout_seconds)

        published = _call(
            "POST", f"/{account_id}/media_publish", token=token, timeout=settings.openai_http_timeout_seconds,
            data={"creation_id": creation_id},
        )
        result_id = str(published.get("id") or "")
        if not result_id:
            raise InstagramPublishError("Instagram не подтвердил публикацию")
        revoke_public_links(db, publication)
        db.commit()
        return result_id
    except (IntegrationConfigurationError, PublicMediaLinkError) as error:
        revoke_public_links(db, publication)
        db.commit()
        raise InstagramPublishError(str(error)) from error
    except Exception:
        # A failed Meta transaction must not leave a URL usable until expiry.
        revoke_public_links(db, publication)
        db.commit()
        raise
