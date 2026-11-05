"""Create revocable short-lived public media links for external publishers.

Revision ID: 20261105_0026
Revises: 20261105_0025
"""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0026"
down_revision = "20261105_0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "temporary_public_media_link",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("media_file_id", sa.String(length=36), nullable=False),
        sa.Column("publication_id", sa.String(length=36), nullable=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["media_file_id"], ["media_files.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["publication_id"], ["content_publication.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_temporary_public_media_link_media_file_id", "temporary_public_media_link", ["media_file_id"])
    op.create_index("ix_temporary_public_media_link_publication_id", "temporary_public_media_link", ["publication_id"])
    op.create_index("ix_temporary_public_media_link_token_hash", "temporary_public_media_link", ["token_hash"])
    op.create_index("ix_temporary_public_media_link_expires_at", "temporary_public_media_link", ["expires_at"])


def downgrade() -> None:
    op.drop_table("temporary_public_media_link")
