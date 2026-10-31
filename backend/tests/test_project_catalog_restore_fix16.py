"""PR #199 fix round 16 (review 14, GM r21 and r22), the backend's part.

- HIGH-1: the nodes a kept tab added or duplicated have tab-local ids. Save
  as a project (POST /api/projects/recover) renumbers them to backend ids
  (``nN``) with every edge, and answers the mapping (``renumbered``), so the
  tab's later typing reaches the server and an agent's read can't put the
  old value back. A copy recover writes never holds a non-``nN`` id.
- GM r21, 3: a kept tab's wires arrive only in that snapshot. One the
  server's rules refuse is left out and reported (``droppedWires``), never
  the whole save refused.
- GM r22, 1 and GM r21, 4: the agents' restore note says "no project is
  missing" only when nothing else is said, and reports the open canvas's
  project once.
- GM r22, 5 (review 14 LOW-1, NIT-1): the kept grace starts again at boot
  when a tab kept edits before the restart, and each closed kept tab holds
  its own grace.
- The project limit on a kept save: the 413 carries ``projectCount``.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
import types
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.formatter import catalog_restore_lines  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from tests.conftest import PERSON, PERSON_HELLO  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix9 import _drain  # noqa: E402
from tests.test_project_catalog_restore_fix12 import AGENT_WRITES, CODEX, _settles  # noqa: E402

NN = re.compile(r"^n\d+$")
U1 = "0fad490a-1c2b-4d3e-8f90-a1b2c3d4e5f6"
U2 = "f2d5454b-6a7b-4c8d-9e0f-112233445566"
U3 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"


def _rev(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]


def _active(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["activeProjectId"]


def _node(node_id: str, definition_id: str, params: dict | None = None, x: float = 0) -> dict:
    return {"id": node_id, "type": "model-node", "position": {"x": x, "y": 0},
            "data": {"definitionId": definition_id, "params": params or {}, "outputs": {}}}


def _wire(edge_id: str, source: str, source_handle: str, target: str, target_handle: str) -> dict:
    return {"id": edge_id, "source": source, "sourceHandle": source_handle, "target": target,
            "targetHandle": target_handle, "type": "typed-edge"}


def _kept_snapshot(client) -> tuple[str, dict]:
    """Delta (n1, "delta-1") as the tab kept it: a Text Input added while kept
    (U1, typed into), a Combine Text added while kept (U2), wired n1 -> U2
    and U1 -> U2."""
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = client.get(f"/api/projects/{source}", headers=PERSON).json()["snapshot"]
    assert [node["id"] for node in snapshot["nodes"]] == ["n1"]
    snapshot["nodes"] += [_node(U1, "text-input", {"value": "typed-while-kept"}, 200),
                          _node(U2, "combine-text", {}, 400)]
    snapshot["edges"] += [_wire("w-n1-u2", "n1", "text", U2, "text1"),
                          _wire("w-u1-u2", U1, "text", U2, "text2")]
    return source, snapshot


def _recover(client, source: str, snapshot: dict, recovery_id: str = "e" * 32):
    return client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": recovery_id,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})


def _value(snapshot: dict, node_id: str):
    return next(node for node in snapshot["nodes"] if node["id"] == node_id)["data"]["params"].get("value")


# -- HIGH-1: renumbered at Save as a project ------------------------------------------------

def test_high1_typing_in_a_kept_node_survives_save_and_an_agents_read(app):
    client, store, _graph, _state = app
    source, snapshot = _kept_snapshot(client)
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    body = recovered.json()
    mapping = body["renumbered"]
    assert set(mapping) == {U1, U2} and all(NN.match(new) for new in mapping.values())
    assert len(set(mapping.values())) == 2 and "n1" not in mapping.values()
    copy_id = body["project"]["id"]
    saved = body["project"]["snapshot"]
    assert all(NN.match(node["id"]) for node in saved["nodes"])
    assert sorted((edge["source"], edge["target"]) for edge in saved["edges"]) == sorted(
        [("n1", mapping[U2]), (mapping[U1], mapping[U2])])

    opened = client.post(f"/api/projects/{copy_id}/open", headers=PERSON, json={"workspaceRevision": _rev(client)})
    assert opened.status_code == 200, opened.text
    graph = client.get("/api/graph", headers=PERSON).json()
    assert {node["id"] for node in graph["nodes"]} == {"n1", mapping[U1], mapping[U2]}

    # The tab's typing after the save: updateNodeData pushes params for
    # ^n\d+$ ids only (PUT /api/graph/node/{id}), then the autosave.
    typed = mapping[U1]
    assert NN.match(typed)
    pushed = client.put(f"/api/graph/node/{typed}", json={"params": {"value": "typed-while-kept after-save"}},
                        headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
    assert pushed.status_code == 200, pushed.text
    tab = client.get(f"/api/projects/{copy_id}", headers=PERSON).json()["snapshot"]
    next(node for node in tab["nodes"] if node["id"] == typed)["data"]["params"]["value"] = \
        "typed-while-kept after-save"
    autosave = client.put(f"/api/projects/{copy_id}", headers=PERSON,
                          json={"workspaceRevision": _rev(client), "snapshot": tab})
    assert autosave.status_code == 200, autosave.text

    # An agent's read of the open project, then a listing: both overlay the live canvas.
    read = client.get(f"/api/projects/{copy_id}?view=agent", headers=CODEX)
    assert read.status_code == 200, read.text
    assert client.get("/api/projects", headers=CODEX).status_code == 200

    on_disk = ProjectStore(store.root).read()["projects"][copy_id]
    assert _value(on_disk["snapshot"], typed) == "typed-while-kept after-save"
    assert all(NN.match(node["id"]) for node in on_disk["snapshot"]["nodes"])
    assert sorted((edge["source"], edge["target"]) for edge in on_disk["snapshot"]["edges"]) == sorted(
        [("n1", mapping[U2]), (mapping[U1], mapping[U2])])
    # Later nodes don't take a renumbered id.
    assert on_disk["_nodeCounter"] >= max(int(new[1:]) for new in mapping.values())
    added = client.post("/api/graph/node", json={"definitionId": "text-input", "params": {"value": "later"}},
                        headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
    assert added.status_code == 200, added.text
    assert added.json()["id"] not in {"n1", *mapping.values()}


def test_high1_a_retry_answers_the_same_mapping(app):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    first = _recover(client, source, snapshot)
    again = _recover(client, source, snapshot)
    assert first.status_code == again.status_code == 200, again.text
    assert again.json()["renumbered"] == first.json()["renumbered"] != {}
    assert again.json()["project"]["snapshot"]["nodes"] == first.json()["project"]["snapshot"]["nodes"]
    assert again.json()["droppedWires"] == first.json()["droppedWires"] == []


def test_high1_nothing_to_renumber_answers_an_empty_mapping(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = client.get(f"/api/projects/{source}", headers=PERSON).json()["snapshot"]
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["renumbered"] == {} and recovered.json()["droppedWires"] == []
    assert [node["id"] for node in recovered.json()["project"]["snapshot"]["nodes"]] == ["n1"]


def test_high1_numbered_past_the_sources_counter(app):
    client, store, *_ = app
    source, snapshot = _kept_snapshot(client)
    with store.transaction() as catalog:
        catalog["projects"][source]["_nodeCounter"] = 41
        store.commit(catalog)
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    assert sorted(recovered.json()["renumbered"].values()) == ["n42", "n43"]
    assert ProjectStore(store.root).read()["projects"][recovered.json()["project"]["id"]]["_nodeCounter"] == 43


def test_high1_the_run_history_follows_the_new_ids(app):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    recipe = {"nodes": [{"id": U1, "definitionId": "text-input", "params": {}, "outputs": {}}], "edges": []}
    snapshot["runHistory"] = [{"id": "run-1", "status": "complete", "snapshot": recipe, "targetNodeId": U1,
                               "resultOutputs": {U1: {"text": {"type": "Text", "value": "x"}}}}]
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    new = recovered.json()["renumbered"][U1]
    record = recovered.json()["project"]["snapshot"]["runHistory"][0]
    assert record["targetNodeId"] == new and list(record["resultOutputs"]) == [new]
    assert record["snapshot"]["nodes"][0]["id"] == new and record["id"] == "run-1"


@pytest.mark.parametrize("node_id", [U1, "node-1", "n", "n1a", "N2", "x7", "1"])
def test_high1_no_copy_recover_writes_holds_a_non_backend_id(app, node_id):
    """The ratchet: whatever the tab's local id looks like, the copy holds nN."""
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = client.get(f"/api/projects/{source}", headers=PERSON).json()["snapshot"]
    snapshot["nodes"].append(_node(node_id, "combine-text"))
    snapshot["edges"].append(_wire("w1", "n1", "text", node_id, "text1"))
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    on_disk = ProjectStore(store.root).read()["projects"][recovered.json()["project"]["id"]]
    assert all(NN.match(node["id"]) for node in on_disk["snapshot"]["nodes"])
    assert on_disk["snapshot"]["edges"][0]["target"] == recovered.json()["renumbered"][node_id]


def test_high1_the_invariant_refuses_a_local_id_before_the_commit(app, monkeypatch):
    """The route's own guard: a staging change that let a local id through
    fails the save with nothing written."""
    client, store, *_ = app
    source, snapshot = _kept_snapshot(client)
    monkeypatch.setattr(main_module, "_renumber_tab_local_nodes", lambda snap, counter: ({}, counter))
    before = set(store.read()["projects"])
    with pytest.raises(RuntimeError, match="node ids that aren't Nebula's"):
        _recover(client, source, snapshot)
    assert set(ProjectStore(store.root).read()["projects"]) == before


# -- GM r21, 3: a kept tab's wires the server refuses are left out and said --------------

def test_r21_3_refused_wires_are_dropped_and_reported_and_the_good_ones_kept(app):
    client, store, *_ = app
    source, snapshot = _kept_snapshot(client)
    snapshot["nodes"] += [_node("img-local", "image-input", {}, 600), _node(U3, "combine-text", {}, 800)]
    snapshot["edges"] += [
        # An Image into a Text input: incompatible.
        _wire("w-img", "img-local", "image", U3, "text1"),
        # A second wire into U2's single text1 (n1 holds it).
        _wire("w-second", U1, "text", U2, "text1"),
        # U2 -> U3 is fine; U3 -> U2 then closes a loop.
        _wire("w-u2-u3", U2, "text", U3, "text2"),
        _wire("w-loop", U3, "text", U2, "text3"),
        # The same wire twice.
        _wire("w-dup", U1, "text", U2, "text2"),
    ]
    since = main_module.canvas_events.read(after=None)["latest"]
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    body = recovered.json()
    mapping = body["renumbered"]
    dropped = {wire["id"]: wire for wire in body["droppedWires"]}
    assert set(dropped) == {"w-img", "w-second", "w-loop", "w-dup"}
    # The shared kinds (round 17: type and limit, where round 16 said contract).
    assert {wire["id"]: wire["kind"] for wire in body["droppedWires"]} == {
        "w-img": "type", "w-second": "limit", "w-loop": "loop", "w-dup": "duplicate"}
    # By the copy's ids, with the agents' detail (round 17: no person line).
    assert (dropped["w-loop"]["source"], dropped["w-loop"]["target"]) == (mapping[U3], mapping[U2])
    assert "Incompatible port types" in dropped["w-img"]["detail"]
    assert all("line" not in wire and wire["detail"] for wire in body["droppedWires"])
    kept = {edge["id"] for edge in body["project"]["snapshot"]["edges"]}
    assert kept == {"w-n1-u2", "w-u1-u2", "w-u2-u3"}
    on_disk = ProjectStore(store.root).read()["projects"][body["project"]["id"]]
    assert {edge["id"] for edge in on_disk["snapshot"]["edges"]} == kept
    # The journal says it for agents watching.
    created = [event for event in main_module.canvas_events.read(after=since, kinds={"project.created"})["events"]
               if event["data"].get("projectId") == body["project"]["id"]]
    assert {wire["id"] for wire in created[-1]["data"]["droppedWires"]} == set(dropped)
    assert "left out 4 connections" in created[-1]["summary"]


def test_r21_3_a_wire_to_a_node_that_isnt_there_is_dropped_too(app):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    snapshot["edges"].append(_wire("w-gone", U1, "text", "gone-local", "text1"))
    recovered = _recover(client, source, snapshot)
    assert recovered.status_code == 200, recovered.text
    assert [(wire["id"], wire["kind"]) for wire in recovered.json()["droppedWires"]] == [("w-gone", "missing")]


def test_r21_3_only_recover_drops_other_saves_still_refuse(app):
    """The other staging callers keep refusing a bad wire with a 400."""
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    snapshot["edges"].append(_wire("w-dup", U1, "text", U2, "text2"))
    saved = client.put(f"/api/projects/{source}", headers=PERSON,
                       json={"workspaceRevision": _rev(client), "snapshot": snapshot})
    assert saved.status_code == 400 and "Duplicate project connection" in saved.text


# -- GM r22, 1 and GM r21, 4: the agents' restore note ---------------------------------------

_DAMAGED = {"kind": "restored", "reason": "corrupt", "source": "catalog.json.bak", "damagedReadWhole": False,
            "damagedRecordsUnread": False, "projectLimit": 3}


def _left_out(*names: str) -> list[dict]:
    return [{"id": name[0].lower() * 32, "name": name, "reason": "limit"} for name in names]


def test_r22_1_never_no_project_is_missing_beside_a_left_out_project():
    record = {**_DAMAGED, "notAddedBack": _left_out("Delta"), "notAddedBackCount": 1, "notAddedBackLimitCount": 1}
    note = main_module._catalog_restore_note(record)
    cli = "\n".join(catalog_restore_lines(record))
    assert "no project is missing" not in note and "no project is missing" not in cli
    assert "so every record in it was read (damagedReadWhole: false, damagedRecordsUnread: false)" in note
    assert "after its project records: every record in it was read" in cli
    assert "\"Delta\" wasn't added back" in note


@pytest.mark.parametrize("extra", [
    {"addedBack": [{"id": "a" * 32, "name": "Alpha"}], "addedBackCount": 1},
    {"reverted": [{"id": "b" * 32, "name": "Beta"}], "revertedCount": 1},
    {"cameBack": [{"id": "c" * 32, "name": "Gamma"}], "cameBackCount": 1},
    {"recoveredCanvas": {"id": "r" * 32, "name": "Recovered canvas"}},
    {"canvasNotFiled": {"reason": "projects"}},
])
def test_r22_1_said_more_means_no_none_missing(extra):
    note = main_module._catalog_restore_note({**_DAMAGED, **extra})
    assert "no project is missing" not in note and "every record in it was read" in note


def test_r22_1_nothing_else_said_still_says_no_project_is_missing():
    note = main_module._catalog_restore_note(dict(_DAMAGED))
    assert "no project is missing" in note
    assert "no project is missing" in "\n".join(catalog_restore_lines(dict(_DAMAGED)))
    # The live canvas's reverted row isn't said to the person, so it doesn't count.
    live = {**_DAMAGED, "reverted": [{"id": "d" * 32, "name": "Delta", "liveCanvas": True}], "revertedCount": 1}
    assert "no project is missing" in main_module._catalog_restore_note(live)


def test_r22_1_the_context_part_says_what_the_listing_says():
    """`nebula context` prints catalog_restore_lines over start_here's short
    part: it carries damagedRecordsUnread, so the line agrees with the note
    (the live check found "may be missing" there beside "every record in it
    was read")."""
    from services import agent_start

    record = {**_DAMAGED, "notAddedBack": _left_out("Delta"), "notAddedBackCount": 1,
              "canvasNotFiled": {"reason": "projects"}, "note": "n"}
    part = agent_start.catalog_restore_part(record)
    assert part["damagedRecordsUnread"] is False
    lines = "\n".join(catalog_restore_lines(part))
    assert "may be missing" not in lines and "no project is missing" not in lines
    assert "after its project records: every record in it was read" in lines
    unread = agent_start.catalog_restore_part({**record, "damagedRecordsUnread": True})
    assert "may be missing" in "\n".join(catalog_restore_lines(unread))


@pytest.mark.parametrize("canvas", [{"canvasNotFiled": {"reason": "projects"}},
                                    {"recoveredCanvas": {"id": "r" * 32, "name": "Recovered canvas"}}])
def test_r21_4_the_open_canvas_project_is_said_once(canvas):
    rows = _left_out("Delta", "Epsilon")
    record = {**_DAMAGED, **canvas, "notAddedBack": rows, "notAddedBackCount": 2, "notAddedBackLimitCount": 2,
              "openProjectMissing": rows[1]["id"]}
    note = main_module._catalog_restore_note(record)
    assert "\"Delta\" wasn't added back because the project list is at its limit of 3 projects" in note
    assert "Epsilon" not in note
    assert "could not be added back" not in note


def test_r21_4_counts_leave_the_open_project_out_too():
    rows = _left_out("Alpha", "Beta", "Gamma", "Delta", "Epsilon")
    record = {**_DAMAGED, "canvasNotFiled": {"reason": "projects"}, "notAddedBack": rows,
              "notAddedBackCount": 5, "notAddedBackLimitCount": 5, "openProjectMissing": rows[4]["id"]}
    note = main_module._catalog_restore_note(record)
    assert "4 projects weren't added back because the project list is at its limit" in note
    assert "could not be added back" not in note


def test_r21_4_without_a_canvas_line_the_open_project_is_named_with_the_others():
    rows = _left_out("Delta", "Epsilon")
    record = {**_DAMAGED, "notAddedBack": rows, "notAddedBackCount": 2, "notAddedBackLimitCount": 2,
              "openProjectMissing": rows[1]["id"]}
    note = main_module._catalog_restore_note(record)
    assert "\"Delta\" and \"Epsilon\" weren't added back" in note
    assert "The project that was open didn't come back" in note


# -- GM r22, 5: the kept grace at boot and per tab -------------------------------------------

class _Clock:
    def __init__(self) -> None:
        self.ahead = 0.0

    def monotonic(self) -> float:
        return time.monotonic() + self.ahead


@pytest.fixture
def clock(monkeypatch):
    moved = _Clock()
    module = types.SimpleNamespace(**{name: getattr(time, name) for name in dir(time) if not name.startswith("_")})
    module.monotonic = moved.monotonic
    monkeypatch.setattr(main_module, "_time_module", module)
    return moved


def _manager(monkeypatch, marker: Path):
    """A backend process's ConnectionManager over ``marker`` (a restart is a new one)."""
    manager = main_module.ConnectionManager(marker)
    manager.broadcast_raw = AsyncMock()
    monkeypatch.setattr(main_module, "manager", manager)
    return manager


def _tab(client):
    socket = client.websocket_connect("/ws", headers=PERSON)
    tab = socket.__enter__()
    tab.receive_json()
    tab.send_json(PERSON_HELLO)
    _drain(tab, "proposalSync")
    return socket, tab


def _marker_says(manager) -> bool:
    """Whether the state dir's kept marker has caught up with the manager.
    The server adds the tab to kept_tabs before it writes the marker, so a
    check right after kept_tabs changes can land in between on a slow runner."""
    path = manager.kept_marker
    if path is None:
        return True
    count = manager.kept_count()
    if count == 0:
        return not path.exists()
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("keptTabs") == count
    except (OSError, ValueError, AttributeError):
        return False


def _say_kept(tab, kept: bool, manager, *, kept_now: int) -> None:
    tab.send_json({"type": "keptEdits", "kept": kept})
    assert _settles(lambda: len(manager.kept_tabs) == kept_now and _marker_says(manager))


def _refused(response) -> bool:
    return response.status_code == 409 and response.json().get("code") == "canvas_kept_in_tab"


def _restart(monkeypatch, marker: Path):
    manager = _manager(monkeypatch, marker)
    asyncio.run(main_module._kept_grace_at_boot())
    return manager


def test_r22_5_the_marker_follows_the_kept_tabs(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    manager = _manager(monkeypatch, marker)
    _create(client, "Delta")
    socket, tab = _tab(client)
    assert not marker.exists()
    _say_kept(tab, True, manager, kept_now=1)
    assert marker.exists()
    _say_kept(tab, False, manager, kept_now=0)
    assert not marker.exists()
    socket.__exit__(None, None, None)


def test_r22_5_a_restart_holds_agents_until_the_kept_tab_is_back(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    manager = _manager(monkeypatch, marker)
    _create(client, "Delta")
    socket, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    socket.__exit__(None, None, None)  # the old process goes; its socket closes
    _restart(monkeypatch, marker)
    # Right after the restart, before any tab is back: refused.
    assert _refused(AGENT_WRITES["add"](client))
    # Past the usual grace, inside the boot's: still refused.
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 1
    assert _refused(AGENT_WRITES["add"](client))
    again, tab = _tab(client)
    _say_kept(tab, True, main_module.manager, kept_now=1)
    clock.ahead = 120.0
    assert _refused(AGENT_WRITES["add"](client))
    _say_kept(tab, False, main_module.manager, kept_now=0)
    assert AGENT_WRITES["add"](client).status_code == 200
    assert not marker.exists()
    again.__exit__(None, None, None)


def test_r22_5_a_kept_tab_that_never_comes_back_lets_agents_through_after_the_grace(app, clock, monkeypatch,
                                                                                     tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    manager = _manager(monkeypatch, marker)
    _create(client, "Delta")
    socket, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    socket.__exit__(None, None, None)
    _restart(monkeypatch, marker)
    boot = main_module.KEPT_GRACE_SECONDS + main_module.KEPT_BOOT_SLACK_SECONDS
    clock.ahead = boot - 0.5
    assert _refused(AGENT_WRITES["add"](client))
    clock.ahead = boot + 0.5
    assert AGENT_WRITES["add"](client).status_code == 200
    assert not marker.exists()
    # And the next restart starts none.
    _restart(monkeypatch, marker)
    assert not main_module.manager.kept_in_tab()


def test_r22_5_no_marker_no_boot_grace(app, monkeypatch, tmp_path):
    client, *_ = app
    _create(client, "Delta")
    _restart(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    assert AGENT_WRITES["add"](client).status_code == 200


def test_r22_5_a_damaged_marker_still_holds_one_tab(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.write_text("{not json", encoding="utf-8")
    _create(client, "Delta")
    _restart(monkeypatch, marker)
    assert _refused(AGENT_WRITES["add"](client))
    assert len(main_module.manager.kept_graces) == 1


def test_r22_5_two_kept_tabs_restart_each_holds_its_own(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    manager = _manager(monkeypatch, marker)
    _create(client, "Delta")
    first, tab_a = _tab(client)
    second, tab_b = _tab(client)
    _say_kept(tab_a, True, manager, kept_now=1)
    _say_kept(tab_b, True, manager, kept_now=2)
    first.__exit__(None, None, None)
    second.__exit__(None, None, None)
    _restart(monkeypatch, marker)
    assert len(main_module.manager.kept_graces) == 2
    # One comes back and saves: the other's grace still holds.
    again, tab = _tab(client)
    _say_kept(tab, True, main_module.manager, kept_now=1)
    _say_kept(tab, False, main_module.manager, kept_now=0)
    assert _refused(AGENT_WRITES["add"](client))
    clock.ahead = main_module.KEPT_GRACE_SECONDS + main_module.KEPT_BOOT_SLACK_SECONDS + 0.5
    assert AGENT_WRITES["add"](client).status_code == 200
    again.__exit__(None, None, None)


def test_nit1_one_tabs_kept_false_never_clears_another_tabs_grace(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    _create(client, "Delta")
    first, tab_a = _tab(client)
    second, tab_b = _tab(client)
    _say_kept(tab_a, True, manager, kept_now=1)
    _say_kept(tab_b, True, manager, kept_now=2)
    first.__exit__(None, None, None)  # tab A blips
    assert _settles(lambda: len(manager.kept_tabs) == 1)
    _say_kept(tab_b, False, manager, kept_now=0)  # tab B saves as a project
    clock.ahead = main_module.KEPT_GRACE_SECONDS - 1
    assert _refused(AGENT_WRITES["add"](client))
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 0.5
    assert AGENT_WRITES["add"](client).status_code == 200
    second.__exit__(None, None, None)


# -- The project limit on a kept save --------------------------------------------------------

@pytest.mark.parametrize("limit, count", [(2, 2), (1, 2)])
def test_a_kept_save_past_the_limit_says_the_limit_and_the_count(app, monkeypatch, limit, count):
    client, *_ = app
    source, snapshot = _kept_snapshot(client)
    _create(client, "Echo")
    assert len(client.get("/api/projects", headers=PERSON).json()["projects"]) == count
    monkeypatch.setattr(store_module, "MAX_PROJECTS", limit)
    refused = _recover(client, source, snapshot)
    assert refused.status_code == 413, refused.text
    assert refused.json() == {"detail": "Project limit reached", "limit": "projects", "projectLimit": limit,
                              "projectCount": count}


def test_nit1_a_tab_back_that_saves_ends_its_own_grace_at_once(app, clock, monkeypatch, tmp_path):
    """Back within its grace (kept:true), then Save as a project (kept:false):
    agents go on at once, not when the closed socket's grace runs out."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    _create(client, "Delta")
    socket, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    socket.__exit__(None, None, None)
    assert _settles(lambda: not manager.kept_tabs)
    clock.ahead = 1.0
    again, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    _say_kept(tab, False, manager, kept_now=0)
    assert not manager.kept_graces
    assert AGENT_WRITES["add"](client).status_code == 200
    again.__exit__(None, None, None)


def test_nit1_a_tab_back_takes_the_grace_ending_first(app, clock, monkeypatch, tmp_path):
    """Two kept tabs blip, 5 s apart; one comes back and saves: the later
    grace (the longest another closed tab may still need) keeps running."""
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    _create(client, "Delta")
    first, tab_a = _tab(client)
    second, tab_b = _tab(client)
    _say_kept(tab_a, True, manager, kept_now=1)
    _say_kept(tab_b, True, manager, kept_now=2)
    first.__exit__(None, None, None)
    assert _settles(lambda: len(manager.kept_tabs) == 1)
    clock.ahead = 5.0
    second.__exit__(None, None, None)
    assert _settles(lambda: not manager.kept_tabs)
    clock.ahead = 6.0
    again, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    _say_kept(tab, False, manager, kept_now=0)
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 2  # past the first grace, inside the second
    assert _refused(AGENT_WRITES["add"](client))
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 5.5
    assert AGENT_WRITES["add"](client).status_code == 200
    again.__exit__(None, None, None)
