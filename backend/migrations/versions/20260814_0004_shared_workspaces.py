"""Track uploader for shared workspaces.

Revision ID: 20260814_0004
Revises: 20260814_0003
Create Date: 2026-08-14
"""

import sqlalchemy as sa
from alembic import op

revision = "20260814_0004"
down_revision = "20260814_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("uploaded_by_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_media_files_uploaded_by_id_users", "users", ["uploaded_by_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_constraint("fk_media_files_uploaded_by_id_users", type_="foreignkey")
        batch_op.drop_column("uploaded_by_id")
