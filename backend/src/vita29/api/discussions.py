from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from vita29.auth.dependencies import get_current_user, require_chat_access, require_csrf
from vita29.db.models import (
    AuditLog,
    AuthSession,
    Discussion,
    DiscussionAttachment,
    DiscussionKind,
    DiscussionMember,
    DiscussionMessage,
    MediaBatch,
    MediaFile,
    MessageLike,
    MessageReaction,
    Notification,
    PushSubscription,
    User,
    Workspace,
    WorkspaceKind,
    utc_now,
)
from vita29.db.session import get_db
from vita29.discussions.push import public_vapid_key, send_push_notifications
from vita29.discussions.service import (
    active_users,
    add_members,
    backfill_comment_messages,
    ensure_general_discussion,
)
from vita29.settings import Settings, get_settings
from vita29.workspaces.access import can_access_workspace

router = APIRouter(
    prefix="/discussions",
    tags=["discussions"],
    dependencies=[Depends(require_chat_access)],
)


class ParticipantResponse(BaseModel):
    id: str
    display_name: str


class DiscussionCreateRequest(BaseModel):
    title: str = Field(min_length=2, max_length=160)
    member_ids: list[str] = Field(default_factory=list, max_length=100)


class DiscussionResponse(BaseModel):
    id: str
    title: str
    kind: str
    batch_id: str | None
    client_name: str | None
    member_ids: list[str]
    unread_count: int
    first_unread_message_id: str | None
    last_message: str | None
    updated_at: datetime
    can_delete: bool
    mentioned_me: bool
    is_private: bool


class AttachmentRequest(BaseModel):
    media_id: str


class MessageCreateRequest(BaseModel):
    body: str | None = Field(default=None, max_length=8000)
    reply_to_id: str | None = None
    batch_id: str | None = None
    attachments: list[AttachmentRequest] = Field(default_factory=list, max_length=20)


class ReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=24)


class ReadRequest(BaseModel):
    message_id: str | None = None


class AttachmentResponse(BaseModel):
    media_id: str
    media_type: str
    original_name: str
    batch_id: str | None
    thumbnail_url: str
    preview_url: str


class ReplyPreview(BaseModel):
    id: str
    author_name: str
    body: str | None


class MessageResponse(BaseModel):
    id: str
    discussion_id: str
    author_id: str | None
    author_name: str
    body: str | None
    reply_to: ReplyPreview | None
    batch_id: str | None
    attachments: list[AttachmentResponse]
    reactions: dict[str, int]
    my_reactions: list[str]
    like_count: int
    liked_by_me: bool
    created_at: datetime


class NotificationResponse(BaseModel):
    id: str
    kind: str
    discussion_id: str | None
    message_id: str | None
    actor_name: str | None
    read: bool
    created_at: datetime


class NotificationSummary(BaseModel):
    unread_count: int
    notifications: list[NotificationResponse]


class PushSubscriptionKeys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=1000)
    auth: str = Field(min_length=8, max_length=500)


class PushSubscriptionRequest(BaseModel):
    endpoint: str = Field(min_length=20, max_length=3000)
    keys: PushSubscriptionKeys


class PushPublicKeyResponse(BaseModel):
    public_key: str


def membership(db: Session, discussion_id: str, user_id: str) -> DiscussionMember:
    member = db.get(DiscussionMember, (discussion_id, user_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return member


def discussion_response(db: Session, discussion: Discussion, user: User) -> DiscussionResponse:
    member = membership(db, discussion.id, user.id)
    member_ids = list(
        db.scalars(
            select(DiscussionMember.user_id).where(
                DiscussionMember.discussion_id == discussion.id
            )
        )
    )
    last_read = db.get(DiscussionMessage, member.last_read_message_id) if member.last_read_message_id else None
    unread_query = select(func.count()).select_from(DiscussionMessage).where(
        DiscussionMessage.discussion_id == discussion.id,
        DiscussionMessage.author_id != user.id,
    )
    if last_read is not None:
        unread_query = unread_query.where(DiscussionMessage.created_at > last_read.created_at)
    unread_count = int(db.scalar(unread_query) or 0)
    first_unread_query = select(DiscussionMessage).where(
        DiscussionMessage.discussion_id == discussion.id,
        DiscussionMessage.author_id != user.id,
    )
    if last_read is not None:
        first_unread_query = first_unread_query.where(
            DiscussionMessage.created_at > last_read.created_at
        )
    first_unread = db.scalar(first_unread_query.order_by(DiscussionMessage.created_at).limit(1))
    last_message = db.scalar(
        select(DiscussionMessage)
        .where(DiscussionMessage.discussion_id == discussion.id)
        .order_by(DiscussionMessage.created_at.desc())
        .limit(1)
    )
    batch = db.get(MediaBatch, discussion.batch_id) if discussion.batch_id else None
    workspace = db.get(Workspace, batch.workspace_id) if batch is not None else None
    return DiscussionResponse(
        id=discussion.id,
        title=discussion.title,
        kind=discussion.kind.value,
        batch_id=discussion.batch_id,
        client_name=discussion.client_name,
        member_ids=member_ids,
        unread_count=unread_count,
        first_unread_message_id=first_unread.id if first_unread else None,
        last_message=(last_message.body[:120] if last_message and last_message.body else None),
        updated_at=discussion.updated_at,
        can_delete=(
            discussion.kind != DiscussionKind.GENERAL
            and discussion.created_by_id == user.id
        ),
        mentioned_me=bool(
            db.scalar(
                select(func.count())
                .select_from(DiscussionMessage)
                .where(
                    DiscussionMessage.discussion_id == discussion.id,
                    func.casefold(DiscussionMessage.body).contains(
                        f"@{user.display_name.casefold()}"
                    ),
                )
            )
        ),
        is_private=workspace is not None and workspace.kind == WorkspaceKind.PRIVATE,
    )


def message_response(db: Session, message: DiscussionMessage, user: User) -> MessageResponse:
    author = db.get(User, message.author_id) if message.author_id else None
    reply = db.get(DiscussionMessage, message.reply_to_id) if message.reply_to_id else None
    reply_author = db.get(User, reply.author_id) if reply and reply.author_id else None
    attachments: list[AttachmentResponse] = []
    for attachment in db.scalars(
        select(DiscussionAttachment).where(DiscussionAttachment.message_id == message.id)
    ):
        media = db.get(MediaFile, attachment.media_id)
        if media is None or media.deleted_at is not None:
            continue
        attachments.append(
            AttachmentResponse(
                media_id=media.id,
                media_type=media.media_type.value,
                original_name=media.original_name,
                batch_id=media.batch_id,
                thumbnail_url=f"/api/v1/media/{media.id}/thumbnail",
                preview_url=f"/api/v1/media/{media.id}/preview",
            )
        )
    reaction_rows = db.execute(
        select(MessageReaction.emoji, func.count())
        .where(MessageReaction.message_id == message.id)
        .group_by(MessageReaction.emoji)
    ).all()
    my_reactions = list(
        db.scalars(
            select(MessageReaction.emoji).where(
                MessageReaction.message_id == message.id,
                MessageReaction.user_id == user.id,
            )
        )
    )
    like_count = int(
        db.scalar(
            select(func.count()).select_from(MessageLike).where(MessageLike.message_id == message.id)
        )
        or 0
    )
    return MessageResponse(
        id=message.id,
        discussion_id=message.discussion_id,
        author_id=message.author_id,
        author_name=author.display_name if author else "Удалённый пользователь",
        body=message.body,
        reply_to=(
            ReplyPreview(
                id=reply.id,
                author_name=reply_author.display_name if reply_author else "Пользователь",
                body=reply.body,
            )
            if reply
            else None
        ),
        batch_id=message.batch_id,
        attachments=attachments,
        reactions={emoji: count for emoji, count in reaction_rows},
        my_reactions=my_reactions,
        like_count=like_count,
        liked_by_me=db.get(MessageLike, (message.id, user.id)) is not None,
        created_at=message.created_at,
    )


@router.get("/participants", response_model=list[ParticipantResponse])
def list_participants(
    _: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ParticipantResponse]:
    return [ParticipantResponse(id=item.id, display_name=item.display_name) for item in active_users(db)]


@router.get("/media-library", response_model=list[AttachmentResponse])
def media_library(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    search: Annotated[str | None, Query(max_length=200)] = None,
) -> list[AttachmentResponse]:
    query = select(MediaFile).where(MediaFile.deleted_at.is_(None))
    if search and search.strip():
        query = query.where(func.casefold(MediaFile.original_name).contains(search.strip().casefold()))
    candidates = db.scalars(query.order_by(MediaFile.created_at.desc()).limit(200)).all()
    result: list[AttachmentResponse] = []
    for media in candidates:
        if not can_access_workspace(db, media.workspace, user):
            continue
        result.append(
            AttachmentResponse(
                media_id=media.id,
                media_type=media.media_type.value,
                original_name=media.original_name,
                batch_id=media.batch_id,
                thumbnail_url=f"/api/v1/media/{media.id}/thumbnail",
                preview_url=f"/api/v1/media/{media.id}/preview",
            )
        )
    return result[:100]


@router.get("", response_model=list[DiscussionResponse])
def list_discussions(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    search: Annotated[str | None, Query(max_length=200)] = None,
) -> list[DiscussionResponse]:
    ensure_general_discussion(db)
    backfill_comment_messages(db)
    db.commit()
    query = (
        select(Discussion)
        .join(DiscussionMember, DiscussionMember.discussion_id == Discussion.id)
        .where(DiscussionMember.user_id == user.id)
    )
    if search and search.strip():
        term = f"%{search.strip().casefold()}%"
        query = query.where(
            or_(func.casefold(Discussion.title).like(term), func.casefold(Discussion.client_name).like(term))
        )
    discussions = db.scalars(query.order_by(Discussion.updated_at.desc())).all()
    return [discussion_response(db, item, user) for item in discussions]


@router.post("", response_model=DiscussionResponse, status_code=status.HTTP_201_CREATED)
def create_discussion(
    payload: DiscussionCreateRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> DiscussionResponse:
    requested_ids = set(payload.member_ids) | {user.id}
    valid_ids = set(
        db.scalars(select(User.id).where(User.id.in_(requested_ids), User.is_active.is_(True)))
    )
    if valid_ids != requested_ids:
        raise HTTPException(status_code=400, detail="One or more participants are unavailable")
    discussion = Discussion(
        title=payload.title.strip(),
        kind=DiscussionKind.CUSTOM,
        created_by_id=user.id,
    )
    db.add(discussion)
    db.flush()
    add_members(db, discussion, valid_ids)
    for user_id in valid_ids - {user.id}:
        db.add(Notification(user_id=user_id, kind="discussion.created", discussion_id=discussion.id, actor_id=user.id))
    db.commit()
    db.refresh(discussion)
    return discussion_response(db, discussion, user)


@router.get("/push/public-key", response_model=PushPublicKeyResponse)
def push_public_key(
    _: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> PushPublicKeyResponse:
    key = public_vapid_key(settings.vapid_private_key_file)
    if key is None:
        raise HTTPException(status_code=503, detail="Push notifications are not configured")
    return PushPublicKeyResponse(public_key=key)


@router.post("/push/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
def save_push_subscription(
    payload: PushSubscriptionRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    subscription = db.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if subscription is None:
        subscription = PushSubscription(user_id=user.id, endpoint=payload.endpoint)
        db.add(subscription)
    subscription.user_id = user.id
    subscription.p256dh = payload.keys.p256dh
    subscription.auth = payload.keys.auth
    db.commit()


@router.delete("/{discussion_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_discussion(
    discussion_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    membership(db, discussion_id, user.id)
    discussion = db.get(Discussion, discussion_id)
    if (
        discussion is None
        or discussion.kind == DiscussionKind.GENERAL
        or discussion.created_by_id != user.id
    ):
        raise HTTPException(status_code=403, detail="Only the chat creator can delete it")
    db.add(
        AuditLog(
            actor_id=user.id,
            action="discussion.delete",
            target_type="discussion",
            target_id=discussion.id,
            details=discussion.title,
        )
    )
    db.delete(discussion)
    db.commit()


@router.get("/{discussion_id}/messages", response_model=list[MessageResponse])
def list_messages(
    discussion_id: str,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str | None, Query(max_length=200)] = None,
    client: Annotated[str | None, Query(max_length=200)] = None,
    author_id: Annotated[str | None, Query()] = None,
    batch_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[MessageResponse]:
    membership(db, discussion_id, user.id)
    discussion = db.get(Discussion, discussion_id)
    if client and client.strip() and (
        discussion is None
        or client.strip().casefold() not in (discussion.client_name or "").casefold()
    ):
        return []
    query = select(DiscussionMessage).where(DiscussionMessage.discussion_id == discussion_id)
    if q and q.strip():
        query = query.where(func.casefold(DiscussionMessage.body).contains(q.strip().casefold()))
    if author_id:
        query = query.where(DiscussionMessage.author_id == author_id)
    if batch_id:
        query = query.where(DiscussionMessage.batch_id == batch_id)
    messages = db.scalars(query.order_by(DiscussionMessage.created_at.desc()).limit(limit)).all()
    return [message_response(db, item, user) for item in reversed(messages)]


@router.post("/{discussion_id}/messages", response_model=MessageResponse, status_code=status.HTTP_201_CREATED)
def create_message(
    discussion_id: str,
    payload: MessageCreateRequest,
    background_tasks: BackgroundTasks,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    membership(db, discussion_id, user.id)
    body = payload.body.strip() if payload.body else None
    if not body and not payload.attachments and not payload.batch_id:
        raise HTTPException(status_code=400, detail="Message is empty")
    reply = None
    if payload.reply_to_id:
        reply = db.get(DiscussionMessage, payload.reply_to_id)
        if reply is None or reply.discussion_id != discussion_id:
            raise HTTPException(status_code=400, detail="Reply target is unavailable")
    if payload.batch_id and db.get(MediaBatch, payload.batch_id) is None:
        raise HTTPException(status_code=404, detail="Media batch not found")
    media_items: list[MediaFile] = []
    for item in payload.attachments:
        media = db.get(MediaFile, item.media_id)
        if (
            media is None
            or media.deleted_at is not None
            or not can_access_workspace(db, media.workspace, user)
        ):
            raise HTTPException(status_code=404, detail="Media attachment not found")
        media_items.append(media)
    message = DiscussionMessage(
        discussion_id=discussion_id,
        author_id=user.id,
        body=body,
        reply_to_id=reply.id if reply else None,
        batch_id=payload.batch_id,
    )
    db.add(message)
    db.flush()
    for media in media_items:
        db.add(DiscussionAttachment(message_id=message.id, media_id=media.id))
    discussion = db.get(Discussion, discussion_id)
    if discussion:
        discussion.updated_at = utc_now()
    members = db.scalars(
        select(DiscussionMember).where(DiscussionMember.discussion_id == discussion_id)
    ).all()
    push_user_ids = {
        member.user_id
        for member in members
        if member.user_id != user.id and member.notifications_enabled
    }
    for member in members:
        if member.user_id != user.id and member.notifications_enabled:
            db.add(Notification(user_id=member.user_id, kind="message.created", discussion_id=discussion_id, message_id=message.id, actor_id=user.id))
    if reply and reply.author_id and reply.author_id != user.id:
        db.add(Notification(user_id=reply.author_id, kind="message.reply", discussion_id=discussion_id, message_id=message.id, actor_id=user.id))
    if body:
        lowered = body.casefold()
        for mentioned in active_users(db):
            if mentioned.id != user.id and f"@{mentioned.display_name.casefold()}" in lowered:
                db.add(Notification(user_id=mentioned.id, kind="message.mention", discussion_id=discussion_id, message_id=message.id, actor_id=user.id))
    own_member = membership(db, discussion_id, user.id)
    own_member.last_read_message_id = message.id
    push_rows = db.scalars(
        select(PushSubscription).where(PushSubscription.user_id.in_(push_user_ids))
    ).all() if push_user_ids else []
    push_payloads = [
        {"endpoint": row.endpoint, "p256dh": row.p256dh, "auth": row.auth}
        for row in push_rows
    ]
    db.commit()
    db.refresh(message)
    if push_payloads:
        settings = get_settings()
        background_tasks.add_task(
            send_push_notifications,
            push_payloads,
            {
                "title": f"{user.display_name} · {discussion.title if discussion else 'Чаты'}",
                "body": body[:160] if body else "Новое фото или видео в чате",
                "url": "/#chats",
            },
            settings.vapid_private_key_file,
            settings.vapid_subject,
        )
    return message_response(db, message, user)


@router.put("/{discussion_id}/messages/{message_id}/reaction", response_model=MessageResponse)
def toggle_reaction(
    discussion_id: str,
    message_id: str,
    payload: ReactionRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    membership(db, discussion_id, user.id)
    message = db.get(DiscussionMessage, message_id)
    if message is None or message.discussion_id != discussion_id:
        raise HTTPException(status_code=404, detail="Message not found")
    key = (message_id, user.id, payload.emoji)
    existing = db.get(MessageReaction, key)
    if existing:
        db.delete(existing)
    else:
        db.add(MessageReaction(message_id=message_id, user_id=user.id, emoji=payload.emoji))
    db.commit()
    return message_response(db, message, user)


@router.put("/{discussion_id}/messages/{message_id}/like", response_model=MessageResponse)
def toggle_like(
    discussion_id: str,
    message_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MessageResponse:
    membership(db, discussion_id, user.id)
    message = db.get(DiscussionMessage, message_id)
    if message is None or message.discussion_id != discussion_id:
        raise HTTPException(status_code=404, detail="Message not found")
    existing = db.get(MessageLike, (message_id, user.id))
    if existing:
        db.delete(existing)
    else:
        db.add(MessageLike(message_id=message_id, user_id=user.id))
    db.commit()
    return message_response(db, message, user)


@router.put("/{discussion_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_discussion_read(
    discussion_id: str,
    payload: ReadRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    member = membership(db, discussion_id, user.id)
    message = db.get(DiscussionMessage, payload.message_id) if payload.message_id else db.scalar(
        select(DiscussionMessage).where(DiscussionMessage.discussion_id == discussion_id).order_by(DiscussionMessage.created_at.desc()).limit(1)
    )
    if message is not None and message.discussion_id != discussion_id:
        raise HTTPException(status_code=400, detail="Message belongs to another discussion")
    member.last_read_message_id = message.id if message else None
    db.query(Notification).filter(
        Notification.user_id == user.id,
        Notification.discussion_id == discussion_id,
        Notification.read_at.is_(None),
    ).update({Notification.read_at: utc_now()}, synchronize_session=False)
    db.commit()


@router.get("/notifications/inbox", response_model=NotificationSummary)
def list_notifications(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> NotificationSummary:
    rows = db.scalars(
        select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(50)
    ).all()
    result: list[NotificationResponse] = []
    for row in rows:
        actor = db.get(User, row.actor_id) if row.actor_id else None
        result.append(NotificationResponse(id=row.id, kind=row.kind, discussion_id=row.discussion_id, message_id=row.message_id, actor_name=actor.display_name if actor else None, read=row.read_at is not None, created_at=row.created_at))
    return NotificationSummary(unread_count=sum(not item.read for item in result), notifications=result)


@router.put("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_notifications_read(
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    db.query(Notification).filter(
        Notification.user_id == user.id,
        Notification.read_at.is_(None),
    ).update({Notification.read_at: utc_now()}, synchronize_session=False)
    memberships = db.scalars(
        select(DiscussionMember).where(DiscussionMember.user_id == user.id)
    ).all()
    for membership in memberships:
        latest_message_id = db.scalar(
            select(DiscussionMessage.id)
            .where(DiscussionMessage.discussion_id == membership.discussion_id)
            .order_by(DiscussionMessage.created_at.desc(), DiscussionMessage.id.desc())
            .limit(1)
        )
        if latest_message_id is not None:
            membership.last_read_message_id = latest_message_id
    db.commit()


@router.put("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_notification_read(
    notification_id: str,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    if notification.read_at is None:
        notification.read_at = utc_now()
        db.commit()
