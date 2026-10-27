"""GM - Design, round 16 (2026-10-26), verbatim.

(b) "When the dialog builds the label, no parens: "Grok Imagine 2.0 via
xAI", "GPT Image 2.5 Flare via OpenAI". Rows on the gateway keep the card's
own display name. Same wording in the agent-facing proposal cost (backend
services/canvas_proposals.py cost_for) and docs."

Cursor bubble (chip fallback): "Cursor bubble for param changes uses card
labels in curly quotes: 1 label: "Set “Aspect ratio”"; 2 labels: "Set
“Aspect ratio” and “Seed”"; 3 or more: "Set 3 settings". Fields with no
card label are left out of the list AND the count. If no changed field has a
card label, the bubble shows nothing (no say text; the cursor still moves to
the node). The Agent log keeps recording the change; where there's no card
label it uses the param key."
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.cli_graph import CLIGraph
from services.selection_context import SelectionContextStore
from tests.test_canvas_proposals import _propose, api as proposals_api  # noqa: F401

GROK = "krea-image-xai-grok-imagine-2"
FLARE = "krea-image-openai-gpt-image-2-5-flare"
AGENT = {"X-Nebula-Agent": "Codex"}


def _definitions():
    import main
    return main.node_registry.get_all()


# -- (b) the route label ----------------------------------------------------------

def test_cost_for_names_a_krea_copy_on_its_makers_key_with_via():
    from services.canvas_proposals import cost_for

    grok = _definitions()[GROK]
    assert cost_for(grok, {}, None, {"XAI_API_KEY": "x"}) == {
        "kind": "paid", "provider": "xai", "label": "paid · Grok Imagine 2.0 via xAI"}
    assert cost_for(_definitions()[FLARE], {}, None, {"OPENAI_API_KEY": "o"})["label"] == (
        "paid · GPT Image 2.5 Flare via OpenAI")


def test_on_the_gateway_the_label_is_unchanged():
    from services.canvas_proposals import cost_for

    grok = _definitions()[GROK]
    assert cost_for(grok, {}, None, {"KREA_API_TOKEN": "k"})["label"] == "paid · krea"
    assert cost_for(grok, {}, None, {"XAI_API_KEY": "x", "KREA_API_TOKEN": "k"},
                    wired={"style_images"})["label"] == "paid · krea"
    assert cost_for(grok, {})["label"] == "paid · krea"


def test_name_on_route_matches_the_canvas():
    from services.node_route import name_on_route

    defs = _definitions()
    assert name_on_route(defs[GROK], "xai") == "Grok Imagine 2.0 via xAI"
    assert name_on_route(defs[GROK], "krea") == "Grok Imagine 2.0 (Krea)"
    assert name_on_route(defs[GROK], None) == "Grok Imagine 2.0 (Krea)"
    assert name_on_route(defs["nano-banana-fal"], "google") == "Nano Banana via Google"
    assert name_on_route(defs["gpt-image-1-5"], "openai") == "GPT Image 1.5"


def test_a_proposal_names_the_route_with_via(proposals_api, monkeypatch):  # noqa: F811
    monkeypatch.setattr(proposals_api.main, "load_settings",
                        lambda: {"apiKeys": {"XAI_API_KEY": "x", "KREA_API_TOKEN": "k"}})
    n1 = proposals_api.graph.add_node("text-input", {"value": "a fox"})
    body = {"note": "Alt still", "nodes": [{"ref": "+g", "definitionId": GROK}],
            "edges": [{"source": n1, "sourceHandle": "text", "target": "+g", "targetHandle": "prompt"}],
            "run": ["+g"]}
    cost = _propose(proposals_api, body).json()["proposal"]["cost"]
    row = {node["ref"]: node for node in cost["nodes"]}["+g"]
    assert (row["provider"], row["label"]) == ("xai", "paid · Grok Imagine 2.0 via xAI")


# -- the cursor bubble -----------------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    import main as main_module

    graph = CLIGraph()
    sent: list[dict] = []

    async def capture(data):
        sent.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "selection_context", SelectionContextStore())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module, "_check_workspace_revision", lambda: None)
    return TestClient(main_module.app), graph, sent


def _set(api, definition_id: str, params: dict, extra: dict | None = None) -> dict:
    client, graph, sent = api
    node_id = graph.add_node(definition_id, dict(extra or {}))
    sent.clear()
    answer = client.put(f"/api/graph/node/{node_id}", headers=AGENT, json={"params": params})
    assert answer.status_code == 200, answer.text
    (event,) = [event for event in sent if event.get("type") == "agentPresence"]
    assert event["target"] == {"nodeId": node_id}
    return event


def test_one_label(api):
    event = _set(api, GROK, {"aspect_ratio": "16:9"})
    assert event["say"] == "Set “Aspect ratio”"


def test_two_labels(api):
    event = _set(api, GROK, {"aspect_ratio": "16:9", "resolution": "2K"})
    assert event["say"] == "Set “Aspect ratio” and “Resolution”"


def test_three_or_more_labels_are_counted(api):
    event = _set(api, GROK, {"aspect_ratio": "16:9", "resolution": "2K", "quality": "high"})
    # GM, round 18: "Changed N settings" (was "Set N settings").
    assert event["say"] == "Changed 3 settings"


def test_the_card_order_and_the_labels_follow_the_card(api):
    event = _set(api, "gpt-image-2-5-generate", {"quality": "low"})
    assert event["say"] == "Set “Quality”"


def test_a_field_with_no_card_label_is_left_out_of_the_bubble_but_logged_by_key(api, monkeypatch):
    import main as main_module

    real = main_module._card_label

    def labels(definition, node, key):
        return None if key == "resolution" else real(definition, node, key)

    monkeypatch.setattr(main_module, "_card_label", labels)
    event = _set(api, GROK, {"aspect_ratio": "16:9", "resolution": "2K"})
    assert event["say"] == "Set “Aspect ratio”"
    assert event["log"] == "Set “Aspect ratio” and resolution"


def test_no_labelled_field_no_words_but_the_cursor_still_moves_and_the_log_keeps_it(api, monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "_card_label", lambda definition, node, key: None)
    event = _set(api, GROK, {"aspect_ratio": "16:9"})
    assert event["say"] == ""
    assert event["log"] == "Set aspect_ratio"
    assert event["did"]["verb"] == "Changed"


def test_a_hidden_param_has_no_card_label(api):
    import main as main_module

    definition = {"params": [{"key": "scene", "label": "Scene", "hidden": True}, {"key": "seed", "label": "Seed"}]}
    assert main_module._card_label(definition, {}, "scene") is None
    assert main_module._card_label(definition, {}, "seed") == "Seed"
    assert main_module._card_label(definition, {}, "missing") is None


def test_the_say_has_no_raw_keys_when_labels_exist(api):
    event = _set(api, GROK, {"aspect_ratio": "16:9"})
    assert "aspect_ratio" not in event["say"]
