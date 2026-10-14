import httpx
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from vita29.auth.security import hash_password
from vita29.db.models import User, UserRole
from vita29.db.session import create_database_engine
from vita29.main import app
from vita29.settings import Settings
from vita29.yclients.client import YclientsClient, get_yclients_client


class FakeYclientsClient:
    def __init__(self):
        self.activated: list[int] = []

    def activate(self, salon_id: int):
        self.activated.append(salon_id)
        return {"success": True}


def test_real_client_accepts_already_active_connection(tmp_path, monkeypatch) -> None:
    token_file = tmp_path / "partner_token"
    token_file.write_text("partner-token", encoding="utf-8")
    captured_payload = {}

    def fake_post(url, *, headers, json, timeout):
        assert headers["Accept"] == "application/vnd.api.v2+json"
        captured_payload.update(json)
        return httpx.Response(
            403,
            json={"success": False},
            request=httpx.Request("POST", url),
        )

    def fake_get(url, *, headers, timeout):
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": {"connection_status": {"status": "active"}},
            },
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "get", fake_get)
    settings = Settings(yclients_partner_token_file=token_file)

    result = YclientsClient(settings).activate(956792)

    assert result["data"]["connection_status"]["status"] == "active"
    assert captured_payload == {"salon_id": 956792, "application_id": 49434}


def seed_owner(database_path) -> None:
    engine = create_database_engine(f"sqlite:///{database_path}")
    with Session(engine) as db:
        db.add(
            User(
                display_name="Степан",
                login="owner-yc",
                password_hash=hash_password("strong-pass-123"),
                role=UserRole.OWNER,
            )
        )
        db.commit()


def login_owner(client: TestClient) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"login": "owner-yc", "password": "strong-pass-123"},
    )
    assert response.status_code == 200
    return response.json()["csrf_token"]


def test_marketplace_connect_requires_owner_and_activates(client, tmp_path) -> None:
    fake = FakeYclientsClient()
    app.dependency_overrides[get_yclients_client] = lambda: fake

    assert client.get("/api/v1/yclients/connect?salon_id=123", follow_redirects=False).status_code == 401
    seed_owner(tmp_path / "test.db")
    login_owner(client)

    response = client.get("/api/v1/yclients/connect?salon_id=123", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/?yclients=connected"
    assert fake.activated == [123]

    status_response = client.get("/api/v1/yclients/status")
    assert status_response.status_code == 200
    assert status_response.json() == {
        "configured": True,
        "salon_id": 123,
        "application_id": 49434,
        "status": "active",
    }


def test_manual_activation_requires_csrf(client, tmp_path) -> None:
    fake = FakeYclientsClient()
    app.dependency_overrides[get_yclients_client] = lambda: fake
    seed_owner(tmp_path / "test.db")
    csrf = login_owner(client)

    assert client.post("/api/v1/yclients/activate", json={"salon_id": 321}).status_code == 403
    response = client.post(
        "/api/v1/yclients/activate",
        json={"salon_id": 321},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert fake.activated == [321]


def test_marketplace_webhook_rejects_bad_token_and_updates_status(client, tmp_path) -> None:
    fake = FakeYclientsClient()
    app.dependency_overrides[get_yclients_client] = lambda: fake
    seed_owner(tmp_path / "test.db")
    login_owner(client)
    response = client.get("/api/v1/yclients/connect?salon_id=555", follow_redirects=False)
    assert response.status_code == 303

    payload = {
        "salon_id": 555,
        "application_id": 49434,
        "event": "freeze",
        "partner_token": "wrong-token",
    }
    assert client.post("/api/v1/yclients/webhook", json=payload).status_code == 403

    payload["partner_token"] = "test-partner-token"
    accepted = client.post("/api/v1/yclients/webhook", json=payload)
    assert accepted.status_code == 200
    assert client.get("/api/v1/yclients/status").json()["status"] == "frozen"
