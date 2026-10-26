"""Round 13 of feat/agent-presence: review 12 and GM - Design's round-13 lines.

L-7. A Krea node whose required field has no default and nothing chosen
(Krea 2's Aspect ratio and Resolution, a Flux 1.1 Pro's Width and Height,
Topaz Standard's Model, a node app's Version, a style training's Name) can't
run: the gateway (or the handler) refuses it before calling Krea. The canvas
fills no value in, so Nebula refuses the run up front, on every run path,
with GM's line "Choose an aspect ratio for “X” first." When several fields
are missing, only the first in the card's field order is named.

L-3. /api/quick (`nebula quick`) never checked: it now refuses the same way,
before the spend check and before anything runs.

L-4. The canvas's model picker tells "reading the provider's settings
failed" from any other failure: that answer carries a header the canvas
reads (exposed to the browser through CORS).
"""
from __future__ import annotations

import pytest

from services import model_choice
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, CODEX, KEY, _key, api  # noqa: F401 - fixture
from tests.test_pending_nodes import _apply, _direct, _execute_body, pend  # noqa: F401 - fixture

KREA2 = "krea-image-krea-krea-2-medium"
TOPAZ = "krea-enhance-topaz-standard-enhance"
FLUX = "krea-image-bfl-flux-1-1-pro"
HERO_LINE = "Choose an aspect ratio for “Hero” first."

WH = [("width", "width"), ("height", "height")]
AR = [("aspect_ratio", "aspect ratio"), ("resolution", "resolution")]
# The same inventory frontend/tests/requiredFields.round13.test.ts pins.
INVENTORY = {
    "krea-enhance-magnific-creative-enhance": WH,
    "krea-enhance-magnific-precise-enhance": WH,
    "krea-enhance-topaz-bloom-2-enhance": WH,
    "krea-enhance-topaz-bloom-enhance": WH,
    "krea-enhance-topaz-generative-enhance": WH,
    TOPAZ: [*WH, ("model", "model")],
    "krea-enhance-topaz-wonder-35-enhance": WH,
    FLUX: WH,
    "krea-image-bytedance-seedream-4": WH,
    "krea-image-bytedance-seedream-5-lite": WH,
    "krea-image-bytedance-seedream-5-pro": WH,
    "krea-image-krea-krea-2-large": AR,
    KREA2: AR,
    "krea-image-krea-krea-2-medium-turbo": AR,
    "krea-image-openai-gpt-image-2-5-flare": AR,
    "krea-image-openai-gpt-image-2-5-sunburst": AR,
    "krea-image-recraft-recraft-v4-1-flash": AR,
    "krea-image-xai-grok-imagine-2": AR,
    "krea-image-z-image-z-image": AR,
    "krea-node-app": [("node_app_version_id", "version")],
    "krea-style-train": [("name", "name")],
    "krea-video-alibaba-wan-2-1": WH,
    "krea-video-alibaba-wan-2-2": WH,
}


def test_every_krea_node_with_a_required_field_and_no_default_is_covered():
    assert model_choice.required_fields() == INVENTORY


def test_the_gateway_really_refuses_each_missing_field():
    """The reason for the list: each field, left empty, fails the request
    schema the gateway checks before it calls Krea."""
    import asyncio

    from handlers import krea_gateway as gateway
    from models.graph import GraphNode

    for definition_id, fields in INVENTORY.items():
        if definition_id in {"krea-node-app", "krea-style-train"}:
            continue  # their own handlers refuse (no catalog schema)
        model = gateway._model(definition_id)
        required = set(model["requestSchema"].get("required") or [])
        for key, _word in fields:
            assert key in required, (definition_id, key)
        node = GraphNode(id="n1", definition_id=definition_id, params={"_kreaAuth": "api-token"})
        body = asyncio.run(gateway._request_body(node, {}, model))
        with pytest.raises(ValueError):
            gateway._validate(body, model["requestSchema"])


@pytest.mark.parametrize(("definition_id", "params", "field"), [
    (KREA2, {}, "aspect ratio"),
    (KREA2, {"aspect_ratio": None, "resolution": None}, "aspect ratio"),
    (KREA2, {"aspect_ratio": "16:9"}, "resolution"),
    (KREA2, {"aspect_ratio": "16:9", "resolution": "1K"}, None),
    # The card's order: Topaz Standard's Width comes before its Model.
    (TOPAZ, {}, "width"),
    (TOPAZ, {"width": 2048}, "height"),
    (TOPAZ, {"width": 2048, "height": 2048}, "model"),
    (TOPAZ, {"width": 2048, "height": 2048, "model": "CGI"}, None),
    (FLUX, {"width": 1024, "height": 1024}, None),
    ("krea-style-train", {"name": " "}, "name"),
    ("nano-banana", {}, None),
])
def test_the_first_missing_field_in_card_order(definition_id, params, field):
    assert model_choice.unchosen_field(definition_id, params) == field


def test_the_line_takes_an_before_a_vowel():
    assert model_choice.not_chosen_line("Hero", "aspect ratio") == HERO_LINE
    assert model_choice.not_chosen_line("Hero", "resolution") == "Choose a resolution for “Hero” first."
    assert model_choice.not_chosen_line("Clean plate", "model") == "Choose a model for “Clean plate” first."


def _hero(pend, *, params: dict | None = None, pending: bool = False, headers=CLAUDE) -> dict[str, str]:
    body = {
        "note": "the hero frame",
        "nodes": [{"ref": "+p", "definitionId": "text-input", "params": {"value": "a fox"}},
                  {"ref": "+k", "definitionId": KREA2, "params": params or {}}],
        "edges": [{"source": "+p", "sourceHandle": "text", "target": "+k", "targetHandle": "prompt"}],
        "rename": {"+k": "Hero"},
        **({"pending": True} if pending else {}),
    }
    response = _apply(pend, body, headers)
    assert response.status_code == 200, response.text
    return response.json()["idMap"]


def _real_validation(pend, monkeypatch):
    from execution import engine
    monkeypatch.setattr(pend.main, "validate_graph", engine.validate_graph)


def test_an_agents_run_nodes_is_refused(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _hero(pend)
    body = pend.client.post("/api/graph/run", json={"targetNodeId": ids["+k"]}, headers=CLAUDE).json()
    assert body["status"] == "failed", body
    assert HERO_LINE in body["errors"][ids["+k"]]
    assert body["error"].startswith("Nothing ran, so nothing was spent.")
    assert pend.ran == [] and pend.priced == []


def test_the_canvas_run_of_the_node_is_refused(pend):
    ids = _hero(pend)
    body = _direct(pend, ids["+k"]).json()
    assert body["status"] == "validation_error"
    assert any(error["nodeId"] == ids["+k"] and error["person"] == HERO_LINE for error in body["errors"])
    assert pend.ran == [] and pend.priced == []


def test_a_direct_run_over_a_placeholder_is_refused_before_its_confirmation(pend):
    ids = _hero(pend, pending=True)
    response = _direct(pend, ids["+k"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "validation_error"
    assert any(error["person"] == HERO_LINE for error in body["errors"])


def test_the_whole_canvas_run_is_refused(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _hero(pend)
    body = pend.client.post("/api/execute", headers=PERSON, json={**_execute_body(pend), "runId": "r-ar"}).json()
    assert body["status"] == "validation_error", body
    assert any(error["nodeId"] == ids["+k"] and error["person"] == HERO_LINE for error in body["errors"])
    assert pend.ran == []


def test_chosen_fields_are_not_refused(pend, monkeypatch):
    _real_validation(pend, monkeypatch)
    ids = _hero(pend, params={"aspect_ratio": "16:9", "resolution": "1K"})
    body = pend.client.post("/api/graph/run", json={"targetNodeId": ids["+k"]}, headers=CLAUDE).json()
    assert "Choose" not in str(body.get("errors") or {})


# -- L-3: /api/quick ------------------------------------------------------------------------------

@pytest.mark.parametrize(("definition_id", "params", "line"), [
    (KREA2, {}, "Choose an aspect ratio for “Krea 2 Medium (Krea)” first."),
    (TOPAZ, {"width": 2048, "height": 2048}, "Choose a model for “Topaz Standard (Krea)” first."),
])
def test_quick_is_refused_before_the_spend_check_and_before_anything_runs(pend, definition_id, params, line):
    inputs = {"prompt": "a fox"} if definition_id == KREA2 else {"image_url": "https://example.com/a.png"}
    response = pend.client.post("/api/quick", headers=CLAUDE,
                                json={"definitionId": definition_id, "inputs": inputs, "params": params})
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == f"Nothing ran, so nothing was spent. {line}"
    assert pend.ran == [] and pend.priced == []


def test_quick_with_the_fields_chosen_runs(pend):
    response = pend.client.post("/api/quick", headers=CLAUDE, json={
        "definitionId": KREA2, "inputs": {"prompt": "a fox"}, "params": {"aspect_ratio": "16:9", "resolution": "1K"}})
    assert response.status_code == 200, response.text
    assert pend.ran and pend.priced


# -- L-4: the model picker's settings failure is marked ---------------------------------------------

def test_a_settings_read_failure_is_marked_for_the_canvas(pend, monkeypatch):
    from services import universal_ports

    async def unreachable(definition_id, model):
        return "Nebula couldn't reach OpenRouter to read x's ports; try again"

    monkeypatch.setattr(universal_ports, "look_up", unreachable)
    node_id = pend.graph.add_node("openrouter-universal", {})
    for path, body in ((f"/api/graph/node/{node_id}/model", {"model": "x/y"}),
                       ("/api/universal/ports", {"definitionId": "openrouter-universal", "model": "x/y"})):
        response = pend.client.post(path, headers={**PERSON, "Origin": "http://localhost:5795"}, json=body)
        assert response.status_code == 400, response.text
        assert response.headers.get("x-nebula-failure") == "model-settings"
        assert "x-nebula-failure" in response.headers.get("access-control-expose-headers", "").lower()


def test_other_picker_failures_are_not_marked(pend):
    response = pend.client.post("/api/graph/node/n999/model", headers=PERSON, json={"model": "x/y"})
    assert response.status_code == 404
    assert response.headers.get("x-nebula-failure") is None
