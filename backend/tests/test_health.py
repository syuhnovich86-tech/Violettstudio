from pathlib import Path

from fastapi.testclient import TestClient


def test_health_reports_database_and_storage(client: TestClient, tmp_path: Path) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok", "storage": "ok"}
    assert (tmp_path / "media").is_dir()


def test_root_identifies_scaffold(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.json()["stage"] == "scaffold"
