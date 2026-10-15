"""Every output handle a node can produce must be declared by its definition.

Saving a project (and importing or restoring a graph) rejects output handles
the node definition doesn't declare. The frontend persists whatever outputs
a run produced, so a node that writes an undeclared handle makes every later
autosave fail with "output handle ... is not declared". Image Compare did
this with imageA/imageB, Preview with input, Meshy with model_url and the
Remotion node with manifest.

These tests guard the whole class from both ends: the save path accepts real
run outputs, and every literal output key the engine or a handler writes is
declared by a definition (as a wireable ``outputPorts`` entry or as a
display-only ``displayOutputs`` entry).
"""

from __future__ import annotations

import ast
import inspect
import json
import sys
import textwrap
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from execution.engine import execute_graph
from execution.sync_runner import SYNC_HANDLERS
from models.events import ExecutedEvent
from models.graph import GraphEdge, GraphNode
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

BACKEND = Path(__file__).resolve().parents[1]
DEFINITIONS: dict[str, dict[str, Any]] = json.loads(
    (BACKEND / "data" / "node_definitions.json").read_text()
)


def _declared_outputs(definition: dict[str, Any]) -> set[str]:
    return {
        str(port["id"])
        for group in ("outputPorts", "displayOutputs")
        for port in definition.get(group, []) or []
    }


ALL_DECLARED = set().union(*(_declared_outputs(d) for d in DEFINITIONS.values()))


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", ProjectStore(tmp_path / "projects"))
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    return TestClient(main_module.app)


def _snapshot_node(node_id: str, definition_id: str, outputs: dict[str, Any], params=None) -> dict[str, Any]:
    return {
        "id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
        "data": {"definitionId": definition_id, "label": definition_id,
                 "params": params or {}, "outputs": outputs},
    }


async def _run(nodes: list[GraphNode], edges: list[GraphEdge]) -> dict[str, dict[str, Any]]:
    executed: dict[str, dict[str, Any]] = {}

    async def emit(event: Any) -> None:
        if isinstance(event, ExecutedEvent):
            executed[event.node_id] = event.outputs

    await execute_graph(nodes, edges, {}, {}, emit)
    return executed


@pytest.mark.asyncio
async def test_project_autosave_accepts_image_compare_and_preview_run_outputs(workspace, tmp_path) -> None:
    """The dry-run bug: run a graph with Image Compare, then autosave it."""
    image_a = tmp_path / "a.png"
    image_b = tmp_path / "b.png"
    image_a.write_bytes(b"\x89PNG\r\n\x1a\n")
    image_b.write_bytes(b"\x89PNG\r\n\x1a\n")
    nodes = [
        GraphNode(id="n1", definitionId="image-input", params={"filePath": str(image_a)}, outputs={}),
        GraphNode(id="n2", definitionId="image-input", params={"filePath": str(image_b)}, outputs={}),
        GraphNode(id="n3", definitionId="image-compare", params={}, outputs={}),
        GraphNode(id="n4", definitionId="preview", params={}, outputs={}),
    ]
    edges = [
        GraphEdge(id="e1", source="n1", sourceHandle="image", target="n3", targetHandle="imageA"),
        GraphEdge(id="e2", source="n2", sourceHandle="image", target="n3", targetHandle="imageB"),
        GraphEdge(id="e3", source="n1", sourceHandle="image", target="n4", targetHandle="input"),
    ]
    executed = await _run(nodes, edges)
    assert set(executed["n3"]) == {"imageA", "imageB"}
    assert set(executed["n4"]) == {"input"}

    created = workspace.post("/api/projects", json={"name": "Compare"}).json()
    snapshot = {
        "nodes": [
            _snapshot_node(node.id, node.definition_id, executed[node.id], node.params)
            for node in nodes
        ],
        "edges": [edge.model_dump(by_alias=True) for edge in edges],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    response = workspace.put(
        f"/api/projects/{created['project']['id']}",
        json={"snapshot": snapshot, "workspaceRevision": created["workspaceRevision"]},
    )

    assert response.status_code == 200, response.text


def test_display_outputs_are_not_wireable(workspace) -> None:
    """A display-only output can be saved, but nothing can be wired from it."""
    created = workspace.post("/api/projects", json={"name": "Compare"}).json()
    snapshot = {
        "nodes": [
            _snapshot_node("n1", "image-compare", {}),
            _snapshot_node("n2", "preview", {}),
        ],
        "edges": [{"id": "e1", "source": "n1", "sourceHandle": "imageA", "target": "n2", "targetHandle": "input"}],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    response = workspace.put(
        f"/api/projects/{created['project']['id']}",
        json={"snapshot": snapshot, "workspaceRevision": created["workspaceRevision"]},
    )

    assert response.status_code == 400
    assert "imageA" in response.text


def test_meshy_model_url_saves_and_wires_into_retexture(workspace) -> None:
    """Meshy's direct route writes model_url; it is now a real, wireable port."""
    created = workspace.post("/api/projects", json={"name": "Meshy"}).json()
    mesh_outputs = {
        "mesh": {"type": "Mesh", "value": "https://cdn.meshy.test/model.glb"},
        "model_url": {"type": "Text", "value": "https://cdn.meshy.test/model.glb"},
    }
    snapshot = {
        "nodes": [
            _snapshot_node("n1", "meshy-text-to-3d", mesh_outputs),
            _snapshot_node("n2", "meshy-retexture", {}),
        ],
        "edges": [{"id": "e1", "source": "n1", "sourceHandle": "model_url", "target": "n2", "targetHandle": "model_url"}],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    response = workspace.put(
        f"/api/projects/{created['project']['id']}",
        json={"snapshot": snapshot, "workspaceRevision": created["workspaceRevision"]},
    )

    assert response.status_code == 200, response.text


def test_saving_still_rejects_handles_no_definition_declares(workspace) -> None:
    created = workspace.post("/api/projects", json={"name": "Compare"}).json()
    snapshot = {
        "nodes": [_snapshot_node("n1", "image-compare", {"imageC": {"type": "Image", "value": "/x.png"}})],
        "edges": [],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    response = workspace.put(
        f"/api/projects/{created['project']['id']}",
        json={"snapshot": snapshot, "workspaceRevision": created["workspaceRevision"]},
    )

    assert response.status_code == 400
    assert "imageC" in response.text


def test_display_outputs_never_shadow_wireable_ports() -> None:
    for definition_id, definition in DEFINITIONS.items():
        wireable = {port["id"] for port in definition.get("outputPorts", [])}
        display = [port["id"] for port in definition.get("displayOutputs", []) or []]
        assert len(display) == len(set(display)), definition_id
        assert not wireable & set(display), definition_id


# --- Static guard for every output key the backend writes ------------------

def _is_port_value(node: ast.AST) -> bool:
    return isinstance(node, ast.Dict) and {
        key.value for key in node.keys if isinstance(key, ast.Constant)
    } >= {"type", "value"}


def _port_keys(tree: ast.AST) -> list[tuple[int, str]]:
    """Literal keys of output dicts: ``{"image": {"type": ..., "value": ...}}``."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and isinstance(key.value, str) and _is_port_value(value):
                    found.append((node.lineno, key.value))
    return found


def _outputs_assigned(statements: list[ast.stmt]) -> list[tuple[int, str]]:
    """Handles an engine branch writes into ``node_outputs``."""
    found: list[tuple[int, str]] = []
    for statement in statements:
        for node in ast.walk(statement):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if (
                    isinstance(target, ast.Name) and target.id == "node_outputs"
                    and isinstance(node.value, ast.Dict)
                ):
                    found.extend(
                        (node.lineno, key.value) for key in node.value.keys
                        if isinstance(key, ast.Constant) and isinstance(key.value, str)
                    )
                if (
                    isinstance(target, ast.Subscript)
                    and isinstance(target.value, ast.Name) and target.value.id == "node_outputs"
                    and isinstance(target.slice, ast.Constant) and isinstance(target.slice.value, str)
                ):
                    found.append((node.lineno, target.slice.value))
    return found


def _branch_definition_id(test: ast.expr) -> str | None:
    if (
        isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq)
        and isinstance(test.left, ast.Attribute) and test.left.attr == "definition_id"
        and isinstance(test.comparators[0], ast.Constant)
    ):
        return str(test.comparators[0].value)
    return None


def test_engine_local_nodes_only_write_declared_outputs() -> None:
    tree = ast.parse((BACKEND / "execution" / "engine.py").read_text())
    branches = 0
    undeclared: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If) or (definition_id := _branch_definition_id(node.test)) is None:
            continue
        definition = DEFINITIONS.get(definition_id)
        if definition is None:
            continue
        branches += 1
        declared = _declared_outputs(definition)
        undeclared.extend(
            f"engine.py:{line} {definition_id} writes '{handle}'"
            for line, handle in _outputs_assigned(node.body)
            if handle not in declared
        )
    assert branches >= 15, "engine branch scan found too few local nodes; update the scanner"
    assert not undeclared, "\n".join(undeclared)


def test_sync_handlers_only_return_declared_outputs() -> None:
    undeclared: list[str] = []
    for definition_id, handler in SYNC_HANDLERS.items():
        tree = ast.parse(textwrap.dedent(inspect.getsource(handler)))
        declared = _declared_outputs(DEFINITIONS[definition_id])
        undeclared.extend(
            f"{handler.__module__}:{handler.__name__} ({definition_id}) returns '{handle}'"
            for _, handle in _port_keys(tree)
            if handle not in declared
        )
    assert not undeclared, "\n".join(undeclared)


def test_every_literal_output_key_is_declared_by_some_definition() -> None:
    """Broad net for handlers dispatched outside SYNC_HANDLERS.

    It can't tell which definition a helper serves, so it only proves the key
    exists somewhere; the two tests above are exact for their nodes.
    """
    sources = sorted((BACKEND / "handlers").glob("*.py")) + sorted((BACKEND / "execution").glob("*.py"))
    undeclared = [
        f"{path.relative_to(BACKEND)}:{line} '{handle}'"
        for path in sources
        for line, handle in _port_keys(ast.parse(path.read_text()))
        if handle not in ALL_DECLARED
    ]
    assert not undeclared, "\n".join(undeclared)
