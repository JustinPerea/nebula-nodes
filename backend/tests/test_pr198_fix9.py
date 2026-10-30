"""PR #198 fix round 9 (review 8; GM r12 answer 4): the conditional scene
write's agent rule, revisions and the connect a put-back sends.

- H-1: each scene has a revision that grows whenever Nebula holds another
  authoring for it, in every export, snapshot, sync, save answer and 409.
- M-1: a project switch away and back keeps an agent's read.
- M-2: a read is a session's (token, MCP session), not a name's.
- L-1: a refusal is not a read; reading again is.
- L-2: a write whose scene is Nebula's is never refused.
- L-3: ``onlyIfFree`` connect: 409 ``input_taken`` when the input holds
  another connection.
- GM r12 answer 4: the agent's refusal detail, verbatim; no Agent log row.
"""
from __future__ import annotations

import pytest

from services import scene_keys
from tests.test_round19_fence import AGENT, _canvas, _tab, api  # noqa: F401 - fixture

CODEX = {"X-Nebula-Agent": "Codex"}


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def _scene(*prompts: str) -> dict:
    return {"shots": [{"id": f"s{i + 1}", "prompt": p} for i, p in enumerate(prompts)]}


def _cinema(api) -> str:  # noqa: F811
    return api.graph.add_node("cinema-scene", {"scene": _scene("a quiet street", "a busy street")}, position={"x": 0, "y": 0})


def _export(api) -> dict:  # noqa: F811
    return api.client.get("/api/graph/export").json()


def _put(api, node, headers, scene, if_key=None, **extra):  # noqa: F811
    body = {"params": {"scene": scene, **extra}}
    if if_key is not None:
        body["ifSceneKey"] = if_key
    return api.client.put(f"/api/graph/node/{node}", headers=headers, json=body)


def _prompts(api, node):  # noqa: F811
    return [shot["prompt"] for shot in api.main.cli_graph.nodes[node]["params"]["scene"]["shots"]]


def _person_types(api, node, text="the person typed this"):  # noqa: F811
    typed = _put(api, node, _tab(api, _canvas(api)), _scene(text, "a busy street"), _export(api)["sceneKeys"][node])
    assert typed.status_code == 200, typed.text
    return typed


def test_h1_revisions_grow_with_each_authoring_and_stay_with_it(api):  # noqa: F811
    node = _cinema(api)
    first = _export(api)["sceneRevs"][node]
    assert _export(api)["sceneRevs"][node] == first  # the same scene, the same revision
    typed = _person_types(api, node)
    second = typed.json()["sceneRev"]
    assert second > first
    assert _export(api)["sceneRevs"][node] == second
    snap = api.client.get("/api/canvas/snapshot", headers=CODEX).json()
    assert snap["sceneRevs"][node] == second
    assert api.client.get("/api/graph", headers=CODEX).json()["sceneRevs"][node] == second
    # A 409 carries the revision of the scene it hands back.
    refused = _put(api, node, _tab(api, _canvas(api)), _scene("stale", "a busy street"), "not-the-key")
    assert refused.status_code == 409 and refused.json()["sceneRev"] == second
    # A runtime-only change is the same authoring: the same revision.
    api.main.cli_graph.nodes[node]["params"]["scene"]["shots"][0]["output"] = {"status": "done", "imageUrl": "/x.png"}
    assert _export(api)["sceneRevs"][node] == second


def test_m1_a_switch_away_and_back_keeps_the_agents_read(api):  # noqa: F811
    from tests.conftest import PERSON
    node = _cinema(api)
    assert api.client.get("/api/graph/export", headers=CODEX).status_code == 200
    for project in (api.second, api.first):
        rev = api.store.workspace()["workspaceRevision"]
        opened = api.client.post(f"/api/projects/{project}/open", headers=PERSON, json={"workspaceRevision": rev})
        assert opened.status_code == 200, opened.text
    assert node in api.main.cli_graph.nodes
    _person_types(api, node)
    stale = _put(api, node, CODEX, _scene("a quiet street", "codex's copy from before the switch"))
    assert stale.status_code == 409 and stale.json()["code"] == "scene_changed"
    assert _prompts(api, node) == ["the person typed this", "a busy street"]


def test_m2_two_sessions_of_one_agent_never_share_a_read(api):  # noqa: F811
    node = _cinema(api)
    one = {**CODEX, "X-Nebula-Agent-Session": "lane-1"}
    two = {**CODEX, "X-Nebula-Agent-Session": "lane-2"}
    assert api.client.get("/api/canvas/snapshot", headers=one).status_code == 200
    _person_types(api, node)
    assert api.client.get("/api/graph/export", headers=two).status_code == 200
    stale = _put(api, node, one, _scene("a quiet street", "lane 1's stale copy"))
    assert stale.status_code == 409 and stale.json()["code"] == "scene_changed"
    # Lane 2 read the typing: its write goes.
    taken = _put(api, node, two, _scene("the person typed this", "lane 2 on top"))
    assert taken.status_code == 200, taken.text


def test_m2_a_verified_token_is_its_own_reader(api, monkeypatch):  # noqa: F811
    from commons.actors import agent_registry
    records = {"tok-a": {"runner": "codex", "session": "chat-a"}, "tok-b": {"runner": "codex", "session": "chat-b"}}
    monkeypatch.setattr(agent_registry, "lookup", lambda token: records.get(token))
    node = _cinema(api)
    a = {"Authorization": "Agent tok-a"}
    b = {"Authorization": "Agent tok-b"}
    assert api.client.get("/api/graph/export", headers=a).status_code == 200
    _person_types(api, node)
    assert api.client.get("/api/graph/export", headers=b).status_code == 200
    assert _put(api, node, a, _scene("a quiet street", "chat a's stale copy")).status_code == 409


def test_l1_a_refusal_is_not_a_read_and_a_read_again_is(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/graph/export", headers=CODEX).status_code == 200
    _person_types(api, node)
    stale = _scene("a quiet street", "codex")
    # Sent again blindly (the CLI never shows the answer's scene): refused each time.
    assert [_put(api, node, CODEX, stale).status_code for _ in range(2)] == [409, 409]
    assert _prompts(api, node) == ["the person typed this", "a busy street"]
    # `nebula look` (a read), then the change on top: taken.
    assert api.client.get("/api/graph", headers=CODEX).status_code == 200
    assert _put(api, node, CODEX, _scene("the person typed this", "codex on top")).status_code == 200


def test_l2_a_write_whose_scene_is_nebulas_is_never_refused(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/graph/export", headers=CODEX).status_code == 200
    _person_types(api, node)
    current = api.main.cli_graph.nodes[node]["params"]["scene"]
    same = api.client.put(f"/api/graph/node/{node}", headers=CODEX, json={"params": {"scene": current}})
    assert same.status_code == 200, same.text


def test_gm_r12_the_agents_refusal_detail_and_no_log_row(api):  # noqa: F811
    node = _cinema(api)
    api.main.cli_graph.nodes[node]["label"] = "Opening"
    assert api.client.get("/api/graph/export", headers=CODEX).status_code == 200
    _person_types(api, node)
    before = len(api.sent)
    refused = _put(api, node, CODEX, _scene("a quiet street", "codex"))
    assert refused.status_code == 409
    assert refused.json()["detail"] == "“Opening” changed since you last read it, so nothing was changed. Read it again and redo your change."
    # Nothing goes out for the person: no Agent log row, no toast, no sync.
    assert api.sent[before:] == []


def test_l3_a_put_back_connect_never_takes_a_held_input(api):  # noqa: F811
    node = _cinema(api)
    target = api.graph.add_node("gpt-image-2-5-edit", {}, position={"x": 400, "y": 0})
    api.graph.connect(node, "shot_s1", target, "mask")
    body = {"source": node, "sourceHandle": "shot_s2", "target": target, "targetHandle": "mask", "onlyIfFree": True}
    taken = api.client.post("/api/graph/connect", headers=_tab(api, _canvas(api)), json=body)
    assert taken.status_code == 409 and taken.json()["code"] == "input_taken"
    assert [(e["sourceHandle"], e["targetHandle"]) for e in api.main.cli_graph.edges if e["target"] == target] == [("shot_s1", "mask")]
    api.main.cli_graph.edges[:] = [e for e in api.main.cli_graph.edges if e["target"] != target]
    free = api.client.post("/api/graph/connect", headers=_tab(api, _canvas(api)), json=body)
    assert free.status_code == 200, free.text


def test_docs_say_the_round_9_rule():
    """MCP-SETUP, SKILL.md and the MCP docstring (every feature has agent
    support): revisions, sessions, refusal is not a read, N-2, N-3, input_taken."""
    from pathlib import Path
    repo = Path(__file__).resolve().parents[2]
    setup = " ".join((repo / "docs/MCP-SETUP.md").read_text(encoding="utf-8").split())
    skill = " ".join((repo / "skills/nebula/SKILL.md").read_text(encoding="utf-8").split())
    assert "forgets every read" not in setup
    for line in ("`sceneRevs`", "`X-Nebula-Agent-Session`", "`NEBULA_AGENT_SESSION`", "A refusal is not a read",
                 "MCP has no scene write.", "keeps that session's read current", "`input_taken`", '"onlyIfFree": true',
                 "changed since you last read it, so nothing was changed. Read it again and redo your change."):
        assert line in setup, line
    assert "A refusal is not a read" in skill and "NEBULA_AGENT_SESSION" in skill


def test_mcp_sends_its_own_session():
    import mcp_server
    headers = mcp_server._agent_headers(None)
    assert headers.get("X-Nebula-Agent-Session") == mcp_server._AGENT_SESSION
    assert len(mcp_server._AGENT_SESSION) >= 8
