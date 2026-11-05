"""Revocable, short-lived media URLs for remote publishing providers."""

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from vita29.db.models import ContentPublication, MediaFile, TemporaryPublicMediaLink, utc_now
from vita29.settings import Settings


class PublicMediaLinkError(RuntimeError):
    """The externally reachable media URL is not configured safely."""


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_media_base_url(settings: Settings) -> str:
    base_url = settings.public_base_url.strip().rstrip("/")
    if not base_url.startswith("https://"):
        raise PublicMediaLinkError(
            "Для публикации в Instagram нужен публичный HTTPS-адрес приложения"
        )
    return base_url


def create_temporary_public_link(
    db: Session,
    settings: Settings,
    media: MediaFile,
    publication: ContentPublication | None = None,
    *,
    lifetime_minutes: int = 90,
) -> str:
    """Return an opaque URL. Only the digest is persisted in the database."""
    now = utc_now()
    db.execute(
        delete(TemporaryPublicMediaLink).where(
            TemporaryPublicMediaLink.expires_at < now - timedelta(days=1)
        )
    )
    token = secrets.token_urlsafe(32)
    db.add(
        TemporaryPublicMediaLink(
            media_file_id=media.id,
            publication_id=publication.id if publication else None,
            token_hash=token_digest(token),
            expires_at=now + timedelta(minutes=lifetime_minutes),
        )
    )
    db.flush()
    return f"{public_media_base_url(settings)}/api/v1/public/media/{token}"


def revoke_public_links(db: Session, publication: ContentPublication) -> None:
    """Immediately make every delivery URL for a publication inaccessible."""
    db.execute(
        update(TemporaryPublicMediaLink)
        .where(
            TemporaryPublicMediaLink.publication_id == publication.id,
            TemporaryPublicMediaLink.revoked_at.is_(None),
        )
        .values(revoked_at=utc_now())
    )
