"""Every asset proposal posts an Update (Justin's Q92 a, 2026-10-21).

"a) Keep the wording, and each proposal also posts an Update ("Claude Code
asks to change the cover of X", with Review)." A cover proposal shows on the
Projects screen and a Send notes proposal in Moodboard Studio; the Updates
corner (#124) is where an agent's asks land wherever the person works.

One Update per agent and target, posted the way Nebula posts its own
updates (services/agent_notes.py), attributed to the agent, on the open
project's list. Its Review action takes the person to where they decide. When
the proposal closes the Update says how, and is read. Nothing private: the
agent's note, the board's notes, private notes and Commons text stay out.
"""
from __future__ import annotations

import json

from tests.test_asset_proposals import A, B, C, CLAUDE, CODEX, KEY, _board, _events, _key, _pin, _propose, api  # noqa: F401


def _notes(api, project=None) -> list[dict]:
    catalog = api.store.read()
    return [note for note in catalog["projects"][project or api.active].get("agentNotes") or []]


def _proposal_notes(api, project=None) -> list[dict]:
    return [note for note in _notes(api, project) if note.get("about") == "proposal"]


def _note_messages(api, op=None) -> list[dict]:
    return [m for m in api.sent if m.get("type") == "agentNotes" and (op is None or m["op"] == op)]


def _review(note: dict) -> dict:
    (action,) = note["actions"]
    assert action["label"] == "Review"
    return action["op"]


# -- posting ------------------------------------------------------------------------

def test_a_cover_proposal_posts_one_update_with_review(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}, note="Use the dusk shot please").json()["proposal"]
    (note,) = _proposal_notes(api)
    assert note["text"] == "Claude Code asks to change the cover of Dusk"
    assert note["author"]["kind"] == "agent" and note["author"]["name"] == "Claude Code"
    assert note["source"] == "nebula"
    assert note["proposal"] == {"id": view["id"], "kind": "project", "targetId": api.dusk, "cover": "image"}
    assert _review(note) == {"kind": "proposal.review", "proposalId": view["id"], "target": "project",
                             "targetId": api.dusk}
    # The agent's own note is the strip's, not the Update's.
    assert "dusk shot" not in json.dumps(note)
    assert not note.get("readAt")

    added = _note_messages(api, "added")
    assert len(added) == 1
    assert added[0]["surface"] == "canvas" and added[0]["projectId"] == api.active
    assert added[0]["note"]["id"] == note["id"]
    assert added[0]["unread"] == 1
    posted = _events(api, "note.posted")
    assert len(posted) == 1 and posted[0]["actor"]["name"] == "Claude Code"

    # The agent reads it back with list_notes, and get_proposal names it.
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()
    assert [n["id"] for n in listed["notes"] if n["about"] == "proposal"] == [note["id"]]
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["update"] == {"id": note["id"], "projectId": api.active}


def test_a_send_notes_proposal_posts_an_update_without_the_boards_text(api):
    board = _board(api)
    secret = "PAINTERLY liked this a lot"
    put = api.client.put(f"/api/moodboards/{board['id']}", json={
        "notes": "board-wide dusk notes", "images": [{"id": board["images"][0]["id"], "url": board["images"][0]["url"], "notes": "image note here",
                                                      "privateNote": secret}]}, headers=api.person)
    assert put.status_code == 200, put.text
    view = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"]).json()["proposal"]
    (note,) = _proposal_notes(api)
    assert note["text"] == "Claude Code asks to send Dusk board's notes to generators"
    assert _review(note) == {"kind": "proposal.review", "proposalId": view["id"], "target": "moodboard",
                             "targetId": board["id"]}
    text = json.dumps(note)
    for private in (secret, "board-wide dusk notes", "image note here"):
        assert private not in text


def test_a_re_proposal_replaces_the_update_instead_of_stacking(api):
    _pin(api, A, api.person)
    first = _propose(api, {"cover": C}).json()["proposal"]
    first_note = _proposal_notes(api)[0]
    second = _propose(api, {"cover": B}).json()["proposal"]
    (note,) = _proposal_notes(api)
    assert note["id"] != first_note["id"]
    assert note["proposal"]["id"] == second["id"]
    assert _note_messages(api, "added")[-1]["removed"] == [first_note["id"]]
    # Another agent asking about the same project gets its own.
    _propose(api, {"cover": None}, headers=CODEX)
    assert sorted(n["author"]["name"] for n in _proposal_notes(api)) == ["Claude Code", "Codex"]

    # While one of Claude's proposals is still open, its Update still asks.
    taken = api.client.delete(f"/api/canvas/proposals/{second['id']}", headers=CLAUDE)
    assert taken.status_code == 200
    mine = next(n for n in _proposal_notes(api) if n["author"]["name"] == "Claude Code")
    assert not mine.get("resolvedAt")
    assert mine["proposal"]["id"] == first["id"]
    assert _review(mine)["proposalId"] == first["id"]
    api.client.delete(f"/api/canvas/proposals/{first['id']}", headers=CLAUDE)
    mine = next(n for n in _proposal_notes(api) if n["author"]["name"] == "Claude Code")
    assert mine["resolvedAt"] and mine["outcome"] == "Withdrawn by Claude Code"


def test_no_open_project_means_no_update_but_the_proposal_opens(api):
    catalog = api.store.read()
    catalog["activeProjectId"] = None
    api.store.commit(catalog)
    _pin(api, A, api.person)
    made = _propose(api, {"cover": C})
    assert made.status_code == 201, made.text
    assert made.json()["proposal"]["update"] is None
    assert not _note_messages(api, "added")


# -- the Update follows the proposal ---------------------------------------------------

def _resolved(api) -> dict:
    (note,) = _proposal_notes(api)
    return note


def test_accepting_resolves_the_update(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    accepted = api.client.post(f"/api/asset-proposals/{view['id']}/accept",
                               headers={**api.person, KEY: _key(api, view["id"])})
    assert accepted.status_code == 200, accepted.text
    note = _resolved(api)
    assert note["outcome"] == "Accepted: the cover changed"
    assert note["resolvedAt"] and note["readAt"]
    assert note["resolvedBy"] == {"kind": "person"}
    resolved = _note_messages(api, "resolved")
    assert len(resolved) == 1
    assert resolved[-1]["note"]["id"] == note["id"] and resolved[-1]["unread"] == 0
    # The agent reads the outcome in list_notes.
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    assert next(n for n in listed if n["id"] == note["id"])["outcome"] == "Accepted: the cover changed"


def test_rejecting_resolves_the_update_without_the_persons_reason(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.client.post(f"/api/asset-proposals/{view['id']}/reject", json={"reason": "Keep the wide shot"},
                    headers={**api.person, KEY: _key(api, view["id"])})
    note = _resolved(api)
    assert note["outcome"] == "You kept your cover"
    assert "wide shot" not in json.dumps(note)


def test_an_agent_cover_kept_says_this_cover(api):
    _pin(api, A, CODEX)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.client.post(f"/api/asset-proposals/{view['id']}/reject", headers={**api.person, KEY: _key(api, view["id"])})
    assert _resolved(api)["outcome"] == "You kept this cover"


def test_expiry_resolves_the_update(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.clock.now += 15 * 60 + 1
    api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE)
    note = _resolved(api)
    assert note["outcome"] == "Expired" and note["resolvedBy"] == {"kind": "system"}


def _timers(api, monkeypatch) -> list:
    """The backend's one-shot timers, recorded instead of waiting on the wall clock."""
    timers: list = []
    monkeypatch.setattr(api.main, "_call_later", lambda delay, fn, *args: timers.append((delay, fn, args)))
    return timers


def _fire(api, timer) -> None:
    """Run a recorded timer on a loop of its own, as the backend's loop would."""
    import asyncio

    _, fn, args = timer

    async def run():
        fn(*args)
        await asyncio.gather(*list(api.main._asset_expiry_tasks))

    asyncio.run(run())


def test_expiry_resolves_the_update_on_time_without_any_read(api, monkeypatch):
    """Review finding: nobody reads proposals (the agent stopped, the person
    stays on the canvas), so only a timer can close it when it's due. The
    corner gets the "resolved" message and loses its Review then."""
    timers = _timers(api, monkeypatch)
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    (timer,) = timers
    assert 15 * 60 <= timer[0] <= 15 * 60 + 2
    api.clock.now += 15 * 60 + 1
    api.sent.clear()
    _fire(api, timer)
    note = _resolved(api)
    assert note["outcome"] == "Expired" and note["resolvedBy"] == {"kind": "system"} and note["readAt"]
    (resolved,) = _note_messages(api, "resolved")
    assert resolved["note"]["id"] == note["id"] and resolved["unread"] == 0
    assert api.book.get(view["id"]).status == "expired"


def test_a_timer_that_fires_early_waits_for_the_new_expiry(api, monkeypatch):
    """An accept in progress pushes the expiry out; the timer then checks again later."""
    timers = _timers(api, monkeypatch)
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.book.get(view["id"]).expires_at = api.clock.now + 30 * 60
    api.clock.now += 15 * 60 + 1
    _fire(api, timers[0])
    assert api.book.get(view["id"]).is_open
    assert not _resolved(api).get("resolvedAt")
    assert len(timers) == 2 and 14 * 60 <= timers[1][0] <= 15 * 60 + 2


def test_list_notes_never_reports_an_expired_proposal_as_waiting(api, monkeypatch):
    _timers(api, monkeypatch)  # the timer never fires here
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    api.clock.now += 15 * 60 + 1
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    assert note["outcome"] == "Expired" and note["resolvedAt"]


def test_an_update_whose_proposal_is_gone_after_a_restart_resolves(api, monkeypatch):
    """Proposals live in memory and Updates on the project: after a restart
    the Update's proposal can't be decided any more, so its Review goes."""
    from services import asset_proposals

    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    monkeypatch.setattr(api.main, "asset_proposals", asset_proposals.AssetProposalBook(api.clock))
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    # Q108 a: it says what happened (tests/test_proposal_restart_outcome.py).
    assert note["outcome"] == "Closed: Nebula restarted" and note["resolvedBy"] == {"kind": "system"}


def test_an_open_proposals_update_is_left_alone_by_list_notes(api):
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    assert not note.get("resolvedAt") and not note.get("outcome")


def test_an_invalidated_proposal_resolves_the_update(api):
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    _pin(api, B, api.person)
    api.client.get("/api/asset-proposals")
    assert _resolved(api)["outcome"] == "No longer fits"


def test_the_update_resolves_in_the_project_it_was_posted_in(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    # The person opens another project before deciding.
    from services.project_store import make_project

    catalog = api.store.read()
    other = make_project("Another")
    catalog["projects"][other["id"]] = other
    catalog["activeProjectId"] = other["id"]
    api.store.commit(catalog)
    api.sent.clear()
    api.client.post(f"/api/asset-proposals/{view['id']}/reject", headers={**api.person, KEY: _key(api, view["id"])})
    note = _resolved(api)  # still on "Open now"'s list
    assert note["outcome"] == "You kept your cover"
    # Not the open project's list: no socket message would land on the wrong one.
    assert not _note_messages(api)


def test_send_notes_outcomes(api):
    board = _board(api)
    view = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"]).json()["proposal"]
    api.client.post(f"/api/asset-proposals/{view['id']}/reject", headers={**api.person, KEY: _key(api, view["id"])})
    assert _resolved(api)["outcome"] == "You kept the notes here"
    again = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"]).json()["proposal"]
    accepted = api.client.post(f"/api/asset-proposals/{again['id']}/accept",
                               headers={**api.person, KEY: _key(api, again["id"])})
    assert accepted.status_code == 200, accepted.text
    (note,) = _proposal_notes(api)  # the re-proposal replaced the rejected one's
    assert note["outcome"] == "Accepted: the notes go to generators"


def test_start_here_lists_open_asset_proposals_with_their_update(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    start = api.client.get("/api/agent/start", headers=CLAUDE)
    assert start.status_code == 200, start.text
    rows = start.json()["proposals"]["open"]
    row = next(r for r in rows if r["id"] == view["id"])
    assert row["kind"] == "project" and row["targetId"] == api.dusk
    assert row["update"] == _proposal_notes(api)[0]["id"]


def test_nebula_notes_prints_the_outcome(api):
    """The CLI twin: `nebula notes` lists the Update and, once closed, how."""
    from cli.commands.notes import format_note

    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    note = _proposal_notes(api)[0]
    assert "waiting for your OK" in format_note(note) and "[unread]" in format_note(note)
    api.client.post(f"/api/asset-proposals/{view['id']}/reject", headers={**api.person, KEY: _key(api, view["id"])})
    line = format_note(_resolved(api))
    assert "[You kept your cover]" in line and "[unread]" not in line
    assert "waiting for your OK" not in line
