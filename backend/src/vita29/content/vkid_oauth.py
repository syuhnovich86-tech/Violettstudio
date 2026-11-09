"""VK ID OAuth primitives for an isolated analytics connection.

No credentials are stored here; the caller must persist rotated tokens atomically.
"""
import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx


class VKIDError(RuntimeError):
    """Sanitised provider error; never includes token response bodies."""


def new_authorization(client_id: str, redirect_uri: str) -> tuple[str, str, str]:
    verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
                       "scope": "stats groups", "state": state, "code_challenge": challenge,
                       "code_challenge_method": "S256"})
    return "https://id.vk.com/authorize?" + query, state, verifier


async def token_request(client: httpx.AsyncClient, *, client_id: str, redirect_uri: str,
                        device_id: str, state: str, code: str | None = None,
                        verifier: str | None = None, refresh_token: str | None = None) -> dict:
    if not all((client_id, redirect_uri, device_id, state)) or bool(code) == bool(refresh_token):
        raise ValueError("invalid VK ID request")
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "device_id": device_id, "state": state}
    if code:
        if not verifier:
            raise ValueError("PKCE verifier required")
        params.update(grant_type="authorization_code", code_verifier=verifier)
        body = {"code": code}
    else:
        params["grant_type"] = "refresh_token"
        body = {"refresh_token": refresh_token}
    try:
        response = await client.post("https://id.vk.com/oauth2/auth", params=params, data=body)
        result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise VKIDError("VK ID is unavailable") from exc
    if response.is_error or not isinstance(result, dict) or result.get("error"):
        raise VKIDError("VK ID rejected the request")
    if not secrets.compare_digest(str(result.get("state", "")), state):
        raise VKIDError("VK ID state mismatch")
    if not result.get("access_token") or not result.get("refresh_token"):
        raise VKIDError("VK ID did not return a renewable token")
    return result
