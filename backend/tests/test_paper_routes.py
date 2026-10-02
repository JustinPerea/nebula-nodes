"""Actual mounted HTTP routes with isolated portable Paper capture fixtures."""
from __future__ import annotations

import copy
import io
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main as main_module
import services.paper_routes as routes
from models.graph import GraphNode
from services.cli_graph import CLIGraph
from services.paper_sources import PaperSources
from services.paper_transport import PaperError


IDENTITY = {"fileId": "file-1", "pageId": "page-1", "objectId": "logo-1"}


def artwork(color):
    result = io.BytesIO()
    Image.new("RGBA", (14, 9), color).save(result, format="PNG")
    return result.getvalue()


class PortableTransport:
    def __init__(self):
        self.raw = artwork((255, 70, 50, 150))
        self.error = None
        self.calls = []

    def check(self):
        if self.error:
            raise self.error

    async def capture(self, identity, settings):
        self.check()
        self.calls.append((copy.deepcopy(identity), copy.deepcopy(settings)))
        return ({**identity, "fileName": "Fixture file", "pageName": "Fixture page",
                 "objectName": "Fixture logo", "navigation": "file",
                 "openUrl": "https://app.paper.design/file/file-1/page-1"},
                self.raw, {"width": 14, "height": 9})

    async def files(self):
        self.check()
        return {"files": [{"id": "file-1", "name": "Fixture file"}]}

    async def info(self, file_id, page_id=None):
        self.check()
        return {"file": {"id": file_id, "name": "Fixture file"},
                "pageId": page_id or "page-1", "pageName": "Fixture page"}

    async def selection(self, file_id=None):
        return {**await self.info(file_id or "file-1"), "selection": [{"id": "logo-2", "name": "Other logo"}]}

    async def object_info(self, file_id, page_id, object_id):
        return {**await self.info(file_id, page_id), "object": {"id": object_id, "name": "Fixture logo"}}

    async def open(self, identity):
        self.check()
        return {"navigation": "file", "objectNavigation": False, "url": identity["openUrl"]}


@pytest.fixture
def paper_http(tmp_path, monkeypatch):
    transport = PortableTransport()
    store = PaperSources(tmp_path, transport)
    monkeypatch.setattr(routes, "paper_sources", store)
    monkeypatch.setattr(main_module, "cli_graph", CLIGraph())
    execute = AsyncMock(side_effect=AssertionError("Paper refresh must never dispatch execution"))
    monkeypatch.setattr(main_module, "execute_graph", execute)
    return TestClient(main_module.app), store, transport, execute


def test_mounted_link_refresh_delivery_and_restart_history(paper_http, tmp_path):
    client, store, transport, execute = paper_http
    response = client.post("/api/paper/sources", json=IDENTITY)
    assert response.status_code == 200
    a = response.json()
    snapshot_response = client.get(a["snapshot"]["previewUrl"])
    assert snapshot_response.status_code == 200
    assert snapshot_response.content == transport.raw
    assert snapshot_response.headers["content-type"] == "image/png"
    assert "immutable" in snapshot_response.headers["cache-control"]

    unchanged = client.post(f"/api/paper/sources/{a['id']}/refresh")
    assert unchanged.status_code == 200 and unchanged.json()["changed"] is False
    transport.raw = artwork((40, 100, 255, 210))
    changed = client.post(f"/api/paper/sources/{a['id']}/refresh")
    assert changed.status_code == 200
    b = changed.json()
    assert b["changed"] is True and b["snapshot"]["id"] != a["snapshot"]["id"]
    assert client.get(a["snapshot"]["previewUrl"]).content == snapshot_response.content
    assert client.get(b["snapshot"]["previewUrl"]).content == transport.raw
    assert len(client.get(f"/api/paper/sources/{a['id']}").json()["snapshots"]) == 2
    assert PaperSources(tmp_path, transport).get(a["id"])["snapshot"] == b["snapshot"]
    execute.assert_not_called()


@pytest.mark.parametrize("state,status", [("missing", 409), ("unavailable", 503)])
def test_failed_refresh_http_includes_retained_good_source(paper_http, state, status):
    client, _, transport, execute = paper_http
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    transport.error = PaperError("Fixture source cannot be reached", state)
    response = client.post(f"/api/paper/sources/{a['id']}/refresh")
    assert response.status_code == status
    retained = response.json()["detail"]["source"]
    assert retained["snapshot"] == a["snapshot"]
    assert retained["lastSuccessfulRefresh"] == a["lastSuccessfulRefresh"]
    assert retained["state"] == state
    assert client.get(a["snapshot"]["previewUrl"]).status_code == 200
    execute.assert_not_called()


def test_explicit_reconnect_http_preserves_id_and_history(paper_http):
    client, _, transport, execute = paper_http
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    transport.error = PaperError("Deleted", "missing")
    assert client.post(f"/api/paper/sources/{a['id']}/refresh").status_code == 409
    transport.error = None
    response = client.post(f"/api/paper/sources/{a['id']}/reconnect", json={**IDENTITY, "objectId": "logo-2", "scale": "2x"})
    assert response.status_code == 200
    reconnected = response.json()
    assert reconnected["id"] == a["id"]
    assert reconnected["identity"]["objectId"] == "logo-2"
    assert reconnected["snapshot"]["exportSettings"]["scale"] == "2x"
    assert reconnected["snapshots"][0] == a["snapshot"]
    assert len(reconnected["snapshots"]) == 2
    execute.assert_not_called()


@pytest.mark.parametrize("body", [
    {"fileId": "file-1", "pageId": "page-1"},
    {**IDENTITY, "objectId": "../other"},
    {**IDENTITY, "scale": "10x"},
])
def test_invalid_link_request_cannot_capture(paper_http, body):
    client, _, transport, _ = paper_http
    assert client.post("/api/paper/sources", json=body).status_code == 422
    assert not transport.calls


def test_unknown_source_snapshot_and_tampered_snapshot_fail_closed(paper_http):
    client, _, _, _ = paper_http
    assert client.get("/api/paper/sources/unknown").status_code == 404
    assert client.post("/api/paper/sources/unknown/refresh").status_code == 404
    assert client.get("/api/paper/snapshots/not-a-hash").status_code == 404
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    Path(a["snapshot"]["filePath"]).write_bytes(b"corrupt image")
    assert client.get(a["snapshot"]["previewUrl"]).status_code == 503


def test_read_selection_does_not_retarget_link_and_open_reports_file_fallback(paper_http):
    client, store, transport, execute = paper_http
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    assert client.get("/api/paper/files").status_code == 200
    assert client.get("/api/paper/files/file-1?pageId=page-1").status_code == 200
    assert client.get("/api/paper/object", params=IDENTITY).json()["object"]["id"] == "logo-1"
    assert client.get("/api/paper/selection?fileId=file-1").json()["selection"][0]["id"] == "logo-2"
    assert store.get(a["id"])["identity"]["objectId"] == "logo-1"
    opened = client.post(f"/api/paper/sources/{a['id']}/open").json()
    assert opened["navigation"] == "file" and opened["objectNavigation"] is False
    assert len(transport.calls) == 1
    execute.assert_not_called()


def test_adopting_b_preserves_graph_edges_and_a_outputs_and_late_sync_cannot_rewind(paper_http):
    client, _, transport, execute = paper_http
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    source = client.post("/api/graph/node", json={"definitionId": "paper-source", "params": {"_paperSource": a}})
    assert source.status_code == 200
    downstream = client.post("/api/graph/node", json={"definitionId": "preview", "params": {}})
    assert downstream.status_code == 200
    source_id, target_id = source.json()["id"], downstream.json()["id"]
    connected = client.post("/api/graph/connect", json={"source": source_id, "sourceHandle": "image", "target": target_id, "targetHandle": "input"})
    assert connected.status_code == 200
    graph = main_module.cli_graph
    previous_outputs = {"image": {"type": "Image", "value": a["snapshot"]["filePath"]}}
    graph.nodes[source_id]["outputs"] = copy.deepcopy(previous_outputs)
    graph.nodes[target_id]["outputs"] = copy.deepcopy(previous_outputs)
    edges = copy.deepcopy(graph.edges)
    transport.raw = artwork((20, 210, 100, 255))
    b = client.post(f"/api/paper/sources/{a['id']}/refresh").json()
    assert client.put(f"/api/graph/node/{source_id}", json={"params": {"_paperSource": b}}).status_code == 200

    # An old source event can be recorded by run history without rewinding live B.
    assert main_module._sync_outputs_to_cli_graph(source_id, previous_outputs) == previous_outputs
    old_execution_node = GraphNode(id=source_id, definitionId="paper-source", params={"_paperSource": a})
    assert main_module._sync_params_to_cli_graph([old_execution_node]) is False
    assert graph.nodes[source_id]["params"]["_paperSource"]["snapshot"] == b["snapshot"]
    full_history = copy.deepcopy(b["snapshots"])
    compact_b = {**copy.deepcopy(b), "snapshots": [copy.deepcopy(b["snapshot"])]}
    compact_execution_node = GraphNode(id=source_id, definitionId="paper-source", params={"_paperSource": compact_b})
    assert main_module._sync_params_to_cli_graph([compact_execution_node]) is False
    assert graph.nodes[source_id]["params"]["_paperSource"]["snapshots"] == full_history
    assert [snapshot["id"] for snapshot in full_history] == [a["snapshot"]["id"], b["snapshot"]["id"]]
    assert main_module._sync_params_to_cli_graph([old_execution_node]) is False
    assert graph.nodes[source_id]["params"]["_paperSource"]["snapshots"] == full_history
    assert graph.nodes[target_id]["outputs"] == previous_outputs
    assert graph.edges == edges
    export = client.get("/api/graph/export").json()
    exported_source = next(node for node in export["nodes"] if node["id"] == source_id)
    assert exported_source["type"] == "paperSourceNode"
    assert exported_source["data"]["params"]["_paperSource"]["snapshot"] == b["snapshot"]
    assert exported_source["data"]["outputs"] == main_module._rewrite_output_paths(
        {"image": {"type": "Image", "value": b["snapshot"]["filePath"]}}
    )
    execute.assert_not_called()


@pytest.mark.parametrize("failure_state", [None, "unavailable", "missing"])
def test_export_resolves_canonical_full_history_and_failure_state_after_compacted_payload(paper_http, failure_state):
    client, store, transport, execute = paper_http
    a = client.post("/api/paper/sources", json=IDENTITY).json()
    source_response = client.post("/api/graph/node", json={"definitionId": "paper-source", "params": {"_paperSource": a}})
    assert source_response.status_code == 200
    source_id = source_response.json()["id"]
    transport.raw = artwork((80, 210, 20, 120))
    b = client.post(f"/api/paper/sources/{a['id']}/refresh").json()
    # Reproduce a historic compact run payload that kept only B in CLI params.
    compact_b = {**copy.deepcopy(b), "snapshots": [copy.deepcopy(b["snapshot"])]}
    main_module.cli_graph.nodes[source_id]["params"] = {"_paperSource": compact_b}
    main_module.cli_graph.nodes[source_id]["outputs"] = {"image": {"type": "Image", "value": a["snapshot"]["filePath"]}}
    if failure_state:
        transport.error = PaperError("Fixture refresh is unavailable", failure_state)
        failed = client.post(f"/api/paper/sources/{a['id']}/refresh")
        assert failed.status_code == (409 if failure_state == "missing" else 503)
    canonical = store.get(a["id"])
    calls_before = len(transport.calls)

    export = client.get("/api/graph/export")
    assert export.status_code == 200
    exported_source = next(node for node in export.json()["nodes"] if node["id"] == source_id)
    exported_record = exported_source["data"]["params"]["_paperSource"]
    assert exported_record == canonical
    assert [snapshot["id"] for snapshot in exported_record["snapshots"]] == [a["snapshot"]["id"], b["snapshot"]["id"]]
    assert exported_record["snapshot"] == b["snapshot"]
    assert exported_record["state"] == (failure_state or "current")
    if failure_state:
        assert exported_record["lastError"] == "Fixture refresh is unavailable"
        assert exported_record["lastSuccessfulRefresh"] == b["lastSuccessfulRefresh"]
    assert exported_source["data"]["outputs"] == main_module._rewrite_output_paths(
        {"image": {"type": "Image", "value": b["snapshot"]["filePath"]}}
    )
    assert len(transport.calls) == calls_before, "Graph export must not refresh Paper"
    execute.assert_not_called()


def test_initial_failed_link_exports_unavailable_exact_identity_without_invented_names(paper_http):
    client, _, transport, execute = paper_http
    transport.error = PaperError("Paper unavailable")
    failed = client.post("/api/paper/sources", json=IDENTITY)
    assert failed.status_code == 503
    source = failed.json()["detail"]["source"]
    assert source["identity"] == IDENTITY
    assert source["state"] == "unavailable"
    assert source["snapshots"] == [] and "snapshot" not in source
    assert "lastSuccessfulRefresh" not in source
    created = client.post("/api/graph/node", json={"definitionId": "paper-source", "params": {"_paperSource": source}})
    assert created.status_code == 200
    exported = next(node for node in client.get("/api/graph/export").json()["nodes"] if node["id"] == created.json()["id"])
    assert exported["type"] == "paperSourceNode"
    assert exported["data"]["state"] == "idle" and exported["data"]["outputs"] == {}
    assert exported["data"]["params"]["_paperSource"]["state"] == "unavailable"
    assert exported["data"]["params"]["_paperSource"]["identity"] == IDENTITY
    execute.assert_not_called()


def test_paper_catalog_has_local_typed_source_contract(paper_http):
    client, _, _, _ = paper_http
    result = client.get("/api/nodes/paper-source")
    assert result.status_code == 200
    definition = result.json()
    assert definition["category"] == "utility" and definition["apiProvider"] == "utility"
    assert definition["envKeyName"] == [] and definition["inputPorts"] == []
    assert definition["executionPattern"] == "sync"
    assert [(port["id"], port["dataType"]) for port in definition["outputPorts"]] == [("image", "Image")]
