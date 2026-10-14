import shutil
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from vita29.db.session import get_db
from vita29.settings import Settings, get_settings

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str
    database: str
    storage: str


def storage_is_writable(path: Path) -> bool:
    probe = path / ".healthcheck"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe.touch(exist_ok=True)
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


@router.get("/health", response_model=HealthResponse)
def health(
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    database_status = "ok"
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        database_status = "error"

    writable = storage_is_writable(settings.media_root)
    enough_space = False
    if writable:
        enough_space = shutil.disk_usage(settings.media_root).free >= settings.minimum_free_bytes
    storage_status = "ok" if writable and enough_space else "error"

    overall = "ok" if database_status == storage_status == "ok" else "error"
    if overall != "ok":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthResponse(status=overall, database=database_status, storage=storage_status)
