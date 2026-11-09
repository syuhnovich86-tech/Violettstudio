"""Resumable iOS originals; each acknowledged part is durable before replying."""
import json
import os
import shutil
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from vita29.api.media import _scoped_android_import_key, get_accessible_workspace, media_response, upload_media
from vita29.auth.dependencies import get_current_user, require_csrf
from vita29.db.models import AuthSession, MediaFile, User
from vita29.db.session import get_db
from vita29.settings import Settings, get_settings

try:
    import fcntl
except ImportError:  # Windows development tests use the in-process lock.
    fcntl = None

router = APIRouter(prefix='/media/android-import', tags=['ios import'])
MAX_FILE = 2 * 1024 * 1024 * 1024 * 1024
MAX_CHUNK = 4 * 1024 * 1024
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def paths(settings: Settings, key: str) -> tuple[Path, Path, Path, Path]:
    root = settings.media_root / 'android-import-sessions'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root / f'{key}.part', root / f'{key}.json', root / f'{key}.done', root / f'{key}.lock'


@contextmanager
def locked(path: Path):
    with _locks_guard:
        local = _locks.setdefault(str(path), threading.Lock())
    with local, path.open('a+b') as handle:
        if fcntl:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def authorized_key(request: Request, user: User, db: Session, settings: Settings, workspace_id: str) -> str:
    return _scoped_android_import_key(request, user, get_accessible_workspace(db, workspace_id, user), settings)


def completed(db: Session, key: str, workspace_id: str, marker: Path) -> MediaFile | None:
    item = db.scalar(select(MediaFile).where(MediaFile.ios_import_key == key, MediaFile.deleted_at.is_(None)))
    if item is None and marker.exists():
        try:
            marker_id = json.loads(marker.read_text(encoding='utf-8'))['media_id']
            item = db.get(MediaFile, marker_id)
        except (OSError, ValueError, KeyError, TypeError):
            item = None
    return item if item is not None and item.workspace_id == workspace_id and item.deleted_at is None else None


def read_progress(db: Session, settings: Settings, key: str, workspace_id: str, total: int) -> dict:
    part, meta, marker, lock = paths(settings, key)
    with locked(lock):
        if completed(db, key, workspace_id, marker):
            return {'exists': True, 'offset': total}
        if meta.exists():
            try:
                info = json.loads(meta.read_text(encoding='utf-8'))
                if info['total'] != total:
                    raise HTTPException(status_code=409, detail='Размер исходного файла изменился')
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise HTTPException(status_code=409, detail='Повреждено состояние передачи') from error
        size = part.stat().st_size if part.exists() else 0
        if size > total:
            raise HTTPException(status_code=409, detail='Повреждено состояние передачи')
        return {'exists': False, 'offset': size}


@router.get('/progress')
def progress(request: Request, user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)], settings: Annotated[Settings, Depends(get_settings)], workspace_id: str, total: Annotated[int, Query(gt=0, le=MAX_FILE)]) -> dict:
    key = authorized_key(request, user, db, settings, workspace_id)
    return read_progress(db, settings, key, workspace_id, total)


def append_chunk(request: Request, user: User, db: Session, settings: Settings, workspace_id: str, total: int, offset: int, data: bytes) -> dict:
    key = authorized_key(request, user, db, settings, workspace_id)
    part, meta, marker, lock = paths(settings, key)
    with locked(lock):
        db.refresh(user)
        authorized_key(request, user, db, settings, workspace_id)
        if completed(db, key, workspace_id, marker):
            return {'exists': True, 'offset': total}
        if meta.exists():
            try:
                info = json.loads(meta.read_text(encoding='utf-8'))
                if info['total'] != total:
                    raise HTTPException(status_code=409, detail='Размер исходного файла изменился')
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise HTTPException(status_code=409, detail='Повреждено состояние передачи') from error
        else:
            name = unquote(request.headers.get('x-android-filename', 'iphone-original'))[:255]
            temporary = meta.with_suffix('.json.tmp')
            temporary.write_text(json.dumps({'total': total, 'filename': name}, ensure_ascii=False), encoding='utf-8')
            os.replace(temporary, meta)
        current = part.stat().st_size if part.exists() else 0
        if current != offset:
            raise HTTPException(status_code=409, detail=f'Смещение изменилось: {current}')
        if not data or offset + len(data) > total:
            raise HTTPException(status_code=400, detail='Недопустимая часть файла')
        if shutil.disk_usage(part.parent).free - len(data) < settings.minimum_free_bytes:
            raise HTTPException(status_code=507, detail='Недостаточно места на сервере')
        with part.open('ab') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return {'exists': False, 'offset': current + len(data)}


@router.put('/chunk')
async def chunk(request: Request, _: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)], settings: Annotated[Settings, Depends(get_settings)], workspace_id: str, total: Annotated[int, Query(gt=0, le=MAX_FILE)], offset: Annotated[int, Query(ge=0)]) -> dict:
    authorized_key(request, user, db, settings, workspace_id)
    data = bytearray()
    async for piece in request.stream():
        data.extend(piece)
        if len(data) > MAX_CHUNK:
            raise HTTPException(status_code=413, detail='Часть файла слишком большая')
    return await run_in_threadpool(append_chunk, request, user, db, settings, workspace_id, total, offset, bytes(data))


@router.post('/complete')
def complete(request: Request, auth: Annotated[AuthSession, Depends(require_csrf)], user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)], settings: Annotated[Settings, Depends(get_settings)], workspace_id: str, total: Annotated[int, Query(gt=0, le=MAX_FILE)]) -> dict:
    key = authorized_key(request, user, db, settings, workspace_id)
    part, meta, marker, lock = paths(settings, key)
    with locked(lock):
        db.refresh(user)
        authorized_key(request, user, db, settings, workspace_id)
        previous = completed(db, key, workspace_id, marker)
        if previous:
            return {'exists': True, 'media_id': previous.id}
        if not part.exists() or not meta.exists() or part.stat().st_size != total:
            raise HTTPException(status_code=409, detail='Передача файла ещё не завершена')
        try:
            info = json.loads(meta.read_text(encoding='utf-8'))
            if info['total'] != total:
                raise HTTPException(status_code=409, detail='Размер исходного файла изменился')
            filename = info['filename']
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=409, detail='Повреждено состояние передачи') from error
        with part.open('rb') as source:
            result = upload_media(request, auth, user, db, settings.model_copy(update={'max_file_bytes': MAX_FILE}), UploadFile(file=source, filename=filename), workspace_id, False, None, None)
        temporary = marker.with_suffix('.done.tmp')
        temporary.write_text(json.dumps({'media_id': result.id}), encoding='utf-8')
        os.replace(temporary, marker)
        part.unlink(missing_ok=True)
        meta.unlink(missing_ok=True)
        return {'exists': True, 'media_id': result.id}
