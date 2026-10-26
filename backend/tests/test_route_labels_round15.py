"""Review 14, L-I, and GM - Design, round 15, item 3: "a confirm row names
the route that actually runs, and that route's price ... Never show the
Krea price for a run that doesn't go through Krea." The agent-facing twin
is a proposal's cost: each run node's `provider` and its "paid · <provider>"
label name the provider the run would go through with the keys set, as the
estimate beside it prices it (a Krea copy on its maker's key names the
maker; a connection into a Krea-only input keeps it on Krea)."""
from __future__ import annotations

from tests.test_canvas_proposals import _propose, api  # noqa: F401

GROK = "krea-image-xai-grok-imagine-2"
FLARE = "krea-image-openai-gpt-image-2-5-flare"


def _definitions():
    import main
    return main.node_registry.get_all()


def test_cost_for_a_krea_copy_names_the_route_with_the_keys_set():
    from services.canvas_proposals import cost_for

    grok = _definitions()[GROK]
    assert cost_for(grok, {}, None, {"XAI_API_KEY": "x"}) == {"kind": "paid", "provider": "xai", "label": "paid · xai"}
    assert cost_for(grok, {}, None, {"XAI_API_KEY": "x", "KREA_API_TOKEN": "k"})["provider"] == "xai"
    assert cost_for(grok, {}, None, {"KREA_API_TOKEN": "k"})["provider"] == "krea"
    assert cost_for(_definitions()[FLARE], {}, None, {"OPENAI_API_KEY": "o"})["label"] == "paid · openai"
    # A Krea-only input that arrives by connection keeps it on Krea.
    assert cost_for(grok, {}, None, {"XAI_API_KEY": "x", "KREA_API_TOKEN": "k"},
                    wired={"style_images"})["provider"] == "krea"
    # Without keys it is the node's own provider, as before.
    assert cost_for(grok, {})["provider"] == "krea"


def test_a_proposal_names_the_route_and_prices_it(api, monkeypatch):  # noqa: F811
    monkeypatch.setattr(api.main, "load_settings", lambda: {"apiKeys": {"XAI_API_KEY": "x", "KREA_API_TOKEN": "k"}})
    n1 = api.graph.add_node("text-input", {"value": "a fox"})
    body = {"note": "Alt still", "nodes": [{"ref": "+g", "definitionId": GROK}],
            "edges": [{"source": n1, "sourceHandle": "text", "target": "+g", "targetHandle": "prompt"}],
            "run": ["+g"]}
    cost = _propose(api, body).json()["proposal"]["cost"]
    row = {node["ref"]: node for node in cost["nodes"]}["+g"]
    assert (row["provider"], row["label"]) == ("xai", "paid · xai")
    assert row["price"] == {"low": 0.06, "high": 0.06}
    assert cost["providers"] == ["xai"]
