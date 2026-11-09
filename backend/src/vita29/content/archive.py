"""Durable copies of the files actually sent in published content."""
import hashlib
import os
import tempfile
from pathlib import Path
from uuid import UUID

from sqlalchemy.orm import Session

from vita29.db.models import MediaFile, User, WorkspaceKind, WorkspaceMember
from vita29.media.storage import original_path
from vita29.settings import Settings


def archive_file(settings: Settings, publication_id: str, media_id: str) -> Path:
    publication_id = str(UUID(publication_id))
    media_id = str(UUID(media_id))
    root = (settings.media_root / '.publication-archive').resolve()
    path = (root / publication_id / media_id).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Недопустимый путь архива')
    return path


def can_view_archive_media(db: Session, media: MediaFile, user: User) -> bool:
    workspace = media.workspace
    if not user.is_active or not workspace.owner.is_active:
        return False
    if workspace.kind == WorkspaceKind.STUDIO or workspace.owner_id == user.id:
        return True
    return db.get(WorkspaceMember, (workspace.id, user.id)) is not None


def snapshot_file(settings: Settings, publication_id: str, media: MediaFile) -> Path:
    target = archive_file(settings, publication_id, media.id)
    if target.is_file():
        return target
    source = original_path(settings, media.storage_key)
    if not source.is_file() and media.deleted_at is not None:
        source = settings.trash_path / media.id
    if not source.is_file():
        raise FileNotFoundError('Материал публикации не найден')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = None
    try:
        digest = hashlib.sha256()
        with source.open('rb') as src, tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as dst:
            temporary = Path(dst.name)
            while chunk := src.read(1024 * 1024):
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
        if media.checksum_sha256 and digest.hexdigest() != media.checksum_sha256:
            raise ValueError('Контрольная сумма архивного файла не совпадает')
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return target


def snapshot_publication(settings: Settings, publication_id: str, files: list[MediaFile]) -> None:
    for media in files:
        snapshot_file(settings, publication_id, media)
