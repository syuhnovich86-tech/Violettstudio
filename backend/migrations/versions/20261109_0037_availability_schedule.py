"""Per-master schedules for availability publications."""
from alembic import op
import sqlalchemy as sa

revision = '20261109_0037'
down_revision = '20261108_0036'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('availability_publication_schedule',
        sa.Column('staff_id', sa.BigInteger(), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('frequency', sa.String(8), nullable=False),
        sa.Column('weekdays_json', sa.Text(), nullable=False),
        sa.Column('time_local', sa.String(5), nullable=False),
        sa.Column('publish_new', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('targets_json', sa.Text(), nullable=False),
        sa.Column('seen_slots_json', sa.Text(), nullable=True),
        sa.Column('checked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_regular_date', sa.String(10), nullable=True),
        sa.Column('last_event_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('last_item_id', sa.String(36), nullable=True),
        sa.Column('busy', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table('availability_publication_schedule')
