"""Picker choices are validated before granting a chat workspace capability."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient

import main
from commons import actors
from services import chat_models, chat_session
from tests.test_chat_models import catalog, model
from tests.test_chat_isolation_lifecycle import QueueSocket
from tests.test_commons_integration import isolated_app, receive_done  # noqa: F401


@pytest.mark.parametrize("agent", ["claude", "codex"])
def test_model_endpoint_reads_catalog_without_runner_or_workspace(isolated_app, monkeypatch, agent):
    async def fixture_catalog(selected_agent, **kwargs):
        if selected_agent not in {"claude", "codex"}:
            raise chat_models.ChatModelSelectionError("agent_invalid", "Unsupported agent")
        return {**catalog(), "agent": selected_agent}
    get = AsyncMock(side_effect=fixture_catalog)
    monkeypatch.setattr(chat_models, "get_chat_models", get)
    acquire = Mock(side_effect=AssertionError("catalog must not acquire workspace"))
    monkeypatch.setattr(main.workspace_sessions, "acquire", acquire)
    with TestClient(main.app) as client:
        response = client.get(f"/api/agents/{agent}/models?refresh=true")
        assert response.status_code == 200 and response.json()["agent"] == agent
        assert client.get("/api/agents/daedalus/models").status_code == 400
    assert get.await_args_list[0].args == (agent,)
    assert get.await_args_list[0].kwargs == {"refresh": True}
    acquire.assert_not_called()


@pytest.mark.parametrize("choice,code", [({"model": "unlisted"}, "model_unsupported"),
                                        ({"model": "runtime-model", "effort": "medium"}, "effort_unsupported"),
                                        ({"model": False}, "model_invalid"),
                                        ({"model": []}, "model_invalid"),
                                        ({"model": "runtime-model", "effort": {}}, "effort_invalid"),
                                        ({"provider": "openrouter"}, "provider_invalid")])
def test_invalid_choice_never_starts_runner_or_authority(isolated_app, monkeypatch, choice, code):
    monkeypatch.setattr(chat_models, "get_chat_models", AsyncMock(return_value=catalog()))
    acquire = Mock(side_effect=AssertionError("invalid selection must not acquire workspace"))
    mint = Mock(side_effect=AssertionError("invalid selection must not mint authority"))
    monkeypatch.setattr(main.workspace_sessions, "acquire", acquire)
    monkeypatch.setattr(actors.agent_registry, "mint", mint)
    calls = []
    async def runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "codex", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "hello", "agent": "codex", **choice})
        events = receive_done(ws)
    assert events[0]["code"] == code and events[0]["type"] == "error"
    assert calls == []
    acquire.assert_not_called()
    mint.assert_not_called()


@pytest.mark.parametrize("agent", [False, 0, [], {}, "", " "])
def test_false_like_agents_are_not_silently_defaulted(isolated_app, monkeypatch, agent):
    acquire = Mock(side_effect=AssertionError("invalid agent must not acquire workspace"))
    monkeypatch.setattr(main.workspace_sessions, "acquire", acquire)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "hello", "agent": agent})
        events = receive_done(ws)
    assert events[0]["code"] == "agent_invalid"
    acquire.assert_not_called()


@pytest.mark.parametrize("effort,expected", [("ultra", "ultra"), (None, "low")])
def test_validated_choices_apply_next_turn_and_keep_resume_history(isolated_app, monkeypatch, effort, expected):
    monkeypatch.setattr(chat_models, "get_chat_models", AsyncMock(return_value=catalog()))
    calls = []
    async def runner(message, session_id, selected_model, autonomy, **kwargs):
        calls.append({"session": session_id, "model": selected_model, **kwargs})
        yield {"type": "session", "sessionId": "mock-provider-conversation"}
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "codex", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        payload = {"type": "send", "message": "hello", "agent": "codex", "model": "runtime-model", "effort": effort}
        ws.send_json(payload)
        first = receive_done(ws)
        session_id = next(event["sessionId"] for event in first if event["type"] == "session")
        ws.send_json({**payload, "sessionId": session_id, "effort": "max"})
        second = receive_done(ws)
        assert not [event for event in first + second if event["type"] == "error"]
    assert calls[0]["model"] == "runtime-model" and calls[0]["effort"] == expected
    assert calls[1]["effort"] == "max" and calls[1]["session"] == "mock-provider-conversation"
    assert calls[0]["catalog_validated"] and calls[1]["catalog_validated"]
    assert calls[0]["workdir"] == calls[1]["workdir"]
    assert all(actors.agent_registry.lookup(call["agent_token"]) is None for call in calls)


def test_unknown_effort_default_omits_override_and_missing_model_default_requires_choice(isolated_app, monkeypatch):
    get = AsyncMock(return_value=catalog([model(default=False, default_effort=None)]))
    monkeypatch.setattr(chat_models, "get_chat_models", get)
    calls = []
    async def runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    with TestClient(main.app).websocket_connect("/ws/chat") as ws:
        ws.send_json({"type": "send", "message": "hello", "agent": "claude", "effort": "low"})
        assert receive_done(ws)[0]["code"] == "model_required"
        ws.send_json({"type": "send", "message": "hello", "agent": "claude", "model": "runtime-model", "effort": None})
        assert not [event for event in receive_done(ws) if event["type"] == "error"]
    assert len(calls) == 1 and calls[0]["effort"] is None and calls[0]["catalog_validated"]


@pytest.mark.parametrize("agent", ["claude", "codex"])
@pytest.mark.parametrize("exit_mode", ["stop", "disconnect"])
@pytest.mark.asyncio
async def test_cancel_during_catalog_discovery_waits_for_cleanup_without_turn_authority(
    isolated_app, monkeypatch, agent, exit_mode,
):
    started, cleaning, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
    cleaned = False

    async def blocked_catalog(*args, **kwargs):
        nonlocal cleaned
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            cleaning.set()
            await allow_cleanup.wait()
            cleaned = True

    monkeypatch.setattr(chat_models, "get_chat_models", AsyncMock(side_effect=blocked_catalog))
    acquire, mint = Mock(), Mock()
    monkeypatch.setattr(main.workspace_sessions, "acquire", acquire)
    monkeypatch.setattr(actors.agent_registry, "mint", mint)
    calls = []

    async def runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "done"}

    monkeypatch.setitem(chat_session.AGENT_RUNNERS, agent, runner)

    async def send(socket, event):
        if event["type"] == "cancellation" and event["status"] == "confirmed":
            assert cleaned
            socket.disconnect()

    socket = QueueSocket({"type": "send", "message": "hello", "agent": agent,
                          "model": "runtime-model"}, send)
    task = asyncio.create_task(main.chat_websocket(socket))
    try:
        await asyncio.wait_for(started.wait(), 1)
        if exit_mode == "stop":
            socket.put({"type": "cancel"})
        else:
            socket.disconnect()
        await asyncio.wait_for(cleaning.wait(), 1)
        assert not cleaned
        assert not [event for event in socket.events
                    if event["type"] == "done" or event.get("status") == "confirmed"]
        acquire.assert_not_called()
        mint.assert_not_called()
        assert not calls
        allow_cleanup.set()
        await asyncio.wait_for(task, 1)
    finally:
        allow_cleanup.set()
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    assert cleaned and not calls
    acquire.assert_not_called()
    mint.assert_not_called()
    assert not [event for event in socket.events if event["type"] == "done"]
    if exit_mode == "stop":
        assert [event["status"] for event in socket.events if event["type"] == "cancellation"] == ["requested", "confirmed"]


@pytest.mark.parametrize("agent", ["claude", "codex"])
@pytest.mark.asyncio
async def test_failed_catalog_cleanup_reports_failed_cancellation_without_confirmation(
    isolated_app, monkeypatch, agent,
):
    started = asyncio.Event()

    async def failing_capture(*args, **kwargs):
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            raise RuntimeError("private cleanup diagnostic")

    monkeypatch.setattr(chat_models, "_capture", failing_capture)
    acquire, mint = Mock(), Mock()
    monkeypatch.setattr(main.workspace_sessions, "acquire", acquire)
    monkeypatch.setattr(actors.agent_registry, "mint", mint)
    calls = []

    async def runner(*args, **kwargs):
        calls.append(kwargs)
        yield {"type": "done"}

    monkeypatch.setitem(chat_session.AGENT_RUNNERS, agent, runner)

    async def send(socket, event):
        if event["type"] == "cancellation" and event["status"] == "failed":
            socket.disconnect()

    socket = QueueSocket({"type": "send", "message": "hello", "agent": agent,
                          "model": "runtime-model"}, send)
    task = asyncio.create_task(main.chat_websocket(socket))
    try:
        await asyncio.wait_for(started.wait(), 1)
        socket.put({"type": "cancel"})
        await asyncio.wait_for(task, 1)
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    acquire.assert_not_called()
    mint.assert_not_called()
    assert not calls
    assert [event["status"] for event in socket.events if event["type"] == "cancellation"] == ["requested", "failed"]
    assert not [event for event in socket.events if event["type"] == "done"]
    assert "private cleanup diagnostic" not in str(socket.events)
