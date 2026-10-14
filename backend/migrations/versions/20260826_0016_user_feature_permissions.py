"""add feature permissions to users

Revision ID: 20260826_0016
Revises: 20260826_0015
"""

from alembic import op
import sqlalchemy as sa


revision = "20260826_0016"
down_revision = "20260826_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column("can_add_comments", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        batch_op.add_column(
            sa.Column("can_upload_media", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        batch_op.add_column(
            sa.Column("can_access_admin", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(
            sa.Column("can_access_chats", sa.Boolean(), nullable=False, server_default=sa.true())
        )
    op.execute(
        sa.text("UPDATE users SET can_access_admin = 1 WHERE role IN ('OWNER', 'ADMIN')")
    )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("can_access_chats")
        batch_op.drop_column("can_access_admin")
        batch_op.drop_column("can_upload_media")
        batch_op.drop_column("can_add_comments")
