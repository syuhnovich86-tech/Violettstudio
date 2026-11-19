"""Enable phone sync by default for owners and administrators."""
from alembic import op

revision = "20261119_0040"
down_revision = "20261118_0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE users SET can_import_ios_photo_library = TRUE, "
               "can_import_android_photo_library = TRUE WHERE upper(role) IN ('ADMIN', 'OWNER')")


def downgrade() -> None:
    # A downgrade must preserve any choices made since the upgrade.
    pass
