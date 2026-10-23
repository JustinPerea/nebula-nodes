"""A node run error's line for the person (error copy round 3c, GM - Design).

A handler's exception text is the specific text: ids, record and parameter
names, what to call. Agents read it (MCP run results, the node's stored error,
the run record), so it stays exactly as it is. GM: "the person reads these on
the node, so their lines shouldn't carry ids or record names. ... The node's
error stores the specific text for agents (and the run record and MCP keep
it), and the canvas shows the written line. If a fact helps the person act,
put it in words, like "the node's Resume Operation ID field"."

So the handler attaches the person's line to the exception it raises
(``with_person_line``) and the engine carries it on the ErrorEvent as the
additive ``person`` field (execution/engine.py), beside ``error``. Only the
raised exception's own line counts: a wrapper that turns one failure into
another writes its own line, so a cause's line never leaks into a different
failure. A node error with no person line shows "Couldn't run the node." and
GM's general line on the card, the raw text behind "Details" (the frontend's
lib/nodeErrorCopy.ts).

The rule for every raise during a node's run (round 3c-2). GM's guard:
"provider run errors often carry the one fact the person needs ... Don't let
the general fallback hide them." A line Nebula wrote for the person is a
written line, so it never goes without a person line:

- The text is Nebula's own words for the person and names no id, file path,
  record name, env-var name, parameter key (snake_case) or provider text:
  ``raise as_person_line(ValueError("..."))``. The card shows the text itself.
- It names one of those: ``raise with_person_line(ValueError("..."), line)``
  with an id-free line that names the node's field by its label in
  node_definitions.json, or the input in words ("A connected image file
  can't be found."). ``missing_file_line`` and ``key_line`` are the shared
  ones; a plain "<KEY> is required" MissingCredentialError gets ``key_line``
  by itself (execution/missing_credential.py).
- A shared check that names its caller (route_clients' ``where``, which is
  the provider's model or endpoint id) puts the node's name on its provider
  on the card ("FLUX 3 Video on Replicate"), never the id:
  ``raise refuse(where, text, person_tail)`` with a ``Where``
  (execution/route_clients.py). No value the run was given (``{size!r}``)
  goes in a line.
- Provider text (a provider's body or message), malformed provider answers,
  timeouts the classifier names, moderation blocks (their own card) and
  developer-only states keep no line: the card says the classifier's line or
  GM's general line, with the raw text behind Details.

Either way the exception text stays word for word. A guard counts the raises
with no line (tests/test_error_copy_round3c2.py) in handlers/, execution/ and
the services a run raises from (its RUN_TIME_SERVICES; add a new one there): a
new raise in Nebula's own words without one fails it. A raise the guard can't
read (a re-raise of another exception's text) needs its own test.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TypeVar

_ATTRIBUTE = "nebula_person_line"

E = TypeVar("E", bound=BaseException)


def with_person_line(exc: E, line: str) -> E:
    """Attach the person's line to `exc` and return it (``raise with_person_line(...)``)."""
    setattr(exc, _ATTRIBUTE, line)
    return exc


def as_person_line(exc: E) -> E:
    """`exc`'s own text is already the person's line: the card shows it as it is."""
    return with_person_line(exc, str(exc))


def person_line(exc: BaseException) -> str | None:
    """The person's line `exc` was raised with, or None (the card's fallback)."""
    line = getattr(exc, _ATTRIBUTE, None)
    return line.strip() if isinstance(line, str) and line.strip() else None


def missing_file_line(what: str = "file") -> str:
    """A connected file that isn't there, named in words ("image file",
    "reference video"), never by its path."""
    return f"A connected {what.strip().lower() or 'file'} can't be found. Connect it again, then run the node again."


# How a person knows each key Settings stores: the provider's own spelling
# (frontend/src/lib/providerCatalog.ts labels), and what the key is called.
KEY_NAMES: dict[str, tuple[str, str]] = {
    "ANTHROPIC_API_KEY": ("Anthropic", "API key"),
    "BFL_API_KEY": ("Black Forest Labs", "API key"),
    "BYTEPLUS_API_KEY": ("BytePlus", "API key"),
    "ELEVENLABS_API_KEY": ("ElevenLabs", "API key"),
    "FAL_KEY": ("fal.ai", "API key"),
    "GOOGLE_API_KEY": ("Gemini", "API key"),
    "GOOGLE_VERTEX_CREDENTIALS": ("Google Vertex AI", "credentials"),
    "HIGGSFIELD_API_KEY": ("Higgsfield", "API key"),
    "IDEOGRAM_API_KEY": ("Ideogram", "API key"),
    "KREA_API_TOKEN": ("Krea", "API token"),
    "KREA_USAGE_KEY": ("Krea", "usage key"),
    "MESHY_API_KEY": ("Meshy", "API key"),
    "MINIMAX_API_KEY": ("MiniMax", "API key"),
    "OPENAI_API_KEY": ("OpenAI", "API key"),
    "OPENROUTER_API_KEY": ("OpenRouter", "API key"),
    "QUIVER_API_KEY": ("QuiverAI", "API key"),
    "REPLICATE_API_TOKEN": ("Replicate", "API token"),
    "RUNWAY_API_KEY": ("Runway", "API key"),
    "TYPESAFE_API_KEY": ("TypeSafe", "API key"),
    "WORLDLABS_API_KEY": ("World Labs", "API key"),
    "XAI_API_KEY": ("xAI", "API key"),
}


def _or_list(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} or {items[-1]}"


def key_phrase(keys: Iterable[str]) -> str | None:
    """"OpenAI API key", "ElevenLabs or Runway API key", "Google Vertex AI
    credentials or Gemini API key"; None when a name isn't a key Settings stores."""
    names = [KEY_NAMES.get(key) for key in keys]
    if not names or any(name is None for name in names):
        return None
    kinds = {kind for _provider, kind in names}  # type: ignore[misc]
    if len(kinds) == 1:
        return f"{_or_list([provider for provider, _kind in names])} {kinds.pop()}"  # type: ignore[misc]
    return _or_list([f"{provider} {kind}" for provider, kind in names])  # type: ignore[misc]


def key_line(keys: Iterable[str]) -> str | None:
    """The line for a run that stopped at its own key check."""
    phrase = key_phrase(keys)
    return f"Add your {phrase} in Settings, then run the node again." if phrase else None


def missing_key_line(keys: Iterable[str]) -> str:
    """The pre-run check's missing key (error copy round 3e): key_line, or,
    for a key Settings doesn't list by name, the same line without one."""
    return key_line(keys) or "Add this node's API key in Settings, then run the node again."


# Common inputs said in words, as 3c's lines do ("Connect a prompt, ...").
_PORT_WORDS = {"prompt": "a prompt", "image": "an image", "video": "a video", "audio": "audio"}


def port_name(label: object) -> str:
    """An input's label as a line names it: a note in its parentheses
    ("Mask (white = edit)", "Images (1-4)") left out (GM: no parentheses)."""
    return re.sub(r"\s*\([^)]*\)", "", str(label or "")).strip()


def port_line(label: str) -> str:
    """A required input with no wire, before the run (error copy round 3e):
    in words for the common ones, else by the input's label on the card."""
    name = port_name(label)
    words = _PORT_WORDS.get(name.lower())
    if words:
        return f"Connect {words}, then run the node again."
    if not name:
        return "Connect the node's inputs, then run the node again."
    return f"Connect the node's {name} input, then run the node again."


def joined_lines(lines: Iterable[str | None]) -> str | None:
    """Several checks' person lines on one card, in order, each once. None
    when any check has no line: the card then shows GM's general line with
    every specific text behind Details, so no check goes unsaid."""
    listed = list(lines)
    if not listed or any(not (line and line.strip()) for line in listed):
        return None
    kept: list[str] = []
    for line in listed:
        if line.strip() not in kept:  # type: ignore[union-attr]
            kept.append(line.strip())  # type: ignore[union-attr]
    return " ".join(kept)
