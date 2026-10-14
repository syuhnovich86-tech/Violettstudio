from __future__ import annotations

import json
import os
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

from vita29.media.storage import original_path
from vita29.settings import Settings

DIRECT_SHARE_LIMIT_BYTES = 48 * 1024 * 1024
TARGET_SHARE_BYTES = 42 * 1024 * 1024


@dataclass
class ShareVideoStatus:
    state: str
    progress: int = 0
    size_bytes: int | None = None
    error: str | None = None
    uses_original: bool = False


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-share")
_jobs: dict[str, ShareVideoStatus] = {}
_jobs_lock = threading.Lock()


def share_video_path(settings: Settings, file_id: str) -> Path:
    return settings.previews_path / "share" / f"{file_id}.mp4"


def _probe(source: Path) -> tuple[float, str | None, list[str]]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name:stream=codec_name,codec_type",
            "-of",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=45,
    )
    payload = json.loads(result.stdout)
    duration = float(payload.get("format", {}).get("duration") or 0)
    video_codec = next(
        (
            stream.get("codec_name")
            for stream in payload.get("streams", [])
            if stream.get("codec_type") == "video"
        ),
        None,
    )
    audio_codecs = [
        stream.get("codec_name")
        for stream in payload.get("streams", [])
        if stream.get("codec_type") == "audio"
    ]
    return duration, video_codec, audio_codecs


def _can_share_original(source: Path, video_codec: str | None, audio_codecs: list[str]) -> bool:
    return (
        source.stat().st_size <= DIRECT_SHARE_LIMIT_BYTES
        and video_codec == "h264"
        and all(codec == "aac" for codec in audio_codecs)
    )


def _set_job(file_id: str, **changes: object) -> ShareVideoStatus:
    with _jobs_lock:
        current = _jobs[file_id]
        for key, value in changes.items():
            setattr(current, key, value)
        return ShareVideoStatus(**asdict(current))


def _transcode(
    settings: Settings,
    storage_key: str,
    file_id: str,
    duration: float,
) -> None:
    source = original_path(settings, storage_key)
    target = share_video_path(settings, file_id)
    temporary = target.with_name(f".{file_id}.tmp.mp4")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary.unlink(missing_ok=True)

    duration = max(duration, 1.0)
    target_video_bitrate = int((TARGET_SHARE_BYTES * 8 / duration) - 160_000)
    target_video_bitrate = max(900_000, min(6_000_000, target_video_bitrate))
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        "scale='if(gt(iw,ih),min(iw,1920),-2)':'if(gt(iw,ih),-2,min(ih,1920))'",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        str(target_video_bitrate),
        "-maxrate",
        str(int(target_video_bitrate * 1.15)),
        "-bufsize",
        str(target_video_bitrate * 2),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        "-y",
        str(temporary),
    ]

    try:
        _set_job(file_id, state="processing", progress=1)
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if process.stdout is None:
            raise RuntimeError("Could not read video conversion progress")
        for line in process.stdout:
            key, separator, value = line.strip().partition("=")
            if separator and key in {"out_time_us", "out_time_ms"}:
                try:
                    elapsed = int(value) / 1_000_000
                except ValueError:
                    continue
                _set_job(file_id, progress=max(1, min(99, round(elapsed / duration * 100))))
        _, stderr = process.communicate()
        if process.returncode != 0:
            raise RuntimeError(stderr.strip() or "ffmpeg failed")
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise RuntimeError("Prepared video is empty")
        os.replace(temporary, target)
        _set_job(
            file_id,
            state="ready",
            progress=100,
            size_bytes=target.stat().st_size,
        )
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        temporary.unlink(missing_ok=True)
        _set_job(file_id, state="error", progress=0, error=str(error)[:500])


def prepare_share_video(
    settings: Settings,
    storage_key: str,
    file_id: str,
) -> ShareVideoStatus:
    source = original_path(settings, storage_key)
    target = share_video_path(settings, file_id)
    if target.is_file() and target.stat().st_size > 0:
        status = ShareVideoStatus("ready", 100, target.stat().st_size)
        with _jobs_lock:
            _jobs[file_id] = status
        return ShareVideoStatus(**asdict(status))

    with _jobs_lock:
        existing = _jobs.get(file_id)
        if existing is not None and existing.state in {"pending", "processing"}:
            return ShareVideoStatus(**asdict(existing))

    try:
        duration, video_codec, audio_codecs = _probe(source)
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        status = ShareVideoStatus("error", error=f"Could not inspect video: {error}")
        with _jobs_lock:
            _jobs[file_id] = status
        return ShareVideoStatus(**asdict(status))

    if _can_share_original(source, video_codec, audio_codecs):
        status = ShareVideoStatus("ready", 100, source.stat().st_size, uses_original=True)
        with _jobs_lock:
            _jobs[file_id] = status
        return ShareVideoStatus(**asdict(status))

    status = ShareVideoStatus("pending", 0)
    with _jobs_lock:
        _jobs[file_id] = status
    _executor.submit(_transcode, settings, storage_key, file_id, duration)
    return ShareVideoStatus(**asdict(status))


def get_share_video_status(settings: Settings, file_id: str) -> ShareVideoStatus:
    target = share_video_path(settings, file_id)
    if target.is_file() and target.stat().st_size > 0:
        return ShareVideoStatus("ready", 100, target.stat().st_size)
    with _jobs_lock:
        status = _jobs.get(file_id)
        if status is None:
            return ShareVideoStatus("not_started")
        return ShareVideoStatus(**asdict(status))


def get_prepared_share_video(
    settings: Settings,
    storage_key: str,
    file_id: str,
) -> Path | None:
    target = share_video_path(settings, file_id)
    if target.is_file() and target.stat().st_size > 0:
        return target
    with _jobs_lock:
        status = _jobs.get(file_id)
        if status is None or status.state != "ready" or not status.uses_original:
            return None
    source = original_path(settings, storage_key)
    return source if source.is_file() else None


def remove_share_video(settings: Settings, file_id: str) -> None:
    share_video_path(settings, file_id).unlink(missing_ok=True)
    with _jobs_lock:
        _jobs.pop(file_id, None)
