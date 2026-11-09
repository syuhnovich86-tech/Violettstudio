"""Grant separately controlled access to studio analytics.

Revision ID: 20261108_0033
Revises: 20261106_0032
"""
from alembic import op
import sqlalchemy as sa

revision = '20261108_0033'
down_revision = '20261106_0032'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('can_access_analytics', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute(sa.text("UPDATE users SET can_access_analytics = true WHERE id IN ('d3aa3b54-770d-4d29-b239-6ea0adacadb8', '9291627b-9b25-45d1-b5d7-943d7242d498')"))


def downgrade():
    op.drop_column('users', 'can_access_analytics')
