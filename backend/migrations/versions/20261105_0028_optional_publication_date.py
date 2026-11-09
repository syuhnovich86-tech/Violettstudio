"""Track whether the calendar date is an actual publication date.

Revision ID: 20261105_0028
Revises: 20261105_0027
"""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0028"
down_revision = "20261105_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("content_item", sa.Column("publication_date_assigned", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    op.drop_column("content_item", "publication_date_assigned")
