import json
from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from vita29.auth.dependencies import get_current_user, require_csrf
from vita29.db.models import (
    AuditLog,
    AuthSession,
    MediaBatch,
    MediaFile,
    User,
    UserRole,
    Workspace,
    WorkspaceKind,
    YclientsVisit,
)
from vita29.db.session import get_db
from vita29.discussions.service import (
    add_media_comment_message,
    attach_media_to_batch_comment,
    create_batch_discussion,
)
from vita29.media.places import get_place_resolver
from vita29.media.storage import (
    FileTooLargeError,
    InsufficientStorageError,
    InvalidMediaError,
    ThumbnailError,
    create_thumbnail,
    create_video_thumbnail,
    move_original,
    move_to_trash,
    original_path,
    restore_from_trash,
    restore_moved_original,
    store_upload,
    thumbnail_path,
)
from vita29.settings import Settings, get_settings
from vita29.workspaces.access import can_access_workspace

router = APIRouter(prefix="/media", tags=["media"])


class MediaResponse(BaseModel):
    id: str
    owner_id: str
    owner_name: str
    workspace_id: str
    workspace_name: str
    workspace_kind: str
    original_name: str
    media_type: str
    mime_type: str
    size_bytes: int
    created_at: datetime
    captured_at: datetime | None
    location_country: str | None
    location_city: str | None
    location_key: str | None
    can_delete: bool
    publication_allowed: bool
    comment: str | None
    batch_id: str | None
    batch_comment: str | None


class MoveMediaRequest(BaseModel):
    workspace_id: str


class PublicationRequest(BaseModel):
    publication_allowed: bool


class MediaCommentRequest(BaseModel):
    comment: str | None = None


class MediaBatchCreateRequest(BaseModel):
    workspace_id: str
    yclients_record_id: int | None = None
    comment: str | None = None


class MediaBatchResponse(BaseModel):
    id: str
    workspace_id: str
    yclients_record_id: int | None
    comment: str | None
    created_at: datetime


class MediaPlaceOption(BaseModel):
    key: str
    country: str | None
    city: str | None
    label: str


class MediaMonthOption(BaseModel):
    year: int
    month: int
    count: int


class MediaFilterOptions(BaseModel):
    years: list[int]
    months: list[MediaMonthOption]
    places: list[MediaPlaceOption]
    without_location_count: int


def media_response(media: MediaFile, user: User) -> MediaResponse:
    return MediaResponse(
        id=media.id,
        owner_id=media.owner_id,
        owner_name=media.owner.display_name,
        workspace_id=media.workspace_id,
        workspace_name=media.workspace.display_name,
        workspace_kind=media.workspace.kind.value,
        original_name=media.original_name,
        media_type=media.media_type.value,
        mime_type=media.mime_type,
        size_bytes=media.size_bytes,
        created_at=media.created_at,
        captured_at=media.captured_at,
        location_country=media.location_country,
        location_city=media.location_city,
        location_key=media.location_key,
        publication_allowed=media.publication_allowed,
        comment=media.comment,
        batch_id=media.batch_id,
        batch_comment=media.batch.comment if media.batch is not None else None,
        can_delete=(
            user.role != UserRole.EMPLOYEE
            or media.owner_id == user.id
            or media.uploaded_by_id == user.id
        ),
    )


def get_accessible_media(db: Session, file_id: str, user: User) -> MediaFile:
    media = db.get(MediaFile, file_id)
    if (
        media is None
        or media.deleted_at is not None
        or not can_access_workspace(db, media.workspace, user)
    ):
        raise HTTPException(status_code=404, detail="File not found")
    return media


def get_accessible_workspace(db: Session, workspace_id: str, user: User) -> Workspace:
    workspace = db.get(Workspace, workspace_id)
    if workspace is None or not can_access_workspace(db, workspace, user):
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


@router.get("", response_model=list[MediaResponse])
def list_media(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    workspace_id: Annotated[str | None, Query()] = None,
    date_from: Annotated[date | None, Query()] = None,
    date_to: Annotated[date | None, Query()] = None,
    procedure: Annotated[str | None, Query(max_length=160)] = None,
    client: Annotated[str | None, Query(max_length=200)] = None,
    yclients_record_id: Annotated[int | None, Query()] = None,
    calendar_date: Annotated[date | None, Query()] = None,
    capture_year: Annotated[int | None, Query(ge=1900, le=2200)] = None,
    capture_month: Annotated[int | None, Query(ge=1, le=12)] = None,
    location_key: Annotated[str | None, Query(max_length=220)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MediaResponse]:
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(status_code=400, detail="Start date must not be after end date")
    if workspace_id is not None:
        get_accessible_workspace(db, workspace_id, user)
        accessible_workspace_ids = [workspace_id]
    else:
        workspaces = db.scalars(select(Workspace).join(Workspace.owner)).all()
        accessible_workspace_ids = [
            workspace.id
            for workspace in workspaces
            if can_access_workspace(db, workspace, user)
        ]
    query = select(MediaFile).where(
        MediaFile.deleted_at.is_(None),
        MediaFile.workspace_id.in_(accessible_workspace_ids),
    )
    effective_date = func.coalesce(MediaFile.captured_at, MediaFile.created_at)
    local_timezone = timezone(timedelta(hours=settings.local_utc_offset_hours))
    visit_joined = False
    if calendar_date is not None:
        calendar_start = datetime.combine(
            calendar_date, time.min, tzinfo=local_timezone
        ).astimezone(UTC)
        calendar_end = datetime.combine(
            calendar_date + timedelta(days=1), time.min, tzinfo=local_timezone
        ).astimezone(UTC)
        query = query.outerjoin(
            YclientsVisit,
            MediaFile.yclients_record_id == YclientsVisit.record_id,
        ).where(
            or_(
                and_(effective_date >= calendar_start, effective_date < calendar_end),
                func.date(YclientsVisit.starts_at) == calendar_date.isoformat(),
            )
        )
        visit_joined = True
    if date_from is not None:
        query = query.where(
            effective_date
            >= datetime.combine(date_from, time.min, tzinfo=local_timezone).astimezone(UTC)
        )
    if date_to is not None:
        query = query.where(
            effective_date
            < datetime.combine(
                date_to + timedelta(days=1), time.min, tzinfo=local_timezone
            ).astimezone(UTC)
        )
    if capture_year is not None:
        query = query.where(func.strftime("%Y", effective_date) == str(capture_year))
    if capture_month is not None:
        query = query.where(func.strftime("%m", effective_date) == f"{capture_month:02d}")
    if location_key == "__none__":
        query = query.where(MediaFile.location_key.is_(None))
    elif location_key:
        query = query.where(MediaFile.location_key == location_key)
    normalized_procedure = procedure.strip() if procedure else ""
    normalized_client = client.strip() if client else ""

    if yclients_record_id is not None:
        query = query.where(MediaFile.yclients_record_id == yclients_record_id)

    if (normalized_procedure or normalized_client) and not visit_joined:
        query = query.join(
            YclientsVisit,
            MediaFile.yclients_record_id == YclientsVisit.record_id,
        )

    if normalized_procedure or normalized_client:

        if normalized_procedure:
            query = query.where(
                func.casefold(YclientsVisit.service_titles).contains(
                    normalized_procedure.casefold()
                )
            )

        if normalized_client:
            query = query.where(
                func.casefold(YclientsVisit.client_display_name).contains(
                    normalized_client.casefold()
                )
            )
    files = db.scalars(
        query.order_by(effective_date.desc(), MediaFile.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return [media_response(media, user) for media in files]


@router.get("/filter-options", response_model=MediaFilterOptions)
def media_filter_options(
    workspace_id: Annotated[str, Query()],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    capture_year: Annotated[int | None, Query(ge=1970, le=2200)] = None,
    capture_month: Annotated[int | None, Query(ge=1, le=12)] = None,
) -> MediaFilterOptions:
    get_accessible_workspace(db, workspace_id, user)
    effective_date = func.coalesce(MediaFile.captured_at, MediaFile.created_at)
    active_filter = (
        MediaFile.workspace_id == workspace_id,
        MediaFile.deleted_at.is_(None),
    )
    years = [
        int(value)
        for value in db.scalars(
            select(func.strftime("%Y", effective_date))
            .where(*active_filter)
            .distinct()
            .order_by(func.strftime("%Y", effective_date).desc())
        ).all()
        if value and str(value).isdigit()
    ]
    year_expression = func.strftime("%Y", effective_date)
    month_expression = func.strftime("%m", effective_date)
    month_rows = db.execute(
        select(
            year_expression,
            month_expression,
            func.count(MediaFile.id),
        )
        .where(*active_filter)
        .group_by(year_expression, month_expression)
        .order_by(year_expression.desc(), month_expression.desc())
    ).all()
    period_filter = list(active_filter)
    if capture_year is not None:
        period_filter.append(year_expression == f"{capture_year:04d}")
    if capture_month is not None:
        period_filter.append(month_expression == f"{capture_month:02d}")
    rows = db.execute(
        select(
            MediaFile.location_key,
            MediaFile.location_country,
            MediaFile.location_city,
        )
        .where(*period_filter, MediaFile.location_key.is_not(None))
        .distinct()
        .order_by(MediaFile.location_country, MediaFile.location_city, MediaFile.location_key)
    ).all()
    without_location_count = db.scalar(
        select(func.count(MediaFile.id)).where(
            *period_filter,
            MediaFile.location_key.is_(None),
        )
    ) or 0
    return MediaFilterOptions(
        years=years,
        months=[
            MediaMonthOption(year=int(year), month=int(month), count=int(count))
            for year, month, count in month_rows
            if year and month and str(year).isdigit() and str(month).isdigit()
        ],
        places=[
            MediaPlaceOption(
                key=key,
                country=country,
                city=city,
                label=key,
            )
            for key, country, city in rows
            if key
        ],
        without_location_count=int(without_location_count),
    )


@router.post(
    "/batches",
    response_model=MediaBatchResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_media_batch(
    payload: MediaBatchCreateRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MediaBatchResponse:
    if not user.can_upload_media:
        raise HTTPException(status_code=403, detail="Media upload is disabled")
    if payload.comment and not user.can_add_comments:
        raise HTTPException(status_code=403, detail="Comments are disabled")
    workspace = get_accessible_workspace(db, payload.workspace_id, user)

    visit = None
    if payload.yclients_record_id is not None:
        visit = db.get(YclientsVisit, payload.yclients_record_id)
        if visit is None or visit.deleted:
            raise HTTPException(status_code=404, detail="Visit not found")
        if user.role == UserRole.EMPLOYEE and visit.user_id != user.id:
            raise HTTPException(status_code=403, detail="You cannot use this visit")

    comment = payload.comment.strip() if payload.comment else None
    if comment and len(comment) > 4000:
        raise HTTPException(status_code=400, detail="Comment is too long")

    batch = MediaBatch(
        workspace_id=workspace.id,
        created_by_id=user.id,
        yclients_record_id=visit.record_id if visit is not None else None,
        comment=comment or None,
    )

    try:
        db.add(batch)
        db.flush()
        create_batch_discussion(db, batch, user)
        db.add(
            AuditLog(
                actor_id=user.id,
                action="media.batch.create",
                target_type="media_batch",
                target_id=batch.id,
                details=json.dumps(
                    {
                        "workspace_id": batch.workspace_id,
                        "yclients_record_id": batch.yclients_record_id,
                        "has_comment": bool(batch.comment),
                    }
                ),
            )
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Could not create media batch",
        ) from error

    db.refresh(batch)
    return MediaBatchResponse(
        id=batch.id,
        workspace_id=batch.workspace_id,
        yclients_record_id=batch.yclients_record_id,
        comment=batch.comment,
        created_at=batch.created_at,
    )


@router.post("", response_model=MediaResponse, status_code=status.HTTP_201_CREATED)
def upload_media(
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    upload: Annotated[UploadFile, File()],
    workspace_id: Annotated[str, Query()],
    publication_allowed: Annotated[bool, Query()] = False,
    yclients_record_id: Annotated[int | None, Query()] = None,
    batch_id: Annotated[str | None, Query()] = None,
) -> MediaResponse:
    if not user.can_upload_media:
        raise HTTPException(status_code=403, detail="Media upload is disabled")
    workspace = get_accessible_workspace(db, workspace_id, user)

    batch = None
    if batch_id is not None:
        batch = db.get(MediaBatch, batch_id)
        if batch is None:
            raise HTTPException(status_code=404, detail="Media batch not found")
        if batch.workspace_id != workspace.id:
            raise HTTPException(
                status_code=400,
                detail="Media batch belongs to another workspace",
            )
        if batch.created_by_id != user.id:
            raise HTTPException(
                status_code=403,
                detail="You cannot upload to this media batch",
            )
        if (
            yclients_record_id is not None
            and yclients_record_id != batch.yclients_record_id
        ):
            raise HTTPException(
                status_code=400,
                detail="Visit does not match media batch",
            )
        yclients_record_id = batch.yclients_record_id

    visit = None
    if yclients_record_id is not None:
        visit = db.get(YclientsVisit, yclients_record_id)
        if visit is None or visit.deleted:
            raise HTTPException(status_code=404, detail="Visit not found")
        if user.role == UserRole.EMPLOYEE and visit.user_id != user.id:
            raise HTTPException(status_code=403, detail="You cannot use this visit")
    try:
        stored = store_upload(upload, workspace.id, settings)
    except (InvalidMediaError, FileTooLargeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except InsufficientStorageError as error:
        raise HTTPException(status_code=507, detail=str(error)) from error

    location_country, location_city, location_key = get_place_resolver(
        str(settings.geonames_cities_path)
    ).resolve(stored.gps_latitude, stored.gps_longitude)

    media = MediaFile(
        owner_id=workspace.owner_id,
        workspace_id=workspace.id,
        uploaded_by_id=user.id,
        yclients_record_id=visit.record_id if visit is not None else None,
        publication_allowed=(
            True if workspace.kind == WorkspaceKind.PRIVATE else publication_allowed
        ),
        batch_id=batch.id if batch is not None else None,
        location_country=location_country,
        location_city=location_city,
        location_key=location_key,
        **stored.__dict__,
    )
    try:
        db.add(media)
        db.flush()
        attach_media_to_batch_comment(db, media)
        db.add(
            AuditLog(
                actor_id=user.id,
                action="media.upload",
                target_type="media_file",
                target_id=media.id,
                details=json.dumps(
                    {
                        "size_bytes": media.size_bytes,
                        "workspace_id": workspace.id,
                        "yclients_record_id": media.yclients_record_id,
                        "publication_allowed": media.publication_allowed,
                    "batch_id": media.batch_id,
                    }
                ),
            )
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        original_path(settings, stored.storage_key).unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save file metadata") from error
    db.refresh(media)
    return media_response(media, user)


@router.put("/{file_id}/workspace", response_model=MediaResponse)
def move_media(
    file_id: str,
    payload: MoveMediaRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MediaResponse:
    media = get_accessible_media(db, file_id, user)
    destination = get_accessible_workspace(db, payload.workspace_id, user)
    if destination.id == media.workspace_id:
        return media_response(media, user)

    previous_workspace_id = media.workspace_id
    previous_storage_key = media.storage_key
    try:
        destination_storage_key = move_original(
            settings,
            media.storage_key,
            destination.id,
            media.created_at,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Stored file not found") from error
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not move stored file") from error

    media.storage_key = destination_storage_key
    media.workspace = destination
    media.owner_id = destination.owner_id
    media.owner = destination.owner
    db.add(
        AuditLog(
            actor_id=user.id,
            action="media.move",
            target_type="media_file",
            target_id=media.id,
            details=json.dumps(
                {
                    "from_workspace_id": previous_workspace_id,
                    "to_workspace_id": destination.id,
                }
            ),
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        restore_moved_original(settings, destination_storage_key, previous_storage_key)
        raise HTTPException(status_code=500, detail="Could not save moved file") from error
    db.refresh(media)
    return media_response(media, user)


@router.put("/{file_id}/publication", response_model=MediaResponse)
def update_publication(
    file_id: str,
    payload: PublicationRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MediaResponse:
    media = get_accessible_media(db, file_id, user)
    previous = media.publication_allowed
    media.publication_allowed = (
        True if media.workspace.kind == WorkspaceKind.PRIVATE else payload.publication_allowed
    )
    db.add(
        AuditLog(
            actor_id=user.id,
            action="media.publication.update",
            target_type="media_file",
            target_id=media.id,
            details=json.dumps(
                {
                    "from": previous,
                    "to": media.publication_allowed,
                }
            ),
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not update publication status") from error
    db.refresh(media)
    return media_response(media, user)


@router.put("/{file_id}/comment", response_model=MediaResponse)
def update_comment(
    file_id: str,
    payload: MediaCommentRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MediaResponse:
    if not user.can_add_comments:
        raise HTTPException(status_code=403, detail="Comments are disabled")
    media = get_accessible_media(db, file_id, user)
    if media.workspace.kind == WorkspaceKind.PRIVATE and media.uploaded_by_id != user.id:
        raise HTTPException(status_code=403, detail="Only the uploader can comment on private media")
    comment = payload.comment.strip() if payload.comment else None
    if comment and len(comment) > 4000:
        raise HTTPException(status_code=422, detail="Comment is too long")
    media.comment = comment or None
    if comment:
        add_media_comment_message(db, media, user, comment)
    db.add(
        AuditLog(
            actor_id=user.id,
            action="media.comment.update",
            target_type="media_file",
            target_id=media.id,
            details=json.dumps({"has_comment": media.comment is not None}),
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not update comment") from error
    db.refresh(media)
    return media_response(media, user)


@router.get("/{file_id}/preview")
def preview_media(
    file_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> FileResponse:
    media = get_accessible_media(db, file_id, user)
    path = original_path(settings, media.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file not found")
    return FileResponse(
        path,
        media_type=media.mime_type,
        filename=media.original_name,
        content_disposition_type="inline",
    )


@router.get("/{file_id}/thumbnail")
def thumbnail(
    file_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> FileResponse:
    media = get_accessible_media(db, file_id, user)
    try:
        path = (
            create_thumbnail(settings, media.storage_key, media.id)
            if media.media_type.value == "image"
            else create_video_thumbnail(settings, media.storage_key, media.id)
        )
    except ThumbnailError as error:
        raise HTTPException(status_code=422, detail="Could not create thumbnail") from error
    return FileResponse(path, media_type="image/jpeg")


@router.get("/{file_id}/download")
def download_media(
    file_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> FileResponse:
    media = get_accessible_media(db, file_id, user)
    path = original_path(settings, media.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file not found")
    db.add(
        AuditLog(
            actor_id=user.id,
            action="media.download",
            target_type="media_file",
            target_id=media.id,
        )
    )
    db.commit()
    return FileResponse(path, media_type=media.mime_type, filename=media.original_name)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_media(
    file_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    media = get_accessible_media(db, file_id, user)
    if (
        user.role == UserRole.EMPLOYEE
        and media.owner_id != user.id
        and media.uploaded_by_id != user.id
    ):
        raise HTTPException(status_code=403, detail="You cannot delete this file")
    trash_path = move_to_trash(settings, media.storage_key, media.id)
    media.deleted_at = datetime.now(UTC)
    db.add(
        AuditLog(
            actor_id=user.id,
            action="media.delete",
            target_type="media_file",
            target_id=media.id,
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        if trash_path is not None:
            restore_from_trash(settings, media.storage_key, trash_path)
        raise HTTPException(status_code=500, detail="Could not delete file") from error
    thumbnail_path(settings, media.id).unlink(missing_ok=True)
