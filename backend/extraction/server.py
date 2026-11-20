"""The extraction page's local server: measure-only records over HTTP on 127.0.0.1.

It never imports ``main``, the Commons store or the state folder, and it never
calls a model. Each launch makes a random token and prints the page's address
with the token in the URL fragment, which a browser keeps to itself (it isn't
sent to the server, so it can't reach a log or a query string).

One ASGI middleware runs before any route and refuses, in this order:

1. a ``Host`` that isn't this server's own (421), so a DNS-rebinding page
   can't talk to it;
2. an ``/api/*`` request without the launch token in ``X-Extraction-Token`` (401);
3. an ``Origin`` that isn't the page's own, including ``Origin: null`` (403),
   and any POST with no ``Origin`` at all (403). There are no CORS headers;
4. a body over the image cap plus a small margin (413), by ``Content-Length``
   and by counting the bytes actually read.
"""
from __future__ import annotations

import asyncio
import hmac
import mimetypes
import os
import re
import secrets
from pathlib import Path
from typing import Any, Awaitable, Callable, MutableMapping

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from commons import media
from commons.reader import AnalysisInvalid
from extraction import reader
from extraction import record as rec
from extraction import store
from extraction.errors import ExtractionRefused
from extraction.intake import IMAGE_CAP, intake, rendering_png

DEFAULT_PORT = 8870
DEV_PORT = 5870
HOST = "127.0.0.1"
TOKEN_HEADER = "x-extraction-token"
# A form around one image: the field names, the boundary lines and a short folder path.
BODY_MARGIN = 256 * 1024
BODY_CAP = IMAGE_CAP + BODY_MARGIN
DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist-extraction"
INDEX_FILE = "extraction.html"
NOT_BUILT = (
    "The extraction page isn't built yet.\n"
    "Run `npm run extraction:build` in the frontend folder, then reload this address.\n"
)
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    ),
}

_RECORD_ID = re.compile(r"^ex_[0-9a-f]{16}$")

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]


def allowed_hosts(port: int, dev: bool) -> frozenset[str]:
    """The ``Host`` values this server answers to."""
    ports = [port] + ([DEV_PORT] if dev else [])
    return frozenset(f"{name}:{p}" for p in ports for name in ("127.0.0.1", "localhost"))


def allowed_origins(port: int, dev: bool) -> frozenset[str]:
    """The ``Origin`` values the page can have: its own address, on either spelling of localhost."""
    ports = [port] + ([DEV_PORT] if dev else [])
    return frozenset(f"http://{name}:{p}" for p in ports for name in ("127.0.0.1", "localhost"))


def launch_line(token: str, port: int = DEFAULT_PORT, dev: bool = False) -> str:
    """The address to open: the token sits after ``#``, never in the path or query."""
    return f"http://{HOST}:{DEV_PORT if dev else port}/#token={token}"


def _refuse(status: int, sentence: str) -> JSONResponse:
    return JSONResponse({"error": sentence}, status_code=status, headers=SECURITY_HEADERS)


class _ReadBody(BaseModel):
    folder: str
    again: bool = False


class _CorrectionsBody(BaseModel):
    folder: str
    corrections: list[dict[str, Any]]


class _Guards:
    """Pure ASGI middleware: the Host, token, Origin and body-size checks, before any route."""

    def __init__(self, app: Callable[..., Awaitable[None]], *, token: str, hosts: frozenset[str],
                 origins: frozenset[str], cap: int) -> None:
        self.app = app
        self.token = token.encode()
        self.hosts = hosts
        self.origins = origins
        self.cap = cap

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            # No websockets here: close the handshake.
            await send({"type": "websocket.close", "code": 1008})
            return
        refusal = self._check(scope)
        if refusal is None:
            body = await self._read(scope, receive)
            if isinstance(body, JSONResponse):
                refusal = body
        if refusal is not None:
            await refusal(scope, receive, send)
            return
        await self.app(scope, _replay(body), send)  # type: ignore[arg-type]

    def _check(self, scope: Scope) -> JSONResponse | None:
        headers = {k: v for k, v in scope["headers"]}  # last of a repeated header wins
        host = headers.get(b"host", b"").decode("latin-1").lower()
        if host not in self.hosts:
            return _refuse(421, "This server only answers to its own address.")
        path = scope["path"]
        if path == "/api" or path.startswith("/api/"):
            sent = headers.get(TOKEN_HEADER.encode(), b"")
            if not hmac.compare_digest(sent, self.token):
                return _refuse(401, "The page needs the token from the address the server printed.")
        origin = headers.get(b"origin")
        if origin is not None:
            if origin.decode("latin-1") not in self.origins:
                return _refuse(403, "This request came from somewhere other than the page.")
        elif scope["method"] not in ("GET", "HEAD"):
            return _refuse(403, "This request didn't say where it came from.")
        length = headers.get(b"content-length")
        if length is not None:
            try:
                if int(length) > self.cap:
                    return _refuse(413, "That upload is too large.")
            except ValueError:
                return _refuse(400, "That request's length isn't a number.")
        return None

    async def _read(self, scope: Scope, receive: Receive) -> bytes | JSONResponse:
        """The whole body, counting bytes as they arrive so a body with no length can't pass the cap."""
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return _refuse(400, "The upload was cut off.")
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.cap:
                return _refuse(413, "That upload is too large.")
            chunks.append(chunk)
            if not message.get("more_body", False):
                return b"".join(chunks)


def _replay(body: bytes) -> Receive:
    sent = False

    async def receive() -> MutableMapping[str, Any]:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    return receive


def _clean_name(name: str | None) -> str | None:
    if not name:
        return None
    base = os.path.basename(name.replace("\\", "/"))
    base = "".join(ch for ch in base if ch.isprintable()).strip()[:200]
    return base or None


def _record_id(value: str) -> str:
    if not _RECORD_ID.match(value):
        raise ExtractionRefused("That isn't a record id.")
    return value


def create_app(token: str, *, port: int = DEFAULT_PORT, dev: bool = False,
               dist_dir: Path | str | None = None, spawn: Any = None,
               fake_reader: dict[str, Any] | None = None) -> FastAPI:
    """The app, with its guards. ``dist_dir`` is where the built page lives.

    A read uses the person's Claude usage, so it runs only from the page's Read button (this app's
    ``POST /api/records/{id}/read``). ``spawn`` replaces the process that runs the Claude CLI (tests pass a
    fake). ``fake_reader`` is development only: a structured output the server answers every read with, so
    no model is called and the record says ``fake-reader``.
    """
    dist = Path(dist_dir) if dist_dir is not None else DIST_DIR
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    read_lock = asyncio.Lock()  # one read at a time per server
    app.state.read_lock = read_lock

    @app.exception_handler(ExtractionRefused)
    async def _refused(_: Request, exc: ExtractionRefused) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=400, headers=SECURITY_HEADERS)

    @app.exception_handler(rec.RecordInvalid)
    async def _invalid(_: Request, exc: rec.RecordInvalid) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=400, headers=SECURITY_HEADERS)

    @app.exception_handler(RequestValidationError)
    async def _bad_form(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "That request is missing something the server needs."},
                            status_code=400, headers=SECURITY_HEADERS)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"error": "There's nothing at that address." if exc.status_code == 404
                             else "That request wasn't accepted."},
                            status_code=exc.status_code, headers=SECURITY_HEADERS)

    @app.get("/api/folder")
    def folder_records(path: str) -> dict[str, Any]:
        real = store.resolve_folder(path)
        return {"folder": real, "records": store.list_records(real)}

    @app.post("/api/records")
    def add_record(file: UploadFile = File(...), folder: str = Form(...), kind: str = Form(...),
                   name: str | None = Form(None)) -> dict[str, Any]:
        real = store.resolve_folder(folder)
        data = file.file.read(IMAGE_CAP + 1)
        item = intake(data, name=_clean_name(name) or _clean_name(file.filename), kind=kind)  # type: ignore[arg-type]
        record = rec.build_record(item)
        saved = store.save(record, rendering_png(item.image), item.data, item.ext, real)
        return {"record": saved["record"], "existed": saved["existed"]}

    @app.get("/api/records/{record_id}")
    def get_record(record_id: str, folder: str) -> dict[str, Any]:
        real = store.resolve_folder(folder)
        record = store.load(os.path.join(real, _record_id(record_id)))
        return {"record": record, "effective": rec.effective(record)}

    @app.get("/api/records/{record_id}/rendering")
    def get_rendering(record_id: str, folder: str) -> Response:
        real = store.resolve_folder(folder)
        png = store.rendering_bytes(os.path.join(real, _record_id(record_id)))
        return Response(png, media_type="image/png", headers={"Cache-Control": "no-store", **SECURITY_HEADERS})

    @app.post("/api/records/{record_id}/corrections")
    def add_corrections(record_id: str, body: _CorrectionsBody) -> dict[str, Any]:
        real = store.resolve_folder(body.folder)
        updated = store.correct(os.path.join(real, _record_id(record_id)), body.corrections, "person")
        return {"record": updated, "effective": rec.effective(updated)}

    @app.post("/api/records/{record_id}/read")
    async def read_record(record_id: str, body: _ReadBody) -> Response:
        if read_lock.locked():
            return _refuse(409, "A read is already running. Wait for it to finish, then try again.")
        async with read_lock:
            real = await asyncio.to_thread(store.resolve_folder, body.folder)
            directory = os.path.join(real, _record_id(record_id))
            record = await asyncio.to_thread(store.load, directory)
            if record["status"] == "approved":
                return _refuse(409, "That record is approved, so it can't be read again.")
            if record["structure"]["read"] is not None and not body.again:
                return _refuse(409, "That record has already been read. Choose Read again to replace the reading.")
            png = await asyncio.to_thread(store.rendering_bytes, directory)
            try:
                image = await asyncio.to_thread(media.load_image, png, "image/png", keep_alpha=True)
                model = reader.FAKE_MODEL if fake_reader is not None else reader.MODEL_ID
                structured = fake_reader if fake_reader is not None else await reader.ask(record, image, spawn=spawn)
                # The read can take minutes: apply it to the record as it is now, so a correction made
                # meanwhile is kept.
                fresh = await asyncio.to_thread(store.load, directory)
                updated = await asyncio.to_thread(reader.apply_read, fresh, image, structured, model=model)
            except reader.ReadFailed as exc:
                return _refuse(502, str(exc))
            except AnalysisInvalid as exc:
                return _refuse(502, f"The answer didn't fit what the page expects ({exc}). Nothing was changed.")
            except media.MediaError:
                return _refuse(400, "That record's image couldn't be read.")
            await asyncio.to_thread(store.write, directory, updated)
            return JSONResponse({"record": updated, "effective": rec.effective(updated)}, headers=SECURITY_HEADERS)

    @app.get("/{path:path}")
    def page(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise StarletteHTTPException(404)
        return _static(dist, path)

    app.add_middleware(_Guards, token=token, hosts=allowed_hosts(port, dev),
                       origins=allowed_origins(port, dev), cap=BODY_CAP)
    return app


def _static(dist: Path, path: str) -> Response:
    """A file from the built page; ``/`` is its index. A path can't leave ``dist``."""
    index = path in ("", "/")
    relative = INDEX_FILE if index else path
    root = os.path.realpath(dist)
    if not os.path.isdir(root):
        return PlainTextResponse(NOT_BUILT, status_code=200 if index else 404, headers=SECURITY_HEADERS)
    target = os.path.realpath(os.path.join(root, relative))
    inside = target == root or target.startswith(root + os.sep)
    if not inside or not os.path.isfile(target):
        if index:
            return PlainTextResponse(NOT_BUILT, headers=SECURITY_HEADERS)
        return PlainTextResponse("Not found.\n", status_code=404, headers=SECURITY_HEADERS)
    media = mimetypes.guess_type(target)[0] or "application/octet-stream"
    headers = dict(SECURITY_HEADERS)
    if target.endswith(".html"):
        headers["Cache-Control"] = "no-store"
    return FileResponse(target, media_type=media, headers=headers)


def serve(port: int = DEFAULT_PORT, dev: bool = False, fake_reader: str | None = None) -> int:
    """Start the server on 127.0.0.1 and print the page's address with its token.

    ``fake_reader`` (development only) is a JSON file whose contents answer every read; no model is called.
    """
    import sys

    import uvicorn

    fake = reader.load_fake(fake_reader) if fake_reader else None
    token = secrets.token_urlsafe(32)
    app = create_app(token, port=port, dev=dev, fake_reader=fake)
    print(launch_line(token, port, dev), flush=True)
    if fake is not None:
        print("Fake reader on: Read answers from the file you named. No model is called.", file=sys.stderr, flush=True)
    uvicorn.run(app, host=HOST, port=port, access_log=False, log_level="warning")
    return 0

