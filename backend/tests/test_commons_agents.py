from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mcp_server
from commons.skill import COMMONS_SKILL


def test_mcp_tools_registered_and_instructions_carry_the_skill():
    names = {t.name for t in mcp_server.mcp._tool_manager.list_tools()}
    assert {"commons_search", "commons_get", "commons_add", "commons_comment", "commons_borrow"} <= names
    assert "nothing in the commons fits" in mcp_server.mcp.instructions


def test_mcp_reports_nebula_not_running(monkeypatch):
    mcp_server.set_nebula_url("http://127.0.0.1:9")
    with pytest.raises(RuntimeError, match="isn't running"):
        mcp_server._commons_call("POST", "/api/commons/search", None, json={"query": "x"})


def test_mcp_add_uploads_local_bytes_never_a_path(tmp_path, monkeypatch):
    img = tmp_path / "r.png"
    buf = io.BytesIO()
    Image.fromarray(np.zeros((8, 8, 3), dtype=np.uint8)).save(buf, "PNG")
    img.write_bytes(buf.getvalue())
    sent = {}

    def fake_request(method, url, **kw):
        if url.endswith("/api/capabilities/commons"):
            return httpx.Response(200, json={"enabled": True}, request=httpx.Request(method, url))
        sent.update(method=method, url=url, **kw)
        return httpx.Response(200, json={"asset_id": "ast_x"}, request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    mcp_server._commons_add_impl(str(img), "col_1", "strong grid", "unknown", client_name="claude-code")
    assert sent["url"].endswith("/api/commons/add/upload")
    assert sent["headers"]["X-Nebula-Client"] == "claude-code"
    assert "files" in sent and str(img) not in json.dumps(sent.get("data", {}))


def test_mcp_get_fetches_pixels_through_the_scoped_blob_api(tmp_path, monkeypatch):
    key = "a" * 64 + ".png"
    buf = io.BytesIO()
    Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)).save(buf, "PNG")
    calls = []

    def fake_request(method, url, **kw):
        calls.append((method, url, kw.get("params")))
        request = httpx.Request(method, url)
        if "/api/commons/blobs/" in url:
            return httpx.Response(200, content=buf.getvalue(), request=request)
        return httpx.Response(200, json={"asset": {"media": "image", "blob_key": key},
                                         "blob_url": f"/api/commons/blobs/{key}"}, request=request)

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    monkeypatch.setattr(mcp_server._Path, "read_bytes", lambda self: pytest.fail("read the store from disk"))
    parts = mcp_server.commons_get("ast_1", brand="acme")
    assert calls[1][1].endswith(f"/api/commons/blobs/{key}") and calls[1][2] == {"brand": "acme"}
    assert len(parts) == 2 and parts[1].data == buf.getvalue()


def test_mcp_get_ignores_a_malformed_blob_key(monkeypatch):
    calls = []

    def fake_request(method, url, **kw):
        calls.append(url)
        return httpx.Response(200, json={"asset": {"media": "image", "blob_key": "../../etc/passwd"}},
                              request=httpx.Request(method, url))

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    assert len(mcp_server.commons_get("ast_1")) == 1 and len(calls) == 1


def test_mcp_get_returns_the_detail_when_the_pixels_are_refused(monkeypatch):
    key = "b" * 64 + ".png"

    def fake_request(method, url, **kw):
        request = httpx.Request(method, url)
        if "/api/commons/blobs/" in url:
            return httpx.Response(404, json={"detail": "Not found"}, request=request)
        return httpx.Response(200, json={"asset": {"id": "ast_1", "media": "image", "blob_key": key}}, request=request)

    monkeypatch.setattr(mcp_server.httpx, "request", fake_request)
    parts = mcp_server.commons_get("ast_1")
    assert json.loads(parts[0])["asset"]["id"] == "ast_1"
    assert len(parts) == 2 and "unavailable" in parts[1] and "404" in parts[1]


def test_cli_parser_has_commons_verbs():
    from cli.__main__ import build_parser

    args = build_parser().parse_args(["commons", "search", "dense grid", "--brand", "mitamaton"])
    assert args.command == "commons" and args.commons_cmd == "search" and args.query == "dense grid"


@pytest.mark.asyncio
async def test_run_claude_passes_agent_token_and_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    from services.chat_session import run_claude

    captured = {}
    proc = MagicMock()
    proc.stdout.readline = AsyncMock(side_effect=[b""])
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0

    async def fake(*args, **kwargs):
        captured["args"], captured["env"] = list(args), kwargs["env"]
        return proc

    with patch("services.chat_session.asyncio.create_subprocess_exec", side_effect=fake):
        [e async for e in run_claude("hi", None, "", extra_dirs=[tmp_path], workdir=tmp_path,
                                     agent_token="tok-123")]
    assert captured["env"]["NEBULA_AGENT_TOKEN"] == "tok-123"
    prompt = captured["args"][captured["args"].index("--append-system-prompt") + 1]
    assert "Using the commons" in prompt


@pytest.mark.parametrize('explicit_out', [False, True])
def test_cli_fetch_downloads_through_agent_auth(tmp_path, monkeypatch, capsys, explicit_out):
    import secrets
    from cli.__main__ import build_parser
    from cli.client import NebulaClient
    from cli.commands.commons import run
    from services.agent_workspaces import workspace_scope
    monkeypatch.chdir(tmp_path)
    token = secrets.token_urlsafe(32)
    monkeypatch.setenv('NEBULA_AGENT_TOKEN', token)
    calls = []
    key = 'a' * 64 + '.png'
    def respond(request):
        calls.append(request)
        if request.url.path == '/api/capabilities/commons':
            return httpx.Response(200, json={'enabled': True})
        if '/assets/' in request.url.path:
            return httpx.Response(200, json={'asset': {'blob_key': key}})
        return httpx.Response(200, content=b'pixels')
    client = NebulaClient()
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(respond), base_url=client.base_url)
    out = tmp_path / 'chosen' if explicit_out else tmp_path
    args = ['commons', 'fetch', 'ast_test', '--brand', 'acme']
    if explicit_out:
        args += ['--out', str(out)]
    try:
        with workspace_scope(tmp_path):
            run(client, build_parser().parse_args(args))
    finally:
        client._client.close()
    destination = Path(capsys.readouterr().out.strip())
    assert destination.parent == out and destination.read_bytes() == b'pixels'
    assert len(calls) == 3
    assert calls[0].url.path == '/api/capabilities/commons'
    assert calls[2].url.path == '/api/commons/blobs/' + key
    assert all(r.headers['Authorization'] == f'Agent {token}' for r in calls)
    assert all(r.url.params['brand'] == 'acme' for r in calls[1:])
