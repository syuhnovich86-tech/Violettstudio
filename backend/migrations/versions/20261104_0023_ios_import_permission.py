"""Add explicit permission for full iOS Photo Library import.

Revision ID: 20261104_0023
Revises: 20261104_0022
"""

import sqlalchemy as sa
from alembic import op

revision = "20261104_0023"
down_revision = "20261104_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column(
                "can_import_ios_photo_library",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
    op.execute(
        sa.text(
            "UPDATE users SET can_import_ios_photo_library = 1 "
            "WHERE role = 'OWNER' OR lower(login) IN ('violet29', 'violetta')"
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("can_import_ios_photo_library")
