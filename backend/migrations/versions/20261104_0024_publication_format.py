"""Store each platform's selected publication format.

Revision ID: 20261104_0024
Revises: 20261104_0023
"""
import sqlalchemy as sa
from alembic import op

revision = "20261104_0024"
down_revision = "20261104_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("content_publication", sa.Column("publication_format", sa.String(16), nullable=False, server_default="post"))


def downgrade() -> None:
    op.drop_column("content_publication", "publication_format")
