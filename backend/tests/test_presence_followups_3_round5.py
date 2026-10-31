"""PR #204 round 5 (review 3 and its security review).

- LOW-2: an ask an undo reopens onto a newer ask's live Update gets its expiry timer, so it
  closes when it is due even though its first timer fired while it was closed.
- NIT-1 / security NIT-3: the tab claim's edges (a blank or whitespace claim, ``?tab=0``,
  ``?tab=``, ``?tab=true``, the header on a socket, a claim with ``X-Nebula-Client`` or a
  bogus agent token), the board list's filter, and ``for_reader`` leaving its input as it was.
- Security NIT-1: an Updates message goes through its reader's form whichever form a
  broadcast hands a socket (``others=``, ``broadcast_others``)."""
from __future__ import annotations

import asyncio
import copy
import json

from tests.conftest import FORGED_ORIGIN, PERSON
from tests.test_canvas_proposals import CODEX
from tests.test_presence_followups_3_round3 import _ms, _proposal_notes, _second_cover, _two_asks
from tests.test_undo_restores_deletes import (  # noqa: F401 - api and canvas are fixtures
    CLAUDE,
    _cover_setup,
    _delete,
    _restore,
    _whole,
    api,
    canvas,
)

SHARE = ("asks", "firstSince")


def _hides(ref: dict) -> bool:
    return not any(key in ref for key in SHARE)


def _ref(notes: list[dict]) -> dict:
    (note,) = [n for n in notes if n.get("about") == "proposal" and not n.get("resolvedAt")]
    return note["proposal"]


def _http(canvas, headers) -> tuple[int, dict | None]:
    response = canvas.client.get("/api/canvas/agent-notes", headers=headers)
    return response.status_code, (_ref(response.json()["notes"]) if response.status_code == 200 else None)


def _fire(canvas, timer) -> None:
    """Run a recorded timer on a loop of its own, as the backend's loop would."""
    _, fn, args = timer

    async def run():
        fn(*args)
        await asyncio.gather(*list(canvas.main._asset_expiry_tasks))

    asyncio.run(run())


def test_a_reopened_ask_that_joined_a_live_update_expires_on_time(canvas, monkeypatch):
    """Review 3 LOW-2: p1 closes, Claude Code asks again (p2, whose Update replaces p1's), the
    undo reopens p1 onto p2's Update. p1 gets a timer for its new expiry; when it fires p1
    expires and the Update counts p2 alone."""
    book, c, p1 = _cover_setup(canvas, monkeypatch)
    item = _whole(canvas, c)
    removal = _delete(canvas, c)["removal"]
    _d, p2 = _second_cover(canvas)
    book.get(p2).created_at = book.get(p1).created_at + 7
    book.get(p2).expires_at = book.get(p2).created_at + 10_000  # p2 outlives the check below
    canvas.timers.clear()
    assert _restore(canvas, [item], [removal]).json()["reopened"] == [p1]
    assert book.get(p1).update == book.get(p2).update  # it joined the live Update
    mine = [t for t in canvas.timers if t[1] is canvas.main._start_asset_expiry_check and t[2] == (p1,)]
    assert len(mine) == 1, canvas.timers
    delay = mine[0][0]
    assert abs(delay - (book.get(p1).expires_at - canvas.main.asset_proposals.now() + 0.5)) < 0.01
    canvas.clock.now = book.get(p1).expires_at + 1
    _fire(canvas, mine[0])
    assert book.get(p1).status == "expired"
    (note,) = _proposal_notes(canvas)
    assert not note.get("resolvedAt") and note["proposal"]["id"] == p2
    assert (note["proposal"]["asks"], note["proposal"]["firstSince"]) == (1, _ms(book, p2))


def test_a_blank_or_whitespace_claim_is_no_claim(canvas, monkeypatch):
    _two_asks(canvas, monkeypatch)
    for blank in ("", "   ", "\t"):
        status, ref = _http(canvas, {**FORGED_ORIGIN, "X-Nebula-Tab": blank})
        assert status == 200 and _hides(ref), repr(blank)
    assert _http(canvas, {**FORGED_ORIGIN, "X-Nebula-Tab": "tab-1"})[1]["asks"] == 2


def test_a_claim_with_any_marker_is_that_reader_not_a_tab(canvas, monkeypatch):
    """Security NIT-3: X-Nebula-Client is a marker; a bogus agent token is refused before the
    route reads anything."""
    _two_asks(canvas, monkeypatch)
    status, ref = _http(canvas, {**FORGED_ORIGIN, "X-Nebula-Tab": "tab-1", "X-Nebula-Client": "nebula-cli"})
    assert status == 200 and _hides(ref)
    status, _ref_ = _http(canvas, {"X-Nebula-Tab": "tab-1", "Authorization": "Agent bogus"})
    assert status == 401


def _socket_ref(canvas, path: str, headers: dict) -> dict:
    with canvas.client.websocket_connect(path, headers=headers) as ws:
        for _ in range(6):
            message = ws.receive_json()
            if message.get("type") == "agentNotes" and message.get("op") == "sync":
                return _ref(message["notes"])
    raise AssertionError("no Updates sync on connect")


def test_only_tab_1_on_a_socket_is_a_claim(canvas, monkeypatch):
    """?tab=0, ?tab=, ?tab=true and the header on a socket are not claims; ?tab=1 is."""
    _two_asks(canvas, monkeypatch)
    for path, headers in (("/ws?tab=0", FORGED_ORIGIN), ("/ws?tab=", FORGED_ORIGIN), ("/ws?tab=true", FORGED_ORIGIN),
                          ("/ws", {**FORGED_ORIGIN, "X-Nebula-Tab": "tab-1"})):
        assert _hides(_socket_ref(canvas, path, headers)), path
    assert _socket_ref(canvas, "/ws?tab=1", FORGED_ORIGIN)["asks"] == 2


def test_the_board_list_follows_the_same_rule(canvas, monkeypatch):
    """Review 3 NIT-1: the one reader route without a test. A board-level shared Update (none
    posts there today) would reach only the person's tabs and its author with its counts."""
    main = canvas.main
    note = {"id": "an_b", "about": "proposal", "author": {"kind": "agent", "id": "ext:claude-code", "name": "Claude Code"},
            "proposal": {"id": "pa_b", "kind": "moodboard", "targetId": "b1", "asks": 2, "firstSince": 5}}
    monkeypatch.setattr(main, "_live_board_for_notes", lambda board_id: {"id": board_id})
    monkeypatch.setattr(main.agent_notes, "board_list", lambda board, unread_only=False: {"notes": [copy.deepcopy(note)], "unread": 1})

    def ref(headers):
        response = canvas.client.get("/api/moodboards/b1/agent-notes", headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["notes"][0]["proposal"]

    assert ref(PERSON)["asks"] == 2
    assert ref({**FORGED_ORIGIN, "X-Nebula-Tab": "tab-1"})["asks"] == 2
    assert ref(CLAUDE)["asks"] == 2
    assert _hides(ref(CODEX)) and _hides(ref({}))


def test_for_reader_leaves_its_input_as_it_was():
    from services.agent_notes import for_reader

    note = {"id": "an_1", "about": "proposal", "author": {"kind": "agent", "id": "ext:a"},
            "proposal": {"id": "pa_1", "asks": 2, "firstSince": 5}}
    for payload in ({"notes": [note]}, {"type": "agentNotes", "op": "changed", "note": note}, note):
        before = copy.deepcopy(payload)
        out = for_reader(payload, sees_share=False, agent_id="ext:b")
        assert payload == before
        assert out is not payload


class _Socket:
    def __init__(self) -> None:
        self.got: list[dict] = []

    async def send_text(self, text: str) -> None:
        self.got.append(json.loads(text))


def test_an_updates_message_is_filtered_in_every_broadcast_form():
    """Security NIT-1: a broadcast that hands other sockets a separate form, or one to the
    non-person sockets only, still gives each socket its reader's form of an Updates message."""
    import main

    manager = main.ConnectionManager()
    person, bare, author = _Socket(), _Socket(), _Socket()
    manager.active_connections.extend([person, bare, author])
    manager.browser_connections.add(person)
    manager.share_views[author] = {"sees_share": False, "agent_id": "ext:claude-code"}
    note = {"id": "an_1", "about": "proposal",
            "author": {"kind": "agent", "id": "ext:claude-code", "name": "Claude Code", "color": "#E8825A"},
            "proposal": {"id": "pa_1", "kind": "project", "targetId": "p", "asks": 2, "firstSince": 5}}
    message = {"type": "agentNotes", "surface": "canvas", "op": "changed", "note": note}
    asyncio.run(manager.broadcast_raw(message, others=copy.deepcopy(message)))
    assert person.got[-1]["note"]["proposal"]["asks"] == 2
    assert author.got[-1]["note"]["proposal"]["asks"] == 2
    assert _hides(bare.got[-1]["note"]["proposal"])
    asyncio.run(manager.broadcast_others(message))
    assert _hides(bare.got[-1]["note"]["proposal"])
    assert author.got[-1]["note"]["proposal"]["asks"] == 2
    assert len(person.got) == 1  # broadcast_others never reaches the person's canvas
    # The pins' person form still goes as it did.
    asyncio.run(manager.broadcast_raw({"type": "pins", "full": True}, others={"type": "pins", "full": False}))
    assert (person.got[-1]["full"], bare.got[-1]["full"], author.got[-1]["full"]) == (True, False, False)
