"""What an agent can be doing at its cursor (GM - Design's cursor spec, §2).

One list, in this order everywhere: POST /api/canvas/cursor
(services/agent_presence.py), MCP point_at, the CLI's `nebula point
--action`, the docs, and the frontend's AGENT_CURSOR_ACTIONS (wsClient.ts).
It has no imports, so the CLI can read it without loading the backend.
"""
from __future__ import annotations

ACTIONS = ("move", "look", "think", "type", "click", "drag", "run", "propose", "wait", "error")
ACTIONS_TEXT = ", ".join(ACTIONS)
ACTIONS_LIST_TEXT = ", ".join(ACTIONS[:-1]) + " or " + ACTIONS[-1]
_ECHO_CHARS = 40


def refusal(value: object) -> str:
    """The line an unknown action gets, everywhere (GM - Design, PR #211 r2):
    it echoes the value given, cut to 40 characters."""
    if isinstance(value, str):
        shown = value
    else:
        import json
        shown = json.dumps(value, default=str)
    if len(shown) > _ECHO_CHARS:
        shown = shown[: _ECHO_CHARS - 1] + "\u2026"
    return f"\u201c{shown}\u201d isn\u2019t an action Nebula knows. Use one of {ACTIONS_LIST_TEXT}."
