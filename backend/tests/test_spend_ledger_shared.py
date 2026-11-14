"""The spend ledger is one truth for every backend on a data folder
(follow-up to PR #212): two SpendLedger objects on one file stand for two
Nebula backends on one ~/.nebula. Each check and count re-reads the file
under an exclusive lock between processes; a lock not free in time refuses
the run; an unreadable file is kept aside and holds every budget at its
limit for 24 hours; a run whose backend died stays counted until it ages
out of the window."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from tests.test_agent_spend import add_paid_node, client, price  # noqa: E402,F401 - client is a fixture
from tests.conftest import PERSON  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
HOUR = 60 * 60
DEFINITIONS = {"paid": {"id": "paid", "displayName": "Paid Model", "apiProvider": "openai"}}


class Clock:
    def __init__(self, now: float = 1_760_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _run(ledger: agent_spend.SpendLedger, key: str, amount: float, settings: dict, *, model: str = "paid"):
    """One agent run of ``amount`` through ``ledger``, checked as main._spend_budgets
    builds its budgets, all inside reserve."""
    caps = agent_spend.caps_from_settings(settings)

    def check() -> agent_spend.Decision:
        outside = ledger.spent_outside() if agent_spend.is_outside(key) else None
        budgets = agent_spend.session_budgets(key, ledger.spent(key), caps, outside_spent=outside,
                                              daily_spent=ledger.spent_daily())
        return agent_spend.decide(
            [{"id": "n1", "definitionId": model, "params": {}}], [], settings=settings,
            pricing={"nodes": {model: {"currency": "usd", "rows": [{"match": {}, "price": amount}]}}},
            definitions={model: {"id": model, "displayName": "Paid Model", "apiProvider": "openai"}},
            budgets=budgets, how_to_ask="ASK.")
    return ledger.reserve(key, "Agent", check)


def _two(path: Path, clock=None) -> tuple[agent_spend.SpendLedger, agent_spend.SpendLedger]:
    kwargs = {"clock": clock} if clock is not None else {}
    return agent_spend.SpendLedger(path, **kwargs), agent_spend.SpendLedger(path, **kwargs)


# -- two backends, one file ---------------------------------------------------------------

def test_spend_through_one_backend_is_seen_by_the_others_next_decision(tmp_path):
    a, b = _two(tmp_path / "agent-spend.json")
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None, "dailyTotalUsd": 1}}
    assert b.spent_daily().total == 0
    decision, at = _run(a, "outside:shared", 0.6, settings)
    assert decision.refusal is None and at is not None
    assert b.spent_daily().total == pytest.approx(0.6)
    assert b.spent_outside().total == pytest.approx(0.6)
    # Each fits alone ($0.60 of $1); together they don't: the second waits.
    second, at2 = _run(b, "outside:shared", 0.6, settings)
    assert second.wait is not None and second.wait.used == pytest.approx(0.6) and at2 is None
    assert a.spent_daily().total == pytest.approx(0.6)


@pytest.mark.parametrize(("key", "caps"), [
    ("chat:s1", {"sessionUsd": 1, "dailyTotalUsd": None}),                              # the session limit
    ("outside:shared", {"sessionUsd": None, "outsideDailyUsd": 1, "dailyTotalUsd": None}),  # the outside limit
    ("chat:s1", {"sessionUsd": None, "dailyTotalUsd": 1}),                               # the daily total
    ("outside:shared", {"sessionUsd": None, "outsideDailyUsd": None, "dailyTotalUsd": 1}),
])
def test_each_limit_holds_across_two_backends(tmp_path, key, caps):
    a, b = _two(tmp_path / "agent-spend.json")
    settings = {"runCostConfirmUsd": None, "agentSpend": caps}
    first, _ = _run(a, key, 0.6, settings)
    assert first.refusal is None
    second, at = _run(b, key, 0.6, settings)
    assert second.refusal is not None and at is None
    assert a.spent_daily().total == pytest.approx(0.6) and b.spent_daily().total == pytest.approx(0.6)


def test_the_model_session_limit_holds_across_two_backends(tmp_path):
    a, b = _two(tmp_path / "agent-spend.json")
    settings = {"runCostConfirmUsd": None,
                "agentSpend": {"sessionUsd": None, "dailyTotalUsd": None, "models": {"paid": {"sessionUsd": 1}}}}
    assert _run(a, "chat:s1", 0.6, settings)[0].refusal is None
    refused = _run(b, "chat:s1", 0.6, settings)[0]
    assert refused.refusal and "Paid Model budget" in refused.refusal


def test_one_backends_save_never_drops_the_others_events(tmp_path):
    path = tmp_path / "agent-spend.json"
    a, b = _two(path)
    a.record("outside:shared", "Outside", {"paid": 0.1})
    b.record("chat:b", "Codex", {"paid": 0.2})
    b.record("outside:app:x", "App", {"paid": 0.4})
    a.record("outside:shared", "Outside", {"paid": 0.3})
    a.refund("chat:b", {"paid": 0.05})  # a give-back from the other backend lands on the shared file
    saved = json.loads(path.read_text())["sessions"]
    assert [event[2] for event in saved["outside:shared"]["events"]] == [0.1, 0.3]
    assert [event[2] for event in saved["outside:app:x"]["events"]] == [0.4]
    assert saved["chat:b"]["total"] == pytest.approx(0.15)
    assert len(saved[agent_spend.CHATS_DAILY]["events"]) == 1
    assert a.spent_daily().total == pytest.approx(1.0) == b.spent_daily().total


def test_the_first_load_steps_run_once_for_the_file(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text(json.dumps({"sessions": {
        "unverified:aaa": {"agent": "x", "total": 0.9, "models": {"paid": 0.6}, "updated": clock.now - HOUR},
        "chat:c1": {"agent": "Claude", "total": 1, "models": {"paid": 1}, "updated": clock.now - HOUR},
    }}))  # from before the daily total: not seeded, with a legacy key
    a, b = _two(path, clock)
    assert a.spent_outside().total == pytest.approx(0.9)
    assert b.spent_outside().total == pytest.approx(0.9)
    assert a.spent_daily().total == pytest.approx(1.9) == b.spent_daily().total
    a.record("outside:shared", "Outside", {"paid": 0.1})
    b.record("outside:shared", "Outside", {"paid": 0.1})
    saved = json.loads(path.read_text())
    assert saved[agent_spend._CHATS_DAILY_SEEDED] is True
    assert len(saved["sessions"][agent_spend.CHATS_DAILY]["events"]) == 1      # seeded once, not per backend
    assert sum(e[2] for e in saved["sessions"]["outside:shared"]["events"]) == pytest.approx(1.1)


# -- two real processes racing reserve ------------------------------------------------------

_RACER = textwrap.dedent("""
    import sys
    sys.path.insert(0, sys.argv[1])
    from services import agent_spend
    from pathlib import Path

    ledger = agent_spend.SpendLedger(Path(sys.argv[2]))
    go = Path(sys.argv[3])
    while not go.exists():
        pass
    passed = busy = 0
    for _ in range(int(sys.argv[4])):
        def check():
            used = ledger.spent_daily().total
            refusal = "over" if used + 0.25 > 5.0 + 1e-9 else None
            return agent_spend.Decision(refusal, {"paid": 0.25})
        try:
            decision, _at = ledger.reserve("outside:shared", "Racer", check)
        except agent_spend.LedgerBusy:
            busy += 1
            continue
        passed += decision.refusal is None
    print(passed, busy)
""")


def test_two_processes_racing_reserve_never_pass_more_than_the_limit(tmp_path):
    path, go = tmp_path / "agent-spend.json", tmp_path / "go"
    script = tmp_path / "racer.py"
    script.write_text(_RACER)
    racers = [subprocess.Popen([sys.executable, str(script), str(BACKEND), str(path), str(go), "30"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
    go.touch()
    results = []
    for racer in racers:
        out, err = racer.communicate(timeout=60)
        assert racer.returncode == 0, err
        results.append(tuple(int(n) for n in out.split()))
    passed = sum(p for p, _ in results)
    busy = sum(b for _, b in results)
    events = json.loads(path.read_text())["sessions"]["outside:shared"]["events"]
    # Every pass is counted once in the file, and together they never pass the $5.
    assert len(events) == passed
    assert sum(event[2] for event in events) == pytest.approx(0.25 * passed)
    assert 0.25 * passed <= 5.0 + 1e-9
    if busy == 0:
        assert passed == 20


# -- a lock held past the wait ----------------------------------------------------------------

_HOLDER = textwrap.dedent("""
    import fcntl, os, sys, time
    fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    print("held", flush=True)
    sys.stdin.read()
""")


@pytest.fixture
def held_lock(tmp_path):
    """Another process holding the ledger's lock until the test ends."""
    path = tmp_path / "agent-spend.json"
    holder = subprocess.Popen([sys.executable, "-c", _HOLDER, str(path.with_name(f".{path.name}.lock"))],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert holder.stdout.readline().strip() == "held"
    yield path
    holder.stdin.close()
    holder.wait(timeout=10)


def test_a_lock_held_past_the_wait_refuses_before_the_check(held_lock, monkeypatch):
    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 0.3)
    ledger = agent_spend.SpendLedger(held_lock)
    checked = []

    def check():
        checked.append(1)
        return agent_spend.Decision(None, {"paid": 0.1})
    with pytest.raises(agent_spend.LedgerBusy) as busy:
        ledger.reserve("outside:shared", "Agent", check)
    assert busy.value.why == "another Nebula on this computer is updating the spending record"
    assert checked == []
    with pytest.raises(agent_spend.LedgerBusy):
        ledger.record("outside:shared", "Agent", {"paid": 0.1})
    assert not held_lock.exists()  # nothing was counted


def test_a_run_route_answers_503_when_the_lock_is_held(client, held_lock, monkeypatch):
    import main

    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 0.3)
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(held_lock))
    price(0.2)
    node_id = add_paid_node(client)
    caps = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 50, "models": {}}}
    assert client.put("/api/settings", json=caps, headers=PERSON).status_code == 200
    response = client.post("/api/graph/run", json={"targetNodeId": node_id})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail.startswith("Can't check this run's cost (another Nebula on this computer is updating the "
                             "spending record). Try again in a moment. Propose it instead:")
    assert not held_lock.exists()
    # The person's own runs never touch the ledger.
    assert client.post("/api/graph/run", json={"targetNodeId": node_id}, headers=PERSON).status_code == 200


# -- an unreadable file -------------------------------------------------------------------------

@pytest.mark.parametrize("content", ["{not json", "[]", '{"sessions": 3}', ""])
def test_an_unreadable_ledger_is_kept_aside_and_the_day_is_at_its_limits(tmp_path, content):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text(content)
    ledger = agent_spend.SpendLedger(path, clock=clock)
    assert ledger.spent_daily().full and ledger.spent("chat:a").full and ledger.spent_outside().full
    kept = [p for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-")]
    assert len(kept) == 1 and kept[0].read_text() == content
    assert re.fullmatch(r"agent-spend\.unreadable-\d{8}T\d{6}Z\.json", kept[0].name)
    assert ledger.unreadable_kept_as() == kept[0].name
    saved = json.loads(path.read_text())
    assert saved["unreadable"]["keptAs"] == kept[0].name

    # The daily total: a paid run waits for the person, saying why.
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None}}
    waiting, at = _run(ledger, "outside:shared", 0.01, settings)
    assert waiting.wait is not None and at is None
    assert agent_spend.LEDGER_UNREADABLE in waiting.wait.agent_line("p_1")
    assert waiting.wait.bar_line().endswith(agent_spend.LEDGER_UNREADABLE)
    # With no daily total, the finer limits refuse as at any limit.
    for key, caps in (("chat:a", {"sessionUsd": 5, "dailyTotalUsd": None}),
                      ("outside:shared", {"sessionUsd": None, "outsideDailyUsd": 5, "dailyTotalUsd": None})):
        refused = _run(ledger, key, 0.01, {"runCostConfirmUsd": None, "agentSpend": caps})[0]
        assert refused.refusal and refused.refusal.endswith(f"{agent_spend.LEDGER_UNREADABLE} ASK.")
    # Another backend reads the same: at the limits.
    assert agent_spend.SpendLedger(path, clock=clock).spent_daily().full
    # 24 hours later every run it held has aged out: back to what the file counts.
    clock.now += 24 * HOUR
    assert not ledger.spent_daily().full
    assert _run(ledger, "outside:shared", 0.01, settings)[0].refusal is None
    assert "unreadable" not in json.loads(path.read_text())
    assert [p for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-")] == kept


def test_plan_runs_count_as_used_up_too():
    spent = agent_spend.Spent(0.0, {}, 0, full=True)
    caps = agent_spend.caps_from_settings({"agentSpend": {"sessionUsd": None, "dailyTotalUsd": None}})
    [budget] = agent_spend.session_budgets("chat:a", spent, caps)
    assert budget.spent.plan_runs == agent_spend.DEFAULT_PLAN_RUNS


def test_a_second_unreadable_file_never_overwrites_the_first(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text("first")
    agent_spend.SpendLedger(path, clock=clock).spent_daily()
    path.write_text("second")
    agent_spend.SpendLedger(path, clock=clock).spent_daily()
    kept = sorted(p.read_text() for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-"))
    assert kept == ["first", "second"]


def test_the_unreadable_file_keeps_its_name_until_the_new_one_takes_it(tmp_path, monkeypatch):
    """No moment has a missing ledger (a missing one is a new install at $0):
    the kept name is a second name for the file, and the new file's rename
    replaces the first. A save that fails leaves the unreadable file where
    it was, refuses, and the next check keeps the one name it already has."""
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text("{not json")
    ledger = agent_spend.SpendLedger(path, clock=clock)
    saves = []

    def failing_save(sessions):
        saves.append(1)
        raise OSError("disk full")
    monkeypatch.setattr(ledger, "_save", failing_save)
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None}}
    with pytest.raises(agent_spend.LedgerBusy) as busy:
        _run(ledger, "outside:shared", 0.01, settings)
    assert busy.value.why == "the spending record can't be read or kept aside"
    assert saves and path.read_text() == "{not json"
    kept = [p for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-")]
    assert len(kept) == 1 and os.path.samefile(kept[0], path)
    # A read that only shows amounts is at the limits too, never $0.
    assert ledger.spent_daily().full
    monkeypatch.undo()
    clock.now += 5  # a later second: a new name would differ
    waiting, at = _run(ledger, "outside:shared", 0.01, settings)
    assert waiting.wait is not None and at is None
    assert [p for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-")] == kept
    assert kept[0].read_text() == "{not json"
    assert json.loads(path.read_text())["unreadable"]["keptAs"] == kept[0].name


def test_the_agents_spend_view_counts_as_a_run_is_checked(client, tmp_path, monkeypatch):
    """`nebula spend`, `nebula context` and get_spend_limits read this view:
    while an unreadable ledger holds the limits it shows the daily total used
    up and says why, never "$5 left" beside a run that waits."""
    import main
    from cli.formatter import daily_total_line
    from services import agent_start

    path = tmp_path / "agent-spend.json"
    path.write_text("{not json")
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(path))
    view = client.get("/api/agent/spend").json()
    assert view["limited"] is True
    assert view["ledgerNote"] == agent_spend.LEDGER_UNREADABLE
    assert view["dailyTotal"]["usedUsd"] == view["dailyTotal"]["limitUsd"] == 5
    assert view["dailyTotal"]["leftUsd"] == 0
    assert daily_total_line(view["dailyTotal"]).endswith("$5, $5.00 used, $0.00 left")
    assert agent_start.spend_part(view)["ledgerNote"] == agent_spend.LEDGER_UNREADABLE
    # A readable ledger has no note and counts what was spent.
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(tmp_path / "other.json"))
    view = client.get("/api/agent/spend").json()
    assert "ledgerNote" not in view and view["dailyTotal"]["leftUsd"] == 5
    assert "ledgerNote" not in agent_start.spend_part(view)


def test_a_missing_ledger_is_a_new_install_at_zero(tmp_path):
    path = tmp_path / "agent-spend.json"
    ledger = agent_spend.SpendLedger(path)
    assert ledger.spent_daily() == agent_spend.Spent()
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None}}
    assert _run(ledger, "outside:shared", 0.5, settings)[0].refusal is None
    assert not [p for p in tmp_path.iterdir() if "unreadable" in p.name]


# -- a run whose backend died ---------------------------------------------------------------------

_DIES = textwrap.dedent("""
    import os, sys
    sys.path.insert(0, sys.argv[1])
    from pathlib import Path
    from services import agent_spend

    ledger = agent_spend.SpendLedger(Path(sys.argv[2]), clock=lambda: float(sys.argv[3]))
    ledger.reserve("outside:shared", "Agent", lambda: agent_spend.Decision(None, {"paid": 0.7}))
    os._exit(9)  # dies mid-run: its give-back plan (main._SpendHold) is gone with it
""")


def test_a_run_whose_backend_died_stays_counted_until_it_ages_out(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    died = subprocess.run([sys.executable, "-c", _DIES, str(BACKEND), str(path), repr(clock.now)], timeout=60)
    assert died.returncode == 9
    other = agent_spend.SpendLedger(path, clock=clock)
    assert other.spent_outside().total == pytest.approx(0.7)
    assert other.spent_daily().total == pytest.approx(0.7)
    clock.now += 24 * HOUR - 1
    assert other.spent_daily().total == pytest.approx(0.7)
    clock.now += 1
    assert other.spent_daily().total == 0


# -- the limit both sides share ---------------------------------------------------------------------

def test_the_frontends_daily_total_maximum_is_the_backends():
    source = (BACKEND.parent / "frontend" / "src" / "lib" / "spendLimits.ts").read_text()
    match = re.search(r"export const MAX_DAILY_TOTAL_USD = ([\d_]+);", source)
    assert match and float(match.group(1).replace("_", "")) == agent_spend.MAX_DAILY_TOTAL_USD
