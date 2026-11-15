"""Crash-safe state files shared by phone upload endpoints.

Callers hold the session lock before reading, replacing or recovering state.
Storage I/O errors propagate: an unavailable disk is not a corrupt session.
"""
import json
import os
import uuid
from pathlib import Path

from fastapi import HTTPException


def sync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_state(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def recover_state(part: Path, meta: Path) -> None:
    # Preserve the unfinished bytes for diagnosis, without affecting originals
    # or completed database records. The next progress request starts at zero.
    recovered = part.parent / "recovered"
    recovered.mkdir(mode=0o700, exist_ok=True)
    destination = recovered / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    for source in (meta, part, meta.with_suffix(".json.tmp")):
        if source.exists():
            os.replace(source, destination / source.name)
    sync_directory(destination)
    sync_directory(recovered)
    sync_directory(part.parent)


def read_state(part: Path, meta: Path, total: int) -> dict | None:
    if not meta.exists():
        if part.exists():
            recover_state(part, meta)
        return None
    try:
        info = json.loads(meta.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        recover_state(part, meta)
        return None
    if (
        not isinstance(info, dict)
        or type(info.get("total")) is not int
        or info["total"] <= 0
        or not isinstance(info.get("filename"), str)
        or not info["filename"]
    ):
        recover_state(part, meta)
        return None
    if info["total"] != total:
        raise HTTPException(status_code=409, detail="Размер исходного файла изменился")
    if part.exists() and part.stat().st_size > total:
        recover_state(part, meta)
        return None
    return info
