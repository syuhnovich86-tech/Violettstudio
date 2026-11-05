import json
from pathlib import Path
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from vita29.settings import get_settings


def publish_test_update(client: TestClient, tmp_path: Path) -> None:
    settings = client.app.dependency_overrides[get_settings]()
    settings.mobile_updates_root = tmp_path / "updates"
    update_dir = settings.mobile_updates_root / "0.1.0" / "20261104170000"
    bundle = "_expo/static/js/android/index-test.hbc"
    asset = "assets/test.png"
    (update_dir / bundle).parent.mkdir(parents=True)
    (update_dir / asset).parent.mkdir(parents=True)
    (update_dir / bundle).write_bytes(b"android-javascript-bundle")
    (update_dir / asset).write_bytes(b"fake-png")
    (update_dir / "metadata.json").write_text(
        json.dumps(
            {
                "fileMetadata": {
                    "android": {
                        "bundle": bundle,
                        "assets": [{"path": asset, "ext": "png"}],
                    }
                }
            }
        ),
        encoding="utf-8",
    )


def test_mobile_update_manifest_and_asset(client: TestClient, tmp_path: Path) -> None:
    publish_test_update(client, tmp_path)
    response = client.get(
        "/api/v1/mobile/updates/manifest",
        headers={
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "0.1.0",
        },
    )
    assert response.status_code == 200
    assert response.headers["expo-protocol-version"] == "1"
    manifest = response.json()
    assert manifest["runtimeVersion"] == "0.1.0"
    assert manifest["launchAsset"]["contentType"] == "application/javascript"
    assert manifest["assets"][0]["contentType"] == "image/png"

    asset_url = urlsplit(manifest["assets"][0]["url"])
    asset_response = client.get(f"{asset_url.path}?{asset_url.query}")
    assert asset_response.status_code == 200
    assert asset_response.content == b"fake-png"
    assert asset_response.headers["cache-control"] == "public, max-age=31536000, immutable"

    same_update = client.get(
        "/api/v1/mobile/updates/manifest",
        headers={
            "expo-protocol-version": "1",
            "expo-platform": "android",
            "expo-runtime-version": "0.1.0",
            "expo-current-update-id": manifest["id"],
        },
    )
    assert same_update.status_code == 204


def test_mobile_update_rejects_invalid_request(client: TestClient, tmp_path: Path) -> None:
    publish_test_update(client, tmp_path)
    assert client.get("/api/v1/mobile/updates/manifest").status_code == 400
    response = client.get(
        "/api/v1/mobile/updates/assets/0.1.0/20261104170000/android",
        params={"path": "../../test.db"},
    )
    assert response.status_code == 404
