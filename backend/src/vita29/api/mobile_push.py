"""Register a device for notifications under its authenticated session."""
from typing import Annotated
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import require_csrf
from vita29.db.models import AuthSession, MobilePushDelivery, MobilePushToken, utc_now
from vita29.db.session import get_db

router = APIRouter(prefix="/mobile/push", tags=["mobile push"])


class TokenRequest(BaseModel):
    token: str = Field(min_length=30, max_length=4096)


def remove_session_tokens(db: Session, session_id: str):
    token_ids = select(MobilePushToken.id).where(MobilePushToken.session_id == session_id)
    db.execute(delete(MobilePushDelivery).where(MobilePushDelivery.token_id.in_(token_ids)))
    db.execute(delete(MobilePushToken).where(MobilePushToken.session_id == session_id))


@router.put("/token", status_code=status.HTTP_204_NO_CONTENT)
def register_token(payload: TokenRequest, session: Annotated[AuthSession, Depends(require_csrf)], db: Annotated[Session, Depends(get_db)]):
    token = db.scalar(select(MobilePushToken).where(MobilePushToken.token == payload.token))
    obsolete_ids = select(MobilePushToken.id).where(MobilePushToken.session_id == session.id, MobilePushToken.token != payload.token)
    db.execute(delete(MobilePushDelivery).where(MobilePushDelivery.token_id.in_(obsolete_ids)))
    db.execute(delete(MobilePushToken).where(MobilePushToken.session_id == session.id, MobilePushToken.token != payload.token))
    if token is None:
        token = MobilePushToken(token=payload.token, user_id=session.user_id, session_id=session.id)
        db.add(token)
    elif token.session_id != session.id:
        db.execute(delete(MobilePushDelivery).where(MobilePushDelivery.token_id == token.id))
        token.user_id = session.user_id
        token.session_id = session.id
        token.created_at = utc_now()
    db.commit()


@router.delete("/token", status_code=status.HTTP_204_NO_CONTENT)
def remove_token(session: Annotated[AuthSession, Depends(require_csrf)], db: Annotated[Session, Depends(get_db)]):
    remove_session_tokens(db, session.id)
    db.commit()
