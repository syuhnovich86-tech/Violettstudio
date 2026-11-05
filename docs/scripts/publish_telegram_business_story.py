"""Publish one photo/video story through the official Telegram Bot API.

Requirements:
  pip install httpx
  set TELEGRAM_BOT_TOKEN and TELEGRAM_BUSINESS_CONNECTION_ID
  python publish_telegram_business_story.py ./story.jpg "Short caption"

This is for a Telegram *business account connected to the bot*, not for a
channel. The bot must have the can_manage_stories business right.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python publish_telegram_business_story.py FILE [CAPTION]")
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    connection_id = os.environ["TELEGRAM_BUSINESS_CONNECTION_ID"]
    file_path = Path(sys.argv[1]).resolve()
    caption = sys.argv[2] if len(sys.argv) > 2 else ""
    if not file_path.is_file():
        raise SystemExit(f"File not found: {file_path}")

    is_video = file_path.suffix.lower() in {".mp4", ".mov"}
    attachment_name = "story"
    content = {
        "type": "video" if is_video else "photo",
        "video" if is_video else "photo": f"attach://{attachment_name}",
    }
    if is_video:
        content["duration"] = 15

    # Telegram: photo 1080x1920 <= 10 MB; video 720x1280/H.265 <= 30 MB, 0-60 sec.
    with file_path.open("rb") as handle, httpx.Client(timeout=120) as client:
        response = client.post(
            f"https://api.telegram.org/bot{token}/postStory",
            data={
                "business_connection_id": connection_id,
                "content": json.dumps(content),
                "active_period": 86400,
                "caption": caption[:2048],
                "post_to_chat_page": "true",
            },
            files={attachment_name: (file_path.name, handle, "video/mp4" if is_video else "image/jpeg")},
        )
    response.raise_for_status()
    result = response.json()
    if not result.get("ok"):
        raise SystemExit(result.get("description", "Telegram rejected the story"))
    print(json.dumps(result["result"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
