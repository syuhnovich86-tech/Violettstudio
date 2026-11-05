import hashlib
import json
import os
import shutil
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from vita29.db.models import AuditLog, MediaFile, User, Workspace, WorkspaceKind
from vita29.db.session import SessionLocal
from vita29.media.places import OfflinePlaceResolver
from vita29.media.storage import extract_media_metadata, identify_media, safe_original_name
from vita29.settings import Settings, get_settings

IGNORED_DIRECTORIES = {".duplicates", ".errors"}


def _copy_and_hash(source: Path, temporary: Path, chunk_size: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    temporary.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, temporary.open("xb") as output_file:
        while chunk := input_file.read(chunk_size):
            output_file.write(chunk)
            digest.update(chunk)
            size += len(chunk)
        output_file.flush()
        os.fsync(output_file.fileno())
    return size, digest.hexdigest()


class IphoneImporter:
    def __init__(self, settings: Settings, session_factory: Any = SessionLocal):
        self.settings = settings
        self.session_factory = session_factory
        self.places = OfflinePlaceResolver(settings.geonames_cities_path)

    def _target(self):
        with self.session_factory() as db:
            user = db.scalar(select(User).where(User.login == self.settings.import_owner_login))
            if user is None:
                raise RuntimeError("Import owner is not configured")
            workspace = db.scalar(
                select(Workspace).where(
                    Workspace.owner_id == user.id,
                    Workspace.kind == WorkspaceKind.PRIVATE,
                    Workspace.display_name == self.settings.import_workspace_name,
                )
            )
            if workspace is None:
                raise RuntimeError("Import workspace is not configured")
            return user.id, workspace.id

    def _quarantine(self, source: Path, category: str, reason: str | None = None) -> None:
        relative = source.relative_to(self.settings.import_root)
        destination = self.settings.import_root / category / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination = destination.with_name(f"{uuid.uuid4()}-{destination.name}")
        shutil.move(str(source), str(destination))
        if reason:
            destination.with_suffix(destination.suffix + ".txt").write_text(
                reason[:4000], encoding="utf-8"
            )

    def import_file(self, source: Path, owner_id: str, workspace_id: str) -> str:
        before = source.stat()
        if time.time() - before.st_mtime < self.settings.import_stability_seconds:
            return "waiting"
        with source.open("rb") as input_file:
            header = input_file.read(32)
        media_type, mime_type = identify_media(header)
        captured_at, latitude, longitude = extract_media_metadata(
            source,
            media_type,
            self.settings.local_utc_offset_hours,
        )
        captured_at = captured_at or datetime.fromtimestamp(before.st_mtime, UTC)
        country, city, location_key = self.places.resolve(latitude, longitude)
        file_id = str(uuid.uuid4())
        storage_key = (
            Path(workspace_id)
            / f"{captured_at:%Y}"
            / f"{captured_at:%m}"
            / file_id
        ).as_posix()
        destination = self.settings.originals_path / storage_key
        temporary = destination.with_name(f".{file_id}.import")
        try:
            size, checksum = _copy_and_hash(
                source, temporary, self.settings.upload_chunk_bytes
            )
            after = source.stat()
            if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                temporary.unlink(missing_ok=True)
                return "waiting"
            with self.session_factory() as db:
                duplicate = db.scalar(
                    select(MediaFile.id).where(
                        MediaFile.workspace_id == workspace_id,
                        MediaFile.deleted_at.is_(None),
                        MediaFile.size_bytes == size,
                        MediaFile.checksum_sha256 == checksum,
                    )
                )
                if duplicate is not None:
                    temporary.unlink(missing_ok=True)
                    self._quarantine(source, ".duplicates")
                    return "duplicate"
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(temporary, destination)
                media = MediaFile(
                    id=file_id,
                    owner_id=owner_id,
                    workspace_id=workspace_id,
                    uploaded_by_id=owner_id,
                    storage_key=storage_key,
                    original_name=safe_original_name(source.name),
                    media_type=media_type,
                    mime_type=mime_type,
                    size_bytes=size,
                    checksum_sha256=checksum,
                    captured_at=captured_at,
                    gps_latitude=latitude,
                    gps_longitude=longitude,
                    location_country=country,
                    location_city=city,
                    location_key=location_key,
                    publication_allowed=False,
                )
                db.add(media)
                db.add(
                    AuditLog(
                        actor_id=owner_id,
                        action="media.import.iphone",
                        target_type="media_file",
                        target_id=file_id,
                        details=json.dumps(
                            {
                                "source": source.name,
                                "workspace_id": workspace_id,
                                "size_bytes": size,
                                "has_gps": latitude is not None,
                            },
                            ensure_ascii=False,
                        ),
                    )
                )
                try:
                    db.commit()
                except Exception:
                    db.rollback()
                    destination.unlink(missing_ok=True)
                    raise
            source.unlink()
            return "imported"
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def scan_once(self) -> dict[str, int]:
        self.settings.import_root.mkdir(parents=True, exist_ok=True)
        owner_id, workspace_id = self._target()
        result = {"imported": 0, "duplicate": 0, "waiting": 0, "error": 0}
        files = sorted(
            path
            for path in self.settings.import_root.rglob("*")
            if path.is_file()
            and not path.name.startswith(".")
            and not any(part in IGNORED_DIRECTORIES for part in path.parts)
        )
        for source in files:
            try:
                outcome = self.import_file(source, owner_id, workspace_id)
                result[outcome] += 1
            except Exception as error:  # noqa: BLE001 - quarantine every per-file failure
                result["error"] += 1
                try:
                    self._quarantine(source, ".errors", str(error))
                except OSError:
                    pass
        return result


def main() -> None:
    settings = get_settings()
    importer = IphoneImporter(settings)
    while True:
        try:
            print(json.dumps(importer.scan_once(), ensure_ascii=False), flush=True)
        except Exception as error:  # noqa: BLE001 - keep the long-running importer alive
            print(json.dumps({"fatal": str(error)}, ensure_ascii=False), flush=True)
        time.sleep(settings.import_scan_seconds)


if __name__ == "__main__":
    main()
