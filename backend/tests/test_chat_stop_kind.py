"""The chat websocket's error events: a stop carries ``stop`` (and ``reason`` when Nebula ended
the session), a refusal carries neither, and each person-facing line reads as designed.

Stop kinds (an agent ran, then stopped):
  stop "error"  the agent's own failure: a failed turn, a crash, an unanswered cancel
  stop "ended"  Nebula or a timer ended a personal session, with reason idle, agent_changed,
                commons_enabled, shutdown, or "ended" (the session is unknown or already gone)
A refusal (the agent never ran) has no ``stop``. The person's own Stop sends cancellation events,
never an error event. The wording is spelled out here on purpose: a change to a line fails a test.
"""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import replace

import pytest

import main
from commons import actors
from services import acp_session, chat_models, chat_session, personal_agents
from services.acp_client import AcpError
from services.acp_session import PersonalSessionError
from tests.conftest import PERSON_TOKEN
from tests.test_acp_session import env as acp_env, collect, OWNER, wait_until  # noqa: F401
from tests.test_chat_personal_ws import AGENT, Socket, send, ws_env  # noqa: F401
from tests.test_commons_integration import isolated_app  # noqa: F401

pytestmark = pytest.mark.usefixtures("person")

RELOAD = "Nebula couldn’t read that message. Reload the page, then send again."
UNKNOWN_AGENT = ("Nebula doesn’t recognize the agent for this chat. Pick one in the Model & thinking menu, "
                 "then send again.")
ENDED_UNKNOWN = "This chat’s agent stopped. Send again to start a new conversation."


async def _run(socket, *frames):
    task = asyncio.create_task(main.chat_websocket(socket))
    for frame in frames:
        socket.put(frame) if isinstance(frame, dict) else socket.incoming.put_nowait(frame)
    return task


async def _finish(socket, task):
    socket.disconnect()
    await asyncio.wait_for(task, 5)


def _send(message="hi", **extra):
    return {"type": "send", "message": message, "personToken": PERSON_TOKEN, **extra}


# -- the wording of the lines themselves ---------------------------------------------------


def test_ended_lines_per_reason():
    line = acp_session.ended_line
    assert line("agent_changed", "Your Gemini") == (
        "Your Gemini stopped because it was switched off or changed in Settings. If it’s still on there, send again.")
    assert line("commons_enabled", "Your Gemini") == (
        "Your Gemini stopped because Commons is on. Pick Claude or Codex to keep chatting.")
    assert line("idle", "Your Gemini") == "Your Gemini stopped after it sat idle. Send again to start a new conversation."
    assert line("shutdown", "Your Gemini") == (
        "Your Gemini stopped because Nebula closed. Send again to start a new conversation.")
    assert line("ended", "Your Gemini") == ENDED_UNKNOWN
    assert line("idle", None) == ENDED_UNKNOWN


@pytest.mark.parametrize("code, agent, text", [
    ("model_invalid", "claude", RELOAD),
    ("effort_invalid", "codex", RELOAD),
    ("model_required", "claude",
     "No model is selected. Pick a model in the chat’s Model & thinking menu, then send again."),
    ("model_unsupported", "claude",
     "That model isn’t offered anymore. Open the Model & thinking menu, pick another, then send again."),
    ("effort_unsupported", "codex",
     "This model doesn’t support that effort level. Pick another level in the Model & thinking menu, then send again."),
    ("auth_required", "claude",
     "Claude Code isn’t signed in, so Nebula can’t list its models. Run `claude` in a terminal and sign in, "
     "then send again."),
    ("auth_required", "codex",
     "Codex isn’t signed in, so Nebula can’t list its models. Run `codex` in a terminal and sign in with your "
     "ChatGPT account, then send again."),
    ("catalog_unavailable", "claude",
     "Nebula couldn’t get the model list from Claude Code. Check that it’s installed and signed in, then send again."),
    ("catalog_cleanup_failed", "codex",
     "Nebula couldn’t get the model list from Codex. Check that it’s installed and signed in, then send again."),
    ("catalog_timeout", "codex", "Codex took too long to list its models. Send again in a moment."),
    ("cli_not_installed", "claude", "Claude Code isn’t installed. Install it, then send again."),
])
def test_model_refusal_lines(code, agent, text):
    assert chat_models.chat_refusal_message(code, agent, "fallback") == text


def test_an_unknown_model_code_keeps_its_own_text():
    assert chat_models.chat_refusal_message("something_else", "claude", "its own text") == "its own text"


# -- refusals: no stop ---------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("raw, text", [
    ("{not json", RELOAD),
    ("[1, 2]", RELOAD),
    ("1" * 5000, "A number in that message is too large for Nebula to read. Reload the page, then send again."),
    ("1e999", "A number in that message is too large for Nebula to read. Reload the page, then send again."),
])
async def test_unreadable_messages_are_refusals(isolated_app, raw, text):
    # (An int past 4,300 digits and 1e999 are numbers out of range; the rest is not JSON or not an object.)
    socket = Socket()
    task = await _run(socket, raw)
    error = await socket.next("error")
    assert error["message"] == text and error["source"] == "system" and "stop" not in error and "reason" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
@pytest.mark.parametrize("frame, text, code", [
    (_send(message=5), RELOAD, None),
    (_send(selectedNodeIds="n1"), RELOAD, None),
    (_send(agent=""), UNKNOWN_AGENT, "agent_invalid"),
    (_send(agent=7), UNKNOWN_AGENT, "agent_invalid"),
    (_send(agent="personal:not valid!"), UNKNOWN_AGENT, "agent_invalid"),
    (_send(provider="openai"), "This tab sent an older kind of request. Reload the page, then send again.",
     "provider_invalid"),
])
async def test_bad_sends_are_refusals(isolated_app, frame, text, code):
    socket = Socket()
    task = await _run(socket, frame)
    error = await socket.next("error")
    assert error["message"] == text and error["source"] == ("claude" if code == "provider_invalid" else "system")
    assert error.get("code") == code and "stop" not in error and "reason" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_an_unknown_agent_id_is_a_system_refusal_that_does_not_echo_the_id(isolated_app):
    socket = Socket()
    task = await _run(socket, _send(agent="mallory"))
    error = await socket.next("error")
    assert error["message"] == UNKNOWN_AGENT and "mallory" not in error["message"]
    assert error["source"] == "system" and error["code"] == "agent_invalid" and "stop" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_commons_on_refuses_a_personal_agent(isolated_app, monkeypatch):
    monkeypatch.setenv("NEBULA_COMMONS_ENABLED", "1")
    socket = Socket()
    task = await _run(socket, _send(agent="personal:fake"))
    error = await socket.next("error")
    assert error["message"] == ("Commons is on, so only Claude and Codex can chat. Pick one of them, then send again.")
    assert error["source"] == "system" and "stop" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_a_send_while_a_response_runs_is_a_system_refusal(isolated_app, monkeypatch):
    async def runner(message, session_id, model, autonomy, **kwargs):
        yield {"type": "text", "text": "working"}
        await asyncio.Event().wait()

    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    socket = Socket()
    task = await _run(socket, _send(agent="claude"))
    await socket.next("text")
    socket.put(_send("again", agent="claude"))
    error = await socket.next("error")
    assert error["message"] == "A response is still running. Stop it and wait for it to stop, then send again."
    assert error["source"] == "system" and "stop" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
@pytest.mark.parametrize("code, catalog_error, text", [
    ("auth_required", {"code": "auth_required", "message": "REST text"},
     "Claude Code isn’t signed in, so Nebula can’t list its models. Run `claude` in a terminal and sign in, "
     "then send again."),
    ("cli_not_installed", {"code": "cli_not_installed", "message": "REST text"},
     "Claude Code isn’t installed. Install it, then send again."),
    ("catalog_timeout", {"code": "catalog_timeout", "message": "REST text"},
     "Claude Code took too long to list its models. Send again in a moment."),
    ("catalog_unavailable", {"code": "catalog_unavailable", "message": "REST text"},
     "Nebula couldn’t get the model list from Claude Code. Check that it’s installed and signed in, then send again."),
])
async def test_catalog_refusals_reach_the_chat_in_the_new_wording(isolated_app, monkeypatch, code, catalog_error, text):
    async def catalog(agent, *, refresh=False):
        return {"agent": agent, "status": "unavailable", "models": [], "error": catalog_error}

    monkeypatch.setattr(chat_models, "get_chat_models", catalog)
    socket = Socket()
    task = await _run(socket, _send(agent="claude", model="some-model"))
    error = await socket.next("error")
    assert error["code"] == code and error["message"] == text
    assert error["source"] == "claude" and "stop" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
@pytest.mark.parametrize("model, effort, code, text", [
    ("  ", None, "model_invalid", RELOAD),
    ("m", "  ", "effort_invalid", RELOAD),
    ("gone", None, "model_unsupported",
     "That model isn’t offered anymore. Open the Model & thinking menu, pick another, then send again."),
    ("m", "turbo", "effort_unsupported",
     "This model doesn’t support that effort level. Pick another level in the Model & thinking menu, then send again."),
])
async def test_model_choice_refusals_reach_the_chat(isolated_app, monkeypatch, model, effort, code, text):
    async def catalog(agent, *, refresh=False):
        return {"agent": agent, "status": "ready", "error": None, "models": [
            {"id": "m", "isDefault": True, "defaultEffort": "low", "supportedEfforts": [{"id": "low"}]}]}

    monkeypatch.setattr(chat_models, "get_chat_models", catalog)
    socket = Socket()
    task = await _run(socket, _send(agent="claude", model=model, effort=effort))
    error = await socket.next("error")
    assert error["code"] == code and error["message"] == text and "stop" not in error
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_no_model_picked_and_no_default_is_a_refusal(isolated_app, monkeypatch):
    async def catalog(agent, *, refresh=False):
        return {"agent": agent, "status": "ready", "error": None, "models": [
            {"id": "m", "isDefault": False, "defaultEffort": None, "supportedEfforts": []}]}

    monkeypatch.setattr(chat_models, "get_chat_models", catalog)
    socket = Socket()
    task = await _run(socket, _send(agent="claude", effort="low"))
    error = await socket.next("error")
    assert error["code"] == "model_required" and "stop" not in error
    assert error["message"] == "No model is selected. Pick a model in the chat’s Model & thinking menu, then send again."
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_person_required_is_still_a_refusal_with_its_old_text(isolated_app):
    socket = Socket()
    task = await _run(socket, {"type": "send", "message": "hi", "personToken": "wrong", "agent": "claude"})
    error = await socket.next("error")
    assert error["code"] == "person_required" and "stop" not in error
    assert error["message"].startswith("Only the person can start a chat, from a Nebula canvas connected as them.")
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_the_warning_notice_refusal_names_where_it_opens(ws_env):
    ws_env.register({}, acknowledge=False)
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    error = await socket.next("error")
    assert error["code"] == "personal_agent_warning_required" and "stop" not in error
    assert error["message"] == "Accept the personal agent notice that opens over the chat, then send again."
    await _finish(socket, task)


# -- stops: an agent ran and stopped -------------------------------------------------------


@pytest.mark.asyncio
async def test_a_runner_that_raises_is_an_error_stop(isolated_app, monkeypatch):
    async def runner(message, session_id, model, autonomy, **kwargs):
        raise RuntimeError("the runner fell over")
        yield  # pragma: no cover

    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    socket = Socket()
    task = await _run(socket, _send(agent="claude"))
    error = await socket.next("error")
    assert error["message"] == "the runner fell over" and error["stop"] == "error" and "reason" not in error
    assert error["source"] == "claude"
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_a_runners_own_error_event_keeps_its_stop(isolated_app, monkeypatch):
    async def runner(message, session_id, model, autonomy, **kwargs):
        yield {"type": "error", "stop": "error", "message": "turn failed"}
        yield {"type": "done"}

    monkeypatch.setitem(chat_session.AGENT_RUNNERS, "claude", runner)
    socket = Socket()
    task = await _run(socket, _send(agent="claude"))
    error = await socket.next("error")
    assert error["stop"] == "error" and error["source"] == "claude"
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_a_personal_crash_is_an_error_stop(ws_env):
    ws_env.register({"turns": [[{"chunk": "partial"}, {"crash": 9}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    error = await socket.next("error")
    assert error["code"] == "personal_session_ended" and error["stop"] == "error" and "reason" not in error
    assert error["message"].startswith("Fake Agent exited") and "code 9" in error["message"]
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_the_agents_own_error_answer_is_an_error_stop(acp_env):
    acp_env.register({})
    host = await acp_env.open()
    real = host.conn.request

    async def failing(method, params=None, **kwargs):
        if method == "session/prompt":
            raise AcpError(-32603, "Quota exceeded")
        return await real(method, params, **kwargs)

    host.conn.request = failing
    events = await collect(host)
    assert events[0] == {"type": "error", "stop": "error", "message": "Fake Agent: Quota exceeded"}
    await acp_env.manager.close_all()


@pytest.mark.asyncio
async def test_an_agent_that_ignores_cancel_is_an_error_stop_on_the_next_send(ws_env, monkeypatch):
    monkeypatch.setattr(acp_session, "CANCEL_GRACE_S", 0.5)
    ws_env.register({"turns": [[{"chunk": "working"}, {"ignore_cancel": True}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    session = await socket.next("session")
    await socket.next("text")
    # The person's Stop: cancellation events only, never an error event.
    socket.put({"type": "cancel"})
    assert (await socket.next("cancellation"))["status"] == "requested"
    assert (await socket.next("cancellation"))["status"] == "confirmed"
    assert not [e for e in socket.events if e["type"] == "error"]
    send(socket, "again", session_id=session["sessionId"])
    error = await socket.next("error")
    assert error["code"] == "personal_session_ended" and error["stop"] == "error" and "reason" not in error
    assert error["message"] == ENDED_UNKNOWN
    await _finish(socket, task)


@pytest.mark.asyncio
@pytest.mark.parametrize("reason, text", [
    ("idle", "Fake Agent stopped after it sat idle. Send again to start a new conversation."),
    ("agent_changed", "Fake Agent stopped because it was switched off or changed in Settings. "
                      "If it’s still on there, send again."),
    ("commons_enabled", "Fake Agent stopped because Commons is on. Pick Claude or Codex to keep chatting."),
    ("shutdown", "Fake Agent stopped because Nebula closed. Send again to start a new conversation."),
    ("closed_by_person", ENDED_UNKNOWN),
    ("disconnected", ENDED_UNKNOWN),
])
async def test_a_send_to_an_ended_session_says_why_with_its_reason(ws_env, reason, text):
    ws_env.register({"turns": [[{"chunk": "one"}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    first = await socket.until_done()
    session = next(e for e in first if e["type"] == "session")
    [host] = ws_env.manager.live()
    await host.close(reason)
    send(socket, "again", session_id=session["sessionId"])
    error = await socket.next("error")
    expected = reason if reason in {"idle", "agent_changed", "commons_enabled", "shutdown"} else "ended"
    assert error["code"] == "personal_session_ended" and error["stop"] == "ended" and error["reason"] == expected
    assert error["message"] == text and error["source"] == "personal"
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_the_reason_survives_the_manager_pruning_the_session(ws_env):
    ws_env.register({"turns": [[{"chunk": "one"}]]})
    socket = Socket()
    task = asyncio.create_task(main.chat_websocket(socket))
    send(socket)
    first = await socket.until_done()
    session = next(e for e in first if e["type"] == "session")
    [host] = ws_env.manager.live()
    assert await ws_env.manager.reap_idle(now=host.last_activity + acp_session.IDLE_TIMEOUT_S + 1) == [host.id]
    assert host.id not in ws_env.manager._sessions
    send(socket, "again", session_id=session["sessionId"])
    error = await socket.next("error")
    assert error["stop"] == "ended" and error["reason"] == "idle"
    assert error["message"] == "Fake Agent stopped after it sat idle. Send again to start a new conversation."
    await _finish(socket, task)


@pytest.mark.asyncio
async def test_an_unknown_session_is_an_ended_stop_and_another_sockets_session_stays_private(ws_env):
    ws_env.register({"turns": [[{"chunk": "one"}]]})
    owner, other = Socket(), Socket()
    owner_task = asyncio.create_task(main.chat_websocket(owner))
    send(owner)
    first = await owner.until_done()
    session = next(e for e in first if e["type"] == "session")
    other_task = asyncio.create_task(main.chat_websocket(other))
    send(other, session_id="no-such-session")
    error = await other.next("error")
    assert error["stop"] == "ended" and error["reason"] == "ended" and error["message"] == ENDED_UNKNOWN
    send(other, session_id=session["sessionId"])
    error = await other.next("error")
    assert error["stop"] == "ended" and error["reason"] == "ended" and error["message"] == ENDED_UNKNOWN
    await _finish(owner, owner_task)
    await _finish(other, other_task)


@pytest.mark.asyncio
async def test_settings_switching_the_agent_off_mid_turn_is_an_ended_stop(acp_env):
    acp_env.register({"turns": [[{"chunk": "working"}, {"ignore_cancel": True}]]})
    host = await acp_env.open()
    events = []

    async def consume():
        async for event in host.prompt("go"):
            events.append(event)

    task = asyncio.create_task(consume())
    assert await wait_until(lambda: events)
    personal_agents.update_agent(acp_env.state, "fake", {"enabled": False})
    await acp_env.manager.close_stale(acp_env.state)
    await asyncio.wait_for(task, 5)
    assert events[-1] == {"type": "error", "code": "personal_session_ended", "stop": "ended",
                          "reason": "agent_changed",
                          "message": "Fake Agent stopped because it was switched off or changed in Settings. "
                                     "If it’s still on there, send again."}


# -- start failures are refusals -----------------------------------------------------------


async def _refused(acp_env):
    with pytest.raises(PersonalSessionError) as info:
        await acp_env.open()
    assert info.value.stop is None and info.value.reason is None
    assert "stop" not in info.value.event() and "reason" not in info.value.event()
    return info.value


@pytest.mark.asyncio
async def test_start_failures_read_couldnt_start(acp_env, monkeypatch):
    acp_env.register({"sessionNewError": {"code": -32603, "message": "Boom"}})
    error = await _refused(acp_env)
    assert error.code == "personal_agent_start_failed"
    assert error.message == "Fake Agent couldn’t start. It couldn’t open a session: Boom"

    monkeypatch.setattr(acp_session, "INIT_TIMEOUT_S", 0.3)
    real_spec = personal_agents.launch_spec
    monkeypatch.setattr(personal_agents, "launch_spec",
                        lambda *a, **k: replace(real_spec(*a, **k), startup_timeout=0.3))
    acp_env.register({"initDelay": 3}, agent_id="slow")
    with pytest.raises(PersonalSessionError) as info:
        await acp_env.open(agent_id="slow")
    assert info.value.code == "personal_agent_start_timeout"
    assert info.value.message == "Fake Agent couldn’t start. It didn’t answer in time."


@pytest.mark.asyncio
async def test_a_protocol_mismatch_says_couldnt_start(acp_env):
    acp_env.register({"protocolVersion": 2})
    error = await _refused(acp_env)
    assert error.code == "acp_version_unsupported"
    assert error.message == "Fake Agent couldn’t start. It speaks ACP version 2; Nebula speaks 1."


@pytest.mark.asyncio
async def test_sign_in_refusals_name_the_real_settings_place(acp_env, monkeypatch):
    # No auth method (a custom agent): sign in once in a terminal.
    acp_env.register({"sessionNewError": {"code": -32000, "message": "Authentication required"}})
    error = await _refused(acp_env)
    assert error.code == "auth_required"
    assert error.message == "Fake Agent needs you to sign in. Run it once in a terminal and sign in there, then send again."

    # An agent Nebula signs in for (a spec with an auth method): Settings.
    real_spec = personal_agents.launch_spec
    monkeypatch.setattr(personal_agents, "launch_spec",
                        lambda *a, **k: replace(real_spec(*a, **k), auth_method="oauth"))
    acp_env.register({"authMethods": [{"id": "oauth"}],
                      "sessionNewError": {"code": -32000, "message": "Authentication required"}}, agent_id="g")
    with pytest.raises(PersonalSessionError) as info:
        await acp_env.open(agent_id="g")
    assert info.value.message == ("Fake Agent needs you to sign in. Sign in from Settings > Preferences > "
                                  "Personal agents, then send again.")

    # The stored sign-in timed out.
    monkeypatch.setattr(acp_session, "AUTH_TIMEOUT_S", 0.5)
    acp_env.register({"authMethods": [{"id": "oauth"}], "authenticate": "hang"}, agent_id="h")
    with pytest.raises(PersonalSessionError) as info:
        await acp_env.open(agent_id="h")
    assert info.value.code == "auth_required" and info.value.stop is None
    assert info.value.message == ("Fake Agent needs you to sign in with Google again. Do that in Settings > "
                                  "Preferences > Personal agents, then send again.")

    # The agent answered the sign-in with an error: its words stay.
    acp_env.register({"authMethods": [{"id": "oauth"}], "authenticate": "error"}, agent_id="i")
    with pytest.raises(PersonalSessionError) as info:
        await acp_env.open(agent_id="i")
    assert info.value.message == ("Fake Agent couldn’t use your sign-in: Authentication failed. Sign in again in "
                                  "Settings > Preferences > Personal agents, then send again.")


def test_every_settings_path_the_backend_writes_is_a_real_one():
    assert acp_session.PERSONAL_AGENTS_SETTINGS == "Settings > Preferences > Personal agents"
    # frontend/src/components/panels/settings: the Preferences tab holds the "Personal agents" section.
    from pathlib import Path
    settings = Path(main.__file__).resolve().parent.parent / "frontend" / "src" / "components" / "panels" / "settings"
    assert "label: 'Preferences'" in (settings / "SettingsTabs.tsx").read_text()
    assert ">Personal agents</h3>" in (settings / "PersonalAgentsSection.tsx").read_text()
    assert "label: 'Providers'" in (settings / "SettingsTabs.tsx").read_text()
