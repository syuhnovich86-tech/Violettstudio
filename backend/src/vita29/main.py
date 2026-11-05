from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from vita29.api.auth import router as auth_router
from vita29.api.content import router as content_router
from vita29.api.discussions import router as discussions_router
from vita29.api.health import router as health_router
from vita29.api.integrations import router as integrations_router
from vita29.api.media import router as media_router
from vita29.api.mobile_auth import router as mobile_auth_router
from vita29.api.mobile_updates import router as mobile_updates_router
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
    yield


app = FastAPI(title="Vita29 Files", version="0.1.0", lifespan=lifespan)
app.include_router(health_router, prefix="/api/v1")
app.include_router(integrations_router, prefix="/api/v1")
app.include_router(auth_router, prefix="/api/v1")
app.include_router(content_router, prefix="/api/v1")
app.include_router(discussions_router, prefix="/api/v1")
app.include_router(users_router, prefix="/api/v1")
app.include_router(media_router, prefix="/api/v1")
app.include_router(mobile_auth_router, prefix="/api/v1")
app.include_router(mobile_updates_router, prefix="/api/v1")
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
