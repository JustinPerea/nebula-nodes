"""What an agent can be doing at its cursor (GM - Design's cursor spec, §2).

One list, in this order everywhere: POST /api/canvas/cursor
(services/agent_presence.py), MCP point_at, the CLI's `nebula point
--action`, the docs, and the frontend's AGENT_CURSOR_ACTIONS (wsClient.ts).
It has no imports, so the CLI can read it without loading the backend.
"""
from __future__ import annotations

ACTIONS = ("move", "look", "think", "type", "click", "drag", "run", "propose", "wait", "error")
ACTIONS_TEXT = ", ".join(ACTIONS)
