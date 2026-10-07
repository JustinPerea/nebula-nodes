"""Transport scheduling and malformed messages never outlive turn authority."""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import WebSocketDisconnect

import main
from commons import actors
from services import chat_actions, chat_session
from tests.test_commons_integration import isolated_app  # noqa: F401


class QueueSocket:
    """Expose a sent event before its awaitable returns, like a real transport."""
    def __init__(self, initial, on_send=None, on_receive=None):
        self.scope = {"server": ("127.0.0.1", 54321)}
        self.initial = initial
        self.on_send = on_send
        self.on_receive = on_receive
        self.incoming = asyncio.Queue()
        self.events = []

    async def accept(self):
        self.put(self.initial)

    def put(self, payload):
        self.incoming.put_nowait(json.dumps(payload))

    def disconnect(self):
        self.incoming.put_nowait(None)

    async def receive_text(self):
        raw = await self.incoming.get()
        if isinstance(raw, Exception):
            raise raw
        if raw is None:
            raise WebSocketDisconnect()
        if self.on_receive:
            await self.on_receive(json.loads(raw))
        return raw

    async def send_text(self, text):
        event = json.loads(text)
        self.events.append(event)
        if self.on_send:
            await self.on_send(self, event)


@pytest.mark.parametrize("agent", ["claude", "daedalus"])
@pytest.mark.asyncio
async def test_next_send_after_visible_done_waits_for_old_transport_and_resumes(isolated_app, monkeypatch, agent):
    calls = []
    async def runner(message, session_id, model, autonomy, **kwargs):
        call = {"session": session_id, **kwargs, "closed": False}
        calls.append(call)
        try:
            yield {"type": "session", "sessionId": "synthetic-provider-session"}
            yield {"type": "done"}
        finally:
            call["closed"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, agent, runner)
    second_received = asyncio.Event()
    session_ids = []
    done_count = 0
    async def receive(payload):
        if payload.get("message") == "second":
            # The client has already received done, but the first transport
            # send is still returning. Its drain task cannot yet be complete.
            second_received.set()
    async def send(socket, event):
        nonlocal done_count
        if event["type"] == "session":
            session_ids.append(event["sessionId"])
        if event["type"] == "done":
            done_count += 1
            assert calls[-1]["closed"]
            assert chat_actions._active_handler is None
            if agent == "claude":
                assert actors.agent_registry.lookup(calls[-1]["agent_token"]) is None
                assert not main.workspace_sessions._sessions[session_ids[-1]].active
            if done_count == 1:
                socket.put({"type": "send", "message": "second", "agent": agent,
                            "sessionId": session_ids[-1]})
                await second_received.wait()
            else:
                socket.disconnect()
    socket = QueueSocket({"type": "send", "message": "first", "agent": agent}, send, receive)
    await asyncio.wait_for(main.chat_websocket(socket), timeout=3)
    assert len(calls) == 2
    assert calls[1]["session"] == "synthetic-provider-session"
    assert done_count == 2
    assert not [event for event in socket.events if event["type"] == "error"]
    if agent == "claude":
        assert calls[0]["workdir"] == calls[1]["workdir"]
        assert all(actors.agent_registry.lookup(call["agent_token"]) is None for call in calls)


@pytest.mark.parametrize("malformed", [[], None, 1, "string"])
@pytest.mark.asyncio
async def test_nonobject_envelope_is_rejected_and_disconnect_cleans_active_turn(isolated_app, monkeypatch, malformed):
    seen = {}
    async def runner(message, session_id, model, autonomy, **kwargs):
        seen.update(kwargs)
        try:
            yield {"type": "session", "sessionId": "synthetic-blocked-session"}
            await asyncio.Event().wait()
        finally:
            seen["cleaned"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    async def send(socket, event):
        if event["type"] == "session":
            seen["opaque"] = event["sessionId"]
            socket.put(malformed)
        if event["type"] == "error":
            assert "must be an object" in event["message"]
            assert actors.agent_registry.lookup(seen["agent_token"]) is not None
            assert not seen.get("cleaned")
            socket.disconnect()
    socket = QueueSocket({"type": "send", "message": "first", "agent": "claude"}, send)
    await asyncio.wait_for(main.chat_websocket(socket), timeout=3)
    assert seen["cleaned"]
    assert actors.agent_registry.lookup(seen["agent_token"]) is None
    assert not main.workspace_sessions._sessions[seen["opaque"]].active
    assert chat_actions._active_handler is None
    assert not [event for event in socket.events if event["type"] == "done"]


@pytest.mark.asyncio
async def test_unexpected_transport_exit_still_closes_runner_and_revokes_authority(isolated_app, monkeypatch):
    seen = {}
    async def runner(message, session_id, model, autonomy, **kwargs):
        seen.update(kwargs)
        try:
            yield {"type": "session", "sessionId": "synthetic-transport-session"}
            await asyncio.Event().wait()
        finally:
            seen["cleaned"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    async def send(socket, event):
        if event["type"] == "session":
            seen["opaque"] = event["sessionId"]
            socket.incoming.put_nowait(RuntimeError("synthetic transport failure"))
    socket = QueueSocket({"type": "send", "message": "first", "agent": "claude"}, send)
    with pytest.raises(RuntimeError, match="synthetic transport failure"):
        await asyncio.wait_for(main.chat_websocket(socket), timeout=3)
    assert seen["cleaned"]
    assert actors.agent_registry.lookup(seen["agent_token"]) is None
    assert not main.workspace_sessions._sessions[seen["opaque"]].active
    assert chat_actions._active_handler is None


@pytest.mark.parametrize("second", [{"commonsToken": "invalid"}, {"agent": "daedalus"}, {"agent": []}])
@pytest.mark.asyncio
async def test_active_guard_precedes_second_turn_validation_without_terminal_done(isolated_app, monkeypatch, second):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    human = "h" * 43
    actors.ui_session.set(human)
    calls = []
    async def runner(message, session_id, model, autonomy, **kwargs):
        calls.append(kwargs)
        try:
            yield {"type": "session", "sessionId": "synthetic-active-session"}
            await asyncio.Event().wait()
        finally:
            calls[-1]["cleaned"] = True
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    payload = {"type": "send", "message": "first", "agent": "claude", "commonsToken": human}
    async def send(socket, event):
        if event["type"] == "session":
            socket.put({**payload, "message": "competing", **second})
        if event["type"] == "error":
            assert "Another response is active" in event["message"]
            assert actors.agent_registry.lookup(calls[0]["agent_token"]) is not None
            socket.disconnect()
    socket = QueueSocket(payload, send)
    await asyncio.wait_for(main.chat_websocket(socket), timeout=3)
    assert len(calls) == 1 and calls[0]["cleaned"]
    assert actors.agent_registry.lookup(calls[0]["agent_token"]) is None
    assert not [event for event in socket.events if event["type"] == "done"]


@pytest.mark.parametrize("agent", [["claude"], {"name": "claude"}, 1])
@pytest.mark.asyncio
async def test_invalid_agent_type_never_starts_native_runner(isolated_app, monkeypatch, agent):
    called = []
    async def runner(*args, **kwargs):
        called.append(kwargs)
        yield {"type": "done"}
    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    async def send(socket, event):
        if event["type"] == "done":
            socket.disconnect()
    socket = QueueSocket({"type": "send", "message": "hello", "agent": agent}, send)
    await asyncio.wait_for(main.chat_websocket(socket), timeout=3)
    assert called == []
    assert any(event["type"] == "error" and "agent must be text" in event["message"] for event in socket.events)
    assert not (isolated_app / "state").exists()
