"""Round 14 of feat/agent-presence: review 13 and GM - Design's round-14 lines.

M-1. Round 13 refused a Krea node's run when a required field (Aspect ratio,
Width, ...) had nothing in it, reading only the definition. Three Krea copies
run on their maker's own API when that key is set (GPT Image 2.5 Flare and
Sunburst with an OpenAI key, Grok Imagine 2.0 with an xAI key), and those
APIs take the run without the field. Now the refusal follows the route the
run takes (node_route.select_route, as the router, pricing and the spend gate
read it): the Krea gateway (a token or the plan) needs every field; a maker's
API only the fields it sizes by (Seedream on BytePlus: width and height).

L-6. With no usable route (no key, the plan not signed in) no field is named:
the key or sign-in refusal comes first.

GM - Design, round 14, item 1 (verbatim): typed values use "Set" ("Nothing
ran. Set a width for “X” first."), pickers keep "Choose".

L-5. The model picker's failure header marks only a failed read of the
provider's settings; a missing key and a malformed id say so instead.

Every case runs with fake keys and a fake transport: nothing leaves the machine.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from services import model_choice
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _apply, _direct, _execute_body, pend  # noqa: F401 - fixture

CASES = json.loads((Path(__file__).parent / "fixtures" / "required_field_cases.json").read_text())["cases"]
TOPAZ = "krea-enhance-topaz-standard-enhance"
KREA2 = "krea-image-krea-krea-2-medium"
FLARE = "krea-image-openai-gpt-image-2-5-flare"
SUNBURST = "krea-image-openai-gpt-image-2-5-sunburst"
GROK = "krea-image-xai-grok-imagine-2"
SEEDREAMS = ["krea-image-bytedance-seedream-4", "krea-image-bytedance-seedream-5-lite",
             "krea-image-bytedance-seedream-5-pro"]
KREA_KEY = {"KREA_API_TOKEN": "fake-krea"}


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_route_decides_which_field_is_refused(case):
    found = model_choice.unchosen(case["definitionId"], case["params"], case["apiKeys"],
                                  wired=case.get("wired", ()), plan_ready=case.get("planReady", False))
    assert (list(found) if found else None) == case["expect"]


def test_the_direct_route_nodes_among_the_required_field_nodes():
    """Every Krea node with a required field that can also run on its maker's API."""
    from services import node_route
    from services.node_registry import NodeRegistry

    registry = NodeRegistry().get_all()
    direct = sorted(did for did in model_choice.required_fields() if node_route.direct_keys(registry[did]))
    assert direct == sorted([FLARE, SUNBURST, GROK, *SEEDREAMS])


@pytest.mark.parametrize(("field", "verb"), [
    ("width", "Set"), ("height", "Set"), ("name", "Set"),
    ("aspect ratio", "Choose"), ("resolution", "Choose"), ("model", "Choose"), ("version", "Choose"),
])
def test_gm_round14_set_for_typed_values_choose_for_pickers(field, verb):
    definition = {"width": TOPAZ, "height": TOPAZ, "name": "krea-style-train", "aspect ratio": KREA2,
                  "resolution": KREA2, "model": TOPAZ, "version": "krea-node-app"}[field]
    key = next(key for key, word in model_choice.required_fields()[definition] if word == field)
    assert model_choice.field_verb(definition, key) == verb
    article = "an" if field[0] in "aeiou" else "a"
    assert model_choice.not_chosen_line("Hero", field, verb) == f"{verb} {article} {field} for “Hero” first."


# -- the run paths, end to end, with fake keys and a fake transport -----------

SENT: list[tuple[str, str]] = []


class Intercepted(Exception):
    pass


@pytest.fixture
def maker_client(monkeypatch, person, spending_limits_off):
    """The real app, with fake maker keys in its settings; every outgoing
    request is recorded and stopped before it leaves (review 13's probe)."""
    async def fake_send(self, request, *args, **kwargs):
        SENT.append((request.method, str(request.url)))
        raise Intercepted(str(request.url))

    monkeypatch.setattr(httpx.AsyncClient, "send", fake_send)
    import main

    keys: dict[str, str] = {}
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(keys)})
    with TestClient(main.app) as client:
        client.keys = keys
        yield client


def _execute_node(client, definition_id: str, params: dict, run_id: str):
    SENT.clear()
    node = {"id": "n1", "definitionId": definition_id, "params": {"prompt": "a red cube", **params}}
    response = client.post("/api/execute-node", headers=PERSON,
                           json={"nodes": [node], "edges": [], "targetNodeId": "n1", "runId": run_id})
    assert response.status_code == 200, response.text
    for _ in range(80):
        if SENT:
            break
        time.sleep(0.05)
    return response.json()


@pytest.mark.parametrize(("definition_id", "key", "host"), [
    (FLARE, "OPENAI_API_KEY", "https://api.openai.com/"),
    (SUNBURST, "OPENAI_API_KEY", "https://api.openai.com/"),
    (GROK, "XAI_API_KEY", "https://api.x.ai/"),
])
def test_a_maker_key_runs_without_the_krea_only_field(maker_client, definition_id, key, host):
    maker_client.keys.update({key: "fake-maker"})
    body = _execute_node(maker_client, definition_id, {}, f"r-{definition_id}")
    assert body["status"] == "started", body
    assert SENT and SENT[0][1].startswith(host), SENT


@pytest.mark.parametrize("definition_id", SEEDREAMS)
def test_seedream_on_byteplus_needs_its_size_and_runs_with_it(maker_client, definition_id):
    maker_client.keys.update({"BYTEPLUS_API_KEY": "fake-byteplus"})
    refused = _execute_node(maker_client, definition_id, {}, f"r-{definition_id}-a")
    assert refused["status"] == "validation_error", refused
    assert refused["errors"][0]["person"].startswith("Set a width for “"), refused
    assert SENT == []
    ran = _execute_node(maker_client, definition_id, {"width": 2048, "height": 2048}, f"r-{definition_id}-b")
    assert ran["status"] == "started", ran
    assert SENT and "byteplus" in SENT[0][1], SENT


@pytest.mark.parametrize("definition_id", [FLARE, SUNBURST, GROK, *SEEDREAMS])
def test_the_krea_gateway_still_needs_the_field(maker_client, definition_id):
    maker_client.keys.update(KREA_KEY)
    body = _execute_node(maker_client, definition_id, {}, f"r-{definition_id}-krea")
    assert body["status"] == "validation_error", body
    assert body["errors"][0]["person"].split(" ")[0] in {"Choose", "Set"}
    assert SENT == []


def test_no_krea_token_says_add_the_token_not_the_field(maker_client):
    """L-6: Krea 2 Medium with no token: the key line, alone."""
    body = _execute_node(maker_client, KREA2, {}, "r-krea2-nokey")
    assert body["status"] == "validation_error", body
    lines = [error["person"] for error in body["errors"]]
    assert lines == ["Add your Krea API key in Settings, then run the node again."], lines


# -- review 13's B probes, adapted -------------------------------------------

def _keys(pend, monkeypatch, keys):
    monkeypatch.setattr(pend.main, "load_settings", lambda: {"apiKeys": dict(keys)})


def _real(pend, monkeypatch):
    from execution import engine
    monkeypatch.setattr(pend.main, "validate_graph", engine.validate_graph)


def _node(pend, definition_id, *, params=None, name="Hero"):
    body = {"note": "x", "nodes": [{"ref": "+k", "definitionId": definition_id, "params": params or {"prompt": "a cube"}}],
            "edges": [], "rename": {"+k": name}}
    response = _apply(pend, body, CLAUDE)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]["+k"]


def _quick(pend, monkeypatch, definition_id, keys):
    called = []

    async def fake(**kwargs):
        called.append(1)

    monkeypatch.setattr(pend.main, "execute_graph", fake)
    _keys(pend, monkeypatch, keys)
    inputs = {"image": "https://example.com/a.png"} if definition_id == TOPAZ else {"prompt": "a cube"}
    response = pend.client.post("/api/quick", headers=CLAUDE, json={"definitionId": definition_id, "inputs": inputs, "params": {}})
    return response, called


def test_b1_quick_topaz_says_set_a_width(pend, monkeypatch):
    response, called = _quick(pend, monkeypatch, TOPAZ, KREA_KEY)
    assert response.status_code == 400
    assert response.json()["detail"] == "Nothing ran, so nothing was spent. Set a width for “Topaz Standard (Krea)” first."
    assert called == [] and pend.priced == []


def test_b8_quick_krea2_with_a_token_says_choose(pend, monkeypatch):
    response, called = _quick(pend, monkeypatch, KREA2, KREA_KEY)
    assert response.status_code == 400
    assert response.json()["detail"] == "Nothing ran, so nothing was spent. Choose an aspect ratio for “Krea 2 Medium (Krea)” first."
    assert called == []


def test_b9_quick_gpt25_with_an_openai_key_is_not_refused(pend, monkeypatch):
    response, called = _quick(pend, monkeypatch, FLARE, {"OPENAI_API_KEY": "sk-fake"})
    assert response.status_code == 200, response.text
    assert called == [1]


def test_b4_whole_graph_without_a_token_names_only_the_key(pend, monkeypatch):
    _real(pend, monkeypatch)
    _keys(pend, monkeypatch, {})
    node_id = _node(pend, TOPAZ, params={}, name="Clean plate")
    body = pend.client.post("/api/graph/run", json={}, headers=CLAUDE).json()
    assert body["status"] == "failed", body
    assert body["errors"][node_id] == "Missing API key: KREA_API_TOKEN"
    assert pend.ran == []


def test_b7_run_nodes_krea2_without_a_token_names_only_the_key(pend, monkeypatch):
    _real(pend, monkeypatch)
    _keys(pend, monkeypatch, {})
    node_id = _node(pend, KREA2)
    body = pend.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=CLAUDE).json()
    assert body["errors"][node_id] == "Missing API key: KREA_API_TOKEN", body
    assert pend.ran == []


def test_b7b_run_nodes_krea2_with_a_token_names_the_field(pend, monkeypatch):
    _real(pend, monkeypatch)
    _keys(pend, monkeypatch, KREA_KEY)
    node_id = _node(pend, KREA2)
    body = pend.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=CLAUDE).json()
    assert body["errors"][node_id] == "Choose an aspect ratio for “Hero” first.", body
    assert body["error"] == "Nothing ran, so nothing was spent. n1 (Hero): Choose an aspect ratio for “Hero” first."


def test_b7c_run_nodes_gpt25_with_an_openai_key_runs(pend, monkeypatch):
    _real(pend, monkeypatch)
    _keys(pend, monkeypatch, {"OPENAI_API_KEY": "sk-fake"})
    node_id = _node(pend, FLARE)
    body = pend.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=CLAUDE).json()
    assert body["status"] == "finished", body
    assert pend.ran == [[node_id]]


@pytest.mark.parametrize(("definition_id", "line"), [
    (TOPAZ, "Set a width for “Hero” first."),
    (KREA2, "Choose an aspect ratio for “Hero” first."),
])
def test_b5_b6_an_approval_run_is_refused_before_spend(pend, monkeypatch, definition_id, line):
    seen = []

    async def spend(*args, **kwargs):
        seen.append(kwargs.get("approval_id"))

    monkeypatch.setattr(pend.main, "_require_run_spend_approval", spend)
    _keys(pend, monkeypatch, KREA_KEY)
    node_id = _node(pend, definition_id, params={})
    body = {**_execute_body(pend), "targetNodeId": node_id, "runId": f"r-{definition_id}", "approvalId": "ap-1"}
    answer = pend.client.post("/api/execute-node", headers=PERSON, json=body).json()
    assert answer["status"] == "validation_error", answer
    assert answer["errors"][0]["person"] == line
    assert seen == [] and pend.ran == []


def test_an_approval_run_of_gpt25_with_an_openai_key_is_not_refused(pend, monkeypatch):
    _keys(pend, monkeypatch, {"OPENAI_API_KEY": "sk-fake"})
    node_id = _node(pend, FLARE)
    body = {**_execute_body(pend), "targetNodeId": node_id, "runId": "r-flare"}
    answer = pend.client.post("/api/execute-node", headers=PERSON, json=body).json()
    assert answer.get("status") != "validation_error", answer


def test_style_training_says_set_a_name(pend, monkeypatch):
    _keys(pend, monkeypatch, KREA_KEY)
    from execution import engine
    from models.graph import GraphNode

    errors = engine.unchosen_model_errors([GraphNode(id="n1", definition_id="krea-style-train", params={})], [],
                                          KREA_KEY, name_of=lambda _id: "My style")
    assert [error.person for error in errors] == ["Set a name for “My style” first."]


# -- L-5: the model picker's failure header ------------------------------------

def _ports(client, definition_id, model):
    return client.post("/api/universal/ports", headers={**PERSON, "Origin": "http://127.0.0.1:5795"},
                       json={"definitionId": definition_id, "model": model, "params": {}})


@pytest.fixture
def picker_client(monkeypatch, person):
    async def no_send(self, request, *args, **kwargs):
        raise httpx.ConnectError("blocked by the test")

    monkeypatch.setattr(httpx.AsyncClient, "send", no_send)
    import main

    keys: dict[str, str] = {}
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(keys)})
    from routes import openrouter_proxy, replicate_proxy
    for module in (openrouter_proxy, replicate_proxy):
        if hasattr(module, "load_settings"):
            monkeypatch.setattr(module, "load_settings", lambda: {"apiKeys": dict(keys)})
    client = TestClient(main.app)
    client.keys = keys
    return client


@pytest.mark.parametrize(("definition_id", "model"), [
    ("openrouter-universal", "openai/gpt-4o-mini"),
    ("replicate-universal", "owner/name"),
])
def test_l5_a_missing_key_is_marked_as_one(picker_client, definition_id, model):
    response = _ports(picker_client, definition_id, model)
    assert response.status_code == 400
    assert response.headers.get("x-nebula-failure") == "missing-key"
    assert "x-nebula-failure" in response.headers.get("access-control-expose-headers", "").lower()


def test_l5_a_malformed_replicate_id_carries_no_header(picker_client):
    response = _ports(picker_client, "replicate-universal", "bad id")
    assert response.status_code == 400
    assert response.headers.get("x-nebula-failure") is None


@pytest.mark.parametrize(("definition_id", "model", "key"), [
    ("openrouter-universal", "openai/gpt-4o-mini", "OPENROUTER_API_KEY"),
    ("replicate-universal", "owner/name", "REPLICATE_API_TOKEN"),
])
def test_l5_a_failed_read_is_marked_model_settings(picker_client, definition_id, model, key):
    picker_client.keys.update({key: "fake"})
    response = _ports(picker_client, definition_id, model)
    assert response.status_code == 400, response.text
    assert response.headers.get("x-nebula-failure") == "model-settings"


def test_l5_a_missing_model_carries_no_header(picker_client):
    response = picker_client.post("/api/universal/ports", headers=PERSON, json={"definitionId": "openrouter-universal"})
    assert response.status_code == 400
    assert response.headers.get("x-nebula-failure") is None
