"""Keep websites from driving the local Nebula backend.

The backend listens on 127.0.0.1 and has no login. Without this guard, any
web page Justin visits could:
  - open ws://127.0.0.1:<port>/ws/chat and start a networked agent turn on
    his subscription (WebSockets bypass CORS entirely), or
  - fire "simple" cross-site POSTs (no preflight) at state-changing routes, or
  - use DNS rebinding to make its own domain resolve to 127.0.0.1 and then
    read responses as same-origin.

Two checks, applied to every HTTP request and WebSocket before routing:
  1. Host allowlist: the Host header must name the loopback interface. A
     rebinding attack arrives with the attacker's domain in Host, so it stops
     here.
  2. Origin allowlist for WebSockets and state-changing HTTP methods. Browsers
     always send Origin on cross-origin POSTs (including `no-cors`) and on
     WebSocket handshakes, so a foreign page is always identifiable. Requests
     with no Origin come from non-browser clients (the `nebula` CLI, curl,
     agents' tools) and are allowed.

`file://` is allowed because the packaged desktop app loads its UI from a
file URL, and web pages can't forge that origin. `null` is rejected: any
website can produce it from a sandboxed iframe.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

ALLOWED_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})
# Starlette's TestClient sends `Host: testserver`. It isn't a resolvable
# public name, so a rebinding page can't arrive with it.
TEST_HOSTNAMES = frozenset({"testserver"})
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers") or []:
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def host_allowed(host: str | None) -> bool:
    """True when the Host header names the loopback interface."""
    if not host:
        return False
    try:
        hostname = urlsplit(f"//{host}").hostname
    except ValueError:
        return False
    return hostname in ALLOWED_HOSTNAMES or hostname in TEST_HOSTNAMES


def origin_allowed(origin: str | None) -> bool:
    """True for no Origin (non-browser), loopback origins, and file://."""
    if origin is None:
        return True
    if origin == "file://":
        return True
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname in ALLOWED_HOSTNAMES
        and (port is None or 1 <= port <= 65535)
        and parsed.username is None
        and parsed.password is None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
    )


class LocalRequestGuard:
    """ASGI middleware enforcing the Host and Origin allowlists."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")
        if kind not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        reason: str | None = None
        if not host_allowed(_header(scope, b"host")):
            reason = "Host not allowed"
        else:
            needs_origin_check = kind == "websocket" or scope.get("method") not in SAFE_METHODS
            if needs_origin_check and not origin_allowed(_header(scope, b"origin")):
                reason = "Origin not allowed"

        if reason is None:
            await self.app(scope, receive, send)
            return

        if kind == "websocket":
            # Reject the handshake before the app ever accepts it.
            await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = f'{{"detail":"{reason}"}}'.encode()
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})
