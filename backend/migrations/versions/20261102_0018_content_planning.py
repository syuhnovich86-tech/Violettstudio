"""Add weekly content planning and per-platform publication jobs.

Revision ID: 20261102_0018
Revises: 20260830_0017
"""

import sqlalchemy as sa
from alembic import op

revision = "20261102_0018"
down_revision = "20260830_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column("can_access_content", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    op.execute(
        sa.text(
            "UPDATE users SET can_access_content = 1 WHERE login IN ('stepan', 'violet29') OR role = 'OWNER'"
        )
    )
    op.create_table(
        "content_item",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.String(length=180), nullable=False),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column("status", sa.Enum("DRAFT", "REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED", "FAILED", name="contentstatus"), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("media_ids_json", sa.Text(), nullable=False),
        sa.Column("created_by_id", sa.String(length=36), nullable=False),
        sa.Column("approved_by_id", sa.String(length=36), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["approved_by_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_content_item_status", "content_item", ["status"])
    op.create_index("ix_content_item_scheduled_at", "content_item", ["scheduled_at"])
    op.create_index("ix_content_item_created_by_id", "content_item", ["created_by_id"])
    op.create_table(
        "content_publication",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("content_item_id", sa.String(length=36), nullable=False),
        sa.Column("platform", sa.Enum("TELEGRAM", "MAX", "INSTAGRAM", name="publicationplatform"), nullable=False),
        sa.Column("status", sa.Enum("PENDING", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", name="publicationstatus"), nullable=False),
        sa.Column("external_id", sa.String(length=255), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["content_item_id"], ["content_item.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_content_publication_content_item_id", "content_publication", ["content_item_id"])
    op.create_index("ix_content_publication_platform", "content_publication", ["platform"])
    op.create_index("ix_content_publication_status", "content_publication", ["status"])
    op.create_index(
        "uq_content_publication_item_platform",
        "content_publication",
        ["content_item_id", "platform"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("content_publication")
    op.drop_table("content_item")
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("can_access_content")
