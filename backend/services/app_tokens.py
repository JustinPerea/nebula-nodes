"""Tokens the person gives outside apps, so each has its own spending line.

An agent outside Nebula's chats (Claude Desktop, a terminal tool, a script)
can't prove who it is: names and headers are its own to write. So by default
they all share one budget (``outside:shared`` in services/agent_spend.py).
The person can mint a named token for an app in Settings > Connect your agent.
Nebula writes it to a private file (services/app_token_file.py) and the app's
MCP config points at that file as ``NEBULA_APP_TOKEN_FILE`` (configs made
before that hold the token itself, as ``NEBULA_APP_TOKEN``). Requests
with ``Authorization: Agent <token>`` then count against ``outside:app:<id>``:
the app's own optional daily limit, and still the shared outside budget too,
so a token never adds headroom.

The person's own agents in the chat panel (services/personal_agents.py)
don't use app tokens: each chat session gets a token Nebula mints, which
counts as ``outside:personal:<agentId>`` inside the same outside budget.

The store (``app-tokens.json`` in the state directory) keeps only a SHA-256 of
each token. Tokens are 256 random bits, so a plain hash is enough: there is
nothing to guess. The token itself is in the create response and in its file
(``<state>/app-tokens/<id>.token``), which revoking deletes.

A token is a bearer secret: anything that can read its file can spend as the
app, within its limits, until the person revokes it.
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

from services import agent_spend, app_token_file

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
    def __init__(self, path: Path | None, *, token_dir: Path | None = None) -> None:
        """``token_dir``: the state dir whose ``app-tokens/`` folder holds each
        token's file. None (tests of the budgets alone) writes no files."""
        self._path = path
        self._token_dir = token_dir
        self._lock = threading.Lock()
        self._apps: list[dict[str, Any]] | None = None
        # True when the store file exists but couldn't be read or parsed. The
        # empty list it leaves is "unknown", not "no apps", so nothing may act
        # on it as a list of active apps (see clear_unknown_files).
        self._load_failed = False

    def _load(self) -> list[dict[str, Any]]:
        # A store that failed to load is read again on the next call, so a
        # file put right takes effect without a restart.
        if self._apps is None or self._load_failed:
            self._apps = []
            self._load_failed = False
            if self._path is not None and self._path.exists():
                try:
                    data = json.loads(self._path.read_text(encoding="utf-8"))
                    apps = data.get("apps") if isinstance(data, dict) else None
                    if not isinstance(apps, list):
                        raise ValueError("app-tokens.json has no apps list")
                    self._apps = [app for app in apps if isinstance(app, dict)
                                  and isinstance(app.get("id"), str) and isinstance(app.get("hash"), str)
                                  and isinstance(app.get("name"), str)]
                except (OSError, ValueError):
                    # Unreadable: no app token matches, so every caller falls
                    # to the shared budget or is refused (fail closed).
                    self._apps = []
                    self._load_failed = True
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
        """A new app and its token. The store keeps only its hash; with a
        ``token_dir`` the token is also written to the app's file first, and
        nothing is saved if that fails."""
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
            if self._load_failed:
                # Saving now would write this one app over every other.
                raise AppTokenError("Nebula couldn't read its list of connected apps (app-tokens.json in its "
                                    "state folder), so it won't write over it. Fix or move that file, then try again.")
            if len(apps) >= MAX_APPS:
                raise AppTokenError(f"at most {MAX_APPS} connected apps; revoke one first")
            app = {"id": secrets.token_hex(6), "name": name, "hash": _hash(token), "dailyUsd": limit,
                   "createdAt": time.time(), "client": client, "color": color}
            if self._token_dir is not None:
                try:
                    app_token_file.write(self._token_dir, app["id"], token)
                except (OSError, ValueError) as exc:
                    raise AppTokenError(f"couldn't save the token file ({exc})") from exc
            apps.append(app)
            try:
                self._save()
            except BaseException:
                apps.remove(app)
                if self._token_dir is not None:
                    app_token_file.remove(self._token_dir, app["id"])
                raise
        return self.public(app), token

    def token_file(self, app_id: str) -> Path | None:
        """Where this store writes an app's token file (None without a token_dir)."""
        if self._token_dir is None:
            return None
        # Absolute: it goes into other apps' configs, which start elsewhere.
        return Path(os.path.abspath(app_token_file.path_for(self._token_dir, app_id)))

    def clear_unknown_files(self) -> int:
        """At startup: delete token files of apps that are no longer active.

        Does nothing when the store couldn't be read: its apps are unknown,
        not gone, and a file deleted here can't be made again (the store
        keeps only hashes). Leftovers wait for a start that reads it."""
        if self._token_dir is None:
            return 0
        with self._lock:
            active = [app["id"] for app in self._load()]
            if self._load_failed:
                return 0
            return app_token_file.clear_unknown(self._token_dir, active)

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
            # After the save: the token is dead either way. A file the delete
            # misses goes at the next startup (clear_unknown_files).
            if self._token_dir is not None:
                app_token_file.remove(self._token_dir, app_id)
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
