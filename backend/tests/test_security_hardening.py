"""Security regressions; temporary databases, no real integrations or publishing."""
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from tests.test_auth import login, seed_user
from vita29.auth import throttle
from vita29.settings import Settings


def request(peer="198.51.100.10", headers=None):
    return Request({"type": "http", "client": (peer, 1234), "headers": [
        (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
    ]})


def test_account_limit_shared_between_web_and_mobile(client, monkeypatch):
    monkeypatch.setattr("vita29.api.auth.verify_password", lambda *args: False)
    monkeypatch.setattr("vita29.api.mobile_auth.verify_password", lambda *args: False)
    for i in range(5):
        route = "/api/v1/auth/login" if i % 2 else "/api/v1/mobile/auth/login"
        assert client.post(route, json={"login": " Shared-User ", "password": "wrong"}).status_code == 401
    response = client.post("/api/v1/auth/login", json={"login": "shared-user", "password": "wrong"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "300"


def test_rotating_names_and_headers_cannot_reset_source_budget(client, monkeypatch):
    monkeypatch.setattr("vita29.api.auth.verify_password", lambda *args: False)
    monkeypatch.setattr("vita29.api.mobile_auth.verify_password", lambda *args: False)
    for i in range(60):
        route = "/api/v1/auth/login" if i % 2 else "/api/v1/mobile/auth/login"
        response = client.post(route, json={"login": f"unknown-{i}", "password": "wrong"}, headers={
            "X-Forwarded-For": f"203.0.113.{i}", "X-Vita29-Client-IP": f"203.0.113.{i}"
        })
        assert response.status_code == 401
    assert client.post("/api/v1/mobile/auth/login", json={"login": "next", "password": "wrong"}).status_code == 429


def test_atomic_concurrent_reservations_and_restart(tmp_path):
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'app.db'}")
    def attempt(index):
        try:
            throttle.reserve_login_attempt("same", request(f"198.51.100.{index}"), settings)
            return 200
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=16) as pool:
        outcomes = list(pool.map(attempt, range(16)))
    assert outcomes.count(200) == 5
    assert outcomes.count(429) == 11
    # A fresh interpreter must still see reservations made by this process.
    code = """from fastapi import HTTPException
from starlette.requests import Request
from vita29.settings import Settings
from vita29.auth.throttle import reserve_login_attempt
import sys
try:
    reserve_login_attempt('same', Request({'type':'http','client':('203.0.113.9',1),'headers':[]}), Settings(database_url=sys.argv[1]))
except HTTPException as e:
    assert e.status_code == 429
else:
    raise AssertionError('restart bypass')
"""
    subprocess.run([sys.executable, "-c", code, settings.database_url], check=True)


def test_success_keeps_source_budget_and_expiration_recovers(tmp_path):
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'app.db'}")
    with patch.object(throttle, "time", return_value=1000):
        for _ in range(60):
            attempt = throttle.reserve_login_attempt("valid-user", request(), settings)
            throttle.complete_login_success("valid-user", attempt, settings)
        with pytest.raises(HTTPException) as caught:
            throttle.reserve_login_attempt("another-user", request(), settings)
        assert caught.value.status_code == 429
    with patch.object(throttle, "time", return_value=1301):
        assert throttle.reserve_login_attempt("another-user", request(), settings)


def test_trusted_proxy_and_ipv6_sources():
    settings = Settings(trusted_proxy_hosts=("caddy",))
    with patch.object(throttle, "_proxy_addresses", return_value=frozenset({"172.18.0.2"})):
        headers = {"X-Vita29-Client-IP": "203.0.113.10", "X-Forwarded-For": "192.0.2.20"}
        assert throttle.client_source(request("172.18.0.2", headers), settings) == "203.0.113.10"
        assert throttle.client_source(request("198.51.100.5", headers), settings) == "198.51.100.5"
        assert throttle.client_source(request("172.18.0.2", {"X-Vita29-Client-IP": "invalid"}), settings) == "172.18.0.2"
    assert throttle.client_source(request("2001:db8:1:2::1"), Settings()) == "2001:db8:1:2::/64"
    assert throttle.client_source(request("::ffff:198.51.100.5"), Settings()) == "198.51.100.5"


def test_store_failure_does_not_disable_protection(tmp_path):
    bad_path = tmp_path / "directory"
    bad_path.mkdir()
    settings = Settings(login_throttle_path=bad_path)
    with pytest.raises(HTTPException) as caught:
        throttle.reserve_login_attempt("user", request(), settings)
    assert caught.value.status_code == 503
    assert str(tmp_path) not in caught.value.detail


@pytest.mark.parametrize("authorization", ["Bearer", "Bearer ", "bEaReR", "Basic anything"])
def test_cookie_cannot_use_empty_bearer_to_skip_csrf(client, tmp_path, authorization):
    seed_user(tmp_path / "test.db")
    csrf = login(client)
    response = client.post("/api/v1/auth/logout", headers={"Authorization": authorization})
    assert response.status_code == 403
    assert client.get("/api/v1/auth/me").status_code == 200
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204


def test_invalid_nonempty_bearer_does_not_fall_back_to_cookie(client, tmp_path):
    seed_user(tmp_path / "test.db")
    csrf = login(client)
    assert client.post("/api/v1/auth/logout", headers={"Authorization": "Bearer invalid", "X-CSRF-Token": csrf}).status_code == 401
    assert client.get("/api/v1/auth/me").status_code == 200


def test_employees_share_an_address_and_existing_sessions_remain(client, tmp_path):
    seed_user(tmp_path / "test.db", login="first")
    seed_user(tmp_path / "test.db", login="second")
    csrf = login(client, "first")
    mobile = client.post("/api/v1/mobile/auth/login", json={"login": "second", "password": "strong-pass-123"})
    assert mobile.status_code == 200
    assert client.get("/api/v1/auth/me").json()["user"]["login"] == "first"
    assert client.get("/api/v1/mobile/auth/me", headers={"Authorization": "Bearer " + mobile.json()["access_token"]}).json()["login"] == "second"
    assert client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204


def test_missing_asset_metadata_is_404(client):
    response = client.get("/api/v1/mobile/updates/assets/0.6.0/missing/android", params={"path": "bundle.js"})
    assert response.status_code == 404
    assert response.json()["detail"] == "Asset not found"


@pytest.mark.parametrize("version", [".", "..", "../x", "%2e%2e", "x\\y"])
def test_update_runtime_cannot_leave_root(client, version):
    response = client.get("/api/v1/mobile/updates/manifest", headers={"expo-platform": "android", "expo-runtime-version": version})
    assert response.status_code == 400


def test_production_docs_disabled_without_starting_workers():
    code = """import os
os.environ['VITA29_ENVIRONMENT']='production'
from fastapi.testclient import TestClient
from vita29.main import app
client=TestClient(app)
for path in ['/docs','/redoc','/openapi.json']:
    assert client.get(path).status_code == 404, path
"""
    subprocess.run([sys.executable, "-c", code], check=True)
