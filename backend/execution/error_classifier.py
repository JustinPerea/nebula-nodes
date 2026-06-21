"""Classify raw provider error strings into a friendly, categorized message.

Pure and exception-proof: any internal failure falls back to
``("unknown", <truncated raw>, False)``. The execution engine calls this to
enrich ``ErrorEvent`` so the UI can show a calm, actionable message — especially
for provider safety/moderation rejections — while always preserving the raw
error for debugging.

Categories: blocked, auth, quota, rate_limit, timeout, network, invalid_input, unknown.
"""

from __future__ import annotations

# Order of the checks below matters. BLOCKED is matched before the generic 4xx /
# invalid-input buckets so that a 400 carrying a moderation marker is reported as
# "blocked" rather than "invalid_input". Prefer explicit provider markers over
# the bare word "safety" to avoid mis-bucketing a genuine bad-parameter 400.
_BLOCKED_MARKERS = (
    "moderation_blocked",
    "moderation",
    "content_policy",
    "content policy",
    "content_filter",
    "content filter",
    "safety filter",
    "safety system",
    "safety guidelines",
    "blockreason",
    "block_reason",
    "prohibited_content",
    "prohibited content",
    "responsibleai",
    "responsible ai",
    "flagged as inappropriate",
    "nsfw",
    "sensitive content",
    "usage policies",
    "rejected as a result of our safety",
)
_RATE_MARKERS = (
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "429",
    "overloaded",
)
_AUTH_MARKERS = (
    "invalid api key",
    "incorrect api key",
    "no api key",
    "missing api key",
    "api key not",
    "invalid x-api-key",
    "no auth credentials",
    "unauthorized",
    "authentication failed",
    "authentication error",
    "401",
)
_QUOTA_MARKERS = (
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "insufficient credit",
    "insufficient credits",
    "out of credits",
    "billing",
    "payment required",
    "402",
)
_TIMEOUT_MARKERS = (
    "timed out",
    "timeout",
    "deadline exceeded",
    "etimedout",
)
_NETWORK_MARKERS = (
    "connection error",
    "connection refused",
    "connection reset",
    "econnrefused",
    "name resolution",
    "failed to establish a new connection",
    "max retries exceeded",
    "network is unreachable",
)
_INVALID_MARKERS = (
    "must be",
    "is required",
    "unsupported",
    "is not one of",
    "bad request",
    "validation error",
    "invalid",
    "400",
    "422",
)

_FRIENDLY = {
    "blocked": (
        "This request was blocked by the provider's safety filter. "
        "Try rephrasing your prompt or removing flagged content."
    ),
    "auth": "The API key was rejected. Check your key for this provider in Settings.",
    "quota": (
        "The provider's quota or credits are exhausted. "
        "Check your plan or billing with the provider."
    ),
    "rate_limit": "Rate limited by the provider. Wait a moment and run again.",
    "timeout": "The provider took too long to respond. Try again.",
    "network": "Couldn't reach the provider. Check your connection and try again.",
    "invalid_input": (
        "The request was rejected as invalid. Check the node's inputs and parameters."
    ),
}

_RETRYABLE = frozenset({"rate_limit", "timeout", "network"})


def classify_error(raw: str | None) -> tuple[str, str, bool]:
    """Return ``(category, friendly_message, retryable)``. Never raises.

    For ``unknown`` the friendly message is a truncated copy of the raw error so
    nothing is lost; for known categories it is a stable, calm sentence.
    """
    try:
        if not raw:
            return ("unknown", "Something went wrong.", False)
        text = str(raw).lower()

        def has(markers: tuple[str, ...]) -> bool:
            return any(m in text for m in markers)

        if has(_BLOCKED_MARKERS):
            category = "blocked"
        elif has(_RATE_MARKERS):
            category = "rate_limit"
        elif has(_AUTH_MARKERS):
            category = "auth"
        elif has(_QUOTA_MARKERS):
            category = "quota"
        elif has(_TIMEOUT_MARKERS):
            category = "timeout"
        elif has(_NETWORK_MARKERS):
            category = "network"
        elif has(_INVALID_MARKERS):
            category = "invalid_input"
        else:
            category = "unknown"

        if category == "unknown":
            friendly = str(raw).strip()[:140] or "Something went wrong."
        else:
            friendly = _FRIENDLY[category]
        return (category, friendly, category in _RETRYABLE)
    except Exception:  # pragma: no cover - defensive; classifier must never throw
        try:
            return ("unknown", str(raw)[:140], False)
        except Exception:
            return ("unknown", "Something went wrong.", False)
