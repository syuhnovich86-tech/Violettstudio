"""add per-file media comments

Revision ID: 20260822_0013
Revises: 20260822_0012
"""

from alembic import op
import sqlalchemy as sa


revision = "20260822_0013"
down_revision = "20260822_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("comment", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_column("comment")
