"""Self-hosted Expo Updates v1 endpoint for the studio mobile application."""

import base64
import hashlib
import json
import mimetypes
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response

from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/mobile/updates", tags=["mobile updates"])
SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")


def _headers() -> dict[str, str]:
    return {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0, must-revalidate",
    }


def _safe_segment(value: str, label: str) -> str:
    if not SAFE_SEGMENT.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"Invalid {label}")
    return value


def _latest_update(settings: Settings, runtime_version: str) -> Path:
    runtime_dir = settings.mobile_updates_root / _safe_segment(runtime_version, "runtime version")
    if not runtime_dir.is_dir():
        raise HTTPException(status_code=404, detail="No update for this runtime")
    updates = sorted((path for path in runtime_dir.iterdir() if path.is_dir()), key=lambda path: path.name, reverse=True)
    if not updates:
        raise HTTPException(status_code=404, detail="No update for this runtime")
    return updates[0]


def _read_metadata(update_dir: Path) -> tuple[dict[str, Any], bytes, Path]:
    metadata_path = update_dir / "metadata.json"
    try:
        raw = metadata_path.read_bytes()
        metadata = json.loads(raw)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail="Published update metadata is invalid") from error
    return metadata, raw, metadata_path


def _update_id(metadata_raw: bytes) -> str:
    return str(UUID(hex=hashlib.sha256(metadata_raw).hexdigest()[:32]))


def _asset(update_dir: Path, relative_path: str, extension: str | None, *, launch: bool, settings: Settings, runtime_version: str, platform: str) -> dict[str, str]:
    file_path = (update_dir / relative_path).resolve()
    try:
        file_path.relative_to(update_dir.resolve())
        payload = file_path.read_bytes()
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail="Published update asset is missing") from error
    sha256 = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode("ascii").rstrip("=")
    key = hashlib.md5(payload).hexdigest()
    ext = "bundle" if launch else (extension or file_path.suffix.lstrip(".") or "bin")
    content_type = "application/javascript" if launch else (mimetypes.guess_type(f"file.{ext}")[0] or "application/octet-stream")
    public_root = settings.yclients_public_base_url.rstrip("/")
    update_name = quote(update_dir.name, safe="")
    asset_path = quote(relative_path, safe="")
    return {
        "hash": sha256,
        "key": key,
        "fileExtension": f".{ext}",
        "contentType": content_type,
        "url": f"{public_root}/api/v1/mobile/updates/assets/{quote(runtime_version, safe='')}/{update_name}/{platform}?path={asset_path}",
    }


@router.get("/manifest")
def manifest(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    expo_platform: Annotated[str | None, Header(alias="expo-platform")] = None,
    expo_runtime_version: Annotated[str | None, Header(alias="expo-runtime-version")] = None,
    expo_current_update_id: Annotated[str | None, Header(alias="expo-current-update-id")] = None,
) -> Response:
    _ = request
    if expo_platform not in {"android", "ios"}:
        raise HTTPException(status_code=400, detail="Unsupported platform")
    if not expo_runtime_version:
        raise HTTPException(status_code=400, detail="Missing runtime version")
    update_dir = _latest_update(settings, expo_runtime_version)
    metadata, raw, metadata_path = _read_metadata(update_dir)
    identifier = _update_id(raw)
    if expo_current_update_id == identifier:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=_headers())
    try:
        platform_metadata = metadata["fileMetadata"][expo_platform]
        assets = platform_metadata["assets"]
        bundle = platform_metadata["bundle"]
    except (KeyError, TypeError) as error:
        raise HTTPException(status_code=500, detail="Published update does not support this platform") from error
    config_path = update_dir / "expoConfig.json"
    expo_config = json.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
    body = {
        "id": identifier,
        "createdAt": datetime.fromtimestamp(metadata_path.stat().st_mtime, tz=UTC).isoformat(),
        "runtimeVersion": expo_runtime_version,
        "launchAsset": _asset(update_dir, bundle, None, launch=True, settings=settings, runtime_version=expo_runtime_version, platform=expo_platform),
        "assets": [
            _asset(update_dir, item["path"], item.get("ext"), launch=False, settings=settings, runtime_version=expo_runtime_version, platform=expo_platform)
            for item in assets
        ],
        "metadata": {},
        "extra": {"expoClient": expo_config},
    }
    return JSONResponse(body, media_type="application/expo+json", headers=_headers())


@router.get("/assets/{runtime_version}/{update_name}/{platform}")
def asset(
    runtime_version: str,
    update_name: str,
    platform: str,
    path: Annotated[str, Query(min_length=1, max_length=1000)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> FileResponse:
    if platform not in {"android", "ios"}:
        raise HTTPException(status_code=400, detail="Unsupported platform")
    runtime_dir = settings.mobile_updates_root / _safe_segment(runtime_version, "runtime version")
    update_dir = runtime_dir / _safe_segment(update_name, "update")
    metadata, _, _ = _read_metadata(update_dir)
    try:
        platform_metadata = metadata["fileMetadata"][platform]
        allowed = {platform_metadata["bundle"], *(item["path"] for item in platform_metadata["assets"])}
    except (KeyError, TypeError) as error:
        raise HTTPException(status_code=404, detail="Asset not found") from error
    if path not in allowed:
        raise HTTPException(status_code=404, detail="Asset not found")
    file_path = (update_dir / path).resolve()
    try:
        file_path.relative_to(update_dir.resolve())
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Asset not found") from error
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    asset_metadata = next((item for item in platform_metadata["assets"] if item["path"] == path), None)
    media_type = (
        "application/javascript"
        if path == platform_metadata["bundle"]
        else mimetypes.guess_type(f"file.{asset_metadata.get('ext', 'bin') if asset_metadata else 'bin'}")[0]
        or "application/octet-stream"
    )
    return FileResponse(file_path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})
