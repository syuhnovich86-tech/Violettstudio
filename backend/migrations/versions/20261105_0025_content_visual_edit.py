"""Remember whether a selected source image must be processed by AI.

Revision ID: 20261105_0025
Revises: 20261104_0024
"""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0025"
down_revision = "20261104_0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "content_item",
        sa.Column("visual_edit_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("content_item", "visual_edit_requested")
