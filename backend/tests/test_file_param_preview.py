"""A file param's preview and name follow the file an agent sets (GM r46 Q2
on #222, services/file_param_preview.py).

The person uploads a file into an Image Input; an agent then points the
node at another file through MCP (edit_canvas, /api/graph/apply) or the CLI
(`nebula set`, PUT /api/graph/node/{id}). Agents can't write `_previewUrl`
or `_fileName`, so before this the old upload's preview stayed on the card
while a run read the agent's file.
"""
from __future__ import annotations

import io
import zlib
import struct

import pytest

import mcp_server
from cli.client import NebulaClient
from nebula_api import NebulaAPI
from services.input_file_name import input_file_name
from tests.conftest import PERSON
from tests.test_canvas_proposals import api  # noqa: F401 - fixture


def _png(rgb: tuple[int, int, int]) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"\x00" + bytes(rgb)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _upload(api, name: str, rgb: tuple[int, int, int], create: bool) -> dict:  # noqa: F811
    resp = api.client.post("/api/uploads", files={"file": (name, io.BytesIO(_png(rgb)), "image/png")},
                           data={"create_node": "true" if create else "false"}, headers=PERSON)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def held(api, monkeypatch):  # noqa: F811
    """A person's upload (an Image Input named sunset.png), and an agent's own
    upload of another file (not on the canvas), as upload_file leaves it."""
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    person = _upload(api, "sunset.png", (220, 80, 40), create=True)
    agents = _upload(api, "harbour.png", (40, 120, 220), create=False)
    node_id = person["nodeId"]
    params = api.graph.nodes[node_id]["params"]
    assert input_file_name(params) == "sunset.png" and params["_previewUrl"].endswith(".png")
    return api, node_id, params["_previewUrl"], agents


def _after(api, node_id):  # noqa: F811
    return api.graph.nodes[node_id]["params"]


def _cli(api, monkeypatch) -> NebulaClient:  # noqa: F811
    client = NebulaClient("http://testserver")
    client._client = api.client  # NEBULA_AGENT_NAME (held) marks it an agent's
    return client


def test_mcp_edit_canvas_moves_the_preview_and_name_to_the_agents_file(held, monkeypatch):
    api, node_id, before, agents = held
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    result = mcp_server.edit_canvas(note="use the harbour", params=[{"nodeId": node_id, "params": {"filePath": agents["filePath"]}}])
    assert result["status"] == "applied"
    params = _after(api, node_id)
    assert params["filePath"].endswith(agents["filePath"].split("/")[-1])
    assert params["_previewUrl"] == agents["url"] != before
    # The old upload's name goes with its file: the card shows the path's own name.
    assert "_fileName" not in params
    entry = next(n for n in api.client.get("/api/canvas/snapshot").json()["nodes"] if n["id"] == node_id)
    assert "fileName" not in entry


def test_cli_set_moves_the_preview_and_name_to_the_agents_file(held, monkeypatch):
    api, node_id, before, agents = held
    _cli(api, monkeypatch).update_node(node_id, {"filePath": agents["filePath"]})
    params = _after(api, node_id)
    assert params["_previewUrl"] == agents["url"] != before
    assert "_fileName" not in params


@pytest.mark.parametrize("path", ["/nowhere/never-made.png", "relative/missing.png"])
def test_a_file_nebula_cant_preview_clears_the_preview(held, monkeypatch, path):
    api, node_id, _before, _agents = held
    monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=api.client))
    mcp_server.edit_canvas(note="elsewhere", params=[{"nodeId": node_id, "params": {"filePath": path}}])
    params = _after(api, node_id)
    assert params["filePath"] == path
    assert "_previewUrl" not in params and "_fileName" not in params


def test_cli_set_to_a_missing_file_clears_the_preview(held, monkeypatch):
    api, node_id, _before, _agents = held
    _cli(api, monkeypatch).update_node(node_id, {"filePath": "/nowhere/never-made.png"})
    params = _after(api, node_id)
    assert "_previewUrl" not in params and "_fileName" not in params


def test_an_edit_of_another_param_or_the_same_file_keeps_the_preview(held, monkeypatch):
    api, node_id, before, _agents = held
    same = _after(api, node_id)["filePath"]
    _cli(api, monkeypatch).update_node(node_id, {"filePath": same})
    params = _after(api, node_id)
    assert params["_previewUrl"] == before and input_file_name(params) == "sunset.png"


def test_the_canvas_upload_keeps_the_fields_it_sends(held):
    """The person's own upload writes the file with its preview and name: kept as sent."""
    api, node_id, _before, agents = held
    sent = {"filePath": agents["filePath"], "_previewUrl": agents["url"],
            "_fileName": {"file": agents["filePath"].split("/")[-1], "name": "harbour.png"}}
    resp = api.client.put(f"/api/graph/node/{node_id}", json={"params": sent}, headers=PERSON)
    assert resp.status_code == 200, resp.text
    params = _after(api, node_id)
    assert params["_previewUrl"] == agents["url"] and input_file_name(params) == "harbour.png"


def test_agents_still_cant_set_the_preview_fields(held, monkeypatch):
    api, node_id, _before, _agents = held
    resp = api.client.put(f"/api/graph/node/{node_id}", json={"params": {"_previewUrl": "/api/outputs/x.png"}},
                          headers={"X-Nebula-Agent": "Codex"})
    assert resp.status_code == 422
    resp = api.client.post("/api/graph/apply", json={"note": "x", "params": [
        {"nodeId": node_id, "params": {"_fileName": {"file": "x.png", "name": "x.png"}}}]}, headers={"X-Nebula-Agent": "Codex"})
    assert resp.status_code in (400, 422)


def test_follow_file_params_unit():
    from services.file_param_preview import follow_file_params

    definition = {"params": [{"key": "filePath", "type": "file"}, {"key": "strength", "type": "float"}]}
    url = {"/out/b.png": "/api/outputs/b.png"}.get
    before = {"filePath": "/out/a.png", "_previewUrl": "/api/outputs/a.png", "_fileName": {"file": "a.png", "name": "A.png"}}
    assert follow_file_params(definition, before, {"filePath": "/out/b.png"}, url) == (
        {"filePath": "/out/b.png", "_previewUrl": "/api/outputs/b.png"}, ["_fileName"])
    assert follow_file_params(definition, before, {"filePath": "/x/c.png"}, url) == (
        {"filePath": "/x/c.png"}, ["_previewUrl", "_fileName"])
    assert follow_file_params(definition, before, {"strength": 0.2}, url) == ({"strength": 0.2}, [])
    assert follow_file_params(None, before, {"filePath": "/out/b.png"}, url) == ({"filePath": "/out/b.png"}, [])
