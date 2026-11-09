"""Add soft deletion for workspaces.

Revision ID: 20261106_0031
Revises: 20261106_0030
"""

from alembic import op
import sqlalchemy as sa


revision = "20261106_0031"
down_revision = "20261106_0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Some early installations received this column outside Alembic.  Make the
    # migration safe to run there as well, rather than preventing the app from
    # starting because SQLite reports a duplicate column.
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("workspaces")}
    if "deleted_at" not in columns:
        op.add_column(
            "workspaces",
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )

    indexes = {index["name"] for index in inspector.get_indexes("workspaces")}
    if "ix_workspaces_deleted_at" not in indexes:
        op.create_index("ix_workspaces_deleted_at", "workspaces", ["deleted_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_workspaces_deleted_at", table_name="workspaces")
    op.drop_column("workspaces", "deleted_at")
