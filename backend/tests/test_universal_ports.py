"""Universal nodes' ports come from their model, on the backend.

The OpenRouter, Nous Portal and Replicate nodes' ports used to be worked out
only by the canvas's model pickers, so an agent could not build an OpenRouter
vision node or image-output node, and a Replicate wire was accepted by any
name but never drawn. services/universal_ports.py now has the rules; these
tests pin them against the pickers' old behaviour
(contracts/fixtures/universal-ports/picker-cases.json, written from a
verbatim copy of the old frontend code) and through every path that uses
them: an agent's edit, a proposal, the node routes, the picker's route, the
canvas export and the run check.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from services import universal_ports
from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.model_cache import model_cache
from services.port_contracts import ContractEdge, ContractNode, validate_edge_contracts
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from tests.conftest import PERSON

AGENT = {"X-Nebula-Agent": "Claude Desktop"}
PICKER = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "universal-ports"
                     / "picker-cases.json").read_text())

OPENROUTER_ROWS = [
    {"id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "input_modalities": ["text"],
     "output_modalities": ["text"], "context_length": 200000, "pricing": {}},
    {"id": "openai/gpt-4o", "name": "GPT-4o", "input_modalities": ["text", "image", "file"],
     "output_modalities": ["text"], "context_length": 128000, "pricing": {}},
    {"id": "google/gemini-2.5-flash-image", "name": "Nano Banana", "input_modalities": ["image", "text"],
     "output_modalities": ["image", "text"], "context_length": 32000, "pricing": {}},
]
KONTEXT = next(case["schema"] for case in PICKER["cases"] if case["name"] == "replicate image edit")


@pytest.fixture(autouse=True)
def empty_model_cache():
    model_cache.clear()
    yield
    model_cache.clear()


def _warm_openrouter():
    model_cache.set("openrouter:models", {"models": copy.deepcopy(OPENROUTER_ROWS), "count": 3}, ttl=300)


def _warm_replicate(model: str = "black-forest-labs/flux-kontext-pro", schema=None):
    model_cache.set(f"replicate:schema:{model}", {**copy.deepcopy(schema or KONTEXT), "model_id": model}, ttl=300)


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.sent = sent
    return ctx


def _apply(api, body, headers=AGENT):
    return api.client.post("/api/graph/apply", headers=headers, json=body)


def _export_node(api, node_id: str) -> dict:
    exported = api.client.get("/api/graph/export", headers=PERSON).json()
    return next(node for node in exported["nodes"] if node["id"] == node_id)


def _export_edges(api) -> list[dict]:
    return api.client.get("/api/graph/export", headers=PERSON).json()["edges"]


def _ids(ports):
    return [port["id"] for port in ports]


# -- the rules are the pickers' ---------------------------------------------

def _backend_result(case: dict) -> dict:
    definition_id = case["definitionId"]
    if definition_id == "replicate-universal":
        configured = universal_ports.configure(definition_id, case["params"], case["params"]["model_id"],
                                               case["schema"])
        return {
            "params": {k: v for k, v in configured.params.items() if k != universal_ports.PORTS_PARAM},
            "dynamicInputPorts": configured.inputs,
            "dynamicOutputPorts": configured.outputs,
            "dynamicParams": configured.dynamic_params,
            "providerMeta": {**case.get("providerMeta", {}), **configured.provider_meta},
        }
    configured = universal_ports.configure(definition_id, case["params"], case["model"], case["row"])
    return {
        "params": {k: v for k, v in configured.params.items() if k != universal_ports.PORTS_PARAM},
        "dynamicInputPorts": configured.inputs,
        "dynamicOutputPorts": configured.outputs,
        "keptEdgeIds": [edge["id"] for edge in case.get("edges", [])
                        if universal_ports.edge_fits(case["nodeId"], edge, configured.inputs, configured.outputs)],
    }


@pytest.mark.parametrize("case", PICKER["cases"], ids=[case["name"] for case in PICKER["cases"]])
def test_the_rules_are_the_pickers_rules(case):
    expected = {**case["expected"], **{key: value for key, value in PICKER["backendChanges"].get(case["name"], {}).items()
                                       if key != "why"}}
    assert _backend_result(case) == expected


def test_a_configured_node_keeps_its_ports_for_its_model_only():
    configured = universal_ports.configure("openrouter-universal", {}, "openai/gpt-4o", OPENROUTER_ROWS[1])
    params = configured.params
    assert params[universal_ports.PORTS_PARAM]["model"] == "openai/gpt-4o"
    assert universal_ports.stored_ports("openrouter-universal", params) == (configured.inputs, configured.outputs)
    # The model changed without configuring: the stamp no longer applies.
    assert universal_ports.stored_ports("openrouter-universal", {**params, "model": "x/y"}) is None
    # A saved node from before has no stamp; a forged one is cleaned.
    assert universal_ports.stored_ports("openrouter-universal", {"model": "openai/gpt-4o"}) is None
    forged = {"model": "a/b", universal_ports.PORTS_PARAM: {"model": "a/b", "inputs": [
        {"id": "x", "dataType": "Text", "required": "yes", "evil": 1}, {"id": 3}, "nope"], "outputs": []}}
    assert universal_ports.stored_ports("openrouter-universal", forged) == (
        [{"id": "x", "label": "x", "dataType": "Text", "required": False}], [])


def test_wires_are_checked_against_the_models_ports():
    import main

    definitions = main.node_registry.get_all()
    vision = universal_ports.configure("openrouter-universal", {}, "openai/gpt-4o", OPENROUTER_ROWS[1]).params
    painter = universal_ports.configure("openrouter-universal", {}, "google/gemini-2.5-flash-image",
                                        OPENROUTER_ROWS[2]).params
    edit = universal_ports.configure("replicate-universal", {}, "black-forest-labs/flux-kontext-pro", KONTEXT).params
    nodes = [ContractNode("n1", "image-input", {}), ContractNode("n2", "openrouter-universal", vision),
             ContractNode("n3", "openrouter-universal", painter), ContractNode("n4", "replicate-universal", edit),
             ContractNode("n5", "image-compare", {}), ContractNode("n6", "text-input", {})]
    edges = [ContractEdge("e1", "n1", "image", "n2", "images"),
             ContractEdge("e2", "n3", "image", "n5", "imageA"),
             ContractEdge("e3", "n1", "image", "n4", "input_image"),
             ContractEdge("e4", "n6", "text", "n4", "prompt"),
             ContractEdge("e5", "n2", "text", "n5", "imageB"),
             ContractEdge("e6", "n2", "image", "n5", "imageB")]
    result = validate_edge_contracts(nodes, edges, definitions)
    assert result.valid_edge_indexes == {0, 1, 2}
    messages = {issue.edge_index: issue.message for issue in result.issues}
    assert "Valid inputPorts: ['input_image']" in messages[3]
    assert "params" in messages[3]  # a Replicate model's other inputs are params
    assert "Incompatible port types" in messages[4]
    assert "Valid outputPorts: ['text']" in messages[5]


# -- an agent builds them ---------------------------------------------------

def test_an_agent_builds_a_vision_node_and_an_image_node_wired_onward(api):
    _warm_openrouter()
    response = _apply(api, {
        "note": "describe and repaint",
        "nodes": [
            {"ref": "+photo", "definitionId": "image-input"},
            {"ref": "+ask", "definitionId": "text-input", "params": {"value": "Describe it"}},
            {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}},
            {"ref": "+paint", "definitionId": "openrouter-universal",
             "params": {"model": "google/gemini-2.5-flash-image", "temperature": 0.5}},
            {"ref": "+compare", "definitionId": "image-compare"},
        ],
        "edges": [
            {"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"},
            {"source": "+ask", "sourceHandle": "text", "target": "+eye", "targetHandle": "messages"},
            {"source": "+eye", "sourceHandle": "text", "target": "+paint", "targetHandle": "messages"},
            {"source": "+paint", "sourceHandle": "image", "target": "+compare", "targetHandle": "imageA"},
        ],
    })
    assert response.status_code == 200, response.text
    body = response.json()
    eye, paint = body["idMap"]["+eye"], body["idMap"]["+paint"]
    assert body["summary"] == "added 5, connected 4"
    assert body["modelPorts"][eye] == {"model": "openai/gpt-4o", "inputs": ["messages", "images"], "outputs": ["text"]}
    assert body["modelPorts"][paint]["outputs"] == ["text", "image"]
    params = api.graph.nodes[paint]["params"]
    assert params["_output_image"] is True and params["temperature"] == 0.5
    assert api.graph.nodes[eye]["params"]["_output_image"] is False
    # The canvas gets the real ports and typed wires.
    node = _export_node(api, eye)
    assert _ids(node["data"]["dynamicInputPorts"]) == ["messages", "images"]
    assert node["data"]["dynamicInputPorts"][1]["multiple"] is True
    assert _ids(_export_node(api, paint)["data"]["dynamicOutputPorts"]) == ["text", "image"]
    wire = next(edge for edge in _export_edges(api) if edge["source"] == paint)
    assert wire["data"]["dataType"] == "Image"
    # And the run check agrees.
    from execution.engine import validate_graph
    from models.graph import GraphEdge, GraphNode

    graph_nodes, graph_edges = api.graph.to_execute_format()
    errors = validate_graph([GraphNode.model_validate(n) for n in graph_nodes],
                            [GraphEdge.model_validate(e) for e in graph_edges], {"OPENROUTER_API_KEY": "or-test"})
    # (image-compare's second image is unwired; that's all the check finds.)
    assert [e.message for e in errors] == ["Required input port 'imageB' is not connected"]


def test_an_agent_wires_a_replicate_file_input(api):
    _warm_replicate()
    response = _apply(api, {
        "nodes": [
            {"ref": "+photo", "definitionId": "image-input"},
            {"ref": "+edit", "definitionId": "replicate-universal",
             "params": {"model_id": "black-forest-labs/flux-kontext-pro", "prompt": "make it dusk"}},
            {"ref": "+compare", "definitionId": "image-compare"},
        ],
        "edges": [
            {"source": "+photo", "sourceHandle": "image", "target": "+edit", "targetHandle": "input_image"},
            {"source": "+edit", "sourceHandle": "image", "target": "+compare", "targetHandle": "imageA"},
        ],
    })
    assert response.status_code == 200, response.text
    edit = response.json()["idMap"]["+edit"]
    params = api.graph.nodes[edit]["params"]
    # The picker's params: the schema's defaults, the version, and the agent's own prompt.
    assert params["prompt"] == "make it dusk"
    assert params["aspect_ratio"] == "match_input_image" and params["safety_tolerance"] == 2
    assert params["_version_id"] == "v-kontext" and params["_schema_fetched"] is True
    node = _export_node(api, edit)
    assert _ids(node["data"]["dynamicInputPorts"]) == ["input_image"]
    assert _ids(node["data"]["dynamicOutputPorts"]) == ["image"]

    # A wire into a setting is refused, by name, instead of landing undrawn.
    refused = _apply(api, {
        "nodes": [{"ref": "+say", "definitionId": "text-input", "params": {"value": "x"}}],
        "edges": [{"source": "+say", "sourceHandle": "text", "target": edit, "targetHandle": "prompt"}],
    })
    assert refused.status_code == 400
    assert "input_image" in refused.json()["detail"] and "params" in refused.json()["detail"]


def test_without_the_key_the_refusal_says_so(api):
    # Nothing cached, no OpenRouter key in settings: the model's ports can't be read.
    refused = _apply(api, {
        "nodes": [
            {"ref": "+photo", "definitionId": "image-input"},
            {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}},
        ],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"}],
    })
    assert refused.status_code == 400
    detail = refused.json()["detail"]
    assert "OPENROUTER_API_KEY isn't set" in detail and "only the person can add it" in detail
    assert "+eye" in detail and "images" in detail
    assert api.graph.nodes == {}

    # The node's basic ports still take wires; the answer says why it has only those.
    applied = _apply(api, {
        "nodes": [
            {"ref": "+ask", "definitionId": "text-input", "params": {"value": "hi"}},
            {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}},
        ],
        "edges": [{"source": "+ask", "sourceHandle": "text", "target": "+eye", "targetHandle": "messages"}],
    })
    assert applied.status_code == 200, applied.text
    eye = applied.json()["idMap"]["+eye"]
    assert "OPENROUTER_API_KEY isn't set" in applied.json()["modelPortNotes"][eye]
    assert universal_ports.PORTS_PARAM not in api.graph.nodes[eye]["params"]

    refused = _apply(api, {
        "nodes": [{"ref": "+edit", "definitionId": "replicate-universal",
                   "params": {"model_id": "black-forest-labs/flux-kontext-pro"}},
                  {"ref": "+photo", "definitionId": "image-input"}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+edit", "targetHandle": "input_image"}],
    })
    assert refused.status_code == 400
    assert "REPLICATE_API_TOKEN isn't set" in refused.json()["detail"]


def test_changing_the_model_reconfigures_and_refuses_orphaned_wires(api):
    _warm_openrouter()
    built = _apply(api, {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"}],
    }).json()
    photo, eye = built["idMap"]["+photo"], built["idMap"]["+eye"]

    refused = _apply(api, {"params": [{"nodeId": eye, "params": {"model": "anthropic/claude-sonnet-4.5"}}]})
    assert refused.status_code == 400
    assert f"{photo}.image → {eye}.images" in refused.json()["detail"]
    assert "unwire" in refused.json()["detail"]
    assert api.graph.nodes[eye]["params"]["model"] == "openai/gpt-4o"

    moved = _apply(api, {
        "unwire": [{"source": photo, "sourceHandle": "image", "target": eye, "targetHandle": "images"}],
        "params": [{"nodeId": eye, "params": {"model": "google/gemini-2.5-flash-image"}}],
    })
    assert moved.status_code == 200, moved.text
    assert moved.json()["modelPorts"][eye]["outputs"] == ["text", "image"]
    assert api.graph.nodes[eye]["params"]["_output_image"] is True
    assert _ids(_export_node(api, eye)["data"]["dynamicOutputPorts"]) == ["text", "image"]


def test_agents_still_cannot_write_the_canvas_owned_params(api):
    _warm_openrouter()
    refused = _apply(api, {"nodes": [{"ref": "+eye", "definitionId": "openrouter-universal",
                                      "params": {"model": "openai/gpt-4o", "_model_ports": {}}}]})
    assert refused.status_code == 422


def test_the_node_routes_reconfigure_for_an_unnamed_caller_too(api):
    # The CLI without NEBULA_AGENT_NAME, or curl: not the person, so its node
    # gets its model's ports as an agent's does.
    _warm_openrouter()
    created = api.client.post("/api/graph/node", json={
        "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}})
    assert created.status_code == 200, created.text
    node_id = created.json()["id"]
    assert api.graph.nodes[node_id]["params"][universal_ports.PORTS_PARAM]["model"] == "openai/gpt-4o"

    updated = api.client.put(f"/api/graph/node/{node_id}",
                             json={"params": {"model": "google/gemini-2.5-flash-image"}})
    assert updated.status_code == 200, updated.text
    assert api.graph.nodes[node_id]["params"]["_output_image"] is True


def test_the_same_model_again_reads_nothing_unless_its_ports_are_stale(api, monkeypatch):
    import main as main_module

    _warm_openrouter()
    created = api.client.post("/api/graph/node", headers=AGENT, json={
        "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}})
    node_id = created.json()["id"]
    lookups: list[list] = []
    real = main_module._look_up_models

    async def counted(wanted):
        lookups.append(list(wanted))
        return await real(wanted)

    monkeypatch.setattr(main_module, "_look_up_models", counted)
    same = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT,
                          json={"params": {"model": "openai/gpt-4o", "temperature": 0.3}})
    assert same.status_code == 200, same.text
    assert lookups == []
    params = api.graph.nodes[node_id]["params"]
    assert params["temperature"] == 0.3
    assert universal_ports.stored_ports("openrouter-universal", params) is not None

    # A node saved before ports were kept gets them when its model is sent again.
    api.graph.nodes[node_id]["params"].pop(universal_ports.PORTS_PARAM)
    again = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": {"model": "openai/gpt-4o"}})
    assert again.status_code == 200, again.text
    assert lookups == [[("openrouter-universal", "openai/gpt-4o")]]
    assert universal_ports.stored_ports("openrouter-universal", api.graph.nodes[node_id]["params"]) is not None


def test_the_node_routes_reconfigure_for_anyone_but_the_person(api):
    _warm_openrouter()
    created = api.client.post("/api/graph/node", headers=AGENT, json={
        "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}})
    assert created.status_code == 200, created.text
    node_id = created.json()["id"]
    assert api.graph.nodes[node_id]["params"][universal_ports.PORTS_PARAM]["model"] == "openai/gpt-4o"

    updated = api.client.put(f"/api/graph/node/{node_id}", headers=AGENT,
                             json={"params": {"model": "google/gemini-2.5-flash-image"}})
    assert updated.status_code == 200, updated.text
    assert api.graph.nodes[node_id]["params"]["_output_image"] is True

    # The person's canvas pushes are stored as sent, as before (its picker uses /model).
    person = api.client.put(f"/api/graph/node/{node_id}", headers=PERSON,
                            json={"params": {"model": "anthropic/claude-sonnet-4.5"}})
    assert person.status_code == 200, person.text
    params = api.graph.nodes[node_id]["params"]
    assert params["_output_image"] is True  # untouched
    assert universal_ports.stored_ports("openrouter-universal", params) is None  # stamp no longer matches


def test_a_proposal_configures_when_the_person_accepts(api):
    _warm_openrouter()
    proposed = api.client.post("/api/canvas/proposals", headers=AGENT, json={
        "note": "look at it",
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"}],
    })
    assert proposed.status_code == 201, proposed.text
    proposal_id = proposed.json()["proposal"]["id"]
    key = next(m["acceptKey"] for m in api.sent
               if m.get("type") == "proposalOpened" and m["proposal"]["id"] == proposal_id)
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                               headers={**PERSON, "X-Nebula-Proposal-Key": key}, json={})
    assert accepted.status_code == 200, accepted.text
    eye = accepted.json()["idMap"]["+eye"]
    assert _ids(_export_node(api, eye)["data"]["dynamicInputPorts"]) == ["messages", "images"]


# -- the picker asks the backend --------------------------------------------

def test_the_picker_route_configures_the_node_and_prunes_its_wires(api):
    _warm_openrouter()
    photo = api.graph.add_node("image-input", {})
    ask = api.graph.add_node("text-input", {"value": "hi"})
    eye = api.graph.add_node("openrouter-universal", {"model": "openai/gpt-4o", "temperature": 0.3})
    api.graph.connect(photo, "image", eye, "images")
    api.graph.connect(ask, "text", eye, "messages")

    response = api.client.post(f"/api/graph/node/{eye}/model", headers=PERSON,
                               json={"model": "anthropic/claude-sonnet-4.5"})
    assert response.status_code == 200, response.text
    body = response.json()
    expected = universal_ports.configure("openrouter-universal", {"model": "openai/gpt-4o", "temperature": 0.3},
                                         "anthropic/claude-sonnet-4.5", OPENROUTER_ROWS[0])
    assert body["params"] == expected.params
    assert body["dynamicInputPorts"] == expected.inputs and body["dynamicOutputPorts"] == expected.outputs
    assert [edge["targetHandle"] for edge in body["removedEdges"]] == ["images"]
    assert [edge["targetHandle"] for edge in api.graph.edges] == ["messages"]
    assert api.graph.nodes[eye]["params"] == expected.params
    assert any(message.get("type") == "graphSync" for message in api.sent)

    # Agents set the model with edit_canvas; this route is the person's canvas's.
    assert api.client.post(f"/api/graph/node/{eye}/model", headers=AGENT,
                           json={"model": "openai/gpt-4o"}).status_code == 403
    # So is anyone else who isn't the person (the unnamed CLI, curl, a tab
    # without the person link): it would drop wires past the checks an edit gets.
    unnamed = api.client.post(f"/api/graph/node/{eye}/model", json={"model": "openai/gpt-4o"})
    assert unnamed.status_code == 403, unnamed.text
    assert unnamed.json()["code"] == "person_required"
    assert "PUT /api/graph/node" in unnamed.json()["detail"]


def test_the_picker_route_for_replicate_returns_the_inspectors_controls(api):
    _warm_replicate()
    node = api.graph.add_node("replicate-universal", {"model_id": "black-forest-labs/flux-kontext-pro"})
    response = api.client.post(f"/api/graph/node/{node}/model", headers=PERSON,
                               json={"model": "black-forest-labs/flux-kontext-pro"})
    assert response.status_code == 200, response.text
    body = response.json()
    case = next(case for case in PICKER["cases"] if case["name"] == "replicate image edit")
    assert body["dynamicParams"] == case["expected"]["dynamicParams"]
    assert body["providerMeta"] == {"version_id": "v-kontext", "description": "Edit images with text"}

    missing = api.client.post(f"/api/graph/node/{node}/model", headers=PERSON, json={"model": "nobody/uncached"})
    assert missing.status_code == 400
    assert "REPLICATE_API_TOKEN isn't set" in missing.json()["detail"]


def test_ports_for_a_model_without_a_node(api):
    _warm_openrouter()
    response = api.client.post("/api/universal/ports", headers=AGENT,
                               json={"definitionId": "openrouter-universal", "model": "openai/gpt-4o"})
    assert response.status_code == 200, response.text
    assert _ids(response.json()["inputs"]) == ["messages", "images"]
    with_params = api.client.post("/api/universal/ports", headers=PERSON, json={
        "definitionId": "openrouter-universal", "model": "openai/gpt-4o", "params": {"temperature": 0.2}}).json()
    assert with_params["nodeParams"] == universal_ports.configure(
        "openrouter-universal", {"temperature": 0.2}, "openai/gpt-4o", OPENROUTER_ROWS[1]).params
    assert api.client.post("/api/universal/ports", headers=AGENT,
                           json={"definitionId": "text-input", "model": "x"}).status_code == 400


def test_nous_reads_its_catalog_through_the_hermes_sign_in(api, monkeypatch):
    import routes.nous_proxy as nous_proxy
    from services.nous_auth import NousNotAuthenticatedError

    def signed_out():
        raise NousNotAuthenticatedError("Not signed in to Nous Portal")

    monkeypatch.setattr(nous_proxy, "load_nous_credential", signed_out)
    refused = _apply(api, {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+n", "definitionId": "nous-portal-universal", "params": {"model": "hermes/vl"}}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+n", "targetHandle": "images"}],
    })
    # Nous Portal's definition declares `images`, so its basic ports take the wire.
    assert refused.status_code == 200, refused.text
    assert "sign in" in refused.json()["modelPortNotes"][refused.json()["idMap"]["+n"]]


# -- the run sends what it sent ---------------------------------------------

class _Seen(list):
    """The requests sent; ``replicate_output`` is what a prediction returns."""
    replicate_output: object = "https://x.test/a.png"


@pytest.fixture
def provider_requests(monkeypatch):
    seen = _Seen()

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append({"method": request.method, "url": str(request.url), "json": body})
        if request.url.host == "openrouter.ai":
            if body and body.get("stream"):
                return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                      content=b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
            return httpx.Response(200, json={"choices": [{"message": {"content": "", "images": [
                {"image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}]}}]})
        if request.url.host == "api.replicate.com":
            return httpx.Response(201 if request.method == "POST" else 200, json={
                "id": "p1", "status": "succeeded", "output": seen.replicate_output, "urls": {}})
        return httpx.Response(418)

    original = httpx.AsyncClient.__init__

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(answer)
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", init)
    return seen


@pytest.mark.parametrize("name", ["openrouter vision model", "openrouter image output model",
                                  "replicate image edit", "replicate uploadable audio, object output"])
@pytest.mark.asyncio
async def test_a_configured_node_runs_as_the_pickers_did(name, provider_requests, monkeypatch, tmp_path):
    """The params the picker set and the params the backend sets (the same
    plus `_model_ports`) send the same request."""
    from handlers.openrouter import handle_openrouter_universal
    from handlers.replicate_universal import handle_replicate_universal
    from models.graph import GraphNode, PortValueDict
    import handlers.openrouter as openrouter_handler

    monkeypatch.setattr(openrouter_handler, "save_base64_image", lambda *a, **k: str(tmp_path / "out.png"),
                        raising=False)
    case = next(item for item in PICKER["cases"] if item["name"] == name)
    if name == "replicate uploadable audio, object output":
        # What the model returns: its run fills the Text port it declares
        # (a .png there would fail the run, as a contradiction).
        provider_requests.replicate_output = {"transcription": "hi"}
    legacy = case["expected"]["params"]
    backend = _backend_result(case)["params"]
    configured = universal_ports.configure(
        case["definitionId"], case["params"], case.get("model") or case["params"]["model_id"],
        case.get("row") or case["schema"]).params
    assert {k: v for k, v in configured.items() if k != universal_ports.PORTS_PARAM} == backend

    async def run(params):
        provider_requests.clear()
        node = GraphNode(id="n9", definitionId=case["definitionId"], params=params)
        if case["definitionId"] == "replicate-universal":
            await handle_replicate_universal(node, {"input_image": PortValueDict(type="Image", value="https://x.test/in.png")},
                                             {"REPLICATE_API_TOKEN": "r8-test"})
        else:
            await handle_openrouter_universal(node, {"messages": PortValueDict(type="Text", value="hi")},
                                              {"OPENROUTER_API_KEY": "or-test"})
        return copy.deepcopy(provider_requests)

    before = await run(legacy)
    assert before
    assert await run(configured) == before


def test_nebula_apply_prints_the_ports_a_model_gave():
    from cli.formatter import format_applied

    text = format_applied({
        "summary": "added 2", "idMap": {"+eye": "n2"}, "added": [{"id": "n2", "name": "OpenRouter"}],
        "modelPorts": {"n2": {"model": "openai/gpt-4o", "inputs": ["messages", "images"], "outputs": ["text"]}},
        "modelPortNotes": {"n3": "Nebula can't read Replicate's schema"},
    }, undo=False)
    assert "  Ports of n2 (openai/gpt-4o): in messages, images; out text" in text.splitlines()
    assert "  Ports of n3: Nebula can't read Replicate's schema" in text.splitlines()


def test_look_at_canvas_shows_a_universal_nodes_ports(api):
    _warm_openrouter()
    eye = _apply(api, {"nodes": [{"ref": "+eye", "definitionId": "openrouter-universal",
                                  "params": {"model": "openai/gpt-4o"}}]}).json()["idMap"]["+eye"]
    plain = api.graph.add_node("openrouter-universal", {"model": "openai/gpt-4o"})
    snapshot = api.client.get("/api/canvas/snapshot", headers=AGENT).json()
    nodes = {node["id"]: node for node in snapshot["nodes"]}
    assert nodes[eye]["ports"] == {"inputs": ["messages", "images"], "outputs": ["text"]}
    assert universal_ports.PORTS_PARAM not in nodes[eye]["params"]
    assert "ports" not in nodes[plain]  # never configured: describe_node's ports apply


def test_describe_node_says_the_ports_follow_the_model(api):
    for definition_id in ("openrouter-universal", "nous-portal-universal", "replicate-universal"):
        described = api.client.get(f"/api/agent/nodes/{definition_id}", headers=AGENT).json()
        assert "edit_canvas" in described["modelPorts"] and "modelPorts" in described["modelPorts"]
    assert "modelPorts" not in api.client.get("/api/agent/nodes/text-input", headers=AGENT).json()


def test_a_model_change_that_leaves_only_the_basic_ports_refuses_their_wires(api):
    """Clearing the model, or a model Nebula can't read, leaves the node its
    definition's ports. A wire on a port it had only from its old model
    would then stay on the graph unchecked, and every save of the canvas
    after it would be refused (saved edges are checked against the ports)."""
    _warm_openrouter()
    built = _apply(api, {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+eye", "definitionId": "openrouter-universal", "params": {"model": "openai/gpt-4o"}}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+eye", "targetHandle": "images"}],
    }).json()
    photo, eye = built["idMap"]["+photo"], built["idMap"]["+eye"]

    for model in ("", "nobody/unlisted"):
        refused = _apply(api, {"params": [{"nodeId": eye, "params": {"model": model}}]})
        assert refused.status_code == 400, (model, refused.text)
        assert f"{photo}.image → {eye}.images" in refused.json()["detail"]
        assert "unwire" in refused.json()["detail"]
        assert api.graph.nodes[eye]["params"]["model"] == "openai/gpt-4o"

        put = api.client.put(f"/api/graph/node/{eye}", headers=AGENT, json={"params": {"model": model}})
        assert put.status_code == 400, (model, put.text)
        assert api.graph.nodes[eye]["params"]["model"] == "openai/gpt-4o"

    # Unwired in the same edit, the change goes through and the graph stays valid.
    cleared = _apply(api, {
        "unwire": [{"source": photo, "sourceHandle": "image", "target": eye, "targetHandle": "images"}],
        "params": [{"nodeId": eye, "params": {"model": ""}}],
    })
    assert cleared.status_code == 200, cleared.text
    assert api.graph.edges == []
