from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.auth.security import hash_password
from vita29.db.models import User, UserRole, Workspace, WorkspaceKind
from vita29.db.session import create_database_engine


def seed_user(database_path, *, role=UserRole.ADMIN, login="maria") -> User:
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        user = User(
            display_name="Мария",
            login=login,
            password_hash=hash_password("strong-pass-123"),
            role=role,
            can_access_admin=role in {UserRole.OWNER, UserRole.ADMIN},
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user


def login(client: TestClient, login_name: str = "maria") -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"login": login_name.upper(), "password": "strong-pass-123"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["login"] == login_name
    assert "HttpOnly" in response.headers["set-cookie"]
    return response.json()["csrf_token"]


def test_login_me_and_logout(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db")
    csrf = login(client)

    assert client.get("/api/v1/auth/me").json()["user"]["display_name"] == "Мария"
    assert client.post("/api/v1/auth/logout").status_code == 403
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_user_changes_own_password_and_keeps_current_session(
    client: TestClient, tmp_path
) -> None:
    seed_user(tmp_path / "test.db")
    csrf = login(client)

    wrong_password = client.put(
        "/api/v1/auth/password",
        headers={"X-CSRF-Token": csrf},
        json={"current_password": "wrong-password", "new_password": "changed-pass-456"},
    )
    assert wrong_password.status_code == 400

    changed = client.put(
        "/api/v1/auth/password",
        headers={"X-CSRF-Token": csrf},
        json={
            "current_password": "strong-pass-123",
            "new_password": "changed-pass-456",
        },
    )
    assert changed.status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 200
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"login": "maria", "password": "strong-pass-123"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"login": "maria", "password": "changed-pass-456"},
        ).status_code
        == 200
    )


def test_admin_creates_employee_and_employee_cannot_list_users(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db")
    csrf = login(client)
    response = client.post(
        "/api/v1/users",
        headers={"X-CSRF-Token": csrf},
        json={
            "display_name": "Кристина",
            "login": "kristina",
            "password": "employee-pass-123",
            "role": "employee",
        },
    )
    assert response.status_code == 201
    assert len(client.get("/api/v1/users").json()) == 2

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    employee_login = client.post(
        "/api/v1/auth/login",
        json={"login": "kristina", "password": "employee-pass-123"},
    )
    assert employee_login.status_code == 200
    assert client.get("/api/v1/users").status_code == 403


def test_deactivation_revokes_sessions(client: TestClient, tmp_path) -> None:
    admin = seed_user(tmp_path / "test.db")
    seed_user(tmp_path / "test.db", role=UserRole.EMPLOYEE, login="employee")
    csrf = login(client)

    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        employee = db.scalar(select(User).where(User.login == "employee"))
        assert employee is not None
        employee_id = employee.id

    response = client.put(
        f"/api/v1/users/{employee_id}/active",
        headers={"X-CSRF-Token": csrf},
        json={"is_active": False},
    )
    assert response.status_code == 200
    assert response.json()["is_active"] is False

    response = client.put(
        f"/api/v1/users/{admin.id}/active",
        headers={"X-CSRF-Token": csrf},
        json={"is_active": False},
    )
    assert response.status_code == 400


def test_repeated_bad_logins_are_throttled(client: TestClient) -> None:
    for _ in range(5):
        response = client.post(
            "/api/v1/auth/login", json={"login": "unknown", "password": "wrong"}
        )
        assert response.status_code == 401

    response = client.post(
        "/api/v1/auth/login", json={"login": "unknown", "password": "wrong"}
    )
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "300"


def test_owner_controls_studio_admins_and_owner_is_protected(client: TestClient, tmp_path) -> None:
    studio_admin = seed_user(tmp_path / "test.db")
    owner = seed_user(tmp_path / "test.db", role=UserRole.OWNER, login="owner")

    csrf = login(client)
    response = client.post(
        "/api/v1/users",
        headers={"X-CSRF-Token": csrf},
        json={
            "display_name": "Виолетта",
            "login": "violetta-admin",
            "password": "another-pass-123",
            "role": "admin",
        },
    )
    assert response.status_code == 403
    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})

    csrf = login(client, "owner")
    response = client.put(
        f"/api/v1/users/{studio_admin.id}/active",
        headers={"X-CSRF-Token": csrf},
        json={"is_active": False},
    )
    assert response.status_code == 200
    response = client.put(
        f"/api/v1/users/{owner.id}/active",
        headers={"X-CSRF-Token": csrf},
        json={"is_active": False},
    )
    assert response.status_code == 400


def test_owner_can_change_user_name_and_login_and_workspace_follows(
    client: TestClient, tmp_path
) -> None:
    owner = seed_user(tmp_path / "test.db", role=UserRole.OWNER, login="owner-edit")
    employee = seed_user(tmp_path / "test.db", role=UserRole.EMPLOYEE, login="old-login")
    engine = create_database_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with Session(engine) as db:
        db.add(
            Workspace(
                display_name=employee.display_name,
                kind=WorkspaceKind.STUDIO,
                owner_id=employee.id,
            )
        )
        db.commit()
    csrf = login(client, "owner-edit")

    response = client.put(
        f"/api/v1/users/{employee.id}",
        headers={"X-CSRF-Token": csrf},
        json={"display_name": "Новое имя", "login": "new-login"},
    )
    assert response.status_code == 200
    assert response.json()["display_name"] == "Новое имя"
    assert response.json()["login"] == "new-login"

    with Session(engine) as db:
        workspace = db.scalar(
            select(Workspace).where(
                Workspace.owner_id == employee.id,
                Workspace.kind == WorkspaceKind.STUDIO,
            )
        )
        assert workspace is not None
        assert workspace.display_name == "Новое имя"

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"login": "old-login", "password": "strong-pass-123"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"login": "new-login", "password": "strong-pass-123"},
        ).status_code
        == 200
    )

    assert owner.id != employee.id


def test_owner_can_assign_user_permissions(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", role=UserRole.OWNER, login="rights-owner")
    employee = seed_user(tmp_path / "test.db", role=UserRole.EMPLOYEE, login="rights-user")
    csrf = login(client, "rights-owner")
    response = client.put(
        f"/api/v1/users/{employee.id}/permissions",
        headers={"X-CSRF-Token": csrf},
        json={
            "role": "employee",
            "can_create_shared_workspaces": False,
            "can_create_private_workspaces": True,
            "can_add_comments": False,
            "can_upload_media": False,
            "can_view_all_calendars": True,
            "can_access_admin": False,
            "can_access_chats": False,
        },
    )
    assert response.status_code == 200
    assert response.json()["can_create_shared_workspaces"] is False
    assert response.json()["can_create_private_workspaces"] is True
    assert response.json()["can_add_comments"] is False
    assert response.json()["can_upload_media"] is False
    assert response.json()["can_view_all_calendars"] is True
    assert response.json()["can_access_admin"] is False
    assert response.json()["can_access_chats"] is False

    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf})
    csrf = login(client, "rights-user")
    assert client.get("/api/v1/users").status_code == 403
    assert client.get("/api/v1/discussions").status_code == 403
