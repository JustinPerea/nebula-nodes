"""Classify raw provider error strings into a friendly, categorized message.

Pure and exception-proof: any internal failure falls back to
``("unknown", <truncated raw>, False)``. The execution engine calls this to
enrich ``ErrorEvent`` so the UI can show a calm, actionable message — especially
for provider safety/moderation rejections — while always preserving the raw
error for debugging.

Categories: blocked, auth, quota, rate_limit, timeout, network, invalid_input, unknown.
"""

from __future__ import annotations

import re

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
)
_QUOTA_MARKERS = (
    "insufficient_quota",
    "insufficient quota",
    "exceeded your current quota",
    "insufficient credit",
    "insufficient credits",
    "insufficient balance",
    "out of credits",
    "billing hard limit",
    "billing_hard_limit",
    "check your plan and billing",
    "payment required",
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
    # A TLS error mid-response reaches a handler as a raw ssl.SSLError
    # (services/http_errors.py), e.g. "[SSL: SSLV3_ALERT_BAD_RECORD_MAC] ...".
    "bad record mac",
    "decryption failed",
    "ssl/tls alert",
    "record layer failure",
)
_INVALID_MARKERS = (
    "must be",
    "is required",
    "unsupported",
    "is not one of",
    "bad request",
    "validation error",
    "invalid",
)
# A status code counts only standing on its own: "429" inside 4294967295 (a
# seed range) is not a rate limit, nor "401" inside frame 14012 a bad key.
_STATUS_CODES = {
    "rate_limit": ("429",),
    "auth": ("401",),
    "quota": ("402",),
    "invalid_input": ("400", "422"),
}

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


def classify_error(raw: str | None, *, job_failure: bool = False) -> tuple[str, str, bool]:
    """Return ``(category, friendly_message, retryable)``. Never raises.

    For ``unknown`` the friendly message is a truncated copy of the raw error so
    nothing is lost; for known categories it is a stable, calm sentence.

    ``job_failure``: the error is a terminal job failure (the provider took
    the job, then reported it failed; execution/person_line.as_job_failure).
    The key already worked, so it is never ``auth``, whatever its text says
    ("unauthorized to fetch input" is about the job's input); its other
    categories stay (round 3d, part 2). Callers pass
    ``is_job_failure(exc)``.
    """
    try:
        if not raw:
            return ("unknown", "Something went wrong.", False)
        text = str(raw).lower()

        def code(category: str) -> bool:
            return any(re.search(rf"(?<!\d){c}(?!\d)", text) for c in _STATUS_CODES[category])

        def has(markers: tuple[str, ...], category: str | None = None) -> bool:
            return any(m in text for m in markers) or (category is not None and code(category))

        if "capability guardrail:" in text:
            return ("invalid_input", str(raw).strip(), False)
        if has(_BLOCKED_MARKERS):
            category = "blocked"
        elif has(_RATE_MARKERS, "rate_limit"):
            category = "rate_limit"
        elif not job_failure and has(_AUTH_MARKERS, "auth"):
            category = "auth"
        elif has(_QUOTA_MARKERS, "quota"):
            category = "quota"
        elif has(_TIMEOUT_MARKERS):
            category = "timeout"
        elif has(_NETWORK_MARKERS):
            category = "network"
        elif has(_INVALID_MARKERS, "invalid_input"):
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
