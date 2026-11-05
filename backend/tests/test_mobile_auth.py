from fastapi.testclient import TestClient

from tests.test_auth import seed_user


def test_mobile_bearer_login_me_and_logout(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", login="violetta")
    login = client.post(
        "/api/v1/mobile/auth/login",
        json={"login": "VIOLETTA", "password": "strong-pass-123"},
    )
    assert login.status_code == 200
    token = login.json()["access_token"]
    assert token
    headers = {"Authorization": f"Bearer {token}"}
    me = client.get("/api/v1/mobile/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["login"] == "violetta"
    assert client.post("/api/v1/mobile/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/v1/mobile/auth/me", headers=headers).status_code == 401


def test_mobile_rejects_invalid_credentials(client: TestClient, tmp_path) -> None:
    seed_user(tmp_path / "test.db", login="mobile-user")
    response = client.post(
        "/api/v1/mobile/auth/login",
        json={"login": "mobile-user", "password": "wrong-password"},
    )
    assert response.status_code == 401
