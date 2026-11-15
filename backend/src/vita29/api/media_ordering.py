"""Shared archive/picker chronology for phone-backup destinations."""
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from vita29.db.models import MediaFile, Workspace


def phone_workspace_ids(db: Session, import_workspace_name: str) -> set[str]:
    imported = select(MediaFile.workspace_id).where(MediaFile.ios_import_key.is_not(None)).distinct()
    return set(db.scalars(select(Workspace.id).where(or_(
        Workspace.id.in_(imported),
        Workspace.display_name == import_workspace_name,
        Workspace.id == '7277b107-5194-4337-b62a-7fb96d053f05',
    ))))


def archive_date(phone_ids: set[str]):
    # Unknown capture times must never make an old phone photo appear new.
    return case(
        (MediaFile.workspace_id.in_(phone_ids), MediaFile.captured_at),
        else_=func.coalesce(MediaFile.captured_at, MediaFile.created_at),
    )
