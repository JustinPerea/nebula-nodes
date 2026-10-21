"""Proposals for changes outside the graph (audit U16; Justin's Q60 a, 2026-10-20).

`propose_change` carries only graph changes. This covers the person's calls
that live on an asset or a project:

- A project's cover. An agent sets it directly while the person hasn't
  pinned one (who set it is recorded); a cover the person pinned changes only
  through a proposal the person accepts on the Projects screen. The person's
  own pin and reset work as before.
- A moodboard's Send notes to generators, which only the person may turn on:
  `moodboard_update` told agents to "propose it", and now they can.

Asset proposals share the canvas proposals' life cycle (open, accepted,
rejected, withdrawn, expired, invalidated), their id space for
`GET`/`DELETE /api/canvas/proposals/{id}` (so `get_proposal` and
`withdraw_proposal` work), their journal kinds, and their two-layer accept
gate (the person token and a per-proposal key sent only to the person's
canvas sockets).
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from services.canvas_events import CanvasEventJournal
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard
from services.execution_runs import ExecutionRunRegistry

CLAUDE = {"X-Nebula-Agent": "Claude Code"}
CODEX = {"X-Nebula-Agent": "Codex"}
KEY = "X-Nebula-Proposal-Key"
A = "/api/outputs/a.png"
B = "/api/outputs/b.png"
C = "/api/outputs/c.png"


class Clock:
    def __init__(self) -> None:
        self.now = 1_760_000_000.0

    def __call__(self) -> float:
        return self.now


def _image_node(node_id: str, url: str) -> dict:
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "nano-banana", "params": {}, "outputs": {"image": {"type": "Image", "value": url}}}}


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module
    from services import asset_proposals, project_cover
    from services.project_store import refresh_metadata

    monkeypatch.setenv("NEBULA_MOODBOARD_ROOT", str(tmp_path / "moodboards"))
    monkeypatch.setattr(project_cover, "_time_for", lambda url: {A: 1.0, B: 2.0, C: 3.0}.get(url))
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        active = make_project("Open now")
        dusk = make_project("Dusk")
        dusk["snapshot"]["nodes"] = [_image_node("n1", A), _image_node("n2", B), _image_node("n3", C)]
        refresh_metadata(dusk)
        catalog["projects"][active["id"]] = active
        catalog["projects"][dusk["id"]] = dusk
        catalog["activeProjectId"] = active["id"]
        store.commit(catalog)
    clock = Clock()
    book = asset_proposals.AssetProposalBook(clock)
    journal = CanvasEventJournal()
    sent: list[dict] = []
    browser: list[dict] = []

    async def capture(data):
        sent.append(data)

    async def capture_browser(data):
        browser.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "asset_proposals", book)
    monkeypatch.setattr(main_module, "canvas_events", journal)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture_browser)

    class Api:
        pass

    ctx = Api()
    ctx.client = TestClient(main_module.app)
    ctx.main = main_module
    ctx.store = store
    ctx.book = book
    ctx.clock = clock
    ctx.journal = journal
    ctx.sent = sent
    ctx.browser = browser
    ctx.person = person.headers
    ctx.dusk = dusk["id"]
    ctx.active = active["id"]
    return ctx


def _events(api, prefix: str = "") -> list[dict]:
    return [event for event in api.journal.read(after=0, limit=100)["events"] if event["kind"].startswith(prefix)]


def _key(api, proposal_id: str) -> str:
    """The accept key, read the way the person's canvas reads it: from a browser-only message."""
    for message in api.browser:
        if message.get("type") == "assetProposalOpened" and message["proposal"]["id"] == proposal_id:
            return message["acceptKey"]
    raise AssertionError("no assetProposalOpened message for the browser")


def _pin(api, url, headers, project=None):
    return api.client.put(f"/api/projects/{project or api.dusk}/cover", json={"url": url}, headers=headers)


def _propose(api, change, *, kind="project", target=None, headers=CLAUDE, note="Use the dusk shot"):
    return api.client.post("/api/asset-proposals", json={
        "kind": kind, "id": target or api.dusk, "change": change, "note": note}, headers=headers)


def _saved(api, project=None) -> dict:
    return api.store.read()["projects"][project or api.dusk]


# -- project covers: agents directly while the person hasn't pinned one -----------

def test_an_agent_sets_a_cover_directly_while_the_person_has_not_pinned_one(api):
    set_ = _pin(api, A, CLAUDE)
    assert set_.status_code == 200, set_.text
    body = set_.json()
    assert body["project"]["cover"] == {"source": "pinned", "images": [A]}
    assert body["project"]["coverBy"] == {"kind": "agent", "name": "Claude Code"}
    # The way back: passing it to the same route undoes the change.
    assert body["previous"] == {"cover": None}
    saved = _saved(api)
    assert saved["coverPin"] == A and saved["coverBy"] == {"kind": "agent", "name": "Claude Code"}

    # Another agent (or the same) may change or reset an agent's cover.
    changed = _pin(api, B, CODEX)
    assert changed.status_code == 200, changed.text
    assert changed.json()["previous"] == {"cover": A}
    reset = _pin(api, None, CODEX)
    assert reset.status_code == 200
    assert reset.json()["project"]["cover"]["source"] == "output"
    assert "coverPin" not in _saved(api) and "coverBy" not in _saved(api)

    events = _events(api, "project.cover")
    assert [event["actor"].get("name") for event in events] == ["Claude Code", "Codex", "Codex"]
    assert events[0]["data"]["projectId"] == api.dusk
    assert events[0]["data"]["cover"] == A
    assert events[2]["data"]["cover"] is None
    assert "Dusk" in events[0]["summary"]


def test_a_cover_the_person_pinned_changes_only_through_a_proposal(api):
    assert _pin(api, A, api.person).status_code == 200
    assert _saved(api)["coverBy"] == {"kind": "person", "name": "You"}
    for headers in (CLAUDE, {}):
        for url in (B, None):
            refused = _pin(api, url, headers)
            assert refused.status_code == 403, refused.text
            assert "propose_asset_change" in refused.json()["detail"]
    assert _saved(api)["coverPin"] == A
    # The person's own pin and reset work as before.
    assert _pin(api, B, api.person).json()["project"]["cover"]["images"] == [B]
    assert _pin(api, None, api.person).status_code == 200
    assert [event["actor"]["kind"] for event in _events(api, "project.cover")] == ["person", "person", "person"]


def test_a_pin_saved_before_covers_recorded_who_counts_as_the_persons(api):
    catalog = api.store.read()
    catalog["projects"][api.dusk]["coverPin"] = A  # only the person could pin then
    api.store.commit(catalog)
    assert _pin(api, B, CLAUDE).status_code == 403
    choices = api.client.get(f"/api/projects/{api.dusk}/covers").json()
    assert choices["pinned"] == A
    assert choices["pinnedBy"] == {"kind": "person", "name": "You"}


def test_the_covers_listing_says_who_pinned_it(api):
    assert api.client.get(f"/api/projects/{api.dusk}/covers").json()["pinnedBy"] is None
    _pin(api, B, CLAUDE)
    assert api.client.get(f"/api/projects/{api.dusk}/covers").json()["pinnedBy"] == {"kind": "agent", "name": "Claude Code"}


def test_an_agent_cover_on_the_open_project_reads_the_live_canvas(api):
    # The open project's saved snapshot lags the live canvas; the cover must
    # be one of its images as the canvas has them now.
    api.main.cli_graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": C}})
    set_ = _pin(api, C, CLAUDE, project=api.active)
    assert set_.status_code == 200, set_.text
    assert set_.json()["project"]["cover"] == {"source": "pinned", "images": [C]}


# -- proposing a cover ----------------------------------------------------------

def test_an_agent_proposes_a_new_cover_for_a_pinned_project(api):
    _pin(api, A, api.person)
    made = _propose(api, {"cover": C})
    assert made.status_code == 201, made.text
    view = made.json()["proposal"]
    assert view["id"].startswith("pa_")
    assert view["status"] == "open"
    assert view["kind"] == "project"
    assert view["target"] == {"kind": "project", "id": api.dusk, "name": "Dusk"}
    # auto: the image the automatic cover would show (the newest, C).
    assert view["change"] == {"cover": {"from": A, "to": C, "fromBy": {"kind": "person", "name": "You"}, "auto": C}}
    assert view["agent"]["name"] == "Claude Code"
    assert view["decideIn"] == "projects"
    assert "acceptKey" not in json.dumps(made.json())
    key = _key(api, view["id"])
    assert key not in json.dumps(made.json())

    created = _events(api, "proposal.created")
    assert len(created) == 1
    assert created[0]["data"]["proposalId"] == view["id"]
    assert created[0]["data"]["kind"] == "project"
    assert created[0]["data"]["targetId"] == api.dusk
    assert key not in json.dumps(api.journal.read(after=0, limit=100))
    # The Agent log names it, since no cursor can go to the Projects screen.
    said = [m for m in api.sent if m.get("type") == "agentPresence"]
    assert said and "Dusk" in json.dumps(said[-1])

    # get_proposal and withdraw_proposal reach it through the canvas routes.
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE)
    assert read.status_code == 200, read.text
    assert read.json()["proposal"]["status"] == "open"
    listed = api.client.get("/api/asset-proposals", params={"kind": "project", "id": api.dusk}).json()
    assert [p["id"] for p in listed["proposals"]] == [view["id"]]
    assert key not in json.dumps(listed)


@pytest.mark.parametrize(("body", "status", "words"), [
    ({"kind": "style", "id": "x", "change": {"cover": A}, "note": "n"}, 422, "kind"),
    ({"kind": "project", "id": "x", "change": {"cover": A}, "note": "n"}, 400, "project"),
    ({"kind": "project", "id": "DUSK", "change": {"name": "New"}, "note": "n"}, 422, "cover"),
    ({"kind": "project", "id": "DUSK", "change": {"cover": "/api/outputs/elsewhere.png"}, "note": "n"}, 400,
     "images"),
    ({"kind": "project", "id": "DUSK", "change": {"cover": A}, "note": ""}, 422, "note"),
    ({"kind": "project", "id": "DUSK", "change": "cover", "note": "n"}, 422, "change"),
    ({"kind": "project", "id": "DUSK", "change": {"cover": A}, "note": "n", "extra": 1}, 422, "extra"),
])
def test_bad_proposals_are_refused_before_the_person_sees_them(api, body, status, words):
    body = {**body, "id": api.dusk if body["id"] == "DUSK" else body["id"]}
    refused = api.client.post("/api/asset-proposals", json=body, headers=CLAUDE)
    assert refused.status_code == status, refused.text
    assert words in refused.json()["detail"]
    assert not [m for m in api.browser if m.get("type") == "assetProposalOpened"]


def test_who_may_propose(api):
    assert _propose(api, {"cover": C}, headers=api.person).status_code == 403
    assert _propose(api, {"cover": C}, headers={}).status_code == 400
    # Nothing to decide: it is the cover already.
    _pin(api, C, api.person)
    same = _propose(api, {"cover": C})
    assert same.status_code == 409 and "already" in same.json()["detail"]


def test_an_agent_may_ask_before_setting_an_unpinned_cover(api):
    made = _propose(api, {"cover": B})
    assert made.status_code == 201, made.text
    assert made.json()["proposal"]["change"]["cover"] == {"from": None, "to": B, "fromBy": None, "auto": C}


def test_open_proposals_are_capped_per_agent(api):
    _pin(api, A, api.person)
    for url in (B, C, None):
        assert _propose(api, {"cover": url}).status_code == 201
    assert _propose(api, {"cover": B}).status_code == 429


# -- the person's decision ------------------------------------------------------------

def test_only_the_persons_canvas_accepts_with_the_key(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    key = _key(api, view["id"])
    path = f"/api/asset-proposals/{view['id']}/accept"
    assert api.client.post(path, headers={**CLAUDE, KEY: key}).status_code == 403
    assert api.client.post(path, headers=api.person).status_code == 403
    assert api.client.post(path, headers={**api.person, KEY: "wrong"}).status_code == 403
    assert _saved(api)["coverPin"] == A

    accepted = api.client.post(path, headers={**api.person, KEY: key})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    saved = _saved(api)
    # Accepted, it is the person's pin: the next agent change asks again.
    assert saved["coverPin"] == C and saved["coverBy"] == {"kind": "person", "name": "You"}
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "accepted"
    assert read["applied"] == {"cover": C}

    kinds = [event["kind"] for event in _events(api)]
    assert kinds[-2:] == ["proposal.accepted", "project.cover"] or kinds[-2:] == ["project.cover", "proposal.accepted"]
    accepted_event = _events(api, "proposal.accepted")[-1]
    assert accepted_event["actor"]["kind"] == "person"
    assert accepted_event["data"]["kind"] == "project"
    cover_event = _events(api, "project.cover")[-1]
    assert cover_event["actor"]["kind"] == "person"
    assert "Claude Code" in cover_event["summary"]
    closed = [m for m in api.sent if m.get("type") == "assetProposalClosed"]
    assert closed[-1] == {"type": "assetProposalClosed", "proposalId": view["id"], "status": "accepted",
                          "reason": None, "kind": "project", "targetId": api.dusk}
    assert any(m.get("type") == "projectsChanged" for m in api.sent)
    # Decided once.
    assert api.client.post(path, headers={**api.person, KEY: key}).status_code == 409


def test_the_person_rejects_with_a_reason(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    key = _key(api, view["id"])
    rejected = api.client.post(f"/api/asset-proposals/{view['id']}/reject",
                               json={"reason": "Keep the wide shot"}, headers={**api.person, KEY: key})
    assert rejected.status_code == 200, rejected.text
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "rejected" and read["reason"] == "Keep the wide shot"
    assert _saved(api)["coverPin"] == A
    assert _events(api, "proposal.rejected")[-1]["actor"]["kind"] == "person"


def test_the_agent_withdraws_its_own_proposal(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    assert api.client.delete(f"/api/canvas/proposals/{view['id']}", headers=CODEX).status_code == 403
    taken = api.client.delete(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE)
    assert taken.status_code == 200, taken.text
    assert taken.json()["proposal"]["status"] == "withdrawn"
    assert _events(api, "proposal.withdrawn")[-1]["data"]["kind"] == "project"


def test_a_proposal_expires_after_fifteen_minutes(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    api.clock.now += 15 * 60 + 1
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "expired"
    expired = _events(api, "proposal.expired")[-1]
    assert expired["actor"] == {"kind": "system"}


def test_a_proposal_the_person_overtook_is_invalidated(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    key = _key(api, view["id"])
    # The person picks another cover themselves: the proposal no longer fits.
    _pin(api, B, api.person)
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "invalidated"
    assert "cover" in read["reason"]
    assert any(m.get("type") == "assetProposalClosed" and m["status"] == "invalidated" for m in api.sent)
    assert api.client.post(f"/api/asset-proposals/{view['id']}/accept",
                           headers={**api.person, KEY: key}).status_code == 409
    assert _saved(api)["coverPin"] == B


def test_a_proposal_for_a_deleted_project_is_invalidated(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    revision = api.client.get("/api/projects").json()["workspaceRevision"]
    deleted = api.client.request("DELETE", f"/api/projects/{api.dusk}", json={"workspaceRevision": revision},
                                 headers=api.person)
    assert deleted.status_code == 200, deleted.text
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "invalidated"


def test_the_persons_canvas_gets_open_asset_proposals_with_keys_on_hello(api):
    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    with api.client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "graphSync"
        socket.receive_json()  # pins
        socket.receive_json()  # updates (post_note, #124)
        socket.send_json({"type": "hello", "personToken": api.person["X-Nebula-Person"]})
        seen = [socket.receive_json(), socket.receive_json()]
    sync = next(message for message in seen if message["type"] == "assetProposalSync")
    assert [p["id"] for p in sync["proposals"]] == [view["id"]]
    assert sync["proposals"][0]["acceptKey"] == _key(api, view["id"])


# -- moodboards: Send notes to generators ------------------------------------------------

def _board(api, *, send_notes=False) -> dict:
    made = api.client.post("/api/moodboards", json={
        "name": "Dusk board", "images": [{"url": A}], "projectId": api.active, "sendNotes": send_notes,
    }, headers=api.person)
    assert made.status_code == 200, made.text
    return made.json()


def test_an_agent_proposes_sending_a_boards_notes_and_the_person_accepts_in_studio(api):
    board = _board(api)
    refused = api.client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": True}, headers=CLAUDE)
    assert refused.status_code == 403
    assert "propose_asset_change" in refused.json()["detail"]

    made = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"], note="Your notes say dusk")
    assert made.status_code == 201, made.text
    view = made.json()["proposal"]
    assert view["target"] == {"kind": "moodboard", "id": board["id"], "name": "Dusk board"}
    assert view["change"] == {"sendNotes": {"from": False, "to": True}}
    assert view["decideIn"] == "moodboard-studio"
    key = _key(api, view["id"])

    accepted = api.client.post(f"/api/asset-proposals/{view['id']}/accept",
                               headers={**api.person, KEY: key, "X-Nebula-Tab": "tab-0123456789abcdef"})
    assert accepted.status_code == 200, accepted.text
    saved = api.client.get(f"/api/moodboards/{board['id']}").json()
    assert saved["sendNotes"] is True
    # The Studio that clicked Accept follows the write like any other: it is
    # not its own tab's echo, so it reads the board again.
    changed = [m for m in api.sent if m.get("type") == "storedAssetChanged" and m.get("id") == board["id"]]
    assert changed and "tab" not in (changed[-1].get("edit") or {})
    assert _events(api, "proposal.accepted")[-1]["data"]["kind"] == "moodboard"
    # Q91 a: the accepted change is journaled like any field write, by name only.
    fields = _events(api, "board.fields")
    assert [event["data"]["fields"] for event in fields] == [["sendNotes"]]
    assert fields[0]["data"]["boardId"] == board["id"]
    assert "Your notes say dusk" not in json.dumps(fields)


@pytest.mark.parametrize(("change", "status", "words"), [
    ({"sendNotes": False}, 422, "directly"),
    ({"notes": "x"}, 422, "sendNotes"),
    ({"sendNotes": "yes"}, 422, "true"),
])
def test_bad_board_proposals_are_refused(api, change, status, words):
    board = _board(api)
    refused = _propose(api, change, kind="moodboard", target=board["id"])
    assert refused.status_code == status, refused.text
    assert words in refused.json()["detail"]


def test_a_board_proposal_needs_the_board_and_something_to_change(api):
    assert _propose(api, {"sendNotes": True}, kind="moodboard", target="mb_missing").status_code == 404
    board = _board(api, send_notes=True)
    already = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"])
    assert already.status_code == 409 and "already" in already.json()["detail"]


def test_a_board_proposal_is_invalidated_when_the_person_turns_sending_on_first(api):
    board = _board(api)
    view = _propose(api, {"sendNotes": True}, kind="moodboard", target=board["id"]).json()["proposal"]
    assert api.client.put(f"/api/moodboards/{board['id']}", json={"sendNotes": True},
                          headers=api.person).status_code == 200
    read = api.client.get(f"/api/canvas/proposals/{view['id']}", headers=CLAUDE).json()["proposal"]
    assert read["status"] == "invalidated"
    assert "on" in read["reason"]


def test_the_cli_prints_an_asset_proposal_as_what_it_changes(api):
    from cli.formatter import format_proposal, format_proposal_outcome

    _pin(api, A, api.person)
    view = _propose(api, {"cover": C}).json()["proposal"]
    printed = format_proposal(view)
    assert 'make another image the cover of project "Dusk"' in printed
    assert f"{A} → {C}" in printed
    assert "decide on the Projects screen" in printed
    assert "runs" not in printed
    created = format_proposal(view, created=True)
    assert "on the Projects screen for the person" in created and "on the canvas" not in created
    accepted = {**view, "status": "accepted", "applied": {"cover": C}}
    assert format_proposal_outcome(accepted) == f"Accepted by the person: the cover is now {C}."


def test_a_cover_proposal_for_the_open_project_reads_the_live_canvas_at_accept(api):
    graph = api.main.cli_graph
    graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": A}})
    assert _pin(api, A, api.person, project=api.active).status_code == 200
    # Made after the pin: only the live canvas has it, not the saved project.
    graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": C}})
    view = _propose(api, {"cover": C}, target=api.active).json()["proposal"]
    accepted = api.client.post(f"/api/asset-proposals/{view['id']}/accept",
                               headers={**api.person, KEY: _key(api, view["id"])})
    assert accepted.status_code == 200, accepted.text
    assert _saved(api, api.active)["coverPin"] == C
