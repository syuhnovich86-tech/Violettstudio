import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from vita29.db.models import AuthSession, User

password_hasher = PasswordHasher()
DUMMY_PASSWORD_HASH = password_hasher.hash("dummy-password-never-used")


def normalize_login(login: str) -> str:
    return login.strip().casefold()


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: Session, user: User, lifetime_hours: int) -> tuple[AuthSession, str]:
    raw_token = secrets.token_urlsafe(32)
    auth_session = AuthSession(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        csrf_token=secrets.token_urlsafe(32),
        expires_at=datetime.now(UTC) + timedelta(hours=lifetime_hours),
    )
    db.add(auth_session)
    db.commit()
    db.refresh(auth_session)
    return auth_session, raw_token


def revoke_user_sessions(db: Session, user_id: str) -> None:
    db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
    db.commit()


def find_session(db: Session, raw_token: str) -> AuthSession | None:
    auth_session = db.scalar(
        select(AuthSession).where(AuthSession.token_hash == hash_token(raw_token))
    )
    if auth_session is None:
        return None
    expires_at = auth_session.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at <= datetime.now(UTC):
        db.delete(auth_session)
        db.commit()
        return None
    return auth_session
