"""Hide API keys a provider quoted in an error before an agent reads it.

Cards keep a provider's raw error, and providers quote keys: OpenAI's 401
shows the key's first and last characters around asterisks
("sk-abc1****wxyz"), and an httpx header error shows the whole key. Agents
read those errors through look_at_canvas, get_project and get_run, and no
agent-facing result may hold any part of a key (Justin, audit U6).

Two passes over an error's text:
- a token with three or more asterisks in it (a masked key) becomes HIDDEN;
- a run of 8 or more characters of a configured key becomes HIDDEN. Only keys
  that are one word of 8 to 512 characters are searched this way, so a
  multi-line credential (a service-account JSON) never hides ordinary words.

Errors only: a prompt may well contain "***".
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

HIDDEN = "<key hidden>"
_MASKED = re.compile(r"[A-Za-z0-9_.\-]*\*{3,}[A-Za-z0-9_\-]*")
_TOKEN = re.compile(r"\S{8,512}")
_RUN = 8


def configured_secrets(api_keys: Any) -> list[str]:
    """The settings' key values worth searching for (stripped, one word)."""
    if not isinstance(api_keys, Mapping):
        return []
    secrets = []
    for value in api_keys.values():
        if isinstance(value, str) and _TOKEN.fullmatch(value.strip()):
            secrets.append(value.strip())
    return secrets


def hide_key_echoes(text: Any, secrets: Iterable[str]) -> Any:
    """`text` with masked keys and runs of configured keys replaced; anything
    that isn't a string comes back as it is."""
    if not isinstance(text, str) or not text:
        return text
    text = _MASKED.sub(HIDDEN, text)
    for secret in secrets:
        text = _hide_runs(text, secret)
    return text


def _hide_runs(text: str, secret: str) -> str:
    marked = [False] * len(text)
    found = False
    for start in range(len(secret) - _RUN + 1):
        piece = secret[start:start + _RUN]
        at = text.find(piece)
        while at != -1:
            found = True
            for index in range(at, at + _RUN):
                marked[index] = True
            at = text.find(piece, at + 1)
    if not found:
        return text
    out: list[str] = []
    index = 0
    while index < len(text):
        if marked[index]:
            out.append(HIDDEN)
            while index < len(text) and marked[index]:
                index += 1
        else:
            out.append(text[index])
            index += 1
    return "".join(out)


def hide_in_run(response: dict[str, Any], secrets: Iterable[str]) -> dict[str, Any]:
    """A run response (GET /api/graph/runs/{id}, POST /api/graph/run) with its
    `error`, `errors` and each `nodes[...].error` cleaned."""
    secrets = list(secrets)
    if not isinstance(response, dict):
        return response
    cleaned = dict(response)
    if isinstance(cleaned.get("error"), str):
        cleaned["error"] = hide_key_echoes(cleaned["error"], secrets)
    if isinstance(cleaned.get("errors"), dict):
        cleaned["errors"] = {node: hide_key_echoes(message, secrets) for node, message in cleaned["errors"].items()}
    if isinstance(cleaned.get("nodes"), dict):
        cleaned["nodes"] = {
            node: ({**entry, "error": hide_key_echoes(entry["error"], secrets)}
                   if isinstance(entry, dict) and isinstance(entry.get("error"), str) else entry)
            for node, entry in cleaned["nodes"].items()
        }
    return cleaned
