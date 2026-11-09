import asyncio
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from vita29.content.vkid_oauth import VKIDError, new_authorization, token_request


def test_pkce_and_state_are_unique():
    url, state, verifier = new_authorization("123", "https://example.org/callback")
    query = parse_qs(urlparse(url).query)
    assert query["state"] == [state]
    assert query["code_challenge_method"] == ["S256"]
    assert verifier not in url
    assert state != new_authorization("123", "https://example.org/callback")[1]


def test_exchange_and_refresh_use_correct_parameters():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"state": "s", "access_token": "a", "refresh_token": "r"})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            args = dict(client_id="123", redirect_uri="https://example.org/callback", device_id="d", state="s")
            await token_request(client, **args, code="code", verifier="verifier")
            await token_request(client, **args, refresh_token="r")
    asyncio.run(run())
    assert calls[0].url.params["grant_type"] == "authorization_code"
    assert calls[0].url.params["code_verifier"] == "verifier"
    assert calls[1].url.params["grant_type"] == "refresh_token"
    assert b"refresh_token=r" in calls[1].content


def test_rejects_wrong_state():
    async def run():
        transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"state": "wrong", "access_token": "a", "refresh_token": "r"}))
        async with httpx.AsyncClient(transport=transport) as client:
            await token_request(client, client_id="123", redirect_uri="https://example.org", device_id="d", state="s", refresh_token="r")
    with pytest.raises(VKIDError, match="state mismatch"):
        asyncio.run(run())
