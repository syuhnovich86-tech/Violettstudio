"""Owner/admin interface for external provider credentials.

Secrets are write-only here: the browser receives only a configured/not-configured flag.
"""

import json
import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
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
    vk: ProviderStatus
    threads: ProviderStatus


class IntegrationUpdateRequest(BaseModel):
    openai_api_key: str | None = Field(default=None, max_length=512)
    openai_model: str | None = Field(default=None, max_length=120)
    openai_analytics_model: str | None = Field(default=None, max_length=120)
    openai_image_model: str | None = Field(default=None, max_length=120)
    telegram_bot_token: str | None = Field(default=None, max_length=512)
    telegram_channel: str | None = Field(default=None, max_length=160)
    telegram_api_id: str | None = Field(default=None, max_length=20)
    telegram_api_hash: str | None = Field(default=None, max_length=128)
    max_bot_token: str | None = Field(default=None, max_length=512)
    max_channel_id: str | None = Field(default=None, max_length=160)
    instagram_access_token: str | None = Field(default=None, max_length=2048)
    instagram_analytics_access_token: str | None = Field(default=None, max_length=2048)
    instagram_account_id: str | None = Field(default=None, max_length=160)
    threads_access_token: str | None = Field(default=None, max_length=2048)
    vk_user_token: str | None = Field(default=None, max_length=2048)
    vk_analytics_token: str | None = Field(default=None, max_length=2048)
    vk_group_id: str | None = Field(default=None, max_length=32)


def _status(settings: Settings) -> IntegrationStatusResponse:
    config = read_config(settings)
    return IntegrationStatusResponse(
        openai=ProviderStatus(
            configured=secret_is_configured(settings, "openai_api_key", settings.openai_api_key_file),
            fields={
                "model": config.get("openai_model", settings.openai_content_model),
                "analytics_model": config.get("openai_analytics_model", "gpt-6-astra"),
                "image_model": config.get("openai_image_model", settings.openai_image_model),
            },
        ),
        telegram=ProviderStatus(
            configured=secret_is_configured(settings, "telegram_bot_token", settings.telegram_bot_token_file)
            and bool(config.get("telegram_channel") or settings.telegram_channel_file.is_file()),
            fields={"channel": config.get("telegram_channel", ""),
                    "api_id": config.get("telegram_api_id", ""),
                    "story_session_configured": str(secret_is_configured(settings, "telegram_story_session", settings.integration_secrets_path / "unused")).lower(),
                    "story_credentials_configured": str(bool(config.get("telegram_api_id")) and secret_is_configured(settings, "telegram_api_hash", settings.integration_secrets_path / "unused")).lower()},
        ),
        max=ProviderStatus(
            configured=secret_is_configured(settings, "max_bot_token", settings.integration_secrets_path / "unused")
            and bool(config.get("max_channel_id")),
            fields={"channel_id": config.get("max_channel_id", ""), "story_session_configured": str(secret_is_configured(settings, "max_story_session", settings.integration_secrets_path / "unused")).lower()},
        ),
        instagram=ProviderStatus(
            configured=secret_is_configured(settings, "instagram_access_token", settings.integration_secrets_path / "unused")
            and bool(config.get("instagram_account_id")),
            fields={"account_id": config.get("instagram_account_id", ""), "analytics_token_configured": str(secret_is_configured(settings, "instagram_analytics_access_token", settings.integration_secrets_path / "unused")).lower()},
        ),
        threads=ProviderStatus(configured=secret_is_configured(settings, "threads_access_token", settings.integration_secrets_path / "unused"), fields={}),
        vk=ProviderStatus(
            configured=secret_is_configured(settings, "vk_user_token", settings.integration_secrets_path / "unused")
            and bool(config.get("vk_group_id")),
            fields={"group_id": config.get("vk_group_id", ""), "analytics_token_configured": str(secret_is_configured(settings, "vk_analytics_token", settings.integration_secrets_path / "unused")).lower()},
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
    api_id = data.get("telegram_api_id")
    api_hash = data.get("telegram_api_hash")
    if api_id and not re.fullmatch(r"[0-9]{1,20}", api_id.strip()):
        raise HTTPException(status_code=400, detail="Telegram API ID должен состоять из цифр")
    if api_hash and not re.fullmatch(r"[a-fA-F0-9]{32}", api_hash.strip()):
        raise HTTPException(status_code=400, detail="Неверный формат Telegram API hash")
    write_secret(settings, "openai_api_key", data.pop("openai_api_key"))
    write_secret(settings, "telegram_bot_token", data.pop("telegram_bot_token"))
    write_secret(settings, "telegram_api_hash", data.pop("telegram_api_hash"))
    write_secret(settings, "max_bot_token", data.pop("max_bot_token"))
    write_secret(settings, "instagram_access_token", data.pop("instagram_access_token"))
    write_secret(settings, "instagram_analytics_access_token", data.pop("instagram_analytics_access_token"))
    write_secret(settings, "threads_access_token", data.pop("threads_access_token"))
    write_secret(settings, "vk_user_token", data.pop("vk_user_token"))
    write_secret(settings, "vk_analytics_token", data.pop("vk_analytics_token"))
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
