"""Agents find the Jev nodes by what they do, and see their key and price.

find_nodes matches every query word against id, name and description, so
the Jev definitions carry the verbs people and agents search with.
"""
from __future__ import annotations

import pytest

import main

# query -> the node it must return first. Rows for nodes that aren't defined
# (yet) are skipped.
SEARCHES = {
    "judge": "jev-decide",
    "judge image": "jev-decide",
    "classify": "jev-decide",
    "yes no": "jev-decide",
    "pick best": "jev-pick-best",
    "bounding box": "jev-box",
}


class _Krea:
    def status(self):
        return {"status": "disconnected"}


@pytest.fixture
def no_keys(monkeypatch):
    real = main.load_settings
    monkeypatch.setattr(main, "load_settings", lambda: {**real(), "apiKeys": {}})
    monkeypatch.setattr(main, "_krea_connector", lambda: _Krea())


@pytest.mark.asyncio
@pytest.mark.parametrize(("query", "node_id"), list(SEARCHES.items()))
async def test_find_nodes_returns_the_jev_node_first(no_keys, query, node_id):
    if main.node_registry.get(node_id) is None:
        pytest.skip(f"{node_id} is not defined yet")
    found = await main.agent_find_nodes(query=query, ready_only=False)
    ids = [row["id"] for row in found["nodes"]]
    assert ids and ids[0] == node_id, (query, ids[:5])


@pytest.mark.asyncio
async def test_find_nodes_by_provider_name_lists_every_jev_node_first(no_keys):
    jev = {"jev-decide", "jev-pick-best", "jev-box"}
    defined = {node_id for node_id in jev if main.node_registry.get(node_id) is not None}
    found = await main.agent_find_nodes(query="typesafe", ready_only=False)
    assert {row["id"] for row in found["nodes"][:len(defined)]} == defined


@pytest.mark.asyncio
async def test_find_and_describe_say_what_decide_needs_and_costs(no_keys):
    row = next(row for row in (await main.agent_find_nodes(query="judge", ready_only=False))["nodes"]
               if row["id"] == "jev-decide")
    assert row["runsWith"] is None and "TYPESAFE_API_KEY" in row["missing"]
    assert row["price"] == {"usd": [0.0, 0.0027]}
    assert row["description"].startswith("Judge, classify or score")

    described = await main.agent_describe_node("jev-decide")
    assert [port["id"] for port in described["outputs"]] == [
        "answer", "pass", "probability", "confidence", "probabilities", "report"]
    params = {param["key"]: param for param in described["params"]}
    assert params["model"]["default"] == "jev-1.14.0"
    assert params["options"]["onlyWhen"] == {"answer_type": ["choice"]}
    assert "TYPESAFE_API_KEY" in described["missing"]
    assert described["price"] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(("node_id", "outputs"), [
    ("jev-pick-best", ["winner", "index", "probabilities", "confidence", "report"]),
    ("jev-box", ["found", "box", "crop", "mask", "annotated", "report"]),
])
async def test_describe_says_what_pick_best_and_box_need_and_cost(no_keys, node_id, outputs):
    described = await main.agent_describe_node(node_id)
    assert [port["id"] for port in described["outputs"]] == outputs
    assert "TYPESAFE_API_KEY" in described["missing"]
    assert described["price"] is not None
    row = next(row for row in (await main.agent_find_nodes(query="typesafe", ready_only=False))["nodes"]
               if row["id"] == node_id)
    assert row["price"] == {"usd": [0.0, 0.0027]}
