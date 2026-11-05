"""Owner/admin interface for external provider credentials.

Secrets are write-only here: the browser receives only a configured/not-configured flag.
"""

import json
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from vita29.auth.dependencies import require_csrf, require_owner_or_administrator
from vita29.db.models import AuditLog, AuthSession, User
from vita29.db.session import get_db
from vita29.integrations.store import (
    read_config,
    secret_is_configured,
    update_config,
    write_secret,
)
from vita29.settings import Settings, get_settings

router = APIRouter(prefix="/integrations", tags=["integrations"])


class ProviderStatus(BaseModel):
    configured: bool
    fields: dict[str, str]


class IntegrationStatusResponse(BaseModel):
    openai: ProviderStatus
    telegram: ProviderStatus
    max: ProviderStatus
    instagram: ProviderStatus


class IntegrationUpdateRequest(BaseModel):
    openai_api_key: str | None = Field(default=None, max_length=512)
    openai_model: str | None = Field(default=None, max_length=120)
    openai_image_model: str | None = Field(default=None, max_length=120)
    telegram_bot_token: str | None = Field(default=None, max_length=512)
    telegram_channel: str | None = Field(default=None, max_length=160)
    max_bot_token: str | None = Field(default=None, max_length=512)
    max_channel_id: str | None = Field(default=None, max_length=160)
    instagram_access_token: str | None = Field(default=None, max_length=2048)
    instagram_account_id: str | None = Field(default=None, max_length=160)


def _status(settings: Settings) -> IntegrationStatusResponse:
    config = read_config(settings)
    return IntegrationStatusResponse(
        openai=ProviderStatus(
            configured=secret_is_configured(settings, "openai_api_key", settings.openai_api_key_file),
            fields={
                "model": config.get("openai_model", settings.openai_content_model),
                "image_model": config.get("openai_image_model", settings.openai_image_model),
            },
        ),
        telegram=ProviderStatus(
            configured=secret_is_configured(settings, "telegram_bot_token", settings.telegram_bot_token_file)
            and bool(config.get("telegram_channel") or settings.telegram_channel_file.is_file()),
            fields={"channel": config.get("telegram_channel", "")},
        ),
        max=ProviderStatus(
            configured=secret_is_configured(settings, "max_bot_token", settings.integration_secrets_path / "unused")
            and bool(config.get("max_channel_id")),
            fields={"channel_id": config.get("max_channel_id", "")},
        ),
        instagram=ProviderStatus(
            configured=secret_is_configured(settings, "instagram_access_token", settings.integration_secrets_path / "unused")
            and bool(config.get("instagram_account_id")),
            fields={"account_id": config.get("instagram_account_id", "")},
        ),
    )


@router.get("", response_model=IntegrationStatusResponse)
def get_integrations(
    _: Annotated[User, Depends(require_owner_or_administrator)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> IntegrationStatusResponse:
    return _status(settings)


@router.put("", response_model=IntegrationStatusResponse)
def update_integrations(
    payload: IntegrationUpdateRequest,
    _: Annotated[AuthSession, Depends(require_csrf)],
    user: Annotated[User, Depends(require_owner_or_administrator)],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> IntegrationStatusResponse:
    data = payload.model_dump()
    write_secret(settings, "openai_api_key", data.pop("openai_api_key"))
    write_secret(settings, "telegram_bot_token", data.pop("telegram_bot_token"))
    write_secret(settings, "max_bot_token", data.pop("max_bot_token"))
    write_secret(settings, "instagram_access_token", data.pop("instagram_access_token"))
    update_config(settings, data)
    db.add(AuditLog(
        actor_id=user.id,
        action="integrations.update",
        target_type="integration",
        target_id="providers",
        details=json.dumps({"updated": sorted(key for key, value in payload.model_dump().items() if value is not None)}, ensure_ascii=False),
    ))
    db.commit()
    return _status(settings)
