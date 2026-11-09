"""Track only publications explicitly approved for automatic delivery."""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0030"
down_revision = "20261105_0029"
branch_labels = None
depends_on = None


def upgrade():
    # Some deployments contain only a historical 0029 marker. Repair missing
    # columns on fresh databases without overwriting existing permission choices.
    inspector = sa.inspect(op.get_bind())
    if "can_delete_workspaces" not in {column["name"] for column in inspector.get_columns("users")}:
        op.add_column("users", sa.Column("can_delete_workspaces", sa.Boolean(), nullable=False, server_default=sa.false()))
        op.execute("UPDATE users SET can_delete_workspaces = 1 WHERE login IN ('mariaadmin', 'violettaadmin') OR role = 'OWNER'")
    if "deleted_at" not in {column["name"] for column in inspector.get_columns("workspaces")}:
        op.add_column("workspaces", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "scheduled_publication_job",
        sa.Column("publication_id", sa.String(36), sa.ForeignKey("content_publication.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("approved_by_id", sa.String(36), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_scheduled_publication_job_state", "scheduled_publication_job", ["state"])


def downgrade():
    op.drop_index("ix_scheduled_publication_job_state", table_name="scheduled_publication_job")
    op.drop_table("scheduled_publication_job")
