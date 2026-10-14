"""Store original photo capture dates.

Revision ID: 20260816_0007
Revises: 20260816_0006
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op

revision = "20260816_0007"
down_revision = "20260816_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index("ix_media_files_captured_at", ["captured_at"])
    op.create_index(
        "ix_media_files_workspace_active_captured",
        "media_files",
        ["workspace_id", "deleted_at", "captured_at", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_media_files_workspace_active_captured", table_name="media_files")
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_index("ix_media_files_captured_at")
        batch_op.drop_column("captured_at")
