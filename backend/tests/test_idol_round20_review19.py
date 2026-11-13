"""PR #203 round 20, section 2b: review 19's findings, with GM r40's words.

A. A routed node's missing key is a need like any other key's: its inputs
   and its key say one card line, ending once, and the bubble names both
   (MEDIUM-1). GM r40 item 1: from 4 providers a count ("a key for one of
   its 4 providers"), with 2 or 3 their names. A Krea sign-in is a need the
   same way (a draft for GM).
"""
from __future__ import annotations

import json
import re

import pytest

import main
from execution.engine import validate_graph
from models.graph import GraphNode
from services.node_registry import NodeRegistry
from tests.test_idol_round19_review18 import MCP, _run, bubbles  # noqa: F401 - fixture

REGISTRY = NodeRegistry().get_all()
ENDING = re.compile(r"run (?:it|the node|the nodes) again")


def _card(definition_id: str, keys: dict[str, str] | None = None) -> tuple[str, list]:
    errors = validate_graph([GraphNode(id="n1", definitionId=definition_id, params={})], [], keys or {},
                            name_of=lambda _id: "X")
    return " ".join(dict.fromkeys(error.person for error in errors if error.person)), errors


def _needs_input_and_key(definition: dict) -> bool:
    required = any(port.get("required") for port in definition.get("inputPorts") or [])
    keyed = (bool(definition.get("envKeyName")) or bool(definition.get("routes"))
             or "krea" in str(definition.get("id") or ""))
    return required and keyed


WALKED = sorted(node_id for node_id, definition in REGISTRY.items() if _needs_input_and_key(definition))


def test_the_walk_covers_the_routed_nodes_review_19_named():
    for node_id in ("flux-2-pro", "flux-3-image", "flux-3-image-klein", "flux-3-video", "krea-3",
                    "krea-moodboard-create", "flux-kontext", "claude-chat"):
        assert node_id in WALKED, node_id
    assert len(WALKED) > 100


@pytest.mark.parametrize("node_id", WALKED)
def test_no_card_line_has_two_run_again_endings(node_id):
    card, _errors = _card(node_id)
    assert len(ENDING.findall(card)) <= 1, card


@pytest.mark.parametrize("node_id", WALKED)
def test_the_bubble_names_every_need_when_the_card_says_one_line(node_id):
    """A node whose stops are only inputs and its key: the bubble's words
    name each of them (a first sentence of the needs, per GM r39 item 5)."""
    card, errors = _card(node_id)
    own = [error for error in errors if error.node_id == "n1"]
    if not own or not all(error._stop == "input" or error._key for error in own):
        return
    words = main._bubble_needs("n1", errors)
    assert words is not None, (node_id, card)
    for error in own:
        if error._key:
            assert error._key in words, (node_id, words)


@pytest.mark.parametrize("node_id,card", [
    # GM, PR #203 r40 item 1, verbatim: 4 providers or more, a count.
    ("flux-3-image", "Connect the prompt and add a key for one of its 4 providers in Settings, then run it again."),
    # 2 or 3: their names, joined as the route line joins them.
    ("flux-2-pro", "Connect the prompt and add your Black Forest Labs API key or fal.ai API key in Settings, "
                   "then run it again."),
    ("krea-3", "Connect the prompt and add your Krea API key or fal.ai API key in Settings, then run it again."),
    # A Krea sign-in (a draft for GM).
    ("krea-moodboard-create", "Connect the images and sign in to Krea in Settings, then run it again."),
    # A plain key keeps GM r38's form.
    ("flux-kontext", "Connect the prompt and the image, and add your fal.ai API key in Settings, then run it again."),
])
def test_the_card_says_its_needs_once(node_id, card):
    assert _card(node_id)[0] == card


def test_a_routed_bubble_names_the_node_its_prompt_and_its_key(monkeypatch, bubbles):  # noqa: F811
    body = _run(monkeypatch, [("flux-3-image", {}, "Hero shot")], MCP, {})
    assert body["status"] == "failed"
    # GM, PR #203 r40 item 1, verbatim.
    assert bubbles == ["“Hero shot” needs a prompt and a key for one of its 4 providers."]


def test_a_route_with_another_way_to_run_is_not_a_key_need():
    """Set to Replicate with only fal.ai's key: the route line offers the
    switch, so it stays its own line (not merged into the needs)."""
    errors = validate_graph([GraphNode(id="n1", definitionId="flux-3-image", params={"_provider": "replicate"})], [],
                            {"FAL_KEY": "fal-test-fake"}, name_of=lambda _id: "X")
    assert not any(error._key for error in errors)
    assert any("switch to fal.ai" in (error.person or "") for error in errors)


# -- B1: the origin on every run route (tests only; the rule is unchanged) ------------------------

import ast  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

from tests.conftest import PERSON  # noqa: E402
from tests.test_canvas_proposals import CLAUDE, api  # noqa: E402,F401 - fixture
from tests.test_idol_round19_gate import world  # noqa: E402,F401 - fixture
from tests.test_pending_nodes import _execute_body  # noqa: E402

MARKED = {
    "x-nebula-agent": {**PERSON, "X-Nebula-Agent": "Claude Code"},
    "x-nebula-client": {**PERSON, "X-Nebula-Client": "nebula-cli"},
    "authorization-agent": {**PERSON, "Authorization": "Agent not-a-token"},
}


def _space(hosts) -> list[str]:
    return [str(r.url) for r in hosts.requests if "hf.space" in str(r.url) or "huggingface.co" in str(r.url)]


def _done(api, run_id: str) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if any(m.get("type") == "graphComplete" and m.get("runId") == run_id for m in api.sent):
            return
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} didn't finish")


def _stops(api) -> list[str]:
    return [m["nodeId"] for m in api.sent if m.get("type") == "error" and m.get("proposalNeeded")]


def _execute(api, headers, run_id: str):
    return api.client.post("/api/execute", headers=headers, json={**_execute_body(api), "runId": run_id})


def test_the_persons_canvas_run_makes_the_call(world):
    response = _execute(world, PERSON, "r-person")
    assert response.status_code == 200, response.text
    _done(world, "r-person")
    assert _space(world.hosts) and _stops(world) == []


def test_an_agents_canvas_run_stops_before_the_call(world):
    response = _execute(world, CLAUDE, "r-agent")
    assert response.status_code == 200, response.text
    _done(world, "r-agent")
    assert _space(world.hosts) == [] and _stops(world) == [world.idol]


@pytest.mark.parametrize("marker", list(MARKED))
@pytest.mark.parametrize("route", ["execute", "graph-run"])
def test_the_persons_token_with_an_agents_marker_never_makes_the_call(world, marker, route):
    headers = MARKED[marker]
    if route == "execute":
        response = _execute(world, headers, f"r-{marker}")
        if response.status_code == 200:
            _done(world, f"r-{marker}")
    else:
        response = world.client.post("/api/graph/run", headers=headers, json={"wait": 30})
    assert _space(world.hosts) == []
    if response.status_code == 200:
        assert _stops(world) == [world.idol]


def test_an_agents_cinema_shot_with_idol_upstream_stops_with_no_request(world, monkeypatch):
    """Idol reaches a scene through an Any-typed reroute; the shot pass runs
    what's upstream first, and an agent's stops at Idol. No spending limits,
    so the spend check (which has no list price for the scene) lets it start."""
    real = world.main.load_settings
    no_limits = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "kreaPlanRuns": None, "dailyTotalUsd": None,
                                                    "models": {}}}
    monkeypatch.setattr(world.main, "load_settings", lambda *a, **k: {**real(*a, **k), **no_limits})
    scene = {"scene": {"version": 1, "base": {"model": "seedream-4-5"}, "aspectRatio": "16:9",
                       "shots": [{"id": "a", "prompt": "a chair"}]}}
    cinema = world.graph.add_node("cinema-scene", scene)
    world.graph.connect(world.after, "output", cinema, "reference_set")
    body = {**_execute_body(world), "nodeId": cinema, "shotId": "a", "runId": "r-shot"}
    response = world.client.post("/api/cinema/generate-shot", headers=CLAUDE, json=body)
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 20
    while not _stops(world) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert _stops(world) == [world.idol]
    assert world.hosts.requests == []


def test_every_graph_run_in_main_starts_through_the_origin():
    """Every execute_graph( call in main.py sits inside _run_graph, which
    records who started the run (execution/run_origin.py)."""
    tree = ast.parse((Path(main.__file__)).read_text(encoding="utf-8"))
    callers = []
    for function in ast.walk(tree):
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "execute_graph":
                    callers.append(function.name)
    assert callers == ["_run_graph"]
    runs = sum(1 for node in ast.walk(tree) if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_run_graph")
    assert runs >= 5


# -- B2 to B6: what agents read after a stop, and the done line ------------------------------------

from handlers import speridlabs_idol  # noqa: E402
from services import run_done_cards  # noqa: E402
from services.run_reports import STOPPED_FOR_PROPOSAL  # noqa: E402
from tests.conftest import CANVAS_PARAMS_VERSION  # noqa: E402
from tests.test_idol_round19_gate import _run as _graph_run  # noqa: E402

PROPOSE_MCP = "Propose it instead: propose_change (run: {idol}). The person accepts on the canvas, and the canvas runs it."


def _agent_text(world) -> str:
    return f"{speridlabs_idol.agent_stop_text('Idol')} {PROPOSE_MCP.format(idol=world.idol)}"


def test_the_journal_marks_the_stop_with_the_agents_whole_text(world):
    start = world.client.get("/api/canvas/events", headers=CLAUDE, params={"wait": 0, "limit": 1}).json()["cursor"]
    _graph_run(world, CLAUDE)
    read = world.client.get("/api/canvas/events", headers=CLAUDE,
                            params={"after": start, "wait": 0, "limit": 100, "self": 1}).json()
    [failed] = [e for e in read["events"] if e["kind"] == "run.failed" and e.get("nodeId") == world.idol]
    assert failed["data"]["proposalNeeded"] is True
    assert failed["data"]["error"] == _agent_text(world)
    assert failed["summary"].endswith("stopped")


def test_the_run_result_marks_the_stop_and_says_its_text(world):
    body = _graph_run(world, CLAUDE)
    assert body["stopped"] == {world.idol: STOPPED_FOR_PROPOSAL}
    # One node's own words, never "n2 failed: …" (review 19, NIT-1).
    assert body["error"] == body["errors"][world.idol] == _agent_text(world)
    import mcp_server

    shown = json.loads(mcp_server._run_result(body, None)[0])
    assert shown["stopped"] == {world.idol: STOPPED_FOR_PROPOSAL}


def test_a_canvas_runs_report_marks_the_stop(world):
    """get_run on a canvas run reads run_reports: the same marker and words."""
    _execute(world, CLAUDE, "r-report")
    _done(world, "r-report")
    made = main._run_reports().outcome("r-report")
    assert made["stopped"] == {world.idol: STOPPED_FOR_PROPOSAL}
    assert made["errors"][world.idol] == _agent_text(world)
    from services.run_reports import one_line_error

    assert one_line_error(made["errors"], made["stopped"]) == _agent_text(world)


def test_look_keeps_the_stops_whole_text(world, monkeypatch):
    from cli.formatter import format_snapshot

    # The fixture's project store swaps projects under the error store; hold
    # it on one so the snapshot reads the entry the run wrote.
    main.node_errors.use_project(None)
    monkeypatch.setattr(main.node_errors, "use_project", lambda *_a, **_k: None)
    # A name long enough that the text runs past look's 300-character cut.
    name = "Chair splat for the client deck, second pass"
    renamed = world.client.put(f"/api/graph/node/{world.idol}/label", headers=PERSON, json={"label": name})
    assert renamed.status_code == 200, renamed.text
    _graph_run(world, CLAUDE)
    text = f"{speridlabs_idol.agent_stop_text(name)} {PROPOSE_MCP.format(idol=world.idol)}"
    assert len(text) > 300
    snapshot = world.client.get("/api/canvas/snapshot", headers=CLAUDE).json()
    [node] = [n for n in snapshot["nodes"] if n["id"] == world.idol]
    assert node["stopped"] == STOPPED_FOR_PROPOSAL and node["error"] == text
    assert f"error: {text}" in format_snapshot(snapshot)


def test_watch_prints_the_stops_whole_text():
    from cli.formatter import format_event

    text = f"{speridlabs_idol.agent_stop_text('Idol')} {PROPOSE_MCP.format(idol='n2')}"
    stop = {"kind": "run.failed", "summary": "Idol (n2) stopped", "data": {"error": text, "proposalNeeded": True}}
    assert format_event(stop).endswith(f"Idol (n2) stopped: {text}")
    failed = {"kind": "run.failed", "summary": "Idol (n2) failed", "data": {"error": text}}
    assert format_event(failed).endswith("…")


def test_a_stop_and_a_failure_in_one_run_say_both():
    labels = {"img": "Image", "n1": "Idol", "w": "Writer", "t": "Text"}
    # GM, PR #203 r40 item 2, verbatim.
    assert run_done_cards.done_text("Claude Code", labels, ["img", "n1", "w", "t"], succeeded=["img"],
                                    failed=["n1", "w"], stopped=["n1"]) == (
        "Claude Code finished 1 of 4 nodes. “Idol” is waiting for you to run it, and “Writer” failed.", "partial")
    many = {f"n{i}": f"Idol {i}" for i in range(7)}
    assert run_done_cards.done_text("Claude Code", many, list(many), succeeded=["n0"],
                                    failed=["n1", "n2", "n3", "n4", "n5", "n6"], stopped=["n1", "n2", "n3", "n4"]) == (
        "Claude Code finished 1 of 7 nodes. 4 nodes are waiting for you to run them, and 2 failed.", "partial")
    two = {"img": "Image", "a": "Idol", "b": "Idol 2"}
    assert run_done_cards.done_text("Codex", two, ["img", "a", "b"], succeeded=["img"], failed=["a", "b"],
                                    stopped=["a", "b"]) == (
        "Codex finished 1 of 3 nodes. “Idol” and “Idol 2” are waiting for you to run them because they could bill "
        "your Hugging Face account.", "partial")


def test_the_done_bubble_says_whole_sentences_and_the_log_the_whole_line(world):
    renamed = world.client.put(f"/api/graph/node/{world.idol}/label", headers=PERSON,
                               json={"label": "Chair splat for the client deck"})
    assert renamed.status_code == 200, renamed.text
    _graph_run(world, CLAUDE)
    [line] = [m for m in world.sent if m.get("type") == "agentPresence" and "is waiting for you" in (m.get("log") or "")]
    assert line["log"] == ("Claude Code finished 1 of 3 nodes. “Chair splat for the client deck” is waiting for you to "
                           "run it because it could bill your Hugging Face account.")
    assert line["say"] == "Claude Code finished 1 of 3 nodes."


def test_a_tab_not_connected_as_the_person_gets_its_own_card_body(world):
    tab = {"Origin": "http://localhost:5173", **CANVAS_PARAMS_VERSION}
    response = _execute(world, tab, "r-tab")
    assert response.status_code == 200, response.text
    _done(world, "r-tab")
    [stop] = [m for m in world.sent if m.get("type") == "error" and m.get("proposalNeeded")]
    # GM, PR #203 r40 item 5, verbatim; the gate is unchanged: no request.
    assert stop["person"] == ("This node could bill your Hugging Face account, so only you can run it. You can run "
                              "it when this tab is connected as you.")
    assert stop["category"] == "waiting" and _space(world.hosts) == []


def test_an_agents_stop_keeps_the_agent_card_body(world):
    _graph_run(world, CLAUDE)
    [stop] = [m for m in world.sent if m.get("type") == "error" and m.get("proposalNeeded")]
    assert stop["person"] == speridlabs_idol.AGENT_STOP_PERSON and stop["category"] == "waiting"
    assert stop["friendly"] is None
