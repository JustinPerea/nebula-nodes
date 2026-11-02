"""The proposal card's plan line (GM - Design, 2026-11-01: the canvas proposal
card redesign). One line under the agent's note says what Accept changes and
costs, by node name and never by id; the view carries it as `plan`, so the
card, `nebula proposal` and MCP read the same words."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cli.formatter import format_proposal
from services import money
from services.canvas_proposals import billed_to, plan_line
from tests.test_canvas_proposals import _propose, api  # noqa: F401 - the shared fixture

ROOT = Path(__file__).resolve().parents[2]
CHIPS = json.loads((ROOT / "contracts" / "fixtures" / "money" / "chips.json").read_text())["chip"]


@pytest.mark.parametrize("row", CHIPS, ids=lambda row: f"{row['low']}-{row['high']}-{row['open']}")
def test_chip_label_matches_the_cards_chip(row):
    high = row["high"] if row["high"] is not None else float("nan")
    assert money.chip_label(row["low"], high, row["open"]) == row["text"]


def _view(**over):
    view = {"nodes": [], "edges": [], "params": [], "run": [],
            "cost": {"paidRuns": 0, "freeRuns": 0, "estimate": None, "upTo": False, "nodes": []}}
    cost = over.pop("cost", {})
    view.update(over)
    view["cost"] = {**view["cost"], **cost}
    return view


def _entry(ref, name, *, paid=True, model="Krea 2", billed="your Krea plan", node_id=None):
    return {"ref": ref, "nodeId": node_id, "kind": "paid" if paid else "free", "name": name,
            "model": model, "billedTo": billed if paid else None}


HERO = {"nodeId": "n4", "name": "Hero shot (n4)", "title": "Hero shot", "model": "Krea 2",
        "changes": {"aspect_ratio": {"from": "16:9", "to": "1:1"}}}


def test_change_and_run_the_same_node_reads_as_one_clause():
    view = _view(params=[HERO], run=["n4"],
                 cost={"paidRuns": 1, "nodes": [_entry("n4", "Hero shot", node_id="n4")]})
    assert plan_line(view) == "Changes and runs “Hero shot” · Krea 2 on your Krea plan · no list price"


def test_run_only_names_the_canvas_node_never_its_id():
    view = _view(run=["n4"], cost={"paidRuns": 1, "estimate": {"low": 0.03, "high": 0.03, "open": False},
                                   "nodes": [_entry("n4", "Hero shot", model="GPT Image 2",
                                                    billed="your OpenAI key", node_id="n4")]})
    line = plan_line(view)
    assert line == "Runs “Hero shot” · GPT Image 2 on your OpenAI key · ~$0.03"
    assert "n4" not in line


def test_change_one_run_another():
    prompt = {"nodeId": "n2", "name": "Prompt (n2)", "title": "Prompt", "changes": {"value": {"from": "a", "to": "b"}}}
    view = _view(params=[prompt], run=["n4"], cost={
        "paidRuns": 1, "freeRuns": 1, "upTo": True, "estimate": {"low": 0, "high": 0.43, "open": False},
        "nodes": [_entry("n2", "Prompt", paid=False, node_id="n2"), _entry("n4", "Hero shot", node_id="n4")]})
    assert plan_line(view) == "Changes “Prompt” and runs “Hero shot” · Krea 2 on your Krea plan · Up to $0.43"


def test_adds_with_connections_and_counts_from_four():
    one = _view(nodes=[{"ref": "+k", "name": "Krea 2"}], edges=[{}])
    assert plan_line(one) == "Adds “Krea 2” and 1 connection · nothing runs until you choose"
    three = _view(nodes=[{"ref": f"+{i}", "name": f"N{i}"} for i in range(3)], edges=[{}, {}])
    assert plan_line(three) == "Adds “N0”, “N1” and “N2” and 2 connections · nothing runs until you choose"
    four = _view(params=[{**HERO, "nodeId": f"n{i}", "title": f"T{i}"} for i in range(4)])
    assert plan_line(four) == "Changes 4 nodes · nothing runs until you choose"


def test_adds_and_runs_the_new_node():
    view = _view(nodes=[{"ref": "+k", "name": "Krea 2"}], edges=[{}], run=["+k"], cost={
        "paidRuns": 1, "estimate": {"low": 0.07, "high": 0.07, "open": True},
        "nodes": [_entry("+k", "Krea 2", billed="your Krea API token")]})
    assert plan_line(view) == "Adds “Krea 2” and 1 connection and runs it · Krea 2 on your Krea API token · $0.07 + unpriced"


def test_several_paid_runs_are_a_count_and_free_runs_say_free():
    view = _view(run=["n4", "n5"], cost={"paidRuns": 3, "upTo": True, "nodes": [
        _entry("n4", "A", node_id="n4"), _entry("n5", "B", node_id="n5"), _entry("n3", "C", node_id="n3")]})
    assert plan_line(view) == "Runs “A” and “B” · up to 3 paid runs · no list price"
    free = _view(run=["n4"], cost={"freeRuns": 1, "nodes": [_entry("n4", "Upscale", paid=False, node_id="n4")]})
    assert plan_line(free) == "Runs “Upscale” · free"


def _waiting(**cost):
    return _view(nodes=[{"ref": "+c", "name": "Combine Text"}], run=["+c"], cost={"nodes": [], **cost})


def test_a_run_waiting_on_placeholders_keeps_its_words():
    """GM - Design, round 4: "runs nothing until Codex finishes 2 nodes", or
    "agents finish" for several; review 4, M2: it counts the placeholders
    themselves (`placeholders`), and a backend without that count keeps `count`.
    Moved here from the canvas's own tests with the line (2026-11-01)."""
    assert plan_line(_waiting(pendingSkipped={"count": 2, "placeholders": 1, "agents": ["Codex"]})) == (
        "Adds “Combine Text” · runs nothing until Codex finishes 1 node")
    assert plan_line(_waiting(pendingSkipped={"count": 2, "agents": ["Codex"]})) == (
        "Adds “Combine Text” · runs nothing until Codex finishes 2 nodes")
    assert plan_line(_waiting(pendingSkipped={"count": 3, "agents": ["Codex", "Cursor"]})) == (
        "Adds “Combine Text” · runs nothing until agents finish 3 nodes")
    # Something still runs: the run's own words.
    assert plan_line(_waiting(freeRuns=1, pendingSkipped={"count": 2, "agents": ["Codex"]})) == (
        "Adds “Combine Text” and runs it · free")


def test_a_paid_run_no_provider_can_take_names_only_the_model():
    view = _view(run=["n4"], cost={"paidRuns": 1, "nodes": [_entry("n4", "Hero shot", billed=None, node_id="n4")]})
    assert plan_line(view) == "Runs “Hero shot” · Krea 2 · no list price"


def test_billed_to_names_who_pays():
    import main

    definitions = main.node_registry.get_all()
    krea = definitions["krea-2-generate"]
    paid = {"kind": "paid", "provider": "krea"}
    assert billed_to(krea, {"_kreaAuth": "mcp"}, paid) == "your Krea plan"
    assert billed_to(krea, {"_kreaAuth": "api-token"}, paid) == "your Krea API token"
    assert billed_to(definitions["gpt-image-2-generate"], {}, {"kind": "paid", "provider": "openai"}) == "your OpenAI key"
    assert billed_to(krea, {}, {"kind": "free", "provider": None}) is None
    assert billed_to(krea, {"_kreaAuth": "api-token"}, {"kind": "paid", "provider": None}) is None


def test_the_view_card_cli_and_mcp_read_the_same_names(api):  # noqa: F811 - pytest fixture
    node_id = api.graph.add_node("krea-2-generate", {"_kreaAuth": "api-token", "prompt": "chrome"})
    api.graph.set_label(node_id, "Hero shot")
    response = _propose(api, {"note": "One image at 1:1 first",
                              "params": [{"nodeId": node_id, "params": {"_kreaAuth": "mcp", "aspect_ratio": "1:1"}}],
                              "run": [node_id]})
    assert response.status_code == 201, response.text
    view = response.json()["proposal"]
    assert view["plan"].startswith("Changes and runs “Hero shot” · Krea 2 on your Krea plan · ")
    assert node_id not in view["plan"]
    change = view["params"][0]
    assert (change["title"], change["model"]) == ("Hero shot", "Krea 2")
    entry = view["cost"]["nodes"][0]
    assert (entry["name"], entry["model"], entry["billedTo"]) == ("Hero shot", "Krea 2", "your Krea plan")
    # The CLI prints the card's line word for word, beside its own id lines.
    assert f"  card     {view['plan']}" in format_proposal(view).splitlines()
    # get_proposal (MCP) and the HTTP read return the same view.
    again = api.client.get(f"/api/canvas/proposals/{view['id']}", headers={"X-Nebula-Agent": "Claude Code"})
    assert again.json()["proposal"]["plan"] == view["plan"]
