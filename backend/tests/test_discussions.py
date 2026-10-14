from fastapi.testclient import TestClient

from tests.test_auth import login, seed_user
from tests.test_media import add_user, jpeg_bytes, sign_in, sign_out
from sqlalchemy.orm import Session
from vita29.db.models import UserRole, Workspace, WorkspaceKind, WorkspaceMember
from vita29.db.session import create_database_engine


def test_discussion_messages_unread_replies_and_reactions(client: TestClient, tmp_path) -> None:
    maria = seed_user(tmp_path / "test.db", login="maria")
    kristina = seed_user(tmp_path / "test.db", login="kristina")
    csrf = login(client, "maria")

    discussions = client.get("/api/v1/discussions").json()
    assert len(discussions) == 1
    assert discussions[0]["kind"] == "general"

    created = client.post(
        "/api/v1/discussions",
        headers={"X-CSRF-Token": csrf},
        json={"title": "Контент на неделю", "member_ids": [kristina.id]},
    )
    assert created.status_code == 201
    discussion_id = created.json()["id"]
    message = client.post(
        f"/api/v1/discussions/{discussion_id}/messages",
        headers={"X-CSRF-Token": csrf},
        json={"body": "Посмотрите новую серию", "attachments": []},
    )
    assert message.status_code == 201
    message_id = message.json()["id"]

    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    csrf = login(client, "kristina")
    item = next(item for item in client.get("/api/v1/discussions").json() if item["id"] == discussion_id)
    assert item["unread_count"] == 1
    notifications = client.get("/api/v1/discussions/notifications/inbox").json()
    assert notifications["unread_count"] >= 2
    assert client.put(
        "/api/v1/discussions/notifications/read-all",
        headers={"X-CSRF-Token": csrf},
    ).status_code == 204
    assert client.get("/api/v1/discussions/notifications/inbox").json()["unread_count"] == 0

    reply = client.post(
        f"/api/v1/discussions/{discussion_id}/messages",
        headers={"X-CSRF-Token": csrf},
        json={"body": "Готово 👍", "reply_to_id": message_id, "attachments": []},
    )
    assert reply.status_code == 201
    assert reply.json()["reply_to"]["id"] == message_id
    reply_id = reply.json()["id"]

    liked = client.put(
        f"/api/v1/discussions/{discussion_id}/messages/{reply_id}/like",
        headers={"X-CSRF-Token": csrf},
    )
    assert liked.json()["liked_by_me"] is True
    reacted = client.put(
        f"/api/v1/discussions/{discussion_id}/messages/{reply_id}/reaction",
        headers={"X-CSRF-Token": csrf},
        json={"emoji": "👍"},
    )
    assert reacted.json()["reactions"] == {"👍": 1}

    assert client.put(
        f"/api/v1/discussions/{discussion_id}/read",
        headers={"X-CSRF-Token": csrf},
        json={"message_id": reply_id},
    ).status_code == 204
    item = next(item for item in client.get("/api/v1/discussions").json() if item["id"] == discussion_id)
    assert item["unread_count"] == 0
    assert maria.id in item["member_ids"]
    assert item["can_delete"] is False
    assert client.delete(
        f"/api/v1/discussions/{discussion_id}",
        headers={"X-CSRF-Token": csrf},
    ).status_code == 403

    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    csrf = login(client, "maria")
    item = next(item for item in client.get("/api/v1/discussions").json() if item["id"] == discussion_id)
    assert item["can_delete"] is True
    assert client.delete(
        f"/api/v1/discussions/{discussion_id}",
        headers={"X-CSRF-Token": csrf},
    ).status_code == 204
    assert discussion_id not in {item["id"] for item in client.get("/api/v1/discussions").json()}


def test_media_comment_creates_visible_topic_attachment_and_mention(
    client: TestClient, tmp_path
) -> None:
    database_path = tmp_path / "test.db"
    _, maria_workspace = add_user(database_path, "maria", UserRole.EMPLOYEE)
    add_user(database_path, "kristina", UserRole.EMPLOYEE)
    csrf = sign_in(client, "maria")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={maria_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("comment.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    updated = client.put(
        f"/api/v1/media/{file_id}/comment",
        headers={"X-CSRF-Token": csrf},
        json={"comment": "@Kristina посмотри этот результат"},
    )
    assert updated.status_code == 200
    sign_out(client, csrf)

    csrf = sign_in(client, "kristina")
    topic = next(item for item in client.get("/api/v1/discussions").json() if item["kind"] == "batch")
    assert topic["mentioned_me"] is True
    messages = client.get(f"/api/v1/discussions/{topic['id']}/messages").json()
    assert messages[-1]["body"].startswith("@Kristina")
    assert messages[-1]["attachments"][0]["media_id"] == file_id
    inbox = client.get("/api/v1/discussions/notifications/inbox").json()
    assert any(item["kind"] == "media.comment.mention" for item in inbox["notifications"])
    sign_out(client, csrf)


def test_private_media_comments_are_visible_only_to_uploader(client: TestClient, tmp_path) -> None:
    database_path = tmp_path / "test.db"
    uploader, _ = add_user(database_path, "private-owner", UserRole.EMPLOYEE)
    viewer, _ = add_user(database_path, "private-viewer", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine, expire_on_commit=False) as db:
        workspace = Workspace(
            display_name="Приватная",
            kind=WorkspaceKind.PRIVATE,
            owner_id=uploader.id,
        )
        db.add(workspace)
        db.flush()
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=viewer.id))
        db.commit()
        workspace_id = workspace.id

    csrf = sign_in(client, "private-owner")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={workspace_id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("private.jpg", jpeg_bytes(), "image/jpeg")},
    )
    file_id = uploaded.json()["id"]
    assert client.put(
        f"/api/v1/media/{file_id}/comment",
        headers={"X-CSRF-Token": csrf},
        json={"comment": "Личная заметка"},
    ).status_code == 200
    uploader_topics = client.get("/api/v1/discussions").json()
    assert any(item["kind"] == "batch" and item["is_private"] for item in uploader_topics)
    sign_out(client, csrf)

    csrf = sign_in(client, "private-viewer")
    assert client.get(f"/api/v1/media/{file_id}/preview").status_code == 200
    assert not any(item["kind"] == "batch" for item in client.get("/api/v1/discussions").json())
    assert client.put(
        f"/api/v1/media/{file_id}/comment",
        headers={"X-CSRF-Token": csrf},
        json={"comment": "Не должна сохраниться"},
    ).status_code == 403
    sign_out(client, csrf)
