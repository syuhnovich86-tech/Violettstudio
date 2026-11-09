"""Remember media selected for each publication format."""
from alembic import op
import sqlalchemy as sa

revision = '20261108_0036'
down_revision = '20261108_0035'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('content_publication', sa.Column('media_override_ids_json', sa.Text(), nullable=True))

def downgrade():
    op.drop_column('content_publication', 'media_override_ids_json')
