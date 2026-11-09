"""Allow one publication per platform and format.

Revision ID: 20261108_0035
Revises: 20261108_0034
"""
from alembic import op

revision = '20261108_0035'
down_revision = '20261108_0034'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index('uq_content_publication_item_platform', table_name='content_publication')
    op.create_index('uq_content_publication_item_platform_format', 'content_publication',
                    ['content_item_id', 'platform', 'publication_format'], unique=True)


def downgrade():
    # The downgrade must not silently discard one of the published formats.
    op.create_index('uq_content_publication_item_platform', 'content_publication',
                    ['content_item_id', 'platform'], unique=True)
    op.drop_index('uq_content_publication_item_platform_format', table_name='content_publication')
