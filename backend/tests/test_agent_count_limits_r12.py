"""PR #205 final review (MEDIUM): every agent write path stops at the node and
connection limits /api/graph/apply and the person's Save use, one call at a
time too; and one stalled socket can't hold up a graph sync for the others
(LOW). The limits are patched small."""
from __future__ import annotations

import asyncio
import json

import pytest

from tests.test_agent_canvas_limits_r9 import _accept, _open
from tests.test_agent_canvas_shape_limits_r8 import AGENT, api  # noqa: F401 (fixture)


def _line(nodes: int, edges: int, max_nodes: int, max_edges: int) -> str:
    return (f"A canvas holds at most {max_nodes:,} nodes and {max_edges:,} connections (the most a project can save). "
            f"This edit would leave {nodes:,} nodes and {edges:,} connections, so nothing changed.")


@pytest.fixture
def small(api, monkeypatch):
    """Limits of 4 nodes and 1 connection, with 2 nodes on the canvas."""
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_NODES", 4)
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_EDGES", 1)
    api.first = api.graph.add_node("text-input", {"value": "a"})
    api.second = api.graph.add_node("nano-banana", {})
    return api


def test_a_node_add_passes_at_the_limit_and_is_refused_past_it(small):
    api = small
    for _ in range(2):
        ok = api.client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input", "params": {}})
        assert ok.status_code == 200, ok.text
    refused = api.client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input", "params": {}})
    assert (refused.status_code, refused.json()["detail"]) == (413, _line(5, 0, 4, 1))
    assert len(api.graph.nodes) == 4


def test_the_persons_own_add_is_never_refused(small, person):
    api = small
    for _ in range(4):
        response = api.client.post("/api/graph/node", headers=person.headers,
                                   json={"definitionId": "text-input", "params": {}})
        assert response.status_code == 200, response.text
    assert len(api.graph.nodes) == 6


def test_a_connect_is_refused_past_the_connection_limit(small):
    api = small
    third = api.graph.add_node("text-input", {"value": "b"})
    fourth = api.graph.add_node("nano-banana", {})
    wire = {"source": api.first, "sourceHandle": "text", "target": api.second, "targetHandle": "prompt"}
    assert api.client.post("/api/graph/connect", headers=AGENT, json=wire).status_code == 200
    # The limit is one connection: another, between nodes already there, is refused.
    other = {"source": third, "sourceHandle": "text", "target": fourth, "targetHandle": "prompt"}
    refused = api.client.post("/api/graph/connect", headers=AGENT, json=other)
    assert (refused.status_code, refused.json()["detail"]) == (413, _line(4, 2, 4, 1))
    assert len(api.graph.edges) == 1


def test_node_and_connect_and_a_cluster_are_refused_past_the_node_limit(small):
    api = small
    api.graph.add_node("text-input", {"value": "c"})
    api.graph.add_node("text-input", {"value": "d"})  # at the limit
    both = api.client.post("/api/graph/node-and-connect", headers=AGENT, json={
        "definitionId": "text-input", "params": {},
        "connect": {"newNodeIs": "source", "target": api.second, "sourceHandle": "text", "targetHandle": "prompt"}})
    assert (both.status_code, both.json()["detail"]) == (413, _line(5, 1, 4, 1)), both.text
    cluster = api.client.post("/api/graph/cluster", headers=AGENT, json={
        "nodes": [{"tempId": "t1", "definitionId": "text-input", "params": {}}], "edges": []})
    assert (cluster.status_code, cluster.json()["detail"]) == (413, _line(5, 0, 4, 1))
    assert len(api.graph.nodes) == 4


def test_apply_and_a_proposal_are_refused_with_the_same_words(small):
    api = small
    api.graph.add_node("text-input", {"value": "c"})
    api.graph.add_node("text-input", {"value": "d"})
    plan = {"note": "More", "nodes": [{"ref": "+a", "definitionId": "text-input"}]}
    applied = api.client.post("/api/graph/apply", headers=AGENT, json=plan)
    proposed = api.client.post("/api/canvas/proposals", headers=AGENT, json=plan)
    assert (applied.status_code, proposed.status_code) == (413, 413)
    assert applied.json()["detail"] == proposed.json()["detail"] == _line(5, 0, 4, 1)


def test_an_edit_that_trims_or_leaves_a_canvas_past_a_limit_no_worse_goes_through(small):
    api = small
    for name in "cde":
        api.graph.add_node("text-input", {"value": name})  # 5 nodes: already past the limit of 4
    same = api.client.put(f"/api/graph/node/{api.first}", headers=AGENT, json={"params": {"value": "z"}})
    assert same.status_code == 200, same.text
    grow = api.client.post("/api/graph/node", headers=AGENT, json={"definitionId": "text-input", "params": {}})
    assert grow.status_code == 413


def test_an_accept_past_the_limit_is_refused_on_the_click_and_stays_open(small, person):
    api = small
    made, proposal_id, key = _open(api, {"note": "One", "nodes": [{"ref": "+a", "definitionId": "text-input"}]})
    assert made.status_code == 201, made.text
    # The canvas grew since: two more nodes, so the accepted one would be a 5th.
    api.graph.add_node("text-input", {"value": "c"})
    api.graph.add_node("text-input", {"value": "d"})
    refused = _accept(api, person, proposal_id, key)
    assert refused.status_code == 409, refused.text
    body = refused.json()
    assert (body["code"], body["limit"]) == ("proposal_too_complex", {"kind": "nodes", "max": 4})
    assert _line(5, 0, 4, 1) in body["detail"] and "The proposal is still open." in body["detail"]
    assert len(api.graph.nodes) == 4 and api.main.canvas_proposals.open_list()


def test_the_mcp_tool_and_propose_change_refuse_with_the_same_words(small, monkeypatch):
    import mcp_server
    from nebula_api import NebulaAPI, NebulaAPIError

    api = small
    api.graph.add_node("text-input", {"value": "c"})
    api.graph.add_node("text-input", {"value": "d"})
    client = api.client

    class _Api(NebulaAPI):
        def __init__(self):
            pass

        def request(self, method, path, *, headers=None, params=None, json=None, timeout=None, **kw):
            response = client.request(method, path, headers={**(headers or {}), **AGENT}, params=params, json=json)
            if response.status_code >= 400:
                payload = response.json()
                raise NebulaAPIError(str(payload.get("detail")), status=response.status_code, payload=payload)
            return response.json()

    monkeypatch.setattr(mcp_server, "_api", lambda: _Api())
    with pytest.raises(NebulaAPIError) as edit:
        mcp_server.edit_canvas(note="More", nodes=[{"ref": "+a", "definitionId": "text-input"}])
    with pytest.raises(NebulaAPIError) as propose:
        mcp_server.propose_change(note="More", nodes=[{"ref": "+a", "definitionId": "text-input"}])
    assert (edit.value.status, propose.value.status) == (413, 413)
    assert str(edit.value) == str(propose.value) == _line(5, 0, 4, 1)


# ---- LOW: one slow socket holds up every sync -------------------------------

def test_a_stalled_socket_is_closed_and_doesnt_stop_another_getting_the_sync(monkeypatch):
    import main as main_module

    monkeypatch.setattr(main_module, "SOCKET_SEND_TIMEOUT_SECONDS", 0.2)

    class Socket:
        headers: dict[str, str] = {}
        query_params: dict[str, str] = {}

        def __init__(self, stall: bool) -> None:
            self.stall, self.sent, self.closed = stall, [], False

        async def send_text(self, text: str) -> None:
            if self.stall:
                await asyncio.Event().wait()
            self.sent.append(json.loads(text))

        async def close(self) -> None:
            self.closed = True

    async def run() -> tuple[Socket, Socket, float]:
        manager = main_module.ConnectionManager()
        stalled, healthy = Socket(True), Socket(False)
        manager.active_connections = [stalled, healthy]
        loop = asyncio.get_running_loop()
        started = loop.time()
        await manager.broadcast_raw({"type": "graphSync", "n": 1})
        elapsed = loop.time() - started
        assert manager.active_connections == [healthy]
        return stalled, healthy, elapsed

    stalled, healthy, elapsed = asyncio.run(run())
    assert healthy.sent == [{"type": "graphSync", "n": 1}]
    assert stalled.closed and stalled.sent == []
    assert elapsed < 2.0
