from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from vita29.db.models import (
    Discussion,
    DiscussionAttachment,
    DiscussionKind,
    DiscussionMember,
    DiscussionMessage,
    MediaBatch,
    MediaFile,
    Notification,
    User,
    Workspace,
    WorkspaceKind,
    YclientsVisit,
    utc_now,
)
from vita29.workspaces.access import can_access_workspace


def active_users(db: Session) -> list[User]:
    return list(db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.display_name)))


def add_members(db: Session, discussion: Discussion, user_ids: set[str]) -> None:
    existing = set(
        db.scalars(
            select(DiscussionMember.user_id).where(
                DiscussionMember.discussion_id == discussion.id,
                DiscussionMember.user_id.in_(user_ids),
            )
        )
    ) if user_ids else set()
    for user_id in user_ids - existing:
        db.add(DiscussionMember(discussion_id=discussion.id, user_id=user_id))


def ensure_general_discussion(db: Session) -> Discussion:
    discussion = db.scalar(select(Discussion).where(Discussion.kind == DiscussionKind.GENERAL))
    if discussion is None:
        discussion = Discussion(title="Общий чат", kind=DiscussionKind.GENERAL)
        db.add(discussion)
        db.flush()
    add_members(db, discussion, {user.id for user in active_users(db)})
    return discussion


def create_batch_discussion(db: Session, batch: MediaBatch, creator: User) -> Discussion | None:
    if not batch.comment:
        return None
    existing = db.scalar(select(Discussion).where(Discussion.batch_id == batch.id))
    if existing is not None:
        return existing

    visit = db.get(YclientsVisit, batch.yclients_record_id) if batch.yclients_record_id else None
    client_name = visit.client_display_name if visit is not None else None
    short_comment = " ".join(batch.comment.split())
    if len(short_comment) > 80:
        short_comment = f"{short_comment[:77]}…"
    title = f"Серия: {client_name}" if client_name else f"Серия: {short_comment}"
    discussion = Discussion(
        title=title,
        kind=DiscussionKind.BATCH,
        created_by_id=creator.id,
        batch_id=batch.id,
        client_name=client_name,
    )
    db.add(discussion)
    db.flush()
    members = comment_members(db, batch)
    add_members(db, discussion, {member.id for member in members})
    message = DiscussionMessage(
        discussion_id=discussion.id,
        author_id=creator.id,
        body=batch.comment,
        batch_id=batch.id,
    )
    db.add(message)
    db.flush()
    lowered = batch.comment.casefold()
    for member in members:
        if member.id != creator.id:
            db.add(
                Notification(
                    user_id=member.id,
                    kind=(
                        "media.comment.mention"
                        if f"@{member.display_name.casefold()}" in lowered
                        else "media.comment"
                    ),
                    discussion_id=discussion.id,
                    message_id=message.id,
                    actor_id=creator.id,
                )
            )
    own_member = db.get(DiscussionMember, (discussion.id, creator.id))
    if own_member is not None:
        own_member.last_read_message_id = message.id
    return discussion


def comment_members(db: Session, batch: MediaBatch) -> list[User]:
    batch_workspace = db.get(Workspace, batch.workspace_id)
    if batch_workspace is None:
        return []
    if batch_workspace.kind == WorkspaceKind.PRIVATE:
        creator = db.get(User, batch.created_by_id) if batch.created_by_id else None
        return [creator] if creator is not None and creator.is_active else []
    return [user for user in active_users(db) if can_access_workspace(db, batch_workspace, user)]


def sync_comment_members(db: Session, discussion: Discussion, batch: MediaBatch) -> list[User]:
    members = comment_members(db, batch)
    allowed_ids = {member.id for member in members}
    add_members(db, discussion, allowed_ids)
    workspace = db.get(Workspace, batch.workspace_id)
    if workspace is not None and workspace.kind == WorkspaceKind.PRIVATE:
        db.execute(
            delete(Notification).where(
                Notification.discussion_id == discussion.id,
                Notification.user_id.not_in(allowed_ids),
            )
        )
        db.execute(
            delete(DiscussionMember).where(
                DiscussionMember.discussion_id == discussion.id,
                DiscussionMember.user_id.not_in(allowed_ids),
            )
        )
    return members


def ensure_comment_discussion(
    db: Session,
    batch: MediaBatch,
    creator: User,
    fallback_comment: str,
) -> Discussion:
    discussion = db.scalar(select(Discussion).where(Discussion.batch_id == batch.id))
    if discussion is None:
        visit = db.get(YclientsVisit, batch.yclients_record_id) if batch.yclients_record_id else None
        client_name = visit.client_display_name if visit is not None else None
        short_comment = " ".join(fallback_comment.split())
        if len(short_comment) > 80:
            short_comment = f"{short_comment[:77]}…"
        discussion = Discussion(
            title=f"Серия: {client_name}" if client_name else f"Комментарий: {short_comment}",
            kind=DiscussionKind.BATCH,
            created_by_id=creator.id,
            batch_id=batch.id,
            client_name=client_name,
        )
        db.add(discussion)
        db.flush()
    sync_comment_members(db, discussion, batch)
    return discussion


def add_media_comment_message(
    db: Session,
    media: MediaFile,
    creator: User,
    comment: str,
    *,
    notify: bool = True,
) -> DiscussionMessage:
    batch = db.get(MediaBatch, media.batch_id) if media.batch_id else None
    if batch is None:
        batch = MediaBatch(
            workspace_id=media.workspace_id,
            created_by_id=media.uploaded_by_id or creator.id,
            yclients_record_id=media.yclients_record_id,
        )
        db.add(batch)
        db.flush()
        media.batch_id = batch.id
    discussion = ensure_comment_discussion(db, batch, creator, comment)
    message = DiscussionMessage(
        discussion_id=discussion.id,
        author_id=creator.id,
        body=comment,
        batch_id=batch.id,
    )
    db.add(message)
    db.flush()
    db.add(DiscussionAttachment(message_id=message.id, media_id=media.id))
    discussion.updated_at = utc_now()
    members = comment_members(db, batch)
    lowered = comment.casefold()
    for member in members:
        if member.id == creator.id:
            continue
        if notify:
            kind = (
                "media.comment.mention"
                if f"@{member.display_name.casefold()}" in lowered
                else "media.comment"
            )
            db.add(
                Notification(
                    user_id=member.id,
                    kind=kind,
                    discussion_id=discussion.id,
                    message_id=message.id,
                    actor_id=creator.id,
                )
            )
    own_member = db.get(DiscussionMember, (discussion.id, creator.id))
    if own_member is not None:
        own_member.last_read_message_id = message.id
    return message


def attach_media_to_batch_comment(db: Session, media: MediaFile) -> None:
    if not media.batch_id:
        return
    discussion = db.scalar(select(Discussion).where(Discussion.batch_id == media.batch_id))
    if discussion is None:
        return
    message = db.scalar(
        select(DiscussionMessage)
        .where(DiscussionMessage.discussion_id == discussion.id)
        .order_by(DiscussionMessage.created_at)
        .limit(1)
    )
    if message is None:
        return
    exists = db.scalar(
        select(DiscussionAttachment.id).where(
            DiscussionAttachment.message_id == message.id,
            DiscussionAttachment.media_id == media.id,
        )
    )
    if exists is None:
        db.add(DiscussionAttachment(message_id=message.id, media_id=media.id))


def backfill_comment_messages(db: Session) -> None:
    for media in db.scalars(
        select(MediaFile).where(
            MediaFile.comment.is_not(None),
            MediaFile.deleted_at.is_(None),
        )
    ):
        existing_attachment = db.scalar(
            select(DiscussionAttachment.id)
            .join(DiscussionMessage, DiscussionMessage.id == DiscussionAttachment.message_id)
            .join(Discussion, Discussion.id == DiscussionMessage.discussion_id)
            .where(
                DiscussionAttachment.media_id == media.id,
                Discussion.kind == DiscussionKind.BATCH,
            )
            .limit(1)
        )
        if existing_attachment is not None:
            continue
        creator = db.get(User, media.uploaded_by_id) if media.uploaded_by_id else None
        creator = creator or db.get(User, media.owner_id)
        if creator is not None and media.comment:
            add_media_comment_message(db, media, creator, media.comment, notify=False)

    discussions = db.scalars(select(Discussion).where(Discussion.kind == DiscussionKind.BATCH)).all()
    for discussion in discussions:
        if not discussion.batch_id:
            continue
        batch = db.get(MediaBatch, discussion.batch_id)
        if batch is None:
            continue
        sync_comment_members(db, discussion, batch)
        message = db.scalar(
            select(DiscussionMessage)
            .where(DiscussionMessage.discussion_id == discussion.id)
            .order_by(DiscussionMessage.created_at)
            .limit(1)
        )
        if message is None and batch.comment:
            message = DiscussionMessage(
                discussion_id=discussion.id,
                author_id=batch.created_by_id,
                body=batch.comment,
                batch_id=batch.id,
                created_at=batch.created_at,
            )
            db.add(message)
            db.flush()
        if message is None or not batch.comment or message.body != batch.comment:
            continue
        for media in db.scalars(
            select(MediaFile).where(
                MediaFile.batch_id == batch.id,
                MediaFile.deleted_at.is_(None),
            )
        ):
            exists = db.scalar(
                select(DiscussionAttachment.id).where(
                    DiscussionAttachment.message_id == message.id,
                    DiscussionAttachment.media_id == media.id,
                )
            )
            if exists is None:
                db.add(DiscussionAttachment(message_id=message.id, media_id=media.id))
