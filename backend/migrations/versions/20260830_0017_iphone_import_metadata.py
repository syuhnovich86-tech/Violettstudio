"""Add location metadata and rename the iPhone private archive.

Revision ID: 20260830_0017
Revises: 20260826_0016
"""

import sqlalchemy as sa
from alembic import op

revision = "20260830_0017"
down_revision = "20260826_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("gps_latitude", sa.Float(), nullable=True))
        batch_op.add_column(sa.Column("gps_longitude", sa.Float(), nullable=True))
        batch_op.add_column(sa.Column("location_country", sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column("location_city", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("location_key", sa.String(length=220), nullable=True))
        batch_op.create_index("ix_media_files_location_key", ["location_key"])
    op.create_index(
        "ix_media_files_workspace_location_capture",
        "media_files",
        ["workspace_id", "location_key", "captured_at"],
    )
    op.execute(
        sa.text(
            """
            UPDATE workspaces
            SET display_name = 'Фото с iPhone'
            WHERE kind = 'PRIVATE'
              AND display_name = 'Блог'
              AND owner_id IN (SELECT id FROM users WHERE login = 'violet29')
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE workspaces
            SET display_name = 'Блог'
            WHERE kind = 'PRIVATE'
              AND display_name = 'Фото с iPhone'
              AND owner_id IN (SELECT id FROM users WHERE login = 'violet29')
            """
        )
    )
    op.drop_index("ix_media_files_workspace_location_capture", table_name="media_files")
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_index("ix_media_files_location_key")
        batch_op.drop_column("location_key")
        batch_op.drop_column("location_city")
        batch_op.drop_column("location_country")
        batch_op.drop_column("gps_longitude")
        batch_op.drop_column("gps_latitude")
