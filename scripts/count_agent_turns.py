#!/usr/bin/env python3
"""Count an agent's orientation turns in a `claude -p` stream-json transcript.

Plan v2.7, PR26, section 5.10.1. GM's headless run
(docs/agent-runs/2026-10-20-cli-headless.md) spent 8 of its 16 turns working
out how to use Nebula rather than doing the person's work. This script counts
the same way GM did, so a before-and-after run compares with his 8 of 16.

A turn is one model response: the `assistant` events of one message (Claude
Code writes one event per content block, all with the same `message.id`).
A turn is **orientation** when it has at least one tool call and every tool
call in it is one of:

- ``help``: reading help or docs (``--help``, ``-h``, ``nebula`` with no
  command, ``SKILL.md``, ``docs/``, or loading the nebula skill);
- ``lookup``: looking up node types, their ports, params or prices
  (``nebula context``, ``nodes``, ``info`` and their aliases ``find`` and
  ``describe``; MCP ``start_here``, ``find_nodes``, ``describe_node``);
- ``limits``: reading the spend limits or the keys (``nebula spend``,
  ``nebula keys``, MCP ``get_spend_limits``);
- ``usage-error``: a call that failed on usage, whatever it meant to do
  (argparse's exit 2, an unknown command, option or node id, a named
  "doesn't take" error, an MCP argument error).

Everything else is **needed**: reading the person's own work (``projects``,
``look``, ``selection``, ``pins``, ``moodboard list``/``show`` and their MCP
twins), building, running, proposing, pointing, answering pins. A turn with
no tool call (the final reply) is needed too. A call the demo's guard wrapper
refused ("Not allowed in this demo") is classed ``refused``: it is needed,
not orientation, and is reported on its own.

Usage::

    python3 scripts/count_agent_turns.py run.jsonl          # a table and the totals
    python3 scripts/count_agent_turns.py run.jsonl --json   # the same as JSON
    python3 scripts/count_agent_turns.py a.jsonl b.jsonl c.jsonl   # one block per run, then median and range

Stdlib only; it never calls Nebula or a model.
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

ORIENTATION = ("help", "lookup", "limits", "usage-error")

# `nebula` commands by class. `find` and `describe` are the CLI's aliases for
# `nodes` and `info` (MCP's names for them).
LOOKUP_COMMANDS = {"context", "nodes", "info", "find", "describe"}
LIMIT_COMMANDS = {"spend", "keys"}
# Options of the top `nebula` parser that take a value.
GLOBAL_VALUE_OPTIONS = {"--url"}

# MCP tool names (after `mcp__<server>__`).
LOOKUP_TOOLS = {"start_here", "find_nodes", "describe_node"}
LIMIT_TOOLS = {"get_spend_limits"}

# Text that marks a failed call as a usage failure.
USAGE_PATTERNS = [
    re.compile(p, re.I) for p in (
        r"\berror: unrecognized arguments\b",
        r"\berror: argument [^:\n]+: invalid choice\b",
        r"\berror: the following arguments are required\b",
        r"\berror: argument [^:\n]+: expected\b",
        r"\berror: unknown [a-z ]+ (command|action)\b",
        r"\bNode '[^']+' not found\b",
        r"`nebula [a-z-]+` doesn't take --",
        r"\bRename existing nodes with edit_canvas\b",
        r"\bvalidation errors? for \w+Arguments\b",
        r"\bInputValidationError\b",
        r"\bInput validation error\b",
        r"\bunexpected keyword argument\b",
        r"\b(No such|Unknown) tool\b",
    )
]
GUARD_REFUSAL = re.compile(r"Not allowed in this demo", re.I)
EXIT_CODE = re.compile(r"^\s*Exit code (\d+)")
DOC_PATH = re.compile(r"(^|/)(SKILL\.md|docs/)")
READ_COMMANDS = {"cat", "head", "tail", "less", "more", "sed", "awk", "grep", "rg", "bat"}
# Commands that only filter another's output (`nebula nodes | head -40`): they don't change its class.
FILTER_COMMANDS = READ_COMMANDS | {"jq", "wc", "sort", "uniq", "cut", "tr", "column"}


@dataclass
class Call:
    tool: str
    summary: str
    kind: str = "needed"  # one of ORIENTATION, "needed" or "refused"
    error: bool = False
    exit_code: int | None = None


@dataclass
class Turn:
    index: int
    message_id: str
    calls: list[Call] = field(default_factory=list)
    text: str = ""

    @property
    def orientation(self) -> bool:
        return bool(self.calls) and all(call.kind in ORIENTATION for call in self.calls)

    @property
    def kind(self) -> str:
        if not self.calls:
            return "reply"
        if self.orientation:
            kinds = list(dict.fromkeys(call.kind for call in self.calls))
            return "orientation (" + ", ".join(kinds) + ")"
        return "needed"


# -- reading the transcript --------------------------------------------------

def read_events(lines: Iterable[str]) -> list[dict[str, Any]]:
    events = []
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"line {number} is not JSON: {exc}") from None
        if isinstance(event, dict):
            events.append(event)
    return events


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return "" if content is None else str(content)


def build_turns(events: list[dict[str, Any]]) -> tuple[list[Turn], dict[str, Any] | None]:
    turns: list[Turn] = []
    by_message: dict[str, Turn] = {}
    by_tool_use: dict[str, tuple[Call, dict[str, Any]]] = {}
    results: dict[str, tuple[str, bool]] = {}
    final: dict[str, Any] | None = None
    for event in events:
        kind = event.get("type")
        if kind == "result":
            final = event
            continue
        message = event.get("message") or {}
        if kind == "assistant":
            # One turn per message id; an event without one is its own turn.
            message_id = str(message.get("id") or f"_event{len(turns)}")
            turn = by_message.get(message_id)
            if turn is None:
                turn = Turn(index=len(turns) + 1, message_id=message_id)
                by_message[message_id] = turn
                turns.append(turn)
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text":
                    turn.text = (turn.text + "\n" + str(block.get("text", ""))).strip()
                elif block.get("type") in ("tool_use", "server_tool_use", "mcp_tool_use"):
                    call = Call(tool=str(block.get("name", "")), summary="")
                    turn.calls.append(call)
                    by_tool_use[str(block.get("id"))] = (call, block.get("input") or {})
        elif kind == "user":
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    results[str(block.get("tool_use_id"))] = (
                        _result_text(block.get("content")), bool(block.get("is_error")))
    for tool_use_id, (call, tool_input) in by_tool_use.items():
        text, is_error = results.get(tool_use_id, ("", False))
        classify(call, tool_input, text, is_error)
    return turns, final


# -- classing a call ---------------------------------------------------------

def classify(call: Call, tool_input: dict[str, Any], text: str, is_error: bool) -> None:
    exit_match = EXIT_CODE.match(text)
    call.exit_code = int(exit_match.group(1)) if exit_match else None
    call.error = is_error or bool(call.exit_code)
    call.summary = _summary(call.tool, tool_input)
    if call.error and GUARD_REFUSAL.search(text):
        call.kind = "refused"
        return
    if call.error and (call.exit_code == 2 and "usage:" in text or any(p.search(text) for p in USAGE_PATTERNS)):
        call.kind = "usage-error"
        return
    call.kind = _kind_of(call.tool, tool_input)


def _summary(tool: str, tool_input: dict[str, Any]) -> str:
    if tool == "Bash":
        return " ".join(str(tool_input.get("command", "")).split())[:160]
    if tool in ("Read", "Grep", "Glob"):
        return f"{tool} {tool_input.get('file_path') or tool_input.get('path') or tool_input.get('pattern') or ''}".strip()
    if tool == "Skill":
        return f"Skill {tool_input.get('skill') or tool_input.get('name') or ''}".strip()
    args = json.dumps(tool_input, ensure_ascii=False, sort_keys=True)
    return f"{_mcp_name(tool) or tool} {args}"[:160]


def _mcp_name(tool: str) -> str | None:
    if tool.startswith("mcp__"):
        return tool.split("__", 2)[-1]
    return None


def _kind_of(tool: str, tool_input: dict[str, Any]) -> str:
    mcp = _mcp_name(tool)
    if mcp is not None:
        if mcp in LOOKUP_TOOLS:
            return "lookup"
        if mcp in LIMIT_TOOLS:
            return "limits"
        return "needed"
    if tool == "Bash":
        return _bash_kind(str(tool_input.get("command", "")))
    if tool in ("Read", "Grep", "Glob"):
        target = str(tool_input.get("file_path") or tool_input.get("path") or "")
        return "help" if DOC_PATH.search(target) else "needed"
    if tool == "Skill":
        return "help" if "nebula" in str(tool_input.get("skill") or tool_input.get("name") or "") else "needed"
    return "needed"


def _segments(command: str) -> list[list[str]]:
    """The simple commands in a shell line, split on && || ; and |."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        words = list(lexer)
    except ValueError:
        words = command.split()
    segments: list[list[str]] = [[]]
    for word in words:
        if word and set(word) <= set(";&|"):
            segments.append([])
        else:
            segments[-1].append(word)
    return [segment for segment in segments if segment]


def _nebula_args(words: list[str]) -> list[str] | None:
    """The words after `nebula` (or `python -m nebula`/`cli`), env prefixes skipped."""
    index = 0
    while index < len(words) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[index]):
        index += 1
    words = words[index:]
    if not words:
        return None
    if Path(words[0]).name == "nebula":
        return words[1:]
    if Path(words[0]).name.startswith("python") and len(words) >= 3 and words[1] == "-m" and words[2] in ("nebula", "cli"):
        return words[3:]
    return None


def _nebula_kind(args: list[str]) -> str:
    if any(word in ("--help", "-h") for word in args):
        return "help"
    index = 0
    while index < len(args) and args[index].startswith("-"):
        index += 2 if args[index].split("=", 1)[0] in GLOBAL_VALUE_OPTIONS and "=" not in args[index] else 1
    if index >= len(args):
        return "help"  # `nebula` with no command prints the help
    command = args[index]
    if command == "help":
        return "help"
    if command in LOOKUP_COMMANDS:
        return "lookup"
    if command in LIMIT_COMMANDS:
        return "limits"
    return "needed"


def _bash_kind(command: str) -> str:
    kinds = []
    for words in _segments(command):
        args = _nebula_args(words)
        if args is not None:
            kinds.append(_nebula_kind(args))
        elif Path(words[0]).name in READ_COMMANDS and any(DOC_PATH.search(word) for word in words[1:]):
            kinds.append("help")
        elif Path(words[0]).name in FILTER_COMMANDS:
            continue
        else:
            kinds.append("needed")
    if not kinds:
        return "needed"
    # A shell line is orientation only when all of it is.
    if all(kind in ORIENTATION for kind in kinds):
        return "help" if "help" in kinds else kinds[0]
    return "needed"


# -- the counts --------------------------------------------------------------

def count(path_or_lines: str | Path | Iterable[str]) -> dict[str, Any]:
    if isinstance(path_or_lines, (str, Path)):
        with open(path_or_lines, encoding="utf-8") as handle:
            events = read_events(handle)
        source = str(path_or_lines)
    else:
        events = read_events(path_or_lines)
        source = "<lines>"
    turns, final = build_turns(events)
    calls = [call for turn in turns for call in turn.calls]
    orientation = sum(turn.orientation for turn in turns)
    by_kind = {kind: sum(call.kind == kind for call in calls) for kind in (*ORIENTATION, "needed", "refused")}
    report = {
        "source": source,
        "turns": len(turns),
        "orientation": orientation,
        "needed": len(turns) - orientation,
        "toolCalls": len(calls),
        "callsByKind": by_kind,
        "usageErrors": by_kind["usage-error"],
        "helpReads": by_kind["help"],
        "numTurns": final.get("num_turns") if final else None,
        "durationMs": final.get("duration_ms") if final else None,
        "costUsd": final.get("total_cost_usd") if final else None,
        "rows": [
            {"turn": turn.index, "kind": turn.kind,
             "calls": [asdict(call) for call in turn.calls],
             "text": turn.text[:160] if not turn.calls else ""}
            for turn in turns
        ],
    }
    if final and final.get("num_turns") not in (None, len(turns)):
        report["warning"] = (f"the result event says num_turns {final.get('num_turns')}, "
                             f"but the transcript has {len(turns)} assistant messages")
    return report


def summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    def spread(key: str) -> dict[str, Any]:
        values = [report[key] for report in reports]
        return {"median": statistics.median(values), "min": min(values), "max": max(values)}
    return {"runs": len(reports), "orientation": spread("orientation"), "turns": spread("turns"),
            "usageErrors": spread("usageErrors"), "helpReads": spread("helpReads")}


def format_report(report: dict[str, Any]) -> str:
    lines = [f"{report['source']}"]
    for row in report["rows"]:
        if not row["calls"]:
            lines.append(f"  {row['turn']:>3}  {'reply':<26}  {row['text'] or '(no text)'}")
            continue
        for position, call in enumerate(row["calls"]):
            label = row["kind"] if position == 0 else ""
            failed = f"  [exit {call['exit_code']}]" if call["exit_code"] else "  [error]" if call["error"] else ""
            turn = f"{row['turn']:>3}" if position == 0 else "   "
            lines.append(f"  {turn}  {label:<26}  {call['kind']:<11}  {call['summary']}{failed}")
    lines.append(f"Orientation: {report['orientation']} of {report['turns']} turns "
                 f"({report['toolCalls']} tool calls; usage errors {report['usageErrors']}, help reads {report['helpReads']})")
    extras = [f"num_turns {report['numTurns']}" if report["numTurns"] is not None else "",
              f"{report['durationMs']} ms" if report["durationMs"] is not None else "",
              f"${report['costUsd']}" if report["costUsd"] is not None else ""]
    if any(extras):
        lines.append("Result: " + ", ".join(extra for extra in extras if extra))
    if report.get("warning"):
        lines.append(f"Warning: {report['warning']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Count orientation turns in claude -p stream-json transcripts.")
    parser.add_argument("transcripts", nargs="+", help="stream-json files (one JSON event per line)")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = parser.parse_args(argv)
    reports = [count(path) for path in args.transcripts]
    if args.json:
        payload: Any = reports[0] if len(reports) == 1 else {"runs": reports, "summary": summarize(reports)}
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    print("\n\n".join(format_report(report) for report in reports))
    if len(reports) > 1:
        summary = summarize(reports)
        o = summary["orientation"]
        print(f"\n{summary['runs']} runs: orientation median {o['median']} (range {o['min']} to {o['max']}); "
              f"usage errors median {summary['usageErrors']['median']}, help reads median {summary['helpReads']['median']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
