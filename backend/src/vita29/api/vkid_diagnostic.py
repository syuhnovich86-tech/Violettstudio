"""Temporary, read-only VK ID capability check; does not persist or log credentials."""
import asyncio
import time
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from vita29.auth.dependencies import require_owner_or_administrator
from vita29.content.vkid_oauth import VKIDError, new_authorization, token_request
from vita29.db.models import User
from vita29.integrations.store import config_value
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/integrations/vkid", tags=["integrations"])
CLIENT = "54886080"
CALLBACK = "https://vita29.taild51e5c.ts.net/api/v1/integrations/vkid/callback"
_attempts = {}
_headers = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"}


@router.get("/start")
def start(user: Annotated[User, Depends(require_owner_or_administrator)]):
    now = time.monotonic()
    for key in list(_attempts):
        if _attempts[key]["expires"] < now:
            del _attempts[key]
    if len(_attempts) >= 100:
        raise HTTPException(429, "Слишком много попыток. Повторите позже.")
    url, state, verifier = new_authorization(CLIENT, CALLBACK)
    _attempts[state] = {"user_id": user.id, "verifier": verifier, "expires": now + 600}
    return RedirectResponse(url, headers=_headers)


async def _check_stats(client, token, group):
    if not group.isdecimal():
        return "ID сообщества не настроен"
    try:
        response = await client.post("https://api.vk.com/method/stats.get", data={
            "group_id": group, "v": "5.199", "access_token": token, "interval": "day",
            "intervals_count": "1",
        })
        data = response.json()
        if isinstance(data.get("response"), list):
            return "доступна"
        error = data.get("error", {})
        code = error.get("error_code")
        subcode = error.get("error_subcode")
        return f"ошибка VK {code if isinstance(code, int) else 'неизвестна'}" + (f" / {subcode}" if isinstance(subcode, int) else "")
    except (ValueError, httpx.HTTPError):
        return "ответ VK недоступен"


@router.get("/callback", response_class=HTMLResponse)
async def callback(user: Annotated[User, Depends(require_owner_or_administrator)],
                   settings: Annotated[Settings, Depends(get_settings)],
                   state: str = Query(default="", max_length=128),
                   code: str = Query(default="", max_length=4096),
                   device_id: str = Query(default="", max_length=256),
                   error: str = Query(default="", max_length=128)):
    attempt = _attempts.pop(state, None)
    if not attempt or attempt["expires"] < time.monotonic() or attempt["user_id"] != user.id:
        raise HTTPException(400, "Срок попытки истёк или она относится к другому пользователю.")
    if error or not code or not device_id:
        return HTMLResponse("VK ID не завершил вход. Вернитесь на сайт и попробуйте снова.", headers=_headers)
    group = config_value(settings, "vk_group_id").lstrip("-")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            first = await token_request(client, client_id=CLIENT, redirect_uri=CALLBACK,
                device_id=device_id, state=state, code=code, verifier=attempt["verifier"])
            before = await _check_stats(client, first["access_token"], group)
            second = await token_request(client, client_id=CLIENT, redirect_uri=CALLBACK,
                device_id=device_id, state=state, refresh_token=first["refresh_token"])
            after = await _check_stats(client, second["access_token"], group)
    except (VKIDError, ValueError):
        return HTMLResponse("Не удалось получить или обновить токен VK ID. Действующие ключи не изменены.", headers=_headers)
    return HTMLResponse(f"<h2>Проверка VK ID</h2><p>Обновление токена: успешно.</p>"
        f"<p>Статистика до обновления: {before}.</p><p>Статистика после обновления: {after}.</p>"
        "<p>Проверка завершена, токены не сохранены. Ключ публикаций не изменён.</p>", headers=_headers)
