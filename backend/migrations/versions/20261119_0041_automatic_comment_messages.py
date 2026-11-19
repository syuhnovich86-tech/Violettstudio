"""Keep generated media descriptions out of staff discussions."""
from alembic import op
import sqlalchemy as sa

revision = "20261119_0041"
down_revision = "20261119_0040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "discussion_message",
        sa.Column("is_automatic", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Legacy repair created a batch and its first attached message together, with
    # no manual-comment audit event or notification. Never classify by wording alone.
    op.execute("""
        UPDATE discussion_message AS m SET is_automatic = TRUE
        WHERE m.edited_at IS NULL AND m.reply_to_id IS NULL
          AND EXISTS (
            SELECT 1 FROM discussion d
            JOIN media_batches b ON b.id = d.batch_id
            JOIN discussion_attachment a ON a.message_id = m.id
            JOIN media_files f ON f.id = a.media_id AND f.batch_id = b.id
            WHERE d.id = m.discussion_id AND d.kind = 'BATCH' AND b.comment IS NULL
              AND m.batch_id = b.id AND m.author_id = COALESCE(f.uploaded_by_id, f.owner_id)
              AND m.id = (SELECT first.id FROM discussion_message first
                          WHERE first.discussion_id = d.id ORDER BY first.created_at, first.id LIMIT 1)
              AND (
                (f.storage_key LIKE 'generated/%' AND
                  (m.body = f.comment OR m.body LIKE 'Сгенерированный контент:%'
                                      OR m.body = 'Автоматически собранный макет свободных окон'))
                OR (f.original_name LIKE 'generated-creative-%' AND m.body LIKE 'Сгенерированный контент:%')
                OR (f.original_name LIKE 'generated-availability-%' AND m.body = 'Автоматически собранный макет свободных окон')
              )
              AND NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.action = 'media.comment.update'
                              AND l.target_type = 'media_file' AND l.target_id = f.id
                              AND julianday(l.created_at) <= julianday(m.created_at) + 1.0 / 86400)
          )
          AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.message_id = m.id)
    """)
    # Keep the branch and its links for any staff replies, including future ones.
    # Its old preview title was copied directly from the now hidden message.
    op.execute("""
        UPDATE discussion SET title = 'Комментарии к серии'
        WHERE kind = 'BATCH' AND title LIKE 'Комментарий: %'
          AND EXISTS (SELECT 1 FROM discussion_message m WHERE m.discussion_id = discussion.id
                      AND m.is_automatic = TRUE)
    """)


def downgrade() -> None:
    rows = op.get_bind().execute(sa.text("""
        SELECT d.id, m.body FROM discussion d
        JOIN discussion_message m ON m.discussion_id = d.id AND m.is_automatic = TRUE
        WHERE d.title = 'Комментарии к серии'
    """)).all()
    for discussion_id, body in rows:
        excerpt = " ".join(body.split())
        if len(excerpt) > 80:
            excerpt = excerpt[:77] + "…"
        op.get_bind().execute(
            sa.text("UPDATE discussion SET title = :title WHERE id = :id"),
            {"title": "Комментарий: " + excerpt, "id": discussion_id},
        )
    op.drop_column("discussion_message", "is_automatic")
