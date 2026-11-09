import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from vita29.api.auth import router as auth_router
from vita29.api.content import router as content_router
from vita29.api.content_analytics import router as content_analytics_router
from vita29.api.discussions import router as discussions_router
from vita29.api.health import router as health_router
from vita29.api.integrations import router as integrations_router
from vita29.api.telegram_story_login import router as telegram_story_login_router
from vita29.api.max_story_login import router as max_story_login_router
from vita29.api.media import router as media_router
from vita29.api.android_import_chunks import router as android_import_chunks_router
from vita29.api.mobile_auth import router as mobile_auth_router
from vita29.api.mobile_updates import router as mobile_updates_router
from vita29.api.mobile_push import router as mobile_push_router
from vita29.api.public_media import router as public_media_router
from vita29.api.storage import router as storage_router
from vita29.api.users import router as users_router
from vita29.api.workspaces import router as workspaces_router
from vita29.api.yclients import router as yclients_router
from vita29.settings import get_settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    for path in (settings.originals_path, settings.previews_path, settings.trash_path):
        path.mkdir(parents=True, exist_ok=True)
    async def scheduled_worker():
        from vita29.content.scheduled_delivery import run_due
        from vita29.db.session import SessionLocal
        while True:
            try:
                await asyncio.to_thread(run_due, SessionLocal)
            except Exception:
                logging.getLogger(__name__).exception("Scheduled publication worker failed")
            await asyncio.sleep(15)
    task = asyncio.create_task(scheduled_worker())
    async def mobile_push_worker():
        from vita29.discussions.mobile_push import deliver_pending
        from vita29.db.session import SessionLocal
        while True:
            try:
                await asyncio.to_thread(deliver_pending, SessionLocal, settings.fcm_service_account_file, settings.fcm_project_id)
            except Exception:
                logging.getLogger(__name__).exception("Mobile push worker failed")
            await asyncio.sleep(30)
    push_task = asyncio.create_task(mobile_push_worker())
    async def follower_history_worker():
        from vita29.api.content_analytics import telegram_overview, instagram_overview, max_overview, vk_overview, threads_overview
        from vita29.content.follower_history import record_and_compare
        from vita29.db.session import SessionLocal
        while True:
            try:
                values = await asyncio.gather(telegram_overview(settings, 7), instagram_overview(settings, 7), max_overview(settings), vk_overview(settings, 7), threads_overview(settings, 7), return_exceptions=True)
                data = {name: value for name, value in zip(('telegram', 'instagram', 'max', 'vk', 'threads'), values) if isinstance(value, dict)}
                await asyncio.to_thread(record_and_compare, SessionLocal, settings, data, 7)
            except Exception:
                logging.getLogger(__name__).exception('Follower snapshot worker failed')
            await asyncio.sleep(21600)
    follower_task = asyncio.create_task(follower_history_worker())
    try:
        yield
    finally:
        task.cancel()
        push_task.cancel()
        follower_task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        with suppress(asyncio.CancelledError):
            await push_task
        with suppress(asyncio.CancelledError):
            await follower_task


app = FastAPI(title="Vita29 Files", version="0.1.0", lifespan=lifespan)
app.include_router(health_router, prefix="/api/v1")
app.include_router(android_import_chunks_router, prefix="/api/v1")
app.include_router(integrations_router, prefix="/api/v1")
app.include_router(telegram_story_login_router, prefix="/api/v1")
app.include_router(max_story_login_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(content_router, prefix="/api/v1")
app.include_router(content_analytics_router, prefix="/api/v1")
app.include_router(discussions_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(media_router, prefix="/api/v1")
app.include_router(mobile_auth_router, prefix="/api/v1")
app.include_router(mobile_updates_router, prefix="/api/v1")
app.include_router(mobile_push_router, prefix="/api/v1")
app.include_router(public_media_router, prefix="/api/v1")
app.include_router(storage_router, prefix="/api/v1")
app.include_router(workspaces_router, prefix="/api/v1")
app.include_router(yclients_router, prefix="/api/v1")

frontend_dir = Path(__file__).resolve().parent / "static"
assets_dir = frontend_dir / "assets"
if assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/", include_in_schema=False)
def index():
    index_file = frontend_dir / "index.html"
    if index_file.is_file():
        # Always revalidate the HTML shell. The JavaScript bundle itself has a
        # content hash, but a cached old index would keep a phone on an old UI.
        return FileResponse(index_file, headers={"Cache-Control": "no-cache, must-revalidate"})
    return {"name": "Vita29 Files", "stage": "scaffold"}


@app.get("/logo.svg", include_in_schema=False)
def logo():
    logo_file = frontend_dir / "logo.svg"
    if logo_file.is_file():
        return FileResponse(logo_file, media_type="image/svg+xml")
    raise HTTPException(status_code=404, detail="Logo not found")


PUBLIC_ROOT_ASSETS = {
    "manifest.webmanifest": "application/manifest+json",
    "sw.js": "text/javascript",
    "favicon-32.png": "image/png",
    "apple-touch-icon.png": "image/png",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "icon-maskable-512.png": "image/png",
}


@app.get("/{asset_name}", include_in_schema=False)
def public_root_asset(asset_name: str):
    media_type = PUBLIC_ROOT_ASSETS.get(asset_name)
    asset_file = frontend_dir / asset_name
    if media_type is not None and asset_file.is_file():
        return FileResponse(asset_file, media_type=media_type)
    raise HTTPException(status_code=404, detail="Asset not found")
