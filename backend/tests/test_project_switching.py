"""Agents start and switch projects; the person's canvas follows with a way
back (D4). Agents can't wipe a canvas that has nodes (D3). Project cards show
a real cover, and the person can pin one (F1, F2)."""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module
from services import project_cover
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry
from services.project_store import ProjectStore
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

AGENT = {"X-Nebula-Agent": "Claude Code"}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "execution_runs", ExecutionRunRegistry())
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    broadcast = AsyncMock()
    monkeypatch.setattr(main_module.manager, "broadcast_raw", broadcast)
    return TestClient(main_module.app), graph, store, broadcast


def _syncs(broadcast) -> list[dict]:
    return [call.args[0] for call in broadcast.call_args_list if call.args and call.args[0].get("type") == "graphSync"]


def _create(client, name, revision=None, headers=None):
    body = {"name": name, **({"workspaceRevision": revision} if revision else {})}
    response = client.post("/api/projects", json=body, headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def _rf(node_id, value="v", **data):
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "text-input", "params": {"value": value}, "outputs": {}, **data}}


# -- D4: the canvas follows an agent's switch -------------------------------------

def test_an_agents_new_project_tells_the_canvas_who_switched_and_where_from(workspace, person, monkeypatch):
    client, graph, store, broadcast = workspace
    journal: list[dict] = []
    publish = main_module.canvas_events.publish
    monkeypatch.setattr(main_module.canvas_events, "publish",
                        lambda kind, **kwargs: journal.append({"kind": kind, **kwargs}) or publish(kind, **kwargs))
    mine = _create(client, "Brand board", headers=person.headers)
    graph.add_node("text-input", {"value": "the person's work"})
    broadcast.reset_mock()

    made = _create(client, "Agent sketches", mine["workspaceRevision"], headers=AGENT)

    sync = _syncs(broadcast)[-1]
    assert sync["graphReplaced"] is True
    switch = sync["projectSwitch"]
    assert switch["actor"]["kind"] == "agent" and switch["actor"]["name"] == "Claude Code"
    assert switch["projectId"] == made["project"]["id"] and switch["projectName"] == "Agent sketches"
    assert switch["previousProjectId"] == mine["project"]["id"] and switch["previousProjectName"] == "Brand board"
    assert switch["previousRevision"] == mine["workspaceRevision"]
    assert sync["workspaceRevision"] == made["workspaceRevision"]
    # The person's work was saved into their project before the switch.
    catalog = store.read()
    assert [n["data"]["params"]["value"] for n in catalog["projects"][mine["project"]["id"]]["snapshot"]["nodes"]] \
        == ["the person's work"]
    assert catalog["projects"][made["project"]["id"]]["createdBy"] == {"kind": "agent", "name": "Claude Code"}
    assert made["project"]["createdBy"]["name"] == "Claude Code"
    # The journal names the agent and both projects.
    replaced = [event for event in journal if event["kind"] == "canvas.replaced"][-1]
    assert replaced["actor"]["name"] == "Claude Code"
    assert "Agent sketches" in replaced["summary"] and "Brand board" in replaced["summary"]
    assert replaced["data"]["previousProjectId"] == mine["project"]["id"]


def test_an_agent_opening_a_project_is_announced_too(workspace, person):
    client, _, _, broadcast = workspace
    first = _create(client, "First", headers=person.headers)
    second = _create(client, "Second", first["workspaceRevision"], headers=person.headers)
    broadcast.reset_mock()
    opened = client.post(f"/api/projects/{first['project']['id']}/open",
                         json={"workspaceRevision": second["workspaceRevision"]}, headers=AGENT)
    assert opened.status_code == 200, opened.text
    switch = _syncs(broadcast)[-1]["projectSwitch"]
    assert (switch["projectName"], switch["previousProjectName"]) == ("First", "Second")


def test_the_persons_own_switch_carries_no_notice(workspace, person):
    client, _, store, broadcast = workspace
    first = _create(client, "First", headers=person.headers)
    broadcast.reset_mock()
    _create(client, "Second", first["workspaceRevision"], headers=person.headers)
    assert "projectSwitch" not in _syncs(broadcast)[-1]
    assert "handoff" not in store.read()


def test_the_tab_an_agent_switched_away_saves_its_last_changes_until_the_next_switch(workspace, person):
    client, graph, store, _ = workspace
    mine = _create(client, "Mine", headers=person.headers)
    old_revision = mine["workspaceRevision"]
    project_id = mine["project"]["id"]
    backend_node = graph.add_node("text-input", {"value": "made by an agent just now"})
    _create(client, "Agent's", old_revision, headers=AGENT)

    # The tab never saw the agent's node, and holds a node only it knows,
    # a pan and a finished run record.
    tab = {"nodes": [_rf("local-sticky", "only in the tab")], "edges": [],
           "runHistory": [{"id": "run-1", "status": "complete", "startedAt": 1,
                           "snapshot": {"nodes": [], "edges": []}}],
           "viewport": {"x": 40, "y": 12, "zoom": 0.5}, "createSessionId": None}
    saved = client.put(f"/api/projects/{project_id}", json={"snapshot": tab, "workspaceRevision": old_revision},
                       headers=person.headers)
    assert saved.status_code == 200, saved.text
    snapshot = store.read()["projects"][project_id]["snapshot"]
    assert {node["id"] for node in snapshot["nodes"]} == {backend_node, "local-sticky"}
    assert snapshot["viewport"] == {"x": 40, "y": 12, "zoom": 0.5}
    assert [record["id"] for record in snapshot["runHistory"]] == ["run-1"]
    # An autosave that was in flight at the switch and the tab's last save
    # both land (live: the second used to 409 and leave a duplicate copy).
    tab["viewport"] = {"x": 0, "y": 0, "zoom": 1}
    again = client.put(f"/api/projects/{project_id}", json={"snapshot": tab, "workspaceRevision": old_revision},
                       headers=person.headers)
    assert again.status_code == 200, again.text
    snapshot = store.read()["projects"][project_id]["snapshot"]
    assert snapshot["viewport"] == {"x": 0, "y": 0, "zoom": 1}
    assert {node["id"] for node in snapshot["nodes"]} == {backend_node, "local-sticky"}
    # The next switch ends it: a stale save is the usual conflict again.
    _create(client, "Later", store.read()["workspaceRevision"], headers=person.headers)
    late = client.put(f"/api/projects/{project_id}", json={"snapshot": tab, "workspaceRevision": old_revision},
                      headers=person.headers)
    assert late.status_code == 409


def test_an_agent_reopening_the_open_project_still_takes_the_tabs_last_save(workspace, person):
    client, _, store, broadcast = workspace
    mine = _create(client, "Mine", headers=person.headers)
    project_id = mine["project"]["id"]
    reopened = client.post(f"/api/projects/{project_id}/open",
                           json={"workspaceRevision": mine["workspaceRevision"]}, headers=AGENT)
    assert reopened.status_code == 200, reopened.text
    switch = _syncs(broadcast)[-1]["projectSwitch"]
    assert switch["previousProjectId"] == switch["projectId"] == project_id
    # The tab was showing this project at the old revision; its unsaved
    # edit lands instead of a 409 that would leave a "(recovered)" copy.
    tab = {"nodes": [_rf("local-sticky", "only in the tab")], "edges": [], "runHistory": [],
           "viewport": {"x": 5, "y": 5, "zoom": 1}, "createSessionId": None}
    saved = client.put(f"/api/projects/{project_id}", json={"snapshot": tab, "workspaceRevision": mine["workspaceRevision"]},
                       headers=person.headers)
    assert saved.status_code == 200, saved.text
    catalog = store.read()
    assert [node["id"] for node in catalog["projects"][project_id]["snapshot"]["nodes"]] == ["local-sticky"]
    assert len(catalog["projects"]) == 1


def test_a_stale_tab_cant_hand_off_into_some_other_project(workspace, person):
    client, _, _, _ = workspace
    first = _create(client, "First", headers=person.headers)
    second = _create(client, "Second", first["workspaceRevision"], headers=person.headers)
    _create(client, "Agent's", second["workspaceRevision"], headers=AGENT)
    # Only Second (what was open) takes a handoff, and only at its revision.
    tab = {"nodes": [], "edges": []}
    assert client.put(f"/api/projects/{first['project']['id']}", json={
        "snapshot": tab, "workspaceRevision": second["workspaceRevision"]}).status_code == 409
    assert client.put(f"/api/projects/{second['project']['id']}", json={
        "snapshot": tab, "workspaceRevision": first["workspaceRevision"]}).status_code == 409


# -- D3: agents don't wipe a canvas that has nodes ----------------------------------

def test_agents_cant_clear_or_replace_a_canvas_with_nodes(workspace, person):
    client, graph, _, _ = workspace
    _create(client, "Mine", headers=person.headers)
    graph.add_node("text-input", {"value": "keep"})
    before = graph.get_state()
    for method, path, body in (("DELETE", "/api/graph", None),
                               ("POST", "/api/graph/import", {"nodes": [], "edges": []})):
        response = client.request(method, path, headers=AGENT, **({"json": body} if body is not None else {}))
        assert response.status_code == 403, response.text
        assert "nebula project new" in response.json()["detail"] and "new_project" in response.json()["detail"]
        assert graph.get_state() == before
    # The person may clear (the CLI's --force without an agent name is the same).
    assert client.delete("/api/graph", headers=person.headers).status_code == 200
    assert graph.nodes == {}
    # An empty canvas has nothing to lose.
    assert client.delete("/api/graph", headers=AGENT).status_code == 200
    imported = client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": "x"}}], "edges": []})
    assert imported.status_code == 200, imported.text


def test_an_unnamed_cli_clear_still_works(workspace):
    client, graph, _, _ = workspace
    graph.add_node("text-input", {"value": "x"})
    assert client.delete("/api/graph").status_code == 200
    assert graph.nodes == {}


# -- F1/F2: covers -----------------------------------------------------------------

def _image_node(node_id, url, definition="nano-banana", key="image"):
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": definition, "params": {}, "outputs": {key: {"type": "Image", "value": url}}}}


def _reference(node_id, url):
    return {"id": node_id, "type": "model-node", "position": {"x": 0, "y": 0},
            "data": {"definitionId": "image-input", "params": {"filePath": "/x.png", "_previewUrl": url}, "outputs": {}}}


@pytest.fixture
def clock(monkeypatch):
    times: dict[str, float] = {}
    monkeypatch.setattr(project_cover, "_time_for", lambda url: times.get(url))
    return times


def test_the_cover_is_the_newest_made_image_not_the_last_node(clock):
    clock.update({"/api/outputs/new.png": 200.0, "/api/outputs/old.png": 100.0})
    snapshot = {"nodes": [_reference("ref", "/api/outputs/ref.png"),
                          _image_node("n1", "/api/outputs/new.png"),
                          _image_node("n2", "/api/outputs/old.png")]}
    assert project_cover.cover(snapshot) == {"source": "output", "images": ["/api/outputs/new.png"]}


def test_a_multi_image_output_and_a_saved_local_url_count(clock):
    snapshot = {"nodes": [_image_node("n1", ["http://127.0.0.1:8000/api/outputs/a.png", "/api/outputs/b.png"])]}
    clock.update({"/api/outputs/a.png": 1.0, "/api/outputs/b.png": 2.0})
    assert project_cover.cover(snapshot)["images"] == ["/api/outputs/b.png"]
    made, _ = project_cover.project_images(snapshot)
    assert made == ["/api/outputs/b.png", "/api/outputs/a.png"]


def test_only_references_make_a_mosaic_of_up_to_four(clock):
    refs = [_reference(f"r{i}", f"/api/outputs/ref{i}.png") for i in range(6)]
    # A reroute passing a reference along didn't make anything.
    passed = _image_node("n9", "/api/outputs/ref0.png", definition="reroute", key="output")
    found = project_cover.cover({"nodes": [*refs, passed]})
    assert found == {"source": "references", "images": [f"/api/outputs/ref{i}.png" for i in range(4)]}
    assert project_cover.cover({"nodes": [_rf("n1")]}) is None


def test_a_painted_mask_is_never_a_cover_and_a_paper_artboard_is_a_reference(clock):
    clock.update({"/api/outputs/made.png": 1.0, "/api/outputs/mask.png": 9.0})
    mask = _image_node("m", "/api/outputs/mask.png", definition="mask-painter", key="mask")
    made = _image_node("n1", "/api/outputs/made.png")
    assert project_cover.cover({"nodes": [made, mask]}) == {"source": "output", "images": ["/api/outputs/made.png"]}
    assert "/api/outputs/mask.png" not in [c["url"] for c in project_cover.choices({"nodes": [made, mask]})]
    paper = _image_node("p", "/api/outputs/artboard.png", definition="paper-source")
    assert project_cover.cover({"nodes": [paper, mask]}) == {"source": "references", "images": ["/api/outputs/artboard.png"]}


def test_a_pin_wins_while_its_image_is_in_the_project(clock):
    snapshot = {"nodes": [_image_node("n1", "/api/outputs/a.png"), _reference("r", "/api/outputs/ref.png")]}
    assert project_cover.cover(snapshot, "/api/outputs/ref.png") == {"source": "pinned", "images": ["/api/outputs/ref.png"]}
    # Its node was deleted: back to automatic (the pin stays, should it return).
    assert project_cover.cover({"nodes": snapshot["nodes"][:1]}, "/api/outputs/ref.png")["source"] == "output"


def test_the_backend_ranks_by_the_output_files_time(workspace, person):
    client, graph, _, _ = workspace
    _create(client, "Covers", headers=person.headers)
    old = main_module.OUTPUT_ROOT / "cover-test-old.png"
    new = main_module.OUTPUT_ROOT / "cover-test-new.png"
    try:
        for path, moment in ((new, 2_000_000_000), (old, 1_000_000_000)):
            path.write_bytes(b"png")
            os.utime(path, (moment, moment))
        graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": f"/api/outputs/{new.name}"}})
        graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": f"/api/outputs/{old.name}"}})
        listed = client.get("/api/projects").json()["projects"][0]
        assert listed["cover"] == {"source": "output", "images": [f"/api/outputs/{new.name}"]}
        assert listed["thumbnail"] == f"/api/outputs/{new.name}"
    finally:
        old.unlink(missing_ok=True)
        new.unlink(missing_ok=True)


def test_the_person_pins_and_unpins_a_cover(workspace, person, clock):
    client, graph, store, _ = workspace
    made = _create(client, "Pinned", headers=person.headers)
    project_id = made["project"]["id"]
    graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/a.png"}})
    graph.add_node("nano-banana", {}, outputs={"image": {"type": "Image", "value": "/api/outputs/b.png"}})
    clock.update({"/api/outputs/a.png": 1.0, "/api/outputs/b.png": 2.0})

    choices = client.get(f"/api/projects/{project_id}/covers").json()
    assert [image["url"] for image in choices["images"]] == ["/api/outputs/b.png", "/api/outputs/a.png"]
    assert choices["pinned"] is None

    for headers in (AGENT, {}):
        refused = client.put(f"/api/projects/{project_id}/cover", json={"url": "/api/outputs/a.png"}, headers=headers)
        assert refused.status_code == 403
    outside = client.put(f"/api/projects/{project_id}/cover", json={"url": "/api/outputs/elsewhere.png"},
                         headers=person.headers)
    assert outside.status_code == 400

    pinned = client.put(f"/api/projects/{project_id}/cover", json={"url": "/api/outputs/a.png"}, headers=person.headers)
    assert pinned.status_code == 200, pinned.text
    assert pinned.json()["project"]["cover"] == {"source": "pinned", "images": ["/api/outputs/a.png"]}
    assert client.get("/api/projects").json()["projects"][0]["cover"]["source"] == "pinned"

    unpinned = client.put(f"/api/projects/{project_id}/cover", json={"url": None}, headers=person.headers)
    assert unpinned.json()["project"]["cover"] == {"source": "output", "images": ["/api/outputs/b.png"]}
    assert "coverPin" not in store.read()["projects"][project_id]


def test_projects_saved_before_covers_get_one_when_listed(workspace, person, clock):
    client, _, store, _ = workspace
    made = _create(client, "Old", headers=person.headers)
    _create(client, "Open now", made["workspaceRevision"], headers=person.headers)
    catalog = store.read()
    project = catalog["projects"][made["project"]["id"]]
    project["snapshot"]["nodes"] = [_image_node("n1", "/api/outputs/a.png")]
    project.pop("cover")
    updated = project["updatedAt"]
    store.commit(catalog)
    listed = next(p for p in client.get("/api/projects").json()["projects"] if p["id"] == made["project"]["id"])
    assert listed["cover"] == {"source": "output", "images": ["/api/outputs/a.png"]}
    assert listed["updatedAt"] == updated  # a backfill isn't an edit
