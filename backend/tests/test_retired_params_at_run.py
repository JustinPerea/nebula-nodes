"""Retired option values are replaced wherever a node runs, is created or is
edited, and in price estimates, not only when a graph is staged
(services/retired_nodes.py ``migrate_params``)."""
from __future__ import annotations

import base64
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from execution.engine import execute_graph
from models.graph import GraphEdge, GraphNode
from services import model_pricing
from services.agent_presence import AgentPresence
from services.canvas_events import CanvasEventJournal
from services.cli_graph import CLIGraph
from services.retired_nodes import migrate_param_update
from services.selection_context import SelectionContextStore
from tests.conftest import PERSON as PERSON_HEADERS

RED_PIXEL_B64 = base64.b64encode(
    base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
    )
).decode()


def _on(day: date):
    return patch("services.retired_nodes._today", return_value=day)


@pytest.mark.asyncio
async def test_a_canvas_opened_before_the_shutdown_sends_the_replacement_after_it(tmp_path):
    """The canvas still holds gpt-image-1 from before 2026-10-23; the run must not send it."""
    from handlers.openai_image import handle_openai_image_generate

    resp = MagicMock(status_code=200, raise_for_status=MagicMock())
    resp.json.return_value = {"data": [{"b64_json": RED_PIXEL_B64}]}
    client = AsyncMock()
    client.post.return_value = resp
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    async def emit(_event) -> None:
        pass

    nodes = [
        GraphNode(id="p", definitionId="text-input", params={"value": "a cat"}),
        GraphNode(id="g", definitionId="gpt-image-1-generate", params={"model": "gpt-image-1"}),
    ]
    edges = [GraphEdge(id="e", source="p", sourceHandle="text", target="g", targetHandle="prompt")]
    with patch("handlers.openai_image.httpx.AsyncClient", return_value=client), _on(date(2026, 10, 23)):
        await execute_graph(
            nodes=nodes, edges=edges, api_keys={"OPENAI_API_KEY": "sk-test"},
            handler_registry={"gpt-image-1-generate": handle_openai_image_generate}, emit=emit,
        )
    assert client.post.call_args.kwargs["json"]["model"] == "gpt-image-2.5-flare"
    assert nodes[1].params == {"model": "gpt-image-1"}, "the caller's node is not mutated"


def test_run_requests_are_normalized_before_validation_and_pricing():
    import main as main_module

    nodes = [GraphNode(id="t", definitionId="gemini-tts", params={"model": "gemini-3.1-flash-tts-preview"})]
    with _on(date(2026, 11, 16)):
        assert main_module._normalize_execute_nodes(nodes)[0].params["model"] == "gemini-3.1-flash-tts-preview"
    with _on(date(2026, 11, 17)):
        assert main_module._normalize_execute_nodes(nodes)[0].params["model"] == "gemini-3.8-flash-lite-tts"


def test_a_veo_preview_id_is_priced_like_the_vertex_id_it_runs_as():
    from services.node_registry import NodeRegistry

    definition = NodeRegistry().get_all()["veo-3"]
    import json
    entry = json.loads(model_pricing.PRICING_PATH.read_text())["nodes"]["veo-3"]
    preview = model_pricing.estimate_node(entry, definition, {"model": "veo-3.1-fast-generate-preview", "resolution": "720p"})
    vertex = model_pricing.estimate_node(entry, definition, {"model": "veo-3.1-fast-generate-001", "resolution": "720p"})
    assert preview is not None and preview == vertex


def test_a_partial_update_keeps_stored_params_the_fix_doesnt_need_to_change():
    with _on(date(2026, 10, 30)):
        update = migrate_param_update(
            "meshy-text-to-3d", {"target_polycount": 5000, "topology": "quad"}, {"model_type": "lowpoly"})
    assert update == {"model_type": "smart-topology", "topology": "triangle"}
    with _on(date(2026, 10, 29)):
        assert migrate_param_update("meshy-text-to-3d", {"target_polycount": 5000}, {"model_type": "lowpoly"}) == {
            "model_type": "lowpoly"}


@pytest.fixture()
def api(monkeypatch, person):
    import main as main_module

    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())

    async def _ignore(_data):
        pass

    monkeypatch.setattr(main_module.manager, "broadcast_raw", _ignore)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda *a: None)
    monkeypatch.setattr(main_module, "_workspace_context",
                        lambda: {"activeProjectId": "a" * 32, "workspaceRevision": "rev"})
    return TestClient(main_module.app), graph


def test_creating_and_editing_a_node_stores_the_current_value(api):
    client, graph = api
    created = client.post("/api/graph/node", headers=PERSON_HEADERS, json={
        "definitionId": "veo-3", "params": {"model": "veo-3.1-generate-preview"}})
    assert created.status_code == 200, created.text
    node_id = created.json()["id"]
    assert graph.nodes[node_id]["params"]["model"] == "veo-3.1-generate-001"

    tts = client.post("/api/graph/node", headers=PERSON_HEADERS, json={"definitionId": "gemini-tts", "params": {}})
    tts_id = tts.json()["id"]
    with _on(date(2026, 11, 17)):
        updated = client.put(f"/api/graph/node/{tts_id}", headers=PERSON_HEADERS,
                             json={"params": {"model": "gemini-2.5-pro-preview-tts"}})
    assert updated.status_code == 200, updated.text
    assert graph.nodes[tts_id]["params"]["model"] == "gemini-3.8-flash-tts"
