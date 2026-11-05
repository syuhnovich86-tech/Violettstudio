"""Separate topic approval from generated publication approval.

Revision ID: 20261102_0019
Revises: 20261102_0018
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261102_0019"
down_revision: str | None = "20261102_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("content_publication", sa.Column("caption", sa.Text(), nullable=True))
    op.add_column(
        "content_publication",
        sa.Column("media_ids_json", sa.Text(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("content_publication", "media_ids_json")
    op.drop_column("content_publication", "caption")
