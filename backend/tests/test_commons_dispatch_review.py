"""Backend authority and cancellation checks for Commons-enabled chat turns."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import main
from commons import actors
from services import chat_session
from tests.test_commons_integration import isolated_app, receive_done  # noqa: F401


def enable_human(monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    token = "h" * 43
    actors.ui_session.set(token)
    return token


def test_enabled_daedalus_is_rejected_before_unscoped_runner(isolated_app, monkeypatch):
    human = enable_human(monkeypatch)
    calls = []
    async def unscoped_runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "daedalus", unscoped_runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Read private references", "agent": "daedalus", "commonsToken": human})
        events = receive_done(ws)
    assert calls == []
    assert any(e["type"] == "error" and ("supported" in e["message"] or "Claude" in e["message"] or "scoped" in e["message"]) for e in events)
    assert not (isolated_app / "state").exists()
    assert not (isolated_app / "private-library").exists()


def test_cancellation_revokes_token_and_releases_workspace_before_confirmation(isolated_app, monkeypatch):
    human = enable_human(monkeypatch)
    seen = {}
    async def runner(message, session_id, model, autonomy, **kwargs):
        seen.update(kwargs)
        try:
            yield {"type": "session", "sessionId": "synthetic-blocked-session"}
            await asyncio.Event().wait()
        finally:
            seen["cleaned"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Hello", "agent": "claude", "commonsToken": human, "brand": "acme"})
        started = ws.receive_json()
        assert started["type"] == "session"
        assert actors.agent_registry.lookup(seen["agent_token"]) is not None
        ws.send_json({"type": "cancel"})
        requested = ws.receive_json()
        confirmed = ws.receive_json()
        assert requested["status"] == "requested" and confirmed["status"] == "confirmed"
        assert seen["cleaned"] is True
        assert actors.agent_registry.lookup(seen["agent_token"]) is None
        assert not main.workspace_sessions._sessions[started["sessionId"]].active
    assert not (isolated_app / "private-library").exists()


@pytest.mark.parametrize("changed", [{"brand": "other"}, {"agent": "codex"}])
def test_websocket_resume_cannot_change_bound_brand_or_runner(isolated_app, monkeypatch, changed):
    human = enable_human(monkeypatch)
    calls = []
    async def runner(message, session_id, model, autonomy, **kwargs):
        calls.append(kwargs)
        yield {"type": "session", "sessionId": "synthetic-stable-session"}
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "codex", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        payload = {"type": "send", "message": "Hello", "agent": "claude", "brand": "acme", "commonsToken": human}
        ws.send_json(payload)
        initial = receive_done(ws)
        opaque = next(e["sessionId"] for e in initial if e["type"] == "session")
        ws.send_json({**payload, "sessionId": opaque, **changed})
        rejected = receive_done(ws)
        assert any(e["type"] == "error" and "different agent or brand" in e["message"] for e in rejected)
    assert len(calls) == 1
    assert actors.agent_registry.lookup(calls[0]["agent_token"]) is None
    assert not main.workspace_sessions._sessions[opaque].active


@pytest.mark.parametrize("second", [
    {"agent": "claude"},
    {"agent": "daedalus", "commonsToken": "h" * 43},
])
def test_invalid_second_send_cannot_finish_an_active_turn(isolated_app, monkeypatch, second):
    human = enable_human(monkeypatch)
    calls = []
    async def runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "session", "sessionId": "synthetic-active-session"}
        await asyncio.Event().wait()
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Hello", "agent": "claude", "commonsToken": human})
        assert ws.receive_json()["type"] == "session"
        ws.send_json({"type": "send", "message": "Competing turn", **second})
        rejected = ws.receive_json()
        assert rejected["type"] == "error" and "Another response is active" in rejected["message"]
        ws.send_json({"type": "cancel"})
        assert ws.receive_json()["status"] == "requested"
        assert ws.receive_json()["status"] == "confirmed"
    assert len(calls) == 1
    assert actors.agent_registry.lookup(calls[0]["agent_token"]) is None


def test_done_waits_for_generator_cleanup_and_capability_revocation(isolated_app, monkeypatch):
    human = enable_human(monkeypatch)
    seen = {}
    async def runner(*args, **kwargs):
        seen.update(kwargs)
        try:
            yield {"type": "session", "sessionId": "synthetic-cleanup-session"}
            yield {"type": "done"}
        finally:
            await asyncio.sleep(0.02)
            seen["cleaned"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "Hello", "agent": "claude", "commonsToken": human})
        events = receive_done(ws)
        opaque = next(e["sessionId"] for e in events if e["type"] == "session")
        assert seen["cleaned"] is True
        assert actors.agent_registry.lookup(seen["agent_token"]) is None
        assert not main.workspace_sessions._sessions[opaque].active
