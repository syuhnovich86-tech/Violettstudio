"""Add real studio and private workspaces.

Revision ID: 20260814_0005
Revises: 20260814_0004
Create Date: 2026-08-14
"""

import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "20260814_0005"
down_revision = "20260814_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column(
            "kind",
            sa.Enum("STUDIO", "PRIVATE", name="workspacekind"),
            nullable=False,
        ),
        sa.Column("owner_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_workspaces_kind"), "workspaces", ["kind"])
    op.create_index(op.f("ix_workspaces_owner_id"), "workspaces", ["owner_id"])
    op.create_table(
        "workspace_members",
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workspace_id", "user_id"),
    )
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.add_column(sa.Column("workspace_id", sa.String(length=36), nullable=True))

    connection = op.get_bind()
    users = connection.execute(sa.text("SELECT id, display_name FROM users")).mappings()
    now = datetime.now(UTC)
    for user in users:
        workspace_id = str(uuid.uuid4())
        connection.execute(
            sa.text(
                "INSERT INTO workspaces (id, display_name, kind, owner_id, created_at) "
                "VALUES (:id, :display_name, 'STUDIO', :owner_id, :created_at)"
            ),
            {
                "id": workspace_id,
                "display_name": user["display_name"],
                "owner_id": user["id"],
                "created_at": now,
            },
        )
        connection.execute(
            sa.text(
                "UPDATE media_files SET workspace_id = :workspace_id WHERE owner_id = :owner_id"
            ),
            {"workspace_id": workspace_id, "owner_id": user["id"]},
        )

    with op.batch_alter_table("media_files") as batch_op:
        batch_op.alter_column("workspace_id", existing_type=sa.String(length=36), nullable=False)
        batch_op.create_foreign_key(
            "fk_media_files_workspace_id_workspaces",
            "workspaces",
            ["workspace_id"],
            ["id"],
        )
        batch_op.create_index(op.f("ix_media_files_workspace_id"), ["workspace_id"])


def downgrade() -> None:
    with op.batch_alter_table("media_files") as batch_op:
        batch_op.drop_index(op.f("ix_media_files_workspace_id"))
        batch_op.drop_constraint("fk_media_files_workspace_id_workspaces", type_="foreignkey")
        batch_op.drop_column("workspace_id")
    op.drop_table("workspace_members")
    op.drop_index(op.f("ix_workspaces_owner_id"), table_name="workspaces")
    op.drop_index(op.f("ix_workspaces_kind"), table_name="workspaces")
    op.drop_table("workspaces")
