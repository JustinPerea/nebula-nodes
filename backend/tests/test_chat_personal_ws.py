"""/ws/chat with a personal agent: the person gate, session reuse, permission
answers, close_session, disconnect and stale sessions, against the fake ACP agent."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

import main
from commons import actors
from services import acp_session, personal_agents
from services.acp_session import AcpSessionManager
from tests.conftest import PERSON, PERSON_TOKEN
from tests.test_commons_integration import isolated_app  # noqa: F401

pytestmark = pytest.mark.usefixtures("person")
FAKE = Path(__file__).parent / "fixtures" / "fake_acp_agent.py"
AGENT = "personal:fake"


class Socket:
    def __init__(self):
        self.scope = {"server": ("127.0.0.1", 54321)}
        self.headers = {}
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.events: list[dict] = []
        self.outgoing: asyncio.Queue = asyncio.Queue()

    async def accept(self):
        pass

    def put(self, payload):
        self.incoming.put_nowait(json.dumps(payload))

    def disconnect(self):
        self.incoming.put_nowait(None)

    async def receive_text(self):
        raw = await self.incoming.get()
        if raw is None:
            raise WebSocketDisconnect()
        return raw

    async def send_text(self, text):
        event = json.loads(text)
        self.events.append(event)
        self.outgoing.put_nowait(event)

    async def next(self, type_, timeout=5.0):
        while True:
            event = await asyncio.wait_for(self.outgoing.get(), timeout)
            if event["type"] == type_:
                return event

    async def until_done(self, timeout=5.0):
        seen = []
        while True:
            event = await asyncio.wait_for(self.outgoing.get(), timeout)
            seen.append(event)
            if event["type"] == "done":
                return seen


@pytest.fixture
def ws_env(isolated_app, monkeypatch):
    manager = AcpSessionManager()
    monkeypatch.setattr(main, "acp_sessions", manager)
    monkeypatch.setattr(acp_session, "CANCEL_GRACE_S", 3.0)
    state = main._STATE_DIR
    log = isolated_app / "agent.jsonl"

    def register(script, acknowledge=True):
        path = isolated_app / "script.json"
        path.write_text(json.dumps({"log": str(log), **script}))
        if acknowledge:
            personal_agents.acknowledge_warning(state)
        personal_agents.create_custom(state, {"id": "fake", "displayName": "Fake Agent", "command": sys.executable,
                                              "args": [str(FAKE), str(path)]})

    def methods():
        if not log.exists():
            return []
        return [json.loads(l).get("method") for l in log.read_text().splitlines() if l.strip()]

    yield type("E", (), {"register": staticmethod(register), "manager": manager, "methods": staticmethod(methods),
                         "log": log})


def send(socket, message="hi", session_id=None, token=PERSON_TOKEN, agent=AGENT):
    payload = {"type": "send", "message": message, "agent": agent, "sessionId": session_id}
    if token is not None:
        payload["personToken"] = token
    socket.put(payload)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.asyncio
async def test_person_is_required(ws_env):
    ws_env.register({})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket, token=None)
    events = await socket.until_done()
    assert events[0]["code"] == "person_required"
    socket.disconnect()
    await asyncio.wait_for(task, 5)
    assert ws_env.manager.live() == []


@pytest.mark.asyncio
async def test_warning_must_be_acknowledged(ws_env):
    ws_env.register({}, acknowledge=False)
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    events = await socket.until_done()
    assert events[0]["code"] == "personal_agent_warning_required"
    socket.disconnect()
    await asyncio.wait_for(task, 5)


@pytest.mark.asyncio
async def test_session_reused_then_closed_by_the_person(ws_env):
    ws_env.register({"turns": [[{"chunk": "one"}], [{"chunk": "two"}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    first = await socket.until_done()
    session = next(e for e in first if e["type"] == "session")
    assert session["agentName"] == "Fake Agent" and session["agentInfo"]["name"] == "fake-acp-agent"
    assert [e["text"] for e in first if e["type"] == "text"] == ["one"]
    assert all(e["source"] == "personal" for e in first)
    [host] = ws_env.manager.live()
    pid, token = host.proc.pid, host.token
    assert actors.agent_registry.lookup(token) is not None

    send(socket, "again", session_id=session["sessionId"])
    second = await socket.until_done()
    assert [e["text"] for e in second if e["type"] == "text"] == ["two"]
    assert not any(e["type"] == "session" for e in second)
    assert host.proc.pid == pid and alive(pid)

    socket.put({"type": "close_session", "sessionId": session["sessionId"]})  # no person token
    assert (await socket.next("error"))["code"] == "person_required"
    assert alive(pid)
    socket.put({"type": "close_session", "sessionId": session["sessionId"], "personToken": PERSON_TOKEN})
    closed = await socket.next("session_closed")
    assert closed["sessionId"] == session["sessionId"]
    assert not alive(pid) and actors.agent_registry.lookup(token) is None

    send(socket, "stale", session_id=session["sessionId"])
    stale = await socket.until_done()
    assert stale[0]["code"] == "personal_session_ended"
    socket.disconnect()
    await asyncio.wait_for(task, 5)


@pytest.mark.asyncio
async def test_disconnect_kills_the_agent_and_revokes_the_token(ws_env):
    ws_env.register({})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    await socket.until_done()
    [host] = ws_env.manager.live()
    pid, token = host.proc.pid, host.token
    socket.disconnect()
    await asyncio.wait_for(task, 10)
    assert not alive(pid)
    assert actors.agent_registry.lookup(token) is None
    assert ws_env.manager.live() == []


@pytest.mark.asyncio
async def test_permission_answers_only_count_from_the_owning_socket(ws_env):
    ws_env.register({"turns": [[{"permission": {"options": "all"}}]]})
    owner, other = Socket(), Socket()
    owner_task = asyncio.create_task(main.chat_websocket(owner))
    other_task = asyncio.create_task(main.chat_websocket(other))
    send(owner, "do it")
    request = await owner.next("permission_request")
    # Another chat socket, even the person's, can't answer this card.
    other.put({"type": "permission", "requestId": request["requestId"], "decision": "allow",
               "personToken": PERSON_TOKEN})
    # Without the person token, the owner's socket can't either.
    owner.put({"type": "permission", "requestId": request["requestId"], "decision": "allow"})
    assert (await owner.next("error"))["code"] == "person_required"
    await asyncio.sleep(0.3)
    [host] = ws_env.manager.live()
    assert request["requestId"] in host._pending_perm
    owner.put({"type": "permission", "requestId": request["requestId"], "decision": "deny",
               "personToken": PERSON_TOKEN})
    rest = await owner.until_done()
    assert {"type": "permission_resolved", "requestId": request["requestId"], "outcome": "denied",
            "source": "personal"} in rest
    assert any(e.get("text") == "permission:selected:r1" for e in rest)
    owner.disconnect()
    other.disconnect()
    await asyncio.wait_for(asyncio.gather(owner_task, other_task), 10)


@pytest.mark.asyncio
async def test_competing_turn_rejected_and_cancel_keeps_the_agent(ws_env):
    ws_env.register({"turns": [[{"chunk": "working"}, {"wait_cancel": True}], [{"chunk": "after"}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket, "long")
    session = await socket.next("session")
    await socket.next("text")
    send(socket, "competing", session_id=session["sessionId"])
    rejected = await socket.next("error")
    assert "Another response is active" in rejected["message"]
    socket.put({"type": "cancel"})
    assert (await socket.next("cancellation"))["status"] == "requested"
    assert (await socket.next("cancellation"))["status"] == "confirmed"
    assert "session/cancel" in ws_env.methods()
    [host] = ws_env.manager.live()
    assert alive(host.proc.pid)
    send(socket, "next", session_id=session["sessionId"])
    after = await socket.until_done()
    assert [e["text"] for e in after if e["type"] == "text"] == ["after"]
    socket.disconnect()
    await asyncio.wait_for(task, 10)


@pytest.mark.asyncio
async def test_crash_mid_turn_reports_and_clears(ws_env):
    ws_env.register({"turns": [[{"chunk": "partial"}, {"crash": 9}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    events = await socket.until_done()
    error = next(e for e in events if e["type"] == "error")
    assert error["code"] == "personal_session_ended" and "code 9" in error["message"]
    assert ws_env.manager.live() == []
    assert actors.agent_registry._tokens == {}
    socket.disconnect()
    await asyncio.wait_for(task, 5)


def test_a_minted_agent_token_cannot_reach_the_registry(isolated_app):
    token = actors.agent_registry.mint("personal:fake", [isolated_app])
    with TestClient(main.app) as client:
        response = client.get("/api/personal-agents", headers={**PERSON, "Authorization": f"Agent {token}"})
        assert response.status_code == 403
        response = client.post("/api/personal-agents/acknowledge-warning",
                               headers={"Authorization": f"Agent {token}"})
        assert response.status_code == 403
