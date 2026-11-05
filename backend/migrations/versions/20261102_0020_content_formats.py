"""Add content formats, media limits and availability data.

Revision ID: 20261102_0020
Revises: 20261102_0019
"""

import sqlalchemy as sa
from alembic import op

revision = "20261102_0020"
down_revision = "20261102_0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("content_item") as batch_op:
        batch_op.add_column(
            sa.Column(
                "content_format",
                sa.Enum("POST", "STORY", "AVAILABILITY", name="contentformat"),
                nullable=False,
                server_default="POST",
            )
        )
        batch_op.add_column(sa.Column("media_limit", sa.Integer(), nullable=False, server_default="1"))
        batch_op.add_column(sa.Column("availability_staff_id", sa.BigInteger(), nullable=True))
        batch_op.add_column(
            sa.Column("availability_slots_json", sa.Text(), nullable=False, server_default="[]")
        )
    op.create_index("ix_content_item_content_format", "content_item", ["content_format"])


def downgrade() -> None:
    op.drop_index("ix_content_item_content_format", table_name="content_item")
    with op.batch_alter_table("content_item") as batch_op:
        batch_op.drop_column("availability_slots_json")
        batch_op.drop_column("availability_staff_id")
        batch_op.drop_column("media_limit")
        batch_op.drop_column("content_format")
