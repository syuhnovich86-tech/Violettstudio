import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utc_now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class UserRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    EMPLOYEE = "employee"


class MediaType(str, enum.Enum):
    IMAGE = "image"
    VIDEO = "video"


class WorkspaceKind(str, enum.Enum):
    STUDIO = "studio"
    PRIVATE = "private"


class DiscussionKind(str, enum.Enum):
    GENERAL = "general"
    CUSTOM = "custom"
    BATCH = "batch"


class ContentStatus(str, enum.Enum):
    DRAFT = "draft"
    REVIEW = "review"
    APPROVED = "approved"
    GENERATING = "generating"
    READY = "ready"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"
    FAILED = "failed"


class ContentFormat(str, enum.Enum):
    POST = "post"
    STORY = "story"
    AVAILABILITY = "availability"


class PublicationPlatform(str, enum.Enum):
    TELEGRAM = "telegram"
    MAX = "max"
    INSTAGRAM = "instagram"


class PublicationStatus(str, enum.Enum):
    PENDING = "pending"
    SCHEDULED = "scheduled"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    FAILED = "failed"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    display_name: Mapped[str] = mapped_column(String(120))
    login: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.EMPLOYEE)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    can_create_shared_workspaces: Mapped[bool] = mapped_column(Boolean, default=True)
    can_create_private_workspaces: Mapped[bool] = mapped_column(Boolean, default=False)
    can_add_comments: Mapped[bool] = mapped_column(Boolean, default=True)
    can_upload_media: Mapped[bool] = mapped_column(Boolean, default=True)
    can_view_all_calendars: Mapped[bool] = mapped_column(Boolean, default=False)
    can_access_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    can_access_chats: Mapped[bool] = mapped_column(Boolean, default=True)
    can_access_content: Mapped[bool] = mapped_column(Boolean, default=False)
    can_import_ios_photo_library: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    media_files: Mapped[list["MediaFile"]] = relationship(
        back_populates="owner", foreign_keys="MediaFile.owner_id"
    )
    owned_workspaces: Mapped[list["Workspace"]] = relationship(
        back_populates="owner", foreign_keys="Workspace.owner_id"
    )


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    user: Mapped[User] = relationship(back_populates="sessions")


Index("ix_sessions_token_expiry", AuthSession.token_hash, AuthSession.expires_at)


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    display_name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[WorkspaceKind] = mapped_column(Enum(WorkspaceKind), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    owner: Mapped[User] = relationship(back_populates="owned_workspaces", foreign_keys=[owner_id])
    members: Mapped[list["WorkspaceMember"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan"
    )
    media_files: Mapped[list["MediaFile"]] = relationship(back_populates="workspace")


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    workspace: Mapped[Workspace] = relationship(back_populates="members")
    user: Mapped[User] = relationship()


class MediaBatch(Base):
    __tablename__ = "media_batches"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id"), index=True
    )
    created_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    yclients_record_id: Mapped[int | None] = mapped_column(
        ForeignKey("yclients_visits.record_id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )


class MediaFile(Base):
    __tablename__ = "media_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    uploaded_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    storage_key: Mapped[str] = mapped_column(String(255), unique=True)
    original_name: Mapped[str] = mapped_column(String(255))
    media_type: Mapped[MediaType] = mapped_column(Enum(MediaType))
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    checksum_sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )
    captured_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    gps_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    gps_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    location_country: Mapped[str | None] = mapped_column(String(80), nullable=True)
    location_city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    location_key: Mapped[str | None] = mapped_column(String(220), nullable=True, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    yclients_record_id: Mapped[int | None] = mapped_column(
        ForeignKey("yclients_visits.record_id", ondelete="SET NULL"), nullable=True, index=True
    )
    publication_allowed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    # A deliberate editorial marker.  It is independent of a temporary UI
    # selection and lets the content planner prioritise approved source files.
    content_marked: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("media_batches.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    owner: Mapped[User] = relationship(back_populates="media_files", foreign_keys=[owner_id])
    uploaded_by: Mapped[User | None] = relationship(foreign_keys=[uploaded_by_id])
    workspace: Mapped[Workspace] = relationship(back_populates="media_files")
    yclients_visit: Mapped["YclientsVisit | None"] = relationship()
    batch: Mapped["MediaBatch | None"] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(80), index=True)
    target_type: Mapped[str] = mapped_column(String(40))
    target_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, index=True
    )


class YclientsIntegration(Base):
    __tablename__ = "yclients_integrations"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    salon_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    application_id: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class YclientsStaffMapping(Base):
    __tablename__ = "yclients_staff_mappings"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    salon_id: Mapped[int] = mapped_column(BigInteger, index=True)
    staff_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    staff_name: Mapped[str] = mapped_column(String(120))
    specialization: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )

    user: Mapped[User] = relationship()


class YclientsVisit(Base):
    __tablename__ = "yclients_visits"

    record_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    salon_id: Mapped[int] = mapped_column(BigInteger, index=True)
    staff_id: Mapped[int] = mapped_column(BigInteger, index=True)
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    client_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True)
    client_display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    service_titles: Mapped[str | None] = mapped_column(Text, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    attendance: Mapped[int] = mapped_column(Integer, default=0)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    user: Mapped[User | None] = relationship()


class Discussion(Base):
    __tablename__ = "discussion"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(160))
    kind: Mapped[DiscussionKind] = mapped_column(Enum(DiscussionKind), index=True)
    created_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("media_batches.id", ondelete="SET NULL"), nullable=True, unique=True, index=True
    )
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, index=True
    )


class DiscussionMember(Base):
    __tablename__ = "discussion_member"

    discussion_id: Mapped[str] = mapped_column(
        ForeignKey("discussion.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    last_read_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="SET NULL"), nullable=True
    )
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class DiscussionMessage(Base):
    __tablename__ = "discussion_message"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    discussion_id: Mapped[str] = mapped_column(
        ForeignKey("discussion.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    reply_to_id: Mapped[str | None] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="SET NULL"), nullable=True, index=True
    )
    batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("media_batches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DiscussionAttachment(Base):
    __tablename__ = "discussion_attachment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    message_id: Mapped[str] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="CASCADE"), index=True
    )
    media_id: Mapped[str] = mapped_column(
        ForeignKey("media_files.id", ondelete="CASCADE"), index=True
    )


class MessageReaction(Base):
    __tablename__ = "message_reaction"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    emoji: Mapped[str] = mapped_column(String(24), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class MessageLike(Base):
    __tablename__ = "message_like"

    message_id: Mapped[str] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class Notification(Base):
    __tablename__ = "notification"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    discussion_id: Mapped[str | None] = mapped_column(
        ForeignKey("discussion.id", ondelete="CASCADE"), nullable=True, index=True
    )
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("discussion_message.id", ondelete="CASCADE"), nullable=True, index=True
    )
    actor_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, index=True)


class PushSubscription(Base):
    __tablename__ = "push_subscription"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint: Mapped[str] = mapped_column(Text, unique=True)
    p256dh: Mapped[str] = mapped_column(Text)
    auth: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


class ContentItem(Base):
    __tablename__ = "content_item"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(180))
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    editor_instruction: Mapped[str | None] = mapped_column(Text, nullable=True)
    # This is deliberately separate from the editor note.  An instruction
    # such as "убери маску" must invoke image editing when the editor has
    # selected a source photo, even though it does not contain the word
    # "сгенерируй".
    visual_edit_requested: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Explicit creative-family selection.  "auto" preserves compatibility for
    # older cards, while light/dark makes an editor's choice deterministic.
    visual_style: Mapped[str] = mapped_column(String(8), default="auto", server_default="auto")
    content_format: Mapped[ContentFormat] = mapped_column(
        Enum(ContentFormat), default=ContentFormat.POST, index=True
    )
    media_limit: Mapped[int] = mapped_column(Integer, default=1)
    availability_staff_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    availability_slots_json: Mapped[str] = mapped_column(Text, default="[]")
    status: Mapped[ContentStatus] = mapped_column(Enum(ContentStatus), default=ContentStatus.DRAFT, index=True)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    media_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    approved_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now
    )


class ContentPublication(Base):
    __tablename__ = "content_publication"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    content_item_id: Mapped[str] = mapped_column(
        ForeignKey("content_item.id", ondelete="CASCADE"), index=True
    )
    platform: Mapped[PublicationPlatform] = mapped_column(Enum(PublicationPlatform), index=True)
    publication_format: Mapped[str] = mapped_column(String(16), default="post", server_default="post")
    status: Mapped[PublicationStatus] = mapped_column(
        Enum(PublicationStatus), default=PublicationStatus.PENDING, index=True
    )
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    __table_args__ = (
        Index("uq_content_publication_item_platform", "content_item_id", "platform", unique=True),
    )


class TemporaryPublicMediaLink(Base):
    """A short-lived, opaque URL for a remote publisher such as Meta.

    The raw token is never stored.  A link is valid only while the matching
    publication is being handed to the provider and can be revoked at once.
    """

    __tablename__ = "temporary_public_media_link"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    media_file_id: Mapped[str] = mapped_column(
        ForeignKey("media_files.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_publication.id", ondelete="CASCADE"), index=True, nullable=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
