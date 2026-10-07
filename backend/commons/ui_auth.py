"""Per-launch human authority: stdin from Electron, or a TTY-only dev link."""
from __future__ import annotations

import io
import logging
import os
import secrets
import select
import sys
import time
from urllib.parse import urlsplit

from commons.actors import UISession

log = logging.getLogger(__name__)


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
    raise ValueError("UI session line too long")


def initialize_ui_session(session: UISession, *, stdin=None, stdout=None, timeout=5.0) -> None:
    if session.is_set:
        return  # Startup can be entered repeatedly by test lifespans.
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    if os.environ.get("NEBULA_UI_TOKEN_STDIN") == "1":
        try:
            session.set(_read_line(stdin, timeout).strip())
        except (OSError, ValueError, EOFError, TimeoutError):
            log.warning("Commons UI session unavailable: missing or invalid startup pipe")
        return

    token = secrets.token_urlsafe(32)
    session.set(token)
    if stdout.isatty():
        origin = os.environ.get("NEBULA_DEV_UI_ORIGIN", "http://localhost:5173")
        parsed = urlsplit(origin)
        # Never send a human to a remote origin with the fragment secret.
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or parsed.username or parsed.password:
            log.warning("Commons UI session unavailable: invalid dev UI origin")
            return
        origin = f"{parsed.scheme}://{parsed.netloc}"
        print(f"Commons UI: {origin}/#commons-token={token}", file=stdout, flush=True)
    else:
        log.info("Commons human UI unavailable: no terminal; open Nebula from the desktop app")
