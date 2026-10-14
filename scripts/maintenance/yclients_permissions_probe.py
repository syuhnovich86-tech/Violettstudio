import json

import httpx

from vita29.settings import get_settings
from vita29.yclients.client import YclientsClient


SALON_ID = 956792


def main() -> None:
    settings = get_settings()
    client = YclientsClient(settings)
    base = settings.yclients_api_base_url.rstrip("/")
    response = httpx.get(
        f"{base}/api/v1/user/permissions/{SALON_ID}/",
        headers=client._user_headers(),
        params=[("group_permissions[]", "clients"), ("group_permissions[]", "dashboard")],
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data")
    if not isinstance(data, dict):
        print(json.dumps({"status": response.status_code, "data_type": type(data).__name__}))
        return
    allowed = {}
    for key, value in sorted(data.items()):
        key_lower = key.lower()
        if any(term in key_lower for term in ("client", "phone", "email", "export", "record_form")):
            allowed[key] = value
    print(json.dumps(allowed, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
