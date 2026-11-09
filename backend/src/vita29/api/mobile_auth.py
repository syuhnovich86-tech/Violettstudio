from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.api.auth import LoginRequest, UserResponse, user_response
from vita29.auth.dependencies import get_current_session, require_csrf
from vita29.auth.security import (
    DUMMY_PASSWORD_HASH,
    create_session,
    normalize_login,
    verify_password,
)
from vita29.auth.throttle import clear_login_failures, login_is_allowed, record_login_failure
from vita29.db.models import AuditLog, AuthSession, User
from vita29.api.mobile_push import remove_session_tokens
from vita29.db.session import get_db
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/mobile/auth", tags=["mobile authentication"])


class MobileSessionResponse(BaseModel):
    user: UserResponse
    access_token: str
    expires_at: datetime


@router.post("/login", response_model=MobileSessionResponse)
def mobile_login(
    payload: LoginRequest,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MobileSessionResponse:
    normalized_login = normalize_login(payload.login)
    if not login_is_allowed(normalized_login):
        raise HTTPException(status_code=429, detail="Too many login attempts")
    user = db.scalar(select(User).where(User.login == normalized_login))
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    if user is None or not user.is_active or not verify_password(password_hash, payload.password):
        record_login_failure(normalized_login)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    clear_login_failures(normalized_login)
    mobile_session, raw_token = create_session(db, user, settings.mobile_session_lifetime_hours)
    db.add(AuditLog(actor_id=user.id, action="auth.mobile_login", target_type="user", target_id=user.id))
    db.commit()
    return MobileSessionResponse(
        user=user_response(user),
        access_token=raw_token,
        expires_at=mobile_session.expires_at,
    )


@router.get("/me", response_model=UserResponse)
def mobile_me(session: Annotated[AuthSession, Depends(get_current_session)]) -> UserResponse:
    return user_response(session.user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def mobile_logout(
    session: Annotated[AuthSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    remove_session_tokens(db, session.id)
    db.delete(session)
    db.commit()
