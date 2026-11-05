"""Store editor guidance for a content item.

Revision ID: 20261102_0021
Revises: 20261102_0020
"""

import sqlalchemy as sa
from alembic import op

revision = "20261102_0021"
down_revision = "20261102_0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("content_item") as batch_op:
        batch_op.add_column(sa.Column("editor_instruction", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("content_item") as batch_op:
        batch_op.drop_column("editor_instruction")
