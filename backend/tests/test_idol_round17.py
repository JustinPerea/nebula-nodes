"""PR #203 round 17: GM r32.

- The card's route lines quote the node's name, as the bar and the log do.
- A refused run's card heading is the Agent log's "Nebula couldn’t start the
  run.": node_errors keeps that the pre-call check refused it, across a
  reload, until the node runs or fails again.
- Two actions take a comma between them when the fix lists options: "Pick
  A, B or C, or switch to fal.ai" (the log then ends ". Then run the node
  again.").
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from execution import person_line
from execution.person_line import NotReadyReason, route_action
from models.events import ErrorEvent, ExecutingEvent, ValidationErrorDetail
from services import node_route
from services.node_errors import NodeErrors
from services.node_registry import NodeRegistry

FIXTURES = Path(__file__).parent / "fixtures"


def _pick(options: list[str]) -> Fix:
    words = options[0] if len(options) == 1 else f"{', '.join(options[:-1])} or {options[-1]}"
    return person_line.Fix(f"Pick {words}", len(options))


# -- item 1: the two-action comma ------------------------------------------------

@pytest.mark.parametrize("options, with_switch, alone", [
    (["1K"], "Pick 1K or switch to fal.ai", "Pick 1K"),
    (["1K", "2K"], "Pick 1K or 2K, or switch to fal.ai", "Pick 1K or 2K"),
    (["1K", "2K", "4K"], "Pick 1K, 2K or 4K, or switch to fal.ai", "Pick 1K, 2K or 4K"),
], ids=["one", "two", "three"])
def test_two_actions_take_a_comma_when_the_fix_lists_options(options, with_switch, alone):
    assert route_action(_pick(options), ["fal.ai"], [], None) == (with_switch, len(options) > 1)
    assert route_action(_pick(options), [], [], None) == (alone, False)


def test_the_other_action_shapes_keep_their_words():
    assert route_action(_pick(["1K", "2K", "4K"]), ["fal.ai", "Replicate"], [], None) == (
        "Pick 1K, 2K or 4K, or switch to fal.ai or Replicate", True)
    assert route_action(person_line.Fix("Turn “Raw” off"), ["fal.ai"], [], None) == ("Turn “Raw” off or switch to fal.ai", False)
    assert route_action("Add it in Settings", ["fal.ai"], [], None) == ("Add it in Settings or switch to fal.ai", False)
    assert route_action(_pick(["1K", "2K"]), [], ["fal.ai"], "fal.ai API key") == (
        "Pick 1K or 2K, or add your fal.ai API key in Settings and switch to fal.ai", True)


def test_a_listed_fix_ends_the_log_line_with_its_own_sentence():
    action, after_clause = route_action(_pick(["1K", "2K", "4K"]), ["fal.ai"], [], None)
    reason = NotReadyReason.of("route_block", after_clause=after_clause, provider="Black Forest Labs",
                               why=" with “Resolution” set to 1.5K", action=action)
    assert reason.one.endswith("Pick 1K, 2K or 4K, or switch to fal.ai.")
    assert reason.again[0].endswith("Pick 1K, 2K or 4K, or switch to fal.ai. Then run the node again.")
    assert reason.again[1].endswith("Pick 1K, 2K or 4K, or switch to fal.ai. Then run the nodes again.")


def test_a_real_stop_with_four_resolutions_lists_them_then_the_comma():
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    line = node_route.route_unavailable_line(flux3, {"_provider": "fal", "resolution": "1.5K"},
                                             {"FAL_KEY": "set", "REPLICATE_API_TOKEN": "set"})
    assert line.startswith("“FLUX 3 Image” can’t run on fal.ai with “Resolution” set to 1.5K. Pick ")
    assert line.endswith(" or 4K, or switch to Replicate.")


# -- item 1 of GM's card note: quoted names on the card -----------------------------

def test_the_card_quotes_the_node_name_as_the_log_does():
    flux3 = NodeRegistry().get_all()["flux-3-image"]
    assert node_route.route_unavailable_line(flux3, {"_provider": "replicate"}, {"FAL_KEY": "set"}) == (
        "“FLUX 3 Image” is set to Replicate, which needs your Replicate token. Add it in Settings or switch to fal.ai.")
    assert node_route.card_subject({"displayName": "FLUX 3 Image"}) == "“FLUX 3 Image”"
    assert node_route.card_subject({"displayName": "  "}) == "This node"


def test_every_card_route_line_in_the_fixtures_quotes_its_node():
    cases = json.loads((FIXTURES / "route_cases.json").read_text(encoding="utf-8"))
    lines = [case["unavailableLine"] for case in cases["cases"] if case.get("unavailableLine")]
    named = [line for line in lines if " is set to " in line or " can’t run on " in line]
    assert len(named) > 20
    for line in named:
        assert line.startswith("“"), line
    reasons = json.loads((FIXTURES / "not_ready_reasons.json").read_text(encoding="utf-8"))
    for row in reasons["reasons"] if isinstance(reasons, dict) else reasons:
        assert row["line"].startswith(("“", "You can run", "This node")), row["line"]


# -- the heading: node_errors keeps that the run was refused before it started -------

def _refusal(node_id: str = "n1") -> ValidationErrorDetail:
    return ValidationErrorDetail(node_id=node_id, port_id="", message="Missing API key: OPENAI_API_KEY",
                                 person="Add your OpenAI API key in Settings, then run the node again.")


def test_a_refused_run_is_marked_on_the_card_and_survives_a_reload(tmp_path):
    path = tmp_path / "node-errors.json"
    errors = NodeErrors(path)
    errors.use_project("p1")
    errors.record_validation([_refusal()])
    assert errors.card("n1")["errorNotStarted"] is True
    # Agents read the same text as before: the mark is the card's.
    assert errors.get("n1") == {"error": "Missing API key: OPENAI_API_KEY"}
    restarted = NodeErrors(path)
    restarted.use_project("p1")
    assert restarted.card("n1") == {"state": "error", "error": "Missing API key: OPENAI_API_KEY",
                                    "errorPerson": "Add your OpenAI API key in Settings, then run the node again.",
                                    "errorNotStarted": True}


def test_a_run_error_after_a_refusal_has_no_mark(tmp_path):
    errors = NodeErrors(tmp_path / "node-errors.json")
    errors.use_project("p1")
    errors.record_validation([_refusal()])
    errors.observe(ErrorEvent(node_id="n1", error="HTTP 500 from OpenAI", category="unknown"))
    assert "errorNotStarted" not in errors.card("n1")
    errors.record_validation([_refusal()])
    errors.observe(ExecutingEvent(node_id="n1"))
    assert errors.card("n1") is None
