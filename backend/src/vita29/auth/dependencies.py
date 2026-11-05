import secrets
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from vita29.auth.security import find_session
from vita29.db.models import AuthSession, User, UserRole
from vita29.db.session import get_db

SESSION_COOKIE = "vita29_session"


def get_current_session(
    db: Annotated[Session, Depends(get_db)],
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> AuthSession:
    bearer_token = None
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.casefold() == "bearer" and value:
            bearer_token = value
    raw_token = bearer_token or session_token
    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    auth_session = find_session(db, raw_token)
    if auth_session is None or not auth_session.user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    return auth_session


def get_current_user(
    auth_session: Annotated[AuthSession, Depends(get_current_session)],
) -> User:
    return auth_session.user


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.OWNER and not user.can_access_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator required")
    return user


def require_chat_access(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.OWNER and not user.can_access_chats:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Chat access is disabled")
    return user


def require_content_access(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.OWNER and not user.can_access_content:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Content access is disabled")
    return user


def require_owner(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != UserRole.OWNER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner required")
    return user


def require_owner_or_administrator(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Integration credentials are never available to employees with admin UI access."""
    if user.role not in {UserRole.OWNER, UserRole.ADMIN}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner or administrator required")
    return user


def require_csrf(
    auth_session: Annotated[AuthSession, Depends(get_current_session)],
    csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> AuthSession:
    if authorization and authorization.partition(" ")[0].casefold() == "bearer":
        return auth_session
    if not csrf_token or not secrets.compare_digest(csrf_token, auth_session.csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")
    return auth_session
