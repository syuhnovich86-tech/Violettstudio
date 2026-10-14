"""Add discussions, messages, reactions and notifications.

Revision ID: 20260822_0012
Revises: 20260818_0011
Create Date: 2026-08-22
"""

import sqlalchemy as sa
from alembic import op

revision = "20260822_0012"
down_revision = "20260818_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discussion",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("kind", sa.Enum("GENERAL", "CUSTOM", "BATCH", name="discussionkind"), nullable=False),
        sa.Column("created_by_id", sa.String(36), nullable=True),
        sa.Column("batch_id", sa.String(36), nullable=True),
        sa.Column("client_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["batch_id"], ["media_batches.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("batch_id"),
    )
    op.create_index("ix_discussion_kind", "discussion", ["kind"])
    op.create_index("ix_discussion_created_by_id", "discussion", ["created_by_id"])
    op.create_index("ix_discussion_batch_id", "discussion", ["batch_id"], unique=True)
    op.create_index("ix_discussion_client_name", "discussion", ["client_name"])
    op.create_index("ix_discussion_updated_at", "discussion", ["updated_at"])

    op.create_table(
        "discussion_message",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("discussion_id", sa.String(36), nullable=False),
        sa.Column("author_id", sa.String(36), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("reply_to_id", sa.String(36), nullable=True),
        sa.Column("batch_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussion.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reply_to_id"], ["discussion_message.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["batch_id"], ["media_batches.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_discussion_message_discussion_id", "discussion_message", ["discussion_id"])
    op.create_index("ix_discussion_message_author_id", "discussion_message", ["author_id"])
    op.create_index("ix_discussion_message_reply_to_id", "discussion_message", ["reply_to_id"])
    op.create_index("ix_discussion_message_batch_id", "discussion_message", ["batch_id"])
    op.create_index("ix_discussion_message_created_at", "discussion_message", ["created_at"])

    op.create_table(
        "discussion_member",
        sa.Column("discussion_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("last_read_message_id", sa.String(36), nullable=True),
        sa.Column("notifications_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussion.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["last_read_message_id"], ["discussion_message.id"], ondelete="SET NULL"),
    )

    op.create_table(
        "discussion_attachment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("message_id", sa.String(36), nullable=False),
        sa.Column("media_id", sa.String(36), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["discussion_message.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["media_id"], ["media_files.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_discussion_attachment_message_id", "discussion_attachment", ["message_id"])
    op.create_index("ix_discussion_attachment_media_id", "discussion_attachment", ["media_id"])

    op.create_table(
        "message_reaction",
        sa.Column("message_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("emoji", sa.String(24), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["discussion_message.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_table(
        "message_like",
        sa.Column("message_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["discussion_message.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_table(
        "notification",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("discussion_id", sa.String(36), nullable=True),
        sa.Column("message_id", sa.String(36), nullable=True),
        sa.Column("actor_id", sa.String(36), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussion.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["discussion_message.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
    )
    for column in ("user_id", "kind", "discussion_id", "message_id", "read_at", "created_at"):
        op.create_index(f"ix_notification_{column}", "notification", [column])


def downgrade() -> None:
    op.drop_table("notification")
    op.drop_table("message_like")
    op.drop_table("message_reaction")
    op.drop_table("discussion_attachment")
    op.drop_table("discussion_member")
    op.drop_table("discussion_message")
    op.drop_table("discussion")
