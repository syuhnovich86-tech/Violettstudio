"""Add YCLIENTS staff mappings and visit cache.

Revision ID: 20260816_0009
Revises: 20260816_0008
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op

revision = "20260816_0009"
down_revision = "20260816_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "yclients_staff_mappings",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("salon_id", sa.BigInteger(), nullable=False),
        sa.Column("staff_id", sa.BigInteger(), nullable=False),
        sa.Column("staff_name", sa.String(length=120), nullable=False),
        sa.Column("specialization", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
        sa.UniqueConstraint("staff_id"),
    )
    op.create_index("ix_yclients_staff_mappings_salon_id", "yclients_staff_mappings", ["salon_id"])
    op.create_index("ix_yclients_staff_mappings_staff_id", "yclients_staff_mappings", ["staff_id"])

    op.create_table(
        "yclients_visits",
        sa.Column("record_id", sa.BigInteger(), nullable=False),
        sa.Column("salon_id", sa.BigInteger(), nullable=False),
        sa.Column("staff_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("client_id", sa.BigInteger(), nullable=True),
        sa.Column("client_display_name", sa.String(length=200), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("service_titles", sa.Text(), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("attendance", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("record_id"),
    )
    for column in ("salon_id", "staff_id", "user_id", "client_id", "starts_at", "deleted"):
        op.create_index(f"ix_yclients_visits_{column}", "yclients_visits", [column])


def downgrade() -> None:
    for column in ("deleted", "starts_at", "client_id", "user_id", "staff_id", "salon_id"):
        op.drop_index(f"ix_yclients_visits_{column}", table_name="yclients_visits")
    op.drop_table("yclients_visits")
    op.drop_index("ix_yclients_staff_mappings_staff_id", table_name="yclients_staff_mappings")
    op.drop_index("ix_yclients_staff_mappings_salon_id", table_name="yclients_staff_mappings")
    op.drop_table("yclients_staff_mappings")
