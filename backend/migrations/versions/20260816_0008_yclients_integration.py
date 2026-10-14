"""Add YCLIENTS integration state.

Revision ID: 20260816_0008
Revises: 20260816_0007
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op

revision = "20260816_0008"
down_revision = "20260816_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "yclients_integrations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("salon_id", sa.BigInteger(), nullable=False),
        sa.Column("application_id", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("salon_id"),
    )
    op.create_index("ix_yclients_integrations_salon_id", "yclients_integrations", ["salon_id"])
    op.create_index("ix_yclients_integrations_status", "yclients_integrations", ["status"])


def downgrade() -> None:
    op.drop_index("ix_yclients_integrations_status", table_name="yclients_integrations")
    op.drop_index("ix_yclients_integrations_salon_id", table_name="yclients_integrations")
    op.drop_table("yclients_integrations")
