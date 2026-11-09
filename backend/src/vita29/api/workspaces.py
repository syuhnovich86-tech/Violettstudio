import json
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import get_current_user, require_csrf
from vita29.db.models import (
    AuditLog,
    AuthSession,
    MediaFile,
    User,
    Workspace,
    WorkspaceKind,
    WorkspaceMember,
)
from vita29.db.session import get_db
from vita29.media.storage import move_to_trash, restore_from_trash, thumbnail_path
from vita29.settings import Settings, get_settings
from vita29.workspaces.access import can_access_workspace

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceResponse(BaseModel):
    id: str
    display_name: str
    kind: str
    owner_id: str
    role: str
    file_count: int
    size_bytes: int


class CreateWorkspaceRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)
    kind: WorkspaceKind


def workspace_response(
    workspace: Workspace, file_count: int = 0, size_bytes: int = 0
) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=workspace.id,
        display_name=workspace.display_name,
        kind=workspace.kind.value,
        owner_id=workspace.owner_id,
        role=workspace.owner.role.value,
        file_count=file_count,
        size_bytes=size_bytes,
    )


@router.get("", response_model=list[WorkspaceResponse])
def list_workspaces(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[WorkspaceResponse]:
    rows = db.execute(
        select(
            Workspace,
            func.count(MediaFile.id),
            func.coalesce(func.sum(MediaFile.size_bytes), 0),
        )
        .join(Workspace.owner)
        .outerjoin(
            MediaFile,
            and_(
                MediaFile.workspace_id == Workspace.id,
                MediaFile.deleted_at.is_(None),
            ),
        )
        .where(User.is_active.is_(True), Workspace.deleted_at.is_(None))
        .group_by(Workspace.id)
        .order_by(
            case((Workspace.kind == WorkspaceKind.PRIVATE, 0), else_=1),
            Workspace.display_name,
        )
    ).all()
    return [
        workspace_response(workspace, int(file_count), int(size_bytes))
        for workspace, file_count, size_bytes in rows
        if can_access_workspace(db, workspace, user)
    ]


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
def create_workspace(
    payload: CreateWorkspaceRequest,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceResponse:
    user = auth_session.user
    if payload.kind == WorkspaceKind.STUDIO and not user.can_create_shared_workspaces:
        raise HTTPException(status_code=403, detail="Создание общих папок недоступно")
    if payload.kind == WorkspaceKind.PRIVATE and not user.can_create_private_workspaces:
        raise HTTPException(status_code=403, detail="Создание приватных папок недоступно")

    display_name = payload.display_name.strip()
    duplicate_query = select(Workspace).where(
        func.lower(Workspace.display_name) == display_name.lower(),
        Workspace.kind == payload.kind,
        Workspace.deleted_at.is_(None),
    )
    if payload.kind == WorkspaceKind.PRIVATE:
        duplicate_query = duplicate_query.where(Workspace.owner_id == user.id)
    if db.scalar(duplicate_query) is not None:
        raise HTTPException(status_code=409, detail="Папка с таким названием уже существует")

    workspace = Workspace(display_name=display_name, kind=payload.kind, owner_id=user.id)
    db.add(workspace)
    db.flush()
    if payload.kind == WorkspaceKind.PRIVATE:
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id))
    db.add(
        AuditLog(
            actor_id=user.id,
            action="workspace.create",
            target_type="workspace",
            target_id=workspace.id,
            details=json.dumps(
                {"name": display_name, "kind": payload.kind.value}, ensure_ascii=False
            ),
        )
    )
    db.commit()
    db.refresh(workspace)
    return workspace_response(workspace)


@router.post("/{workspace_id}/android-backup-private", response_model=WorkspaceResponse)
def make_android_backup_private(
    workspace_id: str,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkspaceResponse:
    user = auth_session.user
    if not user.can_upload_media or (user.role.value != "owner" and not user.can_import_android_photo_library):
        raise HTTPException(status_code=403, detail="Копирование медиатеки Android недоступно")
    workspace = db.scalar(select(Workspace).where(Workspace.id == workspace_id).with_for_update())
    if workspace is None or not can_access_workspace(db, workspace, user):
        raise HTTPException(status_code=404, detail="Папка не найдена")
    if workspace.kind == WorkspaceKind.STUDIO:
        if workspace.id == "7277b107-5194-4337-b62a-7fb96d053f05":
            return workspace_response(workspace)
        if user.role.value not in ("owner", "admin") and workspace.owner_id != user.id:
            raise HTTPException(status_code=403, detail="Изменить доступ к общей папке может её владелец или администратор")
        if workspace.display_name == "Сгенерированный контент":
            raise HTTPException(status_code=409, detail="Системную папку нельзя сделать приватной")
        workspace.kind = WorkspaceKind.PRIVATE
        if db.get(WorkspaceMember, (workspace.id, user.id)) is None:
            db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id))
        db.add(AuditLog(actor_id=user.id, action="workspace.make_private_for_android_backup", target_type="workspace", target_id=workspace.id, details=json.dumps({"name": workspace.display_name}, ensure_ascii=False)))
        db.commit()
        db.refresh(workspace)
    return workspace_response(workspace)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(
    workspace_id: str,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    user = auth_session.user
    if user.role.value != "owner" and not user.can_delete_workspaces:
        raise HTTPException(status_code=403, detail="Удаление папок недоступно")
    workspace = db.get(Workspace, workspace_id)
    if workspace is None or not can_access_workspace(db, workspace, user):
        raise HTTPException(status_code=404, detail="Папка не найдена")
    if workspace.id == "7277b107-5194-4337-b62a-7fb96d053f05":
        raise HTTPException(status_code=409, detail="Папку «Телефон студии» нельзя удалить")
    if (workspace.kind == WorkspaceKind.PRIVATE and workspace.owner.login == settings.import_owner_login and workspace.display_name == settings.import_workspace_name) or (workspace.kind == WorkspaceKind.STUDIO and workspace.display_name == "Сгенерированный контент"):
        raise HTTPException(status_code=409, detail="Системная папка используется для автоматической загрузки или генерации и не может быть удалена")
    files = db.scalars(select(MediaFile).where(MediaFile.workspace_id == workspace.id, MediaFile.deleted_at.is_(None))).all()
    moved = []
    try:
        for media in files:
            trash = move_to_trash(settings, media.storage_key, media.id)
            if trash is not None:
                moved.append((media.storage_key, trash))
            media.deleted_at = datetime.now(UTC)
        workspace.deleted_at = datetime.now(UTC)
        db.add(AuditLog(actor_id=user.id, action="workspace.delete", target_type="workspace", target_id=workspace.id, details=json.dumps({"name": workspace.display_name, "file_count": len(files)}, ensure_ascii=False)))
        db.commit()
    except Exception:
        db.rollback()
        for key, trash in reversed(moved):
            restore_from_trash(settings, key, trash)
        raise
    for media in files:
        thumbnail_path(settings, media.id).unlink(missing_ok=True)
