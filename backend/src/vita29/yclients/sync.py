import json
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from vita29.db.models import YclientsStaffMapping, YclientsVisit, utc_now
from vita29.yclients.client import YclientsClient, YclientsError


def _parse_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("YCLIENTS record datetime is missing")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _client_name_from_data(client: dict[str, Any]) -> str | None:
    parts = [client.get("surname"), client.get("name"), client.get("patronymic")]
    result = " ".join(part.strip() for part in parts if isinstance(part, str) and part.strip())
    if result:
        return result[:200]
    display_name = client.get("display_name")
    if isinstance(display_name, str) and display_name.strip():
        return display_name.strip()[:200]
    return None


def _client_name(record: dict[str, Any]) -> str | None:
    client = record.get("client")
    return _client_name_from_data(client) if isinstance(client, dict) else None


def _is_abbreviated_client_name(value: str | None) -> bool:
    if not value:
        return True
    first_part = value.split(maxsplit=1)[0]
    return len(first_part) <= 2 and first_part.endswith(".")


def _service_titles(record: dict[str, Any]) -> str | None:
    services = record.get("services")
    if not isinstance(services, list):
        return None
    titles = [
        item["title"].strip()
        for item in services
        if isinstance(item, dict)
        and isinstance(item.get("title"), str)
        and item["title"].strip()
    ]
    return json.dumps(titles, ensure_ascii=False) if titles else None


def sync_yclients_visits(
    *,
    db: Session,
    client: YclientsClient,
    salon_id: int,
    start_date: date,
    end_date: date,
    page_size: int = 100,
) -> dict[str, int]:
    mappings = db.scalars(
        select(YclientsStaffMapping).where(YclientsStaffMapping.salon_id == salon_id)
    ).all()
    users_by_staff_id = {mapping.staff_id: mapping.user_id for mapping in mappings}
    processed_ids: set[int] = set()
    client_names: dict[int, str | None] = {}
    linked = 0
    unlinked = 0

    for page in range(1, 101):
        records = client.list_records(
            salon_id,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            page=page,
            count=page_size,
        )
        page_client_ids = list({
            int(client_data["id"])
            for record in records
            if isinstance((client_data := record.get("client")), dict)
            and client_data.get("id") is not None
            and int(client_data["id"]) not in client_names
        })
        if page_client_ids:
            stored_names = db.execute(
                select(YclientsVisit.client_id, YclientsVisit.client_display_name).where(
                    YclientsVisit.client_id.in_(page_client_ids)
                )
            ).all()
            for stored_client_id, stored_name in stored_names:
                if stored_client_id is not None and not _is_abbreviated_client_name(stored_name):
                    client_names[int(stored_client_id)] = stored_name
            page_client_ids = [
                client_id for client_id in page_client_ids if client_id not in client_names
            ]
        for start in range(0, len(page_client_ids), 100):
            chunk = page_client_ids[start : start + 100]
            try:
                full_clients = client.list_clients_by_ids(salon_id, chunk)
            except (AttributeError, YclientsError):
                full_clients = []
            for client_data in full_clients:
                if client_data.get("id") is not None:
                    full_name = _client_name_from_data(client_data)
                    if not _is_abbreviated_client_name(full_name):
                        client_names[int(client_data["id"])] = full_name
            missing_ids = [client_id for client_id in chunk if client_id not in client_names]
            try:
                detailed_clients = client.get_clients_by_ids(salon_id, missing_ids)
            except (AttributeError, YclientsError):
                detailed_clients = []
            for client_data in detailed_clients:
                if client_data.get("id") is not None:
                    client_names[int(client_data["id"])] = _client_name_from_data(client_data)
            for client_id in chunk:
                client_names.setdefault(client_id, None)
        for record in records:
            record_id = int(record["id"])
            staff_id = int(record["staff_id"])
            user_id = users_by_staff_id.get(staff_id)
            client_data = record.get("client")
            client_id = (
                int(client_data["id"])
                if isinstance(client_data, dict) and client_data.get("id") is not None
                else None
            )
            visit = db.get(YclientsVisit, record_id) or YclientsVisit(record_id=record_id)
            visit.salon_id = salon_id
            visit.staff_id = staff_id
            visit.user_id = user_id
            visit.client_id = client_id
            visit.client_display_name = client_names.get(client_id) or _client_name(record)
            visit.starts_at = _parse_datetime(record.get("datetime"))
            visit.service_titles = _service_titles(record)
            comment = record.get("comment")
            visit.comment = comment.strip() if isinstance(comment, str) and comment.strip() else None
            visit.attendance = int(record.get("attendance") or 0)
            visit.deleted = bool(record.get("deleted", False))
            visit.synced_at = utc_now()
            db.add(visit)
            processed_ids.add(record_id)
            if user_id is None:
                unlinked += 1
            else:
                linked += 1
        if len(records) < page_size:
            break
    else:
        raise RuntimeError("YCLIENTS records pagination limit exceeded")

    db.commit()
    return {
        "processed": len(processed_ids),
        "linked": linked,
        "unlinked": unlinked,
    }
