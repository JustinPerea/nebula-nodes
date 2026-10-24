"""`nebula ask`, `nebula answers <id>`, `nebula questions withdraw <id>`.

An agent asks the person 1-5 questions only they can answer (Q125 item 1);
the person answers or dismisses them in Nebula's Updates. There is
deliberately no answer or dismiss command here: that is the person's alone.
The MCP twins are ask_person, get_answers and withdraw_questions.
"""
from __future__ import annotations

import argparse
import json
import shlex
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO

import httpx

from nebula_api import NebulaAPIError
from services.agent_questions import WITHDRAW_CLI, cap_message, still_open_rows

from ..client import NebulaClient
from ..formatter import format_questions

POLL_SECONDS = 25.0

# Exit codes for --wait.
EXIT_ANSWERED = 0
EXIT_TIMEOUT = 2
EXIT_DISMISSED = 3
EXIT_CLOSED = 4


# -- building the set from flags ------------------------------------------------

class QuestionAction(argparse.Action):
    """`--question TEXT` starts a question; `--option`, `--multiple` and
    `--no-text` after it belong to it (in the order given)."""

    def __call__(self, parser, namespace, values, option_string=None):  # noqa: ANN001
        questions = list(getattr(namespace, "questions", None) or [])
        if self.dest == "question":
            questions.append({"text": values})
        elif not questions:
            parser.error(f"{option_string} belongs to a question: put --question \"...\" first")
        else:
            current = dict(questions[-1])
            if self.dest == "option":
                current["options"] = [*current.get("options", []), values]
            elif self.dest == "multiple":
                current["multiple"] = True
            elif self.dest == "no_text":
                current["allowText"] = False
            questions[-1] = current
        namespace.questions = questions


def add_ask_arguments(parser: argparse.ArgumentParser) -> None:
    parser.set_defaults(questions=[])
    parser.add_argument("--question", "-q", dest="question", action=QuestionAction, metavar="TEXT",
                        help="A question, one plain line (200 characters max); repeat for up to 5")
    parser.add_argument("--option", dest="option", action=QuestionAction, metavar="CHOICE",
                        help="A choice for the question before it (2 to 6 short, different choices; repeatable)")
    parser.add_argument("--multiple", dest="multiple", action=QuestionAction, nargs=0,
                        help="The question before it takes any number of its choices (default: one)")
    parser.add_argument("--no-text", dest="no_text", action=QuestionAction, nargs=0,
                        help="The question before it takes only its choices, no typed answer")
    parser.add_argument("--note", help="One line saying why you ask (160 characters max)")
    parser.add_argument("--node", dest="nodes", action="append", default=[], metavar="nX",
                        help="A canvas node the questions are about (repeatable); unknown ones are dropped")
    parser.add_argument("--file", help="JSON file with {questions, note, nodeIds} (- reads standard input)")
    parser.add_argument("--wait", type=float, metavar="SECONDS", default=0.0,
                        help="Wait this many seconds for the person's answers")
    parser.add_argument("--json", action="store_true", help="Print the raw JSON")
    parser.add_argument("--as", dest="agent_name",
                        help="Your agent name (default: $NEBULA_AGENT_NAME; in-app agents are named automatically)")


def body_from_args(args: argparse.Namespace) -> dict[str, Any]:
    if getattr(args, "file", None):
        raw = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError("the file must hold a JSON object: {questions, note, nodeIds}")
        return body
    body: dict[str, Any] = {"questions": list(args.questions or [])}
    if args.note:
        body["note"] = args.note
    if args.nodes:
        body["nodeIds"] = list(args.nodes)
    return body


# -- waiting --------------------------------------------------------------------

def wait_for_answers(
    client: NebulaClient,
    view: dict[str, Any],
    *,
    timeout: float,
    agent_name: str | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, Any], bool]:
    """Poll until the person answers, dismisses, or the agent withdraws. Returns (view, timed_out)."""
    deadline = clock() + max(0.0, timeout)
    while view.get("status") == "open":
        remaining = deadline - clock()
        if remaining <= 0:
            return view, True
        try:
            view = client.get_questions(view["id"], wait=min(POLL_SECONDS, remaining),
                                        agent_name=agent_name).get("questions") or view
        except httpx.TimeoutException:
            continue
    return view, False


def outcome_code(view: dict[str, Any]) -> int:
    status = view.get("status")
    if status == "answered":
        return EXIT_ANSWERED
    if status == "dismissed":
        return EXIT_DISMISSED
    return EXIT_CLOSED


def _report(view: dict[str, Any], timed_out: bool, waited: float, *, as_json: bool, out: TextIO) -> int:
    if as_json:
        print(json.dumps({"questions": view, **({"timedOut": True} if timed_out else {})}, ensure_ascii=False,
                         indent=2), file=out)
    else:
        print(format_questions(view), file=out)
        if timed_out:
            print(f"No answer yet after {waited:g}s. Check again: nebula answers {view.get('id')} --wait {waited:g}",
                  file=out)
    return EXIT_TIMEOUT if timed_out else outcome_code(view)


def _withdraw_form(agent_name: str | None) -> str:
    return f"{WITHDRAW_CLI} --as {shlex.quote(agent_name)}" if agent_name else WITHDRAW_CLI


# -- the commands -----------------------------------------------------------------

def run_ask(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None,
            clock: Callable[[], float] = time.monotonic) -> int:
    out = out or sys.stdout
    try:
        body = body_from_args(args)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    try:
        response = client.ask(body, agent_name=args.agent_name)
    except NebulaAPIError as exc:
        payload = exc.payload if isinstance(exc.payload, dict) else {}
        rows = [row for row in payload.get("stillOpen") or [] if isinstance(row, dict) and row.get("id")]
        if exc.status == 429 and rows:
            rows = still_open_rows(rows, withdraw=_withdraw_form(args.agent_name))
            print(f"error: {cap_message(exc.detail, rows)}", file=sys.stderr)
            return 1
        client._fail(exc, "POST /api/canvas/questions")  # noqa: SLF001 - the CLI's one way to print a refusal
        return 1
    view = response.get("questions") or {}
    dropped = response.get("dropped") or []
    if args.json and not args.wait:
        print(json.dumps(response, ensure_ascii=False, indent=2), file=out)
        return 0
    if not args.json:
        count = len(view.get("questions") or [])
        print(f"Asked the person {count} question{'' if count == 1 else 's'} ({view.get('id')}); they answer from "
              "Updates in Nebula.", file=out, flush=True)
        if dropped:
            print(f"Not on the canvas, so left out: {', '.join(map(str, dropped))}", file=out, flush=True)
        if not args.wait:
            print(f"Check: nebula answers {view.get('id')} --wait 300", file=out)
            return 0
    view, timed_out = wait_for_answers(client, view, timeout=args.wait, agent_name=args.agent_name, clock=clock)
    return _report(view, timed_out, args.wait, as_json=args.json, out=out)


def run_answers(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None,
                clock: Callable[[], float] = time.monotonic) -> int:
    out = out or sys.stdout
    view = client.get_questions(args.question_id, agent_name=args.agent_name).get("questions") or {}
    if not args.wait:
        _report(view, False, 0.0, as_json=args.json, out=out)
        return 0
    view, timed_out = wait_for_answers(client, view, timeout=args.wait, agent_name=args.agent_name, clock=clock)
    return _report(view, timed_out, args.wait, as_json=args.json, out=out)


def run_questions(client: NebulaClient, args: argparse.Namespace, *, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    view = client.withdraw_questions(args.question_id, agent_name=args.agent_name).get("questions") or {}
    print(f"Withdrew {view.get('id', args.question_id)}.", file=out)
    return 0
