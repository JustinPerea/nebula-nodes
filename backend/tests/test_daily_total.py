"""The daily total for everything that isn't the person (Justin decided,
2026-10-31): $5 by default, changeable in Settings, and a run that would pass
it waits for the person's OK as a proposal. GM - Design's lines are pinned
here verbatim."""
from __future__ import annotations

import io
import json
import sys
import threading
import time
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from services.agent_presence import AgentIdentity  # noqa: E402
from services.canvas_proposals import Proposal, ProposalBook, ProposalSpec, update_text  # noqa: E402
from services.node_names import node_name_list  # noqa: E402
from tests.conftest import FORGED_ORIGIN, PERSON  # noqa: E402

PAID = "gpt-image-1-generate"
KEY = "X-Nebula-Proposal-Key"
CLAUDE = {"X-Nebula-Agent": "Claude Code"}

# GM - Design, 2026-10-31, verbatim (with the clarification: "$5 / day" is
# simply preselected, no option says "(default)").
BAR_LEFT = "This would pass the $5 daily total, which has $0.20 left."
BAR_USED_UP = "This would pass the $5 daily total, which is used up."
BAR_AND_PER_RUN = "This would pass the $5 daily total and costs more than $1 per run."
CARD = "This run would pass the $5 daily total."
UPDATE = "Claude Code wants to run “Writer” and “Editor”. " + BAR_LEFT
AGENTS = ("Waiting for the person’s OK: this run (about $0.40) would pass their $5 daily total for "
          "everything that isn’t them ($4.80 used in the last 24 hours). Sent as proposal p_1234abcd. "
          "Check it with nebula proposals.")


# -- the setting ------------------------------------------------------------------

@pytest.mark.parametrize(("settings", "expected"), [
    ({}, 5.0),                                                      # never set: the $5 default
    ({"agentSpend": {}}, 5.0),
    ({"agentSpend": {"sessionUsd": 10}}, 5.0),
    ({"agentSpend": {"dailyTotalUsd": None}}, None),                 # "No limit" stays no limit
    ({"agentSpend": {"dailyTotalUsd": 7.5}}, 7.5),
    ({"agentSpend": {"dailyTotalUsd": "lots"}}, 5.0),                # unreadable fails closed
    ({"agentSpend": {"dailyTotalUsd": -1}}, 5.0),
    ({"agentSpend": "junk"}, 5.0),
])
def test_the_default_is_five_dollars_and_only_null_lifts_it(settings, expected):
    assert agent_spend.caps_from_settings(settings)[agent_spend.DAILY_TOTAL_KEY] == expected


def test_no_limit_saved_stays_no_limit():
    saved = agent_spend.validate_caps({"sessionUsd": None, "dailyTotalUsd": None, "models": {}}, {})
    assert saved["dailyTotalUsd"] is None
    assert agent_spend.caps_from_settings({"agentSpend": saved})["dailyTotalUsd"] is None
    # Left out of a save, it isn't written: the default holds.
    assert "dailyTotalUsd" not in agent_spend.validate_caps({"sessionUsd": None, "models": {}}, {})
    with pytest.raises(ValueError):
        agent_spend.validate_caps({"dailyTotalUsd": 0}, {})


# -- the window and who counts ------------------------------------------------------

class Clock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_the_window_rolls_and_spend_25_hours_ago_does_not_count():
    clock = Clock()
    ledger = agent_spend.SpendLedger(None, clock=clock)
    ledger.record("outside:shared", "Agents", {"paid": 3.0})
    ledger.record("chat:a", "Claude", {"paid": 1.0})
    clock.now += 25 * 3600
    # Read before anything is written again: the read itself leaves out the old spend.
    assert ledger.spent_daily().total == 0
    ledger.record("chat:b", "Codex", {"paid": 0.5})
    assert ledger.spent_daily().total == pytest.approx(0.5)
    # A chat's own budget is a session total and keeps it; only the daily total rolls.
    assert ledger.spent("chat:a").total == pytest.approx(1.0)


def test_every_key_counts_toward_the_total_and_give_backs_land_at_the_run():
    clock = Clock()
    ledger = agent_spend.SpendLedger(None, clock=clock)
    at = ledger.record("chat:a", "Claude", {"paid": 1.0})
    ledger.record("outside:shared", "Agents outside Nebula chats", {"paid": 2.0})
    ledger.record("outside:app:x", "Hermes", {"paid": 0.25})
    ledger.record("outside:personal:claude", "Claude (yours)", {"paid": 0.5})
    assert ledger.spent_daily().total == pytest.approx(3.75)
    ledger.refund("chat:a", {"paid": 1.0}, at=at)
    assert ledger.spent_daily().total == pytest.approx(2.75)
    # With no time there's no window to give it back in: it stays counted.
    at2 = ledger.record("chat:a", "Claude", {"paid": 1.0})
    ledger.refund("chat:a", {"paid": 1.0})
    assert at2 and ledger.spent_daily().total == pytest.approx(3.75)


def test_the_chat_events_survive_a_restart_and_are_never_dropped_for_room(tmp_path):
    path = tmp_path / "agent-spend.json"
    ledger = agent_spend.SpendLedger(path)
    for index in range(agent_spend.MAX_SESSIONS + 3):
        ledger.record(f"chat:{index}", "Claude", {"paid": 0.01})
    again = agent_spend.SpendLedger(path)
    assert again.spent_daily().total == pytest.approx(0.01 * (agent_spend.MAX_SESSIONS + 3))


# -- the decision ---------------------------------------------------------------------

DEFINITIONS = {"paid": {"id": "paid", "displayName": "Paid Model", "apiProvider": "openai"},
               "unpriced": {"id": "unpriced", "displayName": "Mystery", "apiProvider": "openai"}}


def _decide(amount: float, used: float, *, settings: dict | None = None, items=None):
    settings = settings if settings is not None else {"runCostConfirmUsd": None}
    caps = agent_spend.caps_from_settings(settings)
    budgets = agent_spend.session_budgets("outside:shared", agent_spend.Spent(), caps,
                                          outside_spent=agent_spend.Spent(),
                                          daily_spent=agent_spend.Spent(used))
    return agent_spend.decide(
        items or [{"id": "n1", "definitionId": "paid", "params": {}}], [], settings=settings,
        pricing={"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}},
        definitions=DEFINITIONS, budgets=budgets, how_to_ask="ASK.")


def test_a_run_that_fits_goes_ahead_and_one_that_passes_waits():
    assert _decide(0.4, 4.6).refusal is None          # exactly at the total: fits
    waiting = _decide(0.4, 4.8)
    assert waiting.wait is not None and waiting.wait.left == pytest.approx(0.2)
    assert waiting.wait.bar_line() == BAR_LEFT
    assert waiting.wait.card_line() == CARD
    assert waiting.wait.agent_line("p_1234abcd") == AGENTS
    assert _decide(0.4, 5.2).wait.bar_line() == BAR_USED_UP
    assert _decide(0.4, 4.8, settings={"runCostConfirmUsd": None, "agentSpend": {"dailyTotalUsd": None}}).refusal is None


def test_the_combined_reason_puts_the_total_first():
    over_both = _decide(1.5, 4.0, settings={"runCostConfirmUsd": 1})
    assert over_both.wait is not None and over_both.wait.also == agent_spend.ALSO_PER_RUN
    assert over_both.wait.bar_line() == BAR_AND_PER_RUN
    # Over $1 alone is refused as before, not made to wait.
    over_run = _decide(1.5, 0.0, settings={"runCostConfirmUsd": 1})
    assert over_run.wait is None and "per-run limit" in over_run.refusal
    unpriced = _decide(4.0, 2.0, settings={"runCostConfirmUsd": 10},
                       items=[{"id": "n1", "definitionId": "paid", "params": {}},
                              {"id": "n2", "definitionId": "unpriced", "params": {}}])
    assert unpriced.wait is not None and unpriced.wait.also == agent_spend.ALSO_UNPRICED
    assert unpriced.wait.bar_line().startswith("This would pass the $5 daily total and ")


def test_the_total_alone_never_makes_an_unpriced_node_ask():
    """The guard's other rows stay as they were: with no other limit, an
    unpriced node runs (it can't be counted), as it did before the total."""
    decision = _decide(0.4, 0.0, items=[{"id": "n2", "definitionId": "unpriced", "params": {}}])
    assert decision.refusal is None


def test_a_run_off_the_canvas_is_refused_in_the_same_words():
    decision = _decide(0.4, 4.8)
    assert decision.refusal == (
        "Needs the person's approval: this run (about $0.40) would pass their $5 daily total for everything "
        "that isn’t them ($4.80 used in the last 24 hours). ASK.")


@pytest.mark.parametrize(("amount", "text"), [(5, "$5"), (7.5, "$7.50"), (0.5, "$0.50"), (1000, "$1,000"),
                                              (2.999, "$3")])
def test_limits_read_as_settings_writes_them(amount, text):
    assert agent_spend.limit_usd(amount) == text


@pytest.mark.parametrize(("names", "text"), [
    (["Writer"], "“Writer”"),
    (["Writer", "Editor"], "“Writer” and “Editor”"),
    (["A", "B", "C"], "“A”, “B” and “C”"),
    (["A", "A"], "2 “A” nodes"),
    (["A", "B", "C", "D"], "4 nodes"),
])
def test_the_name_list_matches_the_frontend_helper(names, text):
    assert node_name_list(names) == text


def test_the_updates_card_line():
    proposal = Proposal(id="p_1", agent=AgentIdentity("ext:claude-code", "Claude Code", "#fff", False),
                        project_id="pr", spec=ProposalSpec(note=BAR_LEFT, run=("n1", "n2")), positions={},
                        created_at=0, expires_at=1, cost={},
                        wait={"barLine": BAR_LEFT, "names": ["Writer", "Editor"]})
    assert update_text(proposal) == UPDATE


# -- reserving is one step -------------------------------------------------------------

def test_two_runs_that_fit_alone_cannot_both_pass_the_total():
    ledger = agent_spend.SpendLedger(None)
    settings = {"runCostConfirmUsd": None}
    caps = agent_spend.caps_from_settings(settings)
    pricing = {"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": 3.0}]}}}
    both_read = threading.Barrier(2, timeout=0.3)

    def check():
        budgets = [agent_spend.daily_budget(ledger.spent_daily(), caps)]
        try:
            both_read.wait()  # without the lock, both read $0 here before either counts
        except threading.BrokenBarrierError:
            pass
        time.sleep(0.05)
        return agent_spend.decide([{"id": "n1", "definitionId": "paid", "params": {}}], [], settings=settings,
                                  pricing=pricing, definitions=DEFINITIONS, budgets=budgets, how_to_ask="ASK.")

    results: list = []
    threads = [threading.Thread(target=lambda: results.append(ledger.reserve("outside:shared", "A", check)))
               for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    waited = [decision for decision, _at in results if decision.wait is not None]
    went = [decision for decision, at in results if decision.refusal is None and at is not None]
    assert len(went) == 1 and len(waited) == 1
    assert ledger.spent_daily().total == pytest.approx(3.0)


# -- over HTTP --------------------------------------------------------------------------

PRICES: dict = {"nodes": {}}


async def every_node_calls_its_provider(*, nodes, run_id=None, **kwargs):
    """A stand-in engine: each node reaches its handler, so the whole count stays."""
    from execution import provider_calls

    for node in nodes:
        provider_calls.mark(run_id, node.id)


def price(amount: float) -> None:
    PRICES["nodes"] = {PAID: {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}


@pytest.fixture
def api(monkeypatch, person):
    import main

    browser: list[dict] = []

    async def capture_browser(data):
        browser.append(data)

    async def nothing(*args, **kwargs):
        return None

    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: PRICES)
    monkeypatch.setattr(main, "execute_graph", AsyncMock(side_effect=every_node_calls_its_provider))
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    monkeypatch.setattr(main, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main.manager, "broadcast_browser", capture_browser)
    monkeypatch.setattr(main.manager, "broadcast_raw", nothing)
    client = TestClient(main.app)
    client.delete("/api/graph?force=true", headers=PERSON)
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "models": {}}}
    assert client.put("/api/settings", json=settings, headers=PERSON).status_code == 200

    class Api:
        pass

    ctx = Api()
    ctx.client, ctx.main, ctx.browser = client, main, browser
    yield ctx
    client.delete("/api/graph?force=true", headers=PERSON)
    client.put("/api/settings", json=settings, headers=PERSON)


def _node(api, label: str | None = None) -> str:
    response = api.client.post("/api/graph/node", json={"definitionId": PAID, "params": {}}, headers=PERSON)
    assert response.status_code == 200, response.text
    node_id = response.json()["id"]
    if label:
        api.main.cli_graph.nodes[node_id]["label"] = label
    return node_id


def _key(api, proposal_id: str) -> str:
    return next(m["acceptKey"] for m in api.browser
                if m.get("type") == "proposalOpened" and m["proposal"]["id"] == proposal_id)


def test_a_run_that_would_pass_the_total_becomes_a_proposal_and_accept_runs_it(api):
    price(3.0)
    writer = _node(api, "Writer")
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 4.8})
    response = api.client.post("/api/graph/run", json={"targetNodeId": writer}, headers=CLAUDE)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "waiting" and body["proposalId"].startswith("p_")
    assert body["dailyTotal"] == {"limitUsd": 5.0, "usedUsd": 4.8, "leftUsd": 0.2, "runUsd": 3.0}
    assert body["message"] == (
        "Waiting for the person’s OK: this run (about $3.00) would pass their $5 daily total for everything "
        f"that isn’t them ($4.80 used in the last 24 hours). Sent as proposal {body['proposalId']}. "
        "Check it with nebula proposals.")
    api.main.execute_graph.assert_not_awaited()
    assert api.main.agent_spend_ledger.spent_daily().total == pytest.approx(4.8)  # nothing counted
    proposal = api.main.canvas_proposals.get(body["proposalId"])
    assert proposal.spec.run == (writer,) and proposal.spec.note == BAR_LEFT
    assert proposal.wait["cardLine"] == CARD and proposal.wait["nodeIds"] == [writer]
    assert update_text(proposal) == f"Claude Code wants to run “Writer”. {BAR_LEFT}"
    view = api.client.get(f"/api/canvas/proposals/{proposal.id}", headers=CLAUDE).json()
    assert view["proposal"]["wait"]["barLine"] == BAR_LEFT and view["proposal"]["wait"]["cardLine"] == CARD
    # Asking again for the same nodes points at the same proposal.
    again = api.client.post("/api/graph/run", json={"targetNodeId": writer}, headers=CLAUDE)
    assert again.status_code == 202 and again.json()["proposalId"] == body["proposalId"]
    assert len(api.main.canvas_proposals.open_list()) == 1
    # The person accepts; the canvas runs it as theirs, uncounted.
    accepted = api.client.post(f"/api/canvas/proposals/{proposal.id}/accept",
                               headers={**PERSON, KEY: _key(api, proposal.id)}, json={})
    assert accepted.status_code == 200, accepted.text
    approval = accepted.json()["approvalId"]
    assert approval
    graph = api.main.cli_graph
    nodes = [{"id": node_id, "definitionId": node["definitionId"], "params": node.get("params") or {}, "outputs": {}}
             for node_id, node in graph.nodes.items()]
    started = api.client.post("/api/execute-node", headers=PERSON,
                              json={"nodes": nodes, "edges": [], "targetNodeId": writer, "approvalId": approval})
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "started"
    assert api.main.agent_spend_ledger.spent_daily().total == pytest.approx(4.8)


def test_the_persons_runs_never_count_and_never_wait(api):
    price(3.0)
    node_id = _node(api)
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 5.0})
    response = api.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=PERSON)
    assert response.status_code == 200, response.text
    api.main.execute_graph.assert_awaited_once()
    assert api.main.agent_spend_ledger.spent_daily().total == pytest.approx(5.0)
    assert api.main.canvas_proposals.open_list() == []


def _chat_headers():
    from commons.actors import agent_registry
    token = agent_registry.mint("claude", [], session="chat-daily")
    return {"Authorization": f"Agent {token}"}, token


@pytest.mark.parametrize("kind", ["chat agent", "outside agent", "script", "unconnected tab"])
def test_each_kind_that_isnt_the_person_counts_toward_the_total(api, kind):
    from commons.actors import agent_registry

    price(2.0)
    node_id = _node(api)
    token = None
    if kind == "chat agent":
        headers, token = _chat_headers()
    else:
        headers = {"outside agent": CLAUDE, "script": {}, "unconnected tab": FORGED_ORIGIN}[kind]
    try:
        first = api.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=headers)
        assert first.status_code == 200, first.text
        assert api.main.agent_spend_ledger.spent_daily().total == pytest.approx(2.0)
        api.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=headers)
        third = api.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=headers)
        assert third.status_code == 202, third.text  # $4 used, $2 more passes $5
        assert third.json()["dailyTotal"]["usedUsd"] == pytest.approx(4.0)
    finally:
        if token:
            agent_registry.revoke(token)


def test_an_unconnected_tabs_canvas_run_shows_the_proposal(api):
    price(3.0)
    node_id = _node(api)
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 4.0})
    nodes = [{"id": node_id, "definitionId": PAID, "params": {}, "outputs": {}}]
    response = api.client.post("/api/execute", headers=FORGED_ORIGIN, json={"nodes": nodes, "edges": []})
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "waiting" and body["runId"]
    opened = [m for m in api.browser if m.get("type") == "proposalOpened"]
    assert opened and opened[-1]["proposal"]["agent"]["name"] == "Unnamed client"
    assert opened[-1]["proposal"]["wait"]["barLine"] == "This would pass the $5 daily total, which has $1.00 left."
    api.main.execute_graph.assert_not_awaited()


def test_the_second_of_two_runs_that_fit_alone_waits(api):
    price(3.0)
    first, second = _node(api), _node(api)
    one = api.client.post("/api/graph/run", json={"targetNodeId": first}, headers=CLAUDE)
    two = api.client.post("/api/graph/run", json={"targetNodeId": second}, headers={"X-Nebula-Agent": "Codex"})
    assert one.status_code == 200 and two.status_code == 202
    assert two.json()["dailyTotal"]["usedUsd"] == pytest.approx(3.0)


def test_a_quick_run_over_the_total_is_refused_in_the_total_s_words(api):
    price(3.0)
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 4.0})
    response = api.client.post("/api/quick", json={"definitionId": PAID, "params": {}, "inputs": {"prompt": "x"}},
                               headers=CLAUDE)
    assert response.status_code == 403
    assert "would pass their $5 daily total for everything that isn’t them" in response.json()["detail"]


# -- agents read it, and can't change it ----------------------------------------------------

def test_agents_read_the_total_used_and_left_exactly(api):
    api.main.agent_spend_ledger.record("chat:x", "Claude", {PAID: 1.25})
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: 2.1})
    view = api.client.get("/api/agent/spend", headers=CLAUDE).json()
    assert view["dailyTotal"] == {"limitUsd": 5.0, "usedUsd": 3.35, "leftUsd": 1.65, "window": "24h"}
    assert view["limits"]["dailyTotalUsd"] == 5.0
    assert api.client.get("/api/agent/spend/apps", headers=PERSON).json()["daily"] == {"spentUsd": 3.35}


def test_nebula_spend_prints_it():
    from cli.commands import spend

    class Client:
        def get_spend(self):
            return {"limited": True, "budget": "shared", "limits": {"perRunUsd": 1.0, "kreaPlanRuns": 10},
                    "spent": {"totalUsd": 0}, "outsideSpent": {"totalUsd": 0},
                    "dailyTotal": {"limitUsd": 5.0, "usedUsd": 3.35, "leftUsd": 1.65, "window": "24h"}}

    out = io.StringIO()
    with redirect_stdout(out):
        spend.run(Client())
    assert ("Daily total, everything that isn't the person, last 24 hours: $5.00, $3.35 used, $1.65 left"
            in out.getvalue())


def test_the_cli_and_mcp_pass_the_waiting_line_as_it_is():
    from cli.commands import execute
    import mcp_server

    answer = {"status": "waiting", "proposalId": "p_1234abcd", "message": AGENTS,
              "dailyTotal": {"limitUsd": 5.0, "usedUsd": 4.8, "leftUsd": 0.2, "runUsd": 0.4}}
    out = io.StringIO()
    with redirect_stdout(out):
        code = execute._report(answer)
    assert code == execute.EXIT_WAITING and out.getvalue().strip() == AGENTS
    shown = json.loads(mcp_server._run_result(answer, None)[0])
    assert shown["message"] == AGENTS and shown["dailyTotal"]["usedUsd"] == 4.8 and shown["status"] == "waiting"


def test_agents_cant_change_the_total(api):
    for headers in (CLAUDE, FORGED_ORIGIN, {}):
        refused = api.client.put("/api/settings", json={"agentSpend": {"sessionUsd": None, "dailyTotalUsd": None,
                                                                       "models": {}}}, headers=headers)
        assert refused.status_code in (401, 403), refused.text
    assert agent_spend.caps_from_settings(api.main.load_settings())["dailyTotalUsd"] == 5.0
    saved = api.client.put("/api/settings", json={"agentSpend": {"sessionUsd": None, "dailyTotalUsd": 7.5,
                                                                 "models": {}}}, headers=PERSON)
    assert saved.status_code == 200
    assert api.client.get("/api/settings", headers=CLAUDE).json()["agentSpend"]["dailyTotalUsd"] == 7.5
