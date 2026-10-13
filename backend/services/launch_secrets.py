"""The desktop sidecar's other launch secrets, read from stdin after the person token.

Electron main used to pass the decrypted provider keys (``NEBULA_INJECTED_KEYS``)
and the Krea OAuth vault key (``NEBULA_CONNECTOR_ENCRYPTION_KEY``) to the
sidecar in its environment. A process's initial environment is readable by any
same-user program (``ps -E``, ``ps eww``) for as long as it runs, and removing a
variable from ``os.environ`` later doesn't change that copy. Checked live in the
desktop pass (2026-10-13): a planted canary key showed up in the sidecar's
``ps -E`` output.

So, with ``NEBULA_LAUNCH_SECRETS_STDIN=1``, Electron writes one more line to the
sidecar's stdin, right after the person-token line (services/person_session.py
reads that one), and then closes stdin::

    {"injectedKeys": {"FAL_KEY": "..."}, "connectorEncryptionKey": "..."}

Either field may be missing. A missing, late, oversized or malformed line
leaves no injected keys and no vault key, which fails closed: provider calls
have no key, and in desktop mode the Krea vault refuses to open
(services/krea_connector.py). Nothing here is ever logged or written to disk.

Browser dev and the test suite don't set the flag; the old environment
variables still work there (services/settings.py, services/krea_connector.py).
"""
from __future__ import annotations

import io
import json
import logging
import os
import select
import sys
import time

log = logging.getLogger(__name__)

STDIN_ENV = "NEBULA_LAUNCH_SECRETS_STDIN"
MAX_LINE_BYTES = 1024 * 1024  # a Vertex service-account JSON is a few KB

_connector_key: str | None = None
_read = False


def connector_encryption_key() -> str | None:
    """The Krea vault key Electron sent over stdin, if any."""
    return _connector_key


def _read_line(stream, timeout: float) -> str:
    if isinstance(stream, io.StringIO):  # tests
        line = stream.readline(MAX_LINE_BYTES + 1)
        if not line.endswith("\n"):
            raise EOFError
        return line
    fd = stream.fileno()
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) <= MAX_LINE_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise TimeoutError
        # One byte at a time, like person_session, so nothing past the newline
        # is consumed. The line is a few KB, so the syscalls don't matter.
        chunk = os.read(fd, 1)
        if not chunk:
            raise EOFError
        data.extend(chunk)
        if chunk == b"\n":
            return data.decode("utf-8")
    raise ValueError("launch secrets line too long")


def _apply(payload: object) -> None:
    global _connector_key
    if not isinstance(payload, dict):
        raise ValueError("launch secrets must be a JSON object")
    keys = payload.get("injectedKeys") or {}
    connector = payload.get("connectorEncryptionKey")
    if not isinstance(keys, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in keys.items()):
        raise ValueError("injectedKeys must map strings to strings")
    if connector is not None and not isinstance(connector, str):
        raise ValueError("connectorEncryptionKey must be a string")
    from services import settings
    settings.set_injected_keys({k: v for k, v in keys.items() if v})
    _connector_key = connector or None


def initialize(*, stdin=None, timeout: float = 5.0) -> None:
    """Read the launch-secrets line once, when Electron said it would send one.

    Call after person_session.initialize(), which reads the line before it."""
    global _read
    if _read or os.environ.get(STDIN_ENV) != "1":
        return
    _read = True
    stream = sys.stdin if stdin is None else stdin
    try:
        _apply(json.loads(_read_line(stream, timeout)))
    except (OSError, ValueError, EOFError, TimeoutError, UnicodeDecodeError):
        # json.JSONDecodeError is a ValueError. Never include the line itself.
        log.warning("Desktop launch secrets unavailable: missing or invalid startup pipe; "
                    "provider keys and the Krea connection are off this launch")


def reset_for_tests() -> None:
    global _connector_key, _read
    _connector_key = None
    _read = False
