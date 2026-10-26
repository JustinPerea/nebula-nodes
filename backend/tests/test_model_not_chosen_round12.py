"""Round 12 of feat/agent-presence: GM - Design's rulings of 2026-10-26.

(b) Topaz Standard with no model chosen. Krea's schema requires `model`, so
the gateway refuses the run before calling Krea (no spend). Nebula can tell
before anything runs, so it refuses the run up front, on every run path
(the canvas's runs, a direct run over placeholders before its confirmation,
agents' run_nodes and `nebula run`), naming the node and the field: GM's
"Choose a model for “Clean plate” first." Every Krea node whose
model-choosing setting is required and has no default counts (Topaz
Standard's Model, a node app's Version).

Item 1: "the agents" in the skip line and the paid-placeholder refusal.
"""
from __future__ import annotations

import pytest

from services import model_choice, pending_nodes
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _apply, _direct, _execute_body, _paid_chain, pend  # noqa: F401 - fixture

TOPAZ = "krea-enhance-topaz-standard-enhance"
GM_LINE = "Choose a model for “Clean plate” first."


@pytest.mark.parametrize(("definition_id", "params", "field"), [
    (TOPAZ, {}, "model"),
    (TOPAZ, {"model": ""}, "model"),
    (TOPAZ, {"model": "  "}, "model"),
    (TOPAZ, {"model": "CGI"}, None),
    ("krea-node-app", {}, "version"),
    ("krea-node-app", {"node_app_version_id": "v_9"}, None),
    # Settings with a default always have a model.
    ("krea-enhance-topaz-bloom-2-enhance", {}, None),
    ("krea-enhance-magnific-precise-enhance", {}, None),
    ("krea-enhance-topaz-video-upscale", {}, None),
    # Not a Krea node, or no model setting: never.
    ("nano-banana", {}, None),
    ("text-input", {}, None),
])
def test_which_settings_are_not_chosen(definition_id, params, field):
    assert model_choice.unchosen_field(definition_id, params) == field


def test_every_krea_node_with_a_required_model_setting_is_covered():
    """The inventory: every Krea definition whose model-choosing setting is
    required with no default. A new one shows up here."""
    assert model_choice.required_model_settings() == {
        TOPAZ: ("model", "model"),
        "krea-node-app": ("node_app_version_id", "version"),
    }


def test_the_line_names_the_node_and_the_field():
    assert model_choice.not_chosen_line("Clean plate", "model") == GM_LINE
    assert model_choice.not_chosen_line("Lab app", "version") == "Choose a version for “Lab app” first."


def _topaz_chain(pend, *, pending: bool, headers=CLAUDE, model: str | None = None) -> dict[str, str]:
    params = {} if model is None else {"model": model}
    body = {
        "note": "clean the plate",
        "nodes": [{"ref": "+s", "definitionId": "text-input", "params": {"value": "unused"}},
                  {"ref": "+t", "definitionId": TOPAZ, "params": params}],
        "edges": [],
        "rename": {"+t": "Clean plate"},
        **({"pending": True} if pending else {}),
    }
    response = _apply(pend, body, headers)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def _real_validation(pend, monkeypatch):
    """The fixture stubs the pre-call check out; these runs need the real one."""
    from execution import engine
    monkeypatch.setattr(pend.main, "validate_graph", engine.validate_graph)


def test_an_agents_run_nodes_is_refused_before_anything_runs(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _topaz_chain(pend, pending=False)
    response = pend.client.post("/api/graph/run", json={"targetNodeId": ids["+t"]}, headers=CLAUDE)
    body = response.json()
    assert body["status"] == "failed", body
    assert GM_LINE in body["errors"][ids["+t"]]
    assert body["error"].startswith("Nothing ran, so nothing was spent.") and GM_LINE in body["error"]
    assert pend.ran == [] and pend.priced == []


def test_the_canvas_run_of_the_node_is_refused_the_same_way(pend):
    ids = _topaz_chain(pend, pending=False)
    response = _direct(pend, ids["+t"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "validation_error"
    assert any(error["nodeId"] == ids["+t"] and error["person"] == GM_LINE for error in body["errors"])
    assert pend.ran == [] and pend.priced == []


def test_a_direct_run_over_a_placeholder_with_no_model_is_refused_before_its_confirmation(pend):
    """GM: "Don't ask someone to approve a run that can't go out." A run that
    would otherwise get the paid-placeholder refusal (409, the dialog again)
    gets this one first."""
    ids = _topaz_chain(pend, pending=True)
    response = _direct(pend, ids["+t"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "validation_error"
    assert any(error["nodeId"] == ids["+t"] and error["person"] == GM_LINE for error in body["errors"])
    assert pend.ran == [] and pend.priced == []


def test_the_whole_canvas_run_is_refused_too(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _topaz_chain(pend, pending=False)
    response = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r-topaz"})
    body = response.json()
    assert body["status"] == "validation_error", body
    assert any(error["nodeId"] == ids["+t"] and error["person"] == GM_LINE for error in body["errors"])
    assert pend.ran == []


def test_a_chosen_model_is_not_refused_for_it(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _topaz_chain(pend, pending=False, model="CGI")
    response = pend.client.post("/api/graph/run", json={"targetNodeId": ids["+t"]}, headers=CLAUDE)
    body = response.json()
    assert GM_LINE not in str(body.get("errors") or {})


# -- GM round 12, item 1: "the agents" ---------------------------------------------------------

def test_the_skip_line_says_the_agents():
    assert pending_nodes.skip_line({"count": 3, "agents": ["Codex", "Claude Code"]}) == (
        "Skipped 3 nodes the agents are still setting up.")
    assert pending_nodes.skip_line({"count": 3, "agents": ["Codex"]}) == "Skipped 3 nodes Codex is still setting up."


def test_the_paid_placeholder_refusal_says_the_agents(pend):
    mine = _paid_chain(pend)
    theirs = _paid_chain(pend, headers=CODEX)
    combine = pend.graph.add_node("combine-text", {})
    pend.graph.connect(mine["+i"], "text", combine, "text1")
    pend.graph.connect(theirs["+i"], "text", combine, "text2")
    response = _direct(pend, combine)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["message"] == (
        "Nothing ran. This run includes 2 paid nodes the agents are still setting up, and Nebula asks "
        "before running those. Click “Run” again to review them.")
