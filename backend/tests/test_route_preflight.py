"""The run preflight for route-table nodes (execution/engine.py validate_graph):
a run fails before any spend with the router's own reason, and never moves to
another provider because some other key is set."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from execution import engine  # noqa: E402
from models.graph import GraphEdge, GraphNode  # noqa: E402
from services import node_route  # noqa: E402

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "route_cases.json").read_text())
DEFINITION = FIXTURE["definitions"]["routes-image"]


@pytest.fixture(autouse=True)
def _fixture_node(monkeypatch):
    registry = dict(engine._registry_node_defs())
    registry.update(FIXTURE["definitions"])
    monkeypatch.setattr(engine, "_registry_node_defs", lambda: registry)


def _graph(params, images=0):
    nodes = [GraphNode(id="p", definitionId="text-input", params={"value": "a cat"}, outputs={}),
             GraphNode(id="n", definitionId=DEFINITION["id"], params=params, outputs={})]
    edges = [GraphEdge(id="p->n", source="p", sourceHandle="text", target="n", targetHandle="prompt")]
    for index in range(images):
        nodes.append(GraphNode(id=f"i{index}", definitionId="image-input", params={"filePath": "/x.png"}, outputs={}))
        edges.append(GraphEdge(id=f"i{index}->n", source=f"i{index}", sourceHandle="image", target="n",
                               targetHandle="images"))
    return nodes, edges


def _messages(params, keys, images=0):
    nodes, edges = _graph(params, images)
    return [error.message for error in engine.validate_graph(nodes, edges, keys) if error.node_id == "n"]


def test_auto_with_a_key_passes():
    assert _messages({}, {"FAL_KEY": "set"}) == []


def test_an_explicit_route_without_its_key_fails_even_with_other_keys():
    messages = _messages({"_provider": "replicate"}, {"BFL_API_KEY": "set", "FAL_KEY": "set"})
    expected = node_route.route_unavailable(DEFINITION, {"_provider": "replicate"},
                                            {"BFL_API_KEY": "set", "FAL_KEY": "set"})["message"]
    assert messages == [expected]
    assert "REPLICATE_API_TOKEN" in expected


def test_auto_blocked_by_a_param_fails_rather_than_moving_on():
    messages = _messages({"safety_tolerance": 6}, {"BFL_API_KEY": "set", "FAL_KEY": "set"})
    assert len(messages) == 1
    assert "can't run on Black Forest Labs" in messages[0]
    assert messages[0].endswith("fal.ai can take it.")  # offered, not taken


def test_too_many_wired_images_block_the_route():
    keys = {"OPENROUTER_API_KEY": "set"}
    assert _messages({"_provider": "openrouter"}, keys, images=4) == []
    messages = _messages({"_provider": "openrouter"}, keys, images=5)
    expected = node_route.route_unavailable(
        DEFINITION, node_route.with_wired_blockers(DEFINITION, {"_provider": "openrouter"}, {"images": 5}), keys)
    assert messages == [expected["message"]]
    assert expected["block"]["reason"] == node_route.PORTS


def test_no_key_names_every_route_key():
    messages = _messages({}, {})
    assert len(messages) == 1
    for key in ("BFL_API_KEY", "FAL_KEY", "REPLICATE_API_TOKEN", "OPENROUTER_API_KEY"):
        assert key in messages[0]


def _wired(definition_id, params, port, count):
    """Messages for a fixture node with ``count`` image inputs wired into ``port``."""
    nodes = [GraphNode(id="p", definitionId="text-input", params={"value": "a cat"}, outputs={}),
             GraphNode(id="n", definitionId=definition_id, params=params, outputs={})]
    edges = [GraphEdge(id="p->n", source="p", sourceHandle="text", target="n", targetHandle="prompt")]
    for index in range(count):
        nodes.append(GraphNode(id=f"i{index}", definitionId="image-input", params={"filePath": "/x.png"}, outputs={}))
        edges.append(GraphEdge(id=f"i{index}->n", source=f"i{index}", sourceHandle="image", target="n",
                               targetHandle=port))
    return nodes, edges


def test_a_plan_route_blocked_by_wired_ports_fails_before_any_spend(monkeypatch):
    """The plan is billed only when its route can take the run with what is
    wired, as the router reads it; a blocked plan run isn't waved through as
    a signed-in Krea run."""
    from services import krea_connector
    monkeypatch.setattr(krea_connector, "is_krea_connected", lambda: True)
    definition = FIXTURE["definitions"]["routes-video"]
    nodes, edges = _wired("routes-video", {"_provider": "krea-plan"}, "keyframes", 2)
    messages = [e.message for e in engine.validate_graph(nodes, edges, {}) if e.node_id == "n"]
    routed = node_route.with_wired_blockers(definition, {"_provider": "krea-plan"}, {"keyframes": 2})
    assert messages == [node_route.route_unavailable(definition, routed, {})["message"]]


def test_a_plan_route_a_wired_port_unblocks_needs_the_krea_sign_in(monkeypatch):
    """A plan run that only a wired input makes possible still checks the
    sign-in, and isn't refused for a route it doesn't take."""
    from services import krea_connector
    monkeypatch.setattr(krea_connector, "is_krea_connected", lambda: False)
    params = {"_kreaAuth": "mcp", "resolution": "2K"}
    nodes, edges = _wired("routes-krea", params, "style_image", 1)
    messages = [e.message for e in engine.validate_graph(nodes, edges, {"FAL_KEY": "set"}) if e.node_id == "n"]
    assert messages == ["Sign in to Krea in Settings before running this recipe"]
