"""Add the persistent editorial marker for content-ready media.

Revision ID: 20261104_0022
Revises: 20261102_0021
"""

import sqlalchemy as sa
from alembic import op

revision = "20261104_0022"
down_revision = "20261102_0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(
            sa.Column("content_marked", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    op.create_index("ix_media_files_content_marked", "media_files", ["content_marked"])


def downgrade() -> None:
    op.drop_index("ix_media_files_content_marked", table_name="media_files")
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_column("content_marked")
