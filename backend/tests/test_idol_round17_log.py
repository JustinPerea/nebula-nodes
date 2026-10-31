"""PR #203 round 17, section 2: the refused run's Agent log line (review 16,
copy-ui M1, M2 and L1; GM r33 items 1 and 2).

- An input with no wire merges as a reason does, from one table
  (person_line.INPUT_NEED_PREDICATES): "2 “GPT Image 2” nodes need a prompt.
  Connect a prompt to each, then run the nodes again."; "“GPT Image 2” needs
  a prompt. Connect one, then run the node again."
- A node with a reason and another stop keeps both: the reason, then the
  other stop.
- Nebula's own line is never cut: past the log's room it takes the count
  form, and a line with no shorter form is said whole.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
from commons.actors import agent_registry
from execution import person_line
from execution.person_line import NotReadyReason, merged_not_ready
from models.events import ValidationErrorDetail
from services import agent_presence
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture

HEADING = "Nebula couldn’t start the run."
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
GPT = "gpt-image-2-generate"
GPT1 = "gpt-image-1-generate"
TTS = "openai-tts"
KEY = {"OPENAI_API_KEY": "sk-test-fake"}
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def chat_turn():
    token = agent_registry.mint("claude", [], session="chat-r17")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


def _refused(monkeypatch, definitions: list[str], headers: dict[str, str], lines: list[str],
             keys: dict[str, str]) -> tuple[dict, list[str], list[str]]:
    """Run a canvas of nodes with nothing wired in: the reply, the node ids,
    and what the Agent log listed for the run."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(keys)})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            ids = [client.post("/api/graph/node", json={"definitionId": d, "params": {}}).json()["id"]
                   for d in definitions]
            lines.clear()
            body = client.post("/api/graph/run", json={}, headers=headers).json()
            return body, ids, list(lines)
        finally:
            client.delete("/api/graph?force=true")


# -- M1: inputs with no wire merge, from one table -------------------------------------

INPUT_CASES = [
    ([GPT], f"{HEADING} “GPT Image 2” needs a prompt. Connect one, then run the node again."),
    ([GPT, GPT], f"{HEADING} 2 “GPT Image 2” nodes need a prompt. Connect a prompt to each, "
                 "then run the nodes again."),
    ([GPT, GPT1], f"{HEADING} “GPT Image 2” and “GPT Image 1” need a prompt. Connect a prompt to each, "
                  "then run the nodes again."),
    ([GPT, GPT, TTS], f"{HEADING} 2 “GPT Image 2” nodes need a prompt. Connect a prompt to each, then run "
                      "the nodes again. “OpenAI TTS” needs text. Connect it, then run the node again."),
    ([GPT, GPT, GPT, GPT1], f"{HEADING} 4 nodes can’t run here yet."),
]


@pytest.mark.parametrize("definitions,line", INPUT_CASES,
                         ids=["one", "same-name-two", "different-names", "two-needs", "counted-from-4"])
@pytest.mark.parametrize("who", ["mcp", "cli", "chat"])
def test_inputs_with_no_wire_merge_in_the_log(monkeypatch, agent_log, chat_turn, who,  # noqa: F811
                                              definitions, line):
    headers = {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]
    body, ids, said = _refused(monkeypatch, definitions, headers, agent_log, KEY)
    assert body["status"] == "failed" and body["nodesExecuted"] == 0
    assert said == [line]
    # The old per-node form is gone, and agents still read every node by id.
    assert "can’t run. Connect" not in said[0]
    assert set(body["errors"]) == set(ids)
    assert all("Required input port prompt is not connected" in body["errors"][i]
               for i, d in zip(ids, definitions) if d != TTS)


# -- L1: a reason and another stop on one node keep both --------------------------------

@pytest.mark.parametrize("who", ["mcp", "cli", "chat"])
def test_a_node_with_a_reason_and_an_input_need_keeps_both(monkeypatch, agent_log, chat_turn, who):  # noqa: F811
    headers = {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]
    _, _, said = _refused(monkeypatch, [GPT, GPT], headers, agent_log, {})
    assert said == [f"{HEADING} 2 “GPT Image 2” nodes need your OpenAI API key. Add it in Settings, then run "
                    "the nodes again. 2 “GPT Image 2” nodes need a prompt. Connect a prompt to each, then run "
                    "the nodes again."]


def test_the_reason_comes_first_then_the_nodes_other_stop(monkeypatch):
    """A stop that is neither (here a World Labs batch line) still follows the
    reason, under the node's name."""
    reason = NotReadyReason.of("key", phrase="OpenAI API key", it="it")
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: reason)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: "Writer")
    errors = [
        ValidationErrorDetail(node_id="n1", port_id="", message="Missing API key: OPENAI_API_KEY",
                              person="Add your OpenAI API key in Settings, then run the node again.").marked("reason"),
        ValidationErrorDetail(node_id="n1", port_id="", message="batch", person="Give it its own run."),
    ]
    assert main._refused_run_log_line(errors) == (
        f"{HEADING} “Writer” needs your OpenAI API key. Add it in Settings, then run the node again. "
        "“Writer” can’t run. Give it its own run.")


def test_a_reason_stop_with_no_reason_found_says_its_card_line(monkeypatch):
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: None)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: "Writer")
    errors = [ValidationErrorDetail(node_id="n1", port_id="", message="Missing API key: X",
                                    person="Add your X key in Settings, then run the node again.").marked("reason")]
    assert main._refused_run_log_line(errors) == (
        f"{HEADING} “Writer” can’t run. Add your X key in Settings, then run the node again.")


# -- the table: one pattern for every input kind ------------------------------------------

@pytest.mark.parametrize("label,one,many", [
    ("Prompt", "needs a prompt. Connect one, then run the node again.",
     "need a prompt. Connect a prompt to each, then run the nodes again."),
    ("Image", "needs an image. Connect one, then run the node again.",
     "need an image. Connect an image to each, then run the nodes again."),
    ("Audio", "needs audio. Connect it, then run the node again.",
     "need audio. Connect audio to each, then run the nodes again."),
    ("Images (1-4)", "needs images. Connect them, then run the node again.",
     "need images. Connect images to each, then run the nodes again."),
    ("Item 1", "needs an output connected to “Item 1”. Connect one, then run the node again.",
     "need an output connected to “Item 1”. Connect one to “Item 1” on each, then run the nodes again."),
    ("", "needs an input. Connect one, then run the node again.",
     "need an input. Connect an input to each, then run the nodes again."),
])
def test_every_input_kind_takes_the_one_pattern(label, one, many):
    need = person_line.input_need(label)
    assert need.again == (one, many)
    assert need.one == one.replace(", then run the node again.", ".")
    for text in (*need.again, need.one, need.many):
        assert "'" not in text and "..." not in text


def test_the_same_input_on_different_names_is_one_line_and_a_different_input_another():
    rows = [("A", person_line.input_need("Prompt")), ("B", person_line.input_need("Prompt")), ("A", person_line.input_need("Image"))]
    assert merged_not_ready(rows, again=True) == [
        ("“A” and “B” need a prompt. Connect a prompt to each, then run the nodes again.", 2),
        ("“A” needs an image. Connect one, then run the node again.", 1)]
    four = [(name, person_line.input_need("Prompt")) for name in "ABCD"]
    assert merged_not_ready(four, again=True) == [
        ("4 nodes need a prompt. Connect a prompt to each, then run the nodes again.", 4)]


# -- M2: Nebula's own line is never cut ---------------------------------------------------

def _longest_rows(count: int = 3) -> list[dict]:
    rows = json.loads((FIXTURES / "not_ready_reasons.json").read_text(encoding="utf-8"))["reasons"]
    return sorted(rows, key=lambda row: -len(row["logOne"]))[:count]


def _reasons_canvas(monkeypatch, labels: list[str], rows: list[dict]) -> list[ValidationErrorDetail]:
    by_id = {f"n{i}": (label, row) for i, (label, row) in enumerate(zip(labels, rows))}
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: by_id[node_id][0])
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: NotReadyReason(
        by_id[node_id][1]["one"], by_id[node_id][1]["many"],
        again=(by_id[node_id][1]["logOne"], by_id[node_id][1]["logMany"]), kind=by_id[node_id][1]["kind"]))
    return [ValidationErrorDetail(node_id=node_id, port_id="", message="stop", person="x").marked("reason")
            for node_id in by_id]


def test_the_three_longest_reasons_at_the_label_limit_take_the_count_form_whole(monkeypatch):
    from services.canvas_edits import MAX_LABEL

    labels = [f"{i}" + "L" * (MAX_LABEL - 1) for i in range(3)]
    errors = _reasons_canvas(monkeypatch, labels, _longest_rows())
    named = " ".join([HEADING, *(f"“{label}” {row['logOne']}" for label, row in zip(labels, _longest_rows()))])
    assert len(named) > agent_presence.MAX_LOG_CHARS
    line = main._refused_run_log_line(errors)
    assert line == f"{HEADING} 3 nodes can’t run here yet."


def test_the_switch_point_is_the_logs_room(monkeypatch):
    """Two nodes: at exactly MAX_LOG_CHARS the line names them; one character
    more and it counts them."""
    rows = _longest_rows(2)

    def line_for(a: int, b: int) -> str:
        return main._refused_run_log_line(_reasons_canvas(monkeypatch, ["a" * a, "b" * b], rows))

    room = agent_presence.MAX_LOG_CHARS - len(line_for(0, 0))
    assert room > 0
    fits = line_for(room - room // 2, room // 2)
    assert len(fits) == agent_presence.MAX_LOG_CHARS and fits.startswith(f"{HEADING} “aaa")
    assert line_for(room - room // 2 + 1, room // 2) == f"{HEADING} 2 nodes can’t run here yet."


def test_one_nodes_line_past_the_room_is_said_whole_and_reaches_the_log_whole(monkeypatch):
    """One node has no shorter form: its line is said whole, and the cursor's
    event carries it whole (agent_presence.clean_log ``whole``)."""
    stops = [f"Set “Field {i}” to a whole number from 1 to 25." for i in range(20)]
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: None)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: "Writer")
    errors = [ValidationErrorDetail(node_id="n1", port_id="set", message=f"m{i}", person=stop)
              for i, stop in enumerate(stops)]
    line = main._refused_run_log_line(errors)
    assert line == f"{HEADING} “Writer” can’t run. " + " ".join(stops)
    assert len(line) > agent_presence.MAX_LOG_CHARS

    sent: list[dict] = []

    async def heard(data, **kwargs):
        sent.append(data)

    monkeypatch.setattr(main.manager, "broadcast_raw", heard)
    with agent_presence.request_headers_scope(MCP):
        asyncio.run(main._say_refused_run(errors))
    [event] = sent
    assert event["log"] == line
    assert event["say"] == agent_presence.clean_say(event["say"])


def test_an_agents_text_in_the_log_is_still_capped():
    """Only Nebula's own whole line skips the room: a line built from what an
    agent sent (raw keys) is still cut, never through a character."""
    assert len(agent_presence.clean_log("x" * 5000)) == agent_presence.MAX_LOG_CHARS
    assert agent_presence.clean_log("x" * 5000, whole=True) == "x" * 5000
    sent: list[dict] = []

    async def heard(data, **kwargs):
        sent.append(data)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(main.manager, "broadcast_raw", heard)
        with agent_presence.request_headers_scope(MCP):
            asyncio.run(main._show_agent({"nodeId": "n1"}, say="Set", log="Set " + "k" * 5000))
    [event] = sent
    assert len(event["log"]) == agent_presence.MAX_LOG_CHARS


# -- GM r33 item 4: the missing-key line names another provider only when its key is set ----

ROUTE_KEY = "“FLUX.2” is set to Black Forest Labs, which needs your Black Forest Labs API key. Add it in Settings"


@pytest.mark.parametrize("keys,line", [
    ({}, f"{ROUTE_KEY}."),
    ({"REPLICATE_API_TOKEN": "set"}, f"{ROUTE_KEY}."),
    ({"FAL_KEY": "set"}, f"{ROUTE_KEY} or switch to fal.ai."),
], ids=["nothing-set", "an-unrelated-key", "fal-key-set"])
def test_the_missing_key_line_names_another_provider_only_when_its_key_is_set(keys, line):
    from services import node_readiness, node_route
    from services.node_registry import NodeRegistry

    definitions = NodeRegistry().get_all()
    flux2 = definitions["flux-2-pro"]
    assert node_route.route_unavailable_line(flux2, {"_provider": "bfl"}, keys) == line
    reason = node_readiness.instance_missing_reason(flux2, {"_provider": "bfl"}, set(keys), False, definitions, {})
    assert reason.line("“FLUX.2”") == line
    assert reason.again[0] == line.removeprefix("“FLUX.2” ").removesuffix(".") + ", then run the node again."


# -- review 16, N1: the size and retired why-clauses, pinned with a fixture route --------

def _fixture_route(rule: str, value: dict) -> dict:
    import copy

    definition = copy.deepcopy(json.loads((FIXTURES / "route_cases.json").read_text(encoding="utf-8"))
                               ["definitions"]["routes-image"])
    for route in definition["routes"]:
        if route["id"] == "bfl":
            route.setdefault("rules", {})[rule] = value
    return definition


@pytest.mark.parametrize("rule,value,params,why", [
    ("size", {"param": "aspect_ratio", "unsupported": ["9:21"]}, {"aspect_ratio": "9:21"},
     ", because it can’t render this “Aspect ratio” exactly. "),
    ("retires", {"on": "2000-01-01"}, {}, ", because the maker retired this model on 2000-01-01. "),
], ids=["size", "retired"])
def test_the_size_and_retired_clauses_read_curly(rule, value, params, why):
    """The generator walks only the registry's route tables, where neither
    rule is set today, so not_ready_reasons.json has no row for them."""
    from services import node_route

    line = node_route.route_unavailable_line(_fixture_route(rule, value), {"_provider": "bfl", **params},
                                             {"BFL_API_KEY": "set", "FAL_KEY": "set"})
    assert line.startswith(f"“Fixture Image” can’t run on Black Forest Labs{why}"), line
    assert "'" not in line
