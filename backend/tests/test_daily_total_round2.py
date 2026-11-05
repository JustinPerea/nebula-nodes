"""The daily total, PR #212 round 2: GM - Design's review (2026-10-31),
verbatim. The bar names both reasons when a run also needs the person's OK
for another one (Accept overrides both), with the nodes and the model by name;
the cursor says the spec's default on
arrival; and agents get the numbers beside the line."""
from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_daily_total import AGENTS, CLAUDE, PAID, PRICES, _node, api, price  # noqa: E402,F401

UNPRICED = "gpt-image-2-generate"  # a paid node with no list price here (PRICES lists only PAID)

DEFINITIONS = {"paid": {"id": "paid", "displayName": "Paid Model", "apiProvider": "openai"},
               "flux": {"id": "flux", "displayName": "FLUX.2 [pro]", "apiProvider": "bfl"},
               "unpriced": {"id": "unpriced", "displayName": "Mystery", "apiProvider": "openai"},
               "unpriced-2": {"id": "unpriced-2", "displayName": "Riddle", "apiProvider": "openai"}}
PRICING = {"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": 3.0}]},
                     "flux": {"currency": "usd", "rows": [{"match": {}, "price": 3.0}]}}}


def _decide(items, *, key="chat:a", settings=None, spent=0.0, outside=0.0, used=4.0, app=None):
    settings = settings if settings is not None else {"runCostConfirmUsd": None}
    caps = agent_spend.caps_from_settings(settings)
    budgets = agent_spend.session_budgets(key, agent_spend.Spent(spent), caps, outside_spent=agent_spend.Spent(outside),
                                          app_name=app[0] if app else None, app_daily_usd=app[1] if app else None,
                                          daily_spent=agent_spend.Spent(used))
    return agent_spend.decide(items, [], settings=settings, pricing=PRICING, definitions=DEFINITIONS,
                              budgets=budgets, how_to_ask="ASK.")


def node(node_id: str, definition: str) -> dict:
    return {"id": node_id, "definitionId": definition, "params": {}}


# -- the bar names both reasons (GM's answers 1-3) ----------------------------------

def test_a_node_with_no_list_price_is_named():
    one = _decide([node("n1", "paid"), node("n2", "unpriced")], settings={"runCostConfirmUsd": 10})
    assert one.wait.also == agent_spend.ALSO_UNPRICED and one.wait.unpriced == ("n2",)
    assert one.wait.bar_line() == "This would pass the $5 daily total, and “Mystery” has no list price."
    # The canvas's own names, when the proposal is made.
    one.wait.names["n2"] = "Writer"
    assert one.wait.bar_line() == "This would pass the $5 daily total, and “Writer” has no list price."
    two = _decide([node("n1", "paid"), node("n2", "unpriced"), node("n3", "unpriced-2")],
                  settings={"runCostConfirmUsd": 10})
    two.wait.names.update({"n2": "Writer", "n3": "Editor"})
    assert two.wait.bar_line() == "This would pass the $5 daily total, and “Writer” and “Editor” have no list price."


def test_a_models_own_per_run_limit_names_the_model():
    settings = {"runCostConfirmUsd": None, "agentSpend": {"models": {"flux": {"perRunUsd": 0.5}}}}
    decision = _decide([node("n1", "flux")], settings=settings)
    assert decision.wait.also == agent_spend.ALSO_MODEL_PER_RUN
    assert decision.wait.bar_line() == (
        "This would pass the $5 daily total and cost more than the $0.50 per-run limit for “FLUX.2 [pro]”.")
    # The general per-run limit keeps GM's round-1 line.
    general = _decide([node("n1", "paid")], settings={"runCostConfirmUsd": 1})
    assert general.wait.bar_line() == "This would pass the $5 daily total and costs more than $1 per run."


@pytest.mark.parametrize("key, settings, extra, line", [
    ("chat:a", {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 2}}, {},
     "This would pass the $5 daily total and the $2 limit for this chat."),
    ("outside:shared", {"runCostConfirmUsd": None, "agentSpend": {"outsideDailyUsd": 2}}, {},
     "This would pass the $5 daily total and the $2 limit for agents outside Nebula chats."),
    ("outside:app:x", {"runCostConfirmUsd": None}, {"app": ("Hermes", 2.0)},
     "This would pass the $5 daily total and the $2 limit for “Hermes”."),
    ("chat:a", {"runCostConfirmUsd": None, "agentSpend": {"models": {"flux": {"sessionUsd": 2}}}}, {},
     "This would pass the $5 daily total and the $2 “FLUX.2 [pro]” limit for this chat."),
])
def test_a_budget_passed_too_is_named_with_whose_it_is(key, settings, extra, line):
    decision = _decide([node("n1", "flux")], key=key, settings=settings, **extra)
    assert decision.wait is not None and decision.wait.also == agent_spend.ALSO_LIMIT
    assert decision.wait.bar_line() == line


def test_a_krea_plan_limit_passed_too_is_named():
    wait = agent_spend.DailyWait(5, 4.0, 3.0)
    budget = agent_spend.Budget("this session", agent_spend.Spent(0.0, plan_runs=10), None, 10)
    agent_spend._first_other_reason(wait, usd_limited=False, estimate={"unpriced": []}, by_model={}, model_caps={},
                                    threshold=None, finer=[budget], run_total=3.0, plan_charge={"krea": 1},
                                    definitions={})
    assert wait.also == agent_spend.ALSO_PLAN_RUNS
    assert wait.bar_line() == "This would pass the $5 daily total and the 10-run Krea plan limit for this chat."


def test_the_first_reason_is_the_one_the_guard_gives_without_the_total():
    """Unpriced before a model's limit, before the per-run limit, before a budget,
    as decide refuses them; and nothing when only the total stops the run."""
    settings = {"runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": 2, "models": {"flux": {"perRunUsd": 0.5}}}}
    assert _decide([node("n1", "flux"), node("n2", "unpriced")], settings=settings).wait.also == agent_spend.ALSO_UNPRICED
    assert _decide([node("n1", "flux"), node("n2", "paid")], settings=settings).wait.also == agent_spend.ALSO_MODEL_PER_RUN
    assert _decide([node("n1", "paid")], settings=settings).wait.also == agent_spend.ALSO_PER_RUN
    assert _decide([node("n1", "paid")], settings={**settings, "runCostConfirmUsd": None}).wait.also == agent_spend.ALSO_LIMIT
    alone = _decide([node("n1", "paid")], settings={"runCostConfirmUsd": None})
    assert alone.wait is not None and alone.wait.also is None
    assert alone.wait.bar_line() == "This would pass the $5 daily total, which has $1.00 left."


def test_the_numbers_and_the_reason_travel_with_the_wait():
    decision = _decide([node("n1", "flux")], settings={"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 2}})
    shown = decision.wait.as_dict()
    assert {key: shown[key] for key in ("limitUsd", "usedUsd", "leftUsd", "runUsd")} == {
        "limitUsd": 5.0, "usedUsd": 4.0, "leftUsd": 1.0, "runUsd": 3.0}
    assert shown["also"] == "limit" and shown["alsoLimitUsd"] == 2 and shown["alsoFor"] == "this chat"


# -- on the canvas -------------------------------------------------------------------

def test_the_bar_names_the_canvas_node_with_no_list_price(api):
    price(3.0)
    writer = _node(api, "Writer")
    response = api.client.post("/api/graph/node", json={"definitionId": UNPRICED, "params": {}}, headers=PERSON)
    sketch = response.json()["id"]
    api.main.cli_graph.nodes[sketch]["label"] = "Sketch"
    assert api.client.put("/api/settings", headers=PERSON, json={
        "runCostConfirmUsd": 10, "agentSpend": {"sessionUsd": None, "models": {}}}).status_code == 200
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 4.8})
    nodes = [{"id": node_id, "definitionId": api.main.cli_graph.nodes[node_id]["definitionId"], "params": {},
              "outputs": {}} for node_id in (writer, sketch)]
    answer = api.client.post("/api/execute", headers=CLAUDE, json={"nodes": nodes, "edges": []})
    assert answer.status_code == 202, answer.text
    assert answer.json()["alsoNeeds"] == "unpriced"
    proposal = api.main.canvas_proposals.get(answer.json()["proposalId"])
    assert proposal.spec.note == "This would pass the $5 daily total, and “Sketch” has no list price."
    assert proposal.wait["barLine"] == proposal.spec.note


def test_a_held_runs_cursor_has_no_say_of_its_own_and_the_reason_stays_on_the_bar(api, monkeypatch):
    said: list[dict] = []

    async def capture_raw(data, others=None):
        said.append(data)

    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture_raw)
    price(3.0)
    writer = _node(api, "Writer")
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 4.8})
    response = api.client.post("/api/graph/run", json={"targetNodeId": writer}, headers=CLAUDE)
    assert response.status_code == 202, response.text
    proposal = api.main.canvas_proposals.get(response.json()["proposalId"])
    # The held run's cursor carries no say of its own: the tab draws its default
    # ("Waiting for your OK") until the node's header says it (GM - Design, PR #212 r2, item 8),
    # and the reason is never the cursor's.
    held = [event for event in said if isinstance(event, dict) and event.get("proposalId") == proposal.id]
    assert len(held) == 1 and held[0].get("say", "") == "" and held[0].get("action") == "propose"
    assert not any("daily total" in (event.get("say") or "") for event in said if isinstance(event, dict))
    assert proposal.spec.note == "This would pass the $5 daily total, which has $0.20 left."


def test_an_ordinary_proposal_still_says_its_note(api, monkeypatch):
    said: list[dict] = []

    async def capture_raw(data, others=None):
        said.append(data)

    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture_raw)
    writer = _node(api, "Writer")
    created = api.client.post("/api/canvas/proposals", headers=CLAUDE,
                              json={"note": "Make it moodier", "params": [{"nodeId": writer, "params": {"size": "1024x1024"}}]})
    assert created.status_code == 201, created.text
    says = [event.get("say") for event in said if isinstance(event, dict) and event.get("say")]
    assert "Make it moodier" in says and "Waiting for your OK" not in says


# -- agents get the numbers beside the line (GM's answer 6) ---------------------------

def test_nebula_run_prints_the_numbers_beside_the_line():
    from cli.commands import execute

    answer = {"status": "waiting", "proposalId": "p_1234abcd", "message": AGENTS, "alsoNeeds": "perRun",
              "dailyTotal": {"limitUsd": 5.0, "usedUsd": 4.8, "leftUsd": 0.2, "runUsd": 0.4}}
    out = io.StringIO()
    with redirect_stdout(out):
        code = execute._report(answer)
    assert code == execute.EXIT_WAITING
    assert out.getvalue().splitlines() == [
        AGENTS, "  Daily total $5: $4.80 used in the last 24 hours, $0.20 left; this run about $0.40."]


def test_the_docs_list_the_numbers_and_the_reasons():
    root = Path(__file__).resolve().parents[2]
    for doc in (root / "docs" / "MCP-SETUP.md", root / "skills" / "nebula" / "SKILL.md"):
        text = " ".join(doc.read_text().split())
        for field in ("`limitUsd`", "`usedUsd`", "`leftUsd`", "`runUsd`", "`alsoNeeds`", "`modelPerRun`",
                      "`planRuns`", "this run about $0.40", "Daily total $5:"):
            assert field in text, (doc.name, field)
