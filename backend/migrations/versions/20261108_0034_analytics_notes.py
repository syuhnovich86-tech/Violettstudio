"""Persist generated analytics notes.

Revision ID: 20261108_0034
Revises: 20261108_0033
"""
from alembic import op
import sqlalchemy as sa

revision = '20261108_0034'
down_revision = '20261108_0033'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('analytics_notes',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('author_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('platform', sa.String(20), nullable=False),
        sa.Column('days', sa.Integer(), nullable=False),
        sa.Column('result_json', sa.Text(), nullable=False))

def downgrade():
    op.drop_table('analytics_notes')
