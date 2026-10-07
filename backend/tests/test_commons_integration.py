"""Current-main seams use isolated state and fake native runners only."""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import main
from commons import actors, runtime
from services import chat_session
from services.agent_workspaces import WorkspaceSessions


@pytest.fixture
def isolated_app(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(tmp_path / "private-library"))
    monkeypatch.delenv("NEBULA_COMMONS_ENABLED", raising=False)
    monkeypatch.setattr(main, "_STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(main, "workspace_sessions", WorkspaceSessions())
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())
    monkeypatch.setattr(actors, "ui_session", actors.UISession())
    runtime.reset_for_tests()
    yield tmp_path
    runtime.reset_for_tests()


def receive_done(ws):
    events = []
    while not events or events[-1]["type"] != "done":
        events.append(ws.receive_json())
    return events


def test_default_off_capability_startup_and_routes_do_not_initialize_library(isolated_app, monkeypatch):
    from commons import ui_auth
    initialize = Mock(side_effect=AssertionError("must not initialize human authority"))
    monkeypatch.setattr(ui_auth, "initialize_ui_session", initialize)
    store = Mock(side_effect=AssertionError("must not open library"))
    monkeypatch.setattr(runtime, "get_store", store)
    with TestClient(main.app) as client:
        assert client.get("/api/capabilities/commons").json() == {"enabled": False, "scopedAgents": ["claude", "codex"]}
        assert client.get("/api/commons/status").status_code == 404
        assert client.post("/api/commons/search", json={}).status_code == 404
        assert client.get("/api/agent/context").status_code == 401
    initialize.assert_not_called()
    store.assert_not_called()
    assert not (isolated_app / "private-library").exists()
    assert not actors.ui_session.is_set


def test_enabled_websocket_requires_human_authority_before_runner_or_workspace(isolated_app, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    called = []
    async def runner(*args, **kwargs):
        called.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Use private references", "agent": "claude", "brand": "other"})
        events = receive_done(ws)
    assert events[0]["type"] == "error" and "UI session" in events[0]["message"]
    assert not called
    assert not (isolated_app / "state").exists()
    assert not (isolated_app / "private-library").exists()


def test_enabled_turn_binds_resume_and_revokes_child_capability(isolated_app, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    human_token = "h" * 43
    actors.ui_session.set(human_token)
    calls = []
    async def runner(message, session_id, model, autonomy, **kwargs):
        calls.append((session_id, autonomy, kwargs))
        record = actors.agent_registry.lookup(kwargs["agent_token"])
        assert record["workspace"] == kwargs["workdir"] and record["brand"] == "acme"
        assert kwargs["agent_token"] != human_token
        yield {"type": "session", "sessionId": "synthetic-provider-session", "model": "fixture-model"}
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        payload = {"type": "send", "message": "Hello", "agent": "claude", "brand": "acme", "commonsToken": human_token}
        ws.send_json(payload)
        events = receive_done(ws)
        opaque = next(e["sessionId"] for e in events if e["type"] == "session")
        assert opaque != "synthetic-provider-session"
        ws.send_json({**payload, "sessionId": opaque})
        events2 = receive_done(ws)
        assert not [e for e in events2 if e["type"] == "error"]
    assert calls[0][0] is None and calls[1][0] == "synthetic-provider-session"
    assert calls[0][2]["workdir"] == calls[1][2]["workdir"]
    for _, _, options in calls:
        assert actors.agent_registry.lookup(options["agent_token"]) is None
    assert not main.workspace_sessions._sessions[opaque].active
    assert not (isolated_app / "private-library").exists()


def test_default_off_daedalus_preserves_current_dispatch_contract(isolated_app, monkeypatch):
    seen = []
    async def runner(message, session_id, model, autonomy, **kwargs):
        seen.append((session_id, autonomy, kwargs))
        yield {"type": "session", "sessionId": "existing-daedalus-id"}
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "daedalus", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Hello", "agent": "daedalus", "sessionId": "old-id", "autonomy": "step", "provider": "nous"})
        events = receive_done(ws)
    assert len(seen) == 1 and seen[0][:2] == ("old-id", "step")
    assert seen[0][2]["provider"] == "nous"
    assert "CURRENT CANVAS SELECTION" in seen[0][2]["selection_context"]
    assert set(seen[0][2]) == {"provider", "selection_context"}
    assert next(e for e in events if e["type"] == "session")["sessionId"] == "existing-daedalus-id"
    assert not (isolated_app / "state").exists()


def test_expired_agent_context_fails_without_file_access(isolated_app):
    with TestClient(main.app) as client:
        assert client.get("/api/agent/context", headers={"Authorization": "Agent expired"}).status_code == 401


def test_enabled_daedalus_rejects_before_even_a_registered_runner(isolated_app, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    human_token = "h" * 43
    actors.ui_session.set(human_token)
    called = []
    async def runner(*args, **kwargs):
        called.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "daedalus", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Hello", "agent": "daedalus", "commonsToken": human_token})
        events = receive_done(ws)
    assert "Claude and Codex" in events[0]["message"]
    assert not called
    assert not (isolated_app / "state").exists()
