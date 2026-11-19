import pytest

from tests.test_auth import login, seed_user
from tests.test_media import PASSWORD, add_user
from vita29.db.models import UserRole


def test_phone_sync_defaults_and_editor_permissions(client, tmp_path):
    path = tmp_path / "test.db"
    seed_user(path, role=UserRole.OWNER, login="creator")
    seed_user(path, role=UserRole.ADMIN, login="administrator")
    employee = seed_user(path, role=UserRole.EMPLOYEE, login="technician")
    csrf = login(client, "administrator")
    headers = {"X-CSRF-Token": csrf}
    people = client.get("/api/v1/users").json()
    for user in people:
        for platform in ("ios", "android"):
            assert user[f"can_import_{platform}_photo_library"] == (user["role"] in ("admin", "owner"))
    payload = next(user for user in people if user["id"] == employee.id)
    endpoint = f"/api/v1/users/{employee.id}/permissions"
    payload["can_import_ios_photo_library"] = True
    assert client.put(endpoint, json=payload, headers=headers).status_code == 200
    del payload["can_import_ios_photo_library"]
    del payload["can_import_android_photo_library"]
    updated = client.put(endpoint, json=payload, headers=headers)
    assert updated.json()["can_import_ios_photo_library"] is True
    assert updated.json()["can_import_android_photo_library"] is False
    flags = {"can_import_ios_photo_library": False, "can_import_android_photo_library": False}
    assert client.put("/api/v1/users/me/phone-sync", json=flags, headers=headers).status_code == 403
    owner_headers = {"X-CSRF-Token": login(client, "creator")}
    assert client.put("/api/v1/users/me/phone-sync", json=flags, headers=owner_headers).status_code == 200
    assert client.get("/api/v1/auth/me").json()["user"]["can_import_ios_photo_library"] is False


@pytest.mark.parametrize("platform", ["android", "ios"])
def test_employee_phone_transfer_stops_after_revocation(client, tmp_path, platform):
    from sqlalchemy.orm import Session
    from vita29.db.models import Workspace, WorkspaceKind
    from vita29.db.session import create_database_engine

    path = tmp_path / "test.db"
    seed_user(path, role=UserRole.ADMIN, login="supervisor")
    employee, folder = add_user(path, "staffphoto", UserRole.EMPLOYEE)
    with Session(create_database_engine(f"sqlite:///{path}")) as db:
        db.get(Workspace, folder.id).kind = WorkspaceKind.PRIVATE
        db.commit()
    mobile = client.post("/api/v1/mobile/auth/login", json={"login": employee.login, "password": PASSWORD}).json()
    device = {"Authorization": "Bearer " + mobile["access_token"], f"X-{platform}-Import-Key": "a" * 64,
              f"X-{platform}-Filename": "test.jpg"}
    url = f"/api/v1/media/{platform}-import/chunk?workspace_id={folder.id}&total=4"
    admin_headers = {"X-CSRF-Token": login(client, "supervisor")}
    staff = next(u for u in client.get("/api/v1/users").json() if u["id"] == employee.id)
    assert client.put(url + "&offset=0", headers=device, content=b"ab").status_code == 403
    for enabled, offset, expected in [(True, 0, 200), (False, 2, 403)]:
        staff[f"can_import_{platform}_photo_library"] = enabled
        assert client.put(f"/api/v1/users/{employee.id}/permissions", json=staff, headers=admin_headers).status_code == 200
        assert client.put(url + f"&offset={offset}", headers=device, content=b"ab").status_code == expected
