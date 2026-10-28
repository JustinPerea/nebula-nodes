"""Round 19: agents, the cursor and the Agent log name a node as the canvas does.

Review 18, M-D: an unnamed key-routed node reads by its canvas title
(GM - Design, round 18, item 1: "Unnamed node: the default title drops the
route"), not its catalog name, everywhere a node is named: MCP results, the
cursor bubble, the Agent log and run refusals. The catalog (find_nodes,
describe_node, search) keeps the catalog names.

Review 18, L-A (GM's visual pass, check 1): a row on the gateway names its
route like any other ("“Alt still” · Grok Imagine 2.0 via Krea · price not
listed"), for nodes whose route depends on keys; with the route unknown,
"drop only the route": "Grok Imagine 2.0".
"""
from __future__ import annotations

import pytest

import main as main_module
from models.graph import GraphNode
from services import node_route
from services.cli_graph import CLIGraph

GROK = "krea-image-xai-grok-imagine-2"
AGENT = {"X-Nebula-Agent": "Codex"}


def _defs():
    return main_module.node_registry.get_all()


# -- M-D: one rule for a node's name -----------------------------------------------

def test_every_definition_names_an_unnamed_node_by_its_canvas_title(monkeypatch):
    defs = _defs()
    assert len(defs) == 308
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    wrong = []
    for definition_id, definition in defs.items():
        title = node_route.canvas_title(definition)
        node_id = graph.add_node(definition_id, {})
        named = {
            "helper": node_route.node_name(definition, None),
            "helper(catalog label)": node_route.node_name(definition, definition.get("displayName")),
            "helper(title label)": node_route.node_name(definition, title),
            "_node_label": main_module._node_label(node_id),
            "_run_node_name": main_module._run_node_name(
                node_id, {node_id: GraphNode(id=node_id, definitionId=definition_id)}),
        }
        graph.nodes[node_id]["label"] = definition.get("displayName")
        named["_node_label(catalog label)"] = main_module._node_label(node_id)
        wrong += [(definition_id, where, got, title) for where, got in named.items() if got != title]
    assert wrong == []


def test_a_name_of_its_own_is_kept(monkeypatch):
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    node_id = graph.add_node(GROK, {})
    graph.nodes[node_id]["label"] = "Alt still"
    assert main_module._node_label(node_id) == "Alt still"
    assert node_route.node_name(_defs()[GROK], "Alt still") == "Alt still"
    # Another model's stripped name is a name of its own.
    assert node_route.node_name(_defs()[GROK], "Nano Banana") == "Nano Banana"


def test_the_bubble_and_the_log_use_the_canvas_title(monkeypatch):
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    node_id = graph.add_node(GROK, {})
    assert main_module._did("Added", node_id)["label"] == "Grok Imagine 2.0"
    assert f"Added {main_module._quoted(main_module._node_label(node_id))}" == "Added “Grok Imagine 2.0”"


def test_a_run_refusal_names_the_node_by_its_canvas_title(monkeypatch):
    graph = CLIGraph()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    run_node = GraphNode(id="n9", definitionId=GROK)
    assert main_module._run_node_name("n9", {"n9": run_node}) == "Grok Imagine 2.0"
    # The open canvas's node by the same id, saved under the catalog name: unnamed.
    graph.nodes["n9"] = {"id": "n9", "definitionId": GROK, "params": {}, "label": "Grok Imagine 2.0 (Krea)"}
    assert main_module._run_node_name("n9", {"n9": run_node}) == "Grok Imagine 2.0"


def test_an_agent_reads_an_unnamed_node_by_its_canvas_title():
    from services.agent_presence import redacted_node

    definition = _defs()[GROK]
    entry = redacted_node("n1", {"definitionId": GROK, "params": {}}, definition, [])
    assert entry["name"] == "Grok Imagine 2.0"
    saved = redacted_node("n1", {"definitionId": GROK, "params": {}, "label": "Grok Imagine 2.0 (Krea)"}, definition, [])
    assert saved["name"] == "Grok Imagine 2.0" and "model" not in saved
    own = redacted_node("n1", {"definitionId": GROK, "params": {}, "label": "Alt still"}, definition, [])
    assert (own["name"], own["model"]) == ("Alt still", "Grok Imagine 2.0 (Krea)")


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    from services.agent_presence import AgentPresence
    from services.selection_context import SelectionContextStore

    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", CLIGraph())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    return TestClient(main_module.app), sent


def test_edit_canvas_names_an_added_unnamed_node_by_its_canvas_title(client):
    http, sent = client
    response = http.post("/api/graph/apply", headers=AGENT, json={"nodes": [{"ref": "+g", "definitionId": GROK}]})
    assert response.status_code == 200, response.text
    assert [row["name"] for row in response.json()["added"]] == ["Grok Imagine 2.0"]
    bubbles = [event for event in sent if event.get("type") == "agentPresence"]
    assert bubbles and all("(Krea)" not in str(event) for event in bubbles)


# -- L-A: the gateway route is named too ---------------------------------------------

def test_name_on_the_gateway_names_the_route_when_it_depends_on_keys():
    grok = _defs()[GROK]
    assert node_route.name_on_route(grok, "krea") == "Grok Imagine 2.0 via Krea"
    assert node_route.name_on_route(grok, "xai") == "Grok Imagine 2.0 via xAI"
    # No route given: the gateway's, as the canvas's nameOnRoute reads it.
    assert node_route.name_on_route(grok, None) == "Grok Imagine 2.0 via Krea"


def test_every_other_definition_keeps_its_name_on_the_gateway():
    for definition in _defs().values():
        gateway = definition.get("apiProvider")
        if node_route.canvas_title(definition) != definition.get("displayName"):
            stripped = node_route.canvas_title(definition)
            assert node_route.name_on_route(definition, gateway) == (
                f"{stripped} via {node_route.provider_label(gateway)}"), definition["id"]
            assert node_route.name_on_route(definition, None) == (
                f"{stripped} via {node_route.provider_label(gateway)}"), definition["id"]
        else:
            assert node_route.name_on_route(definition, gateway) == definition.get("displayName"), definition["id"]
            assert node_route.name_on_route(definition, None) == definition.get("displayName"), definition["id"]


def test_a_proposals_cost_label_names_the_gateway_route():
    from services.canvas_proposals import cost_for

    grok = _defs()[GROK]
    assert cost_for(grok, {}, None, {"KREA_API_TOKEN": "k"})["label"] == "paid · Grok Imagine 2.0 via Krea"
