import json
import os
from pathlib import Path

from vita29.settings import Settings


class IntegrationConfigurationError(RuntimeError):
    """Configuration is not available for a requested external provider."""


def _config_path(settings: Settings) -> Path:
    settings.integration_config_path.parent.mkdir(parents=True, exist_ok=True)
    return settings.integration_config_path


def read_config(settings: Settings) -> dict[str, str]:
    path = _config_path(settings)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        return {}
    return {str(key): str(value) for key, value in data.items() if isinstance(value, str)}


def update_config(settings: Settings, values: dict[str, str | None]) -> None:
    config = read_config(settings)
    for key, value in values.items():
        if value is None:
            continue
        normalized = value.strip()
        if normalized:
            config[key] = normalized
        else:
            config.pop(key, None)
    path = _config_path(settings)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


def _managed_secret_path(settings: Settings, key: str) -> Path:
    settings.integration_secrets_path.mkdir(parents=True, exist_ok=True)
    return settings.integration_secrets_path / key


def write_secret(settings: Settings, key: str, value: str | None) -> None:
    path = _managed_secret_path(settings, key)
    if value is None:
        return
    normalized = value.strip()
    if not normalized:
        path.unlink(missing_ok=True)
        return
    temporary = path.with_suffix(".tmp")
    temporary.write_text(normalized + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


def secret_is_configured(settings: Settings, key: str, legacy_path: Path) -> bool:
    managed = _managed_secret_path(settings, key)
    return bool(managed.is_file() and managed.stat().st_size) or bool(
        legacy_path.is_file() and legacy_path.stat().st_size
    )


def read_secret(settings: Settings, key: str, legacy_path: Path, label: str) -> str:
    managed = _managed_secret_path(settings, key)
    for path in (managed, legacy_path):
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    raise IntegrationConfigurationError(f"{label} is not configured")


def config_value(settings: Settings, key: str, default: str = "") -> str:
    return read_config(settings).get(key, default)
