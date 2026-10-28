"""PR #198 fix round 10 (review 9): the agent rule across MCP and the CLI,
and ``onlyIfFree`` on inputs that take several connections.

- M-1: a read under a session (MCP sends one) is also the name's, so a
  write that sends no session (``nebula set``, a plain PUT) is held to the
  newest read by any session of that name; a CLI write on top of a fresh
  MCP read is taken; a session that never read falls back to the name's.
  A verified token stays its own reader.
- N-1: ``onlyIfFree`` refuses only an input that takes one connection.
"""
from __future__ import annotations

import pytest

from services import scene_keys
from tests.test_pr198_fix9 import CODEX, _cinema, _person_types, _prompts, _put, _scene
from tests.test_round19_fence import AGENT, _canvas, _tab, api  # noqa: F401 - fixture

MCP = {**CODEX, "X-Nebula-Agent-Session": "a1b2c3d4e5f60718"}


@pytest.fixture(autouse=True)
def _fresh_keys():
    scene_keys.forget()
    yield
    scene_keys.forget()


def test_m1_an_mcp_read_guards_a_cli_write(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/canvas/snapshot", headers=MCP).status_code == 200
    _person_types(api, node)
    stale = _put(api, node, CODEX, _scene("a quiet street", "codex stale via cli"))
    assert stale.status_code == 409 and stale.json()["code"] == "scene_changed"
    assert _prompts(api, node) == ["the person typed this", "a busy street"]


def test_m1_a_cli_write_on_a_fresh_mcp_read_is_taken(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/graph/export", headers=CODEX).status_code == 200
    assert _put(api, node, CODEX, _scene("a quiet street", "codex first")).status_code == 200
    _person_types(api, node)
    assert api.client.get("/api/canvas/snapshot", headers=MCP).status_code == 200
    on_top = _put(api, node, CODEX, _scene("the person typed this", "codex on top of the mcp read"))
    assert on_top.status_code == 200, on_top.text
    assert _prompts(api, node) == ["the person typed this", "codex on top of the mcp read"]


def test_m1_a_session_that_never_read_is_held_to_the_names_read(api):  # noqa: F811
    node = _cinema(api)
    assert api.client.get("/api/canvas/snapshot", headers=MCP).status_code == 200
    _person_types(api, node)
    blind = _put(api, node, {**CODEX, "X-Nebula-Agent-Session": "brand-new"}, _scene("a quiet street", "blind"))
    assert blind.status_code == 409


def test_m1_lanes_still_apart_and_name_only_as_before(api):  # noqa: F811
    node = _cinema(api)
    one = {**CODEX, "X-Nebula-Agent-Session": "lane-1"}
    two = {**CODEX, "X-Nebula-Agent-Session": "lane-2"}
    assert api.client.get("/api/canvas/snapshot", headers=one).status_code == 200
    _person_types(api, node)
    assert api.client.get("/api/graph/export", headers=two).status_code == 200
    # Lane 1's own read is older: refused, though the name's newest read is current.
    assert _put(api, node, one, _scene("a quiet street", "lane 1 stale")).status_code == 409
    assert _put(api, node, two, _scene("the person typed this", "lane 2 on top")).status_code == 200


def test_m1_a_verified_token_is_not_the_names_reader(api, monkeypatch):  # noqa: F811
    from commons.actors import agent_registry
    monkeypatch.setattr(agent_registry, "lookup", lambda token: {"runner": "codex", "session": "chat-a"} if token == "tok-a" else None)
    node = _cinema(api)
    chat = {"Authorization": "Agent tok-a"}
    assert api.client.get("/api/graph/export", headers=chat).status_code == 200
    _person_types(api, node)
    assert _put(api, node, chat, _scene("a quiet street", "chat stale")).status_code == 409
    # An outside agent of the same name never read: its write is its own (last writer).
    assert _put(api, node, CODEX, _scene("the person typed this", "outside codex")).status_code == 200


def test_n1_only_if_free_into_an_input_that_takes_several(api):  # noqa: F811
    node = _cinema(api)
    target = api.graph.add_node("gpt-image-2-5-edit", {}, position={"x": 400, "y": 0})
    api.graph.connect(node, "shot_s1", target, "images")
    body = {"source": node, "sourceHandle": "shot_s2", "target": target, "targetHandle": "images", "onlyIfFree": True}
    added = api.client.post("/api/graph/connect", headers=_tab(api, _canvas(api)), json=body)
    assert added.status_code == 200, added.text
    assert sorted(e["sourceHandle"] for e in api.main.cli_graph.edges if e["target"] == target) == ["shot_s1", "shot_s2"]


def test_docs_say_when_mcp_and_the_cli_share_a_read():
    from pathlib import Path
    repo = Path(__file__).resolve().parents[2]
    setup = " ".join((repo / "docs/MCP-SETUP.md").read_text(encoding="utf-8").split())
    skill = " ".join((repo / "skills/nebula/SKILL.md").read_text(encoding="utf-8").split())
    for line in ("newest read by any session of that name", "same `NEBULA_AGENT_SESSION`", "single-connection input"):
        assert line in setup, line
    assert "newest read by any session of that name" in skill
