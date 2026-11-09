import json
import secrets
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import get_current_user, require_csrf, require_owner
from vita29.db.models import (
    AuditLog,
    AuthSession,
    MediaFile,
    User,
    UserRole,
    YclientsIntegration,
    YclientsStaffMapping,
    YclientsVisit,
)
from vita29.db.session import get_db
from vita29.settings import Settings, get_settings
from vita29.yclients.client import (
    YclientsClient,
    YclientsError,
    get_yclients_client,
    read_secret,
)
from vita29.yclients.sync import sync_yclients_visits

router = APIRouter(prefix="/yclients", tags=["yclients"])

def can_view_all_calendars(user: User) -> bool:
    return user.role == UserRole.OWNER or user.can_view_all_calendars


class ActivateRequest(BaseModel):
    salon_id: int = Field(gt=0)


class IntegrationStatus(BaseModel):
    configured: bool
    salon_id: int | None = None
    application_id: int
    status: str | None = None


class MarketplaceWebhook(BaseModel):
    salon_id: int = Field(gt=0)
    application_id: int = Field(gt=0)
    event: Literal["uninstall", "freeze"]
    partner_token: str


class SyncRequest(BaseModel):
    start_date: date
    end_date: date


class SyncResult(BaseModel):
    processed: int
    linked: int
    unlinked: int


class CalendarUser(BaseModel):
    user_id: str
    display_name: str


class VisitResponse(BaseModel):
    record_id: int
    user_id: str | None
    starts_at: str
    client_name: str | None
    services: list[str]
    comment: str | None
    media_count: int
    staff_name: str | None


def activate_integration(
    *,
    salon_id: int,
    actor: User,
    db: Session,
    settings: Settings,
    client: YclientsClient,
) -> YclientsIntegration:
    existing = db.scalar(select(YclientsIntegration).limit(1))
    if existing is not None and existing.salon_id != salon_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="YCLIENTS is already linked to another salon",
        )
    try:
        client.activate(salon_id)
    except YclientsError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="YCLIENTS activation failed",
        ) from exc

    integration = existing or YclientsIntegration(
        salon_id=salon_id,
        application_id=settings.yclients_application_id,
    )
    integration.salon_id = salon_id
    integration.application_id = settings.yclients_application_id
    integration.status = "active"
    db.add(integration)
    db.add(
        AuditLog(
            actor_id=actor.id,
            action="yclients.activate",
            target_type="yclients_salon",
            target_id=str(salon_id),
        )
    )
    db.commit()
    db.refresh(integration)
    return integration


@router.get("/connect", include_in_schema=False)
def connect_from_marketplace(
    salon_id: int,
    owner: Annotated[User, Depends(require_owner)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[YclientsClient, Depends(get_yclients_client)],
) -> RedirectResponse:
    activate_integration(
        salon_id=salon_id,
        actor=owner,
        db=db,
        settings=settings,
        client=client,
    )
    return RedirectResponse(url="/?yclients=connected", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/activate", response_model=IntegrationStatus)
def activate_manually(
    payload: ActivateRequest,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    owner: Annotated[User, Depends(require_owner)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[YclientsClient, Depends(get_yclients_client)],
) -> IntegrationStatus:
    _ = auth_session
    integration = activate_integration(
        salon_id=payload.salon_id,
        actor=owner,
        db=db,
        settings=settings,
        client=client,
    )
    return IntegrationStatus(
        configured=True,
        salon_id=integration.salon_id,
        application_id=integration.application_id,
        status=integration.status,
    )


@router.get("/status", response_model=IntegrationStatus)
def integration_status(
    _: Annotated[User, Depends(require_owner)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> IntegrationStatus:
    integration = db.scalar(select(YclientsIntegration).limit(1))
    if integration is None:
        return IntegrationStatus(
            configured=False,
            application_id=settings.yclients_application_id,
        )
    return IntegrationStatus(
        configured=True,
        salon_id=integration.salon_id,
        application_id=integration.application_id,
        status=integration.status,
    )


@router.get("/calendar-users", response_model=list[CalendarUser])
def calendar_users(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[CalendarUser]:
    query = (
        select(YclientsStaffMapping, User)
        .join(User, User.id == YclientsStaffMapping.user_id)
        .where(User.is_active.is_(True))
        .order_by(User.display_name)
    )
    if not can_view_all_calendars(user):
        query = query.where(User.id == user.id)
    return [
        CalendarUser(user_id=mapping.user_id, display_name=mapped_user.display_name)
        for mapping, mapped_user in db.execute(query).all()
    ]


@router.get("/visits", response_model=list[VisitResponse])
def calendar_visits(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    start_date: Annotated[date, Query()],
    end_date: Annotated[date, Query()],
    user_id: Annotated[str | None, Query()] = None,
) -> list[VisitResponse]:
    if end_date < start_date or (end_date - start_date).days > 62:
        raise HTTPException(status_code=422, detail="Invalid calendar range")
    target_user_id = user.id if not can_view_all_calendars(user) else user_id
    query = select(YclientsVisit).where(
        YclientsVisit.deleted.is_(False),
        YclientsVisit.staff_id.not_in(select(YclientsStaffMapping.staff_id).join(User, User.id == YclientsStaffMapping.user_id).where(User.is_active.is_(False))),
        or_(YclientsVisit.user_id.is_(None), YclientsVisit.user_id.in_(select(User.id).where(User.is_active.is_(True)))),
        func.date(YclientsVisit.starts_at) >= start_date.isoformat(),
        func.date(YclientsVisit.starts_at) <= end_date.isoformat(),
    )
    if target_user_id is not None:
        query = query.where(YclientsVisit.user_id == target_user_id)
    visits = db.scalars(query.order_by(YclientsVisit.starts_at)).all()
    media_counts = {}
    if visits:
        media_counts = dict(
            db.execute(
                select(MediaFile.yclients_record_id, func.count(MediaFile.id))
                .where(
                    MediaFile.deleted_at.is_(None),
                    MediaFile.yclients_record_id.in_([visit.record_id for visit in visits]),
                )
                .group_by(MediaFile.yclients_record_id)
            ).all()
        )
    result = []
    for visit in visits:
        try:
            services = json.loads(visit.service_titles) if visit.service_titles else []
        except ValueError:
            services = []
        result.append(
            VisitResponse(
                record_id=visit.record_id,
                user_id=visit.user_id,
                starts_at=visit.starts_at.isoformat(),
                client_name=visit.client_display_name,
                services=services if isinstance(services, list) else [],
                comment=visit.comment,
                media_count=media_counts.get(visit.record_id, 0),
                staff_name=visit.user.display_name if visit.user is not None else None,
            )
        )
    return result


@router.post("/sync", response_model=SyncResult)
def sync_records(
    payload: SyncRequest,
    auth_session: Annotated[AuthSession, Depends(require_csrf)],
    owner: Annotated[User, Depends(require_owner)],
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[YclientsClient, Depends(get_yclients_client)],
) -> SyncResult:
    _ = auth_session
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid range")
    if (payload.end_date - payload.start_date).days > 366:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Range too large")
    integration = db.scalar(select(YclientsIntegration).limit(1))
    if integration is None or integration.status != "active":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="YCLIENTS integration is not active",
        )
    try:
        result = sync_yclients_visits(
            db=db,
            client=client,
            salon_id=integration.salon_id,
            start_date=payload.start_date,
            end_date=payload.end_date,
        )
    except (YclientsError, ValueError, KeyError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="YCLIENTS records synchronization failed",
        ) from exc
    db.add(
        AuditLog(
            actor_id=owner.id,
            action="yclients.sync_records",
            target_type="yclients_salon",
            target_id=str(integration.salon_id),
            details=f"{payload.start_date.isoformat()}:{payload.end_date.isoformat()}",
        )
    )
    db.commit()
    return SyncResult(**result)


@router.post("/webhook")
def marketplace_webhook(
    payload: MarketplaceWebhook,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    if payload.application_id != settings.yclients_application_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid application")
    try:
        expected_token = read_secret(settings.yclients_partner_token_file)
    except YclientsError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="YCLIENTS integration is not configured",
        ) from exc
    if not secrets.compare_digest(payload.partner_token, expected_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid token")

    integration = db.scalar(
        select(YclientsIntegration).where(YclientsIntegration.salon_id == payload.salon_id)
    )
    if integration is not None:
        integration.status = "disconnected" if payload.event == "uninstall" else "frozen"
        db.commit()
    return {"success": True}
