"""Publish a vertical image/video as a regular MAX channel post.

MAX currently documents channel posts with media, but does not expose a public
story endpoint. This is therefore a normal channel post, not a MAX story.

Requirements:
  pip install httpx
  set MAX_API_TOKEN and MAX_CHANNEL_ID
  python publish_max_channel_post.py ./vertical.jpg "Caption"
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx


BASE_URL = "https://platform-api2.max.ru"


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python publish_max_channel_post.py FILE [CAPTION]")
    token = os.environ["MAX_API_TOKEN"]
    channel_id = os.environ["MAX_CHANNEL_ID"]
    file_path = Path(sys.argv[1]).resolve()
    caption = sys.argv[2] if len(sys.argv) > 2 else ""
    if not file_path.is_file():
        raise SystemExit(f"File not found: {file_path}")
    media_type = "video" if file_path.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"} else "image"
    headers = {"Authorization": token}

    with httpx.Client(timeout=180) as client:
        # 1. Ask MAX for a dedicated upload URL and reusable attachment token.
        upload = client.post(f"{BASE_URL}/uploads", params={"type": media_type}, headers=headers)
        upload.raise_for_status()
        upload_info = upload.json()
        with file_path.open("rb") as handle:
            uploaded = client.post(upload_info["url"], files={"data": (file_path.name, handle)})
        uploaded.raise_for_status()

        # Large files may take time to process; retry publication with a backoff.
        payload = {
            "text": caption[:4000],
            "attachments": [{"type": media_type, "payload": {"token": upload_info["token"]}}],
        }
        for wait in (3, 6, 12, 20):
            sent = client.post(f"{BASE_URL}/messages", params={"chat_id": channel_id}, headers={**headers, "Content-Type": "application/json"}, json=payload)
            if sent.status_code < 400:
                print(sent.json())
                return
            if "attachment.not.ready" not in sent.text:
                sent.raise_for_status()
            time.sleep(wait)
    raise SystemExit("MAX is still processing the file; try publishing again shortly.")


if __name__ == "__main__":
    main()
