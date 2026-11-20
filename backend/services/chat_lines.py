"""The lines the chat websocket shows when it refuses a message (the agent never ran).

Each is a whole sentence for the person, with curly apostrophes, that says what
happened and, where there is an action, ends "then send again." The lines that
name a menu or a Settings place use the names the frontend shows (round B checks
them against frontend/src/components/panels/ChatModelPicker.tsx and settings/).
Model and catalog refusals are in services/chat_models.py (chat_refusal_message).
"""
from __future__ import annotations

import re

from services.chat_models import CLI_NAMES, PICK_ANOTHER_MODEL, chat_refusal_message

# A message the backend could not read: a broken client, a script, a stale tab.
RELOAD_LINE = "Nebula couldn’t read that message. Reload the page, then send again."
NUMBER_TOO_LARGE_LINE = "A number in that message is too large for Nebula to read. Reload the page, then send again."
OLD_REQUEST_LINE = "This tab sent an older kind of request. Reload the page, then send again."
AGENT_UNKNOWN_LINE = f"Nebula doesn’t recognize the agent for this chat. {PICK_ANOTHER_MODEL}"
# Commons has no Settings switch, so no line tells the person to turn it off.
COMMONS_ON_LINE = "Commons is on, so only Claude and Codex can chat. Pick one of them, then send again."
RESPONSE_RUNNING_LINE = "A response is still running. Stop it and wait for it to stop, then send again."

# A Claude or Codex turn Nebula declined to start (the CLI never ran): a refusal, so no `stop`,
# and a `code` the chat reads as a whole line (frontend/src/lib/chatErrorLine.ts, WHOLE_LINE_CODES).
GRANT_OVERLAP_CODE = "agent_grant_overlap"
KNOWLEDGE_CODE = "agent_knowledge_unavailable"
CODEX_FEATURES_CODE = "codex_features_refused"
CODEX_CHATGPT_CODE = "codex_chatgpt_required"
# What the person is asked to do with a notice Nebula skipped part of a reply: nothing, so no action.
# Where the Connect ChatGPT account button is: the connect section that opens above the message box when Codex is the
# agent (frontend/src/components/panels/ChatPanel.tsx, agentConnectHint). Settings has no such control.
CONNECT_CHATGPT = "Connect ChatGPT account above the message box"
OVERSIZED_EVENT_LINE = "Part of the reply was too large to show, so Nebula skipped it."


_DETAIL_MAX = 80
_PATH_PREFIX = re.compile(r"(?:[^\s/\\]*[/\\])+")
_UNSAFE_IN_SPAN = re.compile(r"[`'\"“”‘’\\]")


def one_line_detail(raw: str) -> str:
    """What a CLI printed on stderr, cut to one short line that is safe inside a code span: the first non-empty
    line, a file path reduced to its file name, no quote or backtick (a code span can't hold them), at most
    ``_DETAIL_MAX`` characters. Empty when nothing is left."""
    first = next((line for line in raw.splitlines() if line.strip()), "")
    text = _UNSAFE_IN_SPAN.sub("", _PATH_PREFIX.sub("", first))
    text = " ".join(text.split()).rstrip(".:; ")
    if len(text) > _DETAIL_MAX:
        text = text[:_DETAIL_MAX].rstrip(" .:;,") + "…"
    return text


def start_refusal(code: str, message: str) -> dict[str, str]:
    """The chat event for a turn that was refused before its CLI ran: an error with a code and no ``stop``."""
    return {"type": "error", "code": code, "message": message}


def not_installed_refusal(agent: str) -> dict[str, str]:
    """The CLI's binary is not on PATH: the same line as the model list's ``cli_not_installed``."""
    return start_refusal("cli_not_installed", chat_refusal_message("cli_not_installed", agent, ""))


def grant_overlap_refusal(agent: str) -> dict[str, str]:
    cli = CLI_NAMES.get(agent, agent.title())
    return start_refusal(GRANT_OVERLAP_CODE, (
        f"Nebula didn’t start {cli} because a folder it would open overlaps one Nebula keeps private. "
        "Make sure Nebula’s output and Commons folders are separate, then send again."))


def knowledge_refusal(agent: str) -> dict[str, str]:
    cli = CLI_NAMES.get(agent, agent.title())
    return start_refusal(KNOWLEDGE_CODE, (
        f"Nebula couldn’t copy its reference files for {cli}, so it didn’t start. "
        "Restart Nebula, then send again. If it keeps happening, reinstall Nebula."))
