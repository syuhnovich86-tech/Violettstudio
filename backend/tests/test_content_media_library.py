from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
import json

import pytest

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.test_media import add_user, jpeg_bytes, sign_in, sign_out
from vita29.content.scheduled_delivery import validate_media
from vita29.db.models import ContentItem, ContentPublication, ContentStatus, MediaFile, PublicationPlatform, User, UserRole, Workspace, WorkspaceKind, WorkspaceMember
from vita29.db.session import create_database_engine


@pytest.mark.parametrize('collage_requested', [True, False])
def test_story_collage_request_uses_both_selected_images(client, tmp_path, monkeypatch, collage_requested):
    owner, _ = add_user(tmp_path / 'test.db', 'story-editor', UserRole.OWNER)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        folder = Workspace(display_name='Фото', kind=WorkspaceKind.STUDIO, owner_id=owner.id)
        db.add(folder)
        db.commit()
        folder_id = folder.id
    csrf = sign_in(client, 'story-editor')
    ids = []
    for name in ('before.jpg', 'after.jpg'):
        uploaded = client.post(f'/api/v1/media?workspace_id={folder_id}', headers={'X-CSRF-Token': csrf}, files={'upload': (name, jpeg_bytes(), 'image/jpeg')})
        assert uploaded.status_code == 201
        ids.append(uploaded.json()['id'])
    payload = {'title': 'Перманент', 'editor_instruction': 'Сделай коллаж до и после на белом фоне' if collage_requested else 'Подготовь серию сторис', 'scheduled_at': (datetime.now(UTC) + timedelta(days=1)).isoformat(), 'platforms': ['telegram', 'instagram'], 'platform_formats': {'telegram': 'story', 'instagram': 'story'}, 'media_ids': ids, 'media_limit': 2}
    created = client.post('/api/v1/content/items', headers={'X-CSRF-Token': csrf}, json=payload)
    assert created.status_code == 201, created.text
    calls = []
    monkeypatch.setattr('vita29.api.content.prepare_telegram_draft', lambda *args: SimpleNamespace(caption='Текст', media_ids=ids))
    def generate(db, settings, item, actor_id, instruction, source_media, **kwargs):
        calls.append([media.id for media in source_media])
        return SimpleNamespace(id='generated-collage')
    monkeypatch.setattr('vita29.api.content.generate_branded_visual', generate)
    result = client.post(f"/api/v1/content/items/{created.json()['id']}/prepare", headers={'X-CSRF-Token': csrf})
    assert result.status_code == 200, result.text
    assert calls == ([ids] if collage_requested else [])
    for publication in result.json()['publications']:
        assert publication['media_ids'] == (['generated-collage'] if collage_requested else ids)


def test_marked_private_media_is_available_to_its_content_editor(
    client: TestClient, tmp_path: Path
) -> None:
    """The content library exposes only the caller's permitted private media."""
    database_path = tmp_path / "test.db"
    user, _ = add_user(database_path, "editor", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        editor = db.get(User, user.id)
        assert editor is not None
        editor.can_access_content = True
        private = Workspace(
            display_name="Личный архив",
            kind=WorkspaceKind.PRIVATE,
            owner_id=editor.id,
        )
        db.add(private)
        db.commit()
        db.refresh(private)
        private_id = private.id

    csrf = sign_in(client, "editor")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={private_id}&publication_allowed=true",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("video-source.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]

    marked = client.put(
        f"/api/v1/media/{file_id}/content-mark",
        headers={"X-CSRF-Token": csrf},
        json={"content_marked": True},
    )
    assert marked.status_code == 200
    assert marked.json()["content_marked"] is True

    library = client.get("/api/v1/content/media-library")
    assert library.status_code == 200
    body = library.json()
    assert body["items"][0]["id"] == file_id
    assert body["items"][0]["content_marked"] is True
    assert body["items"][0]["workspace_name"] == "Личный архив"

    revoked = client.put(
        f"/api/v1/media/{file_id}/publication",
        headers={"X-CSRF-Token": csrf},
        json={"publication_allowed": False},
    )
    assert revoked.status_code == 200
    assert revoked.json()["content_marked"] is False
    assert client.get("/api/v1/content/media-library").json()["items"] == []
    visible = client.get(f"/api/v1/content/media-library?workspace_id={private_id}&sort=archive&include_forbidden=true")
    assert visible.status_code == 200
    assert [(item["id"], item["publication_allowed"]) for item in visible.json()["items"]] == [(file_id, False)]
    rejected = client.post(
        "/api/v1/content/items",
        headers={"X-CSRF-Token": csrf},
        json={"title": "Проверка", "scheduled_at": datetime.now(UTC).isoformat(), "platforms": ["telegram"], "media_ids": [file_id]},
    )
    assert rejected.status_code == 422


def test_private_content_requires_both_content_and_workspace_access(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "test.db"
    owner, _ = add_user(path, "private-owner", UserRole.EMPLOYEE)
    member, _ = add_user(path, "private-member", UserRole.EMPLOYEE)
    outsider, _ = add_user(path, "private-outsider", UserRole.EMPLOYEE)
    no_content, _ = add_user(path, "private-no-content", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{path}")
    with Session(engine) as db:
        for actor in (owner, member, outsider):
            db.get(User, actor.id).can_access_content = True
        folder = Workspace(display_name="Private", kind=WorkspaceKind.PRIVATE, owner_id=owner.id)
        db.add(folder)
        db.flush()
        folder_id = folder.id
        db.add_all([WorkspaceMember(workspace_id=folder_id, user_id=member.id), WorkspaceMember(workspace_id=folder_id, user_id=no_content.id)])
        db.commit()
    csrf = sign_in(client, "private-owner")
    upload = client.post(f"/api/v1/media?workspace_id={folder_id}", headers={"X-CSRF-Token": csrf}, files={"upload": ("private.jpg", jpeg_bytes(), "image/jpeg")})
    assert upload.status_code == 201 and upload.json()["publication_allowed"] is True
    media_id = upload.json()["id"]
    sign_out(client, csrf)
    csrf = sign_in(client, "private-member")
    payload = {"title": "Private", "scheduled_at": datetime.now(UTC).isoformat(), "platforms": ["telegram"], "media_ids": [media_id]}
    created = client.post("/api/v1/content/items", headers={"X-CSRF-Token": csrf}, json=payload)
    assert created.status_code == 201
    item_id = created.json()["id"]
    with Session(engine) as db:
        item = db.get(ContentItem, item_id)
        item.status = ContentStatus.READY
        publication = db.query(ContentPublication).filter_by(content_item_id=item_id).one()
        publication.caption = "Текст"
        publication.media_ids_json = json.dumps([media_id])
        db.commit()
    monkeypatch.setattr("vita29.api.content.publish_to_channel", lambda *args: "fake-message")
    with Session(engine) as db:
        actor = db.get(User, member.id)
        for platform in (PublicationPlatform.TELEGRAM, PublicationPlatform.INSTAGRAM, PublicationPlatform.THREADS):
            publication = SimpleNamespace(media_ids_json=json.dumps([media_id]), platform=platform, publication_format="post", caption="Текст")
            assert [file.id for file in validate_media(db, None, publication, actor)] == [media_id]
        db.delete(db.get(WorkspaceMember, (folder_id, member.id)))
        db.commit()
        with pytest.raises(ValueError, match="недоступен"):
            validate_media(db, None, publication, actor)
    assert client.post(f"/api/v1/content/items/{item_id}/publications/telegram", headers={"X-CSRF-Token": csrf}).status_code == 409
    with Session(engine) as db:
        db.add(WorkspaceMember(workspace_id=folder_id, user_id=member.id))
        db.commit()
    assert client.post(f"/api/v1/content/items/{item_id}/publications/telegram", headers={"X-CSRF-Token": csrf}).status_code == 200
    sign_out(client, csrf)
    csrf = sign_in(client, "private-outsider")
    assert client.get(f"/api/v1/content/media-library?workspace_id={folder_id}&include_forbidden=true").status_code == 404
    assert client.post("/api/v1/content/items", headers={"X-CSRF-Token": csrf}, json=payload).status_code == 422
    sign_out(client, csrf)
    csrf = sign_in(client, "private-no-content")
    assert client.post("/api/v1/content/items", headers={"X-CSRF-Token": csrf}, json=payload).status_code == 403


def test_content_library_is_sorted_by_upload_date_newest_first(
    client: TestClient, tmp_path: Path
) -> None:
    """A fresh upload stays first even when its capture date is much older."""
    database_path = tmp_path / "test.db"
    user, workspace = add_user(database_path, "upload-order-editor", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        editor = db.get(User, user.id)
        assert editor is not None
        editor.can_access_content = True
        db.commit()

    csrf = sign_in(client, "upload-order-editor")
    older_upload = client.post(
        f"/api/v1/media?workspace_id={workspace.id}&publication_allowed=true",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("older-upload.jpg", jpeg_bytes(), "image/jpeg")},
    )
    newer_upload = client.post(
        f"/api/v1/media?workspace_id={workspace.id}&publication_allowed=true",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("newer-upload.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert older_upload.status_code == 201
    assert newer_upload.status_code == 201

    older_id = older_upload.json()["id"]
    newer_id = newer_upload.json()["id"]
    now = datetime.now(UTC)
    with Session(engine) as db:
        older = db.get(MediaFile, older_id)
        newer = db.get(MediaFile, newer_id)
        assert older is not None and newer is not None
        older.created_at = now - timedelta(days=1)
        older.captured_at = now
        older.content_marked = True
        newer.created_at = now
        newer.captured_at = now - timedelta(days=365)
        db.commit()

    default_library = client.get("/api/v1/content/media-library")
    uploaded_library = client.get("/api/v1/content/media-library?sort=uploaded")
    legacy_recent_library = client.get("/api/v1/content/media-library?sort=recent")
    archive_library = client.get(f"/api/v1/content/media-library?workspace_id={workspace.id}&sort=archive&include_forbidden=true&limit=1")
    archive_files = client.get(f"/api/v1/media?workspace_id={workspace.id}&limit=100").json()
    assert default_library.status_code == 200
    assert uploaded_library.status_code == 200
    assert legacy_recent_library.status_code == 200
    assert [item["id"] for item in default_library.json()["items"][:2]] == [older_id, newer_id]
    assert [item["id"] for item in uploaded_library.json()["items"][:2]] == [newer_id, older_id]
    assert [item["id"] for item in legacy_recent_library.json()["items"][:2]] == [newer_id, older_id]
    assert archive_library.status_code == 200
    first = archive_library.json()
    second = client.get(f"/api/v1/content/media-library?workspace_id={workspace.id}&sort=archive&include_forbidden=true&limit=1&offset={first['next_offset']}").json()
    assert [first["items"][0]["id"], second["items"][0]["id"]] == [item["id"] for item in archive_files[:2]]
