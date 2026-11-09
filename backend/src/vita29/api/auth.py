from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import SESSION_COOKIE, get_current_session, require_csrf
from vita29.auth.security import (
    DUMMY_PASSWORD_HASH,
    create_session,
    hash_password,
    normalize_login,
    verify_password,
)
from vita29.auth.throttle import (
    WINDOW_SECONDS,
    clear_login_failures,
    login_is_allowed,
    record_login_failure,
)
from vita29.db.models import AuditLog, AuthSession, User
from vita29.db.session import get_db
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/auth", tags=["authentication"])


class LoginRequest(BaseModel):
    login: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=10, max_length=256)


class UserResponse(BaseModel):
    id: str
    display_name: str
    login: str
    role: str
    is_active: bool
    can_create_shared_workspaces: bool
    can_create_private_workspaces: bool
    can_delete_workspaces: bool
    can_add_comments: bool
    can_upload_media: bool
    can_view_all_calendars: bool
    can_access_admin: bool
    can_access_chats: bool
    can_access_content: bool
    can_access_analytics: bool
    can_import_ios_photo_library: bool
    can_import_android_photo_library: bool


class SessionResponse(BaseModel):
    user: UserResponse
    csrf_token: str


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        display_name=user.display_name,
        login=user.login,
        role=user.role.value,
        is_active=user.is_active,
        can_create_shared_workspaces=user.can_create_shared_workspaces,
        can_create_private_workspaces=user.can_create_private_workspaces,
        can_delete_workspaces=user.role.value == "owner" or user.can_delete_workspaces,
        can_add_comments=user.can_add_comments,
        can_upload_media=user.can_upload_media,
        can_view_all_calendars=user.can_view_all_calendars,
        can_access_admin=user.role.value == "owner" or user.can_access_admin,
        can_access_chats=user.role.value == "owner" or user.can_access_chats,
        can_access_content=user.role.value == "owner" or user.can_access_content,
        can_access_analytics=user.role.value in ("owner", "admin") or user.can_access_analytics,
        can_import_android_photo_library=(user.role.value == "owner" or user.can_import_android_photo_library),
        can_import_ios_photo_library=(
            user.role.value == "owner" or user.can_import_ios_photo_library
        ),
    )


@router.post("/login", response_model=SessionResponse)
def login(
    payload: LoginRequest,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SessionResponse:
    normalized_login = normalize_login(payload.login)
    if not login_is_allowed(normalized_login):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts",
            headers={"Retry-After": str(WINDOW_SECONDS)},
        )

    user = db.scalar(select(User).where(User.login == normalized_login))
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    password_valid = verify_password(password_hash, payload.password)
    if user is None or not user.is_active or not password_valid:
        record_login_failure(normalized_login)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    clear_login_failures(normalized_login)

    auth_session, raw_token = create_session(db, user, settings.session_lifetime_hours)
    db.add(
        AuditLog(
            actor_id=user.id,
            action="auth.login",
            target_type="user",
            target_id=user.id,
        )
    )
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        raw_token,
        max_age=settings.session_lifetime_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return SessionResponse(user=user_response(user), csrf_token=auth_session.csrf_token)


@router.get("/me", response_model=SessionResponse)
def me(auth_session: Annotated[AuthSession, Depends(get_current_session)]) -> SessionResponse:
    return SessionResponse(
        user=user_response(auth_session.user), csrf_token=auth_session.csrf_token
    )


@router.put("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: ChangePasswordRequest,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    user = auth_session.user
    if not verify_password(user.password_hash, payload.current_password):
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно")
    if verify_password(user.password_hash, payload.new_password):
        raise HTTPException(status_code=400, detail="Новый пароль должен отличаться от текущего")

    user.password_hash = hash_password(payload.new_password)
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user.id,
            AuthSession.id != auth_session.id,
        )
    )
    db.add(
        AuditLog(
            actor_id=user.id,
            action="auth.password_change",
            target_type="user",
            target_id=user.id,
        )
    )
    db.commit()


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    db.delete(auth_session)
    db.add(
        AuditLog(
            actor_id=auth_session.user_id,
            action="auth.logout",
            target_type="user",
            target_id=auth_session.user_id,
        )
    )
    db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
