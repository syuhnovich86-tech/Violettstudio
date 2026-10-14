"""Add workspace creation permissions and initial shared folders.

Revision ID: 20260816_0006
Revises: 20260814_0005
Create Date: 2026-08-16
"""

import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "20260816_0006"
down_revision = "20260814_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_media_files_workspace_active_created",
        "media_files",
        ["workspace_id", "deleted_at", "created_at"],
    )
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "can_create_shared_workspaces",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            )
        )
        batch_op.add_column(
            sa.Column(
                "can_create_private_workspaces",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )

    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE users SET can_create_private_workspaces = 1 "
            "WHERE login IN ('stepan', 'violet29') OR role = 'OWNER'"
        )
    )
    owner_id = connection.execute(
        sa.text("SELECT id FROM users WHERE login = 'stepan' LIMIT 1")
    ).scalar()
    if owner_id:
        now = datetime.now(UTC)
        for name in ("смас", "губы филлер", "РФ лифтинг", "веко", "био"):
            exists = connection.execute(
                sa.text(
                    "SELECT 1 FROM workspaces WHERE kind = 'STUDIO' "
                    "AND lower(display_name) = lower(:name) LIMIT 1"
                ),
                {"name": name},
            ).scalar()
            if not exists:
                connection.execute(
                    sa.text(
                        "INSERT INTO workspaces (id, display_name, kind, owner_id, created_at) "
                        "VALUES (:id, :name, 'STUDIO', :owner_id, :created_at)"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "name": name,
                        "owner_id": owner_id,
                        "created_at": now,
                    },
                )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "DELETE FROM workspaces WHERE kind = 'STUDIO' "
            "AND display_name IN ('смас', 'губы филлер', 'РФ лифтинг', 'веко', 'био') "
            "AND id NOT IN (SELECT DISTINCT workspace_id FROM media_files)"
        )
    )
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("can_create_private_workspaces")
        batch_op.drop_column("can_create_shared_workspaces")
    op.drop_index("ix_media_files_workspace_active_created", table_name="media_files")
