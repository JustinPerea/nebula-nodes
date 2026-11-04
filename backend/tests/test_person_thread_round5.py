"""The Message box thread, round 5 (review 3 of #223/#225; coordinator D1-D3, GM r100).

- D1: a reply's event names the message it answers (``replyTo``, both forms)
  and never a session or a listener id.
- D2: Claude Code's shell shares its listener's session (the launch command
  sets NEBULA_AGENT_SESSION per launch), so `nebula reply` answers that
  session's message, takes its label and flies its cursor. A terminal that
  is no listening session answers the agent's one fresh listener; with two
  or more, Nebula won't guess (replyTo None, and a note says why).
- GM r100.3: a reply goes to the thread of the message it answers, with an
  Update on the open project naming it ("Claude Code replied in “Coast”."),
  whose Open opens that thread; no message and no project: r100's line.
- `nebula pin resolve` from the session's shell ends that pin's span.
- Rows carry ``rev`` (review 3 LOW-4), and the review 3 survivors B6, B7, B13.
"""
from __future__ import annotations

import os
import re
import stat

import pytest

import mcp_channel
import nebula_api
from services import agent_token_file, channel_listeners, person_thread
from services.cursor_actions import SESSION_RE
from services.project_store import ProjectStoreError, make_project
from tests.conftest import PERSON
from tests.test_canvas_proposals import CLAUDE, Clock, api  # noqa: F401 - fixture
from tests.test_person_thread import CLAUDE_TOKEN, CODEX_TOKEN, SESSION_A, SESSION_B, _listen, _send, thread  # noqa: F401
from tests.test_person_thread_round3 import _person_rows, _reply, paced  # noqa: F401 - fixture


def _accept(thread, headers, row):
    answer = thread.client.post("/api/agent/thread/accepted", headers=headers, json={"messageIds": [row["id"]]})
    assert answer.status_code == 200, answer.text


def _new_project(thread, name: str) -> str:
    store = thread.main.project_store
    with store.transaction() as catalog:
        project = make_project(name)
        catalog["projects"][project["id"]] = project
        store.commit(catalog)
    return project["id"]


def _open(thread, project_id: str | None) -> None:
    store = thread.main.project_store
    with store.transaction() as catalog:
        catalog["activeProjectId"] = project_id
        store.commit(catalog)


def _rows_of(thread, project_id: str) -> list[dict]:
    return thread.main.thread_book.rows(project_id)[1]


def _notes_of(thread, project_id: str) -> list[dict]:
    catalog = thread.main.project_store.read()
    return list(catalog["projects"][project_id].get("agentNotes") or [])


# -- GM r100.3: the reply goes where its message is -------------------------------------------

@pytest.mark.parametrize("way", ["first to second", "second to first"])
def test_a_reply_after_a_project_switch_goes_to_its_messages_thread_both_ways(thread, way):
    first = thread.project_id
    coast = _new_project(thread, "Coast")
    sent_in, opened = (first, coast) if way == "first to second" else (coast, first)
    _open(thread, sent_in)
    a = _listen(thread, SESSION_A)
    message = _send(thread, a, "make the sky warmer").json()["row"]
    _accept(thread, SESSION_A, message)
    _open(thread, opened)  # the person (or Claude's new_project) opened the other one
    answer = _reply(thread, "Done.", headers=SESSION_A)
    assert answer.status_code == 201, answer.text
    assert answer.json()["projectId"] == sent_in and answer.json()["reply"]["replyTo"] == message["id"]
    assert [row["id"] for row in _rows_of(thread, sent_in) if row["kind"] == "reply"] == [
        answer.json()["reply"]["id"]]
    assert not [row for row in _rows_of(thread, opened) if row["kind"] == "reply"]
    # The Update, on the project open now, names the reply's project; its Open opens that thread.
    name = thread.main.project_store.read()["projects"][sent_in]["name"]
    notes = _notes_of(thread, opened)
    assert [note["text"] for note in notes] == [f"Claude Code replied in “{name}”."]
    assert notes[0]["actions"] == [{"label": "Open", "op": {"kind": "thread.open", "projectId": sent_in,
                                                            "replyId": answer.json()["reply"]["id"]}}]
    assert notes[0]["source"] == "nebula" and notes[0]["author"]["id"] == "app:claude1"
    # The person's tabs hear the row with its own project, and the Update.
    told = [m for m in thread.browser if m.get("type") == "personThread" and m.get("change") == "rows"]
    assert told[-1]["projectId"] == sent_in
    assert any(m.get("type") == "agentNotes" and m.get("op") == "added" for m in thread.sent)


def test_a_reply_saved_in_another_project_keeps_no_node_of_the_open_canvas(thread):
    # The node is on the other project's canvas, not the open one: it is
    # ignored (review 4; GM r108 b: no cursor flies, the Update is the signal).
    first = thread.project_id
    coast = _new_project(thread, "Coast")
    a = _listen(thread, SESSION_A)
    message = _send(thread, a).json()["row"]
    _accept(thread, SESSION_A, message)
    _open(thread, coast)
    n1 = thread.main.cli_graph.add_node("text-input", {"value": "a"})
    answer = _reply(thread, "Warmer now.", headers=SESSION_A, nodeId=n1)
    assert answer.status_code == 201, answer.text
    assert answer.json()["projectId"] == first
    assert [row["nodeId"] for row in _rows_of(thread, first) if row["kind"] == "reply"] == [None]


def test_a_reply_in_the_open_project_posts_no_update(thread):
    a = _listen(thread, SESSION_A)
    message = _send(thread, a).json()["row"]
    _accept(thread, SESSION_A, message)
    assert _reply(thread, "Done.", headers=SESSION_A).json()["projectId"] == thread.project_id
    assert _notes_of(thread, thread.project_id) == []


def test_the_oldest_open_push_is_answered_first_across_projects(thread):
    # Review 4 (the push ledger): oldest first follows the order Claude
    # answers its queued pushes in.
    coast = _new_project(thread, "Coast")
    a = _listen(thread, SESSION_A)
    older = _send(thread, a, "first").json()["row"]
    _accept(thread, SESSION_A, older)
    _open(thread, coast)
    newer = _send(thread, a, "second").json()["row"]
    _accept(thread, SESSION_A, newer)
    _open(thread, thread.project_id)
    answer = _reply(thread, "Done.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] == older["id"] and answer["projectId"] == thread.project_id
    answer = _reply(thread, "Done too.", headers=SESSION_A).json()
    assert answer["reply"]["replyTo"] == newer["id"] and answer["projectId"] == coast


def test_no_message_and_no_project_open_is_refused_with_r100s_line(paced):
    _open(paced, None)
    refused = _reply(paced, "Done.", headers=CLAUDE_TOKEN)
    assert refused.status_code == 409 and refused.json()["code"] == "no_project"
    assert refused.json()["detail"] == ("Nebula couldn’t post this reply because no project is open. Open one with "
                                        "open_project, then reply again.")
    # Never spent the pace (it was refunded): a full burst still goes once one is open.
    _open(paced, paced.project_id)
    assert [_reply(paced, f"t{n}", headers=CLAUDE_TOKEN).status_code for n in range(6)] == [201] * 5 + [429]


def test_a_store_error_refunds_the_pace(paced, monkeypatch):
    # Review 3 LOW-6 B6.
    real = paced.main.thread_book.add_reply

    def broken(*a, **k):
        raise ProjectStoreError("Project storage is unavailable")

    monkeypatch.setattr(paced.main.thread_book, "add_reply", broken)
    assert {_reply(paced, f"r{n}", headers=CLAUDE_TOKEN).status_code for n in range(7)} == {503}
    monkeypatch.setattr(paced.main.thread_book, "add_reply", real)
    assert [_reply(paced, f"t{n}", headers=CLAUDE_TOKEN).status_code for n in range(6)] == [201] * 5 + [429]


# -- D1: the event names the message, never a session -------------------------------------------

@pytest.mark.parametrize("whole", [True, False])
def test_the_reply_event_names_the_message_and_never_a_session_or_listener(thread, monkeypatch, whole):
    monkeypatch.setattr(person_thread, "AGENTS_READ_WHOLE_THREAD", whole)
    a = _listen(thread, SESSION_A)
    message = _send(thread, a).json()["row"]
    _accept(thread, SESSION_A, message)
    assert _reply(thread, "Done.", headers=SESSION_A).status_code == 201
    event = [e for e in thread.journal._events if e["kind"] == person_thread.REPLY_EVENT][-1]
    assert event["data"]["replyTo"] == message["id"]
    text = str(event)
    assert a not in text and "sess-a" not in text and "session" not in event["data"]


# -- D2: the shell is its listener's session ------------------------------------------------------

def test_two_sessions_on_one_token_each_shell_answers_its_own_message(thread):
    # Review 3 MEDIUM-1: two Claude Code sessions under one Settings token.
    a, b = _listen(thread, SESSION_A), _listen(thread, SESSION_B)
    to_a = _send(thread, a, "for a").json()["row"]
    _accept(thread, SESSION_A, to_a)
    to_b = _send(thread, b, "for b").json()["row"]
    _accept(thread, SESSION_B, to_b)
    # A's shell: the launch command gave it A's session (NEBULA_AGENT_SESSION).
    shell_a = {**CLAUDE_TOKEN, "X-Nebula-Agent-Session": "sess-a"}
    answer = _reply(thread, "Done for A.", headers=shell_a)
    assert answer.status_code == 201 and answer.json()["reply"]["replyTo"] == to_a["id"]
    assert "note" not in answer.json()
    row = next(r for r in _person_rows(thread) if r["kind"] == "reply")
    assert row["session"] == to_a["to"]["session"] != to_b["to"]["session"]  # A's label, not "· 2"


def test_a_shell_reply_flies_the_listening_sessions_cursor(thread):
    # GM r100.1: one Claude is one cursor. A terminal that isn't a listening
    # session (its own cursor session) answering the one fresh listener
    # flies that listener's cursor, never a "Claude Code · 2".
    n1 = thread.main.cli_graph.add_node("text-input", {"value": "a"})
    a = _listen(thread, SESSION_A)
    message = _send(thread, a).json()["row"]
    _accept(thread, SESSION_A, message)
    shell = {**CLAUDE_TOKEN, "X-Nebula-Cursor-Session": "cc-0123456789abcdef"}
    assert _reply(thread, "Warmer now.", headers=shell, nodeId=n1).status_code == 201
    cursor = [m for m in thread.sent if m.get("type") == "agentPresence"][-1]
    assert cursor["session"]["key"] == message["to"]["session"]["key"]


def test_with_two_fresh_listeners_a_stray_terminal_isnt_guessed(thread):
    a, b = _listen(thread, SESSION_A), _listen(thread, SESSION_B)
    for listener, headers in ((a, SESSION_A), (b, SESSION_B)):
        _accept(thread, headers, _send(thread, listener).json()["row"])
    stray = {**CLAUDE_TOKEN, "X-Nebula-Cursor-Session": "cc-0123456789abcdef"}
    answer = _reply(thread, "Which one?", headers=stray)
    assert answer.status_code == 201 and answer.json()["reply"]["replyTo"] is None
    assert answer.json()["note"] == person_thread.reply_unmatched_line("Claude Code", 2)
    assert answer.json()["note"] == (
        "Nebula posted this reply but couldn’t tell which message it answers because 2 Claude Code sessions are "
        "listening and this terminal isn’t one of them. Reply from the Claude Code the person messaged. To stop "
        "this, start each Claude Code with this command, which gives it its own session that its terminals share.\n"
        "nebula mcp connect claude-code --channel")  # GM r108, string 3


def test_a_crashed_sessions_leftover_never_blocks_the_answer(thread):
    a = _listen(thread, SESSION_A)
    _accept(thread, SESSION_A, _send(thread, a, "old").json()["row"])
    thread.channel_clock.now += channel_listeners.FRESH_SECONDS + 1  # A crashed; its entry lives on a while
    b = _listen(thread, SESSION_B)
    to_b = _send(thread, b, "new").json()["row"]
    _accept(thread, SESSION_B, to_b)
    stray = {**CLAUDE_TOKEN, "X-Nebula-Cursor-Session": "cc-0123456789abcdef"}
    answer = _reply(thread, "Done.", headers=stray).json()
    assert answer["reply"]["replyTo"] == to_b["id"] and "note" not in answer


def test_the_launch_command_makes_a_session_id_per_launch():
    # Review 4 (all three lenses): no uuidgen (Debian/Ubuntu ship it apart,
    # and without it every launch was the bare session "cc-"). POSIX only:
    # the shell's clock and its own process id, at each launch.
    from cli.commands import mcp_connect

    command = mcp_connect.launch_command(mcp_connect.Path("/tmp/listen.json"), "/state/app.token")
    assert command.startswith('NEBULA_APP_TOKEN_FILE=/state/app.token NEBULA_AGENT_SESSION="cc-$(date +%s)-$$" '
                              'claude ')
    assert "uuidgen" not in command
    assert 'NEBULA_AGENT_SESSION="cc-$(date +%s)-$$" claude ' in mcp_connect.launch_command(
        mcp_connect.Path("/tmp/listen.json"))


def test_the_printed_session_is_new_at_each_launch_with_posix_tools_only():
    # Run as a shell runs it, with a PATH that has no uuidgen: two launches
    # (two shells, as two terminals) give two sessions, neither a bare "cc-".
    import subprocess

    from cli.commands import mcp_connect

    script = f'{mcp_connect.SESSION_ASSIGNMENT} /bin/sh -c \'printf %s "$NEBULA_AGENT_SESSION"\''
    made = [subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True, timeout=10,
                           env={"PATH": "/bin:/usr/bin"}).stdout for _ in range(2)]
    assert made[0] != made[1]
    for session in made:
        assert re.fullmatch(r"cc-\d{9,}-\d+", session), session
        assert SESSION_RE.fullmatch(session)


# -- `nebula pin resolve` from the session's shell ends its pin's span ---------------------------

def _pin(thread) -> str:
    node = thread.main.cli_graph.add_node("text-input", {})
    made = thread.client.post("/api/canvas/pins", headers=PERSON, json={"text": "warmer", "nodeId": node})
    assert made.status_code == 201, made.text
    return made.json()["pin"]["id"]


def _feed(thread, state, now, headers):
    params = {"wait": 0, "ownReplies": 1, "after": state.cursor if state.cursor is not None else 0}
    answer = thread.client.get("/api/canvas/events", params=params, headers=headers)
    assert answer.status_code == 200, answer.text
    state.observe(answer.json(), now)


def _pin_span(thread, headers):
    from tests.test_mcp_channel import drain

    listener = thread.client.post("/api/agent/channel", headers=headers, json={"state": "listening"}).json()
    state = mcp_channel.ChannelState(now=0.0)
    state.listener_id, state.agent_id = listener["listener"]["listenerId"], listener["listener"]["agent"]["id"]
    return state, drain


def test_a_shell_pin_answer_ends_only_its_own_sessions_pin_span(thread):
    a_state, drain = _pin_span(thread, SESSION_A)
    b_state, _ = _pin_span(thread, SESSION_B)
    _feed(thread, a_state, 1.0, SESSION_A)
    _feed(thread, b_state, 1.0, SESSION_B)
    pin_id = _pin(thread)
    for state, headers in ((a_state, SESSION_A), (b_state, SESSION_B)):
        _feed(thread, state, 100.0, headers)
        assert [p.wake for _, p in drain(state, 100.0, 101.0)] == ["pin"]
        assert state._reply_due_at is not None
    # A's shell answers the pin (`nebula pin resolve`, A's session).
    assert thread.client.post(f"/api/canvas/pins/{pin_id}/resolve", headers=SESSION_A,
                              json={"reply": "Warmer now."}).status_code == 200
    _feed(thread, a_state, 150.0, SESSION_A)
    _feed(thread, b_state, 150.0, SESSION_B)
    assert a_state._reply_due_at is None and a_state.last_call == 150.0
    assert b_state._reply_due_at is not None  # a sibling's answer never ends B's


# -- channel_status and `nebula channel` agree for a tokenless caller (NIT-2) ----------------------

def test_channel_status_without_a_token_says_what_nebula_channel_says(monkeypatch):
    import mcp_server

    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_APP_TOKEN_FILE", "NEBULA_AGENT_TOKEN_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(mcp_server, "_canvas_call", lambda *a, **k: pytest.fail("no request without a token"))
    seen = mcp_server.channel_status()
    assert seen["token"] is False and seen["listeners"] is None
    assert seen["detail"] == channel_listeners.NO_TOKEN_STATUS_LINE
    assert seen["detail"].endswith("\nnebula mcp connect claude-code --channel")


# -- LOW-4: every change to a row raises its rev -------------------------------------------------

def test_rows_carry_a_rev_that_each_change_raises(thread):
    a = _listen(thread, SESSION_A)
    message = _send(thread, a).json()["row"]
    assert message["rev"] == 1
    _accept(thread, SESSION_A, message)
    taken = next(r for r in _person_rows(thread) if r["id"] == message["id"])
    assert taken["state"] == "accepted" and taken["rev"] == 2
    reply = _reply(thread, "Done.", headers=SESSION_A).json()["reply"]
    assert reply["rev"] == 1


# -- review 3 LOW-6: B7 (the inbox's open project first) and B13 (token-file clauses) -------------

def test_the_inbox_lists_the_open_projects_messages_first(thread):
    coast = _new_project(thread, "Coast")
    a = _listen(thread, SESSION_A)
    _open(thread, coast)
    in_coast = _send(thread, a, "in coast").json()["row"]
    _open(thread, thread.project_id)
    here = _send(thread, a, "here").json()["row"]
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()
    assert [m["messageId"] for m in inbox["messages"]] == [here["id"], in_coast["id"]]
    _open(thread, coast)
    inbox = thread.client.get("/api/agent/thread/inbox", headers=SESSION_A).json()
    assert [m["messageId"] for m in inbox["messages"]] == [in_coast["id"], here["id"]]


@pytest.fixture
def token_path(tmp_path, monkeypatch):
    for name in ("NEBULA_AGENT_TOKEN", "NEBULA_APP_TOKEN", "NEBULA_AGENT_TOKEN_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(nebula_api, "_file_token", None)
    return tmp_path


def _clause(monkeypatch, path) -> str:
    monkeypatch.setenv("NEBULA_APP_TOKEN_FILE", str(path))
    with pytest.raises(nebula_api.NebulaAPIError) as refused:
        nebula_api.with_identity()
    match = re.match(r"Nebula couldn’t read this agent’s token because NEBULA_APP_TOKEN_FILE (.+)\. Copy a new one "
                     r"from Settings › Connect your agent, then run this command\.\nnebula mcp connect claude-code "
                     r"--channel$", refused.value.detail)
    assert match, refused.value.detail
    return match.group(1)


def test_each_token_file_clause_is_gm_r97s(token_path, monkeypatch):
    folder = token_path / "a-folder"
    folder.mkdir()
    assert _clause(monkeypatch, folder) == "points to something that isn’t a regular file"
    good = token_path / "good.token"
    good.write_text("nbl_app_" + "a" * 40)
    os.chmod(good, stat.S_IRUSR | stat.S_IWUSR)
    link = token_path / "link.token"
    link.symlink_to(good)
    assert _clause(monkeypatch, link) == "points to a file Nebula can’t open"
    real_uid = os.getuid()
    monkeypatch.setattr(agent_token_file.os, "getuid", lambda: real_uid + 1)
    assert _clause(monkeypatch, good) == "points to a file that belongs to another user"
    monkeypatch.setattr(agent_token_file.os, "getuid", lambda: real_uid)

    def unreadable(fd, n):
        raise OSError(5, "Input/output error")

    monkeypatch.setattr(agent_token_file.os, "read", unreadable)
    assert _clause(monkeypatch, good) == "points to a file Nebula can’t read"
