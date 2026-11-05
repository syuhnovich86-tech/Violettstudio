"""Public delivery endpoint used only by opaque, short-lived Meta URLs."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.content.public_links import token_digest
from vita29.db.models import MediaFile, TemporaryPublicMediaLink, utc_now
from vita29.db.session import get_db
from vita29.media.storage import original_path
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/public/media", tags=["public-media"])


@router.get("/{token}", include_in_schema=False)
def temporary_public_media(
    token: str,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> FileResponse:
    """Serve one original only while its unguessable delivery token is alive."""
    link = db.scalar(
        select(TemporaryPublicMediaLink).where(
            TemporaryPublicMediaLink.token_hash == token_digest(token),
            TemporaryPublicMediaLink.revoked_at.is_(None),
            TemporaryPublicMediaLink.expires_at > utc_now(),
        )
    )
    if link is None:
        # Deliberately do not reveal whether a token was ever valid.
        raise HTTPException(status_code=404, detail="Файл не найден")
    media = db.get(MediaFile, link.media_file_id)
    if media is None or media.deleted_at is not None or not media.publication_allowed:
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = original_path(settings, media.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    return FileResponse(
        path,
        media_type=media.mime_type,
        filename=media.original_name,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
