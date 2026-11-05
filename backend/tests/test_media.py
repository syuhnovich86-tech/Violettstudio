from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from vita29.auth.security import hash_password
from vita29.db.models import (
    AuditLog,
    MediaFile,
    User,
    UserRole,
    Workspace,
    WorkspaceKind,
    WorkspaceMember,
    YclientsVisit,
)
from vita29.db.session import create_database_engine

PASSWORD = "employee-pass-123"


def add_user(
    database_path: Path,
    login: str,
    role: UserRole,
    *,
    can_create_private_workspaces: bool = False,
    can_upload_media: bool = True,
    can_add_comments: bool = True,
) -> tuple[User, Workspace]:
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine, expire_on_commit=False) as db:
        user = User(
            display_name=login.title(),
            login=login,
            password_hash=hash_password(PASSWORD),
            role=role,
            can_create_private_workspaces=can_create_private_workspaces,
            can_upload_media=can_upload_media,
            can_add_comments=can_add_comments,
        )
        db.add(user)
        db.flush()
        workspace = Workspace(
            display_name=user.display_name,
            kind=WorkspaceKind.STUDIO,
            owner_id=user.id,
        )
        db.add(workspace)
        db.commit()
        return user, workspace


def sign_in(client: TestClient, login: str) -> str:
    response = client.post("/api/v1/auth/login", json={"login": login, "password": PASSWORD})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def sign_out(client: TestClient, csrf: str) -> None:
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204


def jpeg_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (40, 24), color=(195, 115, 47)).save(output, format="JPEG")
    return output.getvalue()


def test_upload_and_comment_permissions_are_enforced(client: TestClient, tmp_path: Path) -> None:
    database_path = tmp_path / "test.db"
    _, uploader_workspace = add_user(database_path, "uploader", UserRole.EMPLOYEE)
    add_user(
        database_path,
        "restricted",
        UserRole.EMPLOYEE,
        can_upload_media=False,
        can_add_comments=False,
    )

    csrf = sign_in(client, "uploader")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={uploader_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("result.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    sign_out(client, csrf)

    csrf = sign_in(client, "restricted")
    assert client.post(
        f"/api/v1/media?workspace_id={uploader_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("blocked.jpg", jpeg_bytes(), "image/jpeg")},
    ).status_code == 403
    assert client.put(
        f"/api/v1/media/{file_id}/comment",
        headers={"X-CSRF-Token": csrf},
        json={"comment": "Не должно сохраниться"},
    ).status_code == 403


def test_studio_workspaces_are_shared_and_delete_permissions_are_safe(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    owner, owner_workspace = add_user(database_path, "owner", UserRole.EMPLOYEE)
    _, other_workspace = add_user(database_path, "other", UserRole.EMPLOYEE)
    _, admin_workspace = add_user(database_path, "admin", UserRole.ADMIN)

    csrf = sign_in(client, "owner")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={owner_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("result.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    assert uploaded.json()["owner_id"] == owner.id
    assert uploaded.json()["workspace_id"] == owner_workspace.id
    assert uploaded.json()["can_delete"] is True
    assert (
        client.get(f"/api/v1/media?workspace_id={owner_workspace.id}").json()[0]["original_name"]
        == "result.jpg"
    )
    assert client.get(f"/api/v1/media/{file_id}/download").content.startswith(b"\xff\xd8\xff")
    thumbnail = client.get(f"/api/v1/media/{file_id}/thumbnail")
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"].startswith("image/jpeg")
    assert client.get(f"/api/v1/media/{file_id}/preview").status_code == 200
    sign_out(client, csrf)

    csrf = sign_in(client, "other")
    workspaces = client.get("/api/v1/workspaces").json()
    assert {workspace["id"] for workspace in workspaces} == {
        owner_workspace.id,
        other_workspace.id,
        admin_workspace.id,
    }
    shared_files = client.get(f"/api/v1/media?workspace_id={owner_workspace.id}").json()
    assert len(shared_files) == 1
    assert shared_files[0]["can_delete"] is False
    assert client.get(f"/api/v1/media?workspace_id={other_workspace.id}").json() == []
    assert client.get(f"/api/v1/media/{file_id}/download").status_code == 200
    assert (
        client.delete(f"/api/v1/media/{file_id}", headers={"X-CSRF-Token": csrf}).status_code == 403
    )

    uploaded_to_owner = client.post(
        f"/api/v1/media?workspace_id={owner_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("shared.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded_to_owner.status_code == 201
    assert uploaded_to_owner.json()["owner_id"] == owner.id
    assert uploaded_to_owner.json()["can_delete"] is True
    shared_file_id = uploaded_to_owner.json()["id"]
    assert (
        client.delete(f"/api/v1/media/{shared_file_id}", headers={"X-CSRF-Token": csrf}).status_code
        == 204
    )
    sign_out(client, csrf)

    csrf = sign_in(client, "admin")
    assert len(client.get(f"/api/v1/media?workspace_id={owner_workspace.id}").json()) == 1
    assert (
        client.delete(f"/api/v1/media/{file_id}", headers={"X-CSRF-Token": csrf}).status_code == 204
    )
    assert client.get(f"/api/v1/media?workspace_id={owner_workspace.id}").json() == []
    assert (tmp_path / "media" / ".trash" / file_id).is_file()

    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        media = db.scalar(select(MediaFile).where(MediaFile.id == file_id))
        assert media is not None and media.deleted_at is not None
        assert (
            db.scalar(
                select(func.count()).select_from(AuditLog).where(AuditLog.action.like("media.%"))
            )
            == 6
        )


def test_private_workspace_is_hidden_and_direct_links_are_blocked(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    wife, _ = add_user(database_path, "violet29", UserRole.EMPLOYEE)
    stepan, _ = add_user(database_path, "stepan", UserRole.OWNER)
    _, _ = add_user(database_path, "maria", UserRole.ADMIN)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine, expire_on_commit=False) as db:
        private_workspace = Workspace(
            display_name="Блог",
            kind=WorkspaceKind.PRIVATE,
            owner_id=wife.id,
        )
        db.add(private_workspace)
        db.flush()
        db.add_all(
            [
                WorkspaceMember(workspace_id=private_workspace.id, user_id=wife.id),
                WorkspaceMember(workspace_id=private_workspace.id, user_id=stepan.id),
            ]
        )
        db.commit()

    csrf = sign_in(client, "violet29")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={private_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("blog.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    assert uploaded.json()["workspace_kind"] == "private"
    sign_out(client, csrf)

    csrf = sign_in(client, "stepan")
    assert private_workspace.id in {
        workspace["id"] for workspace in client.get("/api/v1/workspaces").json()
    }
    assert len(client.get(f"/api/v1/media?workspace_id={private_workspace.id}").json()) == 1
    assert client.get(f"/api/v1/media/{file_id}/download").status_code == 200
    sign_out(client, csrf)

    sign_in(client, "maria")
    assert private_workspace.id not in {
        workspace["id"] for workspace in client.get("/api/v1/workspaces").json()
    }
    assert client.get(f"/api/v1/media?workspace_id={private_workspace.id}").status_code == 404
    assert client.get(f"/api/v1/media/{file_id}/preview").status_code == 404
    assert client.get(f"/api/v1/media/{file_id}/thumbnail").status_code == 404
    assert client.get(f"/api/v1/media/{file_id}/download").status_code == 404
    assert file_id not in {item["id"] for item in client.get("/api/v1/media").json()}


def test_users_create_shared_folders_and_only_permitted_users_create_private_folders(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    creator, _ = add_user(
        database_path,
        "creator",
        UserRole.EMPLOYEE,
        can_create_private_workspaces=True,
    )
    add_user(database_path, "shared-only", UserRole.EMPLOYEE)

    csrf = sign_in(client, "creator")
    shared = client.post(
        "/api/v1/workspaces",
        headers={"X-CSRF-Token": csrf},
        json={"display_name": "РФ лифтинг", "kind": "studio"},
    )
    assert shared.status_code == 201
    assert shared.json()["owner_id"] == creator.id
    assert shared.json()["kind"] == "studio"
    private = client.post(
        "/api/v1/workspaces",
        headers={"X-CSRF-Token": csrf},
        json={"display_name": "Личное", "kind": "private"},
    )
    assert private.status_code == 201
    private_id = private.json()["id"]
    sign_out(client, csrf)

    csrf = sign_in(client, "shared-only")
    visible_ids = {workspace["id"] for workspace in client.get("/api/v1/workspaces").json()}
    assert shared.json()["id"] in visible_ids
    assert private_id not in visible_ids
    forbidden = client.post(
        "/api/v1/workspaces",
        headers={"X-CSRF-Token": csrf},
        json={"display_name": "Нельзя", "kind": "private"},
    )
    assert forbidden.status_code == 403


def test_accessible_media_can_be_moved_between_accessible_workspaces(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    _, source_workspace = add_user(database_path, "mover", UserRole.EMPLOYEE)
    destination_owner, destination_workspace = add_user(
        database_path, "destination", UserRole.EMPLOYEE
    )
    private_owner, _ = add_user(database_path, "private-owner", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine, expire_on_commit=False) as db:
        private_workspace = Workspace(
            display_name="Private",
            kind=WorkspaceKind.PRIVATE,
            owner_id=private_owner.id,
        )
        db.add(private_workspace)
        db.flush()
        db.add(WorkspaceMember(workspace_id=private_workspace.id, user_id=private_owner.id))
        db.commit()

    csrf = sign_in(client, "mover")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={source_workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("move-me.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    with Session(engine) as db:
        previous_key = db.get(MediaFile, file_id).storage_key

    moved = client.put(
        f"/api/v1/media/{file_id}/workspace",
        headers={"X-CSRF-Token": csrf},
        json={"workspace_id": destination_workspace.id},
    )
    assert moved.status_code == 200
    assert moved.json()["workspace_id"] == destination_workspace.id
    assert moved.json()["owner_id"] == destination_owner.id
    assert client.get(f"/api/v1/media?workspace_id={source_workspace.id}").json() == []
    assert len(client.get(f"/api/v1/media?workspace_id={destination_workspace.id}").json()) == 1
    assert not (tmp_path / "media" / "originals" / previous_key).exists()
    with Session(engine) as db:
        new_key = db.get(MediaFile, file_id).storage_key
    assert new_key.startswith(f"{destination_workspace.id}/")
    assert (tmp_path / "media" / "originals" / new_key).is_file()

    forbidden = client.put(
        f"/api/v1/media/{file_id}/workspace",
        headers={"X-CSRF-Token": csrf},
        json={"workspace_id": private_workspace.id},
    )
    assert forbidden.status_code == 404
    assert len(client.get(f"/api/v1/media?workspace_id={destination_workspace.id}").json()) == 1


def test_invalid_file_is_rejected_without_leaving_data(client: TestClient, tmp_path: Path) -> None:
    _, workspace = add_user(tmp_path / "test.db", "owner2", UserRole.EMPLOYEE)
    csrf = sign_in(client, "owner2")
    response = client.post(
        f"/api/v1/media?workspace_id={workspace.id}",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("notes.txt", b"not a photo", "text/plain")},
    )
    assert response.status_code == 400
    assert list((tmp_path / "media" / "originals").rglob("*.upload")) == []


def test_media_links_only_to_own_visit_and_stores_publication_choice(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    employee, workspace = add_user(database_path, "calendar-owner", UserRole.EMPLOYEE)
    other, _ = add_user(database_path, "calendar-other", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        db.add_all(
            [
                YclientsVisit(
                    record_id=101,
                    salon_id=956792,
                    staff_id=1,
                    user_id=employee.id,
                    starts_at=datetime(2026, 8, 20, 12, tzinfo=UTC),
                ),
                YclientsVisit(
                    record_id=102,
                    salon_id=956792,
                    staff_id=2,
                    user_id=other.id,
                    starts_at=datetime(2026, 8, 20, 13, tzinfo=UTC),
                ),
            ]
        )
        db.commit()

    csrf = sign_in(client, "calendar-owner")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={workspace.id}&yclients_record_id=101&publication_allowed=true",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("linked.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    assert uploaded.json()["publication_allowed"] is True
    with Session(engine) as db:
        media = db.get(MediaFile, uploaded.json()["id"])
        assert media.yclients_record_id == 101
        assert media.publication_allowed is True

    forbidden = client.post(
        f"/api/v1/media?workspace_id={workspace.id}&yclients_record_id=102&publication_allowed=false",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("forbidden.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert forbidden.status_code == 403

    calendar = client.get(
        f"/api/v1/yclients/visits?start_date=2026-08-01&end_date=2026-08-31&user_id={other.id}"
    )
    assert calendar.status_code == 200
    assert [visit["record_id"] for visit in calendar.json()] == [101]


def test_media_can_be_filtered_by_inclusive_date_range(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    _, workspace = add_user(database_path, "filter-owner", UserRole.EMPLOYEE)
    csrf = sign_in(client, "filter-owner")
    uploaded_ids = []
    for name in ("old.jpg", "new.jpg"):
        response = client.post(
            f"/api/v1/media?workspace_id={workspace.id}",
            headers={"X-CSRF-Token": csrf},
            files={"upload": (name, jpeg_bytes(), "image/jpeg")},
        )
        assert response.status_code == 201
        uploaded_ids.append(response.json()["id"])

    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        db.get(MediaFile, uploaded_ids[0]).created_at = datetime(2026, 8, 2, 9, tzinfo=UTC)
        db.get(MediaFile, uploaded_ids[1]).created_at = datetime(2026, 8, 20, 18, tzinfo=UTC)
        db.commit()

    base = f"/api/v1/media?workspace_id={workspace.id}"
    assert [item["original_name"] for item in client.get(f"{base}&date_from=2026-08-10").json()] == [
        "new.jpg"
    ]
    assert [item["original_name"] for item in client.get(f"{base}&date_to=2026-08-10").json()] == [
        "old.jpg"
    ]
    assert len(client.get(f"{base}&date_from=2026-08-01&date_to=2026-08-31").json()) == 2
    assert client.get(f"{base}&date_from=2026-08-20&date_to=2026-08-10").status_code == 400


def test_calendar_day_includes_media_linked_to_visits_on_that_day(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    employee, workspace = add_user(database_path, "calendar-day", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        db.add(
            YclientsVisit(
                record_id=301,
                salon_id=956792,
                staff_id=1,
                user_id=employee.id,
                starts_at=datetime(2026, 8, 25, 12, tzinfo=UTC),
            )
        )
        db.commit()

    csrf = sign_in(client, "calendar-day")
    uploaded = client.post(
        f"/api/v1/media?workspace_id={workspace.id}&yclients_record_id=301",
        headers={"X-CSRF-Token": csrf},
        files={"upload": ("visit.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 201
    with Session(engine) as db:
        media = db.get(MediaFile, uploaded.json()["id"])
        media.created_at = datetime(2026, 8, 27, 9, tzinfo=UTC)
        db.commit()

    response = client.get("/api/v1/media?calendar_date=2026-08-25")
    assert response.status_code == 200
    assert [item["original_name"] for item in response.json()] == ["visit.jpg"]


def test_private_archive_can_be_filtered_by_capture_year_and_existing_place(
    client: TestClient, tmp_path: Path
) -> None:
    database_path = tmp_path / "test.db"
    user, _ = add_user(database_path, "iphone-owner", UserRole.EMPLOYEE)
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine, expire_on_commit=False) as db:
        workspace = Workspace(
            display_name="Фото с iPhone",
            kind=WorkspaceKind.PRIVATE,
            owner_id=user.id,
        )
        db.add(workspace)
        db.flush()
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id))
        db.commit()

    csrf = sign_in(client, "iphone-owner")
    ids = []
    for name in ("moscow.jpg", "without-location.jpg"):
        response = client.post(
            f"/api/v1/media?workspace_id={workspace.id}",
            headers={"X-CSRF-Token": csrf},
            files={"upload": (name, jpeg_bytes(), "image/jpeg")},
        )
        assert response.status_code == 201
        ids.append(response.json()["id"])
    with Session(engine) as db:
        moscow = db.get(MediaFile, ids[0])
        moscow.captured_at = datetime(2020, 6, 10, 10, tzinfo=UTC)
        moscow.location_country = "RU"
        moscow.location_city = "Moscow"
        moscow.location_key = "RU · Moscow"
        other = db.get(MediaFile, ids[1])
        other.captured_at = datetime(2021, 7, 11, 10, tzinfo=UTC)
        db.commit()

    options = client.get(
        f"/api/v1/media/filter-options?workspace_id={workspace.id}"
    )
    assert options.status_code == 200
    assert options.json() == {
        "years": [2021, 2020],
        "months": [
            {"year": 2021, "month": 7, "count": 1},
            {"year": 2020, "month": 6, "count": 1},
        ],
        "places": [
            {
                "key": "RU · Moscow",
                "country": "RU",
                "city": "Moscow",
                "label": "RU · Moscow",
            }
        ],
        "without_location_count": 1,
    }
    by_year = client.get(
        f"/api/v1/media?workspace_id={workspace.id}&capture_year=2020"
    )
    assert [item["original_name"] for item in by_year.json()] == ["moscow.jpg"]
    by_month = client.get(
        f"/api/v1/media?workspace_id={workspace.id}&capture_year=2021&capture_month=7"
    )
    assert [item["original_name"] for item in by_month.json()] == [
        "without-location.jpg"
    ]
    filtered_options = client.get(
        f"/api/v1/media/filter-options?workspace_id={workspace.id}&capture_year=2020"
    )
    assert filtered_options.status_code == 200
    assert filtered_options.json()["places"] == [
        {
            "key": "RU · Moscow",
            "country": "RU",
            "city": "Moscow",
            "label": "RU · Moscow",
        }
    ]
    assert filtered_options.json()["without_location_count"] == 0
    by_place = client.get(
        f"/api/v1/media?workspace_id={workspace.id}&location_key=RU%20%C2%B7%20Moscow"
    )
    assert [item["original_name"] for item in by_place.json()] == ["moscow.jpg"]
    without_location = client.get(
        f"/api/v1/media?workspace_id={workspace.id}&location_key=__none__"
    )
    assert [item["original_name"] for item in without_location.json()] == [
        "without-location.jpg"
    ]
