from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends

from vita29.settings import Settings, get_settings


class YclientsError(RuntimeError):
    pass


def read_secret(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise YclientsError(f"YCLIENTS secret is unavailable: {path.name}") from exc
    if not value:
        raise YclientsError(f"YCLIENTS secret is empty: {path.name}")
    return value


class YclientsClient:
    def __init__(self, settings: Settings):
        self.settings = settings

    def _partner_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {read_secret(self.settings.yclients_partner_token_file)}",
            "Accept": "application/vnd.api.v2+json",
        }

    def _user_headers(self) -> dict[str, str]:
        partner_token = read_secret(self.settings.yclients_partner_token_file)
        user_token = read_secret(self.settings.yclients_user_token_file)
        return {
            "Authorization": f"Bearer {partner_token}, User {user_token}",
            "Accept": "application/vnd.api.v2+json",
        }

    def activate(self, salon_id: int) -> dict[str, Any]:
        try:
            response = httpx.post(
                f"{self.settings.yclients_api_base_url.rstrip('/')}/marketplace/partner/callback",
                headers=self._partner_headers(),
                json={
                    "salon_id": salon_id,
                    "application_id": self.settings.yclients_application_id,
                },
                timeout=self.settings.yclients_http_timeout_seconds,
            )
            if response.status_code == 403:
                current = self.connection_status(salon_id)
                connection = current.get("data", {}).get("connection_status", {})
                if connection.get("status") == "active":
                    return current
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise YclientsError("YCLIENTS activation failed") from exc
        if not response.content:
            return {"success": True}
        try:
            return response.json()
        except ValueError as exc:
            raise YclientsError("YCLIENTS returned an invalid activation response") from exc

    def connection_status(self, salon_id: int) -> dict[str, Any]:
        try:
            response = httpx.get(
                (
                    f"{self.settings.yclients_api_base_url.rstrip('/')}"
                    f"/marketplace/salon/{salon_id}/application/"
                    f"{self.settings.yclients_application_id}"
                ),
                headers=self._partner_headers(),
                timeout=self.settings.yclients_http_timeout_seconds,
            )
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise YclientsError("YCLIENTS status request failed") from exc

    def list_records(
        self,
        salon_id: int,
        *,
        start_date: str,
        end_date: str,
        page: int = 1,
        count: int = 100,
    ) -> list[dict[str, Any]]:
        try:
            response = httpx.get(
                f"{self.settings.yclients_api_base_url.rstrip('/')}/api/v1/records/{salon_id}",
                headers=self._user_headers(),
                params={
                    "start_date": start_date,
                    "end_date": end_date,
                    "page": page,
                    "count": count,
                },
                timeout=self.settings.yclients_http_timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise YclientsError("YCLIENTS records request failed") from exc
        data = payload.get("data")
        if not isinstance(data, list):
            raise YclientsError("YCLIENTS returned invalid records data")
        return data

    def list_book_times(self, salon_id: int, staff_id: int, day: str) -> list[str]:
        """Return only times explicitly offered by YCLIENTS online booking.

        This is intentionally not inferred from an empty interval in the local cache:
        an unbooked-looking interval can still be outside of a master's schedule.
        """
        try:
            response = httpx.get(
                f"{self.settings.yclients_api_base_url.rstrip('/')}/api/v1/book_times/"
                f"{salon_id}/{staff_id}/{day}",
                headers=self._user_headers(),
                timeout=self.settings.yclients_http_timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise YclientsError("YCLIENTS free slots request failed") from exc
        data = payload.get("data")
        if not isinstance(data, list):
            raise YclientsError("YCLIENTS returned invalid free slots")
        result: list[str] = []
        for value in data:
            # The studio advertises only appointment windows of one hour or
            # longer.  YCLIENTS provides the duration in seconds for every
            # bookable interval, so discard shorter slots before they can
            # reach the availability-card generator.
            if not isinstance(value, dict):
                continue
            # Some YCLIENTS responses include ``seance_length`` with a null
            # value while the actual duration is provided as ``sum_length``.
            # Treat those records exactly like an omitted seance_length;
            # otherwise valid hour-long windows disappear from the planner.
            duration = value.get("seance_length") or value.get("sum_length")
            try:
                duration_seconds = int(duration)
            except (TypeError, ValueError):
                continue
            if duration_seconds < 60 * 60:
                continue
            candidate = value.get("time")
            if isinstance(candidate, str) and candidate.strip():
                result.append(candidate.strip())
        return result

    def list_clients_by_ids(self, salon_id: int, client_ids: list[int]) -> list[dict[str, Any]]:
        if not client_ids:
            return []
        params: list[tuple[str, str | int]] = [
            ("id[]", client_id) for client_id in client_ids
        ]
        params.extend([("page", 1), ("count", len(client_ids))])
        try:
            response = httpx.get(
                f"{self.settings.yclients_api_base_url.rstrip('/')}/api/v1/clients/{salon_id}",
                headers=self._user_headers(),
                params=params,
                timeout=self.settings.yclients_http_timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise YclientsError("YCLIENTS clients request failed") from exc
        data = payload.get("data")
        if not isinstance(data, list):
            raise YclientsError("YCLIENTS returned invalid clients data")
        return data

    def get_clients_by_ids(self, salon_id: int, client_ids: list[int]) -> list[dict[str, Any]]:
        clients: list[dict[str, Any]] = []
        try:
            with httpx.Client(
                headers=self._user_headers(),
                timeout=self.settings.yclients_http_timeout_seconds,
            ) as http:
                for client_id in client_ids:
                    response = http.get(
                        f"{self.settings.yclients_api_base_url.rstrip('/')}"
                        f"/api/v1/client/{salon_id}/{client_id}"
                    )
                    response.raise_for_status()
                    data = response.json().get("data")
                    if isinstance(data, dict):
                        clients.append(data)
        except (httpx.HTTPError, ValueError) as exc:
            raise YclientsError("YCLIENTS client details request failed") from exc
        return clients


def get_yclients_client(settings: Settings = Depends(get_settings)) -> YclientsClient:
    return YclientsClient(settings)
