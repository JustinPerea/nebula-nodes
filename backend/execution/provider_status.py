"""GM's line for a provider's answer, from one shared table (error copy round 3d).

GM - Design's copy for a provider's HTTP failure, one table for every handler:

- 401/403: "{Provider} didn't accept your API key. Check it in Settings, then
  run the node again."
- 402 / insufficient credits: "Your {Provider} account is out of credits.
  Add credits, then run the node again."
- 429: "{Provider} is busy. Wait a moment, then run the node again."
- 5xx: "{Provider} is having trouble right now. Try again in a few minutes."
- empty or malformed answers: "{Provider} didn't return a result. Run the
  node again."

GM: "Raw provider text stays behind Details in every case." So the card shows
the line and keeps the exception text behind Details (the event's
``provider_text``); agents, MCP, the run record and the journal read the
exception text word for word, as before.

Where it applies: one place, :func:`card_line`, which the engine calls for a
node's run error (both ErrorEvent sites in execution/engine.py) and a Cinema
scene for a failed shot (handlers/cinema_scene.py). It knows the node, its
params and the keys, so it can name the provider the run actually called:

1. A handler's own person line always wins (execution/person_line.py).
2. Moderation keeps its own card: no line for a blocked run.
3. The status: a typed provider error's ``status_code`` (BFLError,
   BytePlusError, QuiverError), else the shapes handlers write it in, "...
   failed (429): ...", "... API error 401: ...", "(HTTP 503)", "(402: ...)".
   A bare number elsewhere in the text (a seed range, "after 300 polls") is
   not a status. httpx's own HTTPStatusError is a download of a result or an
   input URL (every raise_for_status() call is one), not the provider's API,
   so it names no provider and keeps today's line.
4. Credits or a key a provider signals without the status: the classifier's
   quota words win the status (OpenAI answers an exhausted quota with a 429
   "insufficient_quota"), and its auth words read as a rejected key.
   A job the provider ran and then reported failed ("Async job failed: ...",
   "Meshy task failed: ...") takes only the credits line: the key and the
   service already answered, so a status inside the job's error is about the
   job, and the card keeps today's line (the 3d review).
5. Who answered: the provider the text names first ("Meshy submit failed",
   "Veo (Vertex) ...", "Grok ..."), else the route the run took
   (services/node_route.select_route: a provider switcher's choice, or
   Auto's), named the way Settings names its key (person_line.KEY_NAMES).
   A run on the signed-in Krea plan has no key, so a rejected key there keeps
   today's line.

A failure whose status or provider Nebula can't tell keeps today's line: the
classifier's, or GM's general one.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, NamedTuple

from execution.error_classifier import _QUOTA_MARKERS, classify_error
from execution.person_line import (KEY_NAMES, carries_provider_text, key_name, person_line, status_line)


class CardLine(NamedTuple):
    """What a run error's card says: the person's line (None: the card's
    fallback) and whether the exception text, behind Details, carries the
    provider's own words."""
    person: str | None
    provider_text: bool


# The shapes handlers write a provider's HTTP status in.
_STATUS_SHAPES = re.compile(
    r"\((?:HTTP\s*)?([1-5]\d\d)(?:\)|:)"          # "failed (429): ...", "(HTTP 503)", "(402: said)"
    r"|\b(?:error|HTTP|status)\s+([1-5]\d\d)\b"   # "API error 401: ...", "HTTP 401", "status 503"
    r"|^([1-5]\d\d):\s"                           # "403: forbidden"
    r"|:\s([1-5]\d\d)\s"                          # "Failed to fetch Replicate model a/b: 401 {...}"
)

# An answer with no result in it, or one Nebula couldn't read.
_NO_RESULT = re.compile(
    r"\breturned no\b|\bdid not return\b|\bdidn't return\b|\bwithout returning\b|\bcompleted but (?:no|returned no)\b"
    r"|\bsucceeded (?:but returned no|without)\b|\breturned non-JSON\b|\breturned (?:an )?unexpected (?:answer|response)\b"
    r"|\bresult missing\b|\bcompleted without\b|\b(?:ended|closed) without a\b|\breturned an empty\b"
    r"|\bwith no data\b|\bSuccess but no\b|\bReady but returned no\b",
    re.I,
)

# A job the provider took and ran, then reported failed, cancelled or expired
# (every poll's terminal failure: "Async job failed: ...", "Meshy task
# failed: ...", "Krea job <id> cancelled: ...", "Grok failed: ..."). Submit and
# polling already answered, so the key and the service worked: a status or an
# auth word in the job's own error is about the job (an input URL it couldn't
# fetch, a model crash), never the person's key. An API answer that says
# "failed" carries its status right after it ("OpenRouter video failed (402)")
# and still reads the table.
_JOB_FAILED = re.compile(
    r"^(?:Async job failed:"
    r"|[A-Z][\w.() -]*? (?:task|job|generation|prediction|operation|interaction|training|video|Dubbing)"
    r"(?: [\w-]+)? (?:failed|expired|canceled|cancelled|errored)\b(?!\s*\()"
    r"|(?:Grok|Higgsfield|Veo|Veo \(Vertex\)) failed:"
    r"|Replicate stream error:)"
)

# A key the provider says is missing (not refused).
_MISSING_KEY = ("missing api key", "no api key")

# Who answered, when the text names them at its start: the key Settings stores
# for them. Longer names first ("Veo (Vertex)" before "Veo").
_TEXT_PROVIDERS: tuple[tuple[str, str], ...] = (
    ("Veo (Vertex)", "GOOGLE_VERTEX_CREDENTIALS"),
    ("Black Forest Labs", "BFL_API_KEY"), ("BytePlus", "BYTEPLUS_API_KEY"), ("ElevenLabs", "ELEVENLABS_API_KEY"),
    ("OpenRouter", "OPENROUTER_API_KEY"), ("OpenAI", "OPENAI_API_KEY"), ("Replicate", "REPLICATE_API_TOKEN"),
    ("Higgsfield", "HIGGSFIELD_API_KEY"), ("Ideogram", "IDEOGRAM_API_KEY"), ("MiniMax", "MINIMAX_API_KEY"),
    ("Meshy", "MESHY_API_KEY"), ("Runway", "RUNWAY_API_KEY"), ("Krea", "KREA_API_TOKEN"),
    ("fal.ai", "FAL_KEY"), ("FAL", "FAL_KEY"), ("Grok", "XAI_API_KEY"), ("xAI", "XAI_API_KEY"),
    ("Gemini", "GOOGLE_API_KEY"), ("Lyria", "GOOGLE_API_KEY"), ("Veo", "GOOGLE_API_KEY"),
    ("QuiverAI", "QUIVER_API_KEY"), ("Quiver", "QUIVER_API_KEY"), ("World Labs", "WORLDLABS_API_KEY"),
    ("TypeSafe", "TYPESAFE_API_KEY"), ("Anthropic", "ANTHROPIC_API_KEY"), ("Claude", "ANTHROPIC_API_KEY"),
)


def http_status(exc: BaseException) -> int | None:
    """The provider's HTTP status in `exc`, or None when it carries none."""
    import httpx

    for attribute in ("status_code", "status"):
        value = getattr(exc, attribute, None)
        if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599:
            return value
    if isinstance(exc, httpx.HTTPStatusError):
        return None  # a download, not the provider's API (module docstring, 3)
    match = _STATUS_SHAPES.search(str(exc))
    return int(next(group for group in match.groups() if group)) if match else None


def failure_kind(exc: BaseException) -> str | None:
    """Which of GM's lines the failure takes (person_line.STATUS_LINES), or None."""
    import httpx

    if isinstance(exc, httpx.HTTPStatusError):
        return None
    text = str(exc)
    category = classify_error(text)[0]
    if category == "blocked":
        return None
    lowered = text.lower()
    if (category == "quota" or any(marker in lowered for marker in _QUOTA_MARKERS)
            or "Overdue" in str(getattr(exc, "code", "") or "")):
        # BytePlus says an unpaid balance with a code, not a 402
        # (AccountOverdueError, OperationDenied.ServiceOverdue).
        return "credits"
    if _JOB_FAILED.match(text):
        return None  # the job ran: its error is about the job, not the key or the service
    status = http_status(exc)
    if status in (401, 403):
        return "key"
    if status == 402:
        return "credits"
    if status == 429:
        return "busy"
    if status is not None and 500 <= status <= 599:
        return "trouble"
    if category == "auth":
        return "missing" if any(marker in lowered for marker in _MISSING_KEY) else "key"
    if category == "rate_limit":
        return "busy"
    if _NO_RESULT.search(text):
        return "no_result"
    return None


def _named_key(text: str) -> str | None:
    for name, key in _TEXT_PROVIDERS:
        if text.startswith(name) and (len(text) == len(name) or not text[len(name)].isalpha()):
            return key
    return None


def _route(definition_id: str, params: Mapping[str, Any], api_keys: Mapping[str, Any]):
    from execution.maker_routes import definition_for
    from services import node_route

    return node_route.select_route(definition_for(definition_id), params, api_keys)


def provider_line(exc: BaseException, definition_id: str, params: Mapping[str, Any],
                  api_keys: Mapping[str, Any]) -> str | None:
    """GM's line for a provider's answer, naming the provider the run called;
    None when Nebula can't tell the failure or the provider."""
    kind = failure_kind(exc)
    if kind is None:
        return None
    try:
        route = _route(definition_id, params, api_keys)
    except Exception:
        route = None
    from services import node_route

    on_plan = route is not None and route.kind == node_route.PLAN
    key = _named_key(str(exc)) or (route.key if route is not None else None)
    if key is None and on_plan:
        provider, credential = "Krea", None
    else:
        named = key_name(key) if key else None
        if named is None:
            return None
        provider, credential = named
    if kind in ("key", "missing"):
        if on_plan or credential is None:
            return None  # the signed-in Krea plan has no key to check
        return status_line(kind, provider, credential)
    return status_line(kind, provider)


def card_line(exc: BaseException, definition_id: str, params: Mapping[str, Any] | None,
              api_keys: Mapping[str, Any] | None) -> CardLine:
    """The card's line for a run error: the handler's own, else the table's
    for a provider's answer (with its text behind Details), else none."""
    own = person_line(exc)
    if own:
        return CardLine(own, carries_provider_text(exc))
    try:
        line = provider_line(exc, definition_id, params or {}, api_keys or {})
    except Exception:  # the card's line must never break a run's error
        line = None
    return CardLine(line, True) if line else CardLine(None, False)


__all__ = ["CardLine", "KEY_NAMES", "card_line", "failure_kind", "http_status", "provider_line"]
