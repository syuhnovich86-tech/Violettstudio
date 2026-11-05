"""Restore the historical revision marker used by the production database.

Revision ID: 20261105_0029
Revises: 20261105_0028

The production database was stamped with this revision while the corresponding
migration file was absent from the deployment source.  It introduced no schema
that is required by the current application, so this marker keeps Alembic's
history consistent without changing existing data.
"""

revision = "20261105_0029"
down_revision = "20261105_0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Preserve the historic production revision without a schema change."""


def downgrade() -> None:
    """No schema change to revert."""

