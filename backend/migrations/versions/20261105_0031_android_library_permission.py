"""Allow the owner to grant Android library backup per user."""
import sqlalchemy as sa
from alembic import op

revision = "20261105_0031"
down_revision = "20261105_0030"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("can_import_android_photo_library", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("users", "can_import_android_photo_library")
