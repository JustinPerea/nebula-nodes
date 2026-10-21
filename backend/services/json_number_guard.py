"""Refuse JSON request bodies whose numbers no route can use.

Starlette's ``Request.json()`` is plain ``json.loads(body)``. That takes
``NaN``, ``Infinity`` and ``-Infinity`` (not JSON, RFC 8259), turns ``1e400``
into ``inf``, and keeps integers of up to 4,300 digits. Routes then call
``float()`` or ``math.isfinite()`` on those values, and
``float(10**400)`` raises OverflowError: a 500 instead of a refusal.

``JsonNumberGuard`` checks the numbers in every JSON request body once,
before any route (on any router) sees it. A body FastAPI would read as JSON
(``application/json``, ``application/*+json``, or no content type with a
non-empty body; fastapi/routing.py), or that a route would (some take any
content type starting with ``application/json``, such as
``application/json-seq``: routes/commons.py ``json_body``, the Codex login
route), is buffered, parsed once with the checks below, and then replayed to
the app unchanged. A body whose first byte rules out a JSON number (a zip
sent with no content type) streams through instead, never held whole. A
number out of range gets a
422 ``{"detail": "<one line>"}``. Only number tokens count: a string holding
"NaN" or 400 digits is fine. A body that isn't valid JSON passes through, so
FastAPI and the routes keep their own errors.

Code that parses client JSON itself (a route reading ``request.body()``, the
graph.json in a restore bundle) uses ``loads_checked`` for the same rule.

In main.py it sits inside ``LocalRequestGuard`` (a foreign Host or Origin is
refused before the body is read) and inside ``CORSMiddleware`` (the 422
carries CORS headers for a localhost origin).
"""

from __future__ import annotations

import email.message
import json
import math
import sys
from typing import Any, Awaitable, Callable

FLOAT_MAX = sys.float_info.max
# Any integer of at most 308 digits is below FLOAT_MAX (about 1.8e308, 309
# digits), so those skip the int() conversion.
_SAFE_INT_DIGITS = 308
TOKEN_SHOWN = 40

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


def refusal_detail(token: str) -> str:
    """One plain line: the token found (cut to 40 characters) and what to send."""
    shown = token if len(token) <= TOKEN_SHOWN else token[:TOKEN_SHOWN] + "..."
    return (f"JSON number out of range: {shown}. "
            "Send a finite number between about -1.8e308 and 1.8e308.")


class JsonNumberOutOfRange(ValueError):
    """A NaN, an Infinity, or a number too big for a float, in client JSON."""

    def __init__(self, token: str) -> None:
        self.token = token
        super().__init__(refusal_detail(token))


def _refuse_constant(token: str) -> Any:
    raise JsonNumberOutOfRange(token)


def _checked_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise JsonNumberOutOfRange(token)
    return value


def _checked_int(token: str) -> int:
    if len(token) - (token[0] == "-") <= _SAFE_INT_DIGITS:
        return int(token)
    try:
        value = int(token)
    except ValueError:  # past int()'s 4,300-digit limit
        raise JsonNumberOutOfRange(token) from None
    if abs(value) > FLOAT_MAX:
        raise JsonNumberOutOfRange(token)
    return value


def loads_checked(data: str | bytes | bytearray, **kwargs: Any) -> Any:
    """``json.loads`` that raises JsonNumberOutOfRange (a ValueError) for a
    number out of range. Other bad JSON raises as ``json.loads`` does."""
    return json.loads(
        data,
        parse_constant=_refuse_constant,
        parse_float=_checked_float,
        parse_int=_checked_int,
        **kwargs,
    )


def check_numbers(body: bytes) -> None:
    """Raise JsonNumberOutOfRange when ``body`` holds a number out of range.
    A body that isn't valid JSON returns quietly (the route answers it)."""
    try:
        loads_checked(body)
    except JsonNumberOutOfRange:
        raise
    except (ValueError, RecursionError):
        return


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers") or []:
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def read_as_json(content_type: str | None) -> bool:
    """True when FastAPI would parse a body with this content type as JSON
    (fastapi/routing.py: no content type, or application/json or +json), or
    a route would: some accept any content type that starts with
    "application/json" (routes/commons.py json_body, the Codex login route)."""
    if not content_type:
        return True
    if content_type.strip().lower().startswith("application/json"):
        return True
    message = email.message.Message()
    message["content-type"] = content_type
    if message.get_content_maintype() != "application":
        return False
    subtype = message.get_content_subtype()
    return subtype == "json" or subtype.endswith("+json")


_WHITESPACE = b" \t\r\n"
# A JSON value with a number in it starts with one of these. NUL and bytes
# past ASCII stay in too: json.loads reads BOM, UTF-16 and UTF-32 bodies.
_NUMBER_STARTS = frozenset(b"{[-0123456789NI")


def _may_hold_numbers(first: int) -> bool:
    return first in _NUMBER_STARTS or first == 0 or first >= 0x80


def _replay(messages: list[Message], receive: Receive) -> Receive:
    pending = list(messages)

    async def replayed() -> Message:
        if pending:
            return pending.pop(0)
        return await receive()

    return replayed


class JsonNumberGuard:
    """ASGI middleware: a JSON body with a number out of range gets a 422."""

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or not read_as_json(_header(scope, b"content-type")):
            await self.app(scope, receive, send)
            return

        chunks: list[bytes] = []
        checking: bool | None = None  # decided by the first byte that isn't whitespace
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                # The client left mid-body: hand on what came, then this.
                arrived = [{"type": "http.request", "body": b"".join(chunks), "more_body": True}] if chunks else []
                await self.app(scope, _replay([*arrived, message], receive), send)
                return
            part = message.get("body", b"")
            chunks.append(part)
            if checking is None and (start := part.lstrip(_WHITESPACE)):
                checking = _may_hold_numbers(start[0])
            if not message.get("more_body", False):
                break
            if checking is False:
                # It can't be JSON with a number in it (a zip sent with no
                # content type, say): stream the rest instead of holding it.
                arrived = {"type": "http.request", "body": b"".join(chunks), "more_body": True}
                del chunks, message, part
                await self.app(scope, _replay([arrived], receive), send)
                return
        body = chunks[0] if len(chunks) == 1 else b"".join(chunks)
        # Hold the body once while the route runs, not the chunks beside it.
        del chunks, message, part

        if checking:
            try:
                check_numbers(body)
            except JsonNumberOutOfRange as exc:
                await _refuse(send, str(exc))
                return
        await self.app(scope, _replay([{"type": "http.request", "body": body, "more_body": False}], receive), send)


async def _refuse(send: Send, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send({
        "type": "http.response.start",
        "status": 422,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})
