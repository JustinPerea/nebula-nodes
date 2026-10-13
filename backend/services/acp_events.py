"""Map ACP ``session/update`` notifications onto Nebula's chat events.

Pure functions, so every mapping is unit-testable without an agent. The chat
panel already knows ``text``, ``tool_use`` and ``tool_result`` (the Claude
and Codex runners emit them); ACP adds ``thought`` and ``plan``.

Everything forwarded goes through ``redact`` first, which hides the session's
Nebula token if the agent ever echoes it back (in a tool input, say), and is
then capped: message and thought text per chunk and per turn
(``TurnTextBudget``), tool inputs, results, titles and plan entries each.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

MAX_TOOL_RESULT_CHARS = 20_000
MAX_TOOL_INPUT_CHARS = 4_000
MAX_PLAN_ENTRIES = 50
MAX_PLAN_ENTRY_CHARS = 500
MAX_TITLE_CHARS = 200
# Message and thought text: one chunk, and everything one turn sends. An agent
# that streams more would freeze the chat tab.
MAX_TEXT_CHUNK_CHARS = 20_000
MAX_TURN_TEXT_CHARS = 200_000
TEXT_CUT_NOTICE = "This reply was too long to show in full, so Nebula cut some of it."
_PLAN_PRIORITIES = {"high", "medium", "low"}
_PLAN_STATUSES = {"pending", "in_progress", "completed"}

Redact = Callable[[str], str]


def make_redactor(*secrets: str | None) -> Redact:
    """Replace each non-empty secret with *** in a string."""
    values = [s for s in secrets if isinstance(s, str) and len(s) >= 8]

    def redact(text: str) -> str:
        if not isinstance(text, str):
            return text
        for value in values:
            text = text.replace(value, "***")
        return text

    return redact


def redact_value(value: Any, redact: Redact) -> Any:
    """Redact every string inside a JSON value."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_value(item, redact) for item in value]
    if isinstance(value, dict):
        return {redact(str(k)): redact_value(v, redact) for k, v in value.items()}
    return value


def _cap(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… ({len(text) - limit} more characters)"


def capped_json(value: Any, limit: int, redact: Redact) -> Any:
    """The value redacted, or a capped JSON string of it when it's too large."""
    cleaned = redact_value(value, redact)
    try:
        encoded = json.dumps(cleaned, ensure_ascii=False)
    except (TypeError, ValueError):
        return _cap(str(cleaned), limit)
    if len(encoded) <= limit:
        return cleaned
    return _cap(encoded, limit)


def content_block_text(block: Any) -> str:
    """Text for one ACP ContentBlock. Images and audio become placeholders."""
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return str(block.get("text") or "")
    if kind == "image":
        return "[image]"
    if kind == "audio":
        return "[audio]"
    if kind == "resource_link":
        name = str(block.get("name") or block.get("title") or block.get("uri") or "link")
        return f"[{name}]({block.get('uri') or ''})"
    if kind == "resource":
        resource = block.get("resource") if isinstance(block.get("resource"), dict) else {}
        if isinstance(resource.get("text"), str):
            return resource["text"]
        return f"[resource {resource.get('uri') or ''}]".strip()
    return ""


def _tool_content_text(content: Any) -> str:
    """Flatten ToolCallContent[] into text."""
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "content":
            text = content_block_text(item.get("content"))
            if text:
                parts.append(text)
        elif kind == "diff":
            parts.append(f"[diff {item.get('path') or ''}]")
        elif kind == "terminal":
            parts.append("[terminal]")
    return "\n".join(parts)


@dataclass
class TurnTextBudget:
    """How much message and thought text one turn may still send, and
    whether the turn has shown the cut notice yet (it shows it once)."""
    left: int = field(default_factory=lambda: MAX_TURN_TEXT_CHARS)
    noticed: bool = False


def _text_events(kind: str, text: str, redact: Redact, budget: TurnTextBudget | None) -> list[dict[str, Any]]:
    """Redact, then cap: a cut never leaves part of a secret behind."""
    text = redact(text)
    cut = False
    if len(text) > MAX_TEXT_CHUNK_CHARS:
        text, cut = text[:MAX_TEXT_CHUNK_CHARS], True
    if budget is not None:
        if len(text) > budget.left:
            text, cut = text[:budget.left], True
        budget.left -= len(text)
    events: list[dict[str, Any]] = [{"type": kind, "text": text}] if text else []
    if cut and (budget is None or not budget.noticed):
        if budget is not None:
            budget.noticed = True
        events.append({"type": "system", "text": TEXT_CUT_NOTICE})
    return events


@dataclass
class _ToolCall:
    reported_use: bool = False
    reported_result: bool = False
    title: str = ""
    kind: str = "other"
    name: str | None = None
    raw_input: Any = None
    raw_output: Any = None
    content: list = field(default_factory=list)
    status: str = "pending"


class ToolCallState:
    """Per-session tool calls by toolCallId, so updates can be merged."""

    MAX_CALLS = 2000

    def __init__(self) -> None:
        self.calls: dict[str, _ToolCall] = {}

    def get(self, tool_call_id: str) -> _ToolCall:
        call = self.calls.get(tool_call_id)
        if call is None:
            if len(self.calls) >= self.MAX_CALLS:
                self.calls.pop(next(iter(self.calls)))
            call = _ToolCall()
            self.calls[tool_call_id] = call
        return call

    def describe(self, tool_call_id: str) -> dict[str, Any]:
        call = self.calls.get(tool_call_id)
        if call is None:
            return {"title": "", "kind": "other", "name": None, "rawInput": None}
        return {"title": call.title, "kind": call.kind, "name": call.name, "rawInput": call.raw_input}


def _merge(call: _ToolCall, update: dict) -> None:
    if isinstance(update.get("title"), str):
        call.title = update["title"][:MAX_TITLE_CHARS]
    if isinstance(update.get("kind"), str):
        call.kind = update["kind"]
    if isinstance(update.get("name"), str):
        call.name = update["name"][:MAX_TITLE_CHARS]
    if update.get("rawInput") is not None:
        call.raw_input = update["rawInput"]
    if update.get("rawOutput") is not None:
        call.raw_output = update["rawOutput"]
    if isinstance(update.get("content"), list):
        call.content = update["content"]
    if isinstance(update.get("status"), str):
        call.status = update["status"]


def _tool_use_event(tool_call_id: str, call: _ToolCall, redact: Redact) -> dict[str, Any]:
    call.reported_use = True
    return {
        "type": "tool_use",
        "toolUseId": redact(tool_call_id),
        "tool": redact(call.name or call.title or "tool"),
        "title": redact(call.title),
        "kind": call.kind,
        "input": capped_json(call.raw_input if call.raw_input is not None else {}, MAX_TOOL_INPUT_CHARS, redact),
    }


def _tool_result_event(tool_call_id: str, call: _ToolCall, redact: Redact) -> dict[str, Any]:
    call.reported_result = True
    text = _tool_content_text(call.content)
    if not text and call.raw_output is not None:
        try:
            text = json.dumps(call.raw_output, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(call.raw_output)
    return {
        "type": "tool_result",
        "toolUseId": redact(tool_call_id),
        "content": _cap(redact(text), MAX_TOOL_RESULT_CHARS),
        "isError": call.status == "failed",
    }


def map_session_update(update: Any, state: ToolCallState, *, redact: Redact,
                       budget: TurnTextBudget | None = None) -> list[dict[str, Any]]:
    """Chat events for one ``session/update`` ``update`` object.

    ``budget`` is the turn's text allowance; without one, only the per-chunk
    cap applies."""
    if not isinstance(update, dict):
        return []
    kind = update.get("sessionUpdate")
    if kind in {"agent_message_chunk", "agent_thought_chunk"}:
        text = content_block_text(update.get("content"))
        if not text:
            return []
        return _text_events("text" if kind == "agent_message_chunk" else "thought", text, redact, budget)
    if kind in {"tool_call", "tool_call_update"}:
        tool_call_id = update.get("toolCallId")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return []
        call = state.get(tool_call_id)
        _merge(call, update)
        events: list[dict[str, Any]] = []
        if not call.reported_use:
            events.append(_tool_use_event(tool_call_id, call, redact))
        if call.status in {"completed", "failed"} and not call.reported_result:
            events.append(_tool_result_event(tool_call_id, call, redact))
        return events
    if kind == "plan":
        entries = []
        for entry in (update.get("entries") or [])[:MAX_PLAN_ENTRIES]:
            if not isinstance(entry, dict):
                continue
            priority = entry.get("priority") if entry.get("priority") in _PLAN_PRIORITIES else "medium"
            status = entry.get("status") if entry.get("status") in _PLAN_STATUSES else "pending"
            entries.append({"content": redact(str(entry.get("content") or ""))[:MAX_PLAN_ENTRY_CHARS],
                            "priority": priority, "status": status})
        return [{"type": "plan", "entries": entries}]
    # user_message_chunk (only meaningful for session/load replay, deferred),
    # usage_update, available_commands_update, current_mode_update,
    # config_option_update, session_info_update and unknown kinds: dropped.
    return []
