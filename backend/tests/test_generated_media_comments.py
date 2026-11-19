from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from tests.test_media import add_user, jpeg_bytes, sign_in, sign_out
from vita29.db.models import (
    DiscussionAttachment, DiscussionMessage, MediaBatch, MediaFile, User, UserRole,
)
from vita29.db.session import create_database_engine
from vita29.discussions.service import ensure_comment_discussion


def test_only_staff_comments_appear_after_legacy_migration(client: TestClient, tmp_path: Path):
    db_path = tmp_path / "test.db"
    author, workspace = add_user(db_path, "author", UserRole.EMPLOYEE)
    add_user(db_path, "reader", UserRole.EMPLOYEE)
    csrf = sign_in(client, "author")
    headers = {"X-CSRF-Token": csrf}
    description = "Сгенерированный контент: @Reader пример"
    slots = "Автоматически собранный макет свободных окон"
    engine = create_database_engine(f"sqlite:///{db_path}")

    def upload(name):
        response = client.post(
            f"/api/v1/media?workspace_id={workspace.id}", headers=headers,
            files={"upload": (name, jpeg_bytes(), "image/jpeg")},
        )
        assert response.status_code == 201
        return response.json()["id"]

    fresh, old, mixed, manual = [upload(f"generated-creative-{i}.jpg") for i in range(4)]
    with Session(engine) as db:
        for media_id in (fresh, old, mixed, manual):
            media = db.get(MediaFile, media_id)
            media.storage_key = f"generated/creative/{media_id}.jpg"
            media.comment = slots if media_id == old else description
        # Reproduce the first attached message written by the previous automatic repair.
        ids = []
        for media_id in (old, mixed):
            media = db.get(MediaFile, media_id)
            batch = MediaBatch(workspace_id=workspace.id, created_by_id=author.id)
            db.add(batch)
            db.flush()
            media.batch_id = batch.id
            thread = ensure_comment_discussion(db, batch, db.get(User, author.id), media.comment)
            message = DiscussionMessage(
                discussion_id=thread.id, batch_id=batch.id, author_id=author.id, body=media.comment,
            )
            db.add(message)
            db.flush()
            db.add(DiscussionAttachment(message_id=message.id, media_id=media.id))
            ids.append((thread.id, message.id))
        db.commit()
    (old_thread, _), (mixed_thread, mixed_root) = ids
    reply = client.post(
        f"/api/v1/discussions/{mixed_thread}/messages", headers=headers,
        json={"body": "Проверено мастером", "reply_to_id": mixed_root},
    )
    assert reply.status_code == 201
    assert client.put(f"/api/v1/media/{manual}/comment", headers=headers,
                      json={"comment": description}).status_code == 200
    with engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE discussion_message DROP COLUMN is_automatic")
        cfg = Config()
        cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
        revision = ScriptDirectory.from_config(cfg).get_revision("20261119_0041")
        with Operations.context(MigrationContext.configure(conn)):
            revision.module.upgrade()

    sign_out(client, csrf)
    reader_csrf = sign_in(client, "reader")
    for _ in range(2):
        topics = [r for r in client.get("/api/v1/discussions").json() if r["kind"] == "batch"]
        assert len(topics) == 2
        assert old_thread not in [r["id"] for r in topics]
        mixed_topic = next(r for r in topics if r["id"] == mixed_thread)
        assert mixed_topic["unread_count"] == 1
        assert mixed_topic["first_unread_message_id"] == reply.json()["id"]
        assert not mixed_topic["mentioned_me"] and description not in mixed_topic["title"]
        assert mixed_topic["last_message"] == "Проверено мастером"
    messages = client.get(f"/api/v1/discussions/{mixed_thread}/messages").json()
    assert [(m["body"], m["reply_to"]) for m in messages] == [("Проверено мастером", None)]
    assert client.get(f"/api/v1/discussions/{mixed_thread}/messages", params={"q": description}).json() == []
    assert client.get(f"/api/v1/discussions/{old_thread}/messages").json() == []
    notices = client.get("/api/v1/discussions/notifications/inbox").json()["notifications"]
    assert any(n["kind"] == "media.comment.mention" for n in notices)
    assert next(t for t in topics if t["id"] != mixed_thread)["mentioned_me"]
    with Session(engine) as db:
        assert db.get(MediaFile, fresh).batch_id is None
        assert db.get(MediaFile, old).comment == slots
        assert len(db.scalars(select(DiscussionMessage).where(DiscussionMessage.is_automatic)).all()) == 2

    sign_out(client, reader_csrf)
    csrf = sign_in(client, "author")
    response = client.put(f"/api/v1/media/{old}/comment", headers={"X-CSRF-Token": csrf},
                          json={"comment": "Новый комментарий сотрудника"})
    assert response.status_code == 200
    topics = client.get("/api/v1/discussions").json()
    assert next(t for t in topics if t["id"] == old_thread)["title"] == "Комментарий: Новый комментарий сотрудника"
    assert [m["body"] for m in client.get(f"/api/v1/discussions/{old_thread}/messages").json()] == ["Новый комментарий сотрудника"]
