"""Private downloaded-reference workspaces and backend-owned chat bindings.

Bindings live only for this backend process. A restart requires a new chat;
old folders are preserved and denied, never silently adopted or deleted.
"""
from __future__ import annotations

import hashlib
import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


_workspace: ContextVar[Path | None] = ContextVar("agent_workspace", default=None)


def workspace_root(state_dir: Path | None = None) -> Path:
    state = state_dir if state_dir is not None else Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula"))
    return state / "agent-workspaces"


def legacy_workspace_root(state_dir: Path | None = None) -> Path:
    return workspace_root(state_dir).with_name("agent-workspace")


def workspace_deny_roots(workdir: Path | None = None) -> list[Path]:
    roots = []
    # CLI processes may talk to a backend with a different state dir. Its
    # authenticated context names the exact managed leaf, never a caller path.
    if workdir is not None:
        for parent in Path(workdir).parents:
            if parent.name == "agent-workspaces":
                roots += [parent, parent.with_name("agent-workspace")]
                break
    roots += [workspace_root(), legacy_workspace_root()]
    return list(dict.fromkeys(roots))


def active_workspace() -> Path | None:
    return _workspace.get()


@contextmanager
def workspace_scope(workspace: Path | None):
    token = _workspace.set(validate_workspace(workspace) if workspace is not None else None)
    try:
        yield
    finally:
        _workspace.reset(token)


def normalize_brand(brand: str | None) -> str | None:
    if brand is None:
        return None
    if not isinstance(brand, str) or len(brand) > 128 or any(ord(c) < 32 for c in brand):
        raise WorkspaceSessionError("Brand must be a short text name")
    return brand.strip() or None


def create_workspace(state_dir: Path, brand: str | None = None) -> Path:
    from services.agent_profiles import default_secret_paths, paths_overlap, protected_agent_dirs
    brand = normalize_brand(brand)
    root = workspace_root(state_dir)
    for protected in [*protected_agent_dirs(), *default_secret_paths()]:
        if paths_overlap(root, protected):
            raise WorkspaceSessionError("Agent workspace namespace overlaps protected storage")
    key = hashlib.sha256(("brand:" + brand if brand is not None else "unbranded").encode()).hexdigest()[:32]
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise WorkspaceSessionError("Agent workspace namespace cannot be a symlink")
    brand_dir = root / key
    brand_dir.mkdir(exist_ok=True, mode=0o700)
    if brand_dir.is_symlink() or brand_dir.resolve().parent != root.resolve():
        raise WorkspaceSessionError("Agent workspace namespace contains an unexpected alias")
    path = brand_dir / uuid4().hex
    path.mkdir(mode=0o700)
    return path.resolve()


class WorkspaceSessionError(ValueError):
    pass


def workspace_identity(workspace: Path) -> tuple[tuple[int, int], ...]:
    path = Path(workspace).absolute()
    try:
        if path.resolve(strict=True) != path or not path.is_dir():
            raise WorkspaceSessionError("Agent workspace location changed or is unavailable")
        directories = [path]
        if path.parent.parent.name == "agent-workspaces":
            directories += [path.parent, path.parent.parent]
        identities = []
        for directory in directories:
            if directory.is_symlink() or not directory.is_dir():
                raise WorkspaceSessionError("Agent workspace ancestry changed")
            info = directory.stat()
            identities.append((info.st_dev, info.st_ino))
        return tuple(identities)
    except (OSError, RuntimeError) as exc:
        raise WorkspaceSessionError("Agent workspace location changed or is unavailable") from exc


def validate_workspace(workspace: Path, identity=None) -> Path:
    observed = workspace_identity(workspace)
    if identity is not None and observed != identity:
        raise WorkspaceSessionError("Agent workspace identity changed. Start a new chat with /clear.")
    return Path(workspace).absolute()


@dataclass
class WorkspaceSession:
    id: str
    runner: str
    brand: str | None
    workspace: Path
    identity: tuple[tuple[int, int], ...] = ()
    provider_session_id: str | None = None
    active: bool = True


class WorkspaceSessions:
    def __init__(self):
        self._sessions: dict[str, WorkspaceSession] = {}
        self._provider_owners: dict[tuple[str, str], str] = {}
        self._lock = threading.Lock()

    def acquire(self, state_dir: Path, runner: str, brand: str | None, session_id: str | None) -> WorkspaceSession:
        brand = normalize_brand(brand)
        with self._lock:
            if session_id is not None:
                session = self._sessions.get(session_id) if isinstance(session_id, str) else None
                if session is None:
                    raise WorkspaceSessionError("This chat session expired or predates workspace isolation. Start a new chat with /clear.")
                if session.runner != runner or session.brand != brand:
                    raise WorkspaceSessionError("A chat cannot resume under a different agent or brand. Start a new chat with /clear.")
                if session.active:
                    raise WorkspaceSessionError("This chat already has an active response")
                validate_workspace(session.workspace, session.identity)
                session.active = True
                return session
            try:
                path = create_workspace(state_dir, brand)
                session = WorkspaceSession(uuid4().hex, runner, brand, path, workspace_identity(path))
            except (OSError, RuntimeError) as exc:
                raise WorkspaceSessionError("Cannot create a private chat workspace") from exc
            self._sessions[session.id] = session
            return session

    def bind_provider(self, session: WorkspaceSession, provider_id: str) -> None:
        if not isinstance(provider_id, str) or not provider_id or len(provider_id) > 256:
            raise WorkspaceSessionError("Agent returned an invalid provider session")
        with self._lock:
            owner = self._provider_owners.get((session.runner, provider_id))
            if owner is not None and owner != session.id:
                raise WorkspaceSessionError("Agent returned a session belonging to a different chat")
            if session.provider_session_id is not None and session.provider_session_id != provider_id:
                raise WorkspaceSessionError("Agent changed its session while resuming")
            session.provider_session_id = provider_id
            self._provider_owners[(session.runner, provider_id)] = session.id

    def release(self, session: WorkspaceSession) -> None:
        with self._lock:
            session.active = False


class AgentWorkspaceContext:
    """Request-local capability from a registry-verified token, never a path header."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        from commons.actors import agent_registry
        from starlette.responses import JSONResponse
        headers = {key.lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        auth = headers.get(b"authorization", "")
        current = None
        if auth.startswith("Agent "):
            record = agent_registry.lookup(auth[6:].strip())
            if record is None:
                await JSONResponse({"detail": "invalid or expired agent token"}, status_code=401)(scope, receive, send)
                return
            current = record.get("workspace")
            if current is not None:
                try:
                    validate_workspace(current, record.get("workspace_identity"))
                except WorkspaceSessionError as exc:
                    await JSONResponse({"detail": str(exc)}, status_code=401)(scope, receive, send)
                    return
        with workspace_scope(current):
            await self.app(scope, receive, send)
