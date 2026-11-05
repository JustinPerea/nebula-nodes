"""The Message box thread, round 4 (review 2 of #223/#225, Justin 2026-11-04).

- J1: replying takes a Settings agent token, the same as listening: a name
  alone (any name, however rotated), an in-app agent's turn token and a
  revoked token are refused with a line that says what to do, and the
  reply pace keys on the token's agent only.
- J2: the `nebula` CLI reads NEBULA_APP_TOKEN_FILE (strictly, never into
  the environment), so a reply from the listening Claude's own shell is the
  listening session's: it settles the person's message.
- Boundary LOW-1: revoking a token settles its listener's messages in flight.
- Boundary LOW-2: the inbox and accept find a message in any project, and
  a lost journal stretch or a failed read re-arms the inbox.
- Live L1 / parity B7, NIT-2, NIT-3, LOW-2, live L3.
"""
from __future__ import annotations

import os
import stat
from types import SimpleNamespace

import anyio
import pytest

import mcp_channel
import nebula_api
from services import app_token_file, person_thread
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, Clock, api  # noqa: F401 - fixture
from tests.test_mcp_channel import resp
from tests.test_person_thread import (CLAUDE_TOKEN, CODEX_TOKEN, SESSION_A, SESSION_B, _listen, _send,  # noqa: F401
                                      thread)
from tests.test_person_thread_round3 import _person_rows, _reply, paced  # noqa: F401 - fixture


# -- J1: a reply takes a Settings token -------------------------------------------------------

def test_rotating_names_never_posts_a_reply(paced):
    """Review 2 MEDIUM-1: 20 tokenless replies under 20 names used to all post."""
    answers = [_reply(paced, f"r{n}", headers={"X-Nebula-Agent": f"Claude Code {n}"}) for n in range(20)]
    assert {(a.status_code, a.json()["detail"], a.headers["X-Nebula-Code"]) for a in answers} == {
        (401, person_thread.REPLY_NO_TOKEN_LINE, "reply_no_token")}
    assert not any(row["kind"] == "reply" for row in _person_rows(paced))
    # The token agent's own pace is untouched by them: a full burst of 5.
    assert [_reply(paced, f"t{n}", headers=CLAUDE_TOKEN).status_code for n in range(6)] == [201] * 5 + [429]


def test_an_in_app_agents_turn_token_is_told_to_answer_in_its_chat(thread, monkeypatch):
    from commons.actors import agent_registry
    monkeypatch.setattr(agent_registry, "lookup", lambda token: {"runner": "claude", "session": "chat1"}
                        if token == "tok-inapp" else None)
    refused = _reply(thread, "hi", headers={"Authorization": "Agent tok-inapp"})
    assert refused.status_code == 401 and refused.json()["detail"] == person_thread.REPLY_IN_APP_LINE
    assert refused.headers["X-Nebula-Code"] == "reply_in_app_token"


def test_a_revoked_token_gets_the_replys_own_line_and_the_listener_routes_r81s(thread):
    bogus = {"Authorization": "Agent gone", "X-Nebula-Agent-Session": "sess-a"}
    refused = _reply(thread, "hi", headers=bogus)
    assert refused.status_code == 401 and refused.json()["detail"] == person_thread.REPLY_BAD_TOKEN_LINE
    assert refused.headers["X-Nebula-Code"] == "reply_token_invalid"
    # Parity NIT-2: the listener's own routes answer a bad token as registering does.
    for method, path in (("get", "/api/agent/thread/inbox"), ("post", "/api/agent/thread/accepted"),
                         ("post", "/api/agent/thread/held")):
        answer = getattr(thread.client, method)(path, headers=bogus, **({"json": {"messageIds": []}}
                                                                         if method == "post" else {}))
        assert answer.status_code == 401 and answer.headers["X-Nebula-Code"] == "listener_token_invalid", path


def test_the_reply_lines_follow_the_copy_rules():
    for line in (person_thread.REPLY_NO_TOKEN_LINE, person_thread.REPLY_IN_APP_LINE,
                 person_thread.REPLY_BAD_TOKEN_LINE):
        assert line.startswith("Nebula couldn’t post this reply because ")
        assert "'" not in line and "(" not in line and ":" not in line, line
    assert "NEBULA_APP_TOKEN_FILE" in person_thread.REPLY_NO_TOKEN_LINE
    assert "Settings › Connect your agent" in person_thread.REPLY_NO_TOKEN_LINE


def test_the_agent_lines_are_gm_r94s_verbatim():
    """GM r94: the words, and the command on its own line."""
    command = "nebula mcp connect claude-code --channel"
    assert person_thread.REPLY_NO_TOKEN_LINE.split("\n") == [
        "Nebula couldn’t post this reply because this agent has no token. Copy one from Settings › Connect your "
        "agent, run this command, then reply again.",
        command,
        "The nebula CLI finds the token through NEBULA_APP_TOKEN_FILE, which this command sets up."]
    assert person_thread.REPLY_BAD_TOKEN_LINE.split("\n") == [
        "Nebula couldn’t post this reply because its token isn’t valid anymore. Copy a new one from Settings › "
        "Connect your agent, run this command, then reply again.",
        command]
    assert person_thread.REPLY_IN_APP_LINE == (
        "Nebula couldn’t post this reply because it uses an in-app agent’s token, and only an agent connected from "
        "Settings › Connect your agent can reply in the Message box. Answer the person in this chat instead.")
    from cli.commands import thread as thread_cmd
    assert thread_cmd.NO_TOKEN_CHANNEL_LINE.split("\n") == [
        "This terminal has no agent token, so Nebula can’t tell which listeners are yours. Run this command, then "
        "start Claude Code as it says.",
        command,
        "The nebula CLI in that session reads its token file."]


def test_an_empty_token_file_variable_says_what_to_do(monkeypatch):
    monkeypatch.setattr(nebula_api, "_file_token", None)
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.app_token_from_file({"NEBULA_APP_TOKEN_FILE": "  "})
    assert refused.value.detail == ("NEBULA_APP_TOKEN_FILE is empty. Unset it, or point it at the token file that "
                                    "Settings › Connect your agent saved.")


# -- live L1 and parity B7: the pace ------------------------------------------------------------

def test_a_reply_nebula_refuses_never_spends_the_pace(paced, monkeypatch):
    real = paced.main.thread_book.add_reply

    def no_project(*a, **k):
        raise person_thread.ThreadError(409, "Open or create a project first", "no_project")

    monkeypatch.setattr(paced.main.thread_book, "add_reply", no_project)
    assert {_reply(paced, f"r{n}", headers=CLAUDE_TOKEN).status_code for n in range(7)} == {409}
    monkeypatch.setattr(paced.main.thread_book, "add_reply", real)
    assert [_reply(paced, f"t{n}", headers=CLAUDE_TOKEN).status_code for n in range(6)] == [201] * 5 + [429]


def test_a_long_quiet_never_banks_more_than_the_burst():
    clock = Clock()
    pace = person_thread.ReplyPace(clock)
    assert pace.take("app:claude1") == 0.0
    clock.now += 1000.0  # 500 replies' worth of quiet
    waits = [pace.take("app:claude1") for _ in range(6)]
    assert waits[:5] == [0.0] * 5 and waits[5] > 0


def test_refund_never_raises_the_bucket_past_the_burst():
    pace = person_thread.ReplyPace(Clock())
    pace.take("app:a")
    pace.refund("app:a")
    pace.refund("app:a")
    assert [pace.take("app:a") for _ in range(6)][5] > 0
    pace.refund("app:unknown")  # nothing to give back


# -- J2: the CLI reads the token file -----------------------------------------------------------

@pytest.fixture
def token_file(tmp_path, monkeypatch):
    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_AGENT_TOKEN_FILE"):
        monkeypatch.delenv(name, raising=False)
    path = str(app_token_file.write(tmp_path / "state", "0123456789ab", "nbl_app_" + "a" * 40))
    monkeypatch.setenv("NEBULA_APP_TOKEN_FILE", path)
    monkeypatch.setattr(nebula_api, "_file_token", None)
    return path


def test_the_cli_sends_the_token_in_the_file_and_never_puts_it_in_the_environment(token_file):
    headers = nebula_api.with_identity({"X-Nebula-Agent": "Claude Code"})
    assert headers["Authorization"] == "Agent nbl_app_" + "a" * 40
    assert "NEBULA_APP_TOKEN" not in os.environ and nebula_api.has_token()


def test_the_token_file_wins_over_a_token_in_the_environment(token_file, monkeypatch):
    # D3 (round 5; review 3 LOW-1/LOW-3): the MCP server's order, so the
    # shell and the listener are one agent even when an old NEBULA_APP_TOKEN
    # is still exported.
    monkeypatch.setenv("NEBULA_APP_TOKEN", "from-env")
    assert nebula_api.with_identity()["Authorization"] == "Agent nbl_app_" + "a" * 40
    # A turn token (an in-app chat) still comes first, as in the MCP server.
    monkeypatch.setenv("NEBULA_AGENT_TOKEN", "turn")
    assert nebula_api.with_identity()["Authorization"] == "Agent turn"


def test_a_bad_token_file_fails_closed_even_with_a_good_token_in_the_environment(token_file, monkeypatch):
    monkeypatch.setenv("NEBULA_APP_TOKEN", "from-env")
    os.chmod(token_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IROTH)
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.with_identity()
    assert "because NEBULA_APP_TOKEN_FILE points to a file other users can read" in refused.value.detail
    assert "from-env" not in refused.value.detail


def test_has_token_is_true_only_when_a_token_is_sent(monkeypatch, tmp_path):
    # Review 3 NIT: with a personal agent's NEBULA_AGENT_TOKEN_FILE set, the
    # app file isn't read, so (with nothing else) no token goes.
    assert not nebula_api.has_token({"NEBULA_AGENT_TOKEN_FILE": "/x", "NEBULA_APP_TOKEN_FILE": "/y"})
    assert nebula_api.has_token({"NEBULA_AGENT_TOKEN_FILE": "/x", "NEBULA_APP_TOKEN": "t"})
    assert nebula_api.has_token({"NEBULA_APP_TOKEN_FILE": "/y"})
    assert nebula_api.has_token({"NEBULA_AGENT_TOKEN": "t"})
    assert not nebula_api.has_token({"NEBULA_AGENT_TOKEN": "", "NEBULA_APP_TOKEN": ""})


def test_a_personal_agents_token_file_keeps_the_app_file_unread(token_file, monkeypatch):
    # Review 3 LOW-2/LOW-6 B2: the NEBULA_AGENT_TOKEN_FILE guard.
    monkeypatch.setenv("NEBULA_AGENT_TOKEN_FILE", "/nonexistent")
    assert nebula_api.app_token_from_file() is None
    assert "Authorization" not in nebula_api.with_identity({"X-Nebula-Agent": "Claude Code"})


def test_the_file_token_is_cached_per_path(token_file, monkeypatch, tmp_path):
    # Review 3 LOW-6 B1: a changed NEBULA_APP_TOKEN_FILE reads the new file.
    assert nebula_api.app_token_from_file() == "nbl_app_" + "a" * 40
    other = str(app_token_file.write(tmp_path / "other", "ba9876543210", "nbl_app_" + "b" * 40))
    monkeypatch.setenv("NEBULA_APP_TOKEN_FILE", other)
    assert nebula_api.app_token_from_file() == "nbl_app_" + "b" * 40


def test_a_token_file_open_to_others_fails_closed_without_the_token(token_file):
    os.chmod(token_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP)
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.with_identity()
    assert "a" * 40 not in refused.value.detail
    # GM r97: r94's shape, the reason as a clause after the variable, the command on its own line.
    assert refused.value.detail == (
        "Nebula couldn’t read this agent’s token because NEBULA_APP_TOKEN_FILE points to a file other users "
        "can read. Copy a new one from Settings › Connect your agent, then run this command.\n"
        "nebula mcp connect claude-code --channel")


def test_a_missing_token_file_fails_closed(token_file, monkeypatch):
    monkeypatch.setenv("NEBULA_APP_TOKEN_FILE", token_file + ".gone")
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.with_identity()
    assert refused.value.detail.startswith(
        "Nebula couldn’t read this agent’s token because NEBULA_APP_TOKEN_FILE points to a file that doesn’t exist. ")


@pytest.mark.parametrize("content,clause", [
    ("not a token", "points to a file that doesn’t hold a token"),
    ("x" * 5000, "points to a file too large to be a token"),
])
def test_each_token_file_reason_reads_as_a_clause(token_file, content, clause):
    with open(token_file, "w") as handle:
        handle.write(content)
    os.chmod(token_file, stat.S_IRUSR | stat.S_IWUSR)
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.with_identity()
    assert f"because NEBULA_APP_TOKEN_FILE {clause}. " in refused.value.detail


def test_a_reply_from_the_listening_sessions_own_shell_settles_its_message(thread):
    """Review 2 MEDIUM-2 / live M1: `nebula reply` from Claude's Bash has the
    token (J2) but the CLI's cursor session, not the MCP process's."""
    a = _listen(thread, SESSION_A)
    sent = _send(thread, a, "make it warmer").json()["row"]
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [sent["id"]]})
    shell = {**CLAUDE_TOKEN, "X-Nebula-Cursor-Session": "cc-0123456789abcdef"}
    reply = _reply(thread, "Done.", headers=shell)
    assert reply.status_code == 201 and reply.json()["reply"]["replyTo"] == sent["id"]
    row = next(r for r in _person_rows(thread) if r["kind"] == "reply")
    # The person's form names the session that took the message, so it
    # reads as the same "Claude Code" and clears its status.
    assert row["session"] == sent["to"]["session"] and row["agent"]["id"] == "app:claude1"
    # `nebula channel` from that shell sees the listener.
    seen = thread.client.get("/api/canvas/channel", headers=shell).json()["listeners"]
    assert [entry["listenerId"] for entry in seen] == [a]


def test_another_agents_reply_never_settles_the_message(thread):
    a = _listen(thread, SESSION_A)
    sent = _send(thread, a, "make it warmer").json()["row"]
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [sent["id"]]})
    assert _reply(thread, "not mine", headers=CODEX_TOKEN).json()["reply"]["replyTo"] is None


def test_the_cli_without_a_token_says_so_and_without_a_name_says_how(monkeypatch, capsys):
    from cli.commands import thread as thread_cmd

    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_APP_TOKEN_FILE", "NEBULA_AGENT_NAME"):
        monkeypatch.delenv(name, raising=False)

    class Client:
        def get_channel(self, agent_name=None):
            raise AssertionError("no request without a token")

        def get_thread(self, limit=20, agent_name=None):
            raise AssertionError("no request without a name")

    assert thread_cmd.run_channel(Client(), SimpleNamespace(json=False, agent_name="Claude Code")) == 0
    assert capsys.readouterr().out == thread_cmd.NO_TOKEN_CHANNEL_LINE + "\n"
    assert thread_cmd.run_thread(Client(), SimpleNamespace(limit=5, json=False, agent_name=None)) == 1
    assert capsys.readouterr().err == (
        "error: Nebula couldn’t show the thread because this agent has no name. Set NEBULA_AGENT_NAME or pass --as "
        "with a name, then read the thread again.\n")
    assert "'" not in thread_cmd.NO_TOKEN_CHANNEL_LINE and "(" not in thread_cmd.NO_TOKEN_CHANNEL_LINE


def test_the_cli_counts_characters_as_nebula_does(monkeypatch, capsys):
    """Parity NIT-3: an emoji family or a letter with its accent is one."""
    from cli.commands import thread as thread_cmd

    sent = []

    class Client:
        def reply_to_person(self, body, agent_name=None):
            sent.append(body)
            return {"reply": body}

    family = "\U0001F468‍\U0001F469‍\U0001F467" * 400
    accented = "é" * 1500
    for text in (family, accented):
        assert thread_cmd.run_reply(Client(), SimpleNamespace(text=text, node=None, json=False, agent_name=None)) == 0
    assert len(sent) == 2
    assert thread_cmd.run_reply(Client(), SimpleNamespace(text="é" * 2001, node=None, json=False,
                                                          agent_name=None)) == 1
    assert "2,001 characters" in capsys.readouterr().err


# -- the span ends on a reply under the listener's own token, by any route (2026-11-04) -----------

FILE_TOKEN = "nbl_app_" + "c" * 40  # the listening Claude's Settings token, in its token file


@pytest.fixture
def shell(thread, tmp_path, monkeypatch):
    """`nebula` from the listening Claude Code's own Bash: the token file its
    launch command named (the same token as its listener, app:claude1)."""
    from cli.client import NebulaClient
    from services import app_tokens
    from tests.test_person_thread import TOKENS

    known = {**TOKENS, FILE_TOKEN: TOKENS["tok-claude"]}
    monkeypatch.setattr(app_tokens, "lookup", lambda token: known.get(token))
    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_AGENT_TOKEN_FILE", "NEBULA_AGENT_NAME",
                 "NEBULA_AGENT_SESSION"):
        monkeypatch.delenv(name, raising=False)
    path = app_token_file.write(tmp_path / "shell-state", "claude1", FILE_TOKEN)
    monkeypatch.setenv("NEBULA_APP_TOKEN_FILE", str(path))
    monkeypatch.setattr(nebula_api, "_file_token", None)
    client = NebulaClient("http://testserver")
    client._client = thread.client
    return client


def _cli_reply(client, text="Done."):
    from cli.commands import thread as thread_cmd

    try:
        return thread_cmd.run_reply(client, SimpleNamespace(text=text, node=None, json=False, agent_name=None))
    except SystemExit as exc:  # the CLI's refusal: `error: <detail>`, exit 1
        return exc.code


def _feed(thread, state, now):
    """One long-poll answer as the listener asks for it (ownReplies=1)."""
    params = {"wait": 0, "ownReplies": 1, "after": state.cursor if state.cursor is not None else 0}
    if state.journal:
        params["journal"] = state.journal
    answer = thread.client.get("/api/canvas/events", params=params, headers=SESSION_A)
    assert answer.status_code == 200, answer.text
    state.observe(answer.json(), now)


def _spanning(thread):
    """A listener on SESSION_A, the person's message pushed to it: its
    deliberate span is open until its reply (or the cap)."""
    from tests.test_mcp_channel import take

    listener = thread.client.post("/api/agent/channel", headers=SESSION_A,
                                  json={"state": "listening"}).json()["listener"]
    state = mcp_channel.ChannelState(now=0.0)
    state.listener_id, state.agent_id = listener["listenerId"], listener["agent"]["id"]
    _feed(thread, state, 1.0)  # what came before
    _send(thread, state.listener_id, "make it warmer")
    _feed(thread, state, 100.0)
    assert state.inbox_to_fetch()
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()
    assert state.messages_fetched(inbox["messages"]) == 1
    push = take(state, 100.0)
    assert push.wake == "message"
    # The listener marks what it pushed as taken (Listener._accept): a reply
    # then names it (replyTo), which is what ends the span (round 5, D1).
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": push.message_ids})
    assert state._reply_due_at is not None
    return state


def test_a_cli_reply_under_the_listeners_token_ends_its_span(shell, thread):
    state = _spanning(thread)
    assert _cli_reply(shell) == 0
    _feed(thread, state, 150.0)
    assert state._reply_due_at is None and state.last_call == 150.0


def test_a_refused_cli_reply_never_ends_the_span(shell, thread, monkeypatch, capsys):
    state = _spanning(thread)
    # Paced: its five in a row spent on a clock that doesn't move, the CLI's
    # sixth is refused (429), never saved, never journaled.
    for _ in range(5):
        assert thread.main.thread_reply_pace.take("app:claude1") == 0
    assert _cli_reply(shell) == 1
    assert "replies are paced" in capsys.readouterr().err
    _feed(thread, state, 150.0)
    assert state._reply_due_at is not None
    # No token (no file, a name only): refused, 401 reply_no_token.
    monkeypatch.delenv("NEBULA_APP_TOKEN_FILE")
    monkeypatch.setenv("NEBULA_AGENT_NAME", "Claude Code")
    assert _cli_reply(shell) == 1
    assert "because this agent has no token" in capsys.readouterr().err
    _feed(thread, state, 160.0)
    assert state._reply_due_at is not None
    assert not [e for e in thread.journal._events if e["kind"] == person_thread.REPLY_EVENT]


def test_another_tokens_reply_never_ends_the_span(shell, thread):
    state = _spanning(thread)
    assert _reply(thread, "Codex here.", headers=CODEX_TOKEN).status_code == 201
    _feed(thread, state, 150.0)
    assert state._reply_due_at is not None
    # Its own reply still does, after it.
    assert _cli_reply(shell) == 0
    _feed(thread, state, 160.0)
    assert state._reply_due_at is None


def test_a_narrowed_thread_still_journals_the_replys_id(shell, thread, monkeypatch):
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", False)
    state = _spanning(thread)
    assert _cli_reply(shell) == 0
    replied = [e for e in thread.journal._events if e["kind"] == person_thread.REPLY_EVENT]
    assert len(replied) == 1 and set(replied[0]["data"]) == {"replyId", "replyTo"}  # never a session or listener
    _feed(thread, state, 150.0)
    assert state._reply_due_at is None


# -- boundary LOW-1: revoke settles the messages in flight --------------------------------------

def test_revoking_a_listeners_token_settles_its_messages_in_flight(thread, monkeypatch):
    from services import app_tokens
    monkeypatch.setattr(app_tokens, "valid_id", lambda app_id: app_id.isalnum())
    monkeypatch.setattr(thread.main.app_token_store, "revoke", lambda app_id: app_id == "claude1")
    a = _listen(thread, SESSION_A)
    codex = _listen(thread, CODEX_TOKEN)
    taken = _send(thread, a, "taken").json()["row"]
    thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [taken["id"]]})
    stranded = _send(thread, a, "after the revoke").json()["row"]
    other = _send(thread, codex, "for codex").json()["row"]
    assert thread.client.delete("/api/agent/spend/apps/claude1", headers=PERSON).status_code == 200
    states = {row["id"]: row["state"] for row in _person_rows(thread) if row["kind"] == "message"}
    assert states == {taken["id"]: "accepted", stranded["id"]: person_thread.DROPPED_STATE, other["id"]: "sent"}
    told = [row for m in thread.sent + thread.browser if m.get("type") == "personThread"
            for row in m.get("rows") or [] if row["id"] == stranded["id"]]
    assert told and told[-1]["state"] == "dropped"
    # A send to it now is refused as stopped, at once.
    assert _send(thread, a, "too late").status_code == 409


# -- boundary LOW-2: the inbox across projects, and re-armed --------------------------------------

def test_a_message_sent_before_a_project_switch_still_reaches_its_listener(thread):
    a = _listen(thread, SESSION_A)
    sent = _send(thread, a, "in the first project").json()["row"]
    other = thread.client.post("/api/projects", headers=PERSON, json={"name": "Second"})
    assert other.status_code in (200, 201), other.text
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()
    assert inbox["projectId"] != thread.project_id
    assert [(m["messageId"], m["projectId"]) for m in inbox["messages"]] == [(sent["id"], thread.project_id)]
    accepted = thread.client.post("/api/agent/thread/accepted", headers=SESSION_A, json={"messageIds": [sent["id"]]})
    assert accepted.json()["accepted"] == [sent["id"]]
    assert thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()["messages"] == []


@pytest.mark.parametrize("lost", ["gap", "reset"])
def test_lost_events_re_arm_the_inbox(lost):
    state = mcp_channel.ChannelState(now=0.0)
    state.listener_id = "ch_0123456789abcdef"
    state.observe({**resp(), lost: True}, now=1.0)
    assert state.inbox_to_fetch() and not state.inbox_to_fetch()
    # Without a listener id there is no inbox to read.
    fresh = mcp_channel.ChannelState(now=0.0)
    fresh.observe({**resp(), lost: True}, now=1.0)
    assert not fresh.inbox_to_fetch()


def test_a_failed_inbox_read_is_tried_again_at_the_next_decision():
    state = mcp_channel.ChannelState(now=0.0)
    calls = []

    async def failing():
        calls.append(1)
        raise OSError("down")

    async def no_sleep(_seconds):
        return None

    async def nothing(*_a, **_k):
        return {}

    listener = mcp_channel.Listener(state, fetch_events=nothing, fetch_run=nothing, push=nothing,
                                    fetch_pins=nothing, clock=lambda: 0.0, log=lambda _line: None,
                                    sleep=no_sleep, fetch_inbox=failing)
    anyio.run(listener._read_inbox)
    assert len(calls) == mcp_channel.INBOX_TRIES and state.inbox_to_fetch()
