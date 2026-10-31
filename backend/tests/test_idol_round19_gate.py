"""PR #203 round 19, section 1b: Justin's decisions on the Idol gate (2026-10-31).

1. Only the Hugging Face call is gated. An agent's run with Idol in scope
   starts: the nodes before it run, and an Idol node whose last result is
   reused passes. An Idol node that must call the Space while the person's
   token is set stops before any request; nothing after it runs, and the
   agent is told to propose (run result, events, MCP and CLI words). The
   person's own Run and an accepted proposal never stop there; with no token
   nothing changes; a run whose origin is unknown stops (fail closed).
2. Unreadable apiKeys read as no keys for the gate too, and no node takes a
   token from the environment.
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest

import services.settings as settings
from execution import run_origin
from execution.engine import execute_graph
from execution.run_origin import ProposalNeeded, RunOrigin
from execution.sync_runner import get_handler_registry
from handlers import speridlabs_idol
from models.events import ErrorEvent, ExecutedEvent
from models.graph import GraphEdge, GraphNode, PortValueDict
from services import agent_spend, model_pricing, run_done_cards
from services.node_registry import NodeRegistry
from tests.conftest import PERSON
from tests.speridlabs_fakes import IMAGE, idol_hosts
from tests.test_canvas_proposals import CLAUDE, KEY, _key, _propose, api  # noqa: F401 - fixture

TOKEN = "hf_fixturetoken0123456789abcdefghijklmnop"
SIGNED_IN = {"HF_TOKEN": TOKEN}
CLI = {**CLAUDE, "X-Nebula-Surface": "cli"}
STOP = "(Idol) stopped before calling Hugging Face: the person's Hugging Face token is set"
PERSON_LINE = ("An agent’s run stopped here before calling Hugging Face, because your Hugging Face token is set and "
               "this run could bill your account. Run it yourself to go ahead.")


def _space_calls(hosts) -> list[str]:
    return [str(request.url) for request in hosts.requests if "hf.space" in str(request.url)
            or "huggingface.co" in str(request.url)]


@pytest.fixture
def world(api, monkeypatch):
    """The canvas: an image, Idol from it, and a reroute after Idol; the
    Space and the image's host faked (nothing reaches the network)."""
    api.hosts = idol_hosts(monkeypatch)
    real = api.main.load_settings

    def keys(api_keys):
        monkeypatch.setattr(api.main, "load_settings", lambda *a, **k: {**real(*a, **k), "apiKeys": dict(api_keys)})

    api.keys = keys
    keys(SIGNED_IN)
    api.image = api.graph.add_node("image-input", {"filePath": IMAGE})
    api.idol = api.graph.add_node("speridlabs-idol", {})
    api.after = api.graph.add_node("reroute", {})
    api.graph.connect(api.image, "image", api.idol, "image")
    api.graph.connect(api.idol, "world", api.after, "input")
    api.main.execution_cache.clear()
    yield api
    api.main.execution_cache.clear()


def _run(api, headers) -> dict:
    response = api.client.post("/api/graph/run", headers=headers, json={"wait": 30})
    assert response.status_code == 200, response.text
    return response.json()


def _errors(api) -> list[dict]:
    return [m for m in api.sent if m.get("type") == "error"]


# -- the stop at the call ---------------------------------------------------------------------

@pytest.mark.parametrize("headers,propose", [
    (CLAUDE, "Propose it instead: propose_change (run: {idol}). The person accepts on the canvas, and the canvas runs it."),
    (CLI, 'Propose it instead: `nebula propose --note "<why>" --run {idol}`. The person accepts on the canvas, '
          "and the canvas runs it."),
], ids=["mcp", "cli"])
def test_an_agents_run_that_must_call_stops_before_any_request(world, headers, propose):
    body = _run(world, headers)
    assert _space_calls(world.hosts) == [] and world.hosts.requests == []
    # The node before Idol ran; Idol stopped; the one after it didn't run.
    assert world.image in body["results"] and world.idol not in body["results"]
    assert world.after not in body["results"] and world.after not in body["errors"]
    assert body["status"] == "failed"
    error = body["errors"][world.idol]
    assert error == (f"{world.idol} {STOP}, so this call can bill their Hugging Face account: a PRO, Team or "
                     "Enterprise account's prepaid credits are billed past its daily ZeroGPU allowance ($1 per 10 "
                     "GPU-minutes), a cost Nebula can't see or limit. Nothing was sent, and the nodes after it didn't "
                     "run. An agent can't make this call. " + propose.format(idol=world.idol))
    [event] = _errors(world)
    assert event["proposalNeeded"] is True and event["person"] == PERSON_LINE and event["nodeId"] == world.idol


DONE = "Claude Code finished 1 of 3 nodes. “Idol” stopped before calling Hugging Face: your token is set, so it waits for you to run it."


def test_the_runs_other_branches_finish(world):
    """A branch that doesn't go through Idol runs to its end, as on any node stop."""
    text = world.graph.add_node("text-input", {"value": "a chair"})
    tail = world.graph.add_node("reroute", {})
    world.graph.connect(text, "text", tail, "input")
    body = _run(world, CLAUDE)
    assert world.hosts.requests == [] and world.after not in body["results"]
    assert text in body["results"] and tail in body["results"]


def test_the_agents_done_card_and_agent_log_say_it_stopped(world):
    _run(world, CLAUDE)
    [line] = [m for m in world.sent if m.get("type") == "agentPresence" and "stopped before" in (m.get("say") or "")]
    # The bubble fits it whole, and the Agent log keeps it whole for any agent's name.
    assert line["say"] == DONE and line["log"] == DONE


def test_the_done_card_line_for_a_run_of_idol_alone():
    labels = {"n1": "Idol"}
    assert run_done_cards.done_text("Codex", labels, ["n1"], succeeded=[], failed=["n1"], stopped=["n1"]) == (
        "Codex's run of “Idol” stopped before calling Hugging Face: your token is set, so it waits for you to run "
        "it.", "failure")
    three = {"n1": "Idol", "n2": "Reroute", "n3": "Reroute"}
    assert run_done_cards.done_text("Codex", three, ["n1", "n2", "n3"], succeeded=[], failed=["n1"],
                                    stopped=["n1"]) == (
        "Codex's run of 3 nodes didn't finish. “Idol” stopped before calling Hugging Face: your token is set, so it "
        "waits for you to run it.", "failure")
    assert run_done_cards.done_text("Codex", labels, ["n1"], succeeded=[], failed=["n1"]) == (
        "Codex's run of “Idol” failed.", "failure")


def test_a_reused_result_passes_with_no_stop_and_no_request(world):
    first = _run(world, PERSON)
    assert world.idol in first["results"] and _space_calls(world.hosts)
    world.hosts.requests.clear()
    world.sent.clear()
    again = _run(world, CLAUDE)
    assert again["status"] == "finished", again
    assert world.idol in again["results"] and world.after in again["results"]
    assert world.hosts.requests == [] and _errors(world) == []


def test_the_persons_run_makes_the_call(world):
    body = _run(world, PERSON)
    assert body["status"] == "finished" and world.after in body["results"]
    calls = world.hosts.sent("POST", r".*/gradio_api/call/run")
    assert calls and calls[0].headers.get("x-hf-authorization") == f"Bearer {TOKEN}"


def test_with_no_token_an_agents_run_calls_keyless(world):
    world.keys({})
    body = _run(world, CLAUDE)
    assert body["status"] == "finished" and world.after in body["results"]
    sent = world.hosts.requests
    assert _space_calls(world.hosts) and all("authorization" not in r.headers and "x-hf-authorization" not in r.headers
                                             for r in sent)


def _wait_for_graph_complete(api, run_id: str) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if any(m.get("type") == "graphComplete" and m.get("runId") == run_id for m in api.sent):
            return
        time.sleep(0.02)
    raise AssertionError("the run didn't finish")


def test_an_accepted_proposal_runs_with_the_persons_authority(world):
    proposal = _propose(world, {"note": "a world", "run": [world.idol]})
    assert proposal.status_code == 201, proposal.text
    proposal_id = proposal.json()["proposal"]["id"]
    accepted = world.client.post(f"/api/canvas/proposals/{proposal_id}/accept",
                                 headers={**PERSON, KEY: _key(world, proposal_id)}, json={})
    assert accepted.status_code == 200, accepted.text
    nodes = [{"id": node_id, "definitionId": node["definitionId"], "params": node.get("params") or {}, "outputs": {}}
             for node_id, node in world.graph.nodes.items()]
    edges = [{"id": e["id"], "source": e["source"], "sourceHandle": e["sourceHandle"], "target": e["target"],
              "targetHandle": e["targetHandle"]} for e in world.graph.edges]
    started = world.client.post("/api/execute-node", headers=PERSON, json={
        "nodes": nodes, "edges": edges, "targetNodeId": world.idol, "approvalId": accepted.json()["approvalId"],
        "runId": "r-accepted"})
    assert started.status_code == 200, started.text
    _wait_for_graph_complete(world, "r-accepted")
    assert _errors(world) == [] and world.hosts.sent("POST", r".*/gradio_api/call/run")


def _quick(api, headers):
    return api.client.post("/api/quick", headers=headers, json={
        "definitionId": "speridlabs-idol", "inputs": {"image": IMAGE}, "params": {}})


@pytest.mark.parametrize("headers,ask", [
    (CLAUDE, "Add it to the canvas instead (edit_canvas, a speridlabs-idol node), then propose the run: "
             "propose_change (run: <node id>). The person accepts on the canvas, and the canvas runs it."),
    (CLI, "Add it to the canvas instead (`nebula create speridlabs-idol`), then propose the run: "
          "`nebula propose --note \"<why>\" --run <node id>`. The person accepts on the canvas, and the canvas runs it."),
], ids=["mcp", "cli"])
def test_an_agents_quick_run_stops_and_points_at_a_canvas_node(world, headers, ask):
    """`nebula quick` has no canvas node to propose, so it names the way to
    add one, in the reader's own words; a 403, before any request."""
    response = _quick(world, headers)
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == (
        "Idol stopped before calling Hugging Face: the person's Hugging Face token is set, so this call can bill "
        "their Hugging Face account: a PRO, Team or Enterprise account's prepaid credits are billed past its daily "
        "ZeroGPU allowance ($1 per 10 GPU-minutes), a cost Nebula can't see or limit. Nothing was sent. An agent "
        "can't make this call. " + ask)
    assert _space_calls(world.hosts) == []


def test_the_persons_quick_run_makes_the_call(world):
    response = _quick(world, PERSON)
    assert response.status_code == 200, response.text
    assert world.hosts.sent("POST", r".*/gradio_api/call/run")


def test_an_in_app_chat_turn_stops_too(world):
    from commons.actors import agent_registry

    token = agent_registry.mint("claude", [], session="chat-r19-gate")
    try:
        body = _run(world, {"Authorization": f"Agent {token}"})
    finally:
        agent_registry.revoke(token)
    assert world.hosts.requests == [] and STOP in body["errors"][world.idol]


def test_the_spend_check_no_longer_refuses_a_run_with_idol():
    items = [{"id": "t1", "definitionId": "text-input", "params": {"value": "a"}},
             {"id": "n1", "definitionId": "speridlabs-idol", "params": {"_provider": "auto"}}]
    for limits in ({}, {"runCostConfirmUsd": 100}):
        decision = agent_spend.decide(items, [], settings={"apiKeys": SIGNED_IN, **limits},
                                      pricing=model_pricing.load_pricing(), definitions=NodeRegistry().get_all(),
                                      how_to_ask="Propose it.")
        assert decision.refusal is None and decision.charge.get("speridlabs-idol", 0) == 0


# -- straight through the engine: an unknown origin, and two runs at once ------------------------

def _graph() -> tuple[list[GraphNode], list[GraphEdge]]:
    nodes = [GraphNode(id="img", definitionId="image-input", params={"filePath": IMAGE}),
             GraphNode(id="idol", definitionId="speridlabs-idol", params={}),
             GraphNode(id="after", definitionId="reroute", params={})]
    edges = [GraphEdge(id="e1", source="img", sourceHandle="image", target="idol", targetHandle="image"),
             GraphEdge(id="e2", source="idol", sourceHandle="world", target="after", targetHandle="input")]
    return nodes, edges


async def _engine_run(origin: RunOrigin | None, keys=SIGNED_IN) -> dict[str, object]:
    events: list = []

    async def emit(event):
        events.append(event)

    nodes, edges = _graph()

    async def go():
        await execute_graph(nodes=nodes, edges=edges, api_keys=dict(keys),
                            handler_registry=get_handler_registry(emit=emit), emit=emit, cache=None)

    if origin is None:
        await go()
    else:
        with run_origin.running(origin):
            await go()
    return {"executed": [e.node_id for e in events if isinstance(e, ExecutedEvent)],
            "errors": {e.node_id: e for e in events if isinstance(e, ErrorEvent)}}


def test_an_origin_holds_only_inside_its_run():
    assert run_origin.current() is None and run_origin.by_person() is False
    with run_origin.running(RunOrigin(person=True)):
        assert run_origin.by_person() is True
        with run_origin.running(RunOrigin(person=False, surface="cli")):
            assert run_origin.current() == RunOrigin(person=False, surface="cli")
        assert run_origin.by_person() is True
    assert run_origin.current() is None


@pytest.mark.asyncio
async def test_a_run_whose_origin_is_unknown_stops(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    ran = await _engine_run(None)
    assert hosts.requests == [] and ran["executed"] == ["img"]
    assert ran["errors"]["idol"].proposal_needed is True and STOP in ran["errors"]["idol"].error


@pytest.mark.asyncio
async def test_two_runs_reaching_the_same_idol_node_at_once(monkeypatch):
    """Each run keeps its own origin: the agent's stops before any request while
    the person's, at the same moment, makes the call."""
    hosts = idol_hosts(monkeypatch)
    entered = asyncio.Event()
    real = speridlabs_idol.wait_until_running

    async def held(client, token):
        entered.set()
        await asyncio.sleep(0.05)
        return await real(client, token)

    monkeypatch.setattr(speridlabs_idol, "wait_until_running", held)

    async def agent_after_person_entered():
        await entered.wait()
        return await _engine_run(RunOrigin(person=False))

    person, agent, other_agent = await asyncio.gather(_engine_run(RunOrigin(person=True)),
                                                      agent_after_person_entered(),
                                                      _engine_run(RunOrigin(person=False, surface="cli")))
    assert person["executed"] == ["img", "idol", "after"] and person["errors"] == {}
    for stopped in (agent, other_agent):
        assert stopped["executed"] == ["img"] and stopped["errors"]["idol"].proposal_needed is True
    assert "nebula propose" in other_agent["errors"]["idol"].error
    assert len(hosts.sent("POST", r".*/gradio_api/call/run")) == 1


@pytest.mark.asyncio
async def test_the_stop_is_in_the_one_function_that_calls_the_space(monkeypatch):
    hosts = idol_hosts(monkeypatch)
    node = GraphNode(id="n1", definitionId="speridlabs-idol", params={})
    inputs = {"image": PortValueDict(type="Image", value=IMAGE)}
    with pytest.raises(speridlabs_idol.IdolProposalNeeded):
        await speridlabs_idol.run_idol(node, inputs, SIGNED_IN)
    with run_origin.running(RunOrigin(person=False)), pytest.raises(speridlabs_idol.IdolProposalNeeded):
        await speridlabs_idol.run_idol(node, inputs, SIGNED_IN)
    assert hosts.requests == []


def test_idols_call_is_the_only_proposal_stop_and_every_may_bill_route_reaches_it():
    """The done card's STOPPED line names Hugging Face: Idol's is the only
    ProposalNeeded. Every route that may bill with its key runs through
    run_hf_space, whose only Space is Idol's, the one handler that checks."""
    from execution import route_clients

    assert {cls.__name__ for cls in ProposalNeeded.__subclasses__()} == {"IdolProposalNeeded"}
    may_bill = [(definition["id"], route) for definition in NodeRegistry().get_all().values()
                for route in definition.get("routes") or [] if route.get("mayBillWithKey")]
    assert may_bill and all(route.get("handler") == "hf-space" for _, route in may_bill)
    assert route_clients.HF_SPACE_HANDLERS == {"speridlabs/idol": "handlers.speridlabs_idol"}


# -- Justin's answer 2: unreadable keys are no keys, and never the environment --------------------

def test_unreadable_apikeys_read_as_no_keys_for_the_gate(world, tmp_path, monkeypatch):
    """Keys Nebula can't read are no keys for every reader, the gate included:
    an agent's Idol run with HF_TOKEN in an unreadable apiKeys (and in the
    environment) runs keyless, with no stop and no token sent."""
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"apiKeys": [TOKEN]}), encoding="utf-8")
    monkeypatch.setenv("NEBULA_SETTINGS_PATH", str(path))
    monkeypatch.setenv("HF_TOKEN", TOKEN)
    monkeypatch.setattr(settings, "_INJECTED_KEYS", {})
    monkeypatch.setattr(world.main, "load_settings", settings.load_settings)
    assert settings.load_settings()["apiKeys"] == {}
    body = _run(world, CLAUDE)
    assert body["status"] == "finished" and world.after in body["results"] and _errors(world) == []
    sent = world.hosts.requests
    assert _space_calls(world.hosts)
    assert all("authorization" not in r.headers and "x-hf-authorization" not in r.headers for r in sent)
    assert all(TOKEN.encode() not in (r.content or b"") for r in sent)


def test_no_node_takes_a_token_from_the_environment(world, monkeypatch):
    """HF_TOKEN in the environment with no saved token: Idol sends no token
    (the person's run, so nothing stops it)."""
    world.keys({})
    monkeypatch.setenv("HF_TOKEN", TOKEN)
    body = _run(world, PERSON)
    assert body["status"] == "finished"
    assert _space_calls(world.hosts)
    assert all("authorization" not in r.headers and "x-hf-authorization" not in r.headers
               for r in world.hosts.requests)
