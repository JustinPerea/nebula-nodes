"""The person's per-launch secret: the one proof that a request is the person.

Each backend launch has at most one person token, a 43-character urlsafe
secret held only in this process's memory. Whoever presents it (in the
``X-Nebula-Person`` header, the ``/ws`` hello frame, a ``/ws/chat`` send, or
Commons' ``Authorization: Bearer``) is treated as the person. Nothing else is:
not an ``Origin`` header, not a query parameter, not a name.

Where the token comes from, in order:

1. Desktop: Electron main writes one line to the sidecar's stdin
   (``NEBULA_PERSON_TOKEN_STDIN=1``; the old ``NEBULA_UI_TOKEN_STDIN`` name
   still works). A missing, short or late line leaves no session at all, so
   nothing counts as the person (fail closed). Electron sends nothing when a
   debugging port is open.
2. Dev: ``backend/devserver.py`` makes the token and hands it to each reload
   worker inside the pickled server object (``provide()``), so it survives
   ``--reload`` restarts without ever being in an environment variable, argv
   or a file.
3. Otherwise a fresh token per process. When stdout is a terminal the link
   is printed there; with no terminal nobody learns it, so the canvas runs
   unverified (the safe default).

The token is never written to disk, argv or logs. See services/person_gate.py
for what it unlocks and what it can't protect against.
"""
from __future__ import annotations

import hmac
import io
import logging
import os
import re
import secrets
import select
import sys
import threading
import time
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

PERSON_HEADER = "x-nebula-person"
TOKEN_STDIN_ENV = "NEBULA_PERSON_TOKEN_STDIN"
LEGACY_TOKEN_STDIN_ENV = "NEBULA_UI_TOKEN_STDIN"
DEV_UI_ORIGIN_ENV = "NEBULA_DEV_UI_ORIGIN"
DEFAULT_DEV_UI_ORIGIN = "http://localhost:5173"
_TOKEN_SHAPE = re.compile(r"[A-Za-z0-9_-]{43}")
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


class PersonSession:
    """The launch's person token. Set once; compared in constant time."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._lock = threading.Lock()

    @property
    def is_set(self) -> bool:
        with self._lock:
            return self._token is not None

    def set(self, token: str) -> None:
        if not isinstance(token, str) or _TOKEN_SHAPE.fullmatch(token) is None:
            raise ValueError("invalid person token format")
        with self._lock:
            if self._token is not None:
                raise RuntimeError("person session already initialized")
            self._token = token

    def verify(self, token: object) -> bool:
        if not isinstance(token, str) or not token:
            return False
        with self._lock:
            current = self._token
        return bool(current) and hmac.compare_digest(current.encode(), token.encode())


# The single instance. Read it through current() so a test fixture that swaps
# it (tests/conftest.py `person`) changes it for every reader at once.
_session = PersonSession()
_provided: str | None = None


def current() -> PersonSession:
    return _session


def verify(token: object) -> bool:
    return current().verify(token)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def provide(token: str) -> None:
    """Hand this process the dev launcher's token before the app starts."""
    global _provided
    if not isinstance(token, str) or _TOKEN_SHAPE.fullmatch(token) is None:
        raise ValueError("invalid person token format")
    _provided = token


def _read_line(stream, timeout: float) -> str:
    # StringIO is used by tests; real pipes use a deadline covering the whole line.
    if isinstance(stream, io.StringIO):
        return stream.readline(128)
    fd = stream.fileno()
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) < 128:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError
        byte = os.read(fd, 1)
        if not byte:
            # EOF without the promised newline fails closed, even for 43 bytes.
            raise EOFError
        data.extend(byte)
        if byte == b"\n":
            return data.decode("ascii")
    raise ValueError("person token line too long")


def loopback_origin(value: str | None) -> str | None:
    """``scheme://host[:port]`` when ``value`` is a plain loopback http(s) origin."""
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        parsed.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return None
    if (parsed.scheme not in ("http", "https") or parsed.hostname not in _LOOPBACK_HOSTS
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment):
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def person_link(token: str, backend_origin: str, ui_origin: str | None = None) -> str | None:
    """The link that connects a browser tab as the person, or None when either
    origin isn't loopback (never send the secret to a remote page)."""
    ui = loopback_origin(ui_origin or os.environ.get(DEV_UI_ORIGIN_ENV) or DEFAULT_DEV_UI_ORIGIN)
    backend = loopback_origin(backend_origin)
    if ui is None or backend is None:
        return None
    return f"{ui}/#nebula-person={token}&backend={backend}"


def initialize(*, stdin=None, stdout=None, timeout: float = 5.0, backend_origin: str | None = None) -> None:
    """Set this launch's person token once (see the module docstring for the order)."""
    session = current()
    if session.is_set:
        return  # Startup can be entered repeatedly by test lifespans.
    if os.environ.get(TOKEN_STDIN_ENV) == "1" or os.environ.get(LEGACY_TOKEN_STDIN_ENV) == "1":
        stdin = sys.stdin if stdin is None else stdin
        try:
            session.set(_read_line(stdin, timeout).strip())
        except (OSError, ValueError, EOFError, TimeoutError, RuntimeError):
            log.warning("Person session unavailable: missing or invalid startup pipe; "
                        "person-only actions are refused this launch")
        return
    if _provided is not None:
        session.set(_provided)
        return

    token = new_token()
    session.set(token)
    stdout = sys.stdout if stdout is None else stdout
    if not stdout.isatty():
        log.info("Person link unavailable: no terminal. Start the backend with "
                 "backend/devserver.py (--open) to connect the canvas as you.")
        return
    if backend_origin is None:
        from services.krea_agent_mcp import resolve_nebula_url
        try:
            backend_origin = resolve_nebula_url()
        except ValueError:
            backend_origin = ""
    link = person_link(token, backend_origin)
    if link is None:
        log.warning("Person link unavailable: the UI or backend origin is not loopback")
        return
    print(f"Open Nebula as you: {link}", file=stdout, flush=True)
