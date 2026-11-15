"""Persistent, atomic login quotas shared by browser and mobile endpoints."""

import hashlib
import ipaddress
import logging
import os
import socket
import sqlite3
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from time import time

from fastapi import HTTPException, Request
from sqlalchemy.engine import make_url

from vita29.settings import Settings

MAX_FAILURES = 5
MAX_SOURCE_ATTEMPTS = 60
WINDOW_SECONDS = 5 * 60
MAX_STORED_ATTEMPTS = 10000
log = logging.getLogger(__name__)


@lru_cache(maxsize=8)
def _proxy_addresses(hosts: tuple[str, ...], bucket: int) -> frozenset[str]:
    """Only operator-configured names are resolved, never request headers."""
    addresses = set()
    for host in hosts:
        try:
            addresses.update(info[4][0] for info in socket.getaddrinfo(host, None))
        except OSError:
            continue
    return frozenset(addresses)


def client_source(request: Request, settings: Settings) -> str:
    peer = request.client.host if request.client else "unknown"
    # Preserve the socket peer in Uvicorn. Trusted Caddy overwrites this header;
    # arbitrary Forwarded/X-Forwarded-For values are never used here.
    if peer in _proxy_addresses(settings.trusted_proxy_hosts, int(time() // 60)):
        try:
            peer = str(ipaddress.ip_address(request.headers.get("x-vita29-client-ip", "")))
        except ValueError:
            pass
    try:
        address = ipaddress.ip_address(peer)
        if isinstance(address, ipaddress.IPv6Address):
            if address.ipv4_mapped:
                return str(address.ipv4_mapped)
            return str(ipaddress.ip_network(f"{address}/64", strict=False))
        return str(address)
    except ValueError:
        return peer[:128]


def _key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _store_path(settings: Settings) -> Path:
    if settings.login_throttle_path is not None:
        return settings.login_throttle_path
    url = make_url(settings.database_url)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise ValueError("An explicit persistent login throttle path is required")
    database = Path(url.database).resolve()
    return database.with_name(database.name + ".login-rate.sqlite3")


@contextmanager
def _transaction(settings: Settings):
    connection = None
    try:
        path = _store_path(settings)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        connection = sqlite3.connect(path, timeout=5, isolation_level=None)
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS attempts ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, source TEXT NOT NULL, "
            "created_at REAL NOT NULL)"
        )
        for column in ("account", "source", "created_at"):
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS attempt_{column} ON attempts ({column})"
            )
        yield connection
        connection.commit()
    except (OSError, sqlite3.Error, ValueError):
        log.error("Login protection storage unavailable", exc_info=True)
        raise HTTPException(
            status_code=503, detail="Login temporarily unavailable", headers={"Retry-After": "5"}
        ) from None
    finally:
        if connection is not None:
            connection.close()


def reserve_login_attempt(login: str, request: Request, settings: Settings) -> int:
    """Reserve before password hashing, across processes and both login routes."""
    now = time()
    account, source = _key(login), _key(client_source(request, settings))
    with _transaction(settings) as db:
        db.execute("DELETE FROM attempts WHERE created_at <= ?", (now - WINDOW_SECONDS,))
        account_count = db.execute(
            "SELECT count(*) FROM attempts WHERE account = ?", (account,)
        ).fetchone()[0]
        source_count = db.execute(
            "SELECT count(*) FROM attempts WHERE source = ?", (source,)
        ).fetchone()[0]
        total = db.execute("SELECT count(*) FROM attempts").fetchone()[0]
        if (
            account_count >= MAX_FAILURES
            or source_count >= MAX_SOURCE_ATTEMPTS
            or total >= MAX_STORED_ATTEMPTS
        ):
            raise HTTPException(
                status_code=429, detail="Too many login attempts",
                headers={"Retry-After": str(WINDOW_SECONDS)},
            )
        attempt = db.execute(
            "INSERT INTO attempts (account, source, created_at) VALUES (?, ?, ?)",
            (account, source, now),
        )
        return int(attempt.lastrowid)


def complete_login_success(login: str, attempt_id: int, settings: Settings) -> None:
    with _transaction(settings) as db:
        # A valid account must not reset source password-spray protection or
        # erase reservations created after this successful attempt.
        db.execute(
            "UPDATE attempts SET account = NULL WHERE account = ? AND id <= ?",
            (_key(login), attempt_id),
        )
