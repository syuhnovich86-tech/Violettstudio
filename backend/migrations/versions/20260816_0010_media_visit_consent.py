"""Link media to YCLIENTS visits and publication consent.

Revision ID: 20260816_0010
Revises: 20260816_0009
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op

revision = "20260816_0010"
down_revision = "20260816_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("yclients_record_id", sa.BigInteger(), nullable=True))
        batch_op.add_column(
            sa.Column("publication_allowed", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.create_foreign_key(
            "fk_media_files_yclients_record_id",
            "yclients_visits",
            ["yclients_record_id"],
            ["record_id"],
            ondelete="SET NULL",
        )
        batch_op.create_index("ix_media_files_yclients_record_id", ["yclients_record_id"])
        batch_op.create_index("ix_media_files_publication_allowed", ["publication_allowed"])


def downgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_index("ix_media_files_publication_allowed")
        batch_op.drop_index("ix_media_files_yclients_record_id")
        batch_op.drop_constraint("fk_media_files_yclients_record_id", type_="foreignkey")
        batch_op.drop_column("publication_allowed")
        batch_op.drop_column("yclients_record_id")
