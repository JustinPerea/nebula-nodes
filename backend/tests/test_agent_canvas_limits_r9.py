"""Review 8 of PR #205 (limits MEDIUM-1, LOW-1, NIT-1, NIT-2): a proposal is
measured against the 16 MiB project size limit when it is made and on every
Accept, as the edit it stages would be; on a canvas already too deep an
agent's write may only take depth away; the uncapped "no worse" walk is timed
on the largest canvas Save allows; an Accept refused for depth names it."""
from __future__ import annotations

import argparse
import io
import json
import time

import pytest
from fastapi.testclient import TestClient

from services import project_size
from services.project_store import MAX_PROJECT_BYTES
from tests.test_agent_canvas_shape_limits_r8 import AGENT, DEEP_MSG, KEY, _deep, _measure, api  # noqa: F401 (fixture)

MIB = 1024 * 1024


def _project_bytes(api) -> int:
    """The open project's size as the save check measures it, with the canvas as Nebula holds it."""
    main = api.main
    return project_size.snapshot_bytes(main._overlaid_snapshot(main._open_project_record(api.project_id),
                                                                main._graph_canvas_export(api.graph)))


def _open(api, body: dict):
    made = api.client.post("/api/canvas/proposals", headers=AGENT, json=body)
    if made.status_code != 201:
        return made, None, None
    proposal_id = made.json()["proposal"]["id"]
    key = next(m["acceptKey"] for m in api.browser if m.get("type") == "proposalOpened"
               and m.get("proposal", {}).get("id") == proposal_id)
    return made, proposal_id, key


def _accept(api, person, proposal_id: str, key: str):
    return api.client.post(f"/api/canvas/proposals/{proposal_id}/accept", headers={**person.headers, KEY: key}, json={})


def _refusals(api) -> list[dict]:
    events = api.client.get("/api/canvas/events?after=0&wait=0", headers=AGENT).json()["events"]
    return [event for event in events if event["kind"] == "proposal.accept_refused"]


def _set_params(node_id: str, value: str) -> dict:
    return {"note": "Long text", "params": [{"nodeId": node_id, "params": {"value": value}}]}


# ---- MEDIUM-1: a proposal is measured against the project size limit --------

@pytest.mark.parametrize("over", [0, 1])
def test_a_proposal_is_measured_at_and_past_the_16_mib_size_limit(api, over):
    """The staged canvas at exactly 16 MiB is proposed; one byte more is
    refused as the direct edit is (413 with limit "size"), nothing changed."""
    node = api.graph.add_node("text-input", {"value": ""})
    empty = _project_bytes(api)
    # A string of ASCII letters adds a byte per letter.
    value = "z" * (MAX_PROJECT_BYTES - empty + over)
    made, proposal_id, _key = _open(api, _set_params(node, value))
    if not over:
        assert made.status_code == 201, made.text[:300]
        return
    assert made.status_code == 413, made.text[:300]
    body = made.json()
    assert (body["limit"], body["sizeBytes"], body["limitBytes"]) == ("size", MAX_PROJECT_BYTES + 1, MAX_PROJECT_BYTES)
    assert body["detail"].startswith(f"This edit would leave the open project at {MAX_PROJECT_BYTES + 1:,} bytes, "
                                     "over Nebula's save limit of 16 MiB")
    assert proposal_id is None and not api.main.canvas_proposals.open_list()
    assert api.graph.nodes[node]["params"]["value"] == ""
    # The same edit made directly gets the same answer.
    direct = api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": value}})
    assert (direct.status_code, direct.json()["detail"]) == (413, body["detail"])


def test_the_reviewers_9_mib_proposal_is_refused_as_apply_is(api):
    """Review 8's repro: apply refused the 9 MiB node with 413, the same node
    as a proposal was made and accepted (the project then 18 MB)."""
    node = api.graph.add_node("text-input", {"value": "x"})
    nine = "z" * (9 * MIB)
    assert api.client.put(f"/api/graph/node/{node}", headers=AGENT, json={"params": {"value": nine}}).status_code == 200
    direct = api.client.post("/api/graph/apply", headers=AGENT, json={
        "nodes": [{"ref": "+d", "definitionId": "text-input", "params": {"value": nine}}]})
    made, _proposal_id, _key = _open(api, {"note": "big", "nodes": [
        {"ref": "+n", "definitionId": "text-input", "params": {"value": nine}}]})
    assert (direct.status_code, made.status_code) == (413, 413)
    # The same words (the sizes differ by the new node's place on the canvas).
    for answer in (direct, made):
        assert answer.json()["detail"].startswith("This edit would leave the open project at ")
        assert answer.json()["limit"] == "size"


def test_a_proposal_that_trims_a_project_already_over_the_limit_is_made(api, person):
    """No worse: on a project the person made too large, a proposal that
    makes it smaller goes through, and so does its Accept."""
    node = api.graph.add_node("text-input", {"value": "x"})
    assert api.client.put(f"/api/graph/node/{node}", headers=person.headers,
                          json={"params": {"value": "z" * (17 * MIB)}}).status_code == 200
    assert _project_bytes(api) > MAX_PROJECT_BYTES
    made, proposal_id, key = _open(api, _set_params(node, "short"))
    assert made.status_code == 201, made.text[:300]
    assert _accept(api, person, proposal_id, key).status_code == 200


@pytest.mark.parametrize("over", [0, 1])
def test_accept_after_the_project_grew_to_and_past_the_size_limit(api, person, over):
    """A proposal that was within the size limit when made: after the
    person's own edit, an Accept that lands at exactly 16 MiB goes through,
    and one a byte past is refused like the shape limits (409
    proposal_too_complex with limit {kind: size, max}, the accept_refused
    event, the proposal still open, Accept live again once it fits)."""
    mine = api.graph.add_node("text-input", {"value": ""})
    theirs = api.graph.add_node("text-input", {"value": ""})
    empty = _project_bytes(api)
    proposed = "z" * (9 * MIB)
    made, proposal_id, key = _open(api, _set_params(theirs, proposed))
    assert made.status_code == 201, made.text[:300]
    grown = "y" * (MAX_PROJECT_BYTES - empty - len(proposed) + over)
    assert api.client.put(f"/api/graph/node/{mine}", headers=person.headers, json={"params": {"value": grown}}).status_code == 200
    accepted = _accept(api, person, proposal_id, key)
    if not over:
        assert accepted.status_code == 200, accepted.text[:300]
        assert _project_bytes(api) == MAX_PROJECT_BYTES
        return
    assert accepted.status_code == 409, accepted.text[:300]
    body = accepted.json()
    limit = {"kind": "size", "max": MAX_PROJECT_BYTES}
    assert (body["code"], body["agent"], body["limit"]) == ("proposal_too_complex", "Codex", limit)
    assert body["detail"].startswith(f"The person's Accept of Codex's proposal {proposal_id} was refused: "
                                     f"This edit would leave the open project at {MAX_PROJECT_BYTES + 1:,} bytes")
    assert body["detail"].endswith("The proposal is still open.")
    assert api.graph.nodes[theirs]["params"]["value"] == ""
    assert api.main.canvas_proposals.get(proposal_id).status == "open"
    [refusal] = _refusals(api)
    assert refusal["data"] == {"proposalId": proposal_id, "agentId": "ext:codex", "code": "proposal_too_complex",
                               "limit": limit}
    assert refusal["actor"]["kind"] == "person"
    # The CLI's line for the event (nebula events, nebula watch).
    from cli.formatter import format_event
    assert ("was refused: the canvas would be over Nebula's save limit of 16 MiB; it is still open"
            in format_event(refusal))
    # The person trims their text: Accept goes through.
    assert api.client.put(f"/api/graph/node/{mine}", headers=person.headers, json={"params": {"value": "y"}}).status_code == 200
    again = _accept(api, person, proposal_id, key)
    assert again.status_code == 200, again.text[:300]
    assert api.graph.nodes[theirs]["params"]["value"] == proposed


def test_the_mcp_and_cli_answers_for_a_proposal_past_the_size_limit(api, monkeypatch, capsys, tmp_path):
    """propose_change raises with Nebula's words; `nebula propose` prints
    them as its error and exits 1. Nothing is proposed."""
    import mcp_server
    from cli.client import NebulaClient
    from cli.commands import proposals as proposals_cmd
    from nebula_api import NebulaAPI, NebulaAPIError

    node = api.graph.add_node("text-input", {"value": ""})
    value = "z" * (MAX_PROJECT_BYTES - _project_bytes(api) + 1)
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
    with pytest.raises(NebulaAPIError) as refused:
        mcp_server.propose_change(note="Long text", params=[{"nodeId": node, "params": {"value": value}}])
    assert refused.value.status == 413
    assert str(refused.value).startswith(f"This edit would leave the open project at {MAX_PROJECT_BYTES + 1:,} bytes")
    assert refused.value.payload["limit"] == "size"

    cli = NebulaClient("http://testserver")
    cli._client = TestClient(api.main.app)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps(_set_params(node, value)))
    args = argparse.Namespace(file=str(plan), note=None, add=[], param=[], set_params=[], wire=[], run=[],
                              at=[], rename=[], wait=False, timeout=60.0, json=False, agent_name="Codex")
    with pytest.raises(SystemExit) as exited:
        proposals_cmd.run_propose(cli, args, out=io.StringIO())
    assert exited.value.code == 1
    err = capsys.readouterr().err
    assert err.startswith(f"error: This edit would leave the open project at {MAX_PROJECT_BYTES + 1:,} bytes")
    assert not api.main.canvas_proposals.open_list()
    assert api.graph.nodes[node]["params"]["value"] == ""


# ---- LOW-1: on a too-deep canvas an agent may only take depth away ----------

def test_depth_an_agent_adding_a_second_value_as_deep_as_the_deepest_is_refused(api, person):
    """Review 8's P1: the person's value is 66 deep; Codex's 66-deep value on
    another node was "no worse" (the deepest stayed 66) and left the canvas
    unsaveable once the person fixed theirs."""
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers, json={"params": {"value": _deep(61)}}).status_code == 200
    assert _measure(api)[0] == 66
    response = api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": _deep(61)}})
    assert (response.status_code, response.json()["detail"]) == (400, DEEP_MSG)
    assert api.graph.nodes[b]["params"]["value"] == "y"
    # One value past the limit is as worse as many: 65 deep, one past.
    response = api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": _deep(60)}})
    assert response.status_code == 400


def test_depth_on_a_too_deep_canvas_an_agent_may_take_depth_away_or_add_within_the_limit(api, person):
    a = api.graph.add_node("text-input", {"value": "x"})
    b = api.graph.add_node("text-input", {"value": "y"})
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers, json={"params": {"value": _deep(62)}}).status_code == 200
    # At the limit (64 from the file's root), not past it: no value past it is added.
    assert api.client.put(f"/api/graph/node/{b}", headers=AGENT, json={"params": {"value": _deep(59)}}).status_code == 200
    # Shallower than it was, still too deep: fewer values past the limit.
    assert api.client.put(f"/api/graph/node/{a}", headers=AGENT, json={"params": {"value": _deep(61)}}).status_code == 200
    assert _measure(api)[0] == 66
    # The same depth again, a value for a value: no worse.
    assert api.client.put(f"/api/graph/node/{a}", headers=AGENT, json={"params": {"value": {"other": _deep(60)}}}).status_code == 200
    # Deeper on the same node: more values past the limit.
    response = api.client.put(f"/api/graph/node/{a}", headers=AGENT, json={"params": {"value": _deep(62)}})
    assert response.status_code == 400


def test_depth_a_proposal_on_a_too_deep_canvas_follows_the_same_rule(api, person):
    """Review 8's P5, made and accepted: a proposal adding no value past the
    limit is accepted on a canvas the person made too deep; one adding any
    value past the limit is refused when made."""
    a = api.graph.add_node("text-input", {"value": "x"})
    assert api.client.put(f"/api/graph/node/{a}", headers=person.headers, json={"params": {"value": _deep(61)}}).status_code == 200
    made, proposal_id, key = _open(api, {"note": "deep", "nodes": [
        {"ref": "+n", "definitionId": "text-input", "params": {"value": _deep(59)}}]})
    assert made.status_code == 201, made.text
    assert _accept(api, person, proposal_id, key).status_code == 200
    # 65 from the file's root (60 below the param): a value past the limit.
    refused, _id, _key = _open(api, {"note": "deeper", "nodes": [
        {"ref": "+m", "definitionId": "text-input", "params": {"value": _deep(60)}}]})
    assert (refused.status_code, refused.json()["detail"]) == (400, DEEP_MSG)


# ---- NIT-2: an Accept refused for depth names the depth limit (mutant b08) ---

def test_accept_refused_for_depth_names_the_depth_limit(api, person, monkeypatch):
    """The canvas's limit changes under an open proposal (here the limit
    itself, as a person's edit can't make a proposal's own value deeper): the
    Accept is refused with limit {kind: depth}, in the answer and the event,
    and the CLI's line names the depth."""
    made, proposal_id, key = _open(api, {"note": "deep", "nodes": [
        {"ref": "+n", "definitionId": "text-input", "params": {"value": _deep(50)}}]})
    assert made.status_code == 201, made.text
    monkeypatch.setattr(api.main, "RESTORE_MAX_GRAPH_DEPTH", 40)
    accepted = _accept(api, person, proposal_id, key)
    assert accepted.status_code == 409, accepted.text
    body = accepted.json()
    assert (body["code"], body["limit"]) == ("proposal_too_complex", {"kind": "depth", "max": 40})
    assert "nested more than 40 levels deep" in body["detail"]
    [refusal] = _refusals(api)
    assert refusal["data"]["limit"] == {"kind": "depth", "max": 40}
    from cli.formatter import format_event
    assert "the canvas would be nested more than 40 levels deep; it is still open" in format_event(refusal)
    assert api.main.canvas_proposals.get(proposal_id).status == "open"


def test_the_cli_line_for_a_limit_with_no_max_never_reads_none():
    from cli.formatter import format_event

    for kind, words in [("depth", "nested too deeply to save"), ("values", "too complex to save"),
                        ("size", "too large to save"), ("other", "too complex to save")]:
        line = format_event({"seq": 1, "kind": "proposal.accept_refused", "actor": {"kind": "person"},
                             "data": {"proposalId": "p_a", "limit": {"kind": kind}}, "summary": "x"})
        assert f"the canvas would be {words};" in line and "None" not in line


# ---- NIT-1: the uncapped walk, timed on the largest canvas Save allows ------

def test_the_no_worse_walk_on_the_largest_canvas_save_allows_is_within_budget(api, person):
    """A canvas at exactly 1,000,000 values (the most Save saves), and an
    agent's write that would add values past it: refused, after measuring
    the canvas whole before and after, within budget on a loaded machine."""
    main = api.main
    node = api.graph.add_node("text-input", {"value": []})
    other = api.graph.add_node("text-input", {"value": "y"})
    base = _measure(api)[1]
    room = main.RESTORE_MAX_GRAPH_VALUES - base
    assert api.client.put(f"/api/graph/node/{node}", headers=person.headers,
                          json={"params": {"value": list(range(room))}}).status_code == 200
    assert _measure(api)[1] == main.RESTORE_MAX_GRAPH_VALUES
    view = main._canvas_save_file_view(main._graph_canvas_export(api.graph))
    started = time.perf_counter()
    assert main._graph_shape_measure_past(view)[1] == main.RESTORE_MAX_GRAPH_VALUES
    one_walk = time.perf_counter() - started
    export = main._graph_canvas_export(api.graph)
    grown = {"nodes": [dict(item, data={**item["data"], "params": {"value": [1, 2]}}) if item["id"] == other else item
                       for item in export["nodes"]], "edges": export["edges"]}
    started = time.perf_counter()
    found = main._shape_past_save_limit(grown)
    no_worse = time.perf_counter() - started
    assert found is not None and found[2] == {"kind": "values", "max": main.RESTORE_MAX_GRAPH_VALUES}
    # Measured at load average ~30: 0.04 s per walk (0.115 s for round 8's
    # walk), 0.17 s for the whole check (two walks and the export), 0.28 s
    # for the refused PUT. The bounds leave room for a machine under load.
    assert one_walk < 1.0, one_walk
    assert no_worse < 2.5, no_worse
    # The agent's write itself: refused, and quickly.
    started = time.perf_counter()
    response = api.client.put(f"/api/graph/node/{other}", headers=AGENT, json={"params": {"value": [1, 2]}})
    assert response.status_code == 413, response.text
    assert time.perf_counter() - started < 5.0


def test_the_walk_never_stops_early_and_counts_every_value_past_the_depth_limit(api):
    """However deep the value (the ingress check bounds a write, not a
    canvas built from many), every level is walked and counted."""
    main = api.main
    deepest, count, past = main._graph_shape_measure_past(_deep(300))
    assert (deepest, count, past) == (300, 301, 300 - main.RESTORE_MAX_GRAPH_DEPTH)
    # The root, [1, [...]], 1, [2, {...}], 2, {"a": 3}, 3 and 4.
    assert main._graph_shape_measure([[1, [2, {"a": 3}]], 4]) == (4, 8)
