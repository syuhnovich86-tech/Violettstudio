from fastapi.testclient import TestClient

from tests.test_auth import login, seed_user


def test_storage_status_requires_login_and_reports_capacity(
    client: TestClient, tmp_path
) -> None:
    assert client.get("/api/v1/storage").status_code == 401
    seed_user(tmp_path / "test.db")
    login(client)

    response = client.get("/api/v1/storage")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_bytes"] > 0
    assert payload["used_bytes"] >= 0
    assert payload["free_bytes"] > 0
    assert payload["media_bytes"] == 0
    assert 0 <= payload["used_percent"] <= 100
