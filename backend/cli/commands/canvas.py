from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, TextIO

import httpx

from ..client import NebulaClient
from ..formatter import format_event, format_snapshot

WATCH_POLL_SECONDS = 25.0
ONCE_DEFAULT_TIMEOUT = 600.0


def _target(text: str) -> dict:
    text = (text or "").strip()
    if "," in text:
        x, _, y = text.partition(",")
        try:
            return {"x": float(x), "y": float(y)}
        except ValueError:
            print(f"error: '{text}' is not x,y", file=sys.stderr)
            sys.exit(1)
    node_id, dot, handle = text.partition(".")
    if not node_id:
        print("error: target needs a node id, node.port, or x,y", file=sys.stderr)
        sys.exit(1)
    return {"nodeId": node_id, "handle": handle} if dot else {"nodeId": node_id}


def run_look(client: NebulaClient, *, as_json: bool = False) -> None:
    snapshot = client.get_canvas_snapshot()
    print(json.dumps(snapshot, indent=2, ensure_ascii=False) if as_json else format_snapshot(snapshot))


def run_point(
    client: NebulaClient,
    target: str,
    *,
    say: str = "",
    origin: str | None = None,
    action: str | None = None,
    agent_name: str | None = None,
) -> None:
    body: dict = {"target": _target(target), "say": say}
    if origin:
        body["from"] = _target(origin)
    body["action"] = action or ("drag" if origin else "move")
    result = client.point_cursor(body, agent_name=agent_name)
    agent = result.get("agent", {}).get("name", "agent")
    where = target + (f" (from {origin})" if origin else "")
    print(f"{agent} → {where}" + (f": {result.get('say')}" if result.get("say") else ""))


def run_watch(
    client: NebulaClient,
    *,
    once: bool = False,
    timeout: float | None = None,
    as_json: bool = False,
    since: int | None = None,
    journal: str | None = None,
    kinds: str | None = None,
    include_self: bool = False,
    agent_name: str | None = None,
    out: TextIO | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Long-poll the canvas journal and print changes as they happen.

    Exit codes: 0 when events were printed, 2 when the timeout passed with
    none, 130 on Ctrl-C.
    """
    out = out or sys.stdout
    if once and timeout is None:
        timeout = ONCE_DEFAULT_TIMEOUT
    deadline = None if timeout is None else clock() + max(0.0, timeout)
    cursor = since
    journal_id = journal
    printed = False

    def say(line: str) -> None:
        print(line, file=sys.stderr if as_json else out, flush=True)

    try:
        if not once and not as_json:
            skipping = "including your own changes" if include_self else "skipping your own changes"
            print(f"Watching the canvas (Ctrl-C to stop) — {skipping}", file=out, flush=True)
        while True:
            remaining = WATCH_POLL_SECONDS if deadline is None else deadline - clock()
            if remaining <= 0:
                if printed:
                    return 0
                say(f"No canvas changes in {timeout:g}s.")
                return 2
            wait = min(WATCH_POLL_SECONDS, remaining)
            params: dict[str, Any] = {"wait": round(wait, 1), "limit": 100}
            if cursor is not None:
                params["after"] = cursor
            if journal_id:
                params["journal"] = journal_id
            if kinds:
                params["kinds"] = kinds
            if include_self:
                params["self"] = 1
            try:
                response = client.get_canvas_events(params, timeout=wait + 10, agent_name=agent_name)
            except httpx.TimeoutException:
                continue
            previous = cursor
            if response.get("reset") and journal_id:
                say("(backend restarted — run nebula look)")
            elif response.get("gap") and previous is not None:
                missed = max(0, int(response.get("oldest", 0)) - 1 - int(previous))
                say(f"(missed {missed} events — run nebula look)")
            journal_id = response.get("journal") or journal_id
            cursor = response.get("cursor", cursor)
            events = response.get("events") or []
            if once:
                if not events:
                    continue
                if as_json:
                    print(json.dumps(response, ensure_ascii=False), file=out, flush=True)
                else:
                    for event in events:
                        print(format_event(event), file=out)
                    more = " (more waiting)" if response.get("more") else ""
                    print(f"cursor {cursor}{more} · next: nebula watch --once --since {cursor}", file=out, flush=True)
                return 0
            for event in events:
                line = json.dumps(event, ensure_ascii=False) if as_json else format_event(event)
                print(line, file=out, flush=True)
                printed = True
    except KeyboardInterrupt:
        return 130
