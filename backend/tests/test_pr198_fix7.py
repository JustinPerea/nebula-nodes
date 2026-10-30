"""PR #198 fix round 7 (review 6, M1): a clear or an import of the open
project is not a switch. A tab write made for the canvas before it gets
``code: "canvas_replaced"`` (with ``project`` and ``switchedBy``), so the
scene save says no line of its own and #195's "cleared while you were
editing" line covers it; ``workspace_moved`` stays for another project
opened, made or deleted."""
from __future__ import annotations

from tests.test_round19_fence import AGENT, STALE, _canvas, _tab, _text, api  # noqa: F401 - fixture


def _stale_scene_put(api, node, canvas):  # noqa: F811
    return api.client.put(f"/api/graph/node/{node}", headers=_tab(api, canvas), json={"params": {"value": "B"}})


def test_an_agent_clear_of_the_open_project_reads_canvas_replaced(api):  # noqa: F811
    node = _text(api)
    held = _canvas(api)
    assert api.client.delete("/api/graph?force=true", headers=AGENT).status_code == 200
    _text(api, "AG")
    refused = _stale_scene_put(api, node, held)
    assert refused.status_code == 409
    body = refused.json()
    assert body["detail"] == STALE
    assert body["code"] == "canvas_replaced"
    assert body["project"]["name"] == "Active"
    assert body["switchedBy"] == {"kind": "agent", "name": "Claude"}
    assert api.graph.nodes[node]["params"]["value"] == "AG"


def test_an_import_reads_canvas_replaced(api):  # noqa: F811
    node = _text(api)
    held = _canvas(api)
    imported = api.client.post("/api/graph/import", headers=AGENT, json={
        "nodes": [{"id": "x", "definitionId": "text-input", "params": {"value": "i"}, "position": {"x": 0, "y": 0}}],
        "edges": []})
    assert imported.status_code == 200, imported.text
    refused = _stale_scene_put(api, node, held)
    assert refused.status_code == 409
    assert refused.json()["code"] == "canvas_replaced"
    assert refused.json()["project"]["name"] == "Active"


def test_the_persons_own_clear_in_another_window_reads_canvas_replaced_by_the_person(api):  # noqa: F811
    node = _text(api)
    held = _canvas(api)
    assert api.client.delete("/api/graph?force=true", headers=_tab(api, held)).status_code == 200
    refused = _stale_scene_put(api, node, held)
    assert refused.json()["code"] == "canvas_replaced"
    assert refused.json()["switchedBy"] == {"kind": "person", "name": "You"}


def test_another_project_opened_still_reads_workspace_moved(api):  # noqa: F811
    node = _text(api)
    held = _canvas(api)
    revision = api.store.workspace()["workspaceRevision"]
    opened = api.client.post(f"/api/projects/{api.second}/open", headers=AGENT, json={"workspaceRevision": revision})
    assert opened.status_code == 200, opened.text
    refused = api.client.put(f"/api/graph/node/{node}", headers=_tab(api, held, revision), json={"params": {"value": "B"}})
    assert refused.status_code == 409
    assert refused.json()["code"] == "workspace_moved"
    assert refused.json()["project"]["name"] == "Other"
