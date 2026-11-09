import asyncio
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from vita29.api import vkid_diagnostic as diag
from vita29.auth.dependencies import require_owner_or_administrator
from vita29.settings import get_settings


def test_read_only_check_refreshes_without_saving(monkeypatch):
    app = FastAPI()
    app.include_router(diag.router)
    app.dependency_overrides[require_owner_or_administrator] = lambda: SimpleNamespace(id=9)
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace()
    monkeypatch.setattr(diag, "config_value", lambda *_: "123")
    calls = []
    async def tokens(_client, **kwargs):
        calls.append(kwargs)
        return {"access_token": "secret", "refresh_token": "refresh"}
    async def stats(_client, token, group):
        assert token == "secret" and group == "123"
        return "доступна"
    monkeypatch.setattr(diag, "token_request", tokens)
    monkeypatch.setattr(diag, "_check_stats", stats)
    client = TestClient(app, follow_redirects=False)
    start = client.get("/integrations/vkid/start")
    assert start.status_code == 307
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    result = client.get("/integrations/vkid/callback", params={"state": state, "code": "code", "device_id": "device"})
    assert result.status_code == 200
    assert "Обновление токена: успешно" in result.text
    assert "secret" not in result.text and "refresh" not in result.text
    assert len(calls) == 2 and calls[1]["refresh_token"] == "refresh"
    assert client.get("/integrations/vkid/callback", params={"state": state, "code": "code", "device_id": "device"}).status_code == 400


def test_stats_error_is_sanitised():
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"error": {"error_code": 1051, "error_msg": "secret"}}))
        async with httpx.AsyncClient(transport=transport) as client:
            assert await diag._check_stats(client, "secret", "123") == "ошибка VK 1051"
    asyncio.run(run())
