import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from vita29.settings import get_settings
from vita29.yclients.client import YclientsClient


SALON_ID = 956792
PAGE_SIZE = 100
OUTPUT = Path("/data/app/yclients-client-export/clients.json")


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def full_name(item: dict[str, Any]) -> str:
    result = " ".join(
        part for part in (text(item.get("surname")), text(item.get("name")), text(item.get("patronymic"))) if part
    )
    return result or text(item.get("display_name"))


def names(items: Any) -> str:
    if not isinstance(items, list):
        return ""
    result = []
    for item in items:
        if isinstance(item, dict):
            value = item.get("title") or item.get("name") or item.get("id")
        else:
            value = item
        if value not in (None, ""):
            result.append(str(value).strip())
    return "; ".join(value for value in result if value)


def as_json(value: Any) -> str:
    if value in (None, [], {}):
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def get_page(http: httpx.Client, base: str, page: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    response = http.get(
        f"{base}/api/v1/clients/{SALON_ID}",
        params={"page": page, "count": PAGE_SIZE},
    )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data")
    if not isinstance(data, list):
        raise RuntimeError("YCLIENTS returned invalid clients data")
    return data, payload.get("meta") or {}


def main() -> None:
    settings = get_settings()
    client = YclientsClient(settings)
    base = settings.yclients_api_base_url.rstrip("/")
    with httpx.Client(headers=client._user_headers(), timeout=60) as http:
        first, meta = get_page(http, base, 1)
        total = int(meta.get("total_count") or meta.get("count") or len(first))
        raw = list(first)
        for page in range(2, math.ceil(total / PAGE_SIZE) + 1):
            part, _ = get_page(http, base, page)
            raw.extend(part)

    clients = []
    for item in raw:
        clients.append(
            {
                "id": item.get("id"),
                "full_name": full_name(item),
                "surname": item.get("surname"),
                "name": item.get("name"),
                "patronymic": item.get("patronymic"),
                "phone": item.get("phone"),
                "email": item.get("email"),
                "birth_date": item.get("birth_date") or item.get("birthdate"),
                "sex": item.get("sex"),
                "card": item.get("card"),
                "discount": item.get("discount"),
                "balance": item.get("balance"),
                "spent": item.get("spent"),
                "paid": item.get("paid"),
                "visits_count": item.get("visits_count") if item.get("visits_count") is not None else item.get("visits"),
                "success_visits_count": item.get("success_visits_count"),
                "fail_visits_count": item.get("fail_visits_count"),
                "first_visit_date": item.get("first_visit_date"),
                "last_visit_date": item.get("last_visit_date"),
                "create_date": item.get("create_date") or item.get("created_at"),
                "last_change_date": item.get("last_change_date"),
                "comment": item.get("comment"),
                "categories": names(item.get("categories")),
                "tags": names(item.get("client_tags") or item.get("tags")),
                "category_id": item.get("category_id"),
                "importance_id": item.get("importance_id"),
                "importance": item.get("importance"),
                "recording_source_id": item.get("recording_source_id"),
                "sex_id": item.get("sex_id"),
                "sms_bot": item.get("sms_bot"),
                "sms_check": item.get("sms_check"),
                "sms_not": item.get("sms_not"),
                "custom_fields": as_json(item.get("custom_fields")),
            }
        )
    clients.sort(key=lambda item: (text(item.get("full_name")).casefold(), int(item.get("id") or 0)))
    result = {
        "summary": {
            "salon_id": SALON_ID,
            "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "count": len(clients),
            "api_total": total,
            "source_fields": sorted({key for item in raw for key in item.keys()}),
        },
        "clients": clients,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
