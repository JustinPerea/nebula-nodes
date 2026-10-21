"""A pinned cover whose image left the project stops counting (Justin's Q90 a, 2026-10-21).

"a) It stops counting: agents may set a cover directly, and your next pin
counts again." The question was: you pinned a cover, then deleted the node
whose image it was; does the pin still count?

"Missing" means what the cover picker means by it: the image is no longer
one of the project's choices (``project_cover.is_choice``, the test
``project_cover.choices`` lists by). Nothing deletes the stored pin: whether
it counts is read from whether its image is there, so an undo that brings the
node back makes it count again.
"""
from __future__ import annotations

import pytest

from tests.test_asset_proposals import A, B, C, CLAUDE, CODEX, KEY, _events, _key, _pin, _propose, _saved, api  # noqa: F401


def _drop_node(api, node_id: str, project: str | None = None) -> dict:
    """The node goes from the saved project (as the canvas's autosave writes
    it after a delete); returns it so a test can bring it back (Cmd+Z)."""
    from services.project_store import refresh_metadata

    catalog = api.store.read()
    project = catalog["projects"][project or api.dusk]
    gone = next(node for node in project["snapshot"]["nodes"] if node["id"] == node_id)
    project["snapshot"]["nodes"] = [node for node in project["snapshot"]["nodes"] if node["id"] != node_id]
    refresh_metadata(project)
    api.store.commit(catalog)
    return gone


def _bring_back(api, node: dict, project: str | None = None) -> None:
    from services.project_store import refresh_metadata

    catalog = api.store.read()
    target = catalog["projects"][project or api.dusk]
    target["snapshot"]["nodes"].append(node)
    refresh_metadata(target)
    api.store.commit(catalog)


def _covers(api, project: str | None = None) -> dict:
    found = api.client.get(f"/api/projects/{project or api.dusk}/covers")
    assert found.status_code == 200, found.text
    return found.json()


def _card(api, project: str | None = None) -> dict:
    listed = api.client.get("/api/projects").json()["projects"]
    return next(card for card in listed if card["id"] == (project or api.dusk))


YOU = {"kind": "person", "name": "You"}


def test_a_pin_whose_node_was_deleted_is_automatic_everywhere(api):
    assert _pin(api, A, api.person).status_code == 200
    assert _covers(api)["pinnedBy"] == YOU
    _drop_node(api, "n1")

    covers = _covers(api)
    assert covers["pinned"] is None
    assert covers["pinnedBy"] is None
    # The old pin is named, so the picker can say why the cover went automatic.
    assert covers["lostPin"] == {"url": A, "by": YOU}
    assert covers["cover"]["source"] == "output"
    assert A not in [choice["url"] for choice in covers["images"]]

    card = _card(api)
    assert card["cover"]["source"] == "output"
    assert "coverBy" not in card
    assert card["coverLostPin"] == {"url": A, "by": YOU}
    # The stored pin is kept (an undo can bring its image back).
    assert _saved(api)["coverPin"] == A


def test_an_agent_sets_the_cover_directly_once_the_pins_image_is_gone(api):
    _pin(api, A, api.person)
    _drop_node(api, "n1")
    set_ = _pin(api, B, CLAUDE)
    assert set_.status_code == 200, set_.text
    body = set_.json()
    assert body["project"]["cover"] == {"source": "pinned", "images": [B]}
    assert body["project"]["coverBy"] == {"kind": "agent", "name": "Claude Code"}
    # What the card showed before was the automatic cover: that is the way back.
    assert body["previous"] == {"cover": None}
    events = _events(api, "project.cover")
    assert events[-1]["actor"]["name"] == "Claude Code"
    assert events[-1]["data"]["cover"] == B


def test_bringing_the_node_back_makes_the_pin_count_again(api):
    _pin(api, A, api.person)
    node = _drop_node(api, "n1")
    assert _covers(api)["pinnedBy"] is None
    _bring_back(api, node)  # Cmd+Z on the canvas, saved by autosave
    covers = _covers(api)
    assert covers["pinned"] == A and covers["pinnedBy"] == YOU
    assert "lostPin" not in covers or covers["lostPin"] is None
    assert _card(api)["cover"] == {"source": "pinned", "images": [A]}
    refused = _pin(api, B, CLAUDE)
    assert refused.status_code == 403
    assert "propose_asset_change" in refused.json()["detail"]


def test_an_agent_reset_to_automatic_leaves_a_lost_pin_for_an_undo(api):
    _pin(api, A, api.person)
    node = _drop_node(api, "n1")
    reset = _pin(api, None, CODEX)
    assert reset.status_code == 200, reset.text
    assert reset.json()["previous"] == {"cover": None}
    # The cover was automatic already: nothing changed, so nothing is journaled.
    assert [e["actor"]["kind"] for e in _events(api, "project.cover")] == ["person"]
    assert _saved(api)["coverPin"] == A
    _bring_back(api, node)
    assert _covers(api)["pinnedBy"] == YOU


def test_an_open_back_to_automatic_proposal_closes_when_the_pin_loses_its_image(api):
    """Review finding: proposed while the pin counted, "back to automatic"
    changes nothing once its image is gone (a new one is refused with 409),
    so it closes as no longer fitting, and the stored pin stays for an undo."""
    _pin(api, A, api.person)
    view = _propose(api, {"cover": None})
    assert view.status_code == 201, view.text
    proposal_id = view.json()["proposal"]["id"]
    node = _drop_node(api, "n1")

    listed = api.client.get("/api/asset-proposals", params={"kind": "project", "id": api.dusk}).json()["proposals"]
    assert listed == []
    assert api.book.get(proposal_id).status == "invalidated"
    assert _saved(api)["coverPin"] == A
    _bring_back(api, node)
    assert _covers(api)["pinned"] == A and _covers(api)["pinnedBy"] == YOU


def test_accepting_a_back_to_automatic_proposal_after_the_pin_lost_its_image_keeps_the_pin(api):
    _pin(api, A, api.person)
    proposal_id = _propose(api, {"cover": None}).json()["proposal"]["id"]
    key = _key(api, proposal_id)
    node = _drop_node(api, "n1")
    accepted = api.client.post(f"/api/asset-proposals/{proposal_id}/accept", headers={**api.person, KEY: key})
    assert accepted.status_code == 409, accepted.text
    assert _saved(api)["coverPin"] == A
    _bring_back(api, node)
    assert _covers(api)["pinned"] == A


def test_the_persons_next_pin_counts_again(api):
    _pin(api, A, api.person)
    _drop_node(api, "n1")
    assert _pin(api, C, api.person).status_code == 200
    covers = _covers(api)
    assert covers["pinned"] == C and covers["pinnedBy"] == YOU
    assert covers.get("lostPin") is None
    assert _pin(api, B, CLAUDE).status_code == 403


def test_the_person_clearing_a_lost_pin_drops_it(api):
    _pin(api, A, api.person)
    node = _drop_node(api, "n1")
    assert _pin(api, None, api.person).status_code == 200
    assert "coverPin" not in _saved(api)
    _bring_back(api, node)
    assert _covers(api)["pinned"] is None


def test_the_open_projects_live_canvas_decides_too(api):
    # The open project's saved snapshot lags the canvas: a node deleted on the
    # canvas is gone before autosave writes it.
    first = api.main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": C}})
    api.main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": B}})
    assert _pin(api, C, api.person, project=api.active).status_code == 200
    assert _pin(api, B, CLAUDE, project=api.active).status_code == 403
    api.main.cli_graph.remove_node(first)
    assert _covers(api, api.active)["pinnedBy"] is None
    set_ = _pin(api, B, CLAUDE, project=api.active)
    assert set_.status_code == 200, set_.text
    assert set_.json()["project"]["coverBy"]["name"] == "Claude Code"


# -- proposals and a lost pin -------------------------------------------------------

def test_a_proposal_on_a_lost_pin_shows_the_automatic_cover(api):
    _pin(api, A, api.person)
    _drop_node(api, "n1")
    made = _propose(api, {"cover": C})
    assert made.status_code == 201, made.text
    cover = made.json()["proposal"]["change"]["cover"]
    # Never "You pinned" over an image that is gone.
    assert cover["from"] is None and cover["fromBy"] is None
    assert cover["lostPin"] == {"url": A, "by": YOU}
    # Back to automatic: it already is.
    same = _propose(api, {"cover": None})
    assert same.status_code == 409 and "automatic" in same.json()["detail"]


def test_an_open_proposal_whose_pin_lost_its_image_stays_open_and_accepts(api):
    """Decided: the proposal stays open and the strip shows it against the
    automatic cover; Accept applies it as before (the person's pin, which
    counts). Closing it would surprise more: an undo brings the image back
    and the agent would have to ask again."""
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    assert view["change"]["cover"]["from"] == A and view["change"]["cover"]["fromBy"] == YOU
    node = _drop_node(api, "n1")

    listed = api.client.get("/api/asset-proposals", params={"kind": "project", "id": api.dusk}).json()["proposals"]
    assert [p["id"] for p in listed] == [view["id"]]
    assert listed[0]["status"] == "open"
    cover = listed[0]["change"]["cover"]
    assert cover["from"] is None and cover["fromBy"] is None
    assert cover["lostPin"] == {"url": A, "by": YOU}

    # The node comes back while it waits: the strip shows the pin again.
    _bring_back(api, node)
    cover = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]["change"]["cover"]
    assert cover["from"] == A and cover["fromBy"] == YOU and "lostPin" not in cover

    _drop_node(api, "n1")
    accepted = api.client.post(f"/api/asset-proposals/{view['id']}/accept",
                               headers={**api.person, KEY: _key(api, view["id"])})
    assert accepted.status_code == 200, accepted.text
    saved = _saved(api)
    assert saved["coverPin"] == C and saved["coverBy"] == YOU
    assert _pin(api, B, CLAUDE).status_code == 403


def test_the_person_view_of_a_proposal_says_the_pin_is_gone(api):
    """The Projects screen's strip reads the proposal from the person's socket
    (assetProposalSync) and from the relist after projectsChanged."""
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    _drop_node(api, "n1")
    with api.client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "graphSync"
        socket.receive_json()  # pins
        socket.receive_json()  # updates
        socket.send_json({"type": "hello", "personToken": api.person["X-Nebula-Person"]})
        seen = [socket.receive_json(), socket.receive_json()]
    sync = next(message for message in seen if message["type"] == "assetProposalSync")
    cover = next(p for p in sync["proposals"] if p["id"] == view["id"])["change"]["cover"]
    assert cover["from"] is None and cover["lostPin"]["url"] == A


@pytest.mark.parametrize("tool", ["set_project_cover", "list_project_covers", "propose_asset_change"])
def test_the_tool_docs_say_a_pin_whose_image_is_gone_no_longer_counts(tool):
    import mcp_server

    doc = " ".join((getattr(mcp_server, tool).__doc__ or "").split())
    assert "no longer counts" in doc


def test_the_moodboard_cover_doc_says_removing_the_image_clears_it():
    import mcp_server

    doc = " ".join((mcp_server.moodboard_update.__doc__ or "").split())
    assert "Removing the cover image opens the board on #1" in doc


def test_nebula_proposal_says_the_pin_is_gone(api):
    """The CLI twin: `nebula proposal <id>` prints the cover it changes from."""
    from cli.formatter import format_proposal

    _pin(api, A, api.person)
    _drop_node(api, "n1")
    view = _propose(api, {"cover": C}).json()["proposal"]
    printed = format_proposal(view)
    assert f"cover: automatic → {C}" in printed
    assert "no longer counts" in printed


# -- the open canvas pushes the new view right away (follow-up) ---------------------
#
# Live check: with a cover proposal open, the person deleted the pinned node and
# went to Projects within a second. Their tab kept "You pinned" over the gone
# image until the autosave's projectsChanged relisted (about 2 s). Every live
# canvas change goes through _broadcast_graph_sync; it now re-checks the open
# project's cover proposals and pushes what changed.

def _open_canvas_proposal(api, change):
    first = api.main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": A}})
    for url in (B, C):
        api.main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": url}})
    assert _pin(api, A, api.person, project=api.active).status_code == 200
    made = _propose(api, change, target=api.active)
    assert made.status_code == 201, made.text
    return first, made.json()["proposal"]


def _synced(api, proposal_id, key):
    syncs = [m for m in api.browser if m.get("type") == "assetProposalSync"]
    assert syncs, "no assetProposalSync pushed to the person's tab"
    found = next(p for p in syncs[-1]["proposals"] if p["id"] == proposal_id)
    assert found["acceptKey"] == key
    return found


def _broadcast_sync(api):
    import asyncio

    asyncio.run(api.main._broadcast_graph_sync(edit=True))


def test_deleting_the_pinned_node_pushes_the_proposals_new_view(api):
    first, view = _open_canvas_proposal(api, {"cover": C})
    assert view["change"]["cover"]["from"] == A
    key = _key(api, view["id"])
    api.browser.clear()
    deleted = api.client.delete(f"/api/graph/node/{first}", headers=api.person)
    assert deleted.status_code == 200, deleted.text
    # Pushed with the delete itself, before any autosave or relist.
    cover = _synced(api, view["id"], key)["change"]["cover"]
    assert cover["from"] is None and cover["fromBy"] is None
    assert cover["lostPin"] == {"url": A, "by": YOU}


def test_the_node_coming_back_pushes_the_pin_again(api):
    first, view = _open_canvas_proposal(api, {"cover": C})
    node = api.main.cli_graph.nodes[first]
    key = _key(api, view["id"])
    api.client.delete(f"/api/graph/node/{first}", headers=api.person)
    api.browser.clear()
    api.main.cli_graph.nodes[first] = node  # Cmd+Z (POST /api/graph/restore) puts it back
    _broadcast_sync(api)
    cover = _synced(api, view["id"], key)["change"]["cover"]
    assert cover["from"] == A and cover["fromBy"] == YOU and "lostPin" not in cover


def test_deleting_the_pinned_node_closes_a_back_to_automatic_proposal_at_once(api):
    first, view = _open_canvas_proposal(api, {"cover": None})
    api.client.delete(f"/api/graph/node/{first}", headers=api.person)
    closed = [m for m in api.sent if m.get("type") == "assetProposalClosed" and m["proposalId"] == view["id"]]
    assert closed and closed[0]["status"] == "invalidated"
    assert api.book.get(view["id"]).status == "invalidated"


def test_a_canvas_edit_that_changes_no_view_pushes_nothing(api):
    _, view = _open_canvas_proposal(api, {"cover": C})
    api.browser.clear()
    api.main.cli_graph.add_node("nano-banana", {}, outputs={})
    _broadcast_sync(api)
    assert not [m for m in api.browser if m.get("type") == "assetProposalSync"]
    assert api.book.get(view["id"]).is_open


def test_canvas_edits_skip_the_check_without_a_cover_proposal_on_the_open_project(api, monkeypatch):
    checked: list[str] = []

    def spy(proposal, project, images):
        checked.append(proposal.id)
        return None

    # A proposal on another project (Dusk isn't open): the canvas can't change its images.
    _pin(api, A, api.person)
    assert _propose(api, {"cover": C}).status_code == 201
    monkeypatch.setattr(api.main, "_cover_proposal_misfit", spy)
    node = api.main.cli_graph.add_node("nano-banana", {}, outputs={})
    assert api.client.delete(f"/api/graph/node/{node}", headers=api.person).status_code == 200
    assert checked == []


def test_a_failing_check_never_fails_the_canvas_edit(api, monkeypatch):
    first, _ = _open_canvas_proposal(api, {"cover": C})

    def broken(proposal, project, images):
        raise RuntimeError("boom")

    monkeypatch.setattr(api.main, "_cover_proposal_misfit", broken)
    assert api.client.delete(f"/api/graph/node/{first}", headers=api.person).status_code == 200


# -- the automatic cover's image (follow-up) ----------------------------------------

def test_a_cover_proposal_names_the_automatic_cover_image(api):
    """The strip's "Automatic now" / "Automatic" side shows the image the
    automatic cover would be (the newest one), not a "Newest image" placeholder."""
    _pin(api, A, api.person)
    view = _propose(api, {"cover": None}).json()["proposal"]
    assert view["change"]["cover"]["auto"] == C  # C is the newest of A, B, C
    _drop_node(api, "n3")
    listed = api.client.get("/api/asset-proposals", params={"kind": "project", "id": api.dusk}).json()["proposals"]
    assert listed[0]["change"]["cover"]["auto"] == B


def test_a_lost_pin_proposal_names_the_automatic_cover_image(api):
    _pin(api, A, api.person)
    _drop_node(api, "n1")
    cover = _propose(api, {"cover": B}).json()["proposal"]["change"]["cover"]
    assert cover["from"] is None and cover["auto"] == C


def test_the_automatic_cover_is_null_when_the_project_has_no_image(api):
    first, view = _open_canvas_proposal(api, {"cover": B})
    assert view["change"]["cover"]["auto"] == C
    for node_id in list(api.main.cli_graph.nodes):
        api.main.cli_graph.remove_node(node_id)
    _broadcast_sync(api)
    # Every image gone: B isn't a choice, so the proposal closed.
    assert api.book.get(view["id"]).status == "invalidated"
