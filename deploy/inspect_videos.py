import json
import sqlite3
import subprocess
from pathlib import Path

database = sqlite3.connect("/data/app/vita29.db")
database.row_factory = sqlite3.Row
rows = database.execute(
    "SELECT id, original_name, mime_type, size_bytes, storage_key "
    "FROM media_files WHERE media_type = 'VIDEO' AND deleted_at IS NULL "
    "ORDER BY created_at DESC LIMIT 10"
).fetchall()
for row in rows:
    path = Path("/data/media/originals") / row["storage_key"]
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration", "-show_entries", "stream=codec_name,codec_type,pix_fmt", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    print(json.dumps({**dict(row), "exists": path.is_file(), "probe": json.loads(probe.stdout or "{}")}, ensure_ascii=False))
