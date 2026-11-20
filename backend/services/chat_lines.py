"""The lines the chat websocket shows when it refuses a message (the agent never ran).

Each is a whole sentence for the person, with curly apostrophes, that says what
happened and, where there is an action, ends "then send again." The lines that
name a menu or a Settings place use the names the frontend shows (round B checks
them against frontend/src/components/panels/ChatModelPicker.tsx and settings/).
Model and catalog refusals are in services/chat_models.py (chat_refusal_message).
"""
from __future__ import annotations

from services.chat_models import CHAT_MODEL_MENU

# A message the backend could not read: a broken client, a script, a stale tab.
RELOAD_LINE = "Nebula couldn’t read that message. Reload the page, then send again."
NUMBER_TOO_LARGE_LINE = "A number in that message is too large for Nebula to read. Reload the page, then send again."
OLD_REQUEST_LINE = "This tab sent an older kind of request. Reload the page, then send again."
AGENT_UNKNOWN_LINE = (f"Nebula doesn’t recognize the agent for this chat. Pick one in the {CHAT_MODEL_MENU} menu, "
                      "then send again.")
# Commons has no Settings switch: it is on only when the backend starts with this variable.
COMMONS_ON_LINE = ("Commons is on, so only Claude and Codex can chat. Pick one of them, or start Nebula without "
                   "`NEBULA_COMMONS_ENABLED=1` to turn Commons off, then send again.")
RESPONSE_RUNNING_LINE = "A response is still running. Stop it and wait for it to stop, then send again."
