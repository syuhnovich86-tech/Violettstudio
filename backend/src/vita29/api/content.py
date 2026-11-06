import json
from datetime import UTC, date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from vita29.auth.dependencies import require_content_access, require_csrf
from vita29.content.agent import (
    ContentAgentError,
    ensure_openai_response,
    openai_ipv4_client,
    prepare_telegram_draft,
    read_openai_secret,
    recognize_template_staff,
    staff_from_title,
    template_for_staff,
)
from vita29.content.availability_image import render_availability_image
from vita29.content.instagram import InstagramPublishError, publish_to_instagram
from vita29.content.telegram import TelegramPublishError, publish_to_channel
from vita29.content.visual import (
    append_editor_instruction,
    generate_branded_visual,
    requires_generated_visual,
)
from vita29.db.models import (
    AuditLog,
    AuthSession,
    ContentFormat,
    ContentItem,
    ContentPublication,
    ContentStatus,
    MediaFile,
    MediaType,
    PublicationPlatform,
    PublicationStatus,
    User,
    Workspace,
    WorkspaceKind,
    YclientsIntegration,
    YclientsStaffMapping,
    utc_now,
)
from vita29.db.session import get_db
from vita29.settings import get_settings
from vita29.workspaces.access import can_access_workspace
from vita29.yclients.client import YclientsClient, YclientsError, get_yclients_client

router = APIRouter(prefix="/content", tags=["content"])


class ContentPublicationResponse(BaseModel):
    id: str
    platform: PublicationPlatform
    publication_format: str
    status: PublicationStatus
    caption: str | None
    media_ids: list[str]
    external_id: str | None
    error: str | None
    published_at: datetime | None


class ContentItemResponse(BaseModel):
    id: str
    title: str
    caption: str | None
    editor_instruction: str | None
    visual_edit_requested: bool
    visual_style: Literal["auto", "light", "dark"]
    content_format: ContentFormat
    media_limit: int
    availability_staff_id: int | None
    availability_slots: list[dict[str, object]]
    status: ContentStatus
    scheduled_at: datetime
    media_ids: list[str]
    created_by_id: str
    approved_by_id: str | None
    approved_at: datetime | None
    publications: list[ContentPublicationResponse]
    created_at: datetime
    updated_at: datetime


class ContentItemCreate(BaseModel):
    title: str = Field(min_length=2, max_length=180)
    caption: str | None = Field(default=None, max_length=5000)
    editor_instruction: str | None = Field(default=None, max_length=1000)
    visual_edit_requested: bool = False
    visual_style: Literal["auto", "light", "dark"] = "auto"
    scheduled_at: datetime
    platforms: list[PublicationPlatform] = Field(min_length=1)
    platform_formats: dict[PublicationPlatform, str] = Field(default_factory=dict)
    media_ids: list[str] = Field(default_factory=list, max_length=10)
    content_format: ContentFormat = ContentFormat.POST
    media_limit: int = Field(default=1, ge=1, le=10)
    availability_staff_id: int | None = Field(default=None, gt=0)

    @field_validator("platforms")
    @classmethod
    def unique_platforms(cls, value: list[PublicationPlatform]) -> list[PublicationPlatform]:
        return list(dict.fromkeys(value))

    @field_validator("platform_formats")
    @classmethod
    def valid_platform_formats(cls, value: dict[PublicationPlatform, str]) -> dict[PublicationPlatform, str]:
        for platform, format_name in value.items():
            if format_name not in {"post", "story", "reel"} or (platform == PublicationPlatform.MAX and format_name != "post"):
                raise ValueError("Недопустимый формат площадки")
        return value


class ContentItemUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=180)
    caption: str | None = Field(default=None, max_length=5000)
    editor_instruction: str | None = Field(default=None, max_length=1000)
    visual_edit_requested: bool | None = None
    visual_style: Literal["auto", "light", "dark"] | None = None
    append_editor_instruction: bool = False
    scheduled_at: datetime | None = None
    platforms: list[PublicationPlatform] | None = Field(default=None, min_length=1)
    platform_formats: dict[PublicationPlatform, str] | None = None
    media_ids: list[str] | None = Field(default=None, max_length=10)
    content_format: ContentFormat | None = None
    media_limit: int | None = Field(default=None, ge=1, le=10)
    availability_staff_id: int | None = Field(default=None, gt=0)
    status: ContentStatus | None = None

    @field_validator("platforms")
    @classmethod
    def unique_platforms(cls, value: list[PublicationPlatform] | None) -> list[PublicationPlatform] | None:
        return list(dict.fromkeys(value)) if value else value

    @field_validator("platform_formats")
    @classmethod
    def valid_platform_formats(cls, value: dict[PublicationPlatform, str] | None) -> dict[PublicationPlatform, str] | None:
        if value is None:
            return value
        for platform, format_name in value.items():
            if format_name not in {"post", "story", "reel"} or (platform == PublicationPlatform.MAX and format_name != "post"):
                raise ValueError("Недопустимый формат площадки")
        return value


class ContentPlanCreate(BaseModel):
    items: list[ContentItemCreate] = Field(min_length=1, max_length=100)


class PublicationCaptionUpdate(BaseModel):
    caption: str = Field(min_length=1, max_length=4000)


class AvailabilityStaffResponse(BaseModel):
    staff_id: int
    staff_name: str
    specialization: str | None = None


class AvailabilityResponse(BaseModel):
    staff: list[AvailabilityStaffResponse]
    slots: list[dict[str, object]]


class ContentLibraryMediaResponse(BaseModel):
    id: str
    original_name: str
    media_type: MediaType
    thumbnail_url: str
    comment: str | None
    content_marked: bool
    workspace_id: str
    workspace_name: str


class ContentLibraryWorkspaceResponse(BaseModel):
    id: str
    display_name: str
    kind: WorkspaceKind


class ContentLibraryResponse(BaseModel):
    items: list[ContentLibraryMediaResponse]
    workspaces: list[ContentLibraryWorkspaceResponse]
    total: int
    next_offset: int | None


class VisualGenerateRequest(BaseModel):
    instruction: str = Field(min_length=2, max_length=1000)
    source_media_ids: list[str] = Field(default_factory=list, max_length=10)


class VoiceTranscriptionResponse(BaseModel):
    text: str


_MAX_VOICE_TRANSCRIPTION_BYTES = 10 * 1024 * 1024
_VOICE_AUDIO_EXTENSIONS = {".webm", ".ogg", ".mp3", ".mp4", ".m4a", ".wav"}
_VOICE_AUDIO_TYPES = {
    "audio/webm",
    "video/webm",
    "audio/ogg",
    "application/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/wav",
    "audio/x-wav",
}
_VOICE_TRANSCRIPTION_PROMPT = (
    "Русская речь для контент-плана студии эстетики VIOLETTA. "
    "Возможные названия услуг: перманентный макияж, стрелки, брови, губы, "
    "ламинирование ресниц, RF-лифтинг, СМАС-лифтинг, био, пирсинг."
)


@router.post("/transcribe", response_model=VoiceTranscriptionResponse)
def transcribe_content_voice(
    audio: Annotated[UploadFile, File(...)],
    _: Annotated[AuthSession, Depends(require_csrf)],
    __: Annotated[User, Depends(require_content_access)],
) -> VoiceTranscriptionResponse:
    """Transcribe a short editor dictation without storing its audio persistently."""
    filename = audio.filename or "dictation.webm"
    extension = Path(filename).suffix.casefold()
    content_type = (audio.content_type or "").split(";", 1)[0].casefold()
    if extension not in _VOICE_AUDIO_EXTENSIONS or (content_type and content_type not in _VOICE_AUDIO_TYPES):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Нужна аудиозапись в формате WebM, M4A, MP3, OGG или WAV")

    try:
        audio_bytes = audio.file.read(_MAX_VOICE_TRANSCRIPTION_BYTES + 1)
    finally:
        audio.file.close()
    if not audio_bytes:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Запись пуста. Попробуйте сказать фразу ещё раз")
    if len(audio_bytes) > _MAX_VOICE_TRANSCRIPTION_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Голосовая запись слишком длинная. Остановите запись раньше и повторите")

    settings = get_settings()
    try:
        api_key = read_openai_secret(settings)
        with openai_ipv4_client(settings.openai_http_timeout_seconds) as client:
            response = client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                data={"model": "gpt-transcribe", "prompt": _VOICE_TRANSCRIPTION_PROMPT},
                files={"file": (filename, audio_bytes, content_type or "audio/webm")},
            )
        ensure_openai_response(response)
        response.raise_for_status()
        payload = response.json()
    except ContentAgentError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Голосовой ввод пока недоступен: " + str(error)) from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Не удалось распознать голос. Попробуйте ещё раз") from error

    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Речь не удалось распознать. Говорите ближе к микрофону и повторите")
    return VoiceTranscriptionResponse(text=text.strip())


@router.get("/media-library", response_model=ContentLibraryResponse)
def content_media_library(
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
    workspace_id: Annotated[str | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=160)] = None,
    limit: Annotated[int, Query(ge=1, le=120)] = 60,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ContentLibraryResponse:
    """List only media the editor can access and is permitted to publish."""
    accessible_workspaces = [
        workspace for workspace in db.scalars(select(Workspace).order_by(Workspace.display_name)).all()
        if can_access_workspace(db, workspace, user)
    ]
    accessible_ids = [workspace.id for workspace in accessible_workspaces]
    if workspace_id is not None and workspace_id not in accessible_ids:
        raise HTTPException(status_code=404, detail="Папка недоступна")
    selected_ids = [workspace_id] if workspace_id else accessible_ids
    if not selected_ids:
        return ContentLibraryResponse(items=[], workspaces=[], total=0, next_offset=None)
    filters = [
        MediaFile.deleted_at.is_(None),
        MediaFile.publication_allowed.is_(True),
        MediaFile.media_type.in_([MediaType.IMAGE, MediaType.VIDEO]),
        MediaFile.workspace_id.in_(selected_ids),
    ]
    if search and search.strip():
        needle = f"%{search.strip()}%"
        filters.append(or_(MediaFile.original_name.ilike(needle), MediaFile.comment.ilike(needle)))
    total = db.scalar(select(func.count(MediaFile.id)).where(*filters)) or 0
    files = db.scalars(
        select(MediaFile)
        .join(Workspace, MediaFile.workspace_id == Workspace.id)
        .where(*filters)
        .order_by(MediaFile.content_marked.desc(), MediaFile.captured_at.desc(), MediaFile.created_at.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return ContentLibraryResponse(
        items=[ContentLibraryMediaResponse(
            id=file.id,
            original_name=file.original_name,
            media_type=file.media_type,
            thumbnail_url=f"/api/v1/media/{file.id}/thumbnail",
            comment=file.comment,
            content_marked=file.content_marked,
            workspace_id=file.workspace_id,
            workspace_name=file.workspace.display_name,
        )
        for file in files],
        workspaces=[ContentLibraryWorkspaceResponse(id=workspace.id, display_name=workspace.display_name, kind=workspace.kind) for workspace in accessible_workspaces],
        total=total,
        next_offset=offset + len(files) if offset + len(files) < total else None,
    )


def validate_content_media_selection(db: Session, user: User, media_ids: list[str], limit: int) -> list[str]:
    """Reject forbidden or inaccessible manual material before it enters a plan."""
    selected = list(dict.fromkeys(media_ids))
    if len(selected) > limit:
        raise HTTPException(status_code=422, detail=f"Можно выбрать не более {limit} материалов")
    if not selected:
        return []
    files = db.scalars(select(MediaFile).where(MediaFile.id.in_(selected))).all()
    by_id = {media.id: media for media in files}
    for media_id in selected:
        media = by_id.get(media_id)
        if (
            media is None or media.deleted_at is not None or not media.publication_allowed
            or media.media_type not in {MediaType.IMAGE, MediaType.VIDEO}
            or not can_access_workspace(db, media.workspace, user)
        ):
            raise HTTPException(status_code=422, detail="Выберите доступные материалы, разрешённые для публикации")
    return selected


@router.get("/availability/staff", response_model=list[AvailabilityStaffResponse])
def list_availability_staff(
    _: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> list[AvailabilityStaffResponse]:
    integration = db.scalar(select(YclientsIntegration).where(YclientsIntegration.status == "active"))
    if integration is None:
        return []
    mappings = db.scalars(
        select(YclientsStaffMapping)
        .where(YclientsStaffMapping.salon_id == integration.salon_id)
        .order_by(YclientsStaffMapping.staff_name)
    ).all()
    # A free-window card is valid only when the studio has one, unambiguous
    # branded template for that specific master.  Do not show other staff in
    # the picker: selecting them would inevitably produce a misleading card.
    available: list[AvailabilityStaffResponse] = []
    for item in mappings:
        try:
            template_for_staff(db, item.staff_id, mappings)
        except ContentAgentError:
            continue
        available.append(
            AvailabilityStaffResponse(
                staff_id=item.staff_id,
                staff_name=item.staff_name,
                specialization=item.specialization,
            )
        )
    return available


def response_for(db: Session, item: ContentItem) -> ContentItemResponse:
    publications = db.scalars(
        select(ContentPublication)
        .where(ContentPublication.content_item_id == item.id)
        .order_by(ContentPublication.platform)
    ).all()
    try:
        media_ids = json.loads(item.media_ids_json)
    except (TypeError, json.JSONDecodeError):
        media_ids = []
    try:
        availability_slots = json.loads(item.availability_slots_json)
    except (TypeError, json.JSONDecodeError):
        availability_slots = []
    return ContentItemResponse(
        id=item.id,
        title=item.title,
        caption=item.caption,
        editor_instruction=item.editor_instruction,
        visual_edit_requested=item.visual_edit_requested,
        visual_style=item.visual_style,
        content_format=item.content_format,
        media_limit=item.media_limit,
        availability_staff_id=item.availability_staff_id,
        availability_slots=availability_slots if isinstance(availability_slots, list) else [],
        status=item.status,
        scheduled_at=item.scheduled_at,
        media_ids=media_ids if isinstance(media_ids, list) else [],
        created_by_id=item.created_by_id,
        approved_by_id=item.approved_by_id,
        approved_at=item.approved_at,
        publications=[publication_response(publication) for publication in publications],
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def publication_response(publication: ContentPublication) -> ContentPublicationResponse:
    try:
        media_ids = json.loads(publication.media_ids_json)
    except (TypeError, json.JSONDecodeError):
        media_ids = []
    return ContentPublicationResponse(
        id=publication.id,
        platform=publication.platform,
        publication_format=publication.publication_format,
        status=publication.status,
        caption=publication.caption,
        media_ids=media_ids if isinstance(media_ids, list) else [],
        external_id=publication.external_id,
        error=publication.error,
        published_at=publication.published_at,
    )


def get_item(db: Session, item_id: str) -> ContentItem:
    item = db.get(ContentItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Content item not found")
    return item


def get_publication(
    db: Session, item: ContentItem, platform: PublicationPlatform
) -> ContentPublication:
    publication = db.scalar(
        select(ContentPublication).where(
            ContentPublication.content_item_id == item.id,
            ContentPublication.platform == platform,
        )
    )
    if publication is None:
        raise HTTPException(status_code=404, detail="This platform is not selected for the topic")
    return publication


def update_item_status_after_publication(db: Session, item: ContentItem) -> None:
    publications = db.scalars(
        select(ContentPublication).where(ContentPublication.content_item_id == item.id)
    ).all()
    if publications and all(job.status == PublicationStatus.PUBLISHED for job in publications):
        item.status = ContentStatus.PUBLISHED
    elif any(job.status == PublicationStatus.FAILED for job in publications):
        item.status = ContentStatus.FAILED
    else:
        item.status = ContentStatus.READY


def collect_availability(
    db: Session, client: YclientsClient, week_start: date, staff_id: int | None = None
) -> tuple[list[YclientsStaffMapping], list[dict[str, object]]]:
    integration = db.scalar(select(YclientsIntegration).where(YclientsIntegration.status == "active"))
    if integration is None:
        raise HTTPException(status_code=409, detail="YCLIENTS is not connected")
    mappings = db.scalars(
        select(YclientsStaffMapping)
        .where(YclientsStaffMapping.salon_id == integration.salon_id)
        .order_by(YclientsStaffMapping.staff_name)
    ).all()
    if staff_id is not None:
        mappings = [mapping for mapping in mappings if mapping.staff_id == staff_id]
        if not mappings:
            raise HTTPException(status_code=404, detail="Master is not available")

    # YCLIENTS rejects a request for a day that has already passed.  A
    # content plan can still show the whole calendar week, but availability
    # must be calculated only for its remaining days.
    local_timezone = timezone(timedelta(hours=client.settings.local_utc_offset_hours))
    # Never advertise a partly elapsed hour.  A card made at 15:22 may begin
    # only with 16:00 (or later), even if YCLIENTS still reports a 15:30 slot.
    local_now = datetime.now(local_timezone)
    earliest_slot_time = (local_now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)).time()
    local_today = local_now.date()
    week_end = week_start + timedelta(days=6)
    first_available_day = max(week_start, local_today)

    slots: list[dict[str, object]] = []
    try:
        if first_available_day > week_end:
            return mappings, slots
        days_to_check = (week_end - first_available_day).days + 1
        for mapping in mappings:
            for offset in range(days_to_check):
                day = first_available_day + timedelta(days=offset)
                times = client.list_book_times(integration.salon_id, mapping.staff_id, day.isoformat())
                if day == local_today:
                    future_times: list[str] = []
                    for value in times:
                        try:
                            slot_time = time.fromisoformat(value[:5])
                        except ValueError:
                            continue
                        if slot_time >= earliest_slot_time:
                            future_times.append(value)
                    times = future_times
                if times:
                    slots.append({
                        "staff_id": mapping.staff_id,
                        "staff_name": mapping.staff_name,
                        "date": day.isoformat(),
                        "times": times[:8],
                    })
    except YclientsError as error:
        raise HTTPException(
            status_code=502,
            detail="Не удалось получить свободные окна из YCLIENTS. Повторите попытку чуть позже.",
        ) from error
    return mappings, slots


_GENERATION_LEAD = timedelta(minutes=30)
_GENERATION_SLOT = timedelta(minutes=30)


def earliest_content_schedule(settings) -> datetime:
    """Return the first safe publication time in the studio time zone.

    A content item needs time to be generated and checked.  More importantly,
    this keeps a freshly created plan from silently being placed in the past
    when its default time (for example, 10:00) has already passed today.
    """
    local_timezone = timezone(timedelta(hours=settings.local_utc_offset_hours))
    candidate = datetime.now(local_timezone) + _GENERATION_LEAD
    candidate = candidate.replace(second=0, microsecond=0)
    remainder = candidate.minute % 30
    if remainder:
        candidate += timedelta(minutes=30 - remainder)
    return candidate.astimezone(UTC)


def future_content_schedule(
    requested_at: datetime, settings, *, not_before: datetime | None = None
) -> datetime:
    """Keep content generation and publication out of the past."""
    local_timezone = timezone(timedelta(hours=settings.local_utc_offset_hours))
    if requested_at.tzinfo is None:
        requested_at = requested_at.replace(tzinfo=local_timezone)
    requested_utc = requested_at.astimezone(UTC)
    earliest = not_before or earliest_content_schedule(settings)
    return max(requested_utc, earliest)


@router.get("/availability", response_model=AvailabilityResponse)
def list_availability(
    week_start: Annotated[date, Query()],
    _: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
    client: YclientsClient = Depends(get_yclients_client),
    staff_id: Annotated[int | None, Query(gt=0)] = None,
) -> AvailabilityResponse:
    mappings, slots = collect_availability(db, client, week_start, staff_id)
    return AvailabilityResponse(
        staff=[AvailabilityStaffResponse(staff_id=item.staff_id, staff_name=item.staff_name) for item in mappings],
        slots=slots,
    )


@router.get("/items", response_model=list[ContentItemResponse])
def list_content_items(
    week_start: Annotated[date, Query()],
    _: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ContentItemResponse]:
    settings = get_settings()
    local_timezone = timezone(timedelta(hours=settings.local_utc_offset_hours))
    starts_at = datetime.combine(week_start, time.min, tzinfo=local_timezone).astimezone(UTC)
    ends_at = starts_at + timedelta(days=7)
    items = db.scalars(
        select(ContentItem)
        .where(ContentItem.scheduled_at >= starts_at, ContentItem.scheduled_at < ends_at)
        .order_by(ContentItem.scheduled_at, ContentItem.created_at)
    ).all()
    return [response_for(db, item) for item in items]


@router.post("/items", response_model=ContentItemResponse, status_code=status.HTTP_201_CREATED)
def create_content_item(
    payload: ContentItemCreate,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    settings = get_settings()
    media_ids = (
        [] if payload.content_format == ContentFormat.AVAILABILITY
        else validate_content_media_selection(db, user, payload.media_ids, payload.media_limit)
    )
    item = ContentItem(
        title=payload.title.strip(),
        caption=payload.caption.strip() if payload.caption else None,
        editor_instruction=payload.editor_instruction.strip() if payload.editor_instruction else None,
        visual_edit_requested=payload.visual_edit_requested,
        visual_style=payload.visual_style,
        scheduled_at=future_content_schedule(payload.scheduled_at, settings),
        media_ids_json=json.dumps(media_ids),
        content_format=payload.content_format,
        media_limit=payload.media_limit,
        availability_staff_id=payload.availability_staff_id,
        created_by_id=user.id,
    )
    db.add(item)
    db.flush()
    for platform in payload.platforms:
        db.add(ContentPublication(content_item_id=item.id, platform=platform, publication_format=payload.platform_formats.get(platform, "post")))
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/bulk", response_model=list[ContentItemResponse], status_code=status.HTTP_201_CREATED)
def create_content_plan(
    payload: ContentPlanCreate,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ContentItemResponse]:
    settings = get_settings()
    items: list[ContentItem] = []
    next_automatic_slot = earliest_content_schedule(settings)
    for entry in payload.items:
        requested_at = entry.scheduled_at
        scheduled_at = future_content_schedule(
            requested_at, settings, not_before=next_automatic_slot
        )
        local_timezone = timezone(timedelta(hours=settings.local_utc_offset_hours))
        if requested_at.tzinfo is None:
            requested_at = requested_at.replace(tzinfo=local_timezone)
        if requested_at.astimezone(UTC) < next_automatic_slot:
            next_automatic_slot = scheduled_at + _GENERATION_SLOT
        item = ContentItem(
            title=entry.title.strip(),
            caption=None,
            visual_edit_requested=entry.visual_edit_requested,
            visual_style=entry.visual_style,
            scheduled_at=scheduled_at,
            media_ids_json="[]",
            content_format=entry.content_format,
            media_limit=entry.media_limit,
            availability_staff_id=entry.availability_staff_id,
            created_by_id=user.id,
        )
        db.add(item)
        db.flush()
        for platform in entry.platforms:
            db.add(ContentPublication(content_item_id=item.id, platform=platform, publication_format=entry.platform_formats.get(platform, "post")))
        items.append(item)
    db.commit()
    for item in items:
        db.refresh(item)
    return [response_for(db, item) for item in items]


@router.patch("/items/{item_id}", response_model=ContentItemResponse)
def update_content_item(
    item_id: str,
    payload: ContentItemUpdate,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    item = get_item(db, item_id)
    changes = payload.model_dump(exclude_unset=True)
    append_instruction = bool(changes.pop("append_editor_instruction", False))
    effective_format = changes.get("content_format", item.content_format)
    effective_limit = changes.get("media_limit", item.media_limit)
    if "media_ids" in changes and effective_format != ContentFormat.AVAILABILITY:
        changes["media_ids"] = validate_content_media_selection(
            db, user, changes["media_ids"], effective_limit
        )
    if "title" in changes:
        item.title = changes["title"].strip()
    if "caption" in changes:
        item.caption = changes["caption"].strip() if changes["caption"] else None
    if "editor_instruction" in changes:
        next_instruction = changes["editor_instruction"].strip() if changes["editor_instruction"] else None
        item.editor_instruction = (
            append_editor_instruction(item.editor_instruction, next_instruction)
            if append_instruction and next_instruction
            else next_instruction
        )
    if "visual_edit_requested" in changes:
        item.visual_edit_requested = bool(changes["visual_edit_requested"])
    if "visual_style" in changes:
        item.visual_style = changes["visual_style"]
    if "scheduled_at" in changes:
        item.scheduled_at = future_content_schedule(changes["scheduled_at"], get_settings())
    if "media_ids" in changes:
        item.media_ids_json = json.dumps(changes["media_ids"])
    if "content_format" in changes:
        item.content_format = changes["content_format"]
    if "media_limit" in changes:
        item.media_limit = changes["media_limit"]
    if "availability_staff_id" in changes:
        item.availability_staff_id = changes["availability_staff_id"]
    if "status" in changes:
        requested_status = changes["status"]
        if requested_status in {ContentStatus.APPROVED, ContentStatus.SCHEDULED}:
            item.approved_by_id = user.id
            item.approved_at = utc_now()
        elif requested_status in {ContentStatus.PUBLISHED, ContentStatus.FAILED}:
            raise HTTPException(status_code=400, detail="Publication status is updated automatically")
        else:
            item.approved_by_id = None
            item.approved_at = None
        item.status = requested_status
    if "platforms" in changes:
        published = db.scalar(
            select(ContentPublication.id).where(
                ContentPublication.content_item_id == item.id,
                ContentPublication.status == PublicationStatus.PUBLISHED,
            ).limit(1)
        )
        if published:
            raise HTTPException(status_code=409, detail="Published platforms cannot be replaced")
        db.execute(delete(ContentPublication).where(ContentPublication.content_item_id == item.id))
        db.flush()
        platform_formats = changes.get("platform_formats") or {}
        for platform in changes["platforms"]:
            db.add(ContentPublication(
                content_item_id=item.id,
                platform=platform,
                publication_format=platform_formats.get(platform, "post"),
            ))
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/{item_id}/rollback", response_model=ContentItemResponse)
def rollback_content_item(
    item_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    __: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    """Return a planned item to a draft without touching its prepared media or text."""
    item = get_item(db, item_id)
    published = db.scalar(
        select(ContentPublication.id).where(
            ContentPublication.content_item_id == item.id,
            ContentPublication.status == PublicationStatus.PUBLISHED,
        ).limit(1)
    )
    if published:
        raise HTTPException(status_code=409, detail="An already published item cannot be rolled back")

    item.status = ContentStatus.DRAFT
    item.approved_by_id = None
    item.approved_at = None
    db.execute(
        update(ContentPublication)
        .where(
            ContentPublication.content_item_id == item.id,
            ContentPublication.status != PublicationStatus.PUBLISHED,
        )
        .values(status=PublicationStatus.PENDING, error=None)
    )
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/{item_id}/prepare", response_model=ContentItemResponse)
def prepare_content_item(
    item_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    """Prepare a content draft for every selected platform; never publish it."""
    item = get_item(db, item_id)
    if item.status not in {ContentStatus.DRAFT, ContentStatus.REVIEW, ContentStatus.APPROVED, ContentStatus.FAILED, ContentStatus.READY}:
        raise HTTPException(status_code=409, detail="This item cannot be prepared now")
    publications = db.scalars(
        select(ContentPublication).where(ContentPublication.content_item_id == item.id)
    ).all()
    if not publications:
        raise HTTPException(status_code=409, detail="Не выбрана ни одна площадка")
    explicit_source_media: list[MediaFile] = []
    if item.content_format != ContentFormat.AVAILABILITY:
        try:
            selected_ids = json.loads(item.media_ids_json)
        except (TypeError, ValueError, json.JSONDecodeError):
            selected_ids = []
        if isinstance(selected_ids, list):
            # A content editor may be different from the original author, so
            # check access again at the moment material is sent to the model.
            validate_content_media_selection(db, user, selected_ids, item.media_limit)
            if selected_ids:
                explicit_source_media = db.scalars(
                    select(MediaFile).where(MediaFile.id.in_(selected_ids))
                ).all()
    if item.content_format == ContentFormat.AVAILABILITY:
        settings = get_settings()
        integration = db.scalar(select(YclientsIntegration).where(YclientsIntegration.status == "active"))
        if integration is None:
            raise HTTPException(status_code=409, detail="YCLIENTS is not connected")
        mappings = db.scalars(
            select(YclientsStaffMapping)
            .where(YclientsStaffMapping.salon_id == integration.salon_id)
            .order_by(YclientsStaffMapping.staff_name)
        ).all()
        # An explicitly named master in the topic is the source of truth. This
        # also repairs older drafts that accidentally saved a different master.
        named_staff = staff_from_title(item.title, mappings)
        if named_staff is not None:
            item.availability_staff_id = named_staff.staff_id
        if item.availability_staff_id is None:
            try:
                recognized = recognize_template_staff(db, settings, mappings, item.title)
            except ContentAgentError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            item.availability_staff_id = recognized.staff_id
            template = db.get(MediaFile, recognized.media_id)
        else:
            try:
                template = template_for_staff(db, item.availability_staff_id, mappings)
            except ContentAgentError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
        if template is None:
            raise HTTPException(status_code=422, detail="Не удалось найти шаблон свободных окон")
        item.media_ids_json = json.dumps([template.id])
        scheduled_day = item.scheduled_at.astimezone(
            timezone(timedelta(hours=settings.local_utc_offset_hours))
        ).date()
        # The template is a Monday-to-Sunday card.  Pass the beginning of its
        # calendar week so a Tuesday publication does not accidentally put the
        # following Monday into the first row of the current card.
        template_week_start = scheduled_day - timedelta(days=scheduled_day.weekday())
        _, slots = collect_availability(
            db,
            YclientsClient(settings),
            template_week_start,
            item.availability_staff_id,
        )
        if not slots:
            mapping = next(
                (entry for entry in mappings if entry.staff_id == item.availability_staff_id),
                None,
            )
            master_name = mapping.staff_name if mapping else "выбранного мастера"
            message = (
                f"У мастера «{master_name}» в YCLIENTS нет свободных окон "
                "для онлайн-записи длительностью от часа на ближайшие 7 дней. "
                "Карточка не собрана: проверьте график и онлайн-запись в YCLIENTS "
                "либо выберите другого мастера."
            )
            item.status = ContentStatus.FAILED
            for publication in publications:
                publication.status = PublicationStatus.FAILED
                publication.error = message
            db.commit()
            raise HTTPException(status_code=409, detail=message)
        item.availability_slots_json = json.dumps(slots, ensure_ascii=False)
    item.status = ContentStatus.GENERATING
    for publication in publications:
        publication.status = PublicationStatus.PENDING
        publication.error = None
    db.commit()
    settings = get_settings()
    try:
        draft = prepare_telegram_draft(db, item, settings)
    except ContentAgentError as error:
        item.status = ContentStatus.FAILED
        for publication in publications:
            publication.status = PublicationStatus.FAILED
            publication.error = str(error)
        db.commit()
        raise HTTPException(status_code=502, detail=str(error)) from error
    for publication in publications:
        publication.caption = draft.caption
    if item.content_format == ContentFormat.AVAILABILITY:
        try:
            rendered = render_availability_image(
                db, settings, item, template, json.loads(item.availability_slots_json), user.id
            )
        except (OSError, ValueError, TypeError) as error:
            item.status = ContentStatus.FAILED
            for publication in publications:
                publication.status = PublicationStatus.FAILED
                publication.error = "Не удалось заполнить шаблон свободных окон"
            db.commit()
            raise HTTPException(status_code=502, detail=publication.error) from error
        for publication in publications:
            publication.media_ids_json = json.dumps([rendered.id])
            publication.caption = "Ближайшие свободные окна — актуально на момент публикации. Напишите нам, чтобы записаться 💌"
    else:
        # An explicit request such as "Создай рекламный пост" must reliably
        # create a campaign visual.  It used to be decided only in the React
        # page, where an old cached bundle (and a Cyrillic regex boundary)
        # could skip the visual endpoint and leave an unrelated archive photo.
        # Keep this server-side so every platform has the same prepared asset.
        # Manual selections are always honoured, but an automatic content
        # selection is equally valuable for a request such as «сделай коллаж
        # губ из галереи».  Feed the selected source files into the visual
        # builder instead of losing them and producing an unrelated stock-like
        # banner.
        prepared_source_media = explicit_source_media
        if not prepared_source_media and draft.media_ids:
            selected_by_id = {
                media.id: media
                for media in db.scalars(
                    select(MediaFile).where(MediaFile.id.in_(draft.media_ids))
                ).all()
            }
            prepared_source_media = [
                selected_by_id[media_id]
                for media_id in draft.media_ids
                if media_id in selected_by_id
            ]
        if item.visual_edit_requested and not any(media.media_type == MediaType.IMAGE for media in explicit_source_media):
            raise HTTPException(
                status_code=422,
                detail="Для обработки ИИ выберите хотя бы одно фото из хранилища. Видео можно добавить в пост отдельно.",
            )
        if item.visual_edit_requested or requires_generated_visual(item.title, item.editor_instruction):
            try:
                generated = generate_branded_visual(
                    db,
                    settings,
                    item,
                    user.id,
                    item.editor_instruction or item.title,
                    prepared_source_media,
                    copy_hint=draft.caption,
                    force_edit=item.visual_edit_requested,
                )
            except ContentAgentError as error:
                item.status = ContentStatus.FAILED
                for publication in publications:
                    publication.status = PublicationStatus.FAILED
                    publication.error = str(error)
                db.commit()
                raise HTTPException(status_code=502, detail=str(error)) from error
            for publication in publications:
                publication.media_ids_json = json.dumps([generated.id])
        else:
            for publication in publications:
                publication.media_ids_json = json.dumps(draft.media_ids)
    for publication in publications:
        publication.status = PublicationStatus.PENDING
        publication.error = None
    item.status = ContentStatus.READY
    db.add(
        AuditLog(
            actor_id=user.id,
            action="content.prepare",
            target_type="content_item",
            target_id=item.id,
            details=json.dumps({"media_count": len(draft.media_ids), "platforms": [entry.platform.value for entry in publications]}),
        )
    )
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/{item_id}/visual", response_model=ContentItemResponse)
def generate_content_visual(
    item_id: str,
    payload: VisualGenerateRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    """Create one explicit branded image; this endpoint never publishes it."""
    item = get_item(db, item_id)
    source_ids = list(dict.fromkeys(payload.source_media_ids))
    if not source_ids:
        try:
            source_ids = [str(value) for value in json.loads(item.media_ids_json)]
        except (TypeError, ValueError, json.JSONDecodeError):
            source_ids = []
    source_media: list[MediaFile] = []
    if source_ids:
        valid_ids = validate_content_media_selection(db, user, source_ids, 10)
        source_media = db.scalars(select(MediaFile).where(MediaFile.id.in_(valid_ids))).all()
    # Build the chronology before calling the image generator. The previous
    # order sent only the last small note (for example, "make the price
    # larger") and saved the original brief afterwards, so the visual could
    # fall back to its mechanical title.
    combined_instruction = append_editor_instruction(item.editor_instruction, payload.instruction)
    publications = db.scalars(
        select(ContentPublication).where(ContentPublication.content_item_id == item.id)
    ).all()
    copy_hint = next((publication.caption for publication in publications if publication.caption), None) or item.caption
    try:
        generated = generate_branded_visual(
            db,
            get_settings(),
            item,
            user.id,
            combined_instruction,
            source_media,
            copy_hint=copy_hint,
            force_edit=True,
        )
    except ContentAgentError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    for publication in publications:
        publication.media_ids_json = json.dumps([generated.id])
        publication.error = None
        if publication.status == PublicationStatus.FAILED:
            publication.status = PublicationStatus.PENDING
    item.editor_instruction = combined_instruction
    item.visual_edit_requested = True
    item.status = ContentStatus.READY
    db.add(AuditLog(
        actor_id=user.id,
        action="content.visual.generate",
        target_type="content_item",
        target_id=item.id,
        details=json.dumps({"media_id": generated.id}, ensure_ascii=False),
    ))
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.patch("/items/{item_id}/publications/{platform}/caption", response_model=ContentItemResponse)
def update_publication_caption(
    item_id: str,
    platform: PublicationPlatform,
    payload: PublicationCaptionUpdate,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    item = get_item(db, item_id)
    publication = get_publication(db, item, platform)
    if publication.status == PublicationStatus.PUBLISHED:
        raise HTTPException(status_code=409, detail="Опубликированный текст нельзя изменить")
    publication.caption = payload.caption.strip()
    db.add(AuditLog(
        actor_id=user.id,
        action="content.caption.update",
        target_type="content_item",
        target_id=item.id,
        details=json.dumps({"platform": platform.value}, ensure_ascii=False),
    ))
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/{item_id}/publications/telegram", response_model=ContentItemResponse)
def publish_telegram_content_item(
    item_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    """Send the already prepared Telegram draft only after an explicit UI action."""
    item = get_item(db, item_id)
    publication = get_publication(db, item, PublicationPlatform.TELEGRAM)
    if publication.publication_format == "reel":
        raise HTTPException(status_code=409, detail="Публикация видеоролика пока не поддерживается. Используйте пост или отправьте видео вручную.")
    if item.content_format == ContentFormat.STORY or publication.publication_format == "story":
        raise HTTPException(
            status_code=409,
            detail="История подготовлена как вертикальный макет. Telegram Bot API не публикует истории канала.",
        )
    if item.status not in {ContentStatus.READY, ContentStatus.SCHEDULED}:
        raise HTTPException(status_code=409, detail="Prepare the draft before publishing")
    if not publication.caption:
        raise HTTPException(status_code=409, detail="Telegram draft is empty")
    try:
        media_ids = json.loads(publication.media_ids_json)
    except (TypeError, json.JSONDecodeError):
        media_ids = []
    if not isinstance(media_ids, list) or not all(isinstance(value, str) for value in media_ids):
        raise HTTPException(status_code=409, detail="Telegram draft contains invalid files")
    media_files: list[MediaFile] = []
    if media_ids:
        media_files = db.scalars(
            select(MediaFile)
            .join(Workspace, MediaFile.workspace_id == Workspace.id)
            .where(
                MediaFile.id.in_(media_ids),
                MediaFile.deleted_at.is_(None),
                MediaFile.publication_allowed.is_(True),
                Workspace.kind == WorkspaceKind.STUDIO,
            )
        ).all()
        by_id = {media.id: media for media in media_files}
        if len(by_id) != len(media_ids):
            raise HTTPException(
                status_code=409,
                detail="One of the selected files is no longer available for publication",
            )
        media_files = [by_id[media_id] for media_id in media_ids]
    publication.status = PublicationStatus.PUBLISHING
    publication.error = None
    db.commit()
    try:
        external_id = publish_to_channel(get_settings(), publication.caption, media_files)
    except TelegramPublishError as error:
        publication.status = PublicationStatus.FAILED
        publication.error = str(error)
        update_item_status_after_publication(db, item)
        db.commit()
        raise HTTPException(status_code=502, detail=str(error)) from error
    publication.status = PublicationStatus.PUBLISHED
    publication.published_at = utc_now()
    publication.external_id = external_id
    publication.error = None
    update_item_status_after_publication(db, item)
    db.add(
        AuditLog(
            actor_id=user.id,
            action="content.publish.telegram",
            target_type="content_item",
            target_id=item.id,
            details=json.dumps({"media_count": len(media_files), "message_ids": external_id}),
        )
    )
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.post("/items/{item_id}/publications/instagram", response_model=ContentItemResponse)
def publish_instagram_content_item(
    item_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> ContentItemResponse:
    """Publish an approved Instagram item using revocable public delivery URLs."""
    item = get_item(db, item_id)
    publication = get_publication(db, item, PublicationPlatform.INSTAGRAM)
    if item.status not in {ContentStatus.READY, ContentStatus.SCHEDULED}:
        raise HTTPException(status_code=409, detail="Сначала подготовьте материал")
    if not publication.caption:
        raise HTTPException(status_code=409, detail="У Instagram-публикации нет текста")
    try:
        media_ids = json.loads(publication.media_ids_json)
    except (TypeError, json.JSONDecodeError):
        media_ids = []
    if not isinstance(media_ids, list) or not media_ids or not all(isinstance(value, str) for value in media_ids):
        raise HTTPException(status_code=409, detail="Для Instagram выберите хотя бы один доступный материал")
    media_files = db.scalars(
        select(MediaFile)
        .join(Workspace, MediaFile.workspace_id == Workspace.id)
        .where(
            MediaFile.id.in_(media_ids),
            MediaFile.deleted_at.is_(None),
            MediaFile.publication_allowed.is_(True),
            Workspace.kind == WorkspaceKind.STUDIO,
        )
    ).all()
    by_id = {media.id: media for media in media_files}
    if len(by_id) != len(media_ids):
        raise HTTPException(status_code=409, detail="Один из материалов больше недоступен для публикации")
    media_files = [by_id[media_id] for media_id in media_ids]
    publication.status = PublicationStatus.PUBLISHING
    publication.error = None
    db.commit()
    try:
        external_id = publish_to_instagram(
            db, get_settings(), publication, publication.caption, media_files
        )
    except InstagramPublishError as error:
        publication.status = PublicationStatus.FAILED
        publication.error = str(error)
        update_item_status_after_publication(db, item)
        db.commit()
        raise HTTPException(status_code=502, detail=str(error)) from error
    publication.status = PublicationStatus.PUBLISHED
    publication.published_at = utc_now()
    publication.external_id = external_id
    publication.error = None
    update_item_status_after_publication(db, item)
    db.add(AuditLog(
        actor_id=user.id,
        action="content.publish.instagram",
        target_type="content_item",
        target_id=item.id,
        details=json.dumps({"media_count": len(media_files), "publication_id": external_id}),
    ))
    db.commit()
    db.refresh(item)
    return response_for(db, item)


@router.delete("/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_content_item(
    item_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    __: Annotated[User, Depends(require_content_access)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    item = get_item(db, item_id)
    published = db.scalar(
        select(ContentPublication.id).where(
            ContentPublication.content_item_id == item.id,
            ContentPublication.status == PublicationStatus.PUBLISHED,
        ).limit(1)
    )
    if published:
        raise HTTPException(status_code=409, detail="Published content cannot be deleted")
    db.delete(item)
    db.commit()
