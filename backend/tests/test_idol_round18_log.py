"""PR #203 round 18, GM r34 item 1: one node with several needs.

- One node with two needs: "“FLUX Kontext” needs a prompt and an image.
  Connect both, then run the node again."; three or more: "…needs a
  prompt, a base image and a mask. Connect them, …".
- Nodes with the same set merge: "2 “FLUX Kontext” nodes need a prompt and
  an image. Connect both to each, then run the nodes again." Different sets
  stay separate sentences.
- The needs follow the node's input order, and the same set merges whatever
  order another node's inputs are in.
- From 4 nodes, nodes that share a set count inside its sentence (GM r35:
  "4 nodes need a prompt and an image. …"); only a line too long for the
  log says "N nodes can’t run here yet." instead.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import main
from commons.actors import agent_registry
from execution import person_line
from execution.person_line import merged_not_ready
from models.events import ValidationErrorDetail
from services import agent_presence
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture

HEADING = "Nebula couldn’t start the run."
MCP = {"X-Nebula-Agent": "Claude Code"}
CLI = {"X-Nebula-Agent": "Claude Code", "X-Nebula-Surface": "cli"}
KONTEXT = "flux-kontext"            # Prompt, Image
FILL = "flux-fill-inpaint"          # Prompt, Base Image, Mask (white = edit)
EDIT = "gpt-image-1-edit"           # Image, Prompt (then two optional inputs)
GPT = "gpt-image-2-generate"        # Prompt
KEYS = {"FAL_KEY": "fal-test-fake", "OPENAI_API_KEY": "sk-test-fake"}


@pytest.fixture
def chat_turn():
    token = agent_registry.mint("claude", [], session="chat-r18")
    yield {"Authorization": f"Agent {token}"}
    agent_registry.revoke(token)


def _refused(monkeypatch, definitions: list[str], headers: dict[str, str], lines: list[str]) -> tuple[dict, list[str], list[str]]:
    """Run a canvas of nodes with nothing connected: the reply, the node ids
    and what the Agent log listed for the run."""
    monkeypatch.setattr(main, "load_settings", lambda: {"apiKeys": dict(KEYS)})
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


CASES = [
    ([KONTEXT], f"{HEADING} “FLUX Kontext” needs a prompt and an image. Connect both, then run the node again."),
    ([FILL], f"{HEADING} “FLUX Fill (Inpaint)” needs a prompt, a base image and a mask. Connect them, then run "
             "the node again."),
    ([KONTEXT, KONTEXT], f"{HEADING} 2 “FLUX Kontext” nodes need a prompt and an image. Connect both to each, "
                         "then run the nodes again."),
    ([KONTEXT, EDIT], f"{HEADING} “FLUX Kontext” and “GPT Image 1 Edit” need a prompt and an image. Connect "
                      "both to each, then run the nodes again."),
    ([KONTEXT, FILL], f"{HEADING} “FLUX Kontext” needs a prompt and an image. Connect both, then run the node "
                      "again. “FLUX Fill (Inpaint)” needs a prompt, a base image and a mask. Connect them, then "
                      "run the node again."),
    ([KONTEXT, GPT], f"{HEADING} “FLUX Kontext” needs a prompt and an image. Connect both, then run the node "
                     "again. “GPT Image 2” needs a prompt. Connect one, then run the node again."),
    ([KONTEXT] * 4, f"{HEADING} 4 nodes need a prompt and an image. Connect both to each, then run the nodes "
                    "again."),
    ([KONTEXT] * 4 + [FILL] * 4, f"{HEADING} 4 nodes need a prompt and an image. Connect both to each, then run "
                                 "the nodes again. 4 nodes need a prompt, a base image and a mask. Connect them to "
                                 "each, then run the nodes again."),
    ([KONTEXT] * 4 + [GPT], f"{HEADING} 4 nodes need a prompt and an image. Connect both to each, then run the "
                            "nodes again. “GPT Image 2” needs a prompt. Connect one, then run the node again."),
]


@pytest.mark.parametrize("definitions,line", CASES, ids=[
    "one-node-two-needs", "one-node-three-needs", "same-set-same-name", "same-set-other-order",
    "different-sets", "a-set-and-one-need", "counted-from-4", "two-sets-counted", "a-counted-set-and-one"])
@pytest.mark.parametrize("who", ["mcp", "cli", "chat"])
def test_a_node_with_several_needs_says_them_once(monkeypatch, agent_log, chat_turn, who,  # noqa: F811
                                                  definitions, line):
    headers = {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]
    body, ids, said = _refused(monkeypatch, definitions, headers, agent_log)
    assert body["status"] == "failed" and body["nodesExecuted"] == 0
    assert said == [line]
    # One run-again ending per action, so never two for one node.
    assert said[0].count(" again.") == said[0].count("Connect ")
    # Agents still read every node by id, in the engine's words.
    assert set(body["errors"]) == set(ids)
    assert all("Required input port prompt is not connected" in body["errors"][i] for i in ids)


MANY_SETS = [KONTEXT, FILL, "runway-aleph", "mmaudio-v2", "minimax-s2v", "seedance-2-r2v", "spatial-context",
             "image-compare", "wan-2-6-r2v"]


@pytest.mark.parametrize("who", ["mcp", "cli", "chat"])
def test_only_a_line_too_long_for_the_log_says_the_count_instead(monkeypatch, agent_log, chat_turn, who):  # noqa: F811
    """GM r35 item 1: the log falls back to "N nodes can’t run here yet."
    only when the per-set sentences don't fit (agent_presence.MAX_LOG_CHARS)."""
    headers = {"mcp": MCP, "cli": CLI, "chat": chat_turn}[who]
    body, ids, said = _refused(monkeypatch, MANY_SETS, headers, agent_log)
    assert body["status"] == "failed" and set(body["errors"]) == set(ids)
    assert said == [f"{HEADING} {len(MANY_SETS)} nodes can’t run here yet."]
    # The named form it replaced was longer than the log's room.
    errors = [ValidationErrorDetail(node_id=f"n{i}", port_id="p", message="m", person="x").marked("input", label)
              for i in range(len(MANY_SETS)) for label in ("Prompt", f"Image {chr(65 + i)}")]
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: None)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: f"Node {node_id}")
    monkeypatch.setattr(main, "_input_order", lambda node_id: {})
    assert main._refused_run_log_line(errors) == f"{HEADING} {len(MANY_SETS)} nodes can’t run here yet."


def test_the_needs_follow_the_nodes_input_order_whatever_order_the_checks_came_in(monkeypatch):
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: None)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: "FLUX Fill (Inpaint)")
    monkeypatch.setattr(main, "_input_order", lambda node_id: {"prompt": 0, "image": 1, "mask": 2})
    unwired = [("mask", "Mask (white = edit)"), ("image", "Base Image"), ("prompt", "Prompt")]
    errors = [ValidationErrorDetail(node_id="n1", port_id=port, message=f"Required input port {port} is not connected",
                                    person="x").marked("input", label) for port, label in unwired]
    assert main._refused_run_log_line(errors) == (
        f"{HEADING} “FLUX Fill (Inpaint)” needs a prompt, a base image and a mask. Connect them, then run the "
        "node again.")


def test_the_count_early_rule_still_keeps_the_line_whole(monkeypatch):
    names = {f"n{i}": f"{chr(65 + i)} " + "very long node name " * 12 for i in range(3)}
    monkeypatch.setattr(main, "_node_not_ready_reason", lambda node_id: None)
    monkeypatch.setattr(main, "_node_label", lambda node_id, graph=None: names[node_id].strip())
    monkeypatch.setattr(main, "_input_order", lambda node_id: {})
    sets = {"n0": ["Prompt", "Image"], "n1": ["Prompt", "Base Image", "Mask"], "n2": ["Audio", "Video"]}
    errors = [ValidationErrorDetail(node_id=node, port_id=label.lower(), message="m", person="x").marked("input", label)
              for node, labels in sets.items() for label in labels]
    line = main._refused_run_log_line(errors)
    assert line == f"{HEADING} 3 nodes can’t run here yet."
    assert len(line) <= agent_presence.MAX_LOG_CHARS


# -- the table: every input kind in a set ------------------------------------------------

@pytest.mark.parametrize("labels,one,many", [
    (["Prompt", "Image"], "needs a prompt and an image. Connect both, then run the node again.",
     "need a prompt and an image. Connect both to each, then run the nodes again."),
    (["Prompt", "Base Image", "Mask (white = edit)"],
     "needs a prompt, a base image and a mask. Connect them, then run the node again.",
     "need a prompt, a base image and a mask. Connect them to each, then run the nodes again."),
    (["Audio", "Images (1-4)"], "needs audio and images. Connect both, then run the node again.",
     "need audio and images. Connect both to each, then run the nodes again."),
    (["Image A", "Image B"],
     "needs an output connected to “Image A” and an output connected to “Image B”. Connect both, then run the "
     "node again.",
     "need an output connected to “Image A” and an output connected to “Image B”. Connect both to each, then "
     "run the nodes again."),
    (["Prompt", "Item 1"], "needs a prompt and an output connected to “Item 1”. Connect both, then run the node "
                           "again.",
     "need a prompt and an output connected to “Item 1”. Connect both to each, then run the nodes again."),
])
def test_every_input_kind_takes_the_set_pattern(labels, one, many):
    need = person_line.input_needs(labels)
    assert need.again == (one, many)
    assert need.one == one.replace(", then run the node again.", ".")
    for text in (*need.again, need.one, need.many):
        assert "'" not in text and "..." not in text


def test_one_need_is_the_single_line_and_a_repeated_input_is_said_once():
    assert person_line.input_needs(["Prompt"]).again == person_line.input_need("Prompt").again
    assert person_line.input_needs(["Item 1"]).again == person_line.input_need("Item 1").again
    assert person_line.input_needs(["Image", "Image"]).again == person_line.input_need("Image").again


def test_four_nodes_with_one_set_merge_with_the_count():
    four = [(name, person_line.input_needs(["Prompt", "Image"])) for name in "ABCD"]
    assert merged_not_ready(four, again=True) == [
        ("4 nodes need a prompt and an image. Connect both to each, then run the nodes again.", 4)]
