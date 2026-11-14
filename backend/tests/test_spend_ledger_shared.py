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
import select
import subprocess
import sys
import textwrap
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_spend  # noqa: E402
from tests.test_agent_spend import add_paid_node, client, price  # noqa: E402,F401 - client is a fixture
from tests.test_daily_total import api  # noqa: E402,F401 - a fixture
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
    # A holder that never starts fails the test rather than hang it.
    ready, _, _ = select.select([holder.stdout], [], [], 30)
    if not ready:
        holder.kill()
        holder.wait(timeout=10)
        pytest.fail("the lock holder didn't start within 30 seconds")
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
    assert detail.startswith("Nebula couldn\u2019t check this run\u2019s cost because another Nebula on this computer "
                             "is updating the spending record. Try again in a moment. Propose it instead:")
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
    until = clock.now + 24 * HOUR
    sentence = agent_spend.ledger_unreadable(until)
    assert sentence in waiting.wait.agent_line("p_1")
    # The stored lines leave it out: the proposal carries the hold's end instead.
    assert "couldn\u2019t read" not in waiting.wait.bar_line()
    assert waiting.wait.as_dict()["ledgerHold"] == {"until": until, "line": sentence}
    # With no daily total, the finer limits refuse as at any limit.
    for key, caps in (("chat:a", {"sessionUsd": 5, "dailyTotalUsd": None}),
                      ("outside:shared", {"sessionUsd": None, "outsideDailyUsd": 5, "dailyTotalUsd": None})):
        refused = _run(ledger, key, 0.01, {"runCostConfirmUsd": None, "agentSpend": caps})[0]
        assert refused.refusal and refused.refusal.endswith(f"{sentence} ASK.")
    # Another backend reads the same: at the limits.
    assert agent_spend.SpendLedger(path, clock=clock).spent_daily().full
    # 24 hours later every run it held has aged out: back to what the file counts.
    clock.now += 24 * HOUR
    assert not ledger.spent_daily().full
    assert _run(ledger, "outside:shared", 0.01, settings)[0].refusal is None
    assert "unreadable" not in json.loads(path.read_text())
    assert [p for p in tmp_path.iterdir() if p.name.startswith("agent-spend.unreadable-")] == kept


def test_plan_runs_count_as_used_up_too():
    spent = agent_spend.Spent(0.0, {}, 0, until=1_760_000_000.0)
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
    assert busy.value.why == agent_spend.BUSY_READ == "it can\u2019t read the spending record or set it aside"
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
    clock = Clock(time.time())
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(path, clock=clock))
    view = client.get("/api/agent/spend").json()
    assert view["limited"] is True
    until = clock.now + 24 * HOUR
    assert view["ledgerNote"] == agent_spend.ledger_unreadable(until)
    assert view["ledgerHold"] == {"until": until}
    assert view["dailyTotal"]["usedUsd"] == view["dailyTotal"]["limitUsd"] == 5
    assert view["dailyTotal"]["leftUsd"] == 0
    assert daily_total_line(view["dailyTotal"]).endswith("$5, $5.00 used, $0.00 left")
    assert agent_start.spend_part(view)["ledgerNote"] == agent_spend.ledger_unreadable(until)
    assert agent_start.spend_part(view)["ledgerHold"] == {"until": until}
    # A readable ledger has no note and counts what was spent.
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(tmp_path / "other.json"))
    view = client.get("/api/agent/spend").json()
    assert "ledgerNote" not in view and "ledgerHold" not in view and view["dailyTotal"]["leftUsd"] == 5
    assert "ledgerNote" not in agent_start.spend_part(view) and "ledgerHold" not in agent_start.spend_part(view)


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

def test_the_apps_live_hold_sentence_starts_as_the_backends_does():
    """Settings draws the hold's sentence itself (its live form, "until 3:40
    PM" or "… tomorrow"); everything before the time must be the backend's
    words, so a stored line and Settings never say it two ways."""
    source = (BACKEND.parent / "frontend" / "src" / "lib" / "ledgerHold.ts").read_text()
    match = re.search(r"export const LEDGER_HOLD_SENTENCE = '([^']+)';", source)
    assert match
    from datetime import timezone
    written = agent_spend.ledger_unreadable(1_760_000_000.0, tz=timezone.utc)
    assert written.startswith(match.group(1) + " ")
    assert match.group(1).endswith(" until")


def test_the_frontends_daily_total_maximum_is_the_backends():
    source = (BACKEND.parent / "frontend" / "src" / "lib" / "spendLimits.ts").read_text()
    match = re.search(r"export const MAX_DAILY_TOTAL_USD = ([\d_]+);", source)
    assert match and float(match.group(1).replace("_", "")) == agent_spend.MAX_DAILY_TOTAL_USD


# -- review of PR #242: races, held locks, files that can't be read --------------------------------

def test_two_threads_sharing_one_ledger_never_pass_the_limit(tmp_path):
    """One backend's threads share one SpendLedger: reserve's check and count
    are one step for them too."""
    ledger = agent_spend.SpendLedger(tmp_path / "agent-spend.json")
    go = threading.Event()
    results: list[tuple[int, int]] = []

    def racer() -> None:
        go.wait()
        passed = busy = 0
        for _ in range(15):
            def check():
                used = ledger.spent_daily().total
                return agent_spend.Decision("over" if used + 0.25 > 5.0 + 1e-9 else None, {"paid": 0.25})
            try:
                decision, _at = ledger.reserve("outside:shared", "Racer", check)
            except agent_spend.LedgerBusy:
                busy += 1
                continue
            passed += decision.refusal is None
        results.append((passed, busy))
    threads = [threading.Thread(target=racer) for _ in range(4)]
    for thread in threads:
        thread.start()
    go.set()
    for thread in threads:
        thread.join(timeout=60)
    assert len(results) == 4
    passed = sum(p for p, _ in results)
    events = json.loads((tmp_path / "agent-spend.json").read_text())["sessions"]["outside:shared"]["events"]
    assert len(events) == passed and 0.25 * passed <= 5.0 + 1e-9
    if sum(b for _, b in results) == 0:
        assert passed == 20


def _write_ledger(path: Path, sessions: dict, **extra) -> bytes:
    path.write_text(json.dumps({"sessions": sessions, agent_spend._CHATS_DAILY_SEEDED: True, **extra}))
    return path.read_bytes()


def test_a_give_back_while_another_process_holds_the_lock_counts_the_run_still(held_lock, monkeypatch):
    """A refund that can't take the lock raises LedgerBusy and changes
    nothing: the run stays counted (over, never under)."""
    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 0.3)
    clock = Clock()
    before = _write_ledger(held_lock, {"outside:shared": {"agent": "Agent", "events": [[clock.now, "paid", 0.5, 0]]}})
    ledger = agent_spend.SpendLedger(held_lock, clock=clock)
    with pytest.raises(agent_spend.LedgerBusy) as busy:
        ledger.refund("outside:shared", {"paid": 0.5}, at=clock.now)
    assert busy.value.why == agent_spend.BUSY_OTHER
    assert held_lock.read_bytes() == before
    assert ledger.spent_outside().total == pytest.approx(0.5)


def test_a_display_read_while_the_lock_is_held_reads_the_file_without_waiting(held_lock, monkeypatch):
    """Settings and `nebula spend` read the file as it is: no wait on the
    other backend, the first-load steps applied to their own copy only, and
    the file left byte for byte as it was."""
    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 5.0)
    clock = Clock()
    # From before the daily total (not seeded) with a legacy key: the first
    # read would migrate and save it under the lock.
    held_lock.write_text(json.dumps({"sessions": {
        "unverified:aaa": {"agent": "x", "total": 0.9, "models": {"paid": 0.9}, "updated": clock.now - HOUR},
        "chat:c1": {"agent": "Claude", "total": 1, "models": {"paid": 1}, "updated": clock.now - HOUR},
    }}))
    before = held_lock.read_bytes()
    ledger = agent_spend.SpendLedger(held_lock, clock=clock)
    started = time.monotonic()
    daily, outside = ledger.spent_daily(), ledger.spent_outside()
    assert time.monotonic() - started < 2.0
    assert daily.total == pytest.approx(1.9) and outside.total == pytest.approx(0.9) and not daily.full
    assert ledger.spent("chat:c1").total == pytest.approx(1.0)
    assert held_lock.read_bytes() == before


def test_the_model_session_limit_and_an_apps_daily_limit_hold_during_the_hold(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    path.write_text("{not json")
    ledger = agent_spend.SpendLedger(path, clock=clock)
    sentence = agent_spend.ledger_unreadable(clock.now + 24 * HOUR)
    # A model's own session limit, with no other limit on.
    settings = {"runCostConfirmUsd": None,
                "agentSpend": {"sessionUsd": None, "dailyTotalUsd": None, "models": {"paid": {"sessionUsd": 5}}}}
    refused = _run(ledger, "chat:s1", 0.01, settings)[0]
    assert refused.refusal and "Paid Model budget" in refused.refusal and refused.refusal.endswith(f"{sentence} ASK.")
    # An app's own daily limit, with the outside budget and the daily total off.
    caps = agent_spend.caps_from_settings(
        {"agentSpend": {"sessionUsd": None, "outsideDailyUsd": None, "dailyTotalUsd": None}})
    key = "outside:app:x"
    budgets = agent_spend.session_budgets(key, ledger.spent(key), caps, outside_spent=ledger.spent_outside(),
                                          app_name="Zapier", app_daily_usd=5, daily_spent=ledger.spent_daily())
    decision = agent_spend.decide(
        [{"id": "n1", "definitionId": "paid", "params": {}}], [], settings={"runCostConfirmUsd": None},
        pricing={"nodes": {"paid": {"currency": "usd", "rows": [{"match": {}, "price": 0.01}]}}},
        definitions=DEFINITIONS, budgets=budgets, how_to_ask="ASK.")
    assert decision.refusal and "Zapier" in decision.refusal and "daily limit" in decision.refusal
    assert decision.refusal.endswith(f"{sentence} ASK.")


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a file with no permissions")
def test_a_file_that_cant_be_opened_is_never_replaced(tmp_path, monkeypatch):
    """A passing read error on a healthy ledger (here, no permission) is not
    an unreadable ledger: nothing is kept aside or replaced, the run is
    refused, a display read is at the limits, and once the file reads again
    every total it held is there, chat session totals included."""
    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 0.3)
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    healthy = agent_spend.SpendLedger(path, clock=clock)
    healthy.record("chat:c1", "Claude", {"paid": 9.5})
    before = path.read_bytes()
    path.chmod(0)
    try:
        ledger = agent_spend.SpendLedger(path, clock=clock)
        settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": 10, "dailyTotalUsd": None}}
        with pytest.raises(agent_spend.LedgerBusy) as busy:
            _run(ledger, "chat:c1", 0.01, settings)
        assert busy.value.why == agent_spend.BUSY_READ
        assert ledger.spent("chat:c1").full and ledger.spent_daily().full
        # Not the 24-hour hold: there is no end to name, so no line names one.
        assert ledger.cant_read() and ledger.hold_until() is None
        with pytest.raises(agent_spend.LedgerBusy):
            ledger.record("chat:c1", "Claude", {"paid": 0.1})
    finally:
        path.chmod(0o600)
    assert path.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir() if not p.name.startswith(".")) == ["agent-spend.json"]
    assert ledger.spent("chat:c1").total == pytest.approx(9.5) and not ledger.spent("chat:c1").full
    assert not ledger.cant_read()
    refused = _run(ledger, "chat:c1", 1.0, settings)[0]
    assert refused.refusal and "$9.50" in refused.refusal  # still counted against its $10


def test_the_views_say_a_record_that_cant_be_read_without_a_time(client, tmp_path, monkeypatch):
    """A ledger that can't be opened has no hold to end: Settings and the
    agents' view get ``ledgerBlocked`` and the can't-read sentence, never
    ``ledgerHold`` with a time that would move at every read. A waiting
    proposal stored during an earlier hold keeps the end it stored."""
    import main
    from services import agent_start

    path = tmp_path / "agent-spend.json"
    path.symlink_to(tmp_path / "gone.json")
    ledger = agent_spend.SpendLedger(path)
    monkeypatch.setattr(main, "agent_spend_ledger", ledger)
    assert ledger.cant_read() and ledger.hold_until() is None
    view = client.get("/api/agent/spend").json()
    assert view["ledgerBlocked"] is True and "ledgerHold" not in view
    assert view["ledgerNote"] == agent_spend.LEDGER_CANT_READ
    assert view["dailyTotal"]["leftUsd"] == 0
    part = agent_start.spend_part(view)
    assert part["ledgerBlocked"] is True and part["ledgerNote"] == agent_spend.LEDGER_CANT_READ
    apps = client.get("/api/agent/spend/apps", headers=PERSON).json()
    assert apps["ledgerBlocked"] is True and "ledgerHold" not in apps
    stored = {"barLine": "x", "ledgerHold": {"until": 123.0, "line": "kept"}}
    assert agent_spend.ledger_hold_now(stored, ledger.hold_until())["ledgerHold"] == {"until": 123.0, "line": "kept"}
    # The app holds the same words.
    source = (BACKEND.parent / "frontend" / "src" / "lib" / "ledgerHold.ts").read_text()
    assert f"export const LEDGER_CANT_READ = '{agent_spend.LEDGER_CANT_READ}';" in source
    # A readable ledger has neither.
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(tmp_path / "other.json"))
    assert "ledgerBlocked" not in client.get("/api/agent/spend").json()
    assert "ledgerBlocked" not in client.get("/api/agent/spend/apps", headers=PERSON).json()


def test_a_symlink_to_nothing_is_not_a_new_install(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_spend, "LOCK_WAIT_SECONDS", 0.3)
    path = tmp_path / "agent-spend.json"
    path.symlink_to(tmp_path / "gone.json")
    ledger = agent_spend.SpendLedger(path)
    settings = {"runCostConfirmUsd": None, "agentSpend": {"sessionUsd": None}}
    with pytest.raises(agent_spend.LedgerBusy) as busy:
        _run(ledger, "outside:shared", 0.01, settings)
    assert busy.value.why == agent_spend.BUSY_READ
    assert ledger.spent_daily().full
    assert path.is_symlink() and not (tmp_path / "gone.json").exists()


@pytest.mark.parametrize("mark", [{}, True, {"since": "2026-11-13T10:00:00Z"}, {"since": None, "keptAs": "x.json"}])
def test_a_malformed_mark_is_saved_once_so_its_hold_ends(tmp_path, mark):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    _write_ledger(path, {}, unreadable=mark)
    ledger = agent_spend.SpendLedger(path, clock=clock)
    assert ledger.spent_daily().until == clock.now + 24 * HOUR
    saved = json.loads(path.read_text())["unreadable"]
    assert saved["since"] == clock.now
    if isinstance(mark, dict) and mark.get("keptAs"):
        assert saved["keptAs"] == "x.json"
    clock.now += 23 * HOUR  # later reads don't restart it
    assert agent_spend.SpendLedger(path, clock=clock).spent_daily().until == clock.now + HOUR
    clock.now += HOUR
    assert not agent_spend.SpendLedger(path, clock=clock).spent_daily().full


def test_a_mark_from_the_future_starts_now(tmp_path):
    clock = Clock()
    path = tmp_path / "agent-spend.json"
    _write_ledger(path, {}, unreadable={"since": clock.now + 365 * 24 * HOUR, "keptAs": "k.json"})
    ledger = agent_spend.SpendLedger(path, clock=clock)
    assert ledger.spent_daily().until == clock.now + 24 * HOUR
    assert json.loads(path.read_text())["unreadable"] == {"since": clock.now, "keptAs": "k.json"}
    clock.now += 24 * HOUR
    assert not ledger.spent_daily().full


# -- the sentence's end time --------------------------------------------------------------------------

@pytest.mark.parametrize(("zone", "when", "expected"), [
    ("America/Los_Angeles", (2026, 11, 15, 15, 40), "3:40 PM on Sunday"),
    ("UTC", (2026, 11, 16, 12, 0), "12:00 PM on Monday"),         # noon
    ("UTC", (2026, 11, 17, 0, 0), "12:00 AM on Tuesday"),         # midnight
    ("Asia/Kolkata", (2026, 11, 18, 9, 5), "9:05 AM on Wednesday"),  # a single-digit hour, a half-hour zone
])
def test_the_sentence_names_the_holds_end_in_local_time(zone, when, expected):
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(zone)
    until = datetime(*when, tzinfo=tz).timestamp()
    assert agent_spend.ledger_unreadable(until, tz=tz) == (
        "Nebula couldn’t read its record of what agents have spent, so it counts every spending limit as "
        f"used up until {expected}.")


def test_the_sentence_uses_the_computers_zone_whatever_the_locale(monkeypatch):
    import locale

    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    try:
        try:
            locale.setlocale(locale.LC_TIME, "fr_FR.UTF-8")
        except locale.Error:
            pass
        until = datetime(2026, 11, 15, 20, 40, tzinfo=timezone.utc).timestamp()  # 3:40 PM in New York
        assert agent_spend.ledger_unreadable(until).endswith("until 3:40 PM on Sunday.")
    finally:
        locale.setlocale(locale.LC_TIME, "C")
        monkeypatch.delenv("TZ")
        time.tzset()


# -- a waiting proposal's hold ---------------------------------------------------------------------

def test_a_waiting_proposal_carries_the_hold_and_its_note_never_does(api, tmp_path, monkeypatch):
    """The note and barLine are stored, so they leave the sentence out; the
    wait details carry ``ledgerHold``, served with the hold's end now while
    one is on (a new hold, a new end) and as stored once it is over."""
    from cli.formatter import format_proposal, ledger_hold_note
    from tests.test_daily_total import CLAUDE, _node, price as daily_price

    clock = Clock(time.time())
    path = tmp_path / "agent-spend.json"
    path.write_text("{not json")
    monkeypatch.setattr(api.main, "agent_spend_ledger", agent_spend.SpendLedger(path, clock=clock))
    daily_price(0.5)
    writer = _node(api, "Writer")
    response = api.client.post("/api/graph/run", json={"targetNodeId": writer}, headers=CLAUDE)
    assert response.status_code == 202, response.text
    until = clock.now + 24 * HOUR
    sentence = agent_spend.ledger_unreadable(until)
    assert sentence in response.json()["message"]  # the one-time line keeps it inline
    proposal = api.main.canvas_proposals.get(response.json()["proposalId"])
    assert "couldn’t read" not in proposal.spec.note and "couldn’t read" not in proposal.wait["barLine"]
    assert "couldn’t read" not in proposal.wait["updateLine"]
    assert proposal.wait["ledgerHold"] == {"until": until, "line": sentence}
    view = api.client.get(f"/api/canvas/proposals/{proposal.id}", headers=CLAUDE).json()["proposal"]
    assert view["wait"]["ledgerHold"] == {"until": until, "line": sentence}
    assert api.main._proposal_brief(proposal)["ledgerHold"] == {"until": until, "line": sentence}
    assert format_proposal(view, now_ms=clock.now * 1000).splitlines()[0].endswith(f" {sentence}")
    # The hold is over: the stored end stays, and the CLI leaves the line out.
    clock.now = until + 60
    view = api.client.get(f"/api/canvas/proposals/{proposal.id}", headers=CLAUDE).json()["proposal"]
    assert view["wait"]["ledgerHold"]["until"] == until
    assert "couldn’t read" not in format_proposal(view, now_ms=clock.now * 1000)
    assert ledger_hold_note(view["wait"]["ledgerHold"], clock.now) == ""
    # The record is found unreadable again: a new hold, served with its new end.
    path.write_text("[]")
    again = clock.now + 24 * HOUR
    view = api.client.get(f"/api/canvas/proposals/{proposal.id}", headers=CLAUDE).json()["proposal"]
    assert view["wait"]["ledgerHold"] == {"until": again, "line": agent_spend.ledger_unreadable(again)}


def test_settings_view_carries_the_holds_end(client, tmp_path, monkeypatch):
    import main

    clock = Clock(time.time())
    path = tmp_path / "agent-spend.json"
    path.write_text("{not json")
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(path, clock=clock))
    view = client.get("/api/agent/spend/apps", headers=PERSON).json()
    assert view["ledgerHold"] == {"until": clock.now + 24 * HOUR}
    monkeypatch.setattr(main, "agent_spend_ledger", agent_spend.SpendLedger(tmp_path / "other.json"))
    assert "ledgerHold" not in client.get("/api/agent/spend/apps", headers=PERSON).json()


def test_the_pricing_refusal_gives_the_reason_then_the_raw_error():
    assert agent_spend.pricing_refusal(ValueError("Expecting value: line 1 column 1 (char 0)"), "ASK.") == (
        "Nebula couldn’t check this run’s cost because it can’t read the pricing table. Error: Expecting "
        "value: line 1 column 1 (char 0). ASK.")
    # A final period is added only when the error has none.
    assert agent_spend.pricing_refusal(ValueError("ends with a period."), "ASK.").endswith(
        "pricing table. Error: ends with a period. ASK.")
    assert agent_spend.pricing_refusal(OSError(2, "No such file or directory", "/x/model_pricing.json"), "ASK.") == (
        "Nebula couldn’t check this run’s cost because it can’t read the pricing table. Error: [Errno 2] No such "
        "file or directory: '/x/model_pricing.json'. ASK.")
    assert agent_spend.pricing_refusal(ValueError(""), "ASK.") == (
        "Nebula couldn’t check this run’s cost because it can’t read the pricing table. ASK.")
