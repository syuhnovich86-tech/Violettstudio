import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from fastapi import UploadFile
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from vita29.db.models import MediaType
from vita29.settings import Settings

register_heif_opener()


class InvalidMediaError(ValueError):
    pass


class FileTooLargeError(ValueError):
    pass


class InsufficientStorageError(OSError):
    pass


class ThumbnailError(OSError):
    pass


@dataclass(frozen=True)
class StoredUpload:
    storage_key: str
    original_name: str
    media_type: MediaType
    mime_type: str
    size_bytes: int
    checksum_sha256: str
    captured_at: datetime | None
    gps_latitude: float | None
    gps_longitude: float | None


def _parse_exif_offset(value: object) -> timezone | None:
    text = str(value or "").strip()
    if len(text) != 6 or text[0] not in "+-" or text[3] != ":":
        return None
    try:
        hours, minutes = int(text[1:3]), int(text[4:6])
    except ValueError:
        return None
    if hours > 23 or minutes > 59:
        return None
    delta = timedelta(hours=hours, minutes=minutes)
    return timezone(delta if text[0] == "+" else -delta)


def extract_capture_datetime(path: Path, local_utc_offset_hours: int) -> datetime | None:
    """Read the photo capture time without exposing any other EXIF metadata."""
    try:
        with Image.open(path) as image:
            exif = image.getexif()
            date_value = exif.get(36867) or exif.get(36868) or exif.get(306)
            offset_value = exif.get(36881) or exif.get(36882) or exif.get(36880)
    except (OSError, ValueError, TypeError):
        return None
    if not date_value:
        return None
    try:
        parsed = datetime.strptime(str(date_value).strip(), "%Y:%m:%d %H:%M:%S")  # noqa: DTZ007
        capture_timezone = _parse_exif_offset(offset_value) or timezone(
            timedelta(hours=local_utc_offset_hours)
        )
        captured = datetime(
            parsed.year,
            parsed.month,
            parsed.day,
            parsed.hour,
            parsed.minute,
            parsed.second,
            tzinfo=capture_timezone,
        )
        return captured.astimezone(UTC)
    except (ValueError, TypeError, KeyError):
        return None


def _gps_degrees(value: object) -> float | None:
    try:
        parts = list(value)  # type: ignore[arg-type]
        if len(parts) != 3:
            return None
        degrees, minutes, seconds = (float(part) for part in parts)
        return degrees + minutes / 60 + seconds / 3600
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def extract_image_gps(path: Path) -> tuple[float | None, float | None]:
    try:
        with Image.open(path) as image:
            exif = image.getexif()
            gps = exif.get_ifd(34853)
    except (OSError, ValueError, TypeError, KeyError):
        return None, None
    latitude = _gps_degrees(gps.get(2))
    longitude = _gps_degrees(gps.get(4))
    if latitude is None or longitude is None:
        return None, None
    if str(gps.get(1, "N")).upper() == "S":
        latitude = -latitude
    if str(gps.get(3, "E")).upper() == "W":
        longitude = -longitude
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None, None
    return latitude, longitude


_ISO6709_RE = re.compile(
    r"(?P<latitude>[+-]\d{2}(?:\.\d+)?)"
    r"(?P<longitude>[+-]\d{3}(?:\.\d+)?)"
)


def extract_video_metadata(path: Path) -> tuple[datetime | None, float | None, float | None]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format_tags=creation_time,location,com.apple.quicktime.location.ISO6709",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            check=True,
            text=True,
            timeout=30,
        )
        tags = json.loads(result.stdout).get("format", {}).get("tags", {})
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, AttributeError):
        return None, None, None

    captured_at = None
    creation_time = tags.get("creation_time")
    if creation_time:
        try:
            captured_at = datetime.fromisoformat(str(creation_time))
            if captured_at.tzinfo is None:
                captured_at = captured_at.replace(tzinfo=UTC)
            captured_at = captured_at.astimezone(UTC)
        except ValueError:
            captured_at = None

    location = tags.get("com.apple.quicktime.location.ISO6709") or tags.get("location") or ""
    match = _ISO6709_RE.search(str(location))
    if not match:
        return captured_at, None, None
    latitude = float(match.group("latitude"))
    longitude = float(match.group("longitude"))
    return captured_at, latitude, longitude


def extract_media_metadata(
    path: Path,
    media_type: MediaType,
    local_utc_offset_hours: int,
) -> tuple[datetime | None, float | None, float | None]:
    if media_type == MediaType.IMAGE:
        captured_at = extract_capture_datetime(path, local_utc_offset_hours)
        latitude, longitude = extract_image_gps(path)
        return captured_at, latitude, longitude
    return extract_video_metadata(path)


def identify_media(header: bytes) -> tuple[MediaType, str]:
    if header.startswith(b"\xff\xd8\xff"):
        return MediaType.IMAGE, "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return MediaType.IMAGE, "image/png"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return MediaType.IMAGE, "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return MediaType.IMAGE, "image/webp"
    if header.startswith(b"\x1aE\xdf\xa3"):
        return MediaType.VIDEO, "video/webm"
    if header.startswith(b"OggS"):
        return MediaType.VIDEO, "video/ogg"
    if header.startswith(b"RIFF") and header[8:12] == b"AVI ":
        return MediaType.VIDEO, "video/x-msvideo"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brand = header[8:12]
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return MediaType.IMAGE, "image/heic"
        if brand in {b"avif", b"avis"}:
            return MediaType.IMAGE, "image/avif"
        if brand == b"qt  ":
            return MediaType.VIDEO, "video/quicktime"
        if brand[:3] == b"3gp":
            return MediaType.VIDEO, "video/3gpp"
        return MediaType.VIDEO, "video/mp4"
    raise InvalidMediaError("Only supported photos and videos can be uploaded")


def safe_original_name(filename: str | None) -> str:
    name = Path(filename or "media").name.strip().replace("\x00", "")
    return name[:255] or "media"


def store_upload(upload: UploadFile, owner_id: str, settings: Settings) -> StoredUpload:
    now = datetime.now(UTC)
    file_id = str(uuid.uuid4())
    relative_dir = Path(owner_id) / f"{now:%Y}" / f"{now:%m}"
    storage_key = (relative_dir / file_id).as_posix()
    target_dir = settings.originals_path / relative_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    temporary_path = target_dir / f".{file_id}.upload"
    final_path = settings.originals_path / Path(storage_key)

    digest = hashlib.sha256()
    size = 0
    header = b""
    try:
        with temporary_path.open("xb") as output:
            while chunk := upload.file.read(settings.upload_chunk_bytes):
                if size == 0:
                    header = chunk[:32]
                size += len(chunk)
                if size > settings.max_file_bytes:
                    raise FileTooLargeError("File exceeds the configured size limit")
                if shutil.disk_usage(target_dir).free - len(chunk) < settings.minimum_free_bytes:
                    raise InsufficientStorageError("Not enough free storage")
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if size == 0:
            raise InvalidMediaError("Empty files cannot be uploaded")
        media_type, mime_type = identify_media(header)
        captured_at, gps_latitude, gps_longitude = extract_media_metadata(
            temporary_path,
            media_type,
            settings.local_utc_offset_hours,
        )
        os.replace(temporary_path, final_path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    finally:
        upload.file.close()

    return StoredUpload(
        storage_key=storage_key,
        original_name=safe_original_name(upload.filename),
        media_type=media_type,
        mime_type=mime_type,
        size_bytes=size,
        checksum_sha256=digest.hexdigest(),
        captured_at=captured_at,
        gps_latitude=gps_latitude,
        gps_longitude=gps_longitude,
    )


def original_path(settings: Settings, storage_key: str) -> Path:
    root = settings.originals_path.resolve()
    path = (root / storage_key).resolve()
    if not path.is_relative_to(root):
        raise InvalidMediaError("Invalid storage path")
    return path


def move_original(
    settings: Settings,
    storage_key: str,
    destination_workspace_id: str,
    created_at: datetime,
) -> str:
    source = original_path(settings, storage_key)
    if not source.is_file():
        raise FileNotFoundError("Stored file not found")
    relative_dir = Path(destination_workspace_id) / f"{created_at:%Y}" / f"{created_at:%m}"
    destination_key = (relative_dir / source.name).as_posix()
    destination = original_path(settings, destination_key)
    if destination.exists():
        raise FileExistsError("Destination file already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)
    return destination_key


def restore_moved_original(
    settings: Settings,
    current_storage_key: str,
    previous_storage_key: str,
) -> None:
    current = original_path(settings, current_storage_key)
    previous = original_path(settings, previous_storage_key)
    previous.parent.mkdir(parents=True, exist_ok=True)
    if current.is_file():
        os.replace(current, previous)


def move_to_trash(settings: Settings, storage_key: str, file_id: str) -> Path | None:
    source = original_path(settings, storage_key)
    target = settings.trash_path / file_id
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        os.replace(source, target)
        return target
    return None


def restore_from_trash(settings: Settings, storage_key: str, trash_path: Path) -> None:
    target = original_path(settings, storage_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    if trash_path.is_file():
        os.replace(trash_path, target)


def thumbnail_path(settings: Settings, file_id: str) -> Path:
    return settings.previews_path / f"{file_id}.jpg"


def create_thumbnail(settings: Settings, storage_key: str, file_id: str) -> Path:
    target = thumbnail_path(settings, file_id)
    if target.is_file():
        return target
    source = original_path(settings, storage_key)
    temporary = target.with_suffix(".jpg.tmp")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source) as image:
            image.seek(0)
            normalized = ImageOps.exif_transpose(image).convert("RGB")
            normalized.thumbnail((720, 720), Image.Resampling.LANCZOS)
            normalized.save(temporary, format="JPEG", quality=82, optimize=True)
        os.replace(temporary, target)
        return target
    except (OSError, ValueError) as error:
        temporary.unlink(missing_ok=True)
        raise ThumbnailError("Could not create thumbnail") from error


def create_video_thumbnail(settings: Settings, storage_key: str, file_id: str) -> Path:
    target = thumbnail_path(settings, file_id)
    if target.is_file():
        return target
    source = original_path(settings, storage_key)
    temporary = target.with_suffix(".jpg.tmp")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "0.1",
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                "scale=720:720:force_original_aspect_ratio=decrease",
                "-q:v",
                "4",
                "-f",
                "image2",
                "-y",
                str(temporary),
            ],
            check=True,
            timeout=45,
        )
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise ThumbnailError("Could not create video thumbnail")
        os.replace(temporary, target)
        return target
    except (OSError, subprocess.SubprocessError) as error:
        temporary.unlink(missing_ok=True)
        raise ThumbnailError("Could not create video thumbnail") from error
