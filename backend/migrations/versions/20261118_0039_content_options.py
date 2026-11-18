"""Preserve explicit publication and image text choices."""
from alembic import op
import sqlalchemy as sa

revision = "20261118_0039"
down_revision = "20261115_0038"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("content_item", sa.Column("no_caption", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("content_item", sa.Column("no_title_on_image", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("content_item", "no_title_on_image")
    op.drop_column("content_item", "no_caption")
