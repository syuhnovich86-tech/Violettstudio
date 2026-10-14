import json
from collections.abc import Mapping

import httpx

from vita29.settings import get_settings
from vita29.yclients.client import YclientsClient


SALON_ID = 956792


def summarize(name: str, response: httpx.Response) -> None:
    summary: dict[str, object] = {"name": name, "status": response.status_code}
    try:
        payload = response.json()
    except ValueError:
        summary["body"] = response.text[:200]
        print(json.dumps(summary, ensure_ascii=False))
        return
    data = payload.get("data") if isinstance(payload, Mapping) else None
    summary["payload_keys"] = sorted(payload.keys()) if isinstance(payload, Mapping) else []
    summary["data_type"] = type(data).__name__
    if isinstance(data, list):
        summary["count"] = len(data)
        summary["item_keys"] = sorted(data[0].keys()) if data and isinstance(data[0], Mapping) else []
        if data and isinstance(data[0], Mapping):
            summary["sample_id"] = data[0].get("id")
            summary["sample_title"] = data[0].get("name") or data[0].get("title")
            summary["first_datetime"] = data[0].get("datetime")
            summary["last_datetime"] = data[-1].get("datetime") if isinstance(data[-1], Mapping) else None
    if isinstance(payload, Mapping):
        summary["meta"] = payload.get("meta")
    elif isinstance(data, Mapping):
        summary["data_keys"] = sorted(data.keys())
    print(json.dumps(summary, ensure_ascii=False))


def main() -> None:
    settings = get_settings()
    client = YclientsClient(settings)
    base = settings.yclients_api_base_url.rstrip("/")
    with httpx.Client(headers=client._user_headers(), timeout=30) as http:
        requests = [
            ("staff", f"{base}/api/v1/company/{SALON_ID}/staff/", {"page": 1, "count": 100}),
            ("services", f"{base}/api/v1/company/{SALON_ID}/services/", {"page": 1, "count": 100}),
            ("records_old", f"{base}/api/v1/records/{SALON_ID}", {"start_date": "2000-01-01", "end_date": "2019-12-31", "page": 1, "count": 1}),
            ("records_recent", f"{base}/api/v1/records/{SALON_ID}", {"start_date": "2020-01-01", "end_date": "2026-10-09", "page": 1, "count": 1}),
            ("records_future", f"{base}/api/v1/records/{SALON_ID}", {"start_date": "2026-10-10", "end_date": "2035-12-31", "page": 1, "count": 1}),
            ("records_all", f"{base}/api/v1/records/{SALON_ID}", {"start_date": "2000-01-01", "end_date": "2035-12-31", "page": 1, "count": 100}),
            ("records_all_1000", f"{base}/api/v1/records/{SALON_ID}", {"start_date": "2000-01-01", "end_date": "2035-12-31", "page": 1, "count": 1000}),
        ]
        for name, url, params in requests:
            try:
                summarize(name, http.get(url, params=params))
            except Exception as exc:
                print(json.dumps({"name": name, "error": type(exc).__name__, "detail": str(exc)[:200]}, ensure_ascii=False))
        sample = http.get(
            f"{base}/api/v1/records/{SALON_ID}",
            params={"start_date": "2000-01-01", "end_date": "2035-12-31", "page": 1, "count": 1},
        ).json()["data"][0]
        nested = {}
        for key in ("client", "staff"):
            value = sample.get(key)
            nested[key] = sorted(value.keys()) if isinstance(value, Mapping) else type(value).__name__
        services = sample.get("services")
        nested["service"] = sorted(services[0].keys()) if isinstance(services, list) and services and isinstance(services[0], Mapping) else []
        print(json.dumps({"nested_keys": nested}, ensure_ascii=False))


if __name__ == "__main__":
    main()
