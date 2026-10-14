import shutil
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import get_current_user
from vita29.db.models import MediaFile, User
from vita29.db.session import get_db
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/storage", tags=["storage"])


class StorageResponse(BaseModel):
    total_bytes: int
    used_bytes: int
    free_bytes: int
    media_bytes: int
    used_percent: float


@router.get("", response_model=StorageResponse)
def storage_status(
    _: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> StorageResponse:
    settings.media_root.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(settings.media_root)
    media_bytes = db.scalar(
        select(func.coalesce(func.sum(MediaFile.size_bytes), 0)).where(
            MediaFile.deleted_at.is_(None)
        )
    )
    used_percent = round((usage.used / usage.total) * 100, 1) if usage.total else 0.0
    return StorageResponse(
        total_bytes=usage.total,
        used_bytes=usage.used,
        free_bytes=usage.free,
        media_bytes=int(media_bytes or 0),
        used_percent=used_percent,
    )
