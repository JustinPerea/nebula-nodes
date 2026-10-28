"""PR #199 fix round 9 (review 9, GM r10 and GM r11).

M-1: the person's canvas's protection is written in the same catalog commit
as its filing (the catalog's `canvasPending`), in the protect and in the
listing's settle, so a failed state.json write or a crash after the commit
never leaves a filed project open and unprotected (review 9's P3/P7 probes).
GM r11, 2: the protection ends for good once the person's tab is on the
project and connected (the person-promoted socket's `viewing` frame); an
agent can't end it. M-2: the CLI prints GM's saved-canvas reply. L-3 and
the nits; GM r10's order and duplicate names; GM r11, 4: the agent's copy
named as the agent's.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.client import NebulaClient  # noqa: E402
from cli.commands import graph as graph_commands  # noqa: E402
from cli.formatter import format_applied  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.canvas_undo import CanvasUndoBook  # noqa: E402
from services.project_store import ProjectStore, ProjectStoreError  # noqa: E402
from tests.conftest import PERSON, PERSON_HELLO  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _rev, _values, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix3 import _restart  # noqa: E402
from tests.test_project_catalog_restore_fix5 import (  # noqa: E402
    _free_a_slot, _live_values, _make_room_without_listing, _waiting,
)
from tests.test_project_catalog_restore_fix8 import _restored_unsettled  # noqa: E402

CODEX = {**PERSON, "X-Nebula-Agent": "Codex"}


def _catalog(store) -> dict:
    return json.loads(store.path.read_text())


def _keepers(store, before) -> list[str]:
    return [p["name"] for p in _catalog(store)["projects"].values() if sorted(_values(p)) == sorted(before)]


def _fresh(store):
    return store_module.canvas_pending_of(_catalog(store))["fresh"]


def _fresh_if_kept(store):
    """The catalog's fresh record, or True where no catalog keeps one (so the
    data checks below still run against an older build)."""
    return _fresh(store) if hasattr(store_module, "canvas_pending_of") else True


# -- M-1: the protection is committed with the filing (review 9's P3 and P7) ---------------

@pytest.mark.parametrize("action", ["add", "clear"])
def test_m1_p3_the_protects_owner_write_fails_and_the_project_stays_protected(app, monkeypatch, action):
    """The protect committed the filing; its state.json write then fails (a
    507, or the process dies there). After a restart and a listing the
    project is open again, still protected: the agent's clear files nothing
    and empties nothing of the person's."""
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    real = main_module._set_canvas_owner
    seen = {"n": 0}

    def flaky(owner):
        seen["n"] += 1
        if seen["n"] == 2:  # the first is _file_live_canvas's, the second the protect's
            raise ProjectStoreError("power cut (test)")
        return real(owner)
    monkeypatch.setattr(main_module, "_set_canvas_owner", flaky)
    if action == "add":
        client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "codex-x"}})
    else:
        client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    monkeypatch.setattr(main_module, "_set_canvas_owner", real)
    filed = _fresh_if_kept(store)
    assert filed is True or _catalog(store)["projects"][filed["projectId"]]["name"] == "Recovered canvas"
    _restart(monkeypatch, state, store)
    main_module._forget_canvas_waiting_cache()
    client.get("/api/projects", headers=PERSON)
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before) == ["Recovered canvas"]


def test_m1_p7_the_protects_owner_write_fails_with_no_restart(app, monkeypatch):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    real = main_module._set_canvas_owner
    seen = {"n": 0}

    def flaky(owner):
        seen["n"] += 1
        if seen["n"] == 2:
            raise ProjectStoreError("disk full (test)")
        return real(owner)
    monkeypatch.setattr(main_module, "_set_canvas_owner", flaky)
    first = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "x"}})
    assert first.status_code == 507, first.text
    monkeypatch.setattr(main_module, "_set_canvas_owner", real)
    client.get("/api/projects", headers=PERSON)
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["savedCanvas"]["name"] == "Recovered canvas"
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before) == ["Recovered canvas"]


def test_m1_p7_the_process_dies_after_the_listings_filing_commit(app, monkeypatch):
    """The listing filed and opened the waiting canvas, its waiting record
    went, and the process died before the rest of the bookkeeping after its
    commit (review 9's crash-before-fresh-write): the protection is in that
    commit."""
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    real_note = main_module._note_canvas_settled
    monkeypatch.setattr(main_module, "_note_canvas_settled", lambda settled: main_module._canvas_settled_off_waiting())
    _free_a_slot(client, ids[0])
    monkeypatch.setattr(main_module, "_note_canvas_settled", real_note)
    assert _fresh_if_kept(store) is not None
    _restart(monkeypatch, state, store)
    main_module._forget_canvas_waiting_cache()
    client.get("/api/projects", headers=PERSON)
    # Opened again as it was, never filed a second time.
    assert sorted(p["name"] for p in _catalog(store)["projects"].values()) == ["B", "C", "Recovered canvas"]
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    client.get("/api/projects", headers=PERSON)
    assert _keepers(store, before) == ["Recovered canvas"]


def test_m1_the_pending_record_lives_in_the_catalog_only():
    from services import catalog_recovery

    assert "canvasPending" in catalog_recovery.CATALOG_FIELDS
    assert not hasattr(ProjectStore, "set_canvas_pending") and not hasattr(main_module, "_note_fresh_filing")


# -- GM r11, 2: protection ends once the person's tab is on the project ------------------

def _listed_fresh(client, store, graph, state, monkeypatch) -> str:
    ids = _waiting(client, store, graph, state, monkeypatch)
    _free_a_slot(client, ids[0])
    fresh = _fresh(store)
    assert fresh and _catalog(store)["activeProjectId"] == fresh["projectId"]
    return fresh["projectId"]


def _drain(socket, until: str) -> None:
    for _ in range(12):
        if socket.receive_json().get("type") == until:
            return
    raise AssertionError(f"no {until}")


def _settles(check, seconds: float = 3.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return check()


def test_gm11_2_the_persons_tab_on_the_project_ends_its_protection_for_good(app, monkeypatch):
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        socket.receive_json()
        socket.send_json(PERSON_HELLO)
        _drain(socket, "proposalSync")
        socket.send_json({"type": "viewing", "projectId": project_id})
        assert _settles(lambda: _fresh(store) is None)
    # The tab closed: protection doesn't come back, and the agent's add
    # lands on the project itself, the person's working project again.
    added = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "on-it"}})
    assert added.status_code == 200, added.text
    assert "savedCanvas" not in added.json()
    assert _catalog(store)["activeProjectId"] == project_id
    assert "on-it" in _values(_catalog(store)["projects"][project_id]) or "on-it" in _live_values(main_module.cli_graph)


@pytest.mark.parametrize("how", ["agent-socket-with-hello", "socket-without-hello", "wrong-project", "agent-open"])
def test_gm11_2_an_agent_cant_end_the_protection(app, monkeypatch, how):
    client, store, graph, state = app
    project_id = _listed_fresh(client, store, graph, state, monkeypatch)
    before = _live_values(main_module.cli_graph)
    if how == "agent-open":
        opened = client.post(f"/api/projects/{project_id}/open", headers=CODEX, json={"workspaceRevision": _rev(client)})
        assert opened.status_code in (200, 409), opened.text
    else:
        headers = CODEX if how == "agent-socket-with-hello" else PERSON
        with client.websocket_connect("/ws", headers=headers) as socket:
            socket.receive_json()
            if how != "socket-without-hello":
                socket.send_json(PERSON_HELLO)
                _drain(socket, "personRequired" if how == "agent-socket-with-hello" else "proposalSync")
            socket.send_json({"type": "viewing", "projectId": "f" * 32 if how == "wrong-project" else project_id})
            socket.send_json({"type": "viewing", "projectId": project_id} if how == "wrong-project" else {"type": "x"})
            if how == "wrong-project":
                # The person's own tab on it ends it; the wrong id before it didn't.
                assert _settles(lambda: _fresh(store) is None)
                return
            time.sleep(0.3)
    assert _fresh(store) is not None and _fresh(store)["projectId"] == project_id
    cleared = client.request("DELETE", "/api/graph?force=true", headers=CODEX)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["savedCanvas"]["name"] == "Recovered canvas"
    assert _keepers(store, before) == ["Recovered canvas"]


def test_gm11_2_no_http_route_ends_it():
    import inspect

    source = inspect.getsource(main_module)
    # The one writer of fresh=None after a filing is the person's socket frame.
    assert source.count('{**pending, "fresh": None}') == 1
    assert "_person_tab_viewing(frame.get(\"projectId\"))" in source


# -- M-2: the CLI prints GM's reply ------------------------------------------------------

def _cli(client) -> NebulaClient:
    cli = NebulaClient("http://testserver")
    cli._client = client
    return cli


@pytest.mark.parametrize("command", ["create", "set", "delete", "connect-less-apply", "clear"])
def test_m2_every_cli_printer_prints_gms_saved_canvas_line(app, monkeypatch, capsys, command):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Codex")
    cli = _cli(client)
    first = sorted(main_module.cli_graph.nodes)[0]
    if command == "create":
        graph_commands.run_create(cli, "text-input", {"value": "c"})
        action = "Created node "
        gm = "and made your change on a copy of it."
    elif command == "set":
        graph_commands.run_set(cli, first, {"value": "v"})
        action = f"Updated {first}: value=v"
        gm = "and made your change on a copy of it."
    elif command == "delete":
        graph_commands.run_delete(cli, [first])
        action = "Deleted "
        gm = "and made your change on a copy of it."
    elif command == "connect-less-apply":
        print(format_applied(cli.apply({"note": "x", "nodes": [
            {"ref": "+a", "definitionId": "text-input", "params": {"value": "a"}}]}, agent_name="Codex")))
        action = "Applied: "
        gm = "and made your change on a copy of it."
    else:
        graph_commands.run_clear(cli, force=True)
        action = "Canvas cleared ("
        gm = "and cleared a new canvas."
    printed = capsys.readouterr().out.splitlines()
    start = next(index for index, line in enumerate(printed) if line.startswith(action))
    lines = printed[start:start + 2]  # the backend's own log lines are around them
    assert lines[1] == f"Nebula saved the open canvas as its own project, “Recovered canvas”, {gm}", lines
    # GM's line takes the clear's Undo sentence's place (review 9, M-2).
    assert "Cmd-Z" not in "\n".join(lines)


def test_m2_without_a_saved_canvas_the_printers_say_what_they_said(app, capsys):
    client, *_ = app
    cli = _cli(client)
    graph_commands.run_create(cli, "text-input", {"value": "c"})
    graph_commands.run_clear(cli, force=True)
    out = [line for line in capsys.readouterr().out.splitlines() if not line.startswith("[")]
    assert out[0].startswith("Created node ") and len(out) == 2
    assert out[1] == "Canvas cleared (1 node removed). The person can undo it on an open canvas (Undo, or Cmd-Z)."


# -- GM r10, 3: the copy that has to wait is said at the time ----------------------------

def test_gm10_3_the_edit_reply_says_the_copy_waits(app, monkeypatch):
    client, store, graph, state = app
    ids = _waiting(client, store, graph, state, monkeypatch)
    _make_room_without_listing(client, store, ids[0])
    response = client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e"}})
    assert response.status_code == 200, response.text
    saved = response.json()["savedCanvas"]
    assert saved["copyWaits"] == "projects"
    assert saved["message"] == ("Nebula saved the open canvas as its own project, “Recovered canvas”, and made your "
                                "change on a copy of it. The copy isn't saved as a project yet because the project "
                                "limit is reached.")
    assert main_module.CANVAS_COPY_WAITS["storage"] == (
        "The copy isn't saved as a project yet because Nebula's project list is full.")
    # GM r11, 4: the waiting copy is the agent's in the listing, never the person's.
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing["canvasNotFiled"]["canvases"] == [{"name": None, "agentCopy": {"agent": "Codex"}}]


# -- GM r11, 4 and GM r10: the copy named as the agent's, in saved order -------------------

def test_gm11_4_the_copy_filed_while_the_notice_shows_is_the_agents(app, monkeypatch):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    assert client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e1"}}).status_code == 200
    listing = client.get("/api/projects", headers=PERSON).json()
    restore = listing["catalogRestore"]
    assert restore["recoveredCanvas"]["name"] == "Recovered canvas" and "agentCopy" not in restore["recoveredCanvas"]
    (copy,) = restore["agentCopies"]
    assert copy["name"] == "Recovered canvas copy" and copy["agentCopy"] == {"agent": "Codex"} and copy["filedAt"]
    assert not restore.get("alsoFiled") and listing.get("canvasSaved") is None
    # Its record left the catalog in the commit that filed it.
    assert store_module.canvas_pending_of(_catalog(store))["copies"] == {}


def test_gm10_the_shared_duplicate_name_helper():
    catalog = {"projects": {"a": {"name": "Hero"}, "b": {"name": "Hero copy"}}, "trash": {"c": {"name": "Hero copy 2"}}}
    assert store_module.duplicate_name("Hero", catalog) == "Hero copy 3"
    assert store_module.duplicate_name("Hero", {"projects": {}}) == "Hero copy"
    assert store_module.duplicate_name("Hero", {"projects": {}}, taken=["Hero copy"]) == "Hero copy 2"


# -- nits ---------------------------------------------------------------------------------

INVERSE = {"added": [{"id": "n9"}], "removed": [], "changed": [], "renamed": [], "moved": [], "addedWires": [],
           "removedWires": [], "ready": []}


def test_nit4_rehome_moves_only_the_copys_edits():
    book = CanvasUndoBook()
    actor = {"kind": "agent", "name": "Codex"}
    older = book.keep(edit_id="e1", actor=actor, agent_id="codex", project_id=None, project_name="",
                      inverse=INVERSE)["token"]
    since = book.mark()
    newer = book.keep(edit_id="e2", actor=actor, agent_id="codex", project_id=None, project_name="",
                      inverse=INVERSE)["token"]
    book.rehome(None, "p" * 32, "Recovered canvas copy", since=since)
    assert book.take(newer, agent_id="codex", project_id="p" * 32).project_name == "Recovered canvas copy"
    assert book.take(older, agent_id="codex", project_id=None).project_id is None


def test_nit3_copies_that_no_longer_exist_are_dropped(app, monkeypatch):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    with store.transaction() as catalog:
        main_module._set_canvas_copies(catalog, add=("d" * 32, {"name": "Gone copy", "agent": "Codex", "mark": 0, "boot": "x"}))
        store.commit(catalog)
    assert "d" * 32 in store_module.canvas_pending_of(_catalog(store))["copies"]
    assert client.post("/api/graph/node", headers=CODEX, json={"definitionId": "text-input", "params": {"value": "e"}}).status_code == 200
    copies = store_module.canvas_pending_of(_catalog(store))["copies"]
    assert "d" * 32 not in copies and len(copies) == 1


def test_nit2_a_new_loss_after_the_note_was_closed_counts_only_itself(tmp_path):
    store = ProjectStore(tmp_path / "projects")
    store._ensure_held_dir()
    store._note_held_lost(2, ["canvas-held/a.damaged-20261028T000000Z-0000aaaa"])
    store._held_note = {**store._held_note, "dismissedAt": store._held_note["at"]}
    store._note_held_lost(1, ["canvas-held/b.damaged-20261028T000001Z-0000bbbb"])
    assert store._held_note["count"] == 1
    assert store._held_note["kept"] == ["canvas-held/a.damaged-20261028T000000Z-0000aaaa",
                                        "canvas-held/b.damaged-20261028T000001Z-0000bbbb"]


def test_l3_a_damaged_note_never_lets_pruning_delete_a_kept_file(tmp_path, monkeypatch):
    store = ProjectStore(tmp_path / "projects")
    store._ensure_held_dir()
    monkeypatch.setattr(store_module, "DAMAGED_KEPT_MIN", 1)
    monkeypatch.setattr(store_module, "DAMAGED_KEPT_DAYS", 0)
    kept = []
    for second in range(4):
        path = store.held_dir / f"{'e' * 32}.json.damaged-20200101T00000{second}Z-0000000{second}"
        path.write_text("{}")
        kept.append(path)
    (store.held_dir / store_module.CANVAS_HELD_NOTE_NAME).write_text("not json")
    note = store._read_held_note()
    assert note is not None and note["count"] is None
    store._held_note = note
    store._prune_held_kept()
    assert all(path.exists() for path in kept)
    assert {f"canvas-held/{path.name}" for path in kept} <= set(note["kept"])


# -- GM r11, 5: the graphSync says the restore ------------------------------------------

def test_gm11_5_the_graph_sync_carries_the_restore_notice(app, monkeypatch):
    client, store, _graph, state = app
    _restored_unsettled(client, store, state, monkeypatch)
    listing = client.get("/api/projects", headers=PERSON).json()
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        sync = socket.receive_json()
    assert sync["type"] == "graphSync" and sync["catalogRestore"] == listing["catalogRestore"]["id"]
    assert client.post("/api/projects/catalog-restore/dismiss", headers=PERSON,
                       json={"id": listing["catalogRestore"]["id"]}).json() == {"dismissed": True}
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        assert "catalogRestore" not in socket.receive_json()


# -- GM r11, 3: the person's refusal lines are gone ---------------------------------------

def test_gm11_3_the_persons_refusal_lines_are_dropped():
    assert not hasattr(main_module, "canvas_waiting_person_reason")
    refusal = main_module.CanvasWaitingRefusal("projects", "clear")
    assert refusal.detail == main_module.CANVAS_WAITING_REFUSAL
    assert "audience" not in main_module._canvas_waiting_body(refusal)
