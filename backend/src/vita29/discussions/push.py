import base64
import json
from pathlib import Path

def public_vapid_key(private_key_file: Path) -> str | None:
    if not private_key_file.is_file():
        return None
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        PublicFormat,
        load_pem_private_key,
    )

    private_key = load_pem_private_key(private_key_file.read_bytes(), password=None)
    public_bytes = private_key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")


def send_push_notifications(
    subscriptions: list[dict[str, str]],
    payload: dict[str, str],
    private_key_file: Path,
    subject: str,
) -> None:
    if not private_key_file.is_file():
        return
    from pywebpush import WebPushException, webpush

    data = json.dumps(payload, ensure_ascii=False)
    for subscription in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription["endpoint"],
                    "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
                },
                data=data,
                vapid_private_key=str(private_key_file),
                vapid_claims={"sub": subject},
                ttl=3600,
                timeout=8,
            )
        except WebPushException:
            continue
