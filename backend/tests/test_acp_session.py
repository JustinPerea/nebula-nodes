"""AcpHostSession and AcpSessionManager against a real fake ACP agent subprocess."""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time
from pathlib import Path

import pytest

from commons import actors
from services import acp_session, agent_spend, personal_agents
from services.acp_session import AcpSessionManager, PersonalSessionError
from services.agent_workspaces import WorkspaceSessions

FAKE = Path(__file__).parent / "fixtures" / "fake_acp_agent.py"
OWNER = "conn-owner"


class Env:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp = tmp_path
        self.state = tmp_path / "state"
        self.out = tmp_path / "out"
        self.out.mkdir()
        self.log = tmp_path / "agent-log.jsonl"
        self.workspaces = WorkspaceSessions()
        self.manager = AcpSessionManager()

    def register(self, script: dict, *, acknowledge: bool = True, agent_id: str = "fake") -> None:
        script = {"log": str(self.log), **script}
        script_file = self.tmp / f"script-{agent_id}.json"
        script_file.write_text(json.dumps(script))
        if acknowledge:
            personal_agents.acknowledge_warning(self.state)
        personal_agents.create_custom(self.state, {
            "id": agent_id, "displayName": "Fake Agent", "color": "#123456",
            "command": sys.executable, "args": [str(FAKE), str(script_file)]})

    async def open(self, owner: str = OWNER, agent_id: str = "fake"):
        return await self.manager.open(owner, agent_id, state_dir=self.state, output_root=self.out,
                                       backend_url="http://127.0.0.1:8142", workspace_sessions=self.workspaces)

    def messages(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]

    def methods(self) -> list[str]:
        return [m.get("method") for m in self.messages() if m.get("method")]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(actors, "agent_registry", actors.AgentRegistry())
    monkeypatch.setattr(acp_session, "PERMISSION_TIMEOUT_S", 5.0)
    monkeypatch.setattr(acp_session, "CANCEL_GRACE_S", 3.0)
    e = Env(tmp_path)
    yield e
    asyncio.get_event_loop_policy()  # keep the loop policy import used


async def collect(host, message="hi", on_event=None):
    events = []
    async for event in host.prompt(message):
        events.append(event)
        if on_event is not None:
            await on_event(event)
    return events


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.05)
    return predicate()


@pytest.mark.asyncio
async def test_initialize_session_new_and_token_lifecycle(env):
    env.register({"turns": [[{"echo_env": "NEBULA_AGENT_TOKEN"}, {"echo_env": "NEBULA_URL"}]]})
    host = await env.open()
    try:
        init = next(m for m in env.messages() if m.get("method") == "initialize")["params"]
        assert init["protocolVersion"] == 1
        assert init["clientCapabilities"] == {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}
        assert init["clientInfo"]["name"] == "nebula-nodes"
        new = next(m for m in env.messages() if m.get("method") == "session/new")["params"]
        assert new["cwd"] == str(host.workdir)
        assert Path(new["cwd"]).is_dir() and "agent-workspaces" in new["cwd"]
        [server] = new["mcpServers"]
        assert server["name"] == "nebula"
        assert server["command"] == sys.executable and Path(server["command"]).is_absolute()
        assert server["args"][0].endswith("backend/mcp_server.py") and Path(server["args"][0]).is_absolute()
        assert server["args"][1:] == ["--url", "http://127.0.0.1:8142"]
        env_vars = {item["name"]: item["value"] for item in server["env"]}
        assert set(env_vars) == {"NEBULA_AGENT_TOKEN_FILE", "NEBULA_URL", "NEBULA_AGENT_NAME"}
        assert env_vars["NEBULA_AGENT_NAME"] == "Fake Agent"
        # The token's value is nowhere in session/new: adapters may put this
        # entry's environment in argv (claude --mcp-config <json>).
        raw_new = next(line for line in env.log.read_text().splitlines() if '"session/new"' in line)
        assert host.token not in raw_new
        # Only a path to a private file outside the agent's workspace.
        token_file = Path(env_vars["NEBULA_AGENT_TOKEN_FILE"])
        assert token_file == host.token_file and token_file.read_text() == host.token
        assert token_file.is_relative_to(env.state / "agent-tokens" / str(os.getpid()))
        assert not token_file.is_relative_to(host.workdir)
        assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
        assert stat.S_IMODE(token_file.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(token_file.parent.parent.stat().st_mode) == 0o700
        record = actors.agent_registry.lookup(host.token)
        assert record is not None
        assert record["spend_key"] == "outside:personal:fake"
        assert record["display_name"] == "Fake Agent" and record["color"] == "#123456"
        assert record["model"] == "fake-acp-agent@1.0.0"
        assert record["workspace"] == host.workdir.resolve()
        events = await collect(host)
        texts = [e["text"] for e in events if e["type"] == "text"]
        assert texts == ["unset", "http://127.0.0.1:8142"]
        assert events[-1] == {"type": "result", "text": "", "stopReason": "end_turn"}
        # The process stays up for the next turn.
        assert host.proc.returncode is None and host.state == "ready"
        pid = host.proc.pid
        assert len(await collect(host)) == 3
        assert host.proc.pid == pid
        token = host.token
    finally:
        await env.manager.close_all()
    assert actors.agent_registry.lookup(token) is None
    assert not token_file.exists()
    assert "session/close" in env.methods()
    assert not alive(pid)
    assert not env.workspaces._sessions[host.id].active


@pytest.mark.asyncio
async def test_spend_key_is_counted_in_the_shared_outside_budget(env, tmp_path, monkeypatch):
    ledger = agent_spend.SpendLedger(tmp_path / "spend.json")
    key = agent_spend.personal_agent_spend_key("claude", "chat-1")
    assert key == "outside:personal:claude" and agent_spend.is_outside(key)
    ledger.record(key, "Claude (your setup)", {"fal-flux": 0.25})
    ledger.record(agent_spend.OUTSIDE_SHARED, "outside", {"fal-flux": 0.5})
    assert ledger.spent_outside().total == pytest.approx(0.75)
    budgets = agent_spend.session_budgets(key, ledger.spent(key), {"outsideDailyUsd": 1.0},
                                          outside_spent=ledger.spent_outside())
    assert [b.who for b in budgets] == ["agents outside Nebula chats"]
    monkeypatch.setattr(agent_spend, "PERSONAL_AGENT_BUDGET", "chat")
    assert agent_spend.personal_agent_spend_key("claude", "chat-1") == "chat:chat-1"


@pytest.mark.asyncio
async def test_streaming_updates_map_to_chat_events(env):
    env.register({"turns": [[
        {"thought": "thinking about it"},
        {"plan": [{"content": "look", "priority": "high", "status": "in_progress"}]},
        {"tool_call": {"toolCallId": "t1", "name": "find_nodes", "title": "Find nodes", "kind": "search",
                       "status": "pending", "rawInput": {"query": "text"}}},
        {"tool_update": {"toolCallId": "t1", "status": "completed",
                         "content": [{"type": "content", "content": {"type": "text", "text": "text-input"}}]}},
        {"chunk": "Hello "}, {"chunk": "there"},
    ]]})
    host = await env.open()
    try:
        events = await collect(host)
    finally:
        await env.manager.close_all()
    assert [e["type"] for e in events] == ["thought", "plan", "tool_use", "tool_result", "text", "text", "result"]
    assert events[2]["tool"] == "find_nodes" and events[2]["input"] == {"query": "text"}
    assert events[3] == {"type": "tool_result", "toolUseId": "t1", "content": "text-input", "isError": False}
    assert events[1]["entries"] == [{"content": "look", "priority": "high", "status": "in_progress"}]
    prompt = next(m for m in env.messages() if m.get("method") == "session/prompt")["params"]["prompt"]
    assert all(block["type"] == "text" for block in prompt)
    assert "Nebula" in prompt[0]["text"] and prompt[-1]["text"] == "hi"


async def _permission_turn(env, options, decision, *, extra_steps=()):
    env.register({"turns": [[{"permission": {"options": options,
                                             "toolCall": {"toolCallId": "c1", "title": "Run rm", "kind": "execute",
                                                          "rawInput": {"command": "ls"}}}}, *extra_steps]]})
    host = await env.open()
    seen = []

    async def answer(event):
        if event["type"] == "permission_request":
            seen.append(event)
            if decision is not None:
                assert host.resolve_permission(event["requestId"], decision, "someone-else") is False
                assert host.resolve_permission(event["requestId"], decision, OWNER) is True

    try:
        events = await collect(host, on_event=answer)
        replies = [m["permissionReply"] for m in env.messages() if "permissionReply" in m]
        return host, events, seen, replies
    finally:
        await env.manager.close_all()


@pytest.mark.asyncio
async def test_permission_allow_once_is_the_only_allow(env):
    host, events, seen, replies = await _permission_turn(env, "all", "allow")
    assert seen[0]["canAllow"] is True and seen[0]["title"] == "Run rm" and seen[0]["input"] == {"command": "ls"}
    assert replies[0]["result"] == {"outcome": {"outcome": "selected", "optionId": "a1"}}
    assert {"type": "permission_resolved", "requestId": seen[0]["requestId"], "outcome": "allowed"} in events
    assert any(e.get("text") == "permission:selected:a1" for e in events)


@pytest.mark.asyncio
async def test_permission_deny_selects_reject_once(env):
    _, events, seen, replies = await _permission_turn(env, "all", "deny")
    assert replies[0]["result"] == {"outcome": {"outcome": "selected", "optionId": "r1"}}
    assert {"type": "permission_resolved", "requestId": seen[0]["requestId"], "outcome": "denied"} in events


@pytest.mark.asyncio
async def test_permission_timeout_denies(env, monkeypatch):
    monkeypatch.setattr(acp_session, "PERMISSION_TIMEOUT_S", 0.3)
    _, events, seen, replies = await _permission_turn(env, "all", None)
    assert replies[0]["result"] == {"outcome": {"outcome": "selected", "optionId": "r1"}}
    assert {"type": "permission_resolved", "requestId": seen[0]["requestId"], "outcome": "timed_out"} in events


@pytest.mark.asyncio
async def test_permission_without_reject_option_cancels(env):
    _, events, seen, replies = await _permission_turn(env, "no_reject", "deny")
    assert replies[0]["result"] == {"outcome": {"outcome": "cancelled"}}
    assert "session/cancel" in env.methods()


@pytest.mark.asyncio
async def test_only_always_allow_cannot_be_allowed(env):
    _, events, seen, replies = await _permission_turn(env, "always_only", "allow")
    assert seen[0]["canAllow"] is False
    # "allow" with no allow_once option is a deny; allow_always is never picked.
    assert replies[0]["result"] == {"outcome": {"outcome": "selected", "optionId": "r1"}}


@pytest.mark.asyncio
async def test_agent_cancel_request_answers_minus_32800(env):
    env.register({"turns": [[{"permission": {"options": "all"}, "cancelAfter": 0.3}]]})
    host = await env.open()
    try:
        events = await collect(host)
    finally:
        await env.manager.close_all()
    replies = [m["permissionReply"] for m in env.messages() if "permissionReply" in m]
    assert replies[0]["error"]["code"] == -32800
    assert any(e["type"] == "permission_resolved" and e["outcome"] == "cancelled" for e in events)


@pytest.mark.asyncio
async def test_cancel_mid_permission_answers_cancelled_and_keeps_session(env):
    env.register({"turns": [[{"permission": {"options": "all"}}, {"wait_cancel": True}], [{"chunk": "again"}]]})
    host = await env.open()
    try:
        asked = asyncio.Event()

        async def consume():
            async for event in host.prompt("go"):
                if event["type"] == "permission_request":
                    asked.set()

        task = asyncio.create_task(consume())
        await asyncio.wait_for(asked.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await wait_until(lambda: any("permissionReply" in m for m in env.messages()))
        replies = [m["permissionReply"] for m in env.messages() if "permissionReply" in m]
        assert replies[0]["result"] == {"outcome": {"outcome": "cancelled"}}
        assert "session/cancel" in env.methods()
        assert host.state == "ready"
        events = await collect(host)
        assert [e.get("text") for e in events if e["type"] == "text"] == ["again"]
    finally:
        await env.manager.close_all()


@pytest.mark.asyncio
async def test_agent_ignoring_cancel_is_killed_after_grace(env, monkeypatch):
    monkeypatch.setattr(acp_session, "CANCEL_GRACE_S", 0.5)
    env.register({"turns": [[{"chunk": "working"}, {"ignore_cancel": True}]]})
    host = await env.open()
    token, pid = host.token, host.proc.pid
    started = asyncio.Event()

    async def consume():
        async for event in host.prompt("go"):
            started.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert host.closed and host.closed_reason == "cancel_timeout"
    assert actors.agent_registry.lookup(token) is None
    assert not alive(pid)


@pytest.mark.asyncio
async def test_crash_mid_turn_ends_session_and_revokes_token(env):
    env.register({"turns": [[{"chunk": "partial"}, {"crash": 3}]]})
    host = await env.open()
    token = host.token
    events = await collect(host)
    assert events[0] == {"type": "text", "text": "partial"}
    assert events[-1]["type"] == "error" and events[-1]["code"] == "personal_session_ended"
    assert "code 3" in events[-1]["message"]
    assert host.closed and host.closed_reason == "crashed"
    assert actors.agent_registry.lookup(token) is None
    assert env.manager.get(host.id, OWNER) is None
    with pytest.raises(PersonalSessionError):
        await collect(host)


@pytest.mark.asyncio
async def test_close_kills_the_whole_tree(env, tmp_path):
    marker = tmp_path / "grandchild.pid"
    env.register({"grandchild": str(marker)})
    host = await env.open()
    assert await wait_until(marker.exists)
    grandchild = int(marker.read_text())
    assert alive(grandchild)
    assert await env.manager.close(host.id, "someone-else") is False
    assert await env.manager.close(host.id, OWNER) is True
    assert await wait_until(lambda: not alive(grandchild))
    assert not alive(host.proc.pid)


@pytest.mark.asyncio
async def test_idle_reaper_closes_quiet_sessions(env):
    env.register({})
    host = await env.open()
    token = host.token
    assert await env.manager.reap_idle(now=host.last_activity + 10) == []
    assert await env.manager.reap_idle(now=host.last_activity + acp_session.IDLE_TIMEOUT_S + 1) == [host.id]
    assert host.closed_reason == "idle" and actors.agent_registry.lookup(token) is None


@pytest.mark.asyncio
async def test_protocol_version_mismatch_is_refused(env):
    env.register({"protocolVersion": 2})
    with pytest.raises(PersonalSessionError) as info:
        await env.open()
    assert info.value.code == "acp_version_unsupported"
    assert env.manager.live() == []
    assert "session/new" not in env.methods()
    assert actors.agent_registry._tokens == {}


@pytest.mark.asyncio
async def test_auth_required_is_reported(env):
    env.register({"sessionNewError": {"code": -32000, "message": "Authentication required"}})
    with pytest.raises(PersonalSessionError) as info:
        await env.open()
    assert info.value.code == "auth_required" and "terminal" in info.value.message
    assert actors.agent_registry._tokens == {}
    assert env.manager.live() == []


@pytest.mark.asyncio
async def test_declined_methods_and_junk_stdout(env):
    env.register({"junkStdout": True, "turns": [[{"fs_read": "/etc/hosts"}, {"chunk": "ok"}]]})
    host = await env.open()
    try:
        events = await collect(host)
        assert host.conn.dropped_lines >= 3
    finally:
        await env.manager.close_all()
    assert [e["text"] for e in events if e["type"] == "text"] == ["fs:-32601", "ok"]


@pytest.mark.asyncio
async def test_start_needs_the_acknowledged_warning_and_one_session_per_owner(env):
    env.register({}, acknowledge=False)
    with pytest.raises(PersonalSessionError) as info:
        await env.open()
    assert info.value.code == "personal_agent_warning_required"
    personal_agents.acknowledge_warning(env.state)
    first = await env.open()
    second = await env.open()
    try:
        assert first.closed and first.closed_reason == "replaced"
        assert [s.id for s in env.manager.live()] == [second.id]
    finally:
        await env.manager.close_all()


@pytest.mark.asyncio
async def test_live_session_cap(env, monkeypatch):
    monkeypatch.setattr(acp_session, "MAX_LIVE_SESSIONS", 1)
    env.register({})
    await env.open("a")
    try:
        with pytest.raises(PersonalSessionError) as info:
            await env.open("b")
        assert info.value.code == "personal_agent_limit"
    finally:
        await env.manager.close_all()


@pytest.mark.asyncio
async def test_agent_crashing_during_cancel_ends_the_session(env):
    # Stop arrives after the first chunk; the agent doesn't honor it and
    # crashes inside the grace period. That must close the session, not leave
    # it "ready" with a dead process and a live token.
    env.register({"turns": [[{"chunk": "working"}, {"sleep": 1.0}, {"crash": 3}]]})
    host = await env.open()
    token, pid = host.token, host.proc.pid
    started = asyncio.Event()

    async def consume():
        async for _event in host.prompt("go"):
            started.set()

    task = asyncio.create_task(consume())
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert host.closed and host.closed_reason == "crashed"
    assert actors.agent_registry.lookup(token) is None
    assert not alive(pid)
    assert env.manager.get(host.id, OWNER) is None
    assert env.manager.live() == []


@pytest.mark.asyncio
async def test_close_finishes_the_kill_when_its_caller_is_cancelled(env, tmp_path):
    marker = tmp_path / "grandchild.pid"
    env.register({"grandchild": str(marker)})
    host = await env.open()
    assert await wait_until(marker.exists)
    grandchild, pid, token = int(marker.read_text()), host.proc.pid, host.token
    # Cancel the caller at its first await (the session/close RPC), as
    # uvicorn does to a websocket task on shutdown or reload.
    caller = asyncio.create_task(host.close("disconnected"))
    await asyncio.sleep(0)
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert actors.agent_registry.lookup(token) is None
    # The shutdown hook's close_all still waits for, and sees, the kill.
    await env.manager.close_all()
    assert not alive(pid)
    assert await wait_until(lambda: not alive(grandchild))
    assert host.closed_reason == "disconnected"


@pytest.mark.asyncio
async def test_shutdown_waits_for_a_teardown_already_pruned(env, monkeypatch):
    """The idle reaper (or a cancelled caller) started a close, and another
    close or open pruned the session before shutdown. Shutdown still waits
    for that kill instead of leaving it to be cancelled with the loop."""
    real = acp_session.terminate_agent_process_tree

    async def slow(proc):
        await asyncio.sleep(0.5)
        await real(proc)

    monkeypatch.setattr(acp_session, "terminate_agent_process_tree", slow)
    env.register({"closeCap": False, "turns": [[{"chunk": "x"}]]})
    host = await env.open()
    pid = host.proc.pid
    closing = asyncio.create_task(host.close("idle"))
    await asyncio.sleep(0)
    env.manager._prune()
    assert host.id not in env.manager._sessions
    await env.manager.shutdown()
    assert host._close_task.done() and not alive(pid)
    await closing


@pytest.mark.asyncio
async def test_no_agent_starts_once_shutdown_began(env, monkeypatch):
    """An open() waiting on close_owned when shutdown runs must not start an
    agent and mint a token after shutdown returned."""
    real = acp_session.terminate_agent_process_tree

    async def slow(proc):
        await asyncio.sleep(0.5)
        await real(proc)

    monkeypatch.setattr(acp_session, "terminate_agent_process_tree", slow)
    env.register({"closeCap": False, "turns": [[{"chunk": "x"}]]})
    old = await env.open()
    old_pid = old.proc.pid
    opening = asyncio.create_task(env.open())
    await asyncio.sleep(0.05)
    await env.manager.shutdown()
    with pytest.raises(PersonalSessionError) as refused:
        await opening
    assert refused.value.code == "personal_agent_shutting_down"
    assert env.manager.live() == [] and not alive(old_pid)
    assert env.methods().count("initialize") == 1  # the refused open never started an agent


@pytest.mark.asyncio
async def test_inherited_provider_keys_never_reach_the_agent(env, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-real")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("FAL_KEY", "fal-test-not-real")
    monkeypatch.setenv("NEBULA_APP_TOKEN", "app-test-not-real")
    env.register({"turns": [[{"echo_env": "ANTHROPIC_API_KEY"}, {"echo_env": "OPENAI_API_KEY"},
                             {"echo_env": "FAL_KEY"}, {"echo_env": "NEBULA_APP_TOKEN"}, {"echo_env": "HOME"}]]})
    host = await env.open()
    try:
        texts = [e["text"] for e in await collect(host) if e["type"] == "text"]
    finally:
        await env.manager.close_all()
    assert texts[:4] == ["unset", "unset", "unset", "unset"]
    assert texts[4] != "unset"  # the rest of the environment still passes


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["switch_off", "new_args", "delete"])
async def test_settings_changes_stop_running_sessions(env, change):
    env.register({})
    host = await env.open()
    pid, token = host.proc.pid, host.token
    # A rename or recolor leaves it running.
    personal_agents.update_agent(env.state, "fake", {"displayName": "Renamed", "color": "#abcdef"})
    assert await env.manager.close_stale(env.state) == []
    assert alive(pid) and env.manager.still_allowed(host, env.state)
    if change == "switch_off":
        personal_agents.update_agent(env.state, "fake", {"enabled": False})
    elif change == "new_args":
        args = personal_agents.get_agent(env.state, "fake").args
        personal_agents.update_agent(env.state, "fake", {"args": [*args, "--extra"]})
    else:
        assert personal_agents.delete_custom(env.state, "fake")
    assert not env.manager.still_allowed(host, env.state)
    assert await env.manager.close_stale(env.state) == [host.id]
    assert host.closed and host.closed_reason == "agent_changed"
    assert "Settings" in host.ended_message()
    assert not alive(pid)
    assert actors.agent_registry.lookup(token) is None
    assert env.manager.live() == []


@pytest.mark.asyncio
async def test_switching_off_mid_turn_ends_the_turn(env):
    env.register({"turns": [[{"chunk": "working"}, {"wait_cancel": True}]]})
    host = await env.open()
    pid = host.proc.pid
    events = []

    async def consume():
        async for event in host.prompt("go"):
            events.append(event)

    task = asyncio.create_task(consume())
    assert await wait_until(lambda: events)
    personal_agents.update_agent(env.state, "fake", {"enabled": False})
    await env.manager.close_stale(env.state)
    await asyncio.wait_for(task, 5)
    assert events[-1]["type"] == "error" and events[-1]["code"] == "personal_session_ended"
    assert "Settings" in events[-1]["message"]
    assert not alive(pid)


# -- a close that lands while the session is still starting -----------------------

@pytest.fixture
def slow_kill(monkeypatch):
    """Make the teardown's tree kill take a second, as the SIGTERM grace and
    process snapshot can in real life, so start() resumes mid-teardown."""
    real = acp_session.terminate_agent_process_tree

    async def slow(proc):
        await asyncio.sleep(1.0)
        await real(proc)

    monkeypatch.setattr(acp_session, "terminate_agent_process_tree", slow)


async def _starting_session(env, method: str):
    """Begin env.open() and return (task, host) once the agent has received ``method``."""
    opening = asyncio.create_task(env.open())
    assert await wait_until(lambda: method in env.methods())
    [host] = list(env.manager._sessions.values())
    return opening, host


@pytest.mark.asyncio
async def test_close_during_session_new_wins_over_start(env, slow_kill):
    # Settings switch the agent off while session/new is in flight. The agent
    # still answers it; start() must not turn the closed session "ready".
    env.register({"sessionNewDelay": 0.3})
    opening, host = await _starting_session(env, "session/new")
    pid, token, token_file = host.proc.pid, host.token, host.token_file
    assert token is not None and token_file.exists()
    personal_agents.update_agent(env.state, "fake", {"enabled": False})
    assert await env.manager.close_stale(env.state) == [host.id]
    with pytest.raises(PersonalSessionError) as info:
        await opening
    assert info.value.code == "personal_session_ended" and "Settings" in info.value.message
    assert host.closed and host.state == "closed" and host.closed_reason == "agent_changed"
    assert actors.agent_registry.lookup(token) is None
    assert not token_file.exists()
    assert not alive(pid)
    # It holds no slot and no later close is needed to free it.
    assert env.manager.live() == [] and env.manager._sessions == {}


@pytest.mark.asyncio
async def test_close_during_initialize_mints_no_token(env, slow_kill):
    # The teardown revokes first; a start() that resumed after it and minted
    # would leave a live token nobody revokes.
    env.register({"initDelay": 0.3})
    opening, host = await _starting_session(env, "initialize")
    pid = host.proc.pid
    await env.manager.close_owned(OWNER, "replaced")
    with pytest.raises(PersonalSessionError) as info:
        await opening
    assert info.value.code == "personal_session_ended"
    assert host.token is None and actors.agent_registry._tokens == {}
    assert "session/new" not in env.methods()
    assert not (env.state / "agent-tokens" / str(os.getpid())).exists() \
        or list((env.state / "agent-tokens" / str(os.getpid())).iterdir()) == []
    assert not alive(pid)
    assert env.manager._sessions == {}


@pytest.mark.asyncio
async def test_close_during_spawn_kills_the_late_process(env, monkeypatch):
    # The teardown ran before the spawn returned, so it saw no process.
    real_spawn = acp_session._spawn
    spawned: list = []
    release = asyncio.Event()

    async def slow_spawn(argv, child_env, cwd):
        proc = await real_spawn(argv, child_env, cwd)
        spawned.append(proc)
        await release.wait()
        return proc

    monkeypatch.setattr(acp_session, "_spawn", slow_spawn)
    env.register({})
    opening = asyncio.create_task(env.open())
    assert await wait_until(lambda: spawned)
    [host] = list(env.manager._sessions.values())
    await env.manager.close_all("shutdown")
    release.set()
    with pytest.raises(PersonalSessionError) as info:
        await opening
    assert info.value.code == "personal_session_ended"
    assert host.proc is None and host.token is None and actors.agent_registry._tokens == {}
    assert await wait_until(lambda: not alive(spawned[0].pid))
    assert env.methods() == []
    assert env.manager._sessions == {}


@pytest.mark.asyncio
async def test_registry_change_while_starting_is_caught_after_start(env):
    # A change that bypassed close_stale (another backend process, a hand
    # edit) during start: open() checks again before handing the session out.
    env.register({"initDelay": 0.3})
    opening = asyncio.create_task(env.open())
    assert await wait_until(lambda: "initialize" in env.methods())
    personal_agents.update_agent(env.state, "fake", {"enabled": False})
    with pytest.raises(PersonalSessionError) as info:
        await opening
    assert info.value.code == "personal_session_ended" and "Settings" in info.value.message
    assert actors.agent_registry._tokens == {}
    assert env.manager.live() == [] and env.manager._sessions == {}


@pytest.mark.asyncio
async def test_settings_change_while_open_replaces_the_old_chat(env):
    # open() closes the owner's previous session first. A Settings change
    # during that close must count: the launch key and spec are read after it.
    env.register({"turns": [[]]}, agent_id="fake")
    env.register({"turns": [[]]}, agent_id="fake2")
    first = await env.open(agent_id="fake")
    opening = asyncio.create_task(env.open(agent_id="fake2"))
    assert await wait_until(lambda: first.closed, timeout=5)
    personal_agents.update_agent(env.state, "fake2", {"enabled": False})
    await env.manager.close_stale(env.state)
    with pytest.raises(PersonalSessionError) as info:
        await opening
    assert info.value.code == "personal_agent_disabled"
    assert env.manager.live() == []
    assert actors.agent_registry._tokens == {}
    assert env.methods().count("initialize") == 1  # fake2 never started


@pytest.mark.asyncio
async def test_long_text_is_capped_per_chunk_and_per_turn(env, monkeypatch):
    from services import acp_events
    monkeypatch.setattr(acp_events, "MAX_TURN_TEXT_CHARS", 50_000)
    big = "x" * (acp_events.MAX_TEXT_CHUNK_CHARS + 5_000)
    env.register({"turns": [[{"chunk": big}, {"thought": big}, {"chunk": big}, {"chunk": big}, {"chunk": "tail"}]]})
    host = await env.open()
    try:
        events = await collect(host)
    finally:
        await env.manager.close_all()
    shown = [e for e in events if e["type"] in {"text", "thought"}]
    assert all(len(e["text"]) <= acp_events.MAX_TEXT_CHUNK_CHARS for e in shown)
    assert sum(len(e["text"]) for e in shown) == 50_000
    assert [e for e in events if e["type"] == "system"] == [{"type": "system", "text": acp_events.TEXT_CUT_NOTICE}]
    assert events[-1]["type"] == "result"
