"""PR #203 round 18, section 2: review 17's copy findings, GM r36 B1, B2, B4, B5.

- B1 (MEDIUM-1): after a count, a numbered input's action names what to
  connect: "Connect an output to “Text 1” on each".
- B2 (LOW-1): "“Claude” needs messages. Connect them, …"; every other mass
  noun keeps "it".
- B4: a single option and two providers take the comma: "Pick 1K, or switch
  to fal.ai or Replicate."
- B5 (LOW-6): the cursor bubble is the line alone when the line already
  opens with the node's quoted name.
- NIT-2: runway-gen4-turbo's ports have labels, so its line names the image.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
from commons.actors import agent_registry
from execution import person_line
from execution.engine import validate_graph
from execution.person_line import NotReadyReason, route_action
from models.graph import GraphNode
from services import node_route
from services.node_registry import NodeRegistry
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture
from tests.test_idol_round12 import PERSON

HEADING = "Nebula couldn’t start the run."
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
KEYS = {"FAL_KEY": "fal-test-fake", "REPLICATE_API_TOKEN": "r8-test-fake", "ANTHROPIC_API_KEY": "sk-ant-test-fake"}


@pytest.fixture
def chat_turn():
    token = agent_registry.mint("claude", [], session="chat-r18-copy")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


@pytest.fixture
def bubbles(monkeypatch):
    """Each agent cursor's bubble (`say`) as the canvas shows it."""
    said: list[str] = []
    original = main.manager.broadcast_raw

    async def heard(data, **kwargs):
        if isinstance(data, dict) and data.get("type") == "agentPresence" and data.get("say"):
            said.append(str(data["say"]))
        await original(data, **kwargs)

    monkeypatch.setattr(main.manager, "broadcast_raw", heard)
    yield said


def _run(monkeypatch, nodes: list[tuple[str, dict]], headers: dict[str, str], *logs: list[str],
         wires: tuple[tuple[int, str, int, str], ...] = ()) -> dict:
    """Run a canvas of ``nodes`` (``wires`` between them by index) as
    ``headers``' caller; each of ``logs`` keeps only what the run added
    (never the canvas's own clear after)."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(KEYS)})
    monkeypatch.setattr(main, "execute_graph", AsyncMock())
    seen: list[list[str]] = []
    with TestClient(main.app) as client:
        client.delete("/api/graph?force=true")
        try:
            ids = []
            for definition, params in nodes:
                # The person places them: a provider choice is theirs.
                added = client.post("/api/graph/node", json={"definitionId": definition, "params": params},
                                    headers=PERSON)
                assert added.status_code == 200, added.text
                ids.append(added.json()["id"])
            for source, out, target, into in wires:
                wire = {"source": ids[source], "sourceHandle": out, "target": ids[target], "targetHandle": into}
                assert client.post("/api/graph/connect", headers=PERSON, json=wire).status_code == 200
            for log in logs:
                log.clear()
            response = client.post("/api/graph/run", json={}, headers=headers)
            seen = [list(log) for log in logs]
        finally:
            client.delete("/api/graph?force=true")
    for log, kept in zip(logs, seen):
        log[:] = kept
    return response.json()


WHO = pytest.mark.parametrize("who", ["mcp", "cli", "chat"])


def _headers(who: str, chat_turn: dict[str, str]) -> dict[str, str]:
    return {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]


# -- B1: a numbered input after a count -----------------------------------------------

@WHO
def test_two_combine_text_nodes_name_the_output_to_connect(monkeypatch, agent_log, chat_turn, person, who):  # noqa: F811
    body = _run(monkeypatch, [("combine-text", {})] * 2, _headers(who, chat_turn), agent_log)
    assert body["status"] == "failed"
    assert agent_log == [f"{HEADING} 2 “Combine Text” nodes need an output connected to “Text 1”. Connect an output "
                         "to “Text 1” on each, then run the nodes again."]


def test_one_combine_text_node_keeps_connect_one():
    need = person_line.input_need("Text 1")
    assert need.again[0] == "needs an output connected to “Text 1”. Connect one, then run the node again."
    assert need.again[1] == ("need an output connected to “Text 1”. Connect an output to “Text 1” on each, then "
                             "run the nodes again.")


# -- B2: messages are "them" ----------------------------------------------------------

@WHO
def test_claude_needs_messages_connect_them(monkeypatch, agent_log, chat_turn, person, who):  # noqa: F811
    body = _run(monkeypatch, [("claude-chat", {})], _headers(who, chat_turn), agent_log)
    assert body["status"] == "failed"
    assert agent_log == [f"{HEADING} “Claude” needs messages. Connect them, then run the node again."]


@pytest.mark.parametrize("label,pronoun", [("Audio", "it"), ("Text", "it"), ("Context", "it"), ("Lighting", "it"),
                                           ("Media", "it"), ("Messages", "them"), ("Guidance", "it")])
def test_every_mass_noun_takes_the_pronoun_of_its_number(label, pronoun):
    assert set(person_line._MASS_NOUNS) == {"audio", "text", "context", "lighting", "media", "messages", "guidance"}
    need = person_line.input_need(label)
    assert need.again[0] == f"needs {label.lower()}. Connect {pronoun}, then run the node again."


# -- B4: one option and two providers --------------------------------------------------

def test_one_option_and_two_providers_take_the_comma():
    assert route_action(person_line.Fix("Pick 1K", 1), ["fal.ai", "Replicate"], [], None) == (
        "Pick 1K, or switch to fal.ai or Replicate", True)
    assert route_action(person_line.Fix("Pick 1K", 1), ["fal.ai"], [], None) == ("Pick 1K or switch to fal.ai", False)
    reason = NotReadyReason.of("route_block", after_clause=True, provider="Black Forest Labs",
                               why=" with “Resolution” set to 1.5K", action="Pick 1K, or switch to fal.ai or Replicate")
    assert reason.one.endswith("Pick 1K, or switch to fal.ai or Replicate.")
    assert reason.again[0].endswith("Pick 1K, or switch to fal.ai or Replicate. Then run the node again.")


# -- B5: the bubble says the name once ------------------------------------------------

FLUX3_AT_1_5K = ("flux-3-image", {"_provider": "fal", "resolution": "1.5K"})


@WHO
def test_a_route_line_that_opens_with_the_name_is_the_bubble_alone(monkeypatch, agent_log, bubbles, chat_turn,  # noqa: F811
                                                                   person, who):
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    line = node_route.route_unavailable_line(flux3, FLUX3_AT_1_5K[1], KEYS)
    assert line.startswith("“FLUX 3 Image” can’t run on fal.ai")
    body = _run(monkeypatch, [("text-input", {"value": "a fox"}), FLUX3_AT_1_5K], _headers(who, chat_turn),
                agent_log, bubbles, wires=((0, "text", 1, "prompt"),))
    assert body.get("status") == "failed", body
    [bubble] = bubbles
    assert bubble.startswith("“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K.")
    assert bubble.count("“FLUX 3 Image”") == 1 and not bubble.startswith("“FLUX 3 Image” can’t run. ")


@WHO
def test_a_line_that_doesnt_open_with_the_name_keeps_the_bubbles_prefix(monkeypatch, agent_log, bubbles,  # noqa: F811
                                                                        chat_turn, person, who):
    body = _run(monkeypatch, [("claude-chat", {})], _headers(who, chat_turn), agent_log, bubbles)
    assert body["status"] == "failed"
    [bubble] = bubbles
    assert bubble.startswith("“Claude” can’t run. Connect ")


# -- NIT-2: runway-gen4-turbo's image ----------------------------------------------------

def test_runway_gen4_turbos_unwired_image_is_named():
    [error] = [e for e in validate_graph([GraphNode(id="n1", definitionId="runway-gen4-turbo", params={})], [],
                                         {"RUNWAY_API_KEY": "rw-test-fake"}) if e.port_id == "image"]
    assert error.person == "Connect an image to this node, then run it again."
    assert person_line.input_need("Image").again[0] == "needs an image. Connect one, then run the node again."
