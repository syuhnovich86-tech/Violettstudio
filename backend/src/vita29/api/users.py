import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from vita29.api.auth import UserResponse, user_response
from vita29.auth.dependencies import require_admin, require_csrf
from vita29.auth.security import hash_password, normalize_login, revoke_user_sessions
from vita29.db.models import (
    AuditLog,
    AuthSession,
    User,
    UserRole,
    Workspace,
    WorkspaceKind,
)
from vita29.db.session import get_db
from vita29.workspaces.access import create_studio_workspace

router = APIRouter(prefix="/users", tags=["users"])


class CreateUserRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)
    login: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")
    password: str = Field(min_length=10, max_length=256)
    role: UserRole = UserRole.EMPLOYEE


class ResetPasswordRequest(BaseModel):
    password: str = Field(min_length=10, max_length=256)


class UpdateUserRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)
    login: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9._-]+$")


class SetActiveRequest(BaseModel):
    is_active: bool


class UpdatePermissionsRequest(BaseModel):
    role: UserRole
    can_create_shared_workspaces: bool
    can_create_private_workspaces: bool
    can_delete_workspaces: bool | None = None
    can_add_comments: bool
    can_upload_media: bool
    can_view_all_calendars: bool
    can_access_admin: bool
    can_access_chats: bool
    can_access_content: bool = False
    can_access_analytics: bool | None = None
    can_import_ios_photo_library: bool = False
    can_import_android_photo_library: bool | None = None


def persist_user(db: Session, user: User) -> None:
    try:
        db.add(user)
        db.flush()
        create_studio_workspace(db, user)
        db.commit()
        db.refresh(user)
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Login already exists") from error


@router.get("", response_model=list[UserResponse])
def list_users(
    _: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> list[UserResponse]:
    users = db.scalars(select(User).order_by(User.display_name)).all()
    return [user_response(user) for user in users]


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: CreateUserRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    if payload.role == UserRole.OWNER:
        raise HTTPException(status_code=400, detail="The owner can only be created from the server")
    if admin.role != UserRole.OWNER and payload.role == UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Only the owner can create administrators")
    user = User(
        display_name=payload.display_name.strip(),
        login=normalize_login(payload.login),
        password_hash=hash_password(payload.password),
        role=payload.role,
        can_create_shared_workspaces=True,
        can_create_private_workspaces=False,
        can_add_comments=True,
        can_upload_media=True,
        can_view_all_calendars=payload.role == UserRole.ADMIN,
        can_access_admin=payload.role == UserRole.ADMIN,
        can_access_chats=True,
        can_access_content=False,
        can_import_ios_photo_library=False,
    )
    persist_user(db, user)
    db.add(
        AuditLog(
            actor_id=admin.id,
            action="user.create",
            target_type="user",
            target_id=user.id,
        )
    )
    db.commit()
    return user_response(user)


@router.put("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: str,
    payload: UpdateUserRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == UserRole.OWNER and user.id != admin.id:
        raise HTTPException(status_code=403, detail="The owner account is protected")
    if user.role == UserRole.ADMIN and admin.role != UserRole.OWNER and user.id != admin.id:
        raise HTTPException(
            status_code=403, detail="Only the owner can manage other administrators"
        )

    previous_name = user.display_name
    previous_login = user.login
    user.display_name = payload.display_name.strip()
    user.login = normalize_login(payload.login)
    studio_workspace = db.scalar(
        select(Workspace).where(
            Workspace.owner_id == user.id,
            Workspace.kind == WorkspaceKind.STUDIO,
        )
    )
    if studio_workspace is not None:
        studio_workspace.display_name = user.display_name
    db.add(
        AuditLog(
            actor_id=admin.id,
            action="user.update",
            target_type="user",
            target_id=user.id,
            details=json.dumps(
                {
                    "display_name": {"from": previous_name, "to": user.display_name},
                    "login": {"from": previous_login, "to": user.login},
                },
                ensure_ascii=False,
            ),
        )
    )
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Login already exists") from error
    db.refresh(user)
    return user_response(user)


@router.put("/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(
    user_id: str,
    payload: ResetPasswordRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == UserRole.OWNER and user.id != admin.id:
        raise HTTPException(status_code=403, detail="The owner account is protected")
    if user.role == UserRole.ADMIN and admin.role != UserRole.OWNER and user.id != admin.id:
        raise HTTPException(
            status_code=403, detail="Only the owner can manage other administrators"
        )
    user.password_hash = hash_password(payload.password)
    db.add(
        AuditLog(
            actor_id=admin.id,
            action="user.password_reset",
            target_type="user",
            target_id=user.id,
        )
    )
    db.commit()
    revoke_user_sessions(db, user.id)


@router.put("/{user_id}/active", response_model=UserResponse)
def set_active(
    user_id: str,
    payload: SetActiveRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == UserRole.OWNER:
        raise HTTPException(status_code=400, detail="The owner account cannot be deactivated")
    if user.id == admin.id and not payload.is_active:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")
    if user.role == UserRole.ADMIN and admin.role != UserRole.OWNER:
        raise HTTPException(status_code=403, detail="Only the owner can manage administrators")
    user.is_active = payload.is_active
    db.add(
        AuditLog(
            actor_id=admin.id,
            action="user.activate" if payload.is_active else "user.deactivate",
            target_type="user",
            target_id=user.id,
        )
    )
    db.commit()
    db.refresh(user)
    if not user.is_active:
        revoke_user_sessions(db, user.id)
    return user_response(user)


@router.put("/{user_id}/permissions", response_model=UserResponse)
def update_permissions(
    user_id: str,
    payload: UpdatePermissionsRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == UserRole.OWNER or payload.role == UserRole.OWNER:
        raise HTTPException(status_code=403, detail="Owner permissions are protected")
    if admin.role != UserRole.OWNER and (
        user.role == UserRole.ADMIN or payload.role == UserRole.ADMIN
    ):
        raise HTTPException(status_code=403, detail="Only the owner can manage administrators")
    previous = {
        "role": user.role.value,
        "can_create_shared_workspaces": user.can_create_shared_workspaces,
        "can_create_private_workspaces": user.can_create_private_workspaces,
        "can_delete_workspaces": user.can_delete_workspaces,
        "can_add_comments": user.can_add_comments,
        "can_upload_media": user.can_upload_media,
        "can_view_all_calendars": user.can_view_all_calendars,
        "can_access_admin": user.can_access_admin,
        "can_access_chats": user.can_access_chats,
        "can_access_content": user.can_access_content,
        "can_access_analytics": user.can_access_analytics,
        "can_import_ios_photo_library": user.can_import_ios_photo_library,
        "can_import_android_photo_library": user.can_import_android_photo_library,
    }
    user.role = payload.role
    user.can_create_shared_workspaces = payload.can_create_shared_workspaces
    user.can_create_private_workspaces = payload.can_create_private_workspaces
    if payload.can_delete_workspaces is not None:
        user.can_delete_workspaces = payload.can_delete_workspaces
    user.can_add_comments = payload.can_add_comments
    user.can_upload_media = payload.can_upload_media
    user.can_view_all_calendars = payload.can_view_all_calendars
    user.can_access_admin = payload.can_access_admin
    user.can_access_chats = payload.can_access_chats
    user.can_access_content = payload.can_access_content
    if payload.can_access_analytics is not None:
        if admin.role != UserRole.OWNER and payload.can_access_analytics != user.can_access_analytics:
            raise HTTPException(status_code=403, detail="Only the owner can change analytics access")
        user.can_access_analytics = payload.can_access_analytics
    if payload.can_import_ios_photo_library and admin.role != UserRole.OWNER:
        raise HTTPException(
            status_code=403,
            detail="Only the owner can grant iPhone library import",
        )
    user.can_import_ios_photo_library = payload.can_import_ios_photo_library
    if payload.can_import_android_photo_library is not None:
        if admin.role != UserRole.OWNER and payload.can_import_android_photo_library != user.can_import_android_photo_library:
            raise HTTPException(status_code=403, detail="Only the owner can change Android library import")
        user.can_import_android_photo_library = payload.can_import_android_photo_library
    db.add(
        AuditLog(
            actor_id=admin.id,
            action="user.permissions.update",
            target_type="user",
            target_id=user.id,
            details=json.dumps(
                {
                    "from": previous,
                    "to": {
                        "role": user.role.value,
                        "can_create_shared_workspaces": user.can_create_shared_workspaces,
                        "can_create_private_workspaces": user.can_create_private_workspaces,
                        "can_delete_workspaces": user.can_delete_workspaces,
                        "can_add_comments": user.can_add_comments,
                        "can_upload_media": user.can_upload_media,
                        "can_view_all_calendars": user.can_view_all_calendars,
                        "can_access_admin": user.can_access_admin,
                        "can_access_chats": user.can_access_chats,
                        "can_access_content": user.can_access_content,
                        "can_access_analytics": user.can_access_analytics,
                        "can_import_ios_photo_library": user.can_import_ios_photo_library,
                        "can_import_android_photo_library": user.can_import_android_photo_library,
                    },
                },
                ensure_ascii=False,
            ),
        )
    )
    db.commit()
    db.refresh(user)
    return user_response(user)
