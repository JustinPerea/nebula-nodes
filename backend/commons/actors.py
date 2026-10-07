"""Who wrote this? The backend decides; callers never self-declare (§4).

- human:justin: only via the per-launch UI bearer token (PLAN component 5)
- agent:<runner>/<model>: Nebula's own runners, via a per-turn agent token
- agent:mcp:<clientInfo.name>: external harnesses, self-reported, never human
- agent:cli: the nebula CLI with no token
"""
from __future__ import annotations

import hmac
import re
import secrets
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

HUMAN = "human:justin"
_CLIENT_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class Actor:
    id: str
    kind: str
    allowed_dirs: tuple[Path, ...] = field(default_factory=tuple)
    self_reported: bool = False
    brand: str | None = None
    workspace: Path | None = None
    workspace_identity: tuple | None = None

    @property
    def is_human(self) -> bool:
        return self.kind == "human"

    @property
    def is_agent(self) -> bool:
        return self.kind == "agent"


SYSTEM_WORKER = Actor("worker:analysis", "system")


class UISession:
    def __init__(self) -> None:
        self._token: str | None = None
        self._lock = threading.Lock()

    @property
    def is_set(self) -> bool:
        with self._lock:
            return self._token is not None

    def set(self, token: str) -> None:
        if not isinstance(token, str) or re.fullmatch(r"[A-Za-z0-9_-]{43}", token) is None:
            raise ValueError("invalid UI session token format")
        with self._lock:
            if self._token is not None:
                raise RuntimeError("UI session already initialized")
            self._token = token

    def verify(self, token: str) -> bool:
        with self._lock:
            current = self._token
        return bool(current) and hmac.compare_digest(current.encode(), token.encode())


class AgentRegistry:
    def __init__(self) -> None:
        self._tokens: dict[str, dict] = {}
        self._lock = threading.Lock()

    def mint(self, runner: str, allowed_dirs: list[Path], *, brand: str | None = None,
             workspace: Path | None = None) -> str:
        identity = None
        if workspace is not None:
            from services.agent_workspaces import workspace_identity, validate_workspace
            identity = workspace_identity(workspace)
            validate_workspace(workspace, identity)
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._tokens[token] = {"runner": runner, "model": None, "brand": brand,
                                   "workspace": Path(workspace).expanduser().resolve() if workspace is not None else None,
                                   "workspace_identity": identity,
                                   "allowed_dirs": tuple(Path(d).resolve() for d in allowed_dirs)}
        return token

    def set_model(self, token: str, model: str) -> None:
        with self._lock:
            if token in self._tokens:
                self._tokens[token]["model"] = model

    def revoke(self, token: str) -> None:
        with self._lock:
            self._tokens.pop(token, None)

    def lookup(self, token: str) -> dict | None:
        with self._lock:
            for known, record in self._tokens.items():
                if hmac.compare_digest(known.encode(), token.encode()):
                    return dict(record)
        return None


ui_session = UISession()
agent_registry = AgentRegistry()


def resolve_actor(headers: Mapping[str, str]) -> Actor:
    lower = {k.lower(): v for k, v in headers.items()}
    auth = lower.get("authorization", "")
    if auth.startswith("Bearer "):
        if not ui_session.is_set:
            raise AuthError("no UI session: open Nebula from the desktop app or use the dev link")
        if ui_session.verify(auth[7:].strip()):
            return Actor(HUMAN, "human")
        raise AuthError("invalid UI session token")
    if auth.startswith("Agent "):
        record = agent_registry.lookup(auth[6:].strip())
        if record is None:
            raise AuthError("invalid or expired agent token")
        if record["workspace"] is not None:
            from services.agent_workspaces import validate_workspace
            try:
                validate_workspace(record["workspace"], record["workspace_identity"])
            except (OSError, ValueError) as exc:
                raise AuthError("agent workspace is unavailable or changed") from exc
        return Actor(f"agent:{record['runner']}/{record['model'] or 'unresolved'}", "agent",
                     allowed_dirs=record["allowed_dirs"], brand=record["brand"], workspace=record["workspace"],
                     workspace_identity=record["workspace_identity"])
    client = lower.get("x-nebula-client")
    if client is not None:
        name = client if _CLIENT_NAME.fullmatch(client) and ":" not in client else "unknown"
        return Actor(f"agent:mcp:{name}", "agent", self_reported=True)
    return Actor("agent:cli", "agent")
