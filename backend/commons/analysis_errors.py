"""Why a Commons analysis failed, as a kind the person's UI can say in words.

GM - Design, error-copy round 3: heading "Couldn't analyze this reference."
over a reason mapped from last_error's kind:
  - network, timeout or provider 5xx -> "The analysis service didn't respond."  (UNAVAILABLE)
  - the model refused or couldn't read the image -> "The analyzer couldn't read this image."  (UNREADABLE)
  - anything else -> "Something went wrong during analysis."  (OTHER)

The kind is decided where the analysis fails (worker.py, reader.py,
intake.py's video probe) and stored next to last_error in
assets.last_error_kind. A row written before that column says the kind its
last_error text names: every last_error is one of this backend's own
messages, so the prefixes below are exact, and anything else is OTHER.
last_error itself is unchanged (agents and the UI's Details toggle read it).
"""
from __future__ import annotations

import asyncio
import re

UNAVAILABLE = "unavailable"
UNREADABLE = "unreadable"
OTHER = "other"
KINDS = (UNAVAILABLE, UNREADABLE, OTHER)

# A provider's answer that says it is down, overloaded or slow, or a dropped
# connection, as the claude CLI writes it into its result ("API Error: 529
# Overloaded", "Request timed out", "Connection error.").
_UNAVAILABLE_TEXT = re.compile(
    r"\b(5\d\d|overloaded|timed? ?out|timeout|connection (error|refused|reset)|network|"
    r"service unavailable|bad gateway|temporarily unavailable|rate.?limit|ECONNRESET|ETIMEDOUT)\b",
    re.IGNORECASE)
_REFUSAL_TEXT = re.compile(r"\b(refus|can'?t help|cannot help|unable to (describe|process|view|see)|"
                           r"could ?n[o']t (read|view|see|process)|safety|policy)", re.IGNORECASE)


def classify_exception(exc: BaseException) -> str:
    """The kind for an exception a reader raised."""
    try:
        import httpx
    except ImportError:  # pragma: no cover - httpx is a backend requirement
        httpx = None  # type: ignore[assignment]
    if httpx is not None:
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            return UNAVAILABLE if status >= 500 or status in (408, 429) else OTHER
        if isinstance(exc, (httpx.TransportError, httpx.TimeoutException)):
            return UNAVAILABLE
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError, ConnectionError)):
        return UNAVAILABLE
    return OTHER


def classify_provider_text(text: str | None) -> str | None:
    """UNAVAILABLE when a provider's error text says it is down or slow, else None."""
    return UNAVAILABLE if text and _UNAVAILABLE_TEXT.search(text) else None


def looks_like_refusal(text: str | None) -> bool:
    return bool(text and _REFUSAL_TEXT.search(text))


# This backend's own last_error texts, by the prefix each is written with.
_TEXT_KINDS = (
    ("reader timed out", UNAVAILABLE),
    ("cannot start claude", UNAVAILABLE),
    ("no result event", UNAVAILABLE),
    ("cannot load image", UNREADABLE),
    ("video probe failed", UNREADABLE),
)


def classify_text(error: str | None) -> str | None:
    """The kind for a stored last_error with no kind (a row from before the
    column): None for no error, else the kind its text names, else OTHER."""
    if not error:
        return None
    for prefix, kind in _TEXT_KINDS:
        if error.startswith(prefix):
            return kind
    if error.startswith("reader crashed:") or error.startswith("reader error:"):
        return classify_provider_text(error) or OTHER
    return OTHER


def kind_of(asset: dict) -> str | None:
    """The asset's kind as the detail shows it: the stored one, else from its text."""
    if not asset.get("last_error"):
        return None
    stored = asset.get("last_error_kind")
    return stored if stored in KINDS else classify_text(asset.get("last_error"))
