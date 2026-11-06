"""Review 7 of PR #205 (limits MEDIUM-1, MEDIUM-2, LOW-1, LOW-2; GM r16
items 2 and 3): every agent path is measured against Save's limits, "no
worse" compares measures that never stop early, an Accept that would leave
the canvas past them is refused on the click (the proposal stays open), and an
import's own checks answer with codes the person's Load line reads."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from services.agent_presence import AgentPresence
from services.canvas_arrange import ArrangeBook
from services.canvas_events import CanvasEventJournal
from services.canvas_pins import CanvasPins
from services.canvas_proposals import ProposalBook
from services.cli_graph import CLIGraph
from services.project_store import ProjectStore, make_project
from services.provider_recovery import ProviderRecoveryStore
from services.provider_start_guard import ProviderStartGuard

AGENT = {"X-Nebula-Agent": "Codex"}
KEY = "X-Nebula-Proposal-Key"
DEEP_MSG = ("This edit would leave the canvas nested more than 64 levels deep from its file's root, "
            "and the person's canvas can't save it. Nothing changed. Nest the value less deeply.")


@pytest.fixture
def api(tmp_path, monkeypatch, person):
    import main as main_module

    graph = CLIGraph(persist_path=tmp_path / "state.json")
    store = ProjectStore(tmp_path / "projects")
    with store.transaction() as catalog:
        project = make_project("Active")
        catalog["projects"][project["id"]] = project
        catalog["activeProjectId"] = project["id"]
        store.commit(catalog)
    browser: list[dict] = []

    async def capture(data, **kw):
        pass

    async def capture_browser(data, **kw):
        browser.append(data)

    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "project_store", store)
    monkeypatch.setattr(main_module, "canvas_pins", CanvasPins(lambda: main_module.project_store))
    monkeypatch.setattr(main_module, "canvas_proposals", ProposalBook())
    monkeypatch.setattr(main_module, "canvas_arrange", ArrangeBook())
    monkeypatch.setattr(main_module, "agent_presence", AgentPresence())
    monkeypatch.setattr(main_module, "canvas_events", CanvasEventJournal())
    monkeypatch.setattr(main_module, "provider_recovery_store", ProviderRecoveryStore(None))
    monkeypatch.setattr(main_module, "provider_start_guard", ProviderStartGuard(tmp_path / "paid-starts.json"))
    monkeypatch.setattr(main_module, "_graph_recovery_bootstrap_error", None)
    monkeypatch.setattr(main_module.manager, "broadcast_raw", capture)
    monkeypatch.setattr(main_module.manager, "broadcast_browser", capture_browser)

    class Api:
        pass

    ctx = Api()
    ctx.main = main_module
    ctx.client = TestClient(main_module.app)
    ctx.graph = graph
    ctx.browser = browser
    ctx.project_id = project["id"]
    return ctx


def _deep(levels: int) -> object:
    nested: object = "leaf"
    for _ in range(levels):
        nested = {"next": nested}
    return nested


def _measure(api) -> tuple[int, int]:
    """(depth, count) of the canvas's Save file, walked whole."""
    main = api.main
    view = main._canvas_save_file_view(main._graph_canvas_export(api.graph))
    deepest = count = 0
    stack = [(view, 0)]
    while stack:
        current, depth = stack.pop()
        count += 1
        deepest = max(deepest, depth)
        if isinstance(current, dict):
            stack.extend((value, depth + 1) for value in current.values())
        elif isinstance(current, list):
            stack.extend((value, depth + 1) for value in current)
    return deepest, count


# ---- MEDIUM-2: "no worse" never stops early ---------------------------------

def test_values_an_agent_adds_a_million_to_an_over_count_canvas_is_refused(api, person):
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    big = list(range(999_990))
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers, json={"params": {"value": big}}).status_code == 200
    assert _measure(api)[1] > 1_000_000
    response = api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": big}})
    assert response.status_code == 413, response.text
    assert api.graph.nodes[b]["params"]["value"] == "y"


def test_values_an_edit_that_leaves_an_over_count_canvas_no_worse_goes_through(api, person):
    """The values branch of "no worse": the same count after is not worse."""
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers,
                          json={"params": {"value": list(range(999_990))}}).status_code == 200
    response = api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": "z"}})
    assert response.status_code == 200, response.text


def test_depth_an_agent_going_deeper_on_a_too_deep_canvas_is_refused(api, person):
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    # 66 and 67 from the file's root.
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers, json={"params": {"value": _deep(61)}}).status_code == 200
    assert _measure(api)[0] == 66
    response = api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": _deep(62)}})
    assert (response.status_code, response.json()["detail"]) == (400, DEEP_MSG)


def test_depth_over_doesnt_hide_the_count(api, person):
    """The person's too-deep value doesn't stop the count: an agent's million
    values on another node are counted, and refused."""
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    assert api.client.put(f"/api/graph/node/{b}", headers=person.headers, json={"params": {"value": _deep(61)}}).status_code == 200
    response = api.client.put(f"/api/graph/node/{a}", headers=AGENT, json={"params": {"value": list(range(999_990))}})
    assert response.status_code == 413, response.text


def test_the_project_snapshots_count_is_read_when_run_history_puts_it_past(api, monkeypatch):
    """Run history the project keeps beside the canvas counts toward the
    project's own save: the agent's edit that puts the snapshot past the
    count is refused though the canvas's file alone is within it."""
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 400)
    node = api.graph.add_node("text-input", {"value": "x"})
    with api.main.project_store.transaction() as catalog:
        catalog["projects"][api.project_id]["snapshot"]["runHistory"] = [{"id": f"r{i}"} for i in range(150)]
        api.main.project_store.commit(catalog)
    _depth, base = _measure(api)
    room = 400 - base
    # Within the file's count, past the snapshot's (its history adds 300).
    response = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": list(range(room - 10))}})
    assert response.status_code == 413, response.text


# ---- MEDIUM-1: every agent path is measured ---------------------------------

@pytest.mark.parametrize("levels, status", [(59, 200), (60, 400)])
def test_an_agents_new_project_for_file_import_is_measured(api, levels, status):
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": _deep(levels)}}], "edges": [],
            "newProjectForFile": True}
    response = api.client.post("/api/graph/import", headers=AGENT, json=body)
    assert response.status_code == status, response.text
    if status == 400:
        assert response.json()["detail"] == DEEP_MSG
        assert not api.graph.nodes


def test_the_persons_new_project_for_file_import_is_never_measured(api, person):
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {"value": _deep(60)}}], "edges": [],
            "newProjectForFile": True}
    response = api.client.post("/api/graph/import", headers=person.headers, json=body)
    assert response.status_code == 200, response.text


def test_the_graph_file_clients_over_16mb_path_is_refused_end_to_end(api, tmp_path):
    """load_graph_file with a plain file over the save limit opens it as a new
    project (newProjectForFile): its value 60 below the param is refused."""
    import graph_file_client
    from nebula_api import NebulaAPI, NebulaAPIError

    big = "z" * (17 * 1024 * 1024)
    graph = {"version": 3, "name": "Deep", "createdAt": "2026-10-31T00:00:00Z",
             "nodes": [{"id": "n1", "type": "model-node", "position": {"x": 0, "y": 0},
                        "data": {"label": "Big", "definitionId": "text-input", "params": {"value": big}, "state": "idle"}},
                       {"id": "n2", "type": "model-node", "position": {"x": 0, "y": 0},
                        "data": {"label": "Deep", "definitionId": "text-input", "params": {"value": _deep(60)},
                                 "state": "idle"}}],
             "edges": []}
    path = tmp_path / "deep.nebula"
    path.write_text(json.dumps(graph))
    client = api.client
    sent: list[tuple[str, str, dict]] = []

    class _Api(NebulaAPI):
        def __init__(self):
            pass

        def request(self, method, p, *, headers=None, params=None, json=None, timeout=None, **kw):
            sent.append((method, p, json if isinstance(json, dict) else {}))
            resp = client.request(method, p, headers={**(headers or {}), **AGENT}, params=params, json=json)
            if resp.status_code >= 400:
                try:
                    payload = resp.json()
                except Exception:  # noqa: BLE001
                    payload = {}
                raise NebulaAPIError(str(payload.get("detail", resp.text)), status=resp.status_code, payload=payload)
            return resp.json()

    with pytest.raises(Exception) as caught:
        graph_file_client.load(_Api(), str(path), headers=AGENT)
    assert DEEP_MSG in str(caught.value)
    assert any(body.get("newProjectForFile") is True for _m, p, body in sent if p == "/api/graph/import")
    assert "n2" not in {node.get("label") for node in api.graph.nodes.values()}
    assert all(node.get("label") != "Deep" for node in api.graph.nodes.values())


@pytest.mark.parametrize("levels, status", [(59, 201), (60, 400)])
def test_an_agents_proposal_is_measured_at_and_past_saves_depth(api, levels, status):
    made = api.client.post("/api/canvas/proposals", headers=AGENT, json={
        "note": "Deep text", "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": _deep(levels)}}]})
    assert made.status_code == status, made.text
    if status == 400:
        assert made.json()["detail"] == DEEP_MSG


def test_an_agents_proposal_is_measured_at_and_past_saves_count(api, monkeypatch):
    import services.canvas_proposals as proposals_module

    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 400)
    monkeypatch.setattr(proposals_module, "MAX_OPEN_PER_AGENT", 50)
    monkeypatch.setattr(proposals_module, "MAX_OPEN_TOTAL", 50)
    _depth, base = _measure(api)

    def propose(length: int):
        return api.client.post("/api/canvas/proposals", headers=AGENT, json={
            "note": "List", "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": list(range(length))}}]})

    # Find the edge by halves (few proposals: they are rate limited): the
    # largest list the proposal can carry, then one more is refused.
    low, high = 1, 400
    while low < high:
        middle = (low + high + 1) // 2
        response = propose(middle)
        assert response.status_code in (201, 413), response.text
        low, high = (middle, high) if response.status_code == 201 else (low, middle - 1)
    assert 300 < low < 400
    refused = propose(low + 1)
    assert refused.status_code == 413, refused.text


def _open_proposal(api, value) -> tuple[str, str]:
    made = api.client.post("/api/canvas/proposals", headers=AGENT, json={
        "note": "List", "nodes": [{"ref": "+t", "definitionId": "text-input", "params": {"value": value}}]})
    assert made.status_code == 201, made.text
    proposal_id = made.json()["proposal"]["id"]
    key = next(m["acceptKey"] for m in api.browser if m.get("type") == "proposalOpened"
               and m.get("proposal", {}).get("id") == proposal_id)
    return proposal_id, key


def test_accept_after_the_canvas_changed_past_saves_count_is_refused_and_the_proposal_stays_open(api, person, monkeypatch):
    """GM r16 item 2: refused on the click with its code, the agent's answer
    giving the exact limit; nothing changed; the proposal is still open, and
    Accept works again once the canvas fits."""
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 400)
    other = api.graph.add_node("text-input", {"value": "x"})
    proposal_id, key = _open_proposal(api, list(range(150)))
    # The person's own edit since: the canvas plus the proposal is past the count.
    assert api.client.put(f"/api/graph/node/{other}", headers=person.headers,
                          json={"params": {"value": list(range(250))}}).status_code == 200
    nodes_before = set(api.graph.nodes)
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**person.headers, KEY: key}, json={})
    assert accepted.status_code == 409, accepted.text
    body = accepted.json()
    assert (body["code"], body["agent"], body["limit"]) == ("proposal_too_complex", "Codex", {"kind": "values", "max": 400})
    assert "more than 400 values" in body["detail"] and "The proposal is still open." in body["detail"]
    assert set(api.graph.nodes) == nodes_before
    assert api.main.canvas_proposals.get(proposal_id).status == "open"
    # The agent reads it in the canvas events, with the exact limit.
    events = api.client.get("/api/canvas/events?after=0&wait=0", headers=AGENT).json()["events"]
    refusals = [event for event in events if event["kind"] == "proposal.accept_refused"]
    assert [event["data"] for event in refusals] == [{"proposalId": proposal_id, "agentId": "ext:codex", "code": "proposal_too_complex",
                                                      "limit": {"kind": "values", "max": 400}}]
    from cli.formatter import format_event
    assert "was refused: the canvas would be holding more than 400 values; it is still open" in format_event(refusals[0])
    # The person trims their value: Accept goes through.
    assert api.client.put(f"/api/graph/node/{other}", headers=person.headers, json={"params": {"value": "x"}}).status_code == 200
    again = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**person.headers, KEY: key}, json={})
    assert again.status_code == 200, again.text


def test_accept_with_the_canvas_unchanged_goes_through(api, person, monkeypatch):
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_VALUES", 400)
    proposal_id, key = _open_proposal(api, list(range(150)))
    accepted = api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**person.headers, KEY: key}, json={})
    assert accepted.status_code == 200, accepted.text


# ---- LOW-1 / GM r16 item 3: the import's own checks answer with codes -------

@pytest.mark.parametrize("body, code", [
    ({"nodes": [{"id": "a", "definitionId": "no-such-node", "params": {}}], "edges": []}, "unknown_definition"),
    ({"nodes": [{"id": "a", "definitionId": "text-input", "params": {}},
                {"id": "b", "definitionId": "text-input", "params": {}}],
      "edges": [{"source": "a", "sourceHandle": "no-such-port", "target": "b", "targetHandle": "nope"}]}, "graph_unknown_port"),
    ({"nodes": [{"id": "a", "definitionId": "text-input", "params": "not an object"}], "edges": []}, "graph_invalid"),
    ({"nodes": [{"id": "a", "definitionId": "text-input", "params": {}}],
      "edges": [{"source": "a", "sourceHandle": "text", "target": "zzz", "targetHandle": "text"}]}, "graph_invalid"),
])
def test_the_imports_own_checks_answer_with_codes_and_keep_the_words(api, person, body, code):
    response = api.client.post("/api/graph/import", headers=person.headers, json=body)
    assert response.status_code == 400, response.text
    assert response.json()["code"] == code
    assert response.json()["detail"]


def test_a_cycle_answers_graph_cycle(api, person, monkeypatch):
    from execution.engine import CycleError

    def cyclic(*_args, **_kwargs):
        raise CycleError("a -> a")

    monkeypatch.setattr(api.main, "topological_sort", cyclic)
    body = {"nodes": [{"id": "a", "definitionId": "text-input", "params": {}}], "edges": []}
    response = api.client.post("/api/graph/import", headers=person.headers, json=body)
    assert (response.status_code, response.json()["code"]) == (400, "graph_cycle")
    assert response.json()["detail"].startswith("graph contains a cycle")
