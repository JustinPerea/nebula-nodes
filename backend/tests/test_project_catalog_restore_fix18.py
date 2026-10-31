"""PR #199 fix round 18 (review 16; GM r25 and r26), the backend's part.

- HIGH-1 (both lenses): an agent's reopen of the project the tab shows
  renumbers a duplicated or pasted node (U -> n2), and the tab's handoff,
  taken before the open, still holds U. The handoff now learns the open's
  {old: new}: one n2 with the tab's late typing, on disk and live.
- MEDIUM-1: the boot renumbering takes the project's newer values, numbers
  past every id the project used, and reloads a tab from before the boot.
- NIT-1 (renumber-everywhere): CLIGraph itself refuses a non-nN id.
- NIT-3: the boot's renumbering rides on first syncs only until a
  replacement or the person's read of the project.
- kept-ui-rules NIT-3: imported output types read the shared port rule.
- agents-grace NIT-1 and NIT-2: the kept marker in a folder Nebula can't
  write, and a directory where it goes.
- GM r25 5: copy names never say "copy 2 2" or "Recovered" twice.
- GM r26: agents are never offered a tab-local id in the selection.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.formatter import format_selection  # noqa: E402
from services import cli_graph as cli_graph_module  # noqa: E402
from services import port_contracts  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph, ForeignNodeIdError  # noqa: E402
from services.selection_context import selection_prompt_context  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import CODEX  # noqa: E402
from tests.test_project_catalog_restore_fix16 import _node, _wire  # noqa: E402
from tests.test_project_catalog_restore_fix17 import (  # noqa: E402
    DUP, NN, P1, _agent_read_and_listing, _autosave, _export_ids, _on_disk, _open, _rev, _stored, _value)

ROOT = Path(__file__).resolve().parent.parent.parent
# The person's canvas tab: every write it sends carries its tab id.
TAB = {**PERSON, "X-Nebula-Tab": "tab-r18-backend"}


@pytest.fixture(autouse=True)
def _no_boot_renumbering():
    main_module._boot_renumbered.clear()
    main_module._boot_replacement.clear()
    yield
    main_module._boot_renumbered.clear()
    main_module._boot_replacement.clear()


def _vals(snapshot: dict) -> list[tuple[str, object]]:
    return sorted((node["id"], node["data"]["params"].get("value")) for node in snapshot["nodes"])


def _live(client) -> dict[str, dict]:
    exported = client.get("/api/graph/export", headers=PERSON).json()
    return {node["id"]: node for node in exported["nodes"]}


def _agent_look(client) -> list[str]:
    return sorted(node.get("id") for node in client.get("/api/canvas/snapshot", headers=CODEX).json().get("nodes", []))


def _delta_with_a_duplicate(client, value: str = "dup-old") -> tuple[str, dict, str]:
    """Delta (n1 "delta-1") and a duplicated node (DUP, tab-local) the tab
    autosaved with ``value``. Returns (delta, the autosaved snapshot, the
    revision the tab holds)."""
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": value}, 300))
    _autosave(client, delta, tab)
    return delta, tab, _rev(client)


def _held(tab: dict, **values: str) -> dict:
    held = json.loads(json.dumps(tab))
    for node in held["nodes"]:
        if node["id"] in values:
            node["data"]["params"]["value"] = values[node["id"]]
    return held


def _handoff(client, project_id: str, revision: str, snapshot: dict, headers=TAB, **more):
    return client.put(f"/api/projects/{project_id}", headers=headers,
                      json={"workspaceRevision": revision, "snapshot": snapshot, **more})


def _lands_once(client, store, delta: str, new: str, value: str) -> None:
    final = _on_disk(store, delta)["snapshot"]
    assert [node_id for node_id, _ in _vals(final)] == sorted(["n1", new]), _vals(final)
    assert _value(final, new) == value
    assert _live(client)[new]["data"]["params"]["value"] == value
    _agent_read_and_listing(client, delta)
    final = _on_disk(store, delta)["snapshot"]
    assert sorted(node["id"] for node in final["nodes"]) == sorted(_export_ids(client)) == _agent_look(client)
    assert _value(final, new) == value
    assert [value for _, value in _vals(_stored(client, delta))].count(value) == 1
    again = _open(client, delta)
    assert again.status_code == 200, again.text
    assert again.json()["renumbered"] == {}


# -- HIGH-1: the handoff learns the open's ids --------------------------------------------

def test_high1_an_agents_reopen_lands_the_tabs_late_typing_on_one_node(app):
    """Review 16 renumber-everywhere's RE16 (typing variant)."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    opened = _open(client, delta, headers=CODEX)
    assert opened.status_code == 200, opened.text
    new = opened.json()["renumbered"][DUP]
    handoff = _handoff(client, delta, old_rev, _held(tab, **{DUP: "dup-new"}))
    assert handoff.status_code == 200 and handoff.json()["handoff"] is True, handoff.text
    _lands_once(client, store, delta, new, "dup-new")


def test_high1_the_agents_grace_probe_p2_lands_on_the_new_id(app):
    """Review 16 agents-grace's P2: the tab's autosave built before the
    renumbering lands after it."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client, "dup")
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    late = _handoff(client, delta, old_rev, _held(tab, **{DUP: "dup typed late"}))
    assert late.status_code == 200 and late.json()["handoff"] is True, late.text
    _lands_once(client, store, delta, new, "dup typed late")


def test_high1_a_move_only_handoff_doesnt_double_the_node(app):
    """RE16C: the only unsaved change is n1 moved by 30 px."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _held(tab)
    next(node for node in held["nodes"] if node["id"] == "n1")["position"]["x"] += 30
    assert _handoff(client, delta, old_rev, held).status_code == 200
    _lands_once(client, store, delta, new, "dup-old")


def test_high1_a_snapshot_the_tab_already_moved_to_the_new_ids_lands_the_same(app):
    """The tab remaps its snapshot by the switch sync's ``renumbered`` too:
    a snapshot that already holds n2 (and lists it as unsent) lands once."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    held = _held(tab, **{DUP: "dup-new"})
    main_module._apply_node_renumbering(held, {DUP: new})
    answer = _handoff(client, delta, old_rev, held, pendingParams={new: {"value": "dup-new"}})
    assert answer.status_code == 200, answer.text
    _lands_once(client, store, delta, new, "dup-new")


def test_high1_unsent_lists_under_the_old_id_move_with_it(app):
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    held = _held(tab, **{DUP: "dup-new"})
    next(node for node in held["nodes"] if node["id"] == DUP)["data"]["label"] = "Late name"
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    answer = _handoff(client, delta, old_rev, held, pendingParams={DUP: {"value": "dup-new"}},
                      pendingLabels={DUP: "Late name"})
    assert answer.status_code == 200, answer.text
    assert _live(client)[new]["data"].get("label") == "Late name"
    _lands_once(client, store, delta, new, "dup-new")


def test_high1_a_renumbered_nodes_late_move_and_name_land_too(app):
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    held = _held(tab)
    late = next(node for node in held["nodes"] if node["id"] == DUP)
    late["position"] = {"x": 640, "y": 80}
    late["data"]["label"] = "Moved name"  # never listed as unsent: the tab never sent this node anything
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    assert _handoff(client, delta, old_rev, held).status_code == 200
    stored = next(node for node in _on_disk(store, delta)["snapshot"]["nodes"] if node["id"] == new)
    assert stored["position"] == {"x": 640, "y": 80} and stored["data"].get("label") == "Moved name"
    assert _live(client)[new]["position"] == {"x": 640, "y": 80}
    assert _live(client)[new]["data"].get("label") == "Moved name"


def test_high1_a_handoff_from_anyone_but_the_persons_tab_keeps_the_stored_copy(app):
    """The renumbered node's values are the tab's unsent ones only from the
    person's tab, as the unsent lists are; anyone else's save (the agent
    that switched, holding the old revision) doubles nothing either."""
    client, store, *_ = app
    delta, tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    answer = _handoff(client, delta, old_rev, _held(tab, **{DUP: "agent typed"}), headers=CODEX)
    assert answer.status_code == 200, answer.text
    final = _on_disk(store, delta)["snapshot"]
    assert _vals(final) == sorted([("n1", "delta-1"), (new, "dup-old")])
    assert _live(client)[new]["data"]["params"]["value"] == "dup-old"


def test_high1_the_open_lists_the_renumbered_nodes_as_nebulas(app):
    """Review 16 NIT-2's B13: at the open the new ids are Nebula's nodes
    (_backendNodeIds), so an agent's delete of one isn't undone by the next
    read, which would keep it as a node only the tab had."""
    client, store, *_ = app
    delta, _tab, _old = _delta_with_a_duplicate(client)
    _create(client, "Alpha")
    new = _open(client, delta).json()["renumbered"][DUP]
    assert new in _on_disk(store, delta)["_backendNodeIds"]
    assert client.delete(f"/api/graph/node/{new}", headers=CODEX).status_code == 200
    _agent_read_and_listing(client, delta)
    assert [node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]] == ["n1"]


def test_high1_the_handoffs_renumbering_ends_with_the_handoff(app):
    client, store, *_ = app
    delta, _tab, old_rev = _delta_with_a_duplicate(client)
    new = _open(client, delta, headers=CODEX).json()["renumbered"][DUP]
    kept = _on_disk(store, delta)[main_module._HANDOFF_RENUMBERED]
    assert kept == {"revision": old_rev, "map": {DUP: new}}
    _create(client, "Alpha")  # the person's own switch ends every handoff
    assert main_module._HANDOFF_RENUMBERED not in _on_disk(store, delta)


def test_high1_a_renumbering_is_read_only_for_its_own_handoff():
    """The map belongs to the handoff at one revision: a save holding any
    other revision (a stale tab's, a later handoff's) gets none of it."""
    project = {main_module._HANDOFF_RENUMBERED: {"revision": "r1", "map": {DUP: "n2", P1: "not-an-id"}}}
    assert main_module._handoff_renumbering(project, "r1") == {DUP: "n2"}
    assert main_module._handoff_renumbering(project, "r2") == {}
    assert main_module._handoff_renumbering({}, "r1") == {}


# -- MEDIUM-1: the boot renumbering ---------------------------------------------------------

def _legacy_state(client, store, state: Path, *, live_value: str, project_value: str,
                  label: str | None = None, position: dict | None = None, history: list | None = None) -> str:
    """Delta as main left it after a reopen: state.json holds the duplicated
    node's uuid with the value it had then; the project (autosaved since)
    holds newer typing, with the uuid in ``_backendNodeIds``."""
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    client.get("/api/projects", headers=PERSON)
    saved = json.loads(state.read_text())
    saved["nodes"].append({"id": DUP, "definitionId": "text-input", "params": {"value": live_value},
                           "outputs": {}, "position": {"x": 1, "y": 1}})
    state.write_text(json.dumps(saved))
    with store.transaction() as catalog:
        project = catalog["projects"][delta]
        node = _node(DUP, "text-input", {"value": project_value}, 300)
        if label:
            node["data"]["label"] = label
        if position:
            node["position"] = position
        project["snapshot"]["nodes"].append(node)
        if history is not None:
            project["snapshot"]["runHistory"] = history
        project["_backendNodeIds"] = sorted({*project.get("_backendNodeIds", []), DUP})
        store.commit(catalog)
    return delta


def _boot(state: Path) -> CLIGraph:
    loaded = CLIGraph(persist_path=state)
    loaded.load(state)
    main_module.cli_graph.nodes, main_module.cli_graph.edges = loaded.nodes, loaded.edges
    main_module.cli_graph._counter = loaded._counter
    main_module.cli_graph.owner = loaded.owner
    main_module.cli_graph.renumbered_on_load = loaded.renumbered_on_load
    asyncio.run(main_module._renumber_live_canvas_at_boot())
    return loaded


def test_medium1_boot_renumber_prefers_the_projects_typing_over_state_json(app):
    """Review 16 renumber-everywhere's test, as it was written."""
    client, store, _graph, state = app
    delta = _legacy_state(client, store, state, live_value="dup-first", project_value="dup-first dup-second")
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    assert _live(client)[new]["data"]["params"]["value"] == "dup-first dup-second"
    assert json.loads(state.read_text())["nodes"][-1]["params"]["value"] == "dup-first dup-second"
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], new) == "dup-first dup-second"


def test_medium1_boot_takes_the_projects_name_and_place(app):
    client, store, _graph, state = app
    _legacy_state(client, store, state, live_value="a", project_value="b", label="Hero line",
                  position={"x": 420, "y": 96})
    _boot(state)
    node = _live(client)[main_module._boot_renumbered[DUP]]
    assert node["data"].get("label") == "Hero line" and node["position"] == {"x": 420, "y": 96}


def test_medium1_boot_numbers_past_every_id_the_project_ever_used(app):
    """state.json's counter is 1; the project's run history names n7 (a node
    deleted since). load() alone gave the uuid n2."""
    client, store, _graph, state = app
    history = [{"id": "r1", "nodeId": "n7", "outputs": {"n7": {}}}]
    delta = _legacy_state(client, store, state, live_value="a", project_value="b", history=history)
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    assert int(new[1:]) > 7
    assert set(_live(client)) == {"n1", new}
    assert {node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]} == {"n1", new}
    assert main_module.cli_graph._counter >= int(new[1:])


def test_medium1_the_first_sync_after_a_boot_renumber_reloads_a_tab_from_before_it(app):
    """The first sync is a reopen of the open project in Nebula's name, under
    a new revision; the old tab's handoff (old revision, the uuid, typing it
    never sent) lands on the new id; the person's read of the project ends it."""
    client, store, _graph, state = app
    delta = _legacy_state(client, store, state, live_value="dup-first", project_value="dup-first dup-second")
    before = _rev(client)
    _boot(state)
    new = main_module._boot_renumbered[DUP]
    after = _rev(client)
    assert after != before
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        first = socket.receive_json()
    assert first["type"] == "graphSync" and first["graphReplaced"] is True
    assert first["workspaceRevision"] == after and first["renumbered"] == {DUP: new}
    assert first["projectSwitch"] == {"actor": {"kind": "system"}, "previousProjectId": delta,
                                      "previousProjectName": "Delta", "previousRevision": before,
                                      "projectId": delta, "projectName": "Delta", "created": False}
    held = _stored(client, delta)  # the person's read (this test's): ends the replacement
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        later = socket.receive_json()
    assert "graphReplaced" not in later and "renumbered" not in later and "projectSwitch" not in later
    # The old tab's handoff: its snapshot still holds the uuid.
    main_module._apply_node_renumbering(held, {new: DUP})
    next(node for node in held["nodes"] if node["id"] == DUP)["data"]["params"]["value"] = "dup-third"
    answer = _handoff(client, delta, before, held)
    assert answer.status_code == 200 and answer.json()["handoff"] is True, answer.text
    final = _on_disk(store, delta)["snapshot"]
    assert _vals(final) == sorted([("n1", "delta-1"), (new, "dup-third")])
    assert _live(client)[new]["data"]["params"]["value"] == "dup-third"


def test_nit3_the_boot_renumbering_stops_at_the_next_replacement(app):
    client, store, _graph, state = app
    _legacy_state(client, store, state, live_value="a", project_value="b")
    _boot(state)
    assert main_module._boot_first_sync()["graphReplaced"] is True
    _create(client, "Alpha")
    assert main_module._boot_first_sync() == {}
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        first = socket.receive_json()
    assert "renumbered" not in first and "graphReplaced" not in first


def test_nit3_an_agents_read_doesnt_end_it(app):
    """Only the person's tab loads the project with the new ids."""
    client, store, _graph, state = app
    delta = _legacy_state(client, store, state, live_value="a", project_value="b")
    _boot(state)
    _agent_read_and_listing(client, delta)
    assert client.get(f"/api/projects/{delta}", headers=CODEX).status_code == 200
    assert main_module._boot_first_sync().get("graphReplaced") is True


# -- NIT-1: the live graph refuses a non-nN id itself -----------------------------------------

def test_nit1_cligraph_refuses_a_uuid_id_on_every_write(tmp_path):
    state = tmp_path / "state.json"
    graph = CLIGraph(persist_path=state)
    graph.add_node("text-input", {"value": "a"})
    candidate = graph.clone()
    candidate.nodes[DUP] = {"id": DUP, "definitionId": "text-input", "params": {}, "outputs": {}}
    with pytest.raises(ForeignNodeIdError):
        graph.replace_with(candidate)
    with pytest.raises(ForeignNodeIdError):
        graph.adopt(candidate)
    assert list(graph.nodes) == ["n1"]
    assert [node["id"] for node in json.loads(state.read_text())["nodes"]] == ["n1"]
    with pytest.raises(ForeignNodeIdError):
        candidate.save(state)
    # A key that is Nebula's but a node that says otherwise.
    candidate = graph.clone()
    candidate.nodes["n2"] = {"id": DUP, "definitionId": "text-input", "params": {}, "outputs": {}}
    with pytest.raises(ForeignNodeIdError):
        graph.replace_with(candidate)
    # Without a file too.
    bare = CLIGraph()
    with pytest.raises(ForeignNodeIdError):
        bare.replace_with(candidate)
    # load() still renumbers instead.
    state.write_text(json.dumps({"nodes": [{"id": DUP, "definitionId": "text-input", "params": {}, "outputs": {}}],
                                 "edges": [], "counter": 0}))
    loaded = CLIGraph()
    loaded.load(state)
    assert list(loaded.nodes) == ["n1"] and loaded.renumbered_on_load == {DUP: "n1"}


def test_nit1_the_commit_uses_the_same_rule():
    with pytest.raises(ForeignNodeIdError):
        main_module._require_backend_node_ids({"nodes": [{"id": "n1"}, {"id": P1}]})
    main_module._require_backend_node_ids({"nodes": [{"id": "n1"}]})


# -- kept-ui-rules NIT-3: imported outputs read the shared rule ------------------------------

def test_kept_ui_nit3_imported_output_types_read_the_shared_port_rule(monkeypatch):
    check = main_module._imported_output_type_is_valid
    for pair in port_contracts.PORT_RULES["alsoCompatible"]:
        assert check(pair[0], pair[1]) and check(pair[1], pair[0])
    assert check("Image", None) and check("Image", "Any") and check("Image", "Image")
    assert not check("Any", "Image") and not check("Text", "Image")
    monkeypatch.setattr(port_contracts, "_ALSO_COMPATIBLE", frozenset())
    assert not check("Mask", "Image") and not check("Image", "Mask")
    monkeypatch.setattr(port_contracts, "_ALSO_COMPATIBLE", frozenset({frozenset({"Text", "Image"})}))
    assert check("Text", "Image")


# -- agents-grace NIT-1 and NIT-2: the kept marker ------------------------------------------

@pytest.mark.unprivileged
def test_grace_nit1_a_marker_in_a_folder_nebula_cant_write_pauses_no_boot(tmp_path, monkeypatch):
    """Review 16 agents-grace's probe: three boots held a grace each."""
    folder = tmp_path / "state"
    folder.mkdir()
    marker = folder / main_module.KEPT_MARKER_NAME
    marker.write_text(json.dumps({"keptTabs": 1, "at": 0}), encoding="utf-8")
    os.chmod(folder, 0o555)
    monkeypatch.setattr(main_module, "KEPT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(main_module, "KEPT_BOOT_SLACK_SECONDS", 0.0)
    try:
        boots = []
        for _ in range(3):
            manager = main_module.ConnectionManager(marker)
            boots.append(manager.start_boot_grace())
            manager.kept_in_tab()
        assert boots == [0, 0, 0]
        assert sorted(path.name for path in folder.iterdir()) == [main_module.KEPT_MARKER_NAME]
    finally:
        os.chmod(folder, 0o755)


def test_grace_nit1_a_marker_in_a_folder_it_can_write_still_holds_the_boot(tmp_path):
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.write_text(json.dumps({"keptTabs": 2, "at": 0}), encoding="utf-8")
    manager = main_module.ConnectionManager(marker)
    assert manager.start_boot_grace() == 2
    assert not list(tmp_path.glob(".kept-probe.*"))


def test_grace_nit2_a_directory_at_the_marker_path_is_tried_once(tmp_path, monkeypatch):
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.mkdir()
    manager = main_module.ConnectionManager(marker)
    manager.kept_graces[("socket", 1)] = main_module._time_module.monotonic() + 30
    calls: list[str] = []
    real = main_module.Path.write_text
    monkeypatch.setattr(main_module.Path, "write_text",
                        lambda self, *a, **k: (calls.append(self.name), real(self, *a, **k))[1])
    for _ in range(50):
        assert manager.kept_in_tab()
    assert len(calls) == 1
    assert not [path for path in tmp_path.iterdir() if path.name.endswith(".tmp")]
    # A new count is tried again.
    manager.kept_graces[("socket", 2)] = main_module._time_module.monotonic() + 30
    manager.kept_in_tab()
    assert len(calls) == 2


# -- GM r25 5: copy names ---------------------------------------------------------------------

def _named(*names: str) -> dict:
    return {"projects": {f"{index:032x}": {"name": name} for index, name in enumerate(names)}, "trash": {}}


_TWO_NUMBERS = re.compile(r"[0-9]+ [0-9]+$")


@pytest.mark.parametrize(("source", "taken", "want"), [
    ("X", (), "X copy"),
    ("X", ("X copy",), "X copy 2"),
    ("X copy", ("X copy",), "X copy 2"),
    ("X copy 2", ("X copy 2",), "X copy 3"),
    ("X copy 2", ("X copy", "X copy 2", "X copy 3"), "X copy 4"),
    ("Recovered X", (), "Recovered X copy"),
    ("Recovered X 2", (), "Recovered X 2 copy"),
    ("Recovered Alpha copy 2", ("Recovered Alpha copy 2",), "Recovered Alpha copy 3"),
    ("Shot 7", (), "Shot 7 copy"),
    ("Shot 7", ("Shot 7 copy",), "Shot 7 copy 2"),
    ("Recovered canvas", (), "Recovered canvas copy"),
    ("Recovered canvas 2", (), "Recovered canvas 2 copy"),
    ("X (recovered)", (), "X (recovered) copy"),
])
def test_gm_r25_5_copy_names(source, taken, want):
    got = store_module.duplicate_name(source, _named(source, *taken))
    assert got == want
    assert "copy copy" not in got and not _TWO_NUMBERS.search(got)


@pytest.mark.parametrize(("source", "taken", "want"), [
    ("X", (), "Recovered X"),
    ("X", ("Recovered X",), "Recovered X 2"),
    ("X copy", (), "Recovered X copy"),
    ("X copy 2", (), "Recovered X copy 2"),
    ("X copy 2", ("Recovered X copy 2",), "Recovered X copy 3"),
    ("Recovered X", ("Recovered X",), "Recovered X 2"),
    ("Recovered X 2", ("Recovered X 2",), "Recovered X 3"),
    ("Recovered Delta", ("Recovered Delta", "Recovered Delta 2"), "Recovered Delta 3"),
    ("Recovered Alpha copy 2", ("Recovered Alpha copy 2",), "Recovered Alpha copy 3"),
    ("Shot 7", (), "Recovered Shot 7"),
    ("Recovered canvas", ("Recovered canvas",), "Recovered canvas 2"),
    ("Recovered canvas 2", ("Recovered canvas 2",), "Recovered canvas 3"),
    ("X (recovered)", (), "Recovered X 2"),
    ("X (recovered 2)", (), "Recovered X 3"),
])
def test_gm_r25_5_recovered_names(source, taken, want):
    got = store_module.recovered_name(source, _named(source, *taken))
    assert got == want
    assert not got.startswith("Recovered Recovered") and not _TWO_NUMBERS.search(got)


def test_gm_r25_5_every_backend_copy_follows_the_rule(app):
    client, store, *_ = app
    catalog = _named("Recovered Alpha copy 2")
    assert main_module._canvas_copy_name("Recovered Alpha copy 2", catalog) == "Recovered Alpha copy 3"
    assert main_module._recovered_copy_name("Alpha copy 2", _named("Recovered Alpha copy 2")) == \
        "Recovered Alpha copy 3"
    assert store_module.lost_row_name("Recovered Delta", _named("Recovered Delta")) == "Recovered Delta 2"


# -- GM r26: no tab-local id offered to agents in the selection -------------------------------

def test_gm_r26_a_selected_tab_local_node_is_left_out_of_what_agents_read(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    published = client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1", DUP, "n99"]})
    assert published.status_code == 200, published.text
    read = client.get("/api/canvas/selection", headers=CODEX).json()
    assert read["selectedNodeIds"] == ["n1"] and read["missingNodeIds"] == ["n99"]
    assert read["tabOnlyCount"] == 1 and "opened again" in read["tabOnlyNote"]
    assert DUP not in json.dumps(read)
    prompt = selection_prompt_context(read)
    assert DUP not in prompt and read["tabOnlyNote"] in prompt
    printed = format_selection(read)
    assert DUP not in printed and read["tabOnlyNote"] in printed
    # A chat turn's own ids too.
    turn = main_module.selection_context.snapshot(main_module.cli_graph, main_module.node_registry,
                                                  requested_ids=[DUP])
    assert turn["selectedNodeIds"] == [] and turn["missingNodeIds"] == [] and turn["tabOnlyCount"] == 1
    look = client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert DUP not in json.dumps(look.get("selection"))


def test_gm_r26_only_nebula_ids_publish_no_note(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]})
    read = client.get("/api/canvas/selection", headers=CODEX).json()
    assert "tabOnlyCount" not in read and "tabOnlyNote" not in read


# -- Docs ---------------------------------------------------------------------------------------

def test_agent_docs_describe_round_18():
    setup = (ROOT / "docs/MCP-SETUP.md").read_text()
    skill = (ROOT / "skills/nebula/SKILL.md").read_text()
    for text in (setup, skill):
        assert "tabOnlyCount" in text
        assert "Recovered Alpha copy 3" in text
    assert "can't write" in setup
    assert "handoff" in setup and "new ids" in setup
