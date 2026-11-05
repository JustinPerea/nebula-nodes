"""A file param's name (GM r48 Q1 on #222, services/upload_names.py).

Everywhere a file param's name shows, it is the name the file was uploaded
with when Nebula has one, else the path's base name, and never a bare
content hash ("Uploaded file"). /api/uploads records each upload's name
beside the content-hash store; the canvas reads it through GET
/api/uploads/names, and agents get the same resolved name in look_at_canvas
(MCP) and `nebula look` (CLI).
"""
from __future__ import annotations

import io
import re
from pathlib import Path

import pytest

import mcp_server
from cli.client import NebulaClient
from cli.formatter import _node_lines
from nebula_api import NebulaAPI
from services import upload_names
from services.agent_presence import redacted_node
from tests.conftest import PERSON
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_file_param_preview import _png

FRONTEND_FILE_NAME = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "fileName.ts"
HASH = "4" * 64


def _upload(api, name: str, rgb: tuple[int, int, int], create: bool = False) -> dict:  # noqa: F811
    resp = api.client.post("/api/uploads", files={"file": (name, io.BytesIO(_png(rgb)), "image/png")},
                           data={"create_node": "true" if create else "false"}, headers=PERSON)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _entry(api, node_id: str) -> dict:  # noqa: F811
    return next(n for n in api.client.get("/api/canvas/snapshot").json()["nodes"] if n["id"] == node_id)


@pytest.fixture
def agent(monkeypatch):
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN"):
        monkeypatch.delenv(name, raising=False)


def test_an_upload_records_its_name_and_the_canvas_reads_it(api):  # noqa: F811
    body = _upload(api, "harbour.png", (40, 120, 220))
    stored = Path(body["filePath"]).name
    assert re.fullmatch(r"[0-9a-f]{64}\.png", stored)
    resp = api.client.get("/api/uploads/names", params=[("file", stored), ("file", "nothing.png")])
    assert resp.status_code == 200
    assert resp.json() == {"names": {stored: "harbour.png"}}
    # The same bytes sent again under another name: the newer name.
    _upload(api, "harbour-again.png", (40, 120, 220))
    assert upload_names.recorded_name(body["filePath"]) == "harbour-again.png"


def test_a_sent_name_that_is_itself_a_hash_or_the_stored_name_records_nothing():
    upload_names.record(f"/out/chat-uploads/{HASH}.png", f"{HASH}.png")
    upload_names.record(f"/out/chat-uploads/{HASH}.png", "../" + "a" * 40 + ".png")
    upload_names.record(f"/out/chat-uploads/{HASH}.png", "")
    assert upload_names.recorded_name(f"{HASH}.png") is None


def test_the_name_rule():
    name = upload_names.file_param_name
    upload_names.record(f"/out/chat-uploads/{HASH}.png", "sunset.png")
    # 1. The node's own kept name, for filePath; else the upload record.
    kept = {"filePath": f"/out/chat-uploads/{HASH}.png", "_fileName": {"file": f"{HASH}.png", "name": "mine.png"}}
    assert name(kept, "filePath") == "mine.png"
    assert name({"filePath": f"/out/chat-uploads/{HASH}.png"}, "filePath") == "sunset.png"
    assert name({"lut": f"/x/{HASH}.png"}, "lut") == "sunset.png"
    # 2. Else the path's base name.
    assert name({"lut": "/looks/teal-orange.cube"}, "lut") == "teal-orange.cube"
    assert name({"filePath": "C:\\me\\b.png"}, "filePath") == "b.png"
    # 3. Never a bare content hash.
    other = "ab" * 32
    for value in (f"/out/chat-uploads/{other}.png", other, f"{'C' * 40}.jpeg", "0" * 32):
        assert name({"filePath": value}, "filePath") == "Uploaded file"
    assert name({"filePath": ""}, "filePath") is None
    assert name({}, "filePath") is None


def test_look_at_canvas_names_every_file_param_as_the_canvas_does():
    definition = {"params": [{"key": "lut", "type": "file"}, {"key": "source_image", "type": "file"}]}
    upload_names.record(f"/out/{HASH}.cube", "teal-orange.cube")
    entry = redacted_node("n1", {"definitionId": "cinema-look", "params": {
        "lut": f"/out/{HASH}.cube", "source_image": f"/out/{'e' * 64}.png"}}, definition, [])
    assert entry["fileNames"] == {"lut": "teal-orange.cube", "source_image": "Uploaded file"}
    assert "fileName" not in entry
    lines = _node_lines({**entry, "state": "idle", "position": {"x": 0, "y": 0}})
    assert '        file (lut): "teal-orange.cube"' in lines
    assert '        file (source_image): "Uploaded file"' in lines


def test_mcp_and_cli_name_an_agents_file_as_the_person_sees_it(api, agent, monkeypatch):  # noqa: F811
    """MCP parity: after an agent sets its own upload into the person's node,
    look_at_canvas says "harbour.png", the name the canvas shows, not the
    stored hash and not the person's old "sunset.png"."""
    person = _upload(api, "sunset.png", (220, 80, 40), create=True)
    agents = _upload(api, "harbour.png", (40, 120, 220))
    node_id = person["nodeId"]
    assert _entry(api, node_id)["fileName"] == "sunset.png"
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    mcp_server.edit_canvas(note="use the harbour", params=[{"nodeId": node_id, "params": {"filePath": agents["filePath"]}}])
    looked = next(n for n in mcp_server.look_at_canvas()["nodes"] if n["id"] == node_id)
    assert looked["fileName"] == "harbour.png"
    # The CLI's `nebula set` to a stored file Nebula has no name for.
    client = NebulaClient("http://testserver")
    client._client = api.client
    client.update_node(node_id, {"filePath": f"/out/chat-uploads/{HASH}.png"})
    entry = next(n for n in mcp_server.look_at_canvas()["nodes"] if n["id"] == node_id)
    assert entry["fileName"] == "Uploaded file"
    lines = _node_lines({**entry, "position": {"x": 0, "y": 0}})
    assert '        file: "Uploaded file"' in lines
    assert HASH not in str(entry.get("fileName")) and HASH not in str(entry.get("fileNames"))


def test_the_frontend_uses_the_same_hash_pattern_and_label():
    source = FRONTEND_FILE_NAME.read_text(encoding="utf-8")
    pattern = re.search(r"export const CONTENT_HASH_NAME = /(.+)/i;", source)
    label = re.search(r"export const UPLOADED_FILE = '([^']+)';", source)
    assert pattern and label
    assert pattern.group(1) == upload_names.CONTENT_HASH_NAME.pattern
    assert label.group(1) == upload_names.UPLOADED_FILE
