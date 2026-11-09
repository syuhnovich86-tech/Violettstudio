"""Track Android push tokens and delivered notifications.

Revision ID: 20261106_0032
Revises: 20261106_0031
"""
from alembic import op
import sqlalchemy as sa

revision = "20261106_0032"
down_revision = "20261106_0031"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("mobile_push_token",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token", sa.Text(), unique=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_mobile_push_token_user_id", "mobile_push_token", ["user_id"])
    op.create_index("ix_mobile_push_token_session_id", "mobile_push_token", ["session_id"])
    op.create_table("mobile_push_delivery",
        sa.Column("notification_id", sa.String(36), sa.ForeignKey("notification.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("token_id", sa.String(36), sa.ForeignKey("mobile_push_token.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_table("mobile_push_delivery")
    op.drop_table("mobile_push_token")
