from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.test_media import add_user, jpeg_bytes, sign_in
from vita29.db.models import User, UserRole, Workspace, WorkspaceKind
from vita29.db.session import create_database_engine


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
