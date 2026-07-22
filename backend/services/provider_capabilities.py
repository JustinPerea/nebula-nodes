"""Provider capability checks that must run before a paid request is sent.

The checks in this module are deliberately conservative. They only reject
prompts that clearly ask for a capability the selected provider documents as
unsupported; ambiguous creative language continues to the provider unchanged.
"""

from __future__ import annotations

import re


GEMINI_OMNI_EXTENSION_ERROR = (
    "Gemini Omni capability guardrail: Gemini Omni can edit an existing video "
    "in place, but it cannot extend the video's duration. Rephrase this as an "
    "edit (for example, 'Change the lighting and keep everything else the same') "
    "or use Veo 3.1 for video extension."
)


_VIDEO_EXTENSION_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bextend(?:ing)?\s+(?:(?:this|the|my|our)\s+)?(?:(?:same|existing|current)\s+)?(?:video|clip|footage|runtime|duration)\b(?=\s*(?:$|[.!?:,]|(?:by|for|with|to|of|beyond|another|until)\b))",
        r"\bcontinue\s+(?:(?:this|the|my|our)\s+)?(?:(?:same|existing|current)\s+)?(?:video|clip|footage)\b(?=\s*(?:$|[.!?:,]|(?:by|for|with|to|from|after|into|until)\b))",
        r"\bcontinue\s+(?:from|where)\b.{0,48}\b(?:left off|ends?|last frame)\b",
        r"\bmake\s+(?:(?:this|the|my|our)\s+)?(?:(?:same|existing|current)\s+)?(?:video|clip|footage)\s+(?:(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds?|minutes?)\s+)?longer\b",
        r"\badd\s+(?:(?:another|an extra)\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a few|several|more)\s+(?:more\s+)?(?:seconds?|minutes?)\b",
        r"\bappend\s+(?:(?:a|an|another|new|extra|final|closing)\s+){0,3}(?:scene|ending|video|clip|footage)\b",
        r"\b(?:after|beyond)\s+(?:the\s+)?(?:end|last frame)\b",
        r"\bkeep\s+(?:it|the video|the clip)\s+going\b",
        r"\bcarry\s+on\s+(?:the\s+)?(?:video|clip|footage)\b",
    )
)


def is_explicit_video_extension(prompt: str) -> bool:
    """Return true only for clear duration-extension instructions."""
    normalized = " ".join(str(prompt).split())
    if not normalized:
        return False
    return any(pattern.search(normalized) for pattern in _VIDEO_EXTENSION_PATTERNS)


def gemini_omni_capability_error(
    prompt: str,
    *,
    has_previous_interaction: bool = False,
    has_video_input: bool = False,
    task: str | None = None,
) -> str | None:
    """Return an actionable error for unsupported Gemini Omni requests.

    Extension language is only meaningful as a provider capability violation
    when the request is editing existing media. Fresh text-to-video prompts are
    not rejected merely because their prose contains words such as "continue."
    """
    has_edit_context = (
        has_previous_interaction
        or has_video_input
        or str(task or "").strip().lower() == "edit"
    )
    if has_edit_context and is_explicit_video_extension(prompt):
        return GEMINI_OMNI_EXTENSION_ERROR
    return None


def enforce_gemini_omni_capabilities(
    prompt: str,
    *,
    has_previous_interaction: bool = False,
    has_video_input: bool = False,
    task: str | None = None,
) -> None:
    """Raise before provider submission when a request is unsupported."""
    error = gemini_omni_capability_error(
        prompt,
        has_previous_interaction=has_previous_interaction,
        has_video_input=has_video_input,
        task=task,
    )
    if error:
        raise ValueError(error)
