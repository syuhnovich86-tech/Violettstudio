import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from vita29.settings import get_settings
from vita29.yclients.client import YclientsClient


SALON_ID = 956792
START_DATE = "2000-01-01"
END_DATE = "2035-12-31"
PAGE_SIZE = 1000
OUTPUT_DIR = Path("/data/app/yclients-export")


def as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def full_name(client: dict[str, Any] | None) -> str:
    if not client:
        return ""
    parts = [client.get("surname"), client.get("name"), client.get("patronymic")]
    result = " ".join(str(part).strip() for part in parts if str(part or "").strip())
    return result or str(client.get("display_name") or "").strip()


def join_values(items: Any, key: str) -> str:
    if not isinstance(items, list):
        return ""
    values = []
    for item in items:
        if isinstance(item, dict) and item.get(key) not in (None, ""):
            values.append(str(item[key]).strip())
    return "; ".join(value for value in values if value)


def sum_service_value(services: Any, key: str) -> float:
    if not isinstance(services, list):
        return 0.0
    result = 0.0
    for service in services:
        if not isinstance(service, dict):
            continue
        value = as_number(service.get(key))
        if value is not None:
            result += value
    return result


def get_data(http: httpx.Client, url: str, params: Any = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    response = http.get(url, params=params)
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data")
    if not isinstance(data, list):
        raise RuntimeError(f"Unexpected YCLIENTS response for {url}")
    return data, payload.get("meta") or {}


def main() -> None:
    settings = get_settings()
    client = YclientsClient(settings)
    base = settings.yclients_api_base_url.rstrip("/")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    with httpx.Client(headers=client._user_headers(), timeout=60) as http:
        staff_raw, _ = get_data(
            http,
            f"{base}/api/v1/company/{SALON_ID}/staff/",
            {"page": 1, "count": 1000},
        )
        services_raw, _ = get_data(
            http,
            f"{base}/api/v1/company/{SALON_ID}/services/",
            {"page": 1, "count": 1000},
        )

        first_records, meta = get_data(
            http,
            f"{base}/api/v1/records/{SALON_ID}",
            {
                "start_date": START_DATE,
                "end_date": END_DATE,
                "page": 1,
                "count": PAGE_SIZE,
            },
        )
        total_count = int(meta.get("total_count") or len(first_records))
        records_raw = list(first_records)
        for page in range(2, math.ceil(total_count / PAGE_SIZE) + 1):
            page_data, _ = get_data(
                http,
                f"{base}/api/v1/records/{SALON_ID}",
                {
                    "start_date": START_DATE,
                    "end_date": END_DATE,
                    "page": page,
                    "count": PAGE_SIZE,
                },
            )
            records_raw.extend(page_data)

        client_ids = sorted(
            {
                int(record["client"]["id"])
                for record in records_raw
                if isinstance(record.get("client"), dict)
                and record["client"].get("id") is not None
            }
        )
        clients_by_id: dict[int, dict[str, Any]] = {}
        for start in range(0, len(client_ids), 100):
            chunk = client_ids[start : start + 100]
            params: list[tuple[str, Any]] = [("id[]", value) for value in chunk]
            params.extend([("page", 1), ("count", 100)])
            clients, _ = get_data(http, f"{base}/api/v1/clients/{SALON_ID}", params)
            for item in clients:
                if item.get("id") is not None:
                    clients_by_id[int(item["id"])] = item

    staff = []
    for item in staff_raw:
        staff.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "specialization": item.get("specialization"),
                "position": item.get("position"),
                "phone": item.get("phone"),
                "email": item.get("email"),
                "status": item.get("status"),
                "bookable": item.get("is_bookable"),
                "online": item.get("is_online"),
                "hidden": item.get("hidden"),
                "fired": item.get("is_fired") if item.get("is_fired") is not None else item.get("fired"),
                "deleted": item.get("is_deleted"),
                "rating": item.get("rating"),
                "has_schedule": item.get("has_schedule"),
                "schedule_till": item.get("schedule_till"),
                "dismissal_date": item.get("dismissal_date"),
                "information": item.get("information"),
            }
        )

    services = []
    for item in services_raw:
        linked_staff = item.get("staff")
        services.append(
            {
                "id": item.get("id"),
                "title": item.get("title"),
                "booking_title": item.get("booking_title"),
                "print_title": item.get("print_title"),
                "category_id": item.get("category_id"),
                "price_min": item.get("price_min"),
                "price_max": item.get("price_max"),
                "discount": item.get("discount"),
                "duration_seconds": item.get("duration"),
                "active": item.get("active"),
                "online": item.get("is_online"),
                "service_type": item.get("service_type"),
                "staff_ids": join_values(linked_staff, "id"),
                "staff_names": join_values(linked_staff, "name"),
                "comment": item.get("comment"),
                "date_from": item.get("date_from"),
                "date_to": item.get("date_to"),
            }
        )

    visits = []
    for record in records_raw:
        client_short = record.get("client") if isinstance(record.get("client"), dict) else {}
        client_id = int(client_short["id"]) if client_short.get("id") is not None else None
        client_full = clients_by_id.get(client_id or -1) or client_short
        record_staff = record.get("staff") if isinstance(record.get("staff"), dict) else {}
        record_services = record.get("services") if isinstance(record.get("services"), list) else []
        visits.append(
            {
                "record_id": record.get("id"),
                "visit_id": record.get("visit_id"),
                "datetime": record.get("datetime"),
                "date": record.get("date"),
                "staff_id": record.get("staff_id"),
                "staff_name": record_staff.get("name"),
                "staff_position": record_staff.get("position"),
                "client_id": client_id,
                "client_name": full_name(client_full),
                "client_phone": client_full.get("phone") if isinstance(client_full, dict) else None,
                "client_email": client_full.get("email") if isinstance(client_full, dict) else None,
                "service_ids": join_values(record_services, "id"),
                "service_titles": join_values(record_services, "title"),
                "service_cost": sum_service_value(record_services, "cost"),
                "cost_to_pay": sum_service_value(record_services, "cost_to_pay"),
                "discount": sum_service_value(record_services, "discount"),
                "attendance": record.get("attendance"),
                "visit_attendance": record.get("visit_attendance"),
                "confirmed": record.get("confirmed"),
                "paid_full": record.get("paid_full"),
                "payment_status": record.get("payment_status"),
                "online": record.get("online"),
                "record_from": record.get("record_from"),
                "comment": record.get("comment"),
                "length_seconds": record.get("length"),
                "seance_length_seconds": record.get("seance_length"),
                "created_at": record.get("create_date"),
                "updated_at": record.get("last_change_date"),
                "deleted": record.get("deleted"),
            }
        )

    visits.sort(key=lambda item: str(item.get("datetime") or ""))
    exported_at = datetime.now().astimezone().isoformat(timespec="seconds")
    summary = {
        "salon_id": SALON_ID,
        "exported_at": exported_at,
        "requested_start": START_DATE,
        "requested_end": END_DATE,
        "staff_count": len(staff),
        "service_count": len(services),
        "visit_count": len(visits),
        "first_visit": visits[0]["datetime"] if visits else None,
        "last_visit": visits[-1]["datetime"] if visits else None,
        "unique_clients": len(client_ids),
        "enriched_clients": len(clients_by_id),
    }
    for name, data in (("staff", staff), ("services", services), ("visits", visits), ("summary", summary)):
        (OUTPUT_DIR / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
