"""PR #203 round 19, section 1: GM r37.

- Item 1: every route line with two actions takes the comma ("Add it in
  Settings, or switch to fal.ai."), and in the Agent Log "Then run the node
  again." is its own sentence after it. One builder: person_line.route_action.
- Item 2: "media" isn't one thing the person connects: "“X” needs a media
  input. Connect one, …", after a count "Connect a media input to each".
  The general rule: after a count the action names the input, never a
  pronoun; "it" only for the mass nouns that are one thing.
- Item 3: sizes read "768 × 768", the option's own label, on every surface;
  no option label writes a size with an x, and no line builder formats a
  size itself.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from execution import engine, person_line
from execution.engine import validate_graph
from execution.person_line import Fix, NotReadyReason, input_need, input_words, route_action
from models.graph import GraphEdge, GraphNode
from services import node_route
from services.node_registry import NodeRegistry
from tests import test_idol_round18_copy as r18
from tests.test_cli_run_errors import agent_log  # noqa: F401 - fixture
from tests.test_idol_round18_copy import HEADING, WHO, _headers, _run, bubbles, chat_turn  # noqa: F401 - fixtures

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
FAL_ONLY = {"FAL_KEY": "fal-test-fake", "ANTHROPIC_API_KEY": "sk-ant-test-fake"}


# -- item 1: the comma before every second action ----------------------------------------

@pytest.mark.parametrize("fix,others,expected", [
    (Fix("Pick 1K"), ["fal.ai"], "Pick 1K, or switch to fal.ai"),
    ("Add it in Settings", ["fal.ai"], "Add it in Settings, or switch to fal.ai"),
    (Fix("Turn “Raw” off"), ["Replicate"], "Turn “Raw” off, or switch to Replicate"),
    (Fix("Pick 1K, 2K or 4K", 3), ["fal.ai"], "Pick 1K, 2K or 4K, or switch to fal.ai"),
    (Fix("Pick 1K"), ["fal.ai", "Replicate"], "Pick 1K, or switch to fal.ai or Replicate"),
])
def test_every_second_action_takes_the_comma_and_the_log_ends_on_its_own(fix, others, expected):
    action, clause = route_action(fix, others, [], None)
    assert (action, clause) == (expected, True)
    reason = NotReadyReason.of("route_block", after_clause=clause, provider="Black Forest Labs", why="", action=action)
    assert reason.one.endswith(f"{expected}.")
    assert reason.again == (f"can’t run on Black Forest Labs. {expected}. Then run the node again.",
                            f"can’t run on Black Forest Labs. {expected}. Then run the nodes again.")


def test_one_action_keeps_its_run_again_clause():
    assert route_action(Fix("Pick 1K"), [], [], None) == ("Pick 1K", False)
    assert route_action(None, ["fal.ai"], [], None) == ("Switch to fal.ai", False)


def test_no_route_line_says_a_second_action_without_the_comma():
    """Every route case's card line and every generated reason: a switch
    after an action always follows a comma (the shared fixtures both
    builders are checked against)."""
    cases = json.loads((BACKEND / "tests/fixtures/route_cases.json").read_text(encoding="utf-8"))
    reasons = (BACKEND / "tests/fixtures/not_ready_reasons.json").read_text(encoding="utf-8")
    lines = [str(case.get("unavailableLine") or "") for case in cases["cases"]]
    assert sum(" or switch to " in line for line in lines) > 5
    for text in [*lines, reasons]:
        assert not re.search(r"[^,\s] or (switch|add your) ", text), text[:200]
    assert not re.search(r"or switch to [^.\"]*, then run the", reasons)


SINGLE = ("flux-3-image", {"_provider": "bfl"})


@WHO
def test_a_single_switch_reads_the_same_on_the_card_and_in_every_log(monkeypatch, agent_log, bubbles,  # noqa: F811
                                                                     chat_turn, person, who):
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    card = node_route.route_unavailable_line(flux3, SINGLE[1], FAL_ONLY)
    assert card == ("“FLUX 3 Image” is set to Black Forest Labs, which needs your Black Forest Labs API key. "
                    "Add it in Settings, or switch to fal.ai.")
    monkeypatch.setattr(r18, "KEYS", FAL_ONLY)
    body = _run(monkeypatch, [("text-input", {"value": "a fox"}), SINGLE], _headers(who, chat_turn),
                agent_log, wires=((0, "text", 1, "prompt"),))
    assert body.get("status") == "failed", body
    assert agent_log == [f"{HEADING} “FLUX 3 Image” is set to Black Forest Labs, which needs your Black Forest "
                         "Labs API key. Add it in Settings, or switch to fal.ai. Then run the node again."]


def test_the_agents_route_message_takes_the_comma_too():
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    message = node_route.route_unavailable(flux3, SINGLE[1], FAL_ONLY)["message"]
    assert "Add it in Settings > Providers, or choose another provider." in message


# -- item 2: a media input ---------------------------------------------------------------------

def test_media_is_a_media_input_never_it():
    need = input_need("Media")
    assert input_words("Media") == "a media input"
    assert need.one == "needs a media input. Connect one."
    assert need.again == ("needs a media input. Connect one, then run the node again.",
                          "need a media input. Connect a media input to each, then run the nodes again.")
    assert person_line.connect_line("Media") == "Connect a media input to this node, then run it again."
    assert person_line.input_needs(["Prompt", "Media"]).one == "needs a prompt and a media input. Connect both."


# Mass nouns that are one thing the person connects ("Connect it"); GM r36
# B2 and r37 item 2 ruled each. A new one must be ruled before it joins.
ONE_THING = {"audio", "text", "context", "lighting", "guidance"}


def _every_input_label() -> set[str]:
    labels: set[str] = set()
    for definition in [*NodeRegistry().get_all().values(), *engine.NODE_DEFS.values()]:
        for port in definition.get("inputPorts") or definition.get("inputs") or []:
            if isinstance(port, dict) and (port.get("label") or port.get("id")):
                labels.add(str(port.get("label") or port.get("id")))
    return labels


def test_every_input_kind_follows_the_one_rule():
    """The general rule (GM r33, r36 B2, r37 item 2), for every input any node
    has: after a count the action names the input ("Connect a prompt to
    each"), never a pronoun; for one node "one" after an article, "them" for a
    plural, and "it" only for a mass noun that is one thing."""
    labels = _every_input_label()
    assert len(labels) > 100 and "Media" in labels
    for label in labels:
        need = input_need(label)
        one, many = need.again
        assert not re.search(r"Connect (one|it|them) to each", many), (label, many)
        if many.startswith("need an output connected to"):
            continue
        words = input_words(label)
        assert many.startswith(f"need {words}. Connect {words} to each, "), (label, many)
        pronoun = re.search(r"\. Connect (\w+),", one).group(1)
        last = words.split()[-1].lower()
        if words.startswith(("a ", "an ")):
            assert pronoun == "one", (label, one)
        elif pronoun == "it":
            assert last in ONE_THING, (label, one)
        else:
            assert pronoun == "them", (label, one)
    assert set(person_line._MASS_NOUNS) - set(person_line._PLURAL_MASS_NOUNS) == ONE_THING


MEDIA_NODE = {
    "id": "fixture-media", "displayName": "Media Mixer", "category": "utility", "executionPattern": "sync",
    "inputPorts": [{"id": "media", "label": "Media", "dataType": "Any", "required": True}],
    "outputPorts": [{"id": "out", "label": "Out", "dataType": "Any", "required": False}], "params": [],
}


@pytest.fixture
def media_node(monkeypatch):
    """A node with a required Media input (none in the catalog has one today),
    in the registry every surface reads."""
    import main

    monkeypatch.setitem(main.node_registry.get_all(), "fixture-media", MEDIA_NODE)
    monkeypatch.setitem(engine._registry_node_defs(), "fixture-media", MEDIA_NODE)
    yield MEDIA_NODE


def test_a_media_inputs_card_line(media_node):
    [error] = validate_graph([GraphNode(id="n1", definitionId="fixture-media", params={})], [], {})
    assert error.person == "Connect a media input to this node, then run it again."


@WHO
def test_media_input_lines_in_every_log(monkeypatch, agent_log, chat_turn, person, media_node, who):  # noqa: F811
    body = _run(monkeypatch, [("fixture-media", {})], _headers(who, chat_turn), agent_log)
    assert body["status"] == "failed"
    assert agent_log == [f"{HEADING} “Media Mixer” needs a media input. Connect one, then run the node again."]
    body = _run(monkeypatch, [("fixture-media", {})] * 2, _headers(who, chat_turn), agent_log)
    assert agent_log == [f"{HEADING} 2 “Media Mixer” nodes need a media input. Connect a media input to each, "
                         "then run the nodes again."]


# -- item 3: sizes from the option's own label ----------------------------------------------

SIZE = re.compile(r"\d\s*[xX×]\s*\d")


def _option_labels(definitions) -> list[str]:
    found = []
    for definition in definitions:
        for param in [*(definition.get("params") or []), *(definition.get("sharedParams") or [])]:
            for option in param.get("options") or [] if isinstance(param, dict) else []:
                if isinstance(option, dict):
                    found.append(str(option.get("label") or ""))
    return found


def test_every_size_option_label_is_written_with_a_spaced_times_sign():
    labels = [label for label in _option_labels(NodeRegistry().get_all().values()) if SIZE.search(label)]
    assert len(labels) > 150 and "768 × 768" in labels
    for label in labels:
        assert not re.search(r"\d\s*[xX]\s*\d|\d×|×\d", label), label


def test_the_line_builders_read_the_label_and_never_format_a_size():
    """Every surface's route line comes from these builders, and they take a
    size from the option's label (person_line.option_label) as it is: none
    writes a size or joins two numbers with an x or a ×."""
    builders = ["execution/person_line.py", "services/node_route.py", "cli/formatter.py", "mcp_server.py"]
    pattern = re.compile(r"\}\s*[xX×]\s*\{|[\"'][^\"'\n]*\d\s*[xX×]\s*\d[^\"'\n]*[\"']")
    for name in builders:
        source = (BACKEND / name).read_text(encoding="utf-8")
        code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
        hits = [hit for hit in pattern.findall(code) if "768sq" not in hit and "|" not in hit]
        if name == "cli/formatter.py":
            # A node's box on the canvas, in pixels (`nebula look`), not an option.
            hits.remove("}×{")
        assert hits == [], (name, hits[:3])
    assert person_line.option_label("flux-3-image", "resolution", "768sq") == "768 × 768"


@WHO
def test_a_size_reads_the_same_on_the_card_the_bubble_and_every_log(monkeypatch, agent_log, bubbles,  # noqa: F811
                                                                    chat_turn, person, who):
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    line = ("“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K. Pick 768 × 768, 1K, 2K or 4K, "
            "or switch to Black Forest Labs or Replicate.")
    keys = {"FAL_KEY": "f", "REPLICATE_API_TOKEN": "r", "BFL_API_KEY": "b"}
    assert node_route.route_unavailable_line(flux3, r18.FLUX3_AT_1_5K[1], keys) == line
    monkeypatch.setattr(r18, "KEYS", keys)
    body = _run(monkeypatch, [("text-input", {"value": "a fox"}), r18.FLUX3_AT_1_5K], _headers(who, chat_turn),
                agent_log, bubbles, wires=((0, "text", 1, "prompt"),))
    assert body.get("status") == "failed", body
    # The bubble says the first sentence, what's wrong; the action is on the
    # card and in the log (GM, PR #203 r39 item 5).
    assert bubbles == ["“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K."]
    assert agent_log == [f"{HEADING} {line[:-1]}. Then run the node again."]
