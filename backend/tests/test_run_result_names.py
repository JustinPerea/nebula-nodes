"""A run result carries the node names its summary lines use (`names`, `ports`), so
printing it reads nothing that notes an agent's Cinema scene reads; "connected"
counts any canvas tab; `onScreen` counts every reported node (design)."""
from __future__ import annotations

import asyncio
import contextlib
import io

import pytest

from services import scene_keys
from services.agent_presence import MAX_SNAPSHOT_NODES, AgentPresence
from tests.test_pr198_fix8 import _canvas, _cinema, _prompts, _put, _scene, _tab  # noqa: F401
from tests.test_round19_fence import AGENT, api  # noqa: F401 - fixture


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def _finished(app, run_id: str, results: dict) -> dict:
    """GET /api/graph/runs/{id} for a CLI run that has finished with ``results``."""
    async def go() -> dict:
        async def done() -> dict:
            return {"results": results, "errors": {}, "skipped": {}, "duration": 1.0, "nodesExecuted": len(results)}

        task = asyncio.create_task(done())
        app._cli_runs.start(run_id, task, None, {"results": {}, "errors": {}})
        return await app.get_graph_run(run_id, wait=5)

    return asyncio.run(go())


def test_the_run_result_names_its_nodes_and_ports(api):  # noqa: F811
    node = api.graph.add_node("cinema-scene", {"scene": _scene("a")}, position={"x": 0, "y": 0})
    api.graph.nodes[node]["label"] = "Opening shot"
    out = _finished(api.main, "run-names-1", {node: {"shot_s1": {"type": "Image", "value": "x" * 300}},
                                              "gone": {"text": {"type": "Text", "value": "t"}}})
    assert out["status"] == "finished"
    # The name as the canvas shows it (node_route.node_name), only for nodes still on it.
    assert out["names"] == {node: "Opening shot"} and set(out["ports"]) == {node}
    assert "shot_s1" in out["ports"][node]


def test_a_result_with_no_outputs_gains_no_keys(api):  # noqa: F811
    out = api.main._with_result_names({"status": "running", "runId": "r"})
    assert "names" not in out and "ports" not in out


def test_printing_a_run_result_leaves_the_readers_scene_reads_alone(api, monkeypatch):  # noqa: F811
    """The CLI and MCP used to read GET /api/graph to name a node, which noted
    every scene key as read by the agent: a stale `nebula set` of a scene then
    went through over the person's typing instead of 409 scene_changed."""
    node = _cinema(api)
    assert api.client.get("/api/canvas/snapshot", headers=AGENT).status_code == 200  # the agent's read
    reads = lambda: {k: v for k, v in scene_keys._reads.items() if k[2] == node}  # noqa: E731
    read_before = reads()
    assert read_before  # the snapshot read noted the scene for this agent
    typed = _put(api, node, _tab(api, _canvas(api)), _scene("the person typed this", "a busy street"),
                 next(iter(read_before.values())))
    assert typed.status_code == 200, typed.text

    noted: list = []
    real = scene_keys.note_read
    monkeypatch.setattr(scene_keys, "note_read", lambda *a, **k: (noted.append(a), real(*a, **k))[1])
    # The run, collapsed output and all, printed the way the CLI does.
    from cli.commands import execute

    result = _finished(api.main, "run-names-2", {node: {"moodboard": {"type": "Moodboard", "value": {"k": "x" * 300}}}})
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        execute._report(result, None)
    assert out.getvalue().splitlines()[0].startswith("“") and "moodboard" not in out.getvalue().splitlines()[0].split("·")[0]
    assert noted == []
    assert reads() == read_before  # the read did not move forward
    refused = _put(api, node, AGENT, _scene("a quiet street", "codex's busy street"))
    assert refused.status_code == 409 and refused.json()["code"] == "scene_changed"
    assert _prompts(api, node) == ["the person typed this", "a busy street"]


# -- connected: any canvas tab -----------------------------------------------------------------

class _Socket:
    def __init__(self, headers=None):
        self.headers = headers or {}


def _marked(main) -> dict:
    snap: dict = {"view": {}}
    main._mark_tab_connected(snap)
    return snap["view"]


def test_an_unverified_tab_still_reads_as_connected(monkeypatch):
    import main

    manager = main.ConnectionManager()
    monkeypatch.setattr(main, "manager", manager)
    assert _marked(main) == {"connected": False, "kept": False}

    tab = _Socket()  # opened without the person link: connected, but not in browser_connections
    manager.active_connections.append(tab)
    assert _marked(main)["connected"] is True and tab not in manager.browser_connections

    manager.active_connections.clear()
    verified = _Socket()  # a socket the person token verified
    manager.active_connections.append(verified)
    manager.browser_connections.add(verified)
    assert _marked(main)["connected"] is True


def test_a_tab_that_keeps_edits_is_marked_kept(monkeypatch):
    import main

    manager = main.ConnectionManager()
    monkeypatch.setattr(main, "manager", manager)
    tab = _Socket()
    manager.active_connections.append(tab)
    manager.browser_connections.add(tab)
    manager.kept_tabs.add(tab)
    assert _marked(main) == {"connected": True, "kept": True}


# -- onScreen over every reported node ---------------------------------------------------------

class _Graph:
    def __init__(self, count: int):
        self.nodes = {f"n{i}": {"definitionId": "x", "params": {}} for i in range(count)}
        self.edges: list = []


class _Registry:
    def get_all(self) -> dict:
        return {}


def test_on_screen_counts_past_the_snapshot_cap():
    total = MAX_SNAPSHOT_NODES + 1
    presence = AgentPresence()
    # Every node is far off to the right except the last, which is past the cap.
    nodes = [{"id": f"n{i}", "x": 5000.0 + i, "y": 0.0, "width": 10.0, "height": 10.0} for i in range(total)]
    nodes[-1].update(x=20.0, y=20.0)
    presence.report_view({"viewport": {"x": 0, "y": 0, "zoom": 1}, "screen": {"width": 400, "height": 400}, "nodes": nodes})
    snap = presence.snapshot(_Graph(total), _Registry())
    assert len(snap["nodes"]) == MAX_SNAPSHOT_NODES and snap["nodeCount"] == total
    assert not any(node.get("onScreen") for node in snap["nodes"])  # the listed ones are all off screen
    assert snap["view"]["onScreenCount"] == 1  # the one past the cap counts

    from cli.formatter import tab_state_line
    from services import agent_start

    part = agent_start.canvas_part({**snap, "view": {**snap["view"], "connected": True, "stale": False}},
                                   project=None, caller_id=None, via="cli")
    assert part["view"]["onScreen"] == 1
    assert tab_state_line(part["view"], part["nodeCount"]) == f"Watching: 1 of {total} nodes on screen."


def test_no_count_without_a_visible_area():
    snap = AgentPresence().snapshot(_Graph(3), _Registry())
    assert "onScreenCount" not in snap["view"]
