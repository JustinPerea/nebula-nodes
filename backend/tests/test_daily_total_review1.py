"""The daily total, PR #212 round 2: review 1's findings and GM - Design's
answers to it (2026-10-31). Each test here fails on the round-1 head
(696c3c85): the first-turn read names the total; only callers that name
themselves get the automatic proposal; full proposal slots get GM's line and
a neutral Agent log line; retries arriving together open one proposal; the
202 answer, the dedupe keys and the run-note cleanup are pinned; the other
kinds of caller, moodboard reads and Cinema shots are held; chat spend from
before the upgrade counts; give-backs are held at 0 per key; an absurd total
is refused; and the execute routes never price what Accept won't run."""
from __future__ import annotations

import asyncio
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_daily_total import AGENTS, CLAUDE, PAID, _node, api, price  # noqa: E402,F401

CODEX = {"X-Nebula-Agent": "Codex"}
# GM - Design, 2026-10-31, verbatim (amounts filled in).
SLOTS_FULL = ("This would pass the $5 daily total, and you already have 3 open proposals. Wait until the person "
              "accepts or rejects one, then propose it again.")
# GM - Design, PR #212 r2, item 2: the log's source column names the agent, so the
# sentence reads whole without it.
SLOTS_FULL_LOG = ("Couldn’t run “Fourth” because it would pass the $5 daily total and all 3 proposal slots "
                  "are full.")
# Item 3, cap of 12 (Nebula's total), verbatim.
TOTAL_FULL = ("This would pass the $5 daily total, and Nebula already has 12 open proposals. Wait until the "
              "person accepts or rejects one, then propose it again.")
TOTAL_FULL_LOG = ("Couldn’t run “Writer” because it would pass the $5 daily total and Nebula already has "
                  "12 open proposals.")


def _over(api, used: float = 4.8) -> None:
    api.main.agent_spend_ledger.record("outside:shared", "Agents", {PAID: used})


def _run(api, node_id: str, headers: dict) -> httpx.Response:
    return api.client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=headers)


def _canvas_nodes(api, *ids: str) -> list[dict]:
    graph = api.main.cli_graph
    return [{"id": node_id, "definitionId": graph.nodes[node_id]["definitionId"],
             "params": dict(graph.nodes[node_id].get("params") or {}), "outputs": {}} for node_id in ids]


# -- the 202 answer, and what it leaves behind ------------------------------------------

@pytest.mark.parametrize("route", ["graph/run", "execute", "execute-node"])
def test_the_waiting_answer_has_exactly_these_keys_and_never_the_accept_key(api, route, monkeypatch):
    forgotten: list[str] = []
    forget = api.main.canvas_events.forget_run
    monkeypatch.setattr(api.main.canvas_events, "forget_run", lambda run_id: (forgotten.append(run_id), forget(run_id)))
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    nodes = _canvas_nodes(api, writer)
    body = {"graph/run": {"targetNodeId": writer}, "execute": {"nodes": nodes, "edges": []},
            "execute-node": {"nodes": nodes, "edges": [], "targetNodeId": writer}}[route]
    response = api.client.post(f"/api/{route}", json=body, headers=CLAUDE)
    assert response.status_code == 202, response.text
    answer = response.json()
    expected = {"status", "proposalId", "message", "dailyTotal"} | ({"runId"} if route != "graph/run" else set())
    assert set(answer) == expected
    assert set(answer["dailyTotal"]) == {"limitUsd", "usedUsd", "leftUsd", "runUsd"}
    proposal = api.main.canvas_proposals.get(answer["proposalId"])
    assert proposal.accept_key not in response.text
    if route != "graph/run":
        # The run never started: its notes are forgotten, as for any refusal.
        assert answer["runId"] in forgotten
    api.main.execute_graph.assert_not_awaited()


def test_a_run_that_also_passes_the_per_run_limit_says_so_over_http_and_mcp(api):
    import mcp_server

    price(3.0)
    writer = _node(api, "Writer")
    assert api.client.put("/api/settings", headers=PERSON, json={
        "runCostConfirmUsd": 1, "agentSpend": {"sessionUsd": None, "models": {}}}).status_code == 200
    _over(api)
    response = _run(api, writer, CLAUDE)
    assert response.status_code == 202, response.text
    answer = response.json()
    assert answer["alsoNeeds"] == "perRun"
    shown = json.loads(mcp_server._run_result(answer, None)[0])
    assert shown["alsoNeeds"] == "perRun" and shown["proposalId"] == answer["proposalId"]
    # MCP's hint names its own call, and the text arrives as it is, not \u-escaped.
    assert shown["message"].endswith(f'Check it with get_proposal("{answer["proposalId"]}").')
    raw = mcp_server._run_result(answer, None)[0]
    assert "person’s OK" in raw and "\\u2019" not in raw


def test_the_cli_keeps_its_own_check_it_hint():
    assert AGENTS.endswith("Check it with nebula proposals.")
    assert agent_spend.for_mcp(AGENTS, "p_1234abcd").endswith('Check it with get_proposal("p_1234abcd").')
    assert agent_spend.for_mcp("Something else.", "p_1") == "Something else."


# -- the dedupe: one proposal per (caller, nodes, project) ------------------------------

def test_two_nodes_from_one_agent_are_two_proposals(api):
    price(3.0)
    one, two = _node(api, "Writer"), _node(api, "Editor")
    _over(api)
    first, second = _run(api, one, CLAUDE), _run(api, two, CLAUDE)
    assert first.status_code == second.status_code == 202
    assert first.json()["proposalId"] != second.json()["proposalId"]
    assert len(api.main.canvas_proposals.open_list()) == 2


def test_one_node_from_two_agents_is_two_proposals(api):
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    first, second = _run(api, writer, CLAUDE), _run(api, writer, CODEX)
    assert first.status_code == second.status_code == 202
    assert first.json()["proposalId"] != second.json()["proposalId"]
    agents = {p.agent.name for p in api.main.canvas_proposals.open_list()}
    assert agents == {"Claude Code", "Codex"}


def test_one_node_in_two_projects_is_two_proposals(api, monkeypatch):
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    first = _run(api, writer, CLAUDE)
    real = api.main._workspace_context
    monkeypatch.setattr(api.main, "_workspace_context", lambda: {**real(), "activeProjectId": "p_other"})
    second = _run(api, writer, CLAUDE)
    assert first.status_code == second.status_code == 202
    assert first.json()["proposalId"] != second.json()["proposalId"]
    assert {p.project_id for p in api.main.canvas_proposals.open_list()} == {real()["activeProjectId"], "p_other"}


def test_fifty_retries_arriving_together_open_one_proposal(api, monkeypatch):
    """_open_canvas_proposal awaits its measure before it creates; with the
    measure yielding, every retry used to pass the dedupe first (review 1, L-1)."""
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    measure = api.main._measure_proposal_inputs

    async def slow_measure(*args, **kwargs):
        await asyncio.sleep(0.01)
        return await measure(*args, **kwargs)

    monkeypatch.setattr(api.main, "_measure_proposal_inputs", slow_measure)

    async def burst() -> list[httpx.Response]:
        transport = httpx.ASGITransport(app=api.main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await asyncio.gather(*(client.post("/api/graph/run", json={"targetNodeId": writer},
                                                      headers=CLAUDE) for _ in range(50)))

    answers = asyncio.run(burst())
    assert [a.status_code for a in answers] == [202] * 50
    assert len({a.json()["proposalId"] for a in answers}) == 1
    assert len(api.main.canvas_proposals.open_list()) == 1
    assert api.main._waiting_locks == {}
    api.main.execute_graph.assert_not_awaited()


def test_a_run_only_proposal_of_a_waiting_run_is_that_proposal(api):
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    waiting = _run(api, writer, CLAUDE).json()["proposalId"]
    again = api.client.post("/api/canvas/proposals", json={"note": "Run Writer", "run": [writer]}, headers=CLAUDE)
    assert again.status_code == 200, again.text
    assert again.json()["proposal"]["id"] == waiting
    assert len(api.main.canvas_proposals.open_list()) == 1
    # Another agent's, or one that changes anything, is a proposal of its own.
    other = api.client.post("/api/canvas/proposals", json={"note": "Run Writer", "run": [writer]}, headers=CODEX)
    assert other.status_code == 201 and other.json()["proposal"]["id"] != waiting
    assert len(api.main.canvas_proposals.open_list()) == 2


# -- full slots ------------------------------------------------------------------------

def test_full_proposal_slots_get_one_line_and_a_neutral_log_line(api, monkeypatch):
    said: list[dict] = []

    async def capture_raw(data, others=None):
        said.append(data)

    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture_raw)
    price(3.0)
    nodes = [_node(api, name) for name in ("First", "Second", "Third", "Fourth")]
    _over(api)
    for node_id in nodes[:3]:
        assert _run(api, node_id, CLAUDE).status_code == 202
    opened = len([m for m in api.browser if m.get("type") == "proposalOpened"])
    said.clear()
    refused = _run(api, nodes[3], CLAUDE)
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == SLOTS_FULL
    assert "Propose it instead" not in refused.text and "couldn't send it" not in refused.text
    # No bar or card: nothing new was opened.
    assert len(api.main.canvas_proposals.open_list()) == 3
    assert len([m for m in api.browser if m.get("type") == "proposalOpened"]) == opened
    log = [m for m in said if m.get("type") == "agentPresence" and m.get("log")]
    assert len(log) == 1 and log[0]["log"] == SLOTS_FULL_LOG and log[0]["tone"] == "muted"
    assert log[0]["agent"]["name"] == "Claude Code" and "target" not in log[0]
    api.main.execute_graph.assert_not_awaited()


def test_nebulas_cap_of_twelve_open_proposals_gets_gms_lines(api, monkeypatch):
    said: list[dict] = []

    async def capture_raw(data, others=None):
        said.append(data)

    monkeypatch.setattr(api.main.manager, "broadcast_raw", capture_raw)
    price(3.0)
    nodes = [_node(api, f"Node {index}") for index in range(12)]
    writer = _node(api, "Writer")
    _over(api)
    for index, node_id in enumerate(nodes):
        assert _run(api, node_id, {"X-Nebula-Agent": f"Agent {index // 3}"}).status_code == 202
    assert len(api.main.canvas_proposals.open_list()) == 12
    said.clear()
    refused = _run(api, writer, {"X-Nebula-Agent": "Agent 4"})
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == TOTAL_FULL
    assert "Propose it instead" not in refused.text and "couldn't send it" not in refused.text
    assert len(api.main.canvas_proposals.open_list()) == 12
    log = [m for m in said if m.get("type") == "agentPresence" and m.get("log")]
    assert len(log) == 1 and log[0]["log"] == TOTAL_FULL_LOG and log[0]["tone"] == "muted"
    assert log[0]["agent"]["name"] == "Agent 4"
    api.main.execute_graph.assert_not_awaited()


def test_the_unpriced_only_wait_words_the_full_slots_without_would_pass(api, monkeypatch):
    wait = agent_spend.DailyWait(5.0, 0.0, 0.0, also=agent_spend.ALSO_UNPRICED, unpriced=("n1",),
                                 names={"n1": "Sketch"}, over=False)
    cannot = "“Sketch” has no list price, so Nebula can’t count it toward the $5 daily total"
    assert wait.slots_full_line(3) == (cannot + ", and you already have 3 open proposals. Wait until the person "
                                       "accepts or rejects one, then propose it again.")
    assert wait.total_full_line(12) == (cannot + ", and Nebula already has 12 open proposals. Wait until the "
                                        "person accepts or rejects one, then propose it again.")
    assert wait.slots_full_log(["Sketch"], 3) == ("Couldn’t run “Sketch” because it has no list price and all 3 "
                                                  "proposal slots are full.")
    assert wait.total_full_log(["Writer", "Sketch"], 12) == (
        "Couldn’t run “Writer” and “Sketch” because “Sketch” has no list price and Nebula already has "
        "12 open proposals.")
    assert wait.nameless_line() == cannot + ". Name yourself with NEBULA_AGENT_NAME or --as to send it as a proposal."
    assert wait.refusal("ASK.") == f"Needs the person's approval: {cannot}. ASK."


# -- the other kinds of caller, and runs off the canvas -----------------------------------

@pytest.fixture
def shot_client(monkeypatch, person):
    from fastapi.testclient import TestClient

    import main
    from tests import test_agent_spend as spend_tests

    monkeypatch.setattr(main.model_pricing, "load_pricing", lambda path=None: spend_tests.PRICES)
    monkeypatch.setattr(main, "validate_graph", lambda *args, **kwargs: [])
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    shot = AsyncMock(side_effect=AssertionError("a shot over the total reached its provider"))
    monkeypatch.setattr(main, "_execute_single_shot_pass", shot)
    client = TestClient(main.app)
    reset = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "models": {}}}
    client.put("/api/settings", json=reset, headers=PERSON)
    yield client, main, shot, spend_tests
    client.put("/api/settings", json=reset, headers=PERSON)


@pytest.mark.parametrize("who", ["outside agent", "script"])
def test_a_cinema_shot_over_the_total_is_refused_in_its_words(shot_client, who):
    client, main, shot, spend_tests = shot_client
    spend_tests._price_base(0.3)
    main.agent_spend_ledger.record("outside:shared", "Agents", {"nano-banana": 4.8})
    response = client.post("/api/cinema/generate-shot", json=spend_tests._shot_request(1),
                           headers=CLAUDE if who == "outside agent" else {})
    assert response.status_code == 403, response.text
    assert "would pass their $5 daily total for everything that isn’t them" in response.json()["detail"]
    shot.assert_not_awaited()
    assert main.agent_spend_ledger.spent_daily().total == pytest.approx(4.8)


def test_a_moodboard_read_over_the_total_is_refused_in_its_words(tmp_path, monkeypatch, person):
    from fastapi.testclient import TestClient

    import main
    from tests import test_moodboard_reader_routes as reader_tests

    google = reader_tests.RouteGoogle()
    monkeypatch.setattr(main, "_moodboard_reader_transport", httpx.MockTransport(google.handler))
    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_APP_TOKEN", raising=False)

    async def ignore(data, others=None):
        return None

    monkeypatch.setattr(main.manager, "broadcast_raw", ignore)
    monkeypatch.setattr(main.manager, "broadcast_browser", ignore)
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(None))
    settings = {"apiKeys": {"GOOGLE_API_KEY": "g-test"}, "runCostConfirmUsd": 50.0,
                "agentSpend": {"sessionUsd": None, "models": {}}}
    monkeypatch.setattr(main, "load_settings", lambda: json.loads(json.dumps(settings)))
    client = TestClient(main.app)
    board = reader_tests._board(client, 2)
    estimate = client.post(f"/api/moodboards/{board['id']}/read/estimate", json={"model": "gemini-4-argon"}).json()
    # Used: the total less half of this read's upper bound, so the read passes it and nothing else.
    main.agent_spend_ledger.record("outside:shared", "Agents", {"gemini-chat": round(5.0 - estimate["high"] / 2, 6)})
    response = client.post(f"/api/moodboards/{board['id']}/read?dryRun=1", json={"model": "gemini-4-argon"},
                           headers=CLAUDE)
    assert response.status_code == 403, response.text
    assert "would pass their $5 daily total for everything that isn’t them" in response.json()["detail"]
    assert google.bodies == []


# -- the ledger --------------------------------------------------------------------------

def _file(tmp_path, sessions: dict, **extra) -> Path:
    path = tmp_path / "agent-spend.json"
    path.write_text(json.dumps({"sessions": sessions, **extra}))
    return path


def test_chat_spend_from_before_the_upgrade_counts_toward_the_total(tmp_path):
    now = 1_000_000.0
    path = _file(tmp_path, {
        "chat:a": {"agent": "Claude", "total": 3.0, "models": {PAID: 2.5}, "planRuns": 0, "updated": now - 3600},
        "chat:old": {"agent": "Codex", "total": 9.0, "models": {PAID: 9.0}, "planRuns": 0, "updated": now - 25 * 3600},
        "outside:shared": {"agent": "Agents", "events": [[now - 60, PAID, 1.0, 0]], "updated": now - 60},
    })
    ledger = agent_spend.SpendLedger(path, clock=lambda: now)
    # The chat updated an hour ago counts (all of its $3, at that time); the one from 25 hours ago doesn't.
    assert ledger.spent_daily().total == pytest.approx(4.0)
    saved = json.loads(path.read_text())
    assert saved["chatsDailySeeded"] is True
    # Once: a restart doesn't count it again, and it leaves the window on time.
    assert agent_spend.SpendLedger(path, clock=lambda: now).spent_daily().total == pytest.approx(4.0)
    # 23.5 hours on, the chat's (an hour older) has left the window; the outside run hasn't.
    assert agent_spend.SpendLedger(path, clock=lambda: now + 3600 * 23.5).spent_daily().total == pytest.approx(1.0)


def test_a_file_that_already_counts_its_chats_is_not_counted_twice(tmp_path):
    now = 1_000_000.0
    path = _file(tmp_path, {
        "chat:a": {"agent": "Claude", "total": 3.0, "models": {PAID: 3.0}, "planRuns": 0, "updated": now - 60},
        "daily:chats": {"agent": "Nebula chats", "events": [[now - 60, PAID, 3.0, 0]], "updated": now - 60},
    }, chatsDailySeeded=True)
    assert agent_spend.SpendLedger(path, clock=lambda: now).spent_daily().total == pytest.approx(3.0)
    unmarked = _file(tmp_path, {
        "chat:a": {"agent": "Claude", "total": 3.0, "models": {PAID: 3.0}, "planRuns": 0, "updated": now - 60},
        "daily:chats": {"agent": "Nebula chats", "events": [[now - 60, PAID, 3.0, 0]], "updated": now - 60},
    })
    assert agent_spend.SpendLedger(unmarked, clock=lambda: now).spent_daily().total == pytest.approx(3.0)


def test_a_give_back_never_erases_another_keys_spend():
    ledger = agent_spend.SpendLedger(None)
    at = ledger.record("chat:a", "Claude", {PAID: 2.0})
    ledger.record("outside:shared", "Agents", {PAID: 2.0})
    ledger.refund("chat:a", {PAID: 2.0}, at=at)
    ledger.refund("chat:a", {PAID: 2.0}, at=at)  # a second give-back of the same share
    assert ledger.spent_daily().total == pytest.approx(2.0)


# -- the setting ------------------------------------------------------------------------

@pytest.mark.parametrize("value", [10 ** 400, 1e308, 100_000.01])
def test_an_absurd_total_saved_by_hand_reads_as_the_default(value):
    assert agent_spend.caps_from_settings({"agentSpend": {"dailyTotalUsd": value}})["dailyTotalUsd"] == 5.0
    with pytest.raises(ValueError):
        agent_spend.validate_caps({"sessionUsd": None, "dailyTotalUsd": value, "models": {}}, {})


def test_a_huge_session_limit_saved_by_hand_is_unreadable_not_a_500():
    assert agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": 10 ** 400}})["sessionUsd"] is None


def test_the_person_can_save_up_to_the_most_a_total_may_be(api):
    ok = api.client.put("/api/settings", headers=PERSON, json={
        "agentSpend": {"sessionUsd": None, "dailyTotalUsd": 100_000, "models": {}}})
    assert ok.status_code == 200, ok.text
    refused = api.client.put("/api/settings", headers=PERSON, json={
        "agentSpend": {"sessionUsd": None, "dailyTotalUsd": 1e308, "models": {}}})
    assert refused.status_code in (400, 422), refused.text
    assert agent_spend.caps_from_settings(api.main.load_settings())["dailyTotalUsd"] == 100_000


# -- the execute routes price what Accept runs ----------------------------------------------

@pytest.mark.parametrize("route", ["execute", "execute-node"])
def test_a_request_whose_nodes_arent_the_canvas_is_refused_not_proposed(api, route):
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    nodes = _canvas_nodes(api, writer)
    nodes[0]["params"] = {**nodes[0]["params"], "prompt": "not what the canvas has"}
    body = {"nodes": nodes, "edges": []} if route == "execute" else {"nodes": nodes, "edges": [],
                                                                     "targetNodeId": writer}
    response = api.client.post(f"/api/{route}", json=body, headers=CLAUDE)
    assert response.status_code == 403, response.text
    assert "would pass their $5 daily total for everything that isn’t them" in response.json()["detail"]
    assert api.main.canvas_proposals.open_list() == []
    api.main.execute_graph.assert_not_awaited()


# -- the first-turn read and `nebula context` ------------------------------------------------

def test_nebula_context_prints_the_daily_total():
    from cli.formatter import format_start
    from services import agent_start

    status = {"limited": True, "budget": "shared", "window": "24h",
              "limits": {"perRunUsd": 1.0, "sessionUsd": None, "outsideDailyUsd": None, "kreaPlanRuns": 4,
                         "models": {}},
              "spent": {"totalUsd": 2.0, "models": {}, "kreaPlanRuns": 0},
              "outsideSpent": {"totalUsd": 2.0, "models": {}, "kreaPlanRuns": 0},
              "dailyTotal": {"limitUsd": 5.0, "usedUsd": 2.0, "leftUsd": 3.0, "window": "24h"}}
    part = agent_start.spend_part(status)
    assert part["daily"] == {"limitUsd": 5.0, "usedUsd": 2.0, "leftUsd": 3.0}
    out = io.StringIO()
    with redirect_stdout(out):
        print(format_start({"spend": part}))
    assert "Daily total, everything that isn't the person, last 24 hours: $5, $2.00 used, $3.00 left" in out.getvalue()
    none = agent_start.spend_part({**status, "dailyTotal": {"limitUsd": None, "usedUsd": 2.0, "leftUsd": None}})
    assert "no limit ($2.00 used)" in format_start({"spend": none})


def test_the_in_app_chat_prompt_says_a_waiting_run_was_already_proposed():
    """The in-app chat agents read only this (review 1 of PR #212, LOW-3)."""
    from services.chat_session import NEBULA_MCP_PRIMER

    text = " ".join(NEBULA_MCP_PRIMER.split())
    assert ("A run past the person's daily total comes back 'waiting' with a proposalId: Nebula already sent it "
            "to them as a proposal, so don't propose it again; wait for their decision with get_proposal.") in text
    assert "A run answered 'waiting' was already sent as a proposal" in text


# -- Justin's Q165: the total alone makes an unpriced node ask ---------------------------

SKETCH_BAR = "“Writer” has no list price, so Nebula can’t count it toward the $5 daily total."
SKETCH_UPDATE = "Claude Code wants to run “Writer”. It has no list price, so Nebula can’t count it toward the $5 daily total."


def _unpriced() -> None:
    from tests.test_daily_total import PRICES

    PRICES["nodes"] = {}  # the paid node has no list price


def test_an_unpriced_node_waits_with_room_left_and_no_other_limit(api):
    _unpriced()
    writer = _node(api, "Writer")
    response = _run(api, writer, CLAUDE)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "waiting" and body["alsoNeeds"] == agent_spend.ALSO_UNPRICED
    assert body["message"] == (f"{SKETCH_BAR} Proposing it for the person’s OK. Sent as proposal "
                               f"{body['proposalId']}. Check it with nebula proposals.")
    assert body["dailyTotal"]["usedUsd"] == 0.0 and body["dailyTotal"]["leftUsd"] == 5.0
    proposal = api.main.canvas_proposals.get(body["proposalId"])
    assert proposal.spec.note == SKETCH_BAR == proposal.wait["barLine"]  # the bar's line
    assert proposal.wait["over"] is False
    from services.canvas_proposals import update_text

    assert update_text(proposal) == SKETCH_UPDATE
    api.main.execute_graph.assert_not_awaited()
    # The MCP wording of the same line.
    assert agent_spend.for_mcp(body["message"], body["proposalId"]).endswith(f'Check it with get_proposal("{body["proposalId"]}").')


def test_an_unpriced_node_waits_with_the_per_run_limit_off_too(api):
    _unpriced()
    assert api.client.put("/api/settings", json={"runCostConfirmUsd": None}, headers=PERSON).status_code == 200
    writer = _node(api, "Writer")
    assert _run(api, writer, CLAUDE).status_code == 202


def test_the_unpriced_line_gives_way_to_the_existing_one_when_the_priced_part_passes(api):
    price(3.0)
    writer = _node(api, "Writer")
    _over(api)
    api.client.put("/api/settings", json={"runCostConfirmUsd": None}, headers=PERSON)
    # Priced and over the total: the existing line (no unpriced node in this run).
    body = _run(api, writer, CLAUDE).json()
    assert api.main.canvas_proposals.get(body["proposalId"]).wait["over"] is True


def test_with_the_total_off_an_unpriced_node_runs_as_before(api):
    _unpriced()
    saved = api.client.put("/api/settings", json={"runCostConfirmUsd": None,
                                                  "agentSpend": {"dailyTotalUsd": None, "models": {}}},
                           headers=PERSON)
    assert saved.status_code == 200, saved.text
    writer = _node(api, "Writer")
    assert _run(api, writer, CLAUDE).status_code == 200
    api.main.execute_graph.assert_awaited_once()
    assert api.main.canvas_proposals.open_list() == []


def test_the_persons_own_run_of_an_unpriced_node_is_never_limited(api):
    _unpriced()
    writer = _node(api, "Writer")
    assert _run(api, writer, PERSON).status_code == 200
    api.main.execute_graph.assert_awaited_once()
    assert api.main.canvas_proposals.open_list() == []


def test_a_caller_with_no_name_gets_the_unpriced_line_and_no_proposal(api):
    _unpriced()
    writer = _node(api, "Writer")
    response = api.client.post("/api/graph/run", json={"targetNodeId": writer})
    assert response.status_code == 403
    assert response.json()["detail"].startswith(SKETCH_BAR) and "Name yourself" in response.json()["detail"]
    assert api.main.canvas_proposals.open_list() == []


def test_the_propose_hint_names_only_the_callers_surface():
    cli = agent_spend.propose_hint(["n1", "n2"], "cli")
    assert cli == ('Propose it instead: `nebula propose --note "<why>" --run n1 --run n2`. '
                   "The person accepts on the canvas, and the canvas runs it.")
    assert "propose_change" not in cli and "MCP" not in cli
    mcp = agent_spend.propose_hint_for_mcp(f"Needs the person's approval: no price. {cli}")
    assert mcp == ("Needs the person's approval: no price. Propose it instead with propose_change. "
                   "The person accepts on the canvas, and the canvas runs it.")
    assert "nebula" not in mcp
    assert agent_spend.propose_hint_for_mcp("No hint here.") == "No hint here."
