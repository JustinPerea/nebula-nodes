"""Websites must not be able to drive the local backend (2026-09-25 fix)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.local_guard import LocalRequestGuard, host_allowed, origin_allowed


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/read")
    async def read() -> dict:
        return {"ok": True}

    @app.post("/write")
    async def write(body: dict) -> dict:
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_json({"ok": True})
        await websocket.close()

    app.add_middleware(LocalRequestGuard)
    return app


@pytest.mark.parametrize("host,ok", [
    ("127.0.0.1:8000", True),
    ("localhost:5173", True),
    ("[::1]:8000", True),
    ("testserver", True),
    ("evil.example:8000", False),  # DNS rebinding arrives with the attacker's name
    ("127.0.0.1.nip.io", False),
    ("", False),
    (None, False),
])
def test_host_allowlist(host, ok):
    assert host_allowed(host) is ok


@pytest.mark.parametrize("origin,ok", [
    (None, True),                      # CLI, curl, agent tools
    ("http://localhost:5173", True),
    ("http://127.0.0.1:8000", True),
    ("file://", True),                 # packaged desktop renderer
    ("null", False),                   # sandboxed iframe on any website
    ("https://evil.example", False),
    ("http://localhost.evil.example", False),
    ("http://127.0.0.1:8000/path", False),
    ("http://user@127.0.0.1:8000", False),
])
def test_origin_allowlist(origin, ok):
    assert origin_allowed(origin) is ok


def test_cross_site_post_is_rejected_before_parsing():
    client = TestClient(_app())
    # A `no-cors` POST from a website carries its Origin and no JSON type.
    resp = client.post("/write", content=b'{"a":1}', headers={"origin": "https://evil.example"})
    assert resp.status_code == 403


def test_local_ui_and_cli_writes_pass():
    client = TestClient(_app())
    assert client.post("/write", json={"a": 1}, headers={"origin": "http://localhost:5173"}).status_code == 200
    assert client.post("/write", json={"a": 1}).status_code == 200


def test_foreign_host_rejected_even_for_reads():
    client = TestClient(_app())
    assert client.get("/read", headers={"host": "evil.example"}).status_code == 403
    assert client.get("/read").status_code == 200


def test_websocket_from_foreign_origin_is_refused():
    client = TestClient(_app())
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}):
            pass
    assert exc.value.code == 1008


def test_websocket_from_local_ui_is_accepted():
    client = TestClient(_app())
    with client.websocket_connect("/ws", headers={"origin": "http://localhost:5173"}) as ws:
        assert ws.receive_json() == {"ok": True}


def test_real_chat_socket_refuses_foreign_origin():
    import main

    client = TestClient(main.app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/chat", headers={"origin": "https://evil.example"}):
            pass
