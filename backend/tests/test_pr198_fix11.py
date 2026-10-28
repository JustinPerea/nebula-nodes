"""PR #198 fix round 11 (review 10): the agent rule's channels, and ’ in
the lines this PR's backend added.

L-1 (review 10's probes, kept): a write is checked against its own
channel's read first. A writer with no session (the CLI, a plain PUT) has
the name's session-less read as its own; only if it never read is it held
to the newest read by any session of that name (kept apart, so a session
read never refreshes a session-less one). A session's own read comes first,
then that newest session read, then the name's session-less read.
"""
from __future__ import annotations

import pytest

from services import scene_keys
from tests.test_pr198_fix9 import CODEX, _cinema, _person_types, _prompts, _put, _scene
from tests.test_round19_fence import AGENT, _canvas, _tab, api  # noqa: F401 - fixture

MCP = {**CODEX, "X-Nebula-Agent-Session": "mcp-proc-1"}
TYPED = ["the person typed this", "a busy street"]


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def _refused(response) -> bool:
    return response.status_code == 409 and response.json().get("code") == "scene_changed"


def test_b1_an_mcp_read_guards_a_cli_write_that_never_read(api):  # noqa: F811
    node = _cinema(api)
    api.client.get("/api/canvas/snapshot", headers=MCP)
    _person_types(api, node)
    assert _refused(_put(api, node, CODEX, _scene("a quiet street", "stale via cli")))
    assert _prompts(api, node) == TYPED


def test_c1_a_fresh_mcp_read_never_refreshes_the_clis_older_look(api):  # noqa: F811
    node = _cinema(api)
    api.client.get("/api/graph", headers=CODEX)  # nebula look, no session: before the typing
    _person_types(api, node)
    api.client.get("/api/canvas/snapshot", headers=MCP)  # another session of the name reads fresh
    assert _refused(_put(api, node, CODEX, _scene("a quiet street", "cli stale from its old look")))
    assert _prompts(api, node) == TYPED
    # The recovery the refusal asks for: nebula look, then redo.
    api.client.get("/api/graph", headers=CODEX)
    assert _put(api, node, CODEX, _scene("the person typed this", "redone")).status_code == 200


def test_c1b_two_session_less_lanes_still_share_one_read(api):  # noqa: F811
    # Documented: without NEBULA_AGENT_SESSION two lanes of one name are one reader.
    node = _cinema(api)
    api.client.get("/api/graph", headers=CODEX)
    _person_types(api, node)
    api.client.get("/api/graph", headers=CODEX)
    assert _put(api, node, CODEX, _scene("a quiet street", "lane A stale")).status_code == 200


def test_c2_lanes_with_their_own_sessions_stay_apart(api):  # noqa: F811
    node = _cinema(api)
    one = {**CODEX, "X-Nebula-Agent-Session": "lane-1"}
    two = {**CODEX, "X-Nebula-Agent-Session": "lane-2"}
    api.client.get("/api/graph/export", headers=one)
    _person_types(api, node)
    api.client.get("/api/graph/export", headers=two)
    assert _refused(_put(api, node, one, _scene("a quiet street", "lane 1 stale")))
    assert _put(api, node, two, _scene("the person typed this", "lane 2 on top")).status_code == 200


def test_c3_a_session_that_never_read(api):  # noqa: F811
    node = _cinema(api)
    api.client.get("/api/graph/export", headers=CODEX)  # the name's session-less read, before the typing
    _person_types(api, node)
    # No session read yet: held to the name's session-less read.
    assert _refused(_put(api, node, {**CODEX, "X-Nebula-Agent-Session": "lane-3"}, _scene("a quiet street", "lane 3")))
    assert _prompts(api, node) == TYPED
    # After lane 2's fresh read, a session that never read is held to that
    # newest session read: current, so it writes as it sends (the last
    # writer, as a reader that never read always has).
    api.client.get("/api/graph/export", headers={**CODEX, "X-Nebula-Agent-Session": "lane-2"})
    late = _put(api, node, {**CODEX, "X-Nebula-Agent-Session": "lane-4"}, _scene("a quiet street", "lane 4"))
    assert late.status_code == 200


def test_c4_a_verified_token_is_never_the_names_reader(api, monkeypatch):  # noqa: F811
    from commons.actors import agent_registry
    monkeypatch.setattr(agent_registry, "lookup", lambda token: {"runner": "codex", "session": "chat-a"} if token == "tok-a" else None)
    node = _cinema(api)
    token = {"Authorization": "Agent tok-a", "X-Nebula-Agent": "Codex", "X-Nebula-Agent-Session": "mcp-proc-1"}
    api.client.get("/api/graph/export", headers=CODEX)
    _person_types(api, node)
    api.client.get("/api/graph/export", headers=token)
    assert _refused(_put(api, node, CODEX, _scene("a quiet street", "name stale")))
    assert all(not key[1].startswith(("name:", "newest:")) for key in scene_keys._reads if key[1].startswith(("chat:", "token:")))
    assert not any(key[1] in ("newest:Codex", "name:Codex:mcp-proc-1") for key in scene_keys._reads)


def test_c5_reads_stay_bounded(api):  # noqa: F811
    node = _cinema(api)
    api.client.get("/api/canvas/snapshot", headers=MCP)
    for i in range(2100):
        scene_keys.note_read("x", (f"name:Other:{i}", "newest:Other"), {"n9": "k"})
    assert len(scene_keys._reads) <= scene_keys.MAX_READS
    assert node


# -- L-3 (GM r18 answer 1): ’ in the lines this PR's backend added, the
# person's and the agents' alike. Agents match on `code`, never the detail.

def test_l3_input_taken_detail_is_curly(api):  # noqa: F811
    node = _cinema(api)
    target = api.graph.add_node("gpt-image-2-5-edit", {}, position={"x": 400, "y": 0})
    api.graph.connect(node, "shot_s1", target, "mask")
    body = {"source": node, "sourceHandle": "shot_s2", "target": target, "targetHandle": "mask", "onlyIfFree": True}
    taken = api.client.post("/api/graph/connect", headers=_tab(api, _canvas(api)), json=body)
    assert taken.status_code == 409 and taken.json()["code"] == "input_taken"
    assert taken.json()["detail"].startswith("Couldn’t connect to ")
    assert "'" not in taken.json()["detail"].replace(f"'{node}'", "")


def test_l3_the_prs_backend_lines_carry_no_straight_apostrophe():
    import main as main_module
    for line in (main_module.RUN_ID_STOPPED, main_module.RUN_ID_RAN, main_module.RUN_ID_STOP_RECORDED):
        assert "can’t" in line and "can't" not in line
    lines = [main_module._removal_person_line(action, numbers, stoppable)
             for action in (None, "undo", "redo") for numbers in ([2], [2, 3], [1, 2, 3, 4]) for stoppable in (True, False)]
    assert lines and all("'" not in line for line in lines), [line for line in lines if "'" in line]
    assert "Couldn’t remove “Shot 2”. It’s still running. Stop the run first." in lines
    assert "Couldn’t remove “Shot 2” and “Shot 3”. They’re still running. Stop the run first." in lines
