"""Store an explicit light or dark family for generated visuals.

Revision ID: 20261106_0030
Revises: 20261105_0031
Create Date: 2026-11-06
"""

from alembic import op
import sqlalchemy as sa


revision = "20261106_0030"
down_revision = "20261105_0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "content_item",
        sa.Column("visual_style", sa.String(length=8), nullable=False, server_default="auto"),
    )


def downgrade() -> None:
    op.drop_column("content_item", "visual_style")
