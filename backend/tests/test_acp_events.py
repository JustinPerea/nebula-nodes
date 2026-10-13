"""map_session_update: every ACP update kind onto Nebula chat events."""
from __future__ import annotations

from services.acp_events import (
    MAX_PLAN_ENTRIES, MAX_TEXT_CHUNK_CHARS, MAX_TOOL_RESULT_CHARS, MAX_TURN_TEXT_CHARS, TEXT_CUT_NOTICE,
    ToolCallState, TurnTextBudget, make_redactor, map_session_update,
)

TOKEN = "secret-session-token-abcdef"
redact = make_redactor(TOKEN)


def run(update, state=None):
    return map_session_update(update, state or ToolCallState(), redact=redact)


def text(t):
    return {"type": "text", "text": t}


def test_message_and_thought_chunks():
    assert run({"sessionUpdate": "agent_message_chunk", "content": text("hi")}) == [{"type": "text", "text": "hi"}]
    assert run({"sessionUpdate": "agent_thought_chunk", "content": text("hmm")}) == [{"type": "thought", "text": "hmm"}]
    assert run({"sessionUpdate": "agent_message_chunk", "content": {"type": "image", "data": "x"}}) == [text("[image]")]
    link = {"type": "resource_link", "name": "spec", "uri": "https://example.com/a"}
    assert run({"sessionUpdate": "agent_message_chunk", "content": link}) == [text("[spec](https://example.com/a)")]


def test_tool_call_lifecycle_reports_once():
    state = ToolCallState()
    first = run({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Read", "kind": "read",
                 "status": "pending", "rawInput": {"path": "a"}}, state)
    assert first == [{"type": "tool_use", "toolUseId": "t1", "tool": "Read", "title": "Read", "kind": "read",
                      "input": {"path": "a"}}]
    assert run({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress"}, state) == []
    done = run({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed",
                "content": [{"type": "content", "content": text("boom")}, {"type": "diff", "path": "/x", "newText": ""}]},
               state)
    assert done == [{"type": "tool_result", "toolUseId": "t1", "content": "boom\n[diff /x]", "isError": True}]
    assert run({"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed"}, state) == []


def test_completed_on_first_report_and_unknown_update_id():
    events = run({"sessionUpdate": "tool_call", "toolCallId": "t2", "name": "find_nodes", "title": "Find",
                  "status": "completed", "rawOutput": {"n": 1}})
    assert [e["type"] for e in events] == ["tool_use", "tool_result"]
    assert events[0]["tool"] == "find_nodes" and events[1]["content"] == '{"n": 1}'
    late = run({"sessionUpdate": "tool_call_update", "toolCallId": "unknown", "status": "completed"})
    assert [e["type"] for e in late] == ["tool_use", "tool_result"]


def test_plan_replaces_and_is_capped():
    entries = [{"content": "x" * 900, "priority": "bogus", "status": "weird"}] * (MAX_PLAN_ENTRIES + 5)
    [event] = run({"sessionUpdate": "plan", "entries": entries})
    assert event["type"] == "plan" and len(event["entries"]) == MAX_PLAN_ENTRIES
    assert event["entries"][0] == {"content": "x" * 500, "priority": "medium", "status": "pending"}


def test_redaction_and_caps():
    leaked = run({"sessionUpdate": "agent_message_chunk", "content": text(f"token={TOKEN}")})
    assert leaked == [text("token=***")]
    state = ToolCallState()
    run({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "x", "rawInput": {"env": TOKEN}}, state)[0]
    use = state.calls["t"]
    assert use.raw_input == {"env": TOKEN}  # state keeps the raw value; events never carry it
    events = run({"sessionUpdate": "tool_call", "toolCallId": "u", "title": "x", "rawInput": {"env": TOKEN}})
    assert events[0]["input"] == {"env": "***"}
    big = run({"sessionUpdate": "tool_call", "toolCallId": "b", "title": "x", "status": "completed",
               "content": [{"type": "content", "content": text("y" * (MAX_TOOL_RESULT_CHARS + 100))}]})
    assert len(big[1]["content"]) < MAX_TOOL_RESULT_CHARS + 100


def test_dropped_kinds():
    for kind in ["user_message_chunk", "usage_update", "available_commands_update", "current_mode_update",
                 "config_option_update", "session_info_update", "notice", "something_new"]:
        assert run({"sessionUpdate": kind, "content": text("x")}) == []
    assert run("not a dict") == []


NOTICE = {"type": "system", "text": TEXT_CUT_NOTICE}


def test_a_huge_chunk_is_capped_with_one_notice():
    # A 50 MB chunk fits in one ACP line but would freeze the chat tab.
    for kind, event_type in (("agent_message_chunk", "text"), ("agent_thought_chunk", "thought")):
        events = run({"sessionUpdate": kind, "content": text("z" * 5_000_000)})
        assert events == [{"type": event_type, "text": "z" * MAX_TEXT_CHUNK_CHARS}, NOTICE]


def test_redaction_happens_before_the_cap():
    # Capping first could cut the token in half and show its first part.
    head = "a" * (MAX_TEXT_CHUNK_CHARS - 5)
    [event, notice] = run({"sessionUpdate": "agent_message_chunk", "content": text(head + TOKEN + "b" * 100)})
    assert TOKEN[:5] not in event["text"] and event["text"].endswith("***" + "b" * 2)
    assert notice == NOTICE


def test_turn_budget_caps_the_running_total_and_notices_once():
    budget, state = TurnTextBudget(), ToolCallState()
    chunk = "c" * MAX_TEXT_CHUNK_CHARS
    shown, notices = 0, 0
    for i in range(MAX_TURN_TEXT_CHARS // MAX_TEXT_CHUNK_CHARS + 5):
        kind = "agent_thought_chunk" if i % 2 else "agent_message_chunk"
        for event in map_session_update({"sessionUpdate": kind, "content": text(chunk)}, state,
                                        redact=redact, budget=budget):
            if event["type"] == "system":
                notices += 1
            else:
                shown += len(event["text"])
    assert shown == MAX_TURN_TEXT_CHARS and notices == 1
    assert map_session_update({"sessionUpdate": "agent_message_chunk", "content": text("more")}, state,
                              redact=redact, budget=budget) == []
    # Small replies are untouched.
    fresh = TurnTextBudget()
    assert map_session_update({"sessionUpdate": "agent_message_chunk", "content": text("hi")}, state,
                              redact=redact, budget=fresh) == [{"type": "text", "text": "hi"}]
