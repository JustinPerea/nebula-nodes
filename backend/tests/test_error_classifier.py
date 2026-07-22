from __future__ import annotations

import pytest

from execution.error_classifier import classify_error


@pytest.mark.parametrize(
    "raw,expected_category,expected_retryable",
    [
        # --- blocked / safety / moderation (must win over generic 4xx) ---
        ("Your request was rejected as a result of our safety system.", "blocked", False),
        ("Async job failed: moderation", "blocked", False),
        ("400 Bad Request: PROHIBITED_CONTENT blockReason", "blocked", False),
        ("Image flagged as inappropriate (content_policy)", "blocked", False),
        ("Generation failed: NSFW content detected", "blocked", False),
        # --- rate limit ---
        ("429 Too Many Requests", "rate_limit", True),
        ("Rate limit exceeded, please slow down", "rate_limit", True),
        ("The engine is currently overloaded", "rate_limit", True),
        # --- auth ---
        ("401 Unauthorized: invalid api key", "auth", False),
        ("Incorrect API key provided", "auth", False),
        # --- quota / billing ---
        ("You exceeded your current quota (insufficient_quota)", "quota", False),
        ("402 Payment Required: insufficient credits", "quota", False),
        # --- timeout ---
        ("Request timed out after 60s", "timeout", True),
        ("upstream deadline exceeded", "timeout", True),
        # --- network ---
        ("Connection refused (ECONNREFUSED)", "network", True),
        ("Max retries exceeded with url", "network", True),
        # --- invalid input (generic 4xx WITHOUT a moderation marker) ---
        ("Parameter 'aspect_ratio' must be one of 16:9, 1:1", "invalid_input", False),
        ("422 Unprocessable Entity: validation error", "invalid_input", False),
        # --- unknown ---
        ("totally opaque provider explosion", "unknown", False),
    ],
)
def test_classify_category(raw: str, expected_category: str, expected_retryable: bool) -> None:
    category, friendly, retryable = classify_error(raw)
    assert category == expected_category
    assert isinstance(friendly, str) and friendly
    assert retryable is expected_retryable


def test_generic_billing_word_is_not_quota() -> None:
    # The bare word "billing" must not over-classify unrelated errors as quota.
    category, _, _ = classify_error("Invalid billing address: postal code required")
    assert category != "quota"


def test_blocked_beats_400() -> None:
    # A 400 that carries a moderation marker must classify as blocked, not invalid_input.
    category, _, _ = classify_error("400 Bad Request: content_policy violation")
    assert category == "blocked"


def test_capability_guardrail_preserves_actionable_message() -> None:
    raw = "Gemini Omni capability guardrail: use Veo 3.1 for video extension."
    category, friendly, retryable = classify_error(raw)
    assert category == "invalid_input"
    assert friendly == raw
    assert retryable is False


def test_unknown_preserves_truncated_raw() -> None:
    raw = "x" * 500
    _, friendly, _ = classify_error(raw)
    assert friendly == "x" * 140


def test_never_raises_on_bad_input() -> None:
    for bad in (None, "", 12345):  # type: ignore[list-item]
        category, friendly, retryable = classify_error(bad)  # type: ignore[arg-type]
        assert isinstance(category, str)
        assert isinstance(friendly, str)
        assert isinstance(retryable, bool)
