"""Current Paper/Krea consumers enforce protected-file checks at byte boundaries.

All artwork and SQLite metadata are synthetic and temporary. No provider,
Paper desktop or real library is contacted.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from handlers import krea_gateway as gateway
from models.graph import GraphNode
from services.agent_workspaces import workspace_scope
from services.file_access import ProtectedPathError, validate_file_references
from services.paper_export_path import require_allowed_path as paper_export_path
from services.paper_sources import PaperSources


def png(color="red") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def files(tmp_path, monkeypatch):
    state, commons, outputs = tmp_path / "state", tmp_path / "custom-commons", tmp_path / "outputs"
    for variable, value in {
        "NEBULA_STATE_DIR": state, "NEBULA_COMMONS_ROOT": commons,
        "NEBULA_SETTINGS_PATH": tmp_path / "settings.png",
    }.items():
        monkeypatch.setenv(variable, str(value))
    state.mkdir()
    commons.mkdir()
    outputs.mkdir()
    import handlers.krea as legacy
    monkeypatch.setattr(legacy, "OUTPUT_ROOT", outputs)
    private = commons / "private.png"
    private.write_bytes(png("blue"))
    return {"root": tmp_path, "state": state, "commons": commons, "outputs": outputs, "private": private}


@pytest.mark.parametrize("reference", ["absolute", "absolute_alias", "served_alias", "loopback_alias", "relative_alias"])
def test_krea_gateway_refuses_protected_input_before_read_bytes(files, monkeypatch, reference):
    alias = files["outputs"] / "alias.png"
    alias.symlink_to(files["private"])
    value = {
        "absolute": str(files["private"]),
        "absolute_alias": str(alias),
        "served_alias": "/api/outputs/alias.png",
        "loopback_alias": "http://127.0.0.1:8000/api/outputs/alias.png",
        "relative_alias": "alias.png",
    }[reference]
    no_read = Mock(side_effect=AssertionError("protected Krea input reached read_bytes"))
    monkeypatch.setattr(Path, "read_bytes", no_read)
    with pytest.raises(ValueError):
        gateway._asset_data(value)
    no_read.assert_not_called()


@pytest.mark.asyncio
async def test_krea_decoded_json_effects_are_guarded_after_generic_graph_validation(files, monkeypatch):
    effect = {"id": "11111111-1111-4111-8111-111111111111", "name": "fixture",
              "asset_url": str(files["private"]), "asset_type": "image"}
    node = GraphNode(id="fixture", definitionId="krea-video-bytedance-seedance-2",
                     params={"prompt": "fixture", "effects": json.dumps([effect]), "duration": 4})
    # The raw graph value is JSON text; only the provider consumer interprets
    # its nested URI. The final byte boundary must enforce the same policy.
    validate_file_references(node.params)
    model = gateway._model(node.definition_id)
    body = await gateway._request_body(node, {}, model)
    no_read = Mock(side_effect=AssertionError("decoded protected path reached read_bytes"))
    monkeypatch.setattr(Path, "read_bytes", no_read)
    async def convert(value):
        return gateway._asset_data(value)
    with pytest.raises(ProtectedPathError):
        await gateway._map_body(body, model, convert)
    no_read.assert_not_called()


def test_krea_gateway_retains_allowed_artwork_and_scoped_own_workspace(files):
    ordinary = files["outputs"] / "logo.png"
    ordinary.write_bytes(png())
    assert gateway._asset_data(str(ordinary)) == ("logo.png", png(), "image/png")
    workspace = files["state"] / "agent-workspaces" / "brand" / "current"
    workspace.mkdir(parents=True)
    local = workspace / "downloaded-reference.png"
    local.write_bytes(png("green"))
    with workspace_scope(workspace):
        assert gateway._asset_data(str(local))[1] == png("green")


def test_paper_export_rejects_custom_commons_root_before_opening_png(files, monkeypatch):
    no_open = Mock(side_effect=AssertionError("Paper opened custom Commons pixels"))
    monkeypatch.setattr(Path, "open", no_open)
    with pytest.raises(ProtectedPathError):
        paper_export_path(files["private"])
    no_open.assert_not_called()


def test_paper_export_rejects_peer_workspace_from_authenticated_other_state(files, monkeypatch):
    # An authenticated request can identify a managed namespace different from
    # a caller's local environment; reserve that namespace's sibling leaves.
    base = files["root"] / "backend-state" / "agent-workspaces" / "brand"
    current, peer = base / "current", base / "peer"
    current.mkdir(parents=True)
    peer.mkdir()
    private = peer / "reference.png"
    private.write_bytes(png("blue"))
    no_open = Mock(side_effect=AssertionError("Paper opened a peer workspace"))
    monkeypatch.setattr(Path, "open", no_open)
    with workspace_scope(current), pytest.raises(ProtectedPathError):
        paper_export_path(private)
    no_open.assert_not_called()


class Capture:
    async def capture(self, identity, settings):
        return {**identity, "fileName": "fixture", "pageName": "fixture", "objectName": "fixture"}, png(), {"width": 8, "height": 8}


@pytest_asyncio.fixture
async def linked(files):
    sources = PaperSources(files["outputs"], Capture())
    source = await sources.link({"fileId": "file", "pageId": "page", "objectId": "logo"})
    return sources, source["snapshot"]


@pytest.mark.asyncio
async def test_paper_snapshot_returns_verified_path_instead_of_persisted_redirect(files, linked):
    sources, snapshot = linked
    modified = {**snapshot, "filePath": str(files["private"])}
    with sources.db() as db:
        db.execute("UPDATE snapshots SET record=? WHERE id=?", (json.dumps(modified), snapshot["id"]))
    verified = sources.snapshot(snapshot["id"], snapshot["hash"])
    assert verified["filePath"] == str(sources.root / (snapshot["id"] + ".png"))
    assert Path(verified["filePath"]).read_bytes() == png()
    assert verified["hash"] == snapshot["hash"]
    assert files["private"].read_bytes() == png("blue")


@pytest.mark.asyncio
async def test_paper_preview_serves_only_verified_artwork_after_metadata_redirect(files, linked, monkeypatch):
    from services import paper_routes
    sources, snapshot = linked
    with sources.db() as db:
        db.execute("UPDATE snapshots SET record=? WHERE id=?", (
            json.dumps({**snapshot, "filePath": str(files["private"])}), snapshot["id"]))
    monkeypatch.setattr(paper_routes, "paper_sources", sources)
    app = FastAPI()
    app.include_router(paper_routes.router)
    response = TestClient(app).get("/api/paper/snapshots/" + snapshot["id"])
    assert response.status_code == 200 and response.content == png()
    assert response.content != files["private"].read_bytes()
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


@pytest.mark.asyncio
async def test_paper_snapshot_refuses_protected_symlink_before_hash_read(files, linked, monkeypatch):
    sources, snapshot = linked
    path = sources.root / (snapshot["id"] + ".png")
    path.unlink()
    path.symlink_to(files["private"])
    no_read = Mock(side_effect=AssertionError("Paper hashed protected bytes"))
    monkeypatch.setattr(Path, "read_bytes", no_read)
    with pytest.raises(ProtectedPathError):
        sources.snapshot(snapshot["id"], snapshot["hash"])
    no_read.assert_not_called()


def test_paper_store_refuses_protected_output_root_before_directory_creation(files):
    with pytest.raises(ProtectedPathError):
        PaperSources(files["commons"], Capture())
    assert not (files["commons"] / "paper-sources").exists()
