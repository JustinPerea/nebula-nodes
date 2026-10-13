"""Tokens the person gives outside apps, so each has its own spending line.

An agent outside Nebula's chats (Claude Desktop, a terminal tool, a script)
can't prove who it is: names and headers are its own to write. So by default
they all share one budget (``outside:shared`` in services/agent_spend.py).
The person can mint a named token for an app in Settings > Agent spending
and paste it into that app's MCP config as ``NEBULA_APP_TOKEN``. Requests
with ``Authorization: Agent <token>`` then count against ``outside:app:<id>``:
the app's own optional daily limit, and still the shared outside budget too,
so a token never adds headroom.

Only a SHA-256 of each token is stored (``app-tokens.json`` in the state
directory); the token itself is shown once, when it is made. Tokens are 256
random bits, so a plain hash is enough: there is nothing to guess.

A token is a bearer secret in the app's config: anything that can read that
file can spend as the app, within its limits, until the person revokes it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from services import agent_spend

TOKEN_PREFIX = "nebula_app_"
MAX_APPS = 50
MAX_NAME = 60
_ID = re.compile(r"^[a-f0-9]{12}$")
_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
# Which app the person connected (services/agent_connect.CLIENTS); kept as a
# label only, so a store written before this field existed still loads.
_CLIENT = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


class AppTokenError(ValueError):
    pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clean_name(value: Any) -> str:
    if not isinstance(value, str):
        raise AppTokenError("name must be text")
    name = " ".join("".join(ch for ch in value if ch.isprintable()).split())
    if not name:
        raise AppTokenError("name the app, for example Claude Desktop")
    if len(name) > MAX_NAME:
        raise AppTokenError(f"name must be at most {MAX_NAME} characters")
    return name


def clean_color(value: Any) -> str | None:
    """The cursor color the person picked (#RRGGBB), or None for the default."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not _COLOR.fullmatch(value):
        raise AppTokenError("color must be #RRGGBB or null")
    return value.upper()


def clean_client(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _CLIENT.fullmatch(value):
        raise AppTokenError("client must be a short id such as hermes")
    return value


class AppTokens:
    def __init__(self, path: Path | None) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._apps: list[dict[str, Any]] | None = None

    def _load(self) -> list[dict[str, Any]]:
        if self._apps is None:
            self._apps = []
            if self._path is not None and self._path.exists():
                try:
                    data = json.loads(self._path.read_text(encoding="utf-8"))
                    apps = data.get("apps") if isinstance(data, dict) else None
                    self._apps = [app for app in apps or [] if isinstance(app, dict)
                                  and isinstance(app.get("id"), str) and isinstance(app.get("hash"), str)
                                  and isinstance(app.get("name"), str)]
                except (OSError, ValueError):
                    # Unreadable: no app token matches, so every caller falls
                    # to the shared budget or is refused (fail closed).
                    self._apps = []
        return self._apps

    def _save(self) -> None:
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"apps": self._apps or []}, handle)
        os.replace(tmp, self._path)

    @staticmethod
    def public(app: dict[str, Any]) -> dict[str, Any]:
        return {"id": app["id"], "name": app["name"], "dailyUsd": app.get("dailyUsd"),
                "createdAt": app.get("createdAt"), "client": app.get("client"), "color": app.get("color")}

    def create(self, name: Any, daily_usd: Any = None, *, client: Any = None,
               color: Any = None) -> tuple[dict[str, Any], str]:
        """A new app and its token. The token is returned once and never stored."""
        name = clean_name(name)
        client = clean_client(client)
        color = clean_color(color)
        try:
            limit = agent_spend.validate_threshold(daily_usd)
        except ValueError as exc:
            raise AppTokenError("dailyUsd must be a positive number of USD or null") from exc
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        with self._lock:
            apps = self._load()
            if len(apps) >= MAX_APPS:
                raise AppTokenError(f"at most {MAX_APPS} connected apps; revoke one first")
            app = {"id": secrets.token_hex(6), "name": name, "hash": _hash(token), "dailyUsd": limit,
                   "createdAt": time.time(), "client": client, "color": color}
            apps.append(app)
            self._save()
        return self.public(app), token

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self.public(app) for app in self._load()]

    def get(self, app_id: str) -> dict[str, Any] | None:
        with self._lock:
            app = next((app for app in self._load() if app["id"] == app_id), None)
            return self.public(app) if app else None

    def set_limit(self, app_id: str, daily_usd: Any) -> dict[str, Any] | None:
        try:
            limit = agent_spend.validate_threshold(daily_usd)
        except ValueError as exc:
            raise AppTokenError("dailyUsd must be a positive number of USD or null") from exc
        with self._lock:
            app = next((app for app in self._load() if app["id"] == app_id), None)
            if app is None:
                return None
            app["dailyUsd"] = limit
            self._save()
            return self.public(app)

    def set_color(self, app_id: str, color: Any) -> dict[str, Any] | None:
        color = clean_color(color)
        with self._lock:
            app = next((app for app in self._load() if app["id"] == app_id), None)
            if app is None:
                return None
            app["color"] = color
            self._save()
            return self.public(app)

    def revoke(self, app_id: str) -> bool:
        with self._lock:
            apps = self._load()
            kept = [app for app in apps if app["id"] != app_id]
            if len(kept) == len(apps):
                return False
            self._apps = kept
            self._save()
            return True

    def lookup(self, token: str) -> dict[str, Any] | None:
        """The app a token belongs to, or None. Only tokens with our prefix are checked."""
        if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX):
            return None
        digest = _hash(token)
        with self._lock:
            for app in self._load():
                if hmac.compare_digest(app["hash"], digest):
                    return self.public(app)
        return None


# The store main.py installs at startup (in the state directory). Code that
# checks an ``Authorization: Agent`` header asks it through lookup().
_store: AppTokens | None = None


def install(store: AppTokens | None) -> None:
    global _store
    _store = store


def store() -> AppTokens | None:
    return _store


def lookup(token: str) -> dict[str, Any] | None:
    current = _store
    return current.lookup(token) if current is not None else None


def valid_id(app_id: str) -> bool:
    return bool(_ID.fullmatch(app_id or ""))
