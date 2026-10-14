from collections import defaultdict
from threading import Lock
from time import monotonic

MAX_FAILURES = 5
WINDOW_SECONDS = 5 * 60

_failures: dict[str, list[float]] = defaultdict(list)
_lock = Lock()


def _recent(values: list[float], now: float) -> list[float]:
    return [value for value in values if now - value < WINDOW_SECONDS]


def login_is_allowed(key: str) -> bool:
    now = monotonic()
    with _lock:
        _failures[key] = _recent(_failures[key], now)
        return len(_failures[key]) < MAX_FAILURES


def record_login_failure(key: str) -> None:
    now = monotonic()
    with _lock:
        _failures[key] = [*_recent(_failures[key], now), now]


def clear_login_failures(key: str) -> None:
    with _lock:
        _failures.pop(key, None)
