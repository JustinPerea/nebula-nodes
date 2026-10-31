"""PR #199 fix round 17 (review 15, GM r23 and r24), the backend's part.

- HIGH-1 (review 15 renumber-recover): Nebula's live graph never holds a
  node id that isn't ``nN``. Duplicate and Paste make tab-local uuid nodes;
  autosave writes them into the project; an open used to load them into the
  live graph, where the tab's typing never reached them, and an agent's read
  then wrote the stale value back. Every open renumbers them (the stored
  project too) and answers ``renumbered``; the commit refuses any other id.
- LOW-1: a renumbering numbers past every id the copy, its run history and
  its records have used, even with the source gone.
- NIT-1 to NIT-4: ASCII digits only; node references in params move; recover
  checks every connection as the live route does, and reports each it drops.
- The shared port rules file, and droppedWires' structured entries.
- Agents-grace LOW-1, LOW-2, NIT-1; kept-wires-ui LOW-1 (no selection or
  view while kept); GM r23 e ("1 node", the restore note's canvas line said
  once) and a ("Recovered Delta").
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module  # noqa: E402
from cli.formatter import catalog_restore_lines, format_start  # noqa: E402
from services import project_store as store_module  # noqa: E402
from services.cli_graph import CLIGraph  # noqa: E402
from services.port_contracts import DROPPED_CONNECTION_KINDS, PORT_RULES, port_types_compatible  # noqa: E402
from services.project_store import ProjectStore  # noqa: E402
from services.wording import counted  # noqa: E402
from tests.conftest import PERSON  # noqa: E402
from tests.test_project_catalog_restore_fix2 import _add_text, _create, app  # noqa: E402,F401
from tests.test_project_catalog_restore_fix12 import AGENT_WRITES, CODEX, _settles  # noqa: E402
from tests.test_project_catalog_restore_fix16 import (  # noqa: E402,F401
    _manager, _marker_says, _node, _refused, _restart, _say_kept, _tab, _wire, clock)

NN = re.compile(r"^n[0-9]+$")
ROOT = Path(__file__).resolve().parent.parent.parent
DUP = "1f52f9bb-0c3d-4e5f-8a9b-0c1d2e3f4a5b"
P1 = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
P2 = "8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e"


def _rev(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["workspaceRevision"]


def _active(client) -> str:
    return client.get("/api/projects", headers=PERSON).json()["activeProjectId"]


def _open(client, project_id: str, headers=PERSON):
    return client.post(f"/api/projects/{project_id}/open", headers=headers, json={"workspaceRevision": _rev(client)})


def _stored(client, project_id: str) -> dict:
    return client.get(f"/api/projects/{project_id}", headers=PERSON).json()["snapshot"]


def _autosave(client, project_id: str, snapshot: dict) -> None:
    saved = client.put(f"/api/projects/{project_id}", headers=PERSON,
                       json={"workspaceRevision": _rev(client), "snapshot": snapshot})
    assert saved.status_code == 200, saved.text


def _type(client, project_id: str, node_id: str, value: str) -> None:
    """The tab's typing: updateNodeData pushes params for nN ids only, then the autosave."""
    if NN.match(node_id):
        pushed = client.put(f"/api/graph/node/{node_id}", json={"params": {"value": value}},
                            headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)})
        assert pushed.status_code == 200, pushed.text
    tab = _stored(client, project_id)
    next(node for node in tab["nodes"] if node["id"] == node_id)["data"]["params"]["value"] = value
    _autosave(client, project_id, tab)


def _on_disk(store, project_id: str) -> dict:
    return ProjectStore(store.root).read()["projects"][project_id]


def _value(snapshot: dict, node_id: str):
    return next(node for node in snapshot["nodes"] if node["id"] == node_id)["data"]["params"].get("value")


def _export_ids(client) -> list[str]:
    exported = client.get("/api/graph/export", headers=PERSON).json()
    return [node["id"] for node in exported["nodes"]]


def _agent_read_and_listing(client, project_id: str) -> None:
    assert client.get(f"/api/projects/{project_id}?view=agent", headers=CODEX).status_code == 200
    assert client.get("/api/projects", headers=CODEX).status_code == 200


# -- HIGH-1: the reviewer's repro, duplicate and paste --------------------------------------

def test_high1_a_duplicates_typing_survives_a_reopen_and_an_agents_read(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    # Duplicate: a uuid node the tab never POSTs; autosave writes it.
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": "delta-1"}, 300))
    _autosave(client, delta, tab)
    _type(client, delta, DUP, "delta-1 dup-first")
    _create(client, "Alpha")
    opened = _open(client, delta)
    assert opened.status_code == 200, opened.text
    renumbered = opened.json()["renumbered"]
    assert list(renumbered) == [DUP] and NN.match(renumbered[DUP]) and renumbered[DUP] != "n1"
    assert all(NN.match(node_id) for node_id in _export_ids(client))
    new = renumbered[DUP]
    # The stored project moved with it, and its counter covers the new id.
    assert {node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]} == {"n1", new}
    assert _on_disk(store, delta)["_nodeCounter"] >= int(new[1:])
    # The tab adopted the id: its typing now reaches the live graph.
    _type(client, delta, new, "delta-1 dup-first dup-second")
    _agent_read_and_listing(client, delta)
    assert _value(_on_disk(store, delta)["snapshot"], new) == "delta-1 dup-first dup-second"
    assert client.get("/api/graph", headers=PERSON).json()["nodes"]


def test_high1_pasted_nodes_and_their_connection_survive_a_reopen_and_an_agents_read(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"] += [_node(P1, "text-input", {"value": "pasted"}, 300), _node(P2, "combine-text", {}, 500)]
    tab["edges"].append(_wire("w-paste", P1, "text", P2, "text1"))
    _autosave(client, delta, tab)
    _create(client, "Alpha")
    opened = _open(client, delta)
    assert opened.status_code == 200, opened.text
    renumbered = opened.json()["renumbered"]
    assert set(renumbered) == {P1, P2} and len(set(renumbered.values())) == 2
    graph = client.get("/api/graph", headers=PERSON).json()
    assert all(NN.match(node["id"]) for node in graph["nodes"])
    assert [(edge["source"], edge["target"]) for edge in graph["edges"]] == [(renumbered[P1], renumbered[P2])]
    _type(client, delta, renumbered[P1], "pasted then typed")
    _agent_read_and_listing(client, delta)
    on_disk = _on_disk(store, delta)["snapshot"]
    assert _value(on_disk, renumbered[P1]) == "pasted then typed"
    assert [(edge["source"], edge["target"]) for edge in on_disk["edges"]] == [(renumbered[P1], renumbered[P2])]


def test_high1_an_agents_open_carries_renumbered_to_the_tab_and_the_journal(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": "dup"}, 300))
    _autosave(client, delta, tab)
    _create(client, "Alpha")
    since = main_module.canvas_events.read(after=None)["latest"]
    main_module.manager.broadcast_raw.reset_mock()
    opened = _open(client, delta, headers=CODEX)
    assert opened.status_code == 200, opened.text
    new = opened.json()["renumbered"][DUP]
    syncs = [call.args[0] for call in main_module.manager.broadcast_raw.call_args_list
             if call.args and call.args[0].get("type") == "graphSync" and call.args[0].get("graphReplaced")]
    assert syncs and syncs[-1]["renumbered"] == {DUP: new} and syncs[-1]["projectSwitch"]["projectId"] == delta
    replaced = main_module.canvas_events.read(after=since, kinds={"canvas.replaced"})["events"]
    assert replaced[-1]["data"]["renumbered"] == {DUP: new} and "gave 1 node new ids" in replaced[-1]["summary"]


def test_high1_an_open_with_nothing_to_renumber_answers_an_empty_mapping_and_changes_nothing(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    _create(client, "Alpha")
    counter_before = _on_disk(store, delta).get("_nodeCounter")
    main_module.manager.broadcast_raw.reset_mock()
    opened = _open(client, delta)
    assert opened.json()["renumbered"] == {}
    assert _on_disk(store, delta).get("_nodeCounter") == counter_before
    syncs = [call.args[0] for call in main_module.manager.broadcast_raw.call_args_list
             if call.args and call.args[0].get("type") == "graphSync"]
    assert syncs and all("renumbered" not in sync for sync in syncs)


def test_high1_a_project_on_disk_with_uuid_ids_opens_with_its_edges_history_and_selection(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _create(client, "Alpha")
    recipe = {"nodes": [{"id": P1, "definitionId": "text-input", "params": {}, "outputs": {}}], "edges": []}
    with store.transaction() as catalog:
        project = catalog["projects"][delta]
        first = _node(P1, "text-input", {"value": "a"}, 0)
        first["selected"] = True
        project["snapshot"]["nodes"] = [first, _node(P2, "combine-text", {}, 300)]
        project["snapshot"]["edges"] = [_wire("w1", P1, "text", P2, "text1")]
        project["snapshot"]["runHistory"] = [{
            "id": "run-1", "status": "complete", "snapshot": recipe, "targetNodeId": P1,
            "resultOutputs": {P1: {"text": {"type": "Text", "value": "a"}}}}]
        project["pins"] = [{"id": "pin-1", "anchor": {"nodeId": P1}}]
        store.commit(catalog)
    opened = _open(client, delta)
    assert opened.status_code == 200, opened.text
    mapping = opened.json()["renumbered"]
    assert set(mapping) == {P1, P2}
    on_disk = _on_disk(store, delta)
    nodes = {node["id"]: node for node in on_disk["snapshot"]["nodes"]}
    assert set(nodes) == {mapping[P1], mapping[P2]} and nodes[mapping[P1]].get("selected") is True
    assert [(edge["source"], edge["target"]) for edge in on_disk["snapshot"]["edges"]] == [(mapping[P1], mapping[P2])]
    record = on_disk["snapshot"]["runHistory"][0]
    assert record["targetNodeId"] == mapping[P1] and list(record["resultOutputs"]) == [mapping[P1]]
    assert record["snapshot"]["nodes"][0]["id"] == mapping[P1]
    assert on_disk["pins"][0]["anchor"]["nodeId"] == mapping[P1]
    assert set(_export_ids(client)) == set(mapping.values())


def test_high1_every_export_id_is_nebulas_after_an_open_a_restore_and_an_import(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": "dup"}, 300))
    _autosave(client, delta, tab)
    _create(client, "Alpha")
    assert _open(client, delta).status_code == 200
    assert all(NN.match(node_id) for node_id in _export_ids(client)) and len(_export_ids(client)) == 2
    # A catalog restore (a torn catalog.json; .bak still has the uuid node),
    # then the tab opens the restored project.
    _create(client, "Beta")
    with store.transaction() as catalog:
        catalog["projects"][delta]["snapshot"]["nodes"].append(_node(P1, "text-input", {"value": "from-bak"}, 500))
        store.commit(catalog)
    _create(client, "Gamma")
    store.path.write_bytes(store.path.read_bytes()[:-2])
    listing = client.get("/api/projects", headers=PERSON).json()
    assert listing.get("catalogRestore")
    assert all(NN.match(node_id) for node_id in _export_ids(client))
    reopened = _open(client, delta)
    assert reopened.status_code == 200, reopened.text
    assert P1 in reopened.json()["renumbered"]
    assert all(NN.match(node_id) for node_id in _export_ids(client)) and len(_export_ids(client)) == 3
    # An import: every file id gets Nebula's, answered as `renumbered`.
    imported = client.post("/api/graph/import", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)},
                           json={"nodes": [{"id": P2, "definitionId": "text-input", "params": {"value": "i"}}],
                                 "edges": []})
    assert imported.status_code == 200, imported.text
    assert imported.json()["renumbered"] == {P2: imported.json()["idMap"][P2]}
    assert all(NN.match(node_id) for node_id in _export_ids(client))


def test_high1_the_commit_refuses_a_node_id_that_isnt_nebulas(app, monkeypatch):
    """The ratchet: an open whose renumbering went missing fails loudly, nothing written."""
    client, store, *_ = app
    delta = _create(client, "Delta")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(DUP, "text-input", {"value": "dup"}, 300))
    _autosave(client, delta, tab)
    alpha = _create(client, "Alpha")
    monkeypatch.setattr(main_module, "_renumber_staged_project", lambda project, candidate: {})
    with pytest.raises(RuntimeError, match="node ids that aren't Nebula's"):
        _open(client, delta)
    assert ProjectStore(store.root).read()["activeProjectId"] == alpha
    assert all(NN.match(node_id) for node_id in main_module.cli_graph.nodes)


@pytest.mark.parametrize("node_id", ["n٣", "n１", "n1a", "N2", "uuid-ish"])
def test_nit1_only_ascii_digits_make_a_nebula_id(app, node_id):
    """n٣ (Arabic-Indic three) and n１ (fullwidth one) aren't Nebula ids: the tab's CLI_ID_RE is ASCII."""
    client, store, *_ = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    tab = _stored(client, delta)
    tab["nodes"].append(_node(node_id, "text-input", {"value": "odd"}, 300))
    _autosave(client, delta, tab)
    _create(client, "Alpha")
    opened = _open(client, delta)
    assert opened.status_code == 200, opened.text
    assert node_id in opened.json()["renumbered"]
    assert all(NN.match(node) for node in main_module.cli_graph.nodes)
    with pytest.raises(RuntimeError):
        main_module._require_backend_node_ids({"nodes": [{"id": node_id}]})


def test_nit2_a_remotion_manifest_and_a_skip_gate_follow_the_renumbering(app):
    client, store, *_ = app
    delta = _create(client, "Delta")
    _create(client, "Alpha")
    manifest = {"timeline": [{"id": "t1", "sourceNodeId": P1, "componentType": "Text"},
                             {"id": "t2", "sourceNodeId": "n99-kept-as-is", "componentType": "Text"}]}
    with store.transaction() as catalog:
        gate = _node(P2, "text-input", {"value": "b"}, 300)
        gate["data"]["skipGateNodeId"] = P1
        catalog["projects"][delta]["snapshot"]["nodes"] = [
            _node(P1, "text-input", {"value": "a"}, 0), gate,
            _node("n1", "remotion-node", {"manifest": manifest}, 600)]
        store.commit(catalog)
    opened = _open(client, delta)
    assert opened.status_code == 200, opened.text
    mapping = opened.json()["renumbered"]
    nodes = {node["id"]: node for node in _on_disk(store, delta)["snapshot"]["nodes"]}
    timeline = nodes["n1"]["data"]["params"]["manifest"]["timeline"]
    assert [item["sourceNodeId"] for item in timeline] == [mapping[P1], "n99-kept-as-is"]
    assert nodes[mapping[P2]]["data"]["skipGateNodeId"] == mapping[P1]
    live = main_module.cli_graph.nodes["n1"]["params"]["manifest"]["timeline"]
    assert live[0]["sourceNodeId"] == mapping[P1]
    # The new ids number past n1.
    assert sorted(mapping.values()) == ["n2", "n3"]


def test_nit2_an_imported_manifest_names_the_imported_nodes_new_ids(app):
    client, *_ = app
    _create(client, "Delta")
    manifest = {"timeline": [{"id": "t1", "sourceNodeId": "file-a", "componentType": "Text"}]}
    imported = client.post("/api/graph/import", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)},
                           json={"nodes": [{"id": "file-a", "definitionId": "text-input", "params": {"value": "a"}},
                                           {"id": "file-b", "definitionId": "remotion-node",
                                            "params": {"manifest": manifest}}], "edges": []})
    assert imported.status_code == 200, imported.text
    ids = imported.json()["idMap"]
    timeline = main_module.cli_graph.nodes[ids["file-b"]]["params"]["manifest"]["timeline"]
    assert timeline[0]["sourceNodeId"] == ids["file-a"]


def test_high1_a_state_json_with_a_uuid_node_loads_renumbered_and_its_project_follows(app, tmp_path):
    client, store, graph, state = app
    delta = _create(client, "Delta")
    _add_text(client, "delta-1")
    client.get("/api/projects", headers=PERSON)
    saved = json.loads(state.read_text())
    saved["nodes"].append({"id": DUP, "definitionId": "text-input", "params": {"value": "dup"}, "outputs": {}})
    saved["edges"].append({"id": "w-dup", "source": "n1", "sourceHandle": "text", "target": DUP,
                           "targetHandle": "text"})
    state.write_text(json.dumps(saved))
    with store.transaction() as catalog:
        catalog["projects"][delta]["snapshot"]["nodes"].append(_node(DUP, "text-input", {"value": "dup"}, 300))
        store.commit(catalog)
    loaded = CLIGraph(persist_path=state)
    loaded.load(state)
    assert set(loaded.renumbered_on_load) == {DUP} and all(NN.match(node_id) for node_id in loaded.nodes)
    assert loaded.edges[-1]["target"] == loaded.renumbered_on_load[DUP]
    main_module.cli_graph.nodes, main_module.cli_graph.edges = loaded.nodes, loaded.edges
    main_module.cli_graph._counter = loaded._counter
    main_module.cli_graph.renumbered_on_load = loaded.renumbered_on_load
    asyncio.run(main_module._renumber_live_canvas_at_boot())
    new = loaded.renumbered_on_load[DUP]
    assert {node["id"] for node in _on_disk(store, delta)["snapshot"]["nodes"]} == {"n1", new}
    assert new in {node["id"] for node in json.loads(state.read_text())["nodes"]}
    # A tab reconnecting after the restart gets the mapping on its first graphSync.
    with client.websocket_connect("/ws", headers=PERSON) as socket:
        first = socket.receive_json()
    assert first["type"] == "graphSync" and first["renumbered"] == {DUP: new}
    main_module._boot_renumbered.clear()


def test_high1_a_stale_node_id_answers_read_the_canvas_again(app):
    client, *_ = app
    _create(client, "Delta")
    gone = client.put("/api/graph/node/n7", headers=CODEX, json={"params": {"value": "x"}})
    assert gone.status_code == 404
    assert "read the canvas again" in gone.json()["detail"] and gone.json()["detail"].startswith("Node n7 not found")


def test_high1_undo_sync_refuses_a_non_nebula_id_clearly(app):
    """The tab sends only CLI_ID_RE ids to /api/graph/restore; anything else is refused, not renumbered."""
    client, *_ = app
    _create(client, "Delta")
    refused = client.post("/api/graph/restore", headers={**PERSON, "X-Nebula-Workspace-Revision": _rev(client)},
                          json={"action": "undo", "nodes": [{"id": DUP, "definitionId": "text-input",
                                                             "params": {}}]})
    assert refused.status_code == 400 and "must be a node id like n3" in refused.text


# -- LOW-1: the counter covers every id the copy has used ------------------------------------

def test_low1_with_the_source_gone_a_kept_node_never_takes_a_deleted_nodes_id(app):
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = _stored(client, source)
    snapshot["nodes"].append(_node(DUP, "text-input", {"value": "kept"}, 300))
    # A run record of n2, deleted since.
    recipe = {"nodes": [{"id": "n2", "definitionId": "text-input", "params": {}, "outputs": {}}], "edges": []}
    snapshot["runHistory"] = [{"id": "run-n2", "status": "complete", "snapshot": recipe, "targetNodeId": "n2",
                               "resultOutputs": {"n2": {"text": {"type": "Text", "value": "old"}}}}]
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": "d" * 32, "snapshot": snapshot, "recoveryId": "f" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    new = recovered.json()["renumbered"][DUP]
    assert new == "n3"
    assert _on_disk(store, "f" * 32)["_nodeCounter"] == 3


# -- NIT-4: recover checks every connection as the live route does ---------------------------

def test_nit4_a_connection_to_a_node_whose_definition_was_removed_is_checked_and_reported(app, monkeypatch):
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = _stored(client, source)
    snapshot["nodes"].append(_node("n5", "retired-thing", {}, 300))
    snapshot["edges"].append(_wire("w-hist", "n1", "text", "n5", "text"))
    with store.transaction() as catalog:
        catalog["projects"][source]["snapshot"]["nodes"].append(_node("n5", "retired-thing", {}, 300))
        store.commit(catalog)
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": "a" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    dropped = recovered.json()["droppedWires"]
    assert [(wire["id"], wire["kind"]) for wire in dropped] == [("w-hist", "port")]
    assert "unknown definition retired-thing" in dropped[0]["detail"]


def test_nit4_a_stray_shot_connection_is_reported_not_dropped_silently(app):
    client, *_ = app
    _create(client, "Delta")
    source = _active(client)
    snapshot = _stored(client, source)
    scene = _node("n1", "cinema-scene", {"scene": {"shots": []}}, 0)
    scene["data"]["outputs"] = {"shot_gone": {"type": "Image", "value": None}}
    snapshot["nodes"] = [scene, _node("n2", "text-input", {}, 300)]
    snapshot["edges"] = [_wire("w-shot", "n1", "shot_gone", "n2", "text")]
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": "b" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    assert [(wire["id"], wire["kind"]) for wire in recovered.json()["droppedWires"]] == [("w-shot", "port")]


# -- droppedWires: structured entries (GM r23 2, agents-grace NIT-2, kept-wires-ui NIT-1) ------

ENTRY_KEYS = {"id", "source", "sourceHandle", "target", "targetHandle", "sourceWas", "targetWas", "sourceName",
              "targetName", "sourcePort", "targetPort", "sourceType", "targetType", "limit", "kind", "detail"}


def test_dropped_wires_carry_names_ports_and_types_never_a_person_line(app):
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = _stored(client, source)
    snapshot["nodes"] += [_node(P1, "combine-text", {}, 300), _node(P2, "image-input", {}, 500),
                          _node("n9", "text-input", {}, 700)]
    snapshot["nodes"][-1]["data"]["label"] = "Second text"
    snapshot["edges"] += [_wire("w-ok", "n1", "text", P1, "text1"),
                          _wire("w-limit", "n9", "text", P1, "text1"),
                          _wire("w-type", P2, "image", P1, "text2"),
                          _wire("w-gone", "gone-local", "text", P1, "text3")]
    since = main_module.canvas_events.read(after=None)["latest"]
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": "c" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    body = recovered.json()
    mapping = body["renumbered"]
    dropped = {wire["id"]: wire for wire in body["droppedWires"]}
    assert set(dropped) == {"w-limit", "w-type", "w-gone"}
    assert all(set(wire) == ENTRY_KEYS for wire in dropped.values())
    assert all(wire["kind"] in PORT_RULES["droppedConnectionKinds"] for wire in dropped.values())
    limit = dropped["w-limit"]
    assert (limit["kind"], limit["limit"], limit["source"], limit["target"]) == ("limit", 1, "n9", mapping[P1])
    assert (limit["sourceName"], limit["targetName"]) == ("Second text", "Combine Text")
    assert limit["sourceType"] == "Text" and limit["targetType"] == "Text" and limit["targetPort"]
    kind = dropped["w-type"]
    assert (kind["kind"], kind["sourceType"], kind["targetType"], kind["limit"]) == ("type", "Image", "Text", None)
    assert kind["source"] == mapping[P2] and kind["sourceWas"] is None
    gone = dropped["w-gone"]
    assert (gone["kind"], gone["source"], gone["sourceWas"], gone["sourceName"], gone["sourcePort"]) == (
        "missing", None, "gone-local", None, None)
    assert gone["target"] == mapping[P1] and gone["targetName"] == "Combine Text"
    # The agents' sentence names the copy's ids, never the tab's, and no person line.
    assert all(P1 not in wire["detail"] and P2 not in wire["detail"] for wire in dropped.values())
    assert all("Remove the extra" not in wire["detail"] for wire in dropped.values())
    # The journal's entries are the same entries.
    created = main_module.canvas_events.read(after=since, kinds={"project.created"})["events"][-1]
    assert {wire["id"]: wire for wire in created["data"]["droppedWires"]} == dropped
    assert "left out 3 connections" in created["summary"]


def test_one_dropped_connection_is_said_in_the_singular(app):
    _create(app[0], "Delta")
    since = main_module.canvas_events.read(after=None)["latest"]
    main_module._journal_project_change("project.created", {"id": "e" * 32, "name": "Delta"}, dropped_wires=[
        {"id": "w", "source": "n1", "sourceHandle": "text", "target": None, "targetHandle": "text",
         "kind": "missing", "detail": "x"}])
    event = main_module.canvas_events.read(after=since, kinds={"project.created"})["events"][-1]
    assert event["summary"].endswith("left out 1 connection it couldn't keep")


# -- The shared port rules (kept-wires-ui LOW-3, GM r23 2) ------------------------------------

def test_port_rules_are_the_same_bytes_on_both_sides():
    backend = ROOT / "backend/data/port_rules.json"
    frontend = ROOT / "frontend/src/lib/portRules.json"
    assert backend.read_bytes() == frontend.read_bytes()
    assert json.loads(backend.read_text()) == PORT_RULES


def test_port_rules_types_are_the_frontends_port_types():
    ports = (ROOT / "frontend/src/constants/ports.ts").read_text()
    declared = re.findall(r"'([A-Za-z0-9]+)'", re.search(r"PORT_DATA_TYPES: PortDataType\[\] = \[(.*?)\];",
                                                         ports, re.S).group(1))
    union = re.findall(r"\|\s*'([A-Za-z0-9]+)'", re.search(r"export type PortDataType =(.*?);",
                                                          (ROOT / "frontend/src/types/index.ts").read_text(),
                                                          re.S).group(1))
    assert sorted(PORT_RULES["types"]) == sorted(declared) == sorted(union)
    assert PORT_RULES["any"] == "Any" and PORT_RULES["types"][-1] == "Any"


def test_port_types_compatible_reads_the_shared_rule_for_every_pair():
    rules = PORT_RULES
    pairs = {frozenset(pair) for pair in rules["alsoCompatible"]}
    for source in rules["types"]:
        for target in rules["types"]:
            expected = rules["any"] in (source, target) or source == target or frozenset((source, target)) in pairs
            assert port_types_compatible(source, target) is expected, (source, target)
    assert port_types_compatible("Image", "Mask") and port_types_compatible("Mask", "Image")
    assert not port_types_compatible("Image", "Text")


def test_every_kind_recover_can_answer_is_a_shared_kind():
    contracts = (ROOT / "backend/services/port_contracts.py").read_text()
    main_text = (ROOT / "backend/main.py").read_text()
    causes = set(re.findall(r'cause="([a-z]+)"', contracts))
    literal = set(re.findall(r'_dropped_wire\(edge_id, [a-z]+, "([a-z]+)"', main_text))
    assert causes and literal and causes | literal <= set(DROPPED_CONNECTION_KINDS)
    assert set(DROPPED_CONNECTION_KINDS) == {"loop", "duplicate", "missing", "port", "type", "limit"}


def test_the_generator_writes_what_is_checked_in(tmp_path):
    import shutil
    import subprocess

    copy = tmp_path / "repo"
    for part in ("scripts/generate-port-rules.py", "frontend/src/constants/ports.ts",
                 "frontend/src/lib/portCompatibility.ts"):
        (copy / part).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / part, copy / part)
    (copy / "backend/data").mkdir(parents=True)
    subprocess.run([sys.executable, "-I", str(copy / "scripts/generate-port-rules.py")], check=True,
                   capture_output=True)
    assert (copy / "backend/data/port_rules.json").read_bytes() == (ROOT / "backend/data/port_rules.json").read_bytes()


# -- Agents-grace LOW-1, LOW-2, NIT-1 --------------------------------------------------------

def test_grace_low1_an_expired_grace_isnt_counted_while_another_tab_stays_kept(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    manager = _manager(monkeypatch, marker)
    _create(client, "Delta")
    first, tab_a = _tab(client)
    second, tab_b = _tab(client)
    _say_kept(tab_a, True, manager, kept_now=1)
    _say_kept(tab_b, True, manager, kept_now=2)
    first.__exit__(None, None, None)  # A closes for good
    assert _settles(lambda: len(manager.kept_tabs) == 1)
    clock.ahead = main_module.KEPT_GRACE_SECONDS + 1
    assert manager.kept_count() == 1  # never counts the expired grace, even before it is dropped
    assert _refused(AGENT_WRITES["add"](client))  # B still keeps edits
    assert manager.kept_graces == {}
    assert json.loads(marker.read_text())["keptTabs"] == 1
    second.__exit__(None, None, None)
    clock.ahead = 0.0
    _restart(monkeypatch, marker)
    assert len(main_module.manager.kept_graces) == 1
    again, tab = _tab(client)
    _say_kept(tab, True, main_module.manager, kept_now=1)
    _say_kept(tab, False, main_module.manager, kept_now=0)
    assert AGENT_WRITES["add"](client).status_code == 200
    again.__exit__(None, None, None)


def test_grace_low2_the_marker_clears_itself_with_no_request(monkeypatch, tmp_path):
    """K9: in a real event loop, with a short grace and nothing asking."""
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.write_text(json.dumps({"keptTabs": 1}), encoding="utf-8")
    monkeypatch.setattr(main_module, "KEPT_GRACE_SECONDS", 0.2)
    monkeypatch.setattr(main_module, "KEPT_BOOT_SLACK_SECONDS", 0.0)
    manager = main_module.ConnectionManager(marker)

    async def boot_then_wait() -> bool:
        assert manager.start_boot_grace() == 1
        assert marker.exists()
        for _ in range(100):  # up to 5 s under load; the state it then asserts
            await asyncio.sleep(0.05)
            if not marker.exists():
                return True
        return False

    assert asyncio.run(boot_then_wait())
    assert manager.kept_graces == {}


def test_grace_nit1_a_directory_where_the_marker_goes_is_no_marker_and_leaks_nothing(monkeypatch, tmp_path, capsys):
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.mkdir()
    manager = main_module.ConnectionManager(marker)
    assert manager.start_boot_grace() == 0 and not manager.kept_in_tab()
    manager.kept_graces[("socket", 1)] = main_module._time_module.monotonic() + 30
    manager._remember_kept()
    manager._marker_count = None
    manager._remember_kept()
    assert [path.name for path in tmp_path.iterdir()] == [main_module.KEPT_MARKER_NAME]
    said = capsys.readouterr().out
    assert said.count("couldn't write the kept marker") == 1 and said.count("isn't a file") == 1


def test_grace_nit1_a_marker_that_cant_be_removed_pauses_one_grace_only(monkeypatch, tmp_path, capsys):
    marker = tmp_path / main_module.KEPT_MARKER_NAME
    marker.write_text(json.dumps({"keptTabs": 1}), encoding="utf-8")
    real_unlink = Path.unlink

    def stuck(self, missing_ok=False):
        if self == marker:
            raise PermissionError("operation not permitted")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", stuck)
    monkeypatch.setattr(main_module, "KEPT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(main_module, "KEPT_BOOT_SLACK_SECONDS", 0.0)
    manager = main_module.ConnectionManager(marker)
    assert manager.start_boot_grace() == 1  # its one grace
    assert not manager.kept_in_tab() and not manager.kept_in_tab()
    assert capsys.readouterr().out.count("couldn't remove the kept marker") == 1
    assert marker.exists()
    # The next boot finds the same marker and holds no grace for it.
    again = main_module.ConnectionManager(marker)
    assert again.start_boot_grace() == 0 and not again.kept_in_tab()
    # A new kept tab writes a new marker, and that one counts again.
    again.kept_graces[("socket", 1)] = main_module._time_module.monotonic() + 30
    again._remember_kept()
    assert main_module.ConnectionManager(marker).start_boot_grace() == 1


# -- Kept-wires-ui LOW-1: no selection and no view while kept ---------------------------------

def test_kept_ui_low1_agents_read_no_selection_or_view_while_a_tab_keeps_edits(app, clock, monkeypatch, tmp_path):
    client, *_ = app
    manager = _manager(monkeypatch, tmp_path / main_module.KEPT_MARKER_NAME)
    _create(client, "Delta")
    _add_text(client, "delta-1")
    assert client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]}).status_code == 200
    view = {"viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": 800, "height": 600},
            "nodes": [{"id": "n1", "x": 0, "y": 0, "width": 100, "height": 50}]}
    assert client.post("/api/canvas/view", headers=PERSON, json=view).status_code == 200
    assert client.get("/api/canvas/selection", headers=CODEX).json()["selectedNodeIds"] == ["n1"]
    socket, tab = _tab(client)
    _say_kept(tab, True, manager, kept_now=1)
    assert client.get("/api/canvas/selection", headers=CODEX).json()["selectedNodeIds"] == []
    look = client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert look["selection"] == [] and look["view"]["reported"] is False and look["view"]["viewport"] is None
    start = client.get("/api/agent/start", headers=CODEX).json()
    assert start["canvas"].get("selection") in ([], None)
    # A chat turn's ids are the kept tab's too: no selection in its prompt context.
    chat = main_module.selection_context.snapshot(main_module.cli_graph, main_module.node_registry,
                                                  requested_ids=["n1"])
    assert chat["selectedNodeIds"] == []
    # Kept mode ends: the selection published before kept mode is read
    # again at once, with no new publish (kept mode ends through Save, a
    # switch, or Discard, an open, and both clear it); here the tab
    # publishes it again anyway.
    _say_kept(tab, False, manager, kept_now=0)
    assert client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]}).status_code == 200
    assert client.get("/api/canvas/selection", headers=CODEX).json()["selectedNodeIds"] == ["n1"]
    socket.__exit__(None, None, None)


def test_kept_ui_low1_a_project_switch_clears_the_published_selection(app):
    client, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    assert client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]}).status_code == 200
    alpha = _create(client, "Alpha")
    _add_text(client, "alpha-1")
    assert main_module.selection_context.current() == []
    assert client.get("/api/canvas/selection", headers=CODEX).json()["selectedNodeIds"] == []
    assert alpha


def test_kept_ui_low1_a_catalog_restore_clears_the_published_selection(app):
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    _create(client, "Alpha")
    assert client.post("/api/canvas/selection", headers=PERSON, json={"nodeIds": ["n1"]}).status_code == 200
    store.path.write_bytes(store.path.read_bytes()[:-2])
    assert client.get("/api/projects", headers=PERSON).json().get("catalogRestore")
    assert _settles(lambda: main_module.selection_context.current() == [])


# -- GM r23 e: "1 node", and the canvas said once --------------------------------------------

def test_r23e_counts_are_singular_for_one():
    assert counted(1, "node") == "1 node" and counted(2, "node") == "2 nodes" and counted(0, "project") == "0 projects"
    assert counted(1, "canvas") == "1 canvas" and counted(3, "canvas") == "3 canvases"
    start = {"canvas": {"nodeCount": 1, "view": {"stale": True}}, "pins": {}, "proposals": {}, "boards": {},
             "nodes": {}, "spend": {}, "next": {}}
    assert "CANVAS: no project open, 1 node, no browser watching" in format_start(start)


_WAITING_RESTORE = {"kind": "restored", "reason": "corrupt", "source": "catalog.json.bak",
                    "canvasNotFiled": {"reason": "projects", "current": True}}


def test_r23e_the_restore_note_leaves_the_waiting_canvas_to_its_block():
    alone = main_module._catalog_restore_note(_WAITING_RESTORE)
    beside = main_module._catalog_restore_note(_WAITING_RESTORE, canvas_block=True)
    assert "couldn't be filed as its own" in alone and "couldn't be filed as its own" not in beside
    assert "Live canvas not saved" in "\n".join(catalog_restore_lines(_WAITING_RESTORE))
    assert "Live canvas not saved" not in "\n".join(catalog_restore_lines(_WAITING_RESTORE, canvas_block=True))
    start = {"catalogRestore": {**_WAITING_RESTORE, "note": beside},
             "canvasNotFiled": {"reason": "projects", "note": "The canvas the person had open isn't saved."},
             "canvas": {"nodeCount": 2, "view": {"stale": True}}, "pins": {}, "proposals": {}, "boards": {},
             "nodes": {}, "spend": {}, "next": {}}
    text = format_start(start)
    assert text.count("Live canvas not saved") == 0 and text.count("CANVAS NOT SAVED AS A PROJECT") == 1
    assert "couldn't be filed as its own" not in text


# -- GM r23 a: "Recovered Delta" ---------------------------------------------------------------

def test_r23a_recovered_copies_are_named_recovered_delta_then_numbered(app):
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = _stored(client, source)
    names = []
    for recovery_id in ("1" * 32, "2" * 32):
        recovered = client.post("/api/projects/recover", headers=PERSON, json={
            "sourceProjectId": source, "snapshot": snapshot, "recoveryId": recovery_id,
            "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
        assert recovered.status_code == 200, recovered.text
        names.append(recovered.json()["project"]["name"])
    assert names == ["Recovered Delta", "Recovered Delta copy"]  # GM r29, 2
    listing = client.get("/api/projects", headers=CODEX).json()
    assert {"Recovered Delta", "Recovered Delta copy"} <= {project["name"] for project in listing["projects"]}


@pytest.mark.parametrize("source, taken, expected", [
    ("Delta", (), "Recovered Delta"),
    # GM r29, 2: " copy", then " copy 2"; no number in a name is read.
    ("Delta", ("Recovered Delta",), "Recovered Delta copy"),
    ("Recovered Delta", ("Recovered Delta",), "Recovered Delta copy"),  # never a second "Recovered"
    ("Delta", ("Recovered Delta", "Recovered Delta copy 2"), "Recovered Delta copy"),  # the lowest free
    ("Recovered canvas", ("Recovered canvas",), "Recovered canvas copy"),
    # A name from before the rule is Nebula's old "Recovered Delta".
    ("Delta (recovered)", (), "Recovered Delta"),
    ("Alpha copy", ("Alpha copy",), "Recovered Alpha copy"),
])
def test_r23a_the_family_rules_hold_in_the_new_shape(source, taken, expected):
    catalog = {"projects": {f"{index:032x}": {"name": name} for index, name in enumerate(taken)}, "trash": {}}
    assert store_module.recovered_name(source, catalog) == expected


def test_r23a_a_duplicate_of_a_recovered_copy_names_its_source():
    catalog = {"projects": {"a" * 32: {"name": "Recovered Delta"}, "b" * 32: {"name": "Recovered Delta copy"}},
               "trash": {}}
    assert store_module.duplicate_name("Recovered Delta", catalog) == "Recovered Delta copy 2"
    assert store_module.duplicate_name("Recovered Delta copy", catalog) == "Recovered Delta copy 2"
    assert store_module.lost_row_name("Beta", {"projects": {}, "trash": {"c" * 32: {"name": "Beta"}}}) == \
        "Recovered Beta"


def test_agent_docs_describe_round_17():
    setup = (ROOT / "docs/MCP-SETUP.md").read_text()
    skill = (ROOT / "skills/nebula/SKILL.md").read_text()
    for text in (setup, skill):
        assert "renumbered" in text and "sourceWas" in text and "Recovered <project" in text
        assert "(recovered)" not in text.replace('("X (recovered)")', "")
    assert "a plain backend launch" in setup.lower() or "plain backend launch" in setup


def test_mcp_open_project_and_nebula_project_open_say_the_renumbered_ids(monkeypatch, capsys):
    import mcp_server
    from cli.commands import projects as projects_command

    listing = {"activeProjectId": "a" * 32, "workspaceRevision": "r",
               "projects": [{"id": "a" * 32, "name": "Alpha"}, {"id": "d" * 32, "name": "Delta"}]}
    opened = {"project": {"id": "d" * 32, "name": "Delta", "snapshot": {"nodes": []}}, "renumbered": {DUP: "n2"}}
    monkeypatch.setattr(mcp_server, "_canvas_call", lambda method, path, ctx, **kw: listing if method == "GET" else opened)
    reply = mcp_server._switch(f"/api/projects/{'d' * 32}/open", {}, None)
    assert reply["renumbered"] == {DUP: "n2"} and "gave 1 node its own ids" in reply["renumberedNote"]

    class Client:
        def list_projects(self):
            return listing

        def open_project(self, project_id, revision):
            return opened

    projects_command.run_open(Client(), "d" * 32)
    err = capsys.readouterr().err
    assert f"gave 1 node its own ids at this open ({DUP} -> n2)" in err and "read the canvas again" in err.lower()


def _recover_with_source_records(client, store, *, history: bool, pins: bool) -> str:
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    with store.transaction() as catalog:
        project = catalog["projects"][source]
        if history:
            recipe = {"nodes": [{"id": "n5", "definitionId": "text-input", "params": {}, "outputs": {}}], "edges": []}
            project["snapshot"]["runHistory"] = [{"id": "run-n5", "status": "complete", "snapshot": recipe,
                                                  "targetNodeId": "n5"}]
        if pins:
            project["pins"] = [{"id": "pin-1", "anchor": {"nodeId": "n9"}}]
        store.commit(catalog)
    snapshot = _stored(client, source)
    snapshot["runHistory"] = []
    snapshot["nodes"].append(_node(DUP, "text-input", {"value": "kept"}, 300))
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": "9" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    return recovered.json()["renumbered"][DUP]


def test_low1_the_counter_covers_the_sources_run_history(app):
    client, store, *_ = app
    assert _recover_with_source_records(client, store, history=True, pins=False) == "n6"


def test_low1_the_counter_covers_the_sources_pins(app):
    client, store, *_ = app
    assert _recover_with_source_records(client, store, history=False, pins=True) == "n10"


def test_low1_a_long_n_string_in_the_history_never_pushes_ids_past_a_short_id(app):
    """Only a short id's length counts (CLIGraph SHORT_ID_RE: 9 digits)."""
    client, store, *_ = app
    _create(client, "Delta")
    _add_text(client, "delta-1")
    source = _active(client)
    snapshot = _stored(client, source)
    snapshot["nodes"].append(_node(DUP, "text-input", {"value": "kept"}, 300))
    recipe = {"nodes": [{"id": "n1", "definitionId": "text-input", "params": {"value": "n99999999999"},
                         "outputs": {}}], "edges": []}
    snapshot["runHistory"] = [{"id": "run-1", "status": "complete", "snapshot": recipe, "targetNodeId": "n1"}]
    recovered = client.post("/api/projects/recover", headers=PERSON, json={
        "sourceProjectId": source, "snapshot": snapshot, "recoveryId": "8" * 32,
        "paramsVersion": main_module.PARAMS_VERSION, "sourceName": "Delta"})
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["renumbered"][DUP] == "n2"
