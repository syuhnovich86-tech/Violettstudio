import json
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from tests.test_media import PASSWORD, add_user, jpeg_bytes
from vita29.db.models import User, UserRole, Workspace, WorkspaceKind
from vita29.db.session import create_database_engine


@pytest.fixture(params=["ios", "android"])
def transfer(client, tmp_path, request):
    platform = request.param
    owner, folder = add_user(tmp_path / "test.db", "recovery", UserRole.OWNER)
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        db.get(User, owner.id).can_import_ios_photo_library = True
        db.get(User, owner.id).can_import_android_photo_library = True
        db.get(Workspace, folder.id).kind = WorkspaceKind.PRIVATE
        db.commit()
    login = client.post("/api/v1/mobile/auth/login", json={"login": "recovery", "password": PASSWORD})
    headers = {
        "Authorization": "Bearer " + login.json()["access_token"],
        f"X-{platform}-Import-Key": "c" * 64,
        f"X-{platform}-Filename": "photo.jpg",
    }
    data = jpeg_bytes()
    base = f"/api/v1/media/{platform}-import"
    query = f"workspace_id={folder.id}&total={len(data)}"
    half = len(data) // 2
    response = client.put(f"{base}/chunk?{query}&offset=0", headers=headers, content=data[:half])
    assert response.status_code == 200, response.text
    root = tmp_path / "media" / f"{platform}-import-sessions"
    meta = next(root.glob("*.json"))
    return base, query, headers, data, meta


@pytest.mark.parametrize("damage", ["empty", "invalid-json", "invalid-schema", "orphan", "oversized"])
def test_broken_transfer_restarts_and_completes_without_duplicate(client, transfer, damage):
    base, query, headers, data, meta = transfer
    part = meta.with_suffix(".part")
    if damage == "empty":
        meta.write_bytes(b"")
    elif damage == "invalid-json":
        meta.write_bytes(b"\x00broken")
    elif damage == "invalid-schema":
        meta.write_text('[]', encoding="utf-8")
    elif damage == "orphan":
        meta.unlink()
    else:
        part.write_bytes(data + b"extra")
    unfinished = part.read_bytes()
    progress = client.get(f"{base}/progress?{query}", headers=headers)
    assert progress.status_code == 200, progress.text
    assert progress.json() == {"exists": False, "offset": 0}
    backups = list((meta.parent / "recovered").glob("*/*.part"))
    assert len(backups) == 1 and backups[0].read_bytes() == unfinished
    assert client.put(f"{base}/chunk?{query}&offset=0", headers=headers, content=data).status_code == 200
    done = client.post(f"{base}/complete?{query}", headers=headers)
    assert done.status_code == 200, done.text
    repeated = client.post(f"{base}/complete?{query}", headers=headers)
    assert repeated.json()["media_id"] == done.json()["media_id"]
    progress = client.get(f"{base}/progress?{query}", headers=headers)
    assert progress.json() == {"exists": True, "offset": len(data)}


def test_valid_partial_transfer_resumes_and_rejects_changed_source(client, transfer):
    base, query, headers, data, meta = transfer
    before = meta.read_bytes()
    changed = query.replace(f"total={len(data)}", f"total={len(data)+1}")
    assert client.get(f"{base}/progress?{changed}", headers=headers).status_code == 409
    assert meta.read_bytes() == before
    assert not (meta.parent / "recovered").exists()
    progress = client.get(f"{base}/progress?{query}", headers=headers)
    offset = progress.json()["offset"]
    assert offset == len(data) // 2
    assert client.put(f"{base}/chunk?{query}&offset={offset}", headers=headers, content=data[offset:]).status_code == 200
    done = client.post(f"{base}/complete?{query}", headers=headers)
    assert done.status_code == 200, done.text


def test_storage_io_errors_are_not_treated_as_corrupt_metadata(tmp_path, monkeypatch):
    from vita29.api.import_state import read_state
    meta = tmp_path / "test.json"
    meta.write_text(json.dumps({"total": 5, "filename": "photo.jpg"}))
    def fail(*args, **kwargs):
        raise OSError("disk unavailable")
    monkeypatch.setattr(Path, "read_text", fail)
    with pytest.raises(OSError, match="disk unavailable"):
        read_state(tmp_path / "test.part", meta, 5)
    assert meta.exists() and not (tmp_path / "recovered").exists()
