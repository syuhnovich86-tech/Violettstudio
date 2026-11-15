"""Retain publication history when removing a card from the plan."""
from alembic import op
import sqlalchemy as sa

revision = "20261115_0038"
down_revision = "20261109_0037"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("content_item", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("content_item", "deleted_at")
