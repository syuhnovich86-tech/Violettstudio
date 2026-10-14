from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="VITA29_",
        case_sensitive=False,
        extra="ignore",
    )

    environment: str = "development"
    database_url: str = "sqlite:///./.data/vita29.db"
    media_root: Path = Path("./.data/media")
    import_root: Path = Path("./.data/import/iphone")
    import_owner_login: str = "violet29"
    import_workspace_name: str = "Фото с iPhone"
    import_scan_seconds: int = Field(default=30, ge=5, le=3600)
    import_stability_seconds: int = Field(default=90, ge=10, le=3600)
    geonames_cities_path: Path = Path("/data/geonames/cities500.txt")
    minimum_free_bytes: int = Field(default=512 * 1024 * 1024, ge=0)
    session_lifetime_hours: int = Field(default=12, ge=1, le=168)
    cookie_secure: bool = False
    max_file_bytes: int = Field(default=2 * 1024 * 1024 * 1024, ge=1024)
    upload_chunk_bytes: int = Field(default=1024 * 1024, ge=64 * 1024, le=8 * 1024 * 1024)
    local_utc_offset_hours: int = Field(default=3, ge=-12, le=14)
    yclients_application_id: int = Field(default=49434, ge=1)
    yclients_api_base_url: str = "https://api.yclients.com"
    yclients_public_base_url: str = "https://31-10-64-46.sslip.io"
    yclients_user_token_file: Path = Path("/run/secrets/yclients_user_token")
    yclients_partner_token_file: Path = Path("/run/secrets/yclients_partner_token")
    yclients_http_timeout_seconds: float = Field(default=15.0, gt=0, le=60)
    vapid_private_key_file: Path = Path("/run/secrets/vapid_private.pem")
    vapid_subject: str = "https://31-10-64-46.sslip.io"

    @property
    def originals_path(self) -> Path:
        return self.media_root / "originals"

    @property
    def previews_path(self) -> Path:
        return self.media_root / "previews"

    @property
    def trash_path(self) -> Path:
        return self.media_root / ".trash"


@lru_cache
def get_settings() -> Settings:
    return Settings()
