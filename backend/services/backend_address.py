"""Where an outside MCP client finds this backend when its port changes per launch.

The desktop sidecar (desktop/sidecar.mjs) starts the backend on a port the OS
assigns, a new one each launch, and puts it in ``NEBULA_URL``. A config that
names that port stops working when Nebula is reopened. So in desktop mode the
backend writes its address to ``<NEBULA_STATE_DIR>/backend-url`` (0600) at
startup, and Connect your agent configs carry ``NEBULA_URL_FILE`` (that path)
instead of ``NEBULA_URL``. backend/mcp_server.py and the ``nebula`` CLI read the
file on every call, so they follow Nebula across relaunches.

A dev backend (backend/devserver.py, plain uvicorn) has a fixed port the
person chose, and several of them may share one state dir, so it publishes
nothing and its configs keep ``NEBULA_URL``.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit

FILE_NAME = "backend-url"


def loopback_url(url: str) -> str:
    """An http origin on this machine, or ValueError. Nothing else is trusted
    with an app token: a file anyone edited to point elsewhere is refused."""
    parts = urlsplit(url.strip())
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("the Nebula address must use a valid port") from exc
    if (parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parts.username is not None or parts.password is not None or parts.query
            or parts.fragment or parts.path not in {"", "/"} or port is None):
        raise ValueError("the Nebula address must be http on 127.0.0.1, localhost or ::1 with a port")
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def launch_assigned(environ: Mapping[str, str] | None = None) -> bool:
    """True when the desktop sidecar started this backend (a new port each launch)."""
    env = os.environ if environ is None else environ
    return env.get("NEBULA_DESKTOP_MODE") == "1"


def url_file(state_dir: Path) -> Path:
    return Path(state_dir) / FILE_NAME


def publish(state_dir: Path, url: str) -> Path:
    """Write this launch's address, atomically and 0600."""
    target = url_file(state_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{FILE_NAME}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(loopback_url(url) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
    return target


def withdraw(state_dir: Path, url: str) -> None:
    """Remove the file at shutdown, unless a newer launch already replaced it."""
    target = url_file(state_dir)
    try:
        if target.read_text(encoding="utf-8").strip() == loopback_url(url):
            target.unlink()
    except (OSError, ValueError):
        pass


def read(path: str | Path) -> str:
    """The address in a backend-url file. Raises ValueError with a plain reason."""
    try:
        text = Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise ValueError(f"Nebula isn't running (no {path}). Open Nebula, then try again.") from exc
    except OSError as exc:
        raise ValueError(f"can't read {path}: {exc}") from exc
    return loopback_url(text)
