"""Round 5d of #225: one message, delivered once.

A message's row has three states after its listener goes away: lapsed
(waiting: the same agent and session may come back inside the window),
dropped (final: the window ended, the listener ended or stopped, it was
evicted for room, or its token was revoked) and, between them, the order of
the sweep's drop and a comeback beat's revive."""
from __future__ import annotations

import asyncio

from services import channel_listeners, person_thread
from tests.conftest import PERSON
from tests.test_canvas_proposals import api  # noqa: F401 - fixture
from tests.test_person_thread import SESSION_A, _listen, _send, thread  # noqa: F401

WINDOW = channel_listeners.LAPSE_WINDOW_SECONDS


def test_the_lapse_window_is_the_sends_span_cap():
    """Round 5e: a lapse is a stopped process (beats go on while Claude works),
    so the window is the send's 10 minutes, not the ledger's 24 hours."""
    from mcp_channel import DELIBERATE_SPAN_CAP
    from services import push_ledger
    assert channel_listeners.LAPSE_WINDOW_SECONDS == DELIBERATE_SPAN_CAP == push_ledger.DELIBERATE_SPAN_CAP == 600.0
    assert channel_listeners.LAPSE_WINDOW_SECONDS < push_ledger.KEEP_SECONDS


def _row(thread, message_id):
    for project_id in thread.main.project_store.read()["projects"]:
        for row in thread.main.thread_book.rows(project_id)[1]:
            if row["id"] == message_id:
                return row
    raise AssertionError(message_id)


def _inbox(thread, headers):
    return [m["messageId"] for m in thread.client.get("/api/agent/thread/inbox", headers=headers).json()["messages"]]


def _sweep(thread):
    asyncio.run(thread.main._sweep_channel_listeners())


def _lapse(thread):
    thread.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    _sweep(thread)


def _end_window(thread):
    thread.channel_clock.now += WINDOW + 1
    _sweep(thread)


def _is_lapsed(thread, message_id):
    row = _row(thread, message_id)
    return row["state"] == "sent" and row.get("lapsed") is True


def _is_dropped(thread, message_id):
    row = _row(thread, message_id)
    return row["state"] == person_thread.DROPPED_STATE and "lapsed" not in row


# -- the probe's double deliveries ---------------------------------------------------------------

def test_same_session_lapse_reads_lapsed_then_delivers_exactly_once(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "render four takes").json()["row"]["id"]
    _lapse(thread)
    assert _is_lapsed(thread, first)  # the box words this as lapsed, with no "send it again"
    _listen(thread, SESSION_A)
    assert "lapsed" not in _row(thread, first) and _row(thread, first)["state"] == "sent"
    assert _inbox(thread, SESSION_A) == [first]


def test_two_sessions_a_row_lapsed_in_a_then_dropped_for_good_and_a_gets_nothing_later(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "render four takes").json()["row"]["id"]
    _lapse(thread)
    assert _is_lapsed(thread, first)
    b_headers = {**SESSION_A, "X-Nebula-Agent-Session": "sess-new"}
    b = _listen(thread, b_headers)
    second = _send(thread, b, "render four takes").json()["row"]["id"]
    _end_window(thread)
    assert _is_dropped(thread, first)
    _listen(thread, SESSION_A)  # the old terminal wakes from sleep, too late
    assert _is_dropped(thread, first)  # it never revives
    assert _inbox(thread, SESSION_A) == []
    assert _inbox(thread, b_headers) == [second]


# -- a revive is for a lapsed row of its own route only ---------------------------------------------

def test_revive_refuses_a_dropped_row(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    thread.client.delete("/api/agent/channel", headers=SESSION_A)  # ended on purpose: final
    assert _is_dropped(thread, first)
    assert thread.main.thread_book.revive_route("app:claude1", "sess-a") == []
    _listen(thread, SESSION_A)
    assert _is_dropped(thread, first) and _inbox(thread, SESSION_A) == []


def test_revive_refuses_another_session_and_another_agent(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    _lapse(thread)
    assert thread.main.thread_book.revive_route("app:claude1", "sess-other") == []
    assert thread.main.thread_book.revive_route("app:codex1", "sess-a") == []
    assert _is_lapsed(thread, first)
    assert thread.main.thread_book.revive_route("app:claude1", "sess-a") != []
    assert not _is_lapsed(thread, first)


def test_a_revoke_drops_a_lapsed_row_clears_its_flag_and_nothing_revives_it(thread, monkeypatch):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    _lapse(thread)
    assert _is_lapsed(thread, first)
    from services import app_tokens
    monkeypatch.setattr(app_tokens, "valid_id", lambda app_id: app_id.isalnum())
    monkeypatch.setattr(thread.main.app_token_store, "revoke", lambda app_id: app_id == "claude1")
    assert thread.client.delete("/api/agent/spend/apps/claude1", headers=PERSON).status_code == 200
    assert _is_dropped(thread, first)  # dropped, and the server-only flag cleared
    assert thread.main.thread_book.revive_route("app:claude1", "sess-a") == []
    _end_window(thread)
    assert _is_dropped(thread, first)


# -- the race -------------------------------------------------------------------------------------------

def test_a_comeback_inside_the_window_beats_a_later_sweep(thread):
    """The revive before the drop: the row is back, and the sweep that would
    have ended the window later finds nothing to drop."""
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    _lapse(thread)
    thread.channel_clock.now += WINDOW - 100
    _listen(thread, SESSION_A)  # back inside the window
    assert not _is_lapsed(thread, first)
    for _ in range(10):  # it keeps beating past the old window's end
        thread.channel_clock.now += 15
        _listen(thread, SESSION_A)
    _sweep(thread)
    assert _row(thread, first)["state"] == "sent" and "lapsed" not in _row(thread, first)
    assert _inbox(thread, SESSION_A) == [first]


def test_the_window_ending_before_a_comeback_drops_the_row_and_the_comeback_does_not_revive_it(thread):
    """The drop before the revive."""
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    _lapse(thread)
    thread.channel_clock.now += WINDOW + 1
    thread.main.channel_book.sweep()  # the window's end is taken, nobody settled it yet
    _listen(thread, SESSION_A)  # the beat settles it first, then revives what is still lapsed
    assert _is_dropped(thread, first)
    assert _inbox(thread, SESSION_A) == []


def test_a_comeback_before_the_lapse_was_marked_never_marks_it(thread):
    """The sweep took the expiry; the comeback beat lands before the box's
    rows were marked: nothing lapses, and the row is never dropped."""
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    thread.channel_clock.now += channel_listeners.TTL_SECONDS + 1
    thread.main.channel_book.sweep()  # expired in the book, the row not yet marked
    _listen(thread, SESSION_A)
    _sweep(thread)
    assert _row(thread, first)["state"] == "sent" and "lapsed" not in _row(thread, first)
    assert _inbox(thread, SESSION_A) == [first]


def test_settling_waits_for_a_beat_that_holds_the_lock(thread):
    """A drop and a revive never interleave: settling takes the same lock."""
    a = _listen(thread, SESSION_A)
    _send(thread, a, "hello")
    _lapse(thread)
    thread.channel_clock.now += WINDOW + 1
    thread.main.channel_book.sweep()  # a final item waits to be settled

    async def run():
        async with thread.main._listener_settle_lock:
            task = asyncio.ensure_future(thread.main._settle_gone_listeners())
            await asyncio.sleep(0.05)
            waiting = not task.done() and bool(thread.main.channel_book._gone)
        await task
        return waiting

    lock = thread.main._listener_settle_lock
    thread.main._listener_settle_lock = asyncio.Lock()
    try:
        assert asyncio.run(run()) is True
    finally:
        thread.main._listener_settle_lock = lock


# -- evicted listeners are gone for good ------------------------------------------------------------------

def test_an_evicted_listeners_row_is_dropped_for_good(thread):
    a = _listen(thread, SESSION_A)
    first = _send(thread, a, "hello").json()["row"]["id"]
    for n in range(channel_listeners.MAX_PER_AGENT):
        thread.channel_clock.now += 1
        _listen(thread, {**SESSION_A, "X-Nebula-Agent-Session": f"other-{n}"})  # the 9th session pushes sess-a out
    assert _is_dropped(thread, first)
    _listen(thread, SESSION_A)
    assert _is_dropped(thread, first) and _inbox(thread, SESSION_A) == []


def test_an_evicted_listener_is_listed_gone():
    from tests.test_canvas_proposals import Clock
    from services.agent_presence import AgentIdentity
    clock = Clock()
    book = channel_listeners.ListenerBook(clock)
    agent = AgentIdentity("app:claude1", "Claude Code", "#000000", True)
    for n in range(channel_listeners.MAX_PER_AGENT + 1):
        clock.now += 1
        book.beat(agent, f"s{n}", state="listening", reason=None, project_id=None)
    assert [g[1] for g in book.take_gone()] == ["s0"]
    assert book.take_lapsed() == []
