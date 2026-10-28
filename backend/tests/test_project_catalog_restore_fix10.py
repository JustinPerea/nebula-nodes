"""PR #199 fix round 10 (review 10, GM r12 and GM r13).

HIGH-1: `canvasPending` sits in the catalog's head (before `activeProjectId`),
a restore keeps what the copy and each damaged file's head still say, and a
restore that couldn't read the damaged file whole protects the reopened
project again when it is the live canvas's (a record the damage took fails
safe). Review 10's 30-cut-point sweep: every cut keeps the person's canvas.
L-1: an agent's copy carries its own name and agent in state.json (and a
held copy in its entry), so a damaged catalog never files it as "Recovered
canvas N" or names it as the person's.
HIGH-2 and GM r13, 1: protection ends only on the person's own open of the
project (a `viewing` frame with `openedBy: "person"`, refused when the last
switch to it was an agent's; or `personOpen`) or their first own edit there
(`personInput`): a tab that followed an agent's switch, an agent's write and
a sync echo never end it.
GM r12, 2: the person's canvases are saved before an agent's copy, and each
waiting canvas says its own count.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from services import project_store as store_module  # noqa: E402
from tests.conftest import PERSON, PERSON_HELLO  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _rev, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import _free_a_slot, _live_values, _waiting  # noqa: E402
from tests.test_project_catalog_restore_fix8 import _restored_unsettled  # noqa: E402
from tests.test_project_catalog_restore_fix9 import _drain, _settles  # noqa: E402

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}


def _catalog(store) -> dict:
    return json.loads(store.path.read_text())


def _fresh(store):
    return store_module.canvas_pending_of(_catalog(store))["fresh"]


def _keepers(store, before) -> list[str]:
    """Every project (or Recently deleted entry) holding exactly ``before``."""
    catalog = _catalog(store)
    rows = [*catalog["projects"].values(), *(catalog.get("trash") or {}).values()]
    return [p["name"] for p in rows if sorted(_values(p)) == sorted(before)]


def _listed_fresh(client, store, graph, state, monkeypatch) -> str:
    ids = _waiting(client, store, graph, state, monkeypatch)
    _free_a_slot(client, ids[0])
    catalog = _catalog(store)
    fresh = store_module.canvas_pending_of(catalog)["fresh"]
    assert fresh and catalog["activeProjectId"] == fresh["projectId"]
    return fresh["projectId"]


def _relaunch(client, monkeypatch, state, store) -> dict:
    _restart(monkeypatch, state, store)
    main_module._forget_canvas_waiting_cache()
    return client.get("/api/projects", headers=PERSON).json()


# -- HIGH-1: review 10's sweep, as a test -----------------------------------------------------

CUTS = [f"f{i:02d}" for i in range(2, 100, 4)] + ["in-head", "before-canvasPending", "inside-canvasPending",
                                                  "before-projects", "before-trash"]


def _cut_at(raw: bytes, cut: str) -> int:
    if cut.startswith("f"):
        return len(raw) * int(cut[1:]) // 100
    if cut == "in-head":
        return raw.index(b'"commitCheck"')
    if cut == "before-canvasPending":
        return raw.index(b'"canvasPending"')
    if cut == "inside-canvasPending":
        return raw.index(b'"canvasPending"') + 40
    if cut == "before-projects":
        return raw.index(b'"projects"')
    return raw.index(b'"trash"') if b'"trash"' in raw else len(raw) - 2


@pytest.mark.parametrize("cut", CUTS)
def test_high1_every_cut_of_the_catalog_keeps_the_persons_canvas(app, monkeypatch, cut):
    """The listing filed and opened the person's waiting canvas, protected;
    then catalog.json is cut (damage: an atomic rename never tears it). After
    a restart, a listing and an agent's clear, the person's canvas is still
    exactly in a project, wherever the cut landed (review 10, HIGH-1: at
    7738ed8f, 9 of these lose it in this test; review 10 counted 10 in its
    own probe)."""
    client, store, graph, state = app
    _listed_fresh(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    raw = store.path.read_bytes()
    assert len(CUTS) == 30
    store.path.write_bytes(raw[:_cut_at(raw, cut)])
    listing = _relaunch(client, monkeypatch, state, store)
    assert listing.get("catalogRestore"), "a restore ran"
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code in (200, 409), cleared.text
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before), f"cut {cut}: the person's canvas is in no project"


def test_high1_the_record_is_written_in_the_head():
    """`canvasPending` comes right before `activeProjectId`: a head that
    still says which project is open has its protection whole too."""
    keys = store_module._HEAD_KEYS
    assert keys.index("canvasPending") + 1 == keys.index("activeProjectId")
    assert keys.index("canvasPending") < keys.index("workspaceRevision")


def test_high1_a_restore_that_lost_the_record_protects_the_reopened_project_again(app, monkeypatch):
    """The damage took the record but left the open project and its record
    (the record missing, the file cut in Recently deleted): the restore
    reopens the live canvas's project and protects it again (b), so the
    agent's clear saves it first (a missing record fails safe)."""
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    catalog = _catalog(store)
    catalog.pop("canvasPending")
    raw = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    store.path.write_bytes(raw[:raw.index(b'"trash"') + 12])
    listing = _relaunch(client, monkeypatch, state, store)
    assert listing["catalogRestore"]["damagedReadWhole"] is False
    assert _catalog(store)["activeProjectId"] == project_id
    assert (_fresh(store) or {}).get("projectId") == project_id
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["savedCanvas"]["id"] == project_id
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before) == ["Recovered canvas"]


def test_high1_a_whole_read_restore_keeps_the_damaged_files_record(app, monkeypatch):
    """A damaged catalog that parses (one record's shape is wrong): the
    restore takes the copy, and the protection the damaged file holds stays."""
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    catalog = _catalog(store)
    deleted = next(iter(catalog["trash"]))
    catalog["trash"][deleted]["snapshot"] = "not a snapshot"
    store.path.write_text(json.dumps(catalog))
    listing = _relaunch(client, monkeypatch, state, store)
    assert listing["catalogRestore"]["damagedReadWhole"] is True
    assert (_fresh(store) or {}).get("projectId") == project_id
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before) == ["Recovered canvas"]


def test_high1_only_the_live_canvass_own_project_is_protected_again(app, monkeypatch):
    """(b) protects the reopened project only when it is the live canvas's:
    another open project, or an empty canvas, is left as the restore made it."""
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    catalog = {**_catalog(store), "canvasPending": {"fresh": None, "copies": {}}}
    other = next(pid for pid in catalog["projects"] if pid != project_id)
    main_module._protect_after_restore({**catalog, "activeProjectId": other})
    assert store_module.canvas_pending_of(catalog)["fresh"] is None
    main_module._protect_after_restore(catalog)
    assert store_module.canvas_pending_of(catalog)["fresh"]["projectId"] == project_id


# -- L-1: the agent's copy is the agent's after any damage ------------------------------------

L1_CUTS = [f"f{i:02d}" for i in range(4, 100, 8)] + ["before-canvasPending", "inside-canvasPending", "before-trash"]


@pytest.mark.parametrize("cut", L1_CUTS)
def test_l1_a_damaged_catalog_never_names_the_agents_copy_as_the_persons(app, monkeypatch, cut):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    added = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "codex-x"}})
    assert added.status_code == 200, added.text
    raw = store.path.read_bytes()
    store.path.write_bytes(raw[:_cut_at(raw, cut)])
    listing = _relaunch(client, monkeypatch, state, store)
    catalog = _catalog(store)
    copies = [p for p in catalog["projects"].values() if "codex-x" in _values(p)]
    assert copies, "the copy is a project"
    for project in copies:
        assert project["name"].endswith(" copy") or " copy " in project["name"], project["name"]
    restore = listing.get("catalogRestore") or {}
    persons = [restore.get("recoveredCanvas") or {}, *(restore.get("alsoFiled") or [])]
    assert not {row.get("id") for row in persons} & {p["id"] for p in copies}
    saved = listing.get("canvasSaved") or {}
    for row in [saved, *(saved.get("filed") or [])]:
        if row.get("id") in {p["id"] for p in copies}:
            assert row.get("agentCopy") == {"agent": "Codex"}


def test_l1_the_copy_note_travels_with_the_canvas(app, monkeypatch):
    """state.json says the canvas is Codex's copy, under the name it takes;
    the note goes with the owner (inert once the canvas is another's)."""
    client, store, graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "codex-x"}})
    saved = json.loads(state.read_text())
    assert saved["projectCopy"] == {"name": "Recovered canvas copy", "agent": "Codex"}
    assert saved["projectId"] == main_module.cli_graph.owner
    reloaded = _restart(monkeypatch, state, store)
    assert reloaded.copy_note == {"of": saved["projectId"], "name": "Recovered canvas copy", "agent": "Codex"}
    client.get("/api/projects", headers=PERSON)  # filed: the canvas is that project's now
    after = json.loads(state.read_text())
    assert after["projectId"] != saved["projectId"] and "projectCopy" not in after
    filed = _catalog(store)["projects"][after["projectId"]]
    assert filed["name"] == "Recovered canvas copy"


# -- HIGH-2 and GM r13, 1: only the person's own open or edit ends it --------------------------

def _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch) -> tuple[str, list]:
    """Codex edits (the edit goes on a copy, the original closed and still
    protected), the listing files the copy and opens it; then Codex opens
    the original over HTTP."""
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    added = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "codex-x"}})
    assert added.status_code == 200 and added.json()["savedCanvas"]["id"] == project_id, added.text
    client.get("/api/projects", headers=PERSON)
    opened = client.post(f"/api/projects/{project_id}/open", headers=CODEX, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    assert _catalog(store)["activeProjectId"] == project_id and (_fresh(store) or {}).get("projectId") == project_id
    return project_id, before


def _the_original_stays_intact(client, store, before) -> None:
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["savedCanvas"]["name"] == "Recovered canvas"
    client.get("/api/projects", headers=PERSON)
    assert "Recovered canvas" in _keepers(store, before)


@pytest.mark.parametrize("frame", ["fixed-tab-viewing-null", "followed-tab-says-person", "old-tab-viewing"])
def test_high2_a_tab_that_follows_codex_onto_the_original_doesnt_end_its_protection(app, monkeypatch, frame):
    """Review 10, HIGH-2, with the person's tab connected: Codex edits, opens
    the original, the tab follows it and says what it shows; Codex clears.
    The original keeps the person's canvas. Even a tab that wrongly says the
    person opened it is refused: the last switch to it was an agent's."""
    client, store, graph, state = app
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        project_id, before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
        socket.send_json({"fixed-tab-viewing-null": {"type": "viewing", "projectId": None},
                          "followed-tab-says-person": {"type": "viewing", "projectId": project_id, "openedBy": "person"},
                          "old-tab-viewing": {"type": "viewing", "projectId": project_id}}[frame])
        assert not _settles(lambda: _fresh(store) is None, seconds=0.4)
    _the_original_stays_intact(client, store, before)


def test_high2_a_followed_tab_plus_the_persons_own_edit_ends_it(app, monkeypatch):
    client, store, graph, state = app
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        project_id, _before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
        socket.send_json({"type": "viewing", "projectId": None})
        socket.send_json({"type": "personInput", "projectId": project_id})
        assert _settles(lambda: _fresh(store) is None)
    added = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "on-it"}})
    assert added.status_code == 200 and "savedCanvas" not in added.json(), added.text


def test_high2_the_persons_own_open_of_the_loaded_project_ends_it(app, monkeypatch):
    """`personOpen`: the person opened the project already loaded in their
    tab (no request goes out): their own open, after Codex's too."""
    client, store, graph, state = app
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        project_id, _before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
        socket.send_json({"type": "personOpen", "projectId": project_id})
        assert _settles(lambda: _fresh(store) is None)


def test_high2_the_persons_open_through_nebula_then_viewing_ends_it(app, monkeypatch):
    client, store, graph, state = app
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        project_id, _before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
        opened = client.post(f"/api/projects/{project_id}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
        assert opened.status_code == 200, opened.text
        socket.send_json({"type": "viewing", "projectId": project_id, "openedBy": "person"})
        assert _settles(lambda: _fresh(store) is None)


def test_high2_an_agents_write_doesnt_end_it(app, monkeypatch):
    client, store, graph, state = app
    project_id, before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
    again = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "codex-y"}})
    assert again.status_code == 200 and again.json()["savedCanvas"]["id"] == project_id, again.text
    assert (_fresh(store) or {}).get("projectId") == project_id
    assert "Recovered canvas" in _keepers(store, before)


def test_high2_the_sync_names_the_project_an_agents_write_closed(app, monkeypatch):
    """A tab that followed Codex onto the original is told, on the sync, that
    Codex's clear closed it to keep the person's canvas in it, so it goes to
    Projects home rather than saying another window changed it. A new id per
    close; the sync keeps carrying the last one."""
    client, store, graph, state = app
    project_id, before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200 and cleared.json()["savedCanvas"]["id"] == project_id, cleared.text
    saved = client.get("/api/graph/export", headers=PERSON).json().get("personsCanvasSaved")
    assert saved and saved["projectId"] == project_id and len(saved["id"]) == 32
    assert client.get("/api/graph/export", headers=PERSON).json()["personsCanvasSaved"] == saved
    assert "Recovered canvas" in _keepers(store, before)


def test_high2_a_sync_echo_doesnt_end_it_and_is_kept(app, monkeypatch):
    """The followed tab writes the layout back (a sync echo, no person
    input): still protected, and the clear saves the canvas, echo included,
    into the original first."""
    client, store, graph, state = app
    project_id, before = _codex_copies_then_opens_the_original(client, store, graph, state, monkeypatch)
    node = next(iter(main_module.cli_graph.nodes))
    echo = client.put("/api/graph/layout", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)},
                      json={"positions": {node: {"x": 640, "y": 480}}})
    assert echo.status_code == 200, echo.text
    assert (_fresh(store) or {}).get("projectId") == project_id
    _the_original_stays_intact(client, store, before)
    original = _catalog(store)["projects"][project_id]
    placed = next(n for n in original["snapshot"]["nodes"] if n["id"] == node)
    assert placed["position"] == {"x": 640, "y": 480}


@pytest.mark.parametrize("headers", ["agent-socket", "no-hello"])
def test_high2_no_agent_sends_the_persons_acts(app, monkeypatch, headers):
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    with client.websocket_connect("/ws", headers=CODEX if headers == "agent-socket" else PERSON) as socket:
        socket.receive_json()
        if headers == "agent-socket":
            socket.send_json(PERSON_HELLO)
            _drain(socket, "personRequired")
        for kind in ("personInput", "personOpen"):
            socket.send_json({"type": kind, "projectId": project_id})
        socket.send_json({"type": "viewing", "projectId": project_id, "openedBy": "person"})
        assert not _settles(lambda: _fresh(store) is None, seconds=0.4)


# -- GM r12, 2: the person's canvas first, each line its own count ----------------------------

def test_gm12_2_each_waiting_canvas_says_its_own_count_the_persons_first(app, monkeypatch):
    client, store, graph, state = app
    _waiting(client, store, graph, state, monkeypatch)
    catalog = _catalog(store)
    copy_id = "c" * 32
    main_module._add_held({"projectId": "d" * 32, "from": copy_id, "unproven": False, "reason": "projects",
                           "since": store_module.now(), "heldAt": store_module.now(), "digest": "x", "counter": 1,
                           "nodes": [], "edges": [], "copy": {"name": "Recovered canvas copy", "agent": "Codex"}})
    view = main_module._canvas_not_filed_view(catalog=catalog)
    rows = view["canvases"]
    assert [bool(row.get("agentCopy")) for row in rows] == [False, True]
    assert rows[1]["agentCopy"] == {"agent": "Codex"}
    over = len(catalog["projects"]) - store_module.MAX_PROJECTS
    assert [row["deletes"] for row in rows] == [max(1, over + 1), max(1, over + 2)]
    assert view["deletes"] == rows[-1]["deletes"]
