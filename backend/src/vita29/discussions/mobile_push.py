"""Send generic Android notifications without exposing private chat contents."""
import logging
from datetime import timedelta
from pathlib import Path

import httpx
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from vita29.db.models import AuthSession, MobilePushDelivery, MobilePushToken, Notification, User, UserRole, utc_now

log = logging.getLogger(__name__)


def pending_deliveries(db: Session):
    now = utc_now()
    return db.execute(
        select(Notification, MobilePushToken)
        .join(MobilePushToken, MobilePushToken.user_id == Notification.user_id)
        .join(AuthSession, AuthSession.id == MobilePushToken.session_id)
        .join(User, User.id == MobilePushToken.user_id)
        .outerjoin(MobilePushDelivery, and_(MobilePushDelivery.notification_id == Notification.id, MobilePushDelivery.token_id == MobilePushToken.id))
        .where(Notification.read_at.is_(None), Notification.created_at >= MobilePushToken.created_at,
               Notification.created_at >= now - timedelta(hours=24), AuthSession.expires_at > now,
               User.is_active.is_(True), or_(User.can_access_chats.is_(True), User.role == UserRole.OWNER),
               MobilePushDelivery.notification_id.is_(None))
        .order_by(Notification.created_at).limit(50)
    ).all()


def deliver_pending(session_factory, credential_path: Path, project_id: str):
    if not credential_path.is_file() or not project_id:
        return
    with session_factory() as db:
        live_sessions = select(AuthSession.id).where(AuthSession.expires_at > utc_now())
        stale_ids = list(db.scalars(select(MobilePushToken.id).where(MobilePushToken.session_id.not_in(live_sessions)).limit(500)))
        if stale_ids:
            db.execute(delete(MobilePushDelivery).where(MobilePushDelivery.token_id.in_(stale_ids)))
            db.execute(delete(MobilePushToken).where(MobilePushToken.id.in_(stale_ids)))
            db.commit()
        if not pending_deliveries(db):
            return
    import google.auth.transport.requests
    from google.oauth2 import service_account

    credentials = service_account.Credentials.from_service_account_file(
        str(credential_path), scopes=['https://www.googleapis.com/auth/firebase.messaging'])
    credentials.refresh(google.auth.transport.requests.Request())
    headers = {'Authorization': f'Bearer {credentials.token}'}
    with session_factory() as db, httpx.Client(timeout=10) as client:
        for notification, device in pending_deliveries(db):
            result = client.post(f'https://fcm.googleapis.com/v1/projects/{project_id}/messages:send', headers=headers,
                json={'message': {'token': device.token, 'notification': {'title': 'VIOLETTA', 'body': 'Новое уведомление в приложении'},
                                  'android': {'priority': 'high', 'notification': {'channel_id': 'messages'}}}})
            if result.is_success:
                db.add(MobilePushDelivery(notification_id=notification.id, token_id=device.id, sent_at=utc_now()))
                db.commit()
            elif (result.status_code == 404 and 'UNREGISTERED' in result.text) or (
                result.status_code == 400 and 'registration token is not a valid' in result.text.lower()
            ):
                db.execute(delete(MobilePushDelivery).where(MobilePushDelivery.token_id == device.id))
                db.delete(device)
                db.commit()
            else:
                log.warning('FCM delivery failed (HTTP %s)', result.status_code)
                break
