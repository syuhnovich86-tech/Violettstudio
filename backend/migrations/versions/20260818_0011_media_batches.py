"""Add media batches with shared comment.

Revision ID: 20260818_0011
Revises: 20260816_0010
Create Date: 2026-08-18
"""

import sqlalchemy as sa
from alembic import op

revision = "20260818_0011"
down_revision = "20260816_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "media_batches",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column("yclients_record_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["yclients_record_id"],
            ["yclients_visits.record_id"],
            ondelete="SET NULL",
        ),
    )

    with op.batch_alter_table("media_batches") as batch_op:
        batch_op.create_index(
            "ix_media_batches_workspace_id",
            ["workspace_id"],
        )
        batch_op.create_index(
            "ix_media_batches_created_by_id",
            ["created_by_id"],
        )
        batch_op.create_index(
            "ix_media_batches_yclients_record_id",
            ["yclients_record_id"],
        )
        batch_op.create_index(
            "ix_media_batches_created_at",
            ["created_at"],
        )

    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(
            sa.Column("batch_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_media_files_batch_id",
            "media_batches",
            ["batch_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_media_files_batch_id",
            ["batch_id"],
        )


def downgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_index("ix_media_files_batch_id")
        batch_op.drop_constraint(
            "fk_media_files_batch_id",
            type_="foreignkey",
        )
        batch_op.drop_column("batch_id")

    op.drop_index(
        "ix_media_batches_workspace_id",
        table_name="media_batches",
    )
    op.drop_index(
        "ix_media_batches_created_at",
        table_name="media_batches",
    )
    op.drop_index(
        "ix_media_batches_yclients_record_id",
        table_name="media_batches",
    )
    op.drop_index(
        "ix_media_batches_created_by_id",
        table_name="media_batches",
    )
    op.drop_table("media_batches")
