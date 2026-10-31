"""PR #203 round 11: the CLI counts every cost class, refusals and hints in
their reader's words from one table, and settings.json's keys never
overwritten with a guess.

- Review 10, MEDIUM-1, and GM r21 item 1: `nebula propose` and `nebula
  proposal` count Krea-plan runs on their own, and a free run that calls a
  provider says which (cli/formatter._cost_line).
- Review 10, LOW-1: `nebula run`'s refusal is in CLI words over HTTP.
- Review 10, LOW-2: propose_change's description lists every cost class,
  written from model_pricing.CLASS_ENTRIES.
- Review 10, LOW-3: cost_for reads a route-table node's params as the
  router does, with the wired inputs.
- Review 10, NIT-3: a ghost card's cost tag is in its cost class.
- Review 10, NIT-4: one table of surface words, one CLI signal.
- Review 10, NIT-5: the spend gate reads the one cost class.
- Review 10, NIT-6: an unreadable `apiKeys` is never overwritten.
- Review 10, NIT-7: the settings signal skips unconfirmed tabs.
- GM r20 item 3 and r21: quoted names, and "Sign in to Krea in Settings".
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
import mcp_server
import project_client
import services.settings as settings
from cli.formatter import _cost_line, format_proposal
from services import agent_spend, agent_words, canvas_proposals, model_pricing, node_readiness, node_route
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, api  # noqa: F401 - fixture
from tests.test_idol_may_bill import SIGNED_IN, _idol_graph, gated  # noqa: F401 - fixture
from tests.test_idol_round10 import _promoted, sockets  # noqa: F401 - fixture
from tests.test_pending_nodes import pend  # noqa: F401 - fixture

BACKEND = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "pricing_cases.json").read_text(encoding="utf-8"))
REGISTRY = NodeRegistry().get_all()
CLI = {"X-Nebula-Surface": "cli"}


# -- the CLI's cost line (review 10, MEDIUM-1; GM r21 item 1) --------------------------------


def _entry(kind, label, **extra):
    return {"ref": f"+{label}", "nodeId": None, "kind": kind, "label": label, **extra}


PAID_AND_PLAN = {
    "upTo": True, "paidRuns": 1, "planRuns": 1, "mayCostRuns": 0, "freeRuns": 0, "providers": ["fal"],
    "estimate": {"low": 0.03, "high": 0.03, "open": False},
    "nodes": [_entry("paid", "paid · fal"), _entry("plan", "on Krea plan")],
}


@pytest.mark.parametrize("cost,line", [
    (PAID_AND_PLAN, "up to 1 paid run (fal) and 1 on the person's Krea plan, $0.03 at list prices"),
    ({"paidRuns": 0, "planRuns": 1, "freeRuns": 0, "nodes": [_entry("plan", "on Krea plan")]},
     "1 run on the person's Krea plan"),
    ({"paidRuns": 0, "planRuns": 2, "freeRuns": 1,
      "nodes": [_entry("plan", "on Krea plan"), _entry("plan", "on Krea plan"), _entry("free", "free · runs locally")]},
     "2 runs on the person's Krea plan and 1 free (local)"),
    # A sourced $0 and Idol without a token call a provider: never "runs locally".
    ({"paidRuns": 0, "freeRuns": 1, "nodes": [_entry("free", "free · fal.ai", provider="fal")]}, "1 free run (fal)"),
    ({"paidRuns": 0, "freeRuns": 2, "nodes": [_entry("free", "free · runs locally")] * 2},
     "2 free runs (runs locally)"),
    ({"paidRuns": 1, "mayCostRuns": 1, "planRuns": 1, "freeRuns": 2, "providers": ["openai"],
      "mayCost": [{"name": "Idol", "account": "Hugging Face"}],
      "estimate": {"low": 0.011, "high": 0.011, "open": True},
      "nodes": [_entry("paid", "paid · openai"), _entry("mayCost", "may cost · Hugging Face"),
                _entry("plan", "on Krea plan"), _entry("free", "free · fal.ai", provider="fal"),
                _entry("free", "free · runs locally")]},
     "1 paid run (openai), 1 that may bill the person's own account (Idol), 1 on the person's Krea plan "
     "and 2 free (1 fal, 1 local), $0.011+ at list prices"),
    ({"paidRuns": 2, "freeRuns": 0, "providers": ["anthropic"], "estimate": None},
     "2 paid runs (anthropic), no list price"),
], ids=["paid-and-plan", "plan-only", "plan-and-free", "sourced-zero", "local", "every-class", "no-price"])
def test_the_cli_counts_each_cost_class_on_its_own(cost, line):
    assert _cost_line(cost) == line
    assert ("free" in line) == bool(cost.get("freeRuns"))
    assert "runs locally" not in line or all(entry["label"] == "free · runs locally"
                                             for entry in cost["nodes"] if entry["kind"] == "free")


def test_nebula_propose_prints_the_plan_run_in_its_runs_line():
    view = {"id": "p1", "status": "open", "note": "two pictures", "expiresInSeconds": 600, "nodes": [], "edges": [],
            "params": [], "run": ["+img", "+krea"], "cost": PAID_AND_PLAN}
    text = format_proposal(view, created=True)
    assert ("  runs     +img, +krea — up to 1 paid run (fal) and 1 on the person's Krea plan, "
            "$0.03 at list prices") in text.splitlines()


def test_the_journal_counts_each_class(api):  # noqa: F811
    text = api.graph.add_node("text-input", {"value": "a cat"})
    api.graph.nodes[text]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    response = api.client.post("/api/canvas/proposals", headers=CLAUDE, json={
        "note": "one on the plan",
        "nodes": [{"ref": "+krea", "definitionId": "krea-2-generate", "params": {"_kreaAuth": "mcp"}}],
        "edges": [{"source": text, "sourceHandle": "text", "target": "+krea", "targetHandle": "prompt"}],
        "run": ["+krea"]})
    assert response.status_code == 201, response.text
    event = next(event for event in api.journal.read(after=0)["events"] if event["kind"] == "proposal.created")
    assert (event["data"]["paidRuns"], event["data"]["planRuns"], event["data"]["mayCostRuns"]) == (0, 1, 0)


# -- `nebula run`'s refusal over HTTP (review 10, LOW-1: B14) --------------------------------


@pytest.mark.parametrize("headers,expect,never", [
    (CLAUDE, "Propose it instead: propose_change (run: {idol})", "`nebula"),
    ({**CLAUDE, **CLI}, "Propose it instead: `nebula propose --note \"<why>\" --run {idol}`", "propose_change"),
], ids=["mcp", "cli"])
def test_nebula_runs_idol_refusal_names_its_own_command(gated, headers, expect, never):  # noqa: F811
    _, idol = _idol_graph(gated)
    gated.keys(SIGNED_IN)
    response = gated.client.post("/api/graph/run", headers=headers, json={"wait": 5, "targetNodeId": idol})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert expect.format(idol=idol) in detail and never not in detail
    assert gated.ran == []


@pytest.mark.parametrize("headers,expect,never", [
    (CLAUDE, "propose_change (run: {node})", "`nebula"),
    ({**CLAUDE, **CLI}, "`nebula propose --note \"<why>\" --run {node}`", "propose_change"),
], ids=["mcp", "cli"])
def test_a_spending_limit_refusal_names_its_own_command(gated, monkeypatch, headers, expect, never):  # noqa: F811
    text = gated.graph.add_node("text-input", {"value": "a cat"})
    gated.graph.nodes[text]["outputs"] = {"text": {"type": "Text", "value": "a cat"}}
    image = gated.graph.add_node("nano-banana", {})
    gated.graph.connect(text, "text", image, "prompt")
    real = gated.main.load_settings
    monkeypatch.setattr(gated.main, "load_settings", lambda *a, **k: {
        **real(*a, **k), "apiKeys": {"GEMINI_API_KEY": "fixture"}, "runCostConfirmUsd": 0.0001})
    response = gated.client.post("/api/graph/run", headers=headers, json={"wait": 5, "targetNodeId": image})
    assert response.status_code == 403, response.text
    detail = response.json()["detail"]
    assert expect.format(node=image) in detail and never not in detail
    assert gated.ran == []


# -- propose_change's description, from the one table (review 10, LOW-2) ---------------------


def test_propose_changes_description_lists_every_cost_class():
    import asyncio

    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    description = tools["propose_change"].description
    assert "<<COST_CLASSES>>" not in description
    assert set(model_pricing.CLASS_ENTRIES) == {model_pricing.PAID, model_pricing.PLAN, model_pricing.MAY_COST,
                                                model_pricing.FREE}
    for kind, entry in model_pricing.CLASS_ENTRIES.items():
        assert f"`{kind}`, {entry['label']}, counted in `cost.{entry['count']}`" in description
    assert '"on Krea plan"' in description and "`cost.planRuns`" in description
    # The counts are the keys summarize_cost writes.
    summary = canvas_proposals.summarize_cost([], up_to=False)
    assert {entry["count"] for entry in model_pricing.CLASS_ENTRIES.values()} <= set(summary)


# -- cost_for reads a route-table node as the router does (review 10, LOW-3: B6) -------------


@pytest.mark.parametrize("wired,kind", [((), "plan"), (("end_image",), "paid"), (("keyframes",), "paid")])
def test_a_wire_that_blocks_the_plan_route_is_read_by_cost_for(wired, kind):
    definition = REGISTRY["flux-3-video"]
    params = {"_provider": "krea", "_kreaAuth": "mcp"}
    keys = {"KREA_API_TOKEN": "k", "FAL_KEY": "f", "BFL_API_KEY": "b"}
    entry = canvas_proposals.cost_for(definition, params, REGISTRY, keys, wired=wired)
    estimate = model_pricing.estimate_run([{"id": "n", "definitionId": "flux-3-video", "params": params}],
                                          model_pricing.load_pricing(), REGISTRY, keys, wired={"n": list(wired)})
    assert entry["kind"] == kind == estimate["classes"]["n"]


def test_a_route_table_entry_takes_the_estimates_class():
    """The estimate knows the price (a sourced $0 is free); cost_for alone can't."""
    definition = REGISTRY["flux-3-video"]
    params = {"_provider": "krea", "_kreaAuth": "mcp"}
    entry = canvas_proposals.cost_for(definition, params, REGISTRY, {"KREA_API_TOKEN": "k"},
                                      cost_class=model_pricing.FREE)
    assert entry == {"kind": "free", "provider": "krea", "label": "free · Krea"}


# -- a ghost card's tag is in its cost class (review 10, NIT-3) ------------------------------


def test_a_sourced_zero_ghost_reads_free(monkeypatch):
    shipped = model_pricing.load_pricing()
    pricing = {**shipped, "nodes": {**shipped["nodes"], **CASES["pricing"]["nodes"]}}
    monkeypatch.setattr(model_pricing, "load_pricing", lambda: pricing)
    definitions = {**REGISTRY, **CASES["definitions"]}
    node = canvas_proposals.ProposedNode("+z", "zeroed", {}, None)
    tag = canvas_proposals._ghost_cost(node, definitions["zeroed"], definitions, {"FAL_KEY": "k"}, None, [])
    assert tag == {"kind": "free", "provider": "fal", "label": "free · fal.ai"}
    # Its run entry, when the proposal runs it, says the same.
    run_entry = {"ref": "+z", "kind": "free", "label": "free · fal.ai"}
    assert canvas_proposals._ghost_cost(node, definitions["zeroed"], definitions, {"FAL_KEY": "k"},
                                        run_entry, []) == tag


# -- one table of surface words (review 10, NIT-4) -------------------------------------------


def test_every_surface_call_comes_from_one_table():
    assert canvas_proposals.READY_NODES_MCP == agent_words.WORDS["mcp"]["find"] == "find_nodes"
    assert canvas_proposals.READY_NODES_CLI == agent_words.WORDS["cli"]["find"] == "`nebula nodes`"
    assert canvas_proposals.WITHDRAW_MCP == agent_words.WORDS["mcp"]["withdraw"]
    assert canvas_proposals.WITHDRAW_CLI == agent_words.WORDS["cli"]["withdraw"] == "nebula proposal withdraw {id}"
    assert agent_words.worded("{projects}", "cli") == "`nebula projects`"
    assert agent_words.worded("{projects}", "mcp") == "list_projects"
    assert set(agent_words.WORDS["mcp"]) == set(agent_words.WORDS["cli"])


def test_no_module_keeps_its_own_copy_of_the_cli_words():
    """The CLI words live in agent_words alone (and the CLI's own help)."""
    words = [agent_words.WORDS["cli"][name] for name in ("describe", "propose", "projects")]
    for path in (BACKEND / "main.py", BACKEND / "project_client.py", BACKEND / "services" / "canvas_proposals.py"):
        source = path.read_text(encoding="utf-8")
        for word in words:
            assert f'"{word}"' not in source, (path.name, word)


class _NoProjectOpen:
    base_url = "http://127.0.0.1:1"

    def request(self, method, path, **kwargs):
        return {"activeProjectId": None, "projects": []}


@pytest.mark.parametrize("headers,where", [(CLI, "`nebula projects`"), ({}, "list_projects")], ids=["cli", "mcp"])
def test_the_project_hint_reads_the_cli_signal(headers, where):
    with pytest.raises(project_client.ProjectRefError) as raised:
        project_client.project_ref(_NoProjectOpen(), "current", headers=headers)
    assert str(raised.value) == f"No project is open on the canvas: pass a project id from {where}."


def test_the_cli_sends_one_signal_and_no_via():
    import inspect

    from cli.client import NebulaClient

    assert "via" not in inspect.signature(project_client.project_ref).parameters
    assert "via" not in inspect.signature(main.agent_start_here).parameters
    assert "via=" not in inspect.getsource(NebulaClient)
    client = NebulaClient.__new__(NebulaClient)
    assert client._identity_headers()["X-Nebula-Surface"] == "cli"


# -- the spend gate reads the one cost class (review 10, NIT-5) ------------------------------


def _combos():
    every_key = {key: "k" for key in ("HF_TOKEN", "FAL_KEY", "KREA_API_TOKEN", "REPLICATE_API_TOKEN",
                                      "OPENAI_API_KEY", "GEMINI_API_KEY", "BFL_API_KEY", "XAI_API_KEY")}
    for definition_id, definition in sorted(REGISTRY.items()):
        params = [{}]
        for route in definition.get("routes") or []:
            if isinstance(route, dict) and route.get("provider"):
                params.append({"_provider": route["provider"]})
        for param in params:
            for keys in ({}, SIGNED_IN, every_key):
                yield definition_id, param, keys


def test_the_gate_holds_exactly_the_nodes_may_bill_holds():
    """The reach is unchanged: on every node, route and key set, the cost
    class's mayCost is node_route.may_bill, so the gate allows and refuses
    the same runs before and after."""
    disagree = []
    for definition_id, params, keys in _combos():
        definition = REGISTRY[definition_id]
        item = [{"id": "n", "definitionId": definition_id, "params": params}]
        gated_now = agent_spend.may_bill_nodes(item, REGISTRY, keys) == ["n"]
        if gated_now != node_route.may_bill(definition, params, keys):
            disagree.append((definition_id, params, sorted(keys)))
    assert disagree == []
    assert agent_spend.may_bill_nodes([{"id": "i", "definitionId": "speridlabs-idol", "params": {}}],
                                      REGISTRY, SIGNED_IN) == ["i"]
    assert agent_spend.may_bill_nodes([{"id": "g", "definitionId": "gone", "params": {}}], REGISTRY, SIGNED_IN) == []


# -- an unreadable apiKeys is kept as it is (review 10, NIT-6) -------------------------------


@pytest.mark.parametrize("raw", [["sk-a"], "sk-a", 42], ids=["list", "string", "number"])
def test_unreadable_keys_are_never_overwritten(sockets, raw):  # noqa: F811
    sockets.write_text(json.dumps({"apiKeys": raw, "favorites": []}), encoding="utf-8")
    before = sockets.read_text()
    client = TestClient(main.app, headers=PERSON)
    assert client.get("/api/settings").status_code == 200
    refused = client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}})
    assert refused.status_code == 409 and refused.json()["detail"] == main._unreadable(main.KEYS_UNREADABLE)
    removed = client.delete("/api/settings/api-keys/FAL_KEY")
    assert removed.status_code == 409 and removed.json()["detail"] == main._unreadable(main.KEYS_UNREADABLE)
    assert sockets.read_text() == before
    # A save that writes no key keeps them as saved too.
    assert client.put("/api/settings", json={"favorites": ["nano-banana"]}).status_code == 200
    saved = json.loads(sockets.read_text())
    assert saved["apiKeys"] == raw and saved["favorites"] == ["nano-banana"]
    assert settings.load_settings()["apiKeys"] == {}


def test_a_settings_file_that_is_no_object_is_never_overwritten(sockets):  # noqa: F811
    sockets.write_text("[1, 2]", encoding="utf-8")
    client = TestClient(main.app, headers=PERSON)
    for response in (client.put("/api/settings", json={"favorites": []}),
                     client.put("/api/settings", json={"apiKeys": {"FAL_KEY": "fal-1111"}}),
                     client.delete("/api/settings/api-keys/FAL_KEY")):
        assert response.status_code == 409, response.text
    assert sockets.read_text() == "[1, 2]"


def test_the_unreadable_refusals_say_nothing_was_saved():
    # GM r22 item 3: each names the file by its full path (test_idol_round12).
    assert main.KEYS_UNREADABLE == ("Nothing was saved because Nebula can’t read the keys saved in {path}. "
                                    "Fix “apiKeys” in that file, then try again.")
    assert main.SETTINGS_UNREADABLE.startswith("Nothing was saved because Nebula can’t read {path}.")


# -- the settings signal skips every socket that isn't the person's (review 10, NIT-7) -------


def _heard_all(sockets_open) -> list[list[dict]]:
    """One marker to every socket, and what each heard before it: _heard
    sends a marker per call, which every other socket would read first."""
    sockets_open[0].portal.call(main.manager.broadcast_raw, {"type": "testMarker"})
    heard = []
    for socket in sockets_open:
        mine = []
        for _ in range(80):
            message = socket.receive_json()
            if message.get("type") == "testMarker":
                break
            if message.get("type") == "settingsChanged":
                mine.append(message)
        else:
            raise AssertionError("no marker")
        heard.append(mine)
    return heard


def test_an_unconfirmed_tab_and_a_silent_socket_hear_no_signal(sockets):  # noqa: F811
    tab = TestClient(main.app)
    other = TestClient(main.app, headers=PERSON)
    with tab.websocket_connect("/ws", headers=PERSON) as browser, \
            tab.websocket_connect("/ws", headers=PERSON) as wrong, \
            tab.websocket_connect("/ws") as silent:
        browser.send_json({"type": "hello", "personToken": PERSON["X-Nebula-Person"]})
        _promoted(browser)
        wrong.send_json({"type": "hello", "personToken": "not-the-token"})
        for _ in range(80):
            if wrong.receive_json().get("type") == "personRequired":
                break
        else:
            raise AssertionError("the wrong token was never refused")
        _heard_all([browser, wrong, silent])
        assert other.put("/api/settings", json={"apiKeys": {"HF_TOKEN": "hf_signal_9999"}}).status_code == 200
        assert _heard_all([browser, wrong, silent]) == [[{"type": "settingsChanged", "keys": ["HF_TOKEN"]}], [], []]


# -- quoted names and Krea's one verb (GM r20 item 3, r21) -----------------------------------


def test_the_not_ready_line_quotes_the_name_and_says_sign_in():
    krea = REGISTRY["krea-2-generate"]
    line = node_readiness.instance_missing_line(krea, {"_kreaAuth": "mcp"}, [], False, REGISTRY, name="Krea 2")
    assert line == "“Krea 2” needs your Krea plan. Sign in to Krea in Settings."
    openai = REGISTRY["gpt-image-2-generate"]
    keyed = node_readiness.instance_missing_line(openai, {}, [], False, REGISTRY, name="Poster")
    assert keyed is not None and keyed.startswith("“Poster” needs your ")


def test_a_route_line_names_the_node_in_quotes():
    definition = REGISTRY["flux-3-video"]
    routed = node_route.with_wired_blockers(definition, {"_provider": "krea", "_kreaAuth": "api"}, ["keyframes"])
    line = node_route.route_unavailable_line(definition, routed, {"KREA_API_TOKEN": "set"}, title="“Clip”")
    assert line is not None and line.startswith("“Clip” can't run on Krea")


@pytest.mark.parametrize("params,wired,line", [
    ({"_provider": "krea", "_kreaAuth": "api-token"}, {"keyframes": 1},
     "“Clip” can't run on Krea with keyframes connected. Disconnect the extra inputs, or switch provider."),
    ({"_provider": "fal"}, {}, "“Clip” is set to fal.ai, which needs your fal.ai API key. Add it in Settings, "
                               "or choose another provider. Krea can take it."),
], ids=["route-blocked", "route-key"])
def test_a_route_tables_person_line_quotes_the_name(params, wired, line):
    """The bar's line for a route-table node comes from route_unavailable_line,
    given the quoted title by instance_missing_line."""
    definition = REGISTRY["flux-3-video"]
    assert node_readiness.instance_missing_line(definition, params, ["KREA_API_TOKEN"], False, REGISTRY, wired,
                                                name="Clip") == line


def test_krea_sign_in_says_the_settings_buttons_verb():
    from services.krea_connector import KreaNotConnectedError  # noqa: F401 - the type it raises

    source = (BACKEND / "services" / "krea_connector.py").read_text(encoding="utf-8")
    assert "Connect your Krea account" not in source and source.count('"Sign in to Krea in Settings first"') == 2
    engine = (BACKEND / "execution" / "engine.py").read_text(encoding="utf-8")
    assert '"Sign in to Krea in Settings before running this recipe"' in engine
    assert '"Sign in to Krea in Settings, then run the node again."' in engine


def test_krea_discovery_still_says_who_signs_in(monkeypatch):
    from nebula_api import NebulaAPIError

    def refuse(*_args, **_kwargs):
        raise NebulaAPIError("Sign in to Krea in Settings first", status=400)

    monkeypatch.setattr(mcp_server, "_canvas_call", refuse)
    with pytest.raises(NebulaAPIError) as raised:
        mcp_server._krea_call("GET", "/api/krea/tools", None)
    assert raised.value.detail == ("Sign in to Krea in Settings first. Only the person can sign in to Krea: "
                                   "ask them to open Settings > Providers > Krea in Nebula.")


# -- the run dialog's free ids (review 10, NIT-3) --------------------------------------------


def test_the_run_estimate_lists_the_sourced_zero_nodes(monkeypatch):
    from models.graph import GraphNode

    shipped = model_pricing.load_pricing()
    pricing = {**shipped, "nodes": {**shipped["nodes"], **CASES["pricing"]["nodes"]}}
    monkeypatch.setattr(model_pricing, "load_pricing", lambda: pricing)
    monkeypatch.setattr(main.node_registry, "get_all", lambda: {**REGISTRY, **CASES["definitions"]})
    monkeypatch.setattr(main, "load_settings", lambda *a, **k: {"apiKeys": {"FAL_KEY": "k"}})
    node = GraphNode(id="z", definitionId="zeroed", params={})
    estimate = main._run_estimate([node], [])
    assert estimate["free"] == ["z"]
