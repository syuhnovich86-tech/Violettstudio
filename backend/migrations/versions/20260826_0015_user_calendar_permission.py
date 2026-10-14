"""add calendar permission to users

Revision ID: 20260826_0015
Revises: 20260822_0014
"""

from alembic import op
import sqlalchemy as sa


revision = "20260826_0015"
down_revision = "20260822_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column("can_view_all_calendars", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    op.execute(
        sa.text(
            "UPDATE users SET can_view_all_calendars = 1 "
            "WHERE role IN ('OWNER', 'ADMIN') OR login IN ('stepan', 'violet29', 'violettaadmin', 'mariaadmin')"
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("can_view_all_calendars")
