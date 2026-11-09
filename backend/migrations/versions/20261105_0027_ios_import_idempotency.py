"""Keep retried iOS photo imports from creating duplicate media files.

Revision ID: 20261105_0027
Revises: 20261105_0026
"""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0027"
down_revision = "20261105_0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("media_files", sa.Column("ios_import_key", sa.String(length=64), nullable=True))
    op.create_index("ix_media_files_ios_import_key", "media_files", ["ios_import_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_media_files_ios_import_key", table_name="media_files")
    op.drop_column("media_files", "ios_import_key")
