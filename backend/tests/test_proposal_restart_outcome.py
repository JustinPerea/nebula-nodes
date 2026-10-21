"""An Update whose ask was open when Nebula restarted (Justin's Q108 a, 2026-10-21).

"a) "Closed: Nebula restarted" (the agent can ask again)." Proposals live in
memory and Updates are saved with the project, so after a restart an asset
proposal's Update can outlive its proposal. #149 resolved it as "Expired";
it now says what happened, "Closed: Nebula restarted", wherever the outcome
is produced or shown (the corner, list_notes, `nebula notes`), and the
agent-facing words say the agent can ask again. A proposal that really timed
out (15 minutes) still says "Expired".

Canvas proposals (propose_change) post no Update, so they have no Update to
close; an agent asking after one Nebula no longer has is told the same: a
restart closes open proposals, propose again.
"""
from __future__ import annotations

from pathlib import Path

from tests.test_asset_proposal_updates import _proposal_notes, _resolved, _timers
from tests.test_asset_proposals import A, C, CLAUDE, _board, _pin, _propose, api  # noqa: F401

REPO = Path(__file__).resolve().parents[2]


def _restart(api, monkeypatch) -> None:
    """What a restart leaves: the project's Updates, and an empty proposal book."""
    from services import asset_proposals

    monkeypatch.setattr(api.main, "asset_proposals", asset_proposals.AssetProposalBook(api.clock))


def _listed(api) -> dict:
    listed = api.client.get("/api/canvas/agent-notes", headers=CLAUDE).json()["notes"]
    (note,) = [n for n in listed if n["about"] == "proposal"]
    return note


def test_the_outcome_names_the_restart():
    from services.asset_proposals import RESTART_OUTCOME

    assert RESTART_OUTCOME == "Closed: Nebula restarted"


def test_a_cover_ask_open_at_a_restart_closes_as_restarted(api, monkeypatch):
    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    _restart(api, monkeypatch)
    note = _listed(api)  # list_notes settles first
    assert note["outcome"] == "Closed: Nebula restarted"
    assert note["resolvedBy"] == {"kind": "system"} and note["resolvedAt"] and note["readAt"]
    # Saved that way, so every later read (the corner, `nebula notes`) says the same.
    assert _resolved(api)["outcome"] == "Closed: Nebula restarted"


def test_a_send_notes_ask_open_at_a_restart_closes_as_restarted(api, monkeypatch):
    _timers(api, monkeypatch)
    board = _board(api)
    _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"])
    _restart(api, monkeypatch)
    assert _listed(api)["outcome"] == "Closed: Nebula restarted"


def test_the_socket_connect_after_a_restart_sends_the_closed_update(api, monkeypatch):
    """The person's tab reconnects after the restart: the corner hears it then."""
    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    _restart(api, monkeypatch)
    api.sent.clear()
    with api.client.websocket_connect("/ws") as socket:
        messages = [socket.receive_json() for _ in range(3)]
    notes = next(m for m in messages if m.get("type") == "agentNotes")
    (note,) = [n for n in notes["notes"] if n["about"] == "proposal"]
    assert note["outcome"] == "Closed: Nebula restarted"
    resolved = [m for m in api.sent if m.get("type") == "agentNotes" and m["op"] == "resolved"]
    assert resolved and resolved[0]["note"]["outcome"] == "Closed: Nebula restarted"


def test_a_timed_out_ask_still_says_expired_after_a_restart(api, monkeypatch):
    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.clock.now += 15 * 60 + 1
    api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE)
    assert _resolved(api)["outcome"] == "Expired"
    _restart(api, monkeypatch)
    assert _listed(api)["outcome"] == "Expired"


def test_a_timed_out_ask_says_expired_without_a_restart(api, monkeypatch):
    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    api.clock.now += 15 * 60 + 1
    assert _listed(api)["outcome"] == "Expired"


def test_nebula_notes_prints_the_restart_outcome(api, monkeypatch):
    from cli.commands.notes import format_note

    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    _propose(api, {"cover": C})
    _restart(api, monkeypatch)
    line = format_note(_listed(api))
    assert "[Closed: Nebula restarted]" in line and "waiting for your OK" not in line


def test_asking_after_a_proposal_a_restart_closed_says_to_ask_again(api, monkeypatch):
    """An agent that waits on its proposal across a restart reads a 404 that
    says why and what to do, for an asset proposal and a canvas one alike."""
    _timers(api, monkeypatch)
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    _restart(api, monkeypatch)
    for proposal_id in (view["id"], "pr_gone"):
        response = api.client.get(f"/api/canvas/proposals/{proposal_id}", headers=CLAUDE)
        assert response.status_code == 404
        detail = response.json()["detail"]
        assert "restart" in detail and "propose again" in detail, detail


# -- what agents read ----------------------------------------------------------------

def test_the_mcp_tools_tell_an_agent_about_the_restart_outcome():
    import mcp_server

    for tool in (mcp_server.list_notes, mcp_server.propose_asset_change):
        doc = tool.__doc__ or ""
        assert "Closed: Nebula restarted" in doc, tool.__name__
        assert "again" in doc, tool.__name__


def test_the_docs_name_the_restart_outcome_not_expired():
    for path in ("docs/MCP-SETUP.md", "skills/nebula/SKILL.md"):
        text = (REPO / path).read_text(encoding="utf-8")
        assert "Closed: Nebula restarted" in text, path
    setup = (REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8")
    assert 'whose proposal is gone resolves as "Expired"' not in setup


def test_agents_are_told_updates_show_on_every_screen():
    """Q107 a: the Updates corner is on every screen, with the open project's list."""
    import mcp_server

    assert "every screen" in (mcp_server.post_note.__doc__ or "")
    setup = (REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8")
    assert "in the top\nright of the canvas" not in setup and "top right of the canvas" not in setup
    assert "every screen" in setup
    assert "every screen" in (REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8")


def test_agents_are_told_a_boards_updates_are_not_on_screen_yet():
    """Review of Q107 a: the corner shows only the open project's list.

    An Update posted with `board` is kept with that board for list_notes, but
    no screen shows it (not even Moodboard Studio on that board), so the
    words that now say "every screen" must not steer an agent to post there
    to reach the person.
    """
    import mcp_server

    phrase = "not on screen yet"
    post_doc = " ".join((mcp_server.post_note.__doc__ or "").split())
    assert phrase in post_doc
    assert "post without `board`" in post_doc
    list_doc = " ".join((mcp_server.list_notes.__doc__ or "").split())
    assert phrase in list_doc
    setup = " ".join((REPO / "docs/MCP-SETUP.md").read_text(encoding="utf-8").split())
    assert "(or with a board, with `board`)" not in setup
    assert setup.count(phrase) >= 2, "the tool list and the Updates section"
    skill = " ".join((REPO / "skills/nebula/SKILL.md").read_text(encoding="utf-8").split())
    assert phrase in skill and "leave out `--board`" in skill
    cli = " ".join((REPO / "backend/cli/__main__.py").read_text(encoding="utf-8").split())
    assert phrase in cli
