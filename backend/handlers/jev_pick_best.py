"""jev-pick-best: TypeSafe Jev picks the best of several candidate images.

One Choice question whose options are the candidates themselves: each
option's description is just that image's placeholder, under a neutral key
(a, b, c ...), so nothing in an option name can steer the pick. Each image is
referenced exactly once, so it is sent and billed once.

The node takes at most MAX_CANDIDATES. A live probe (2026-10-14) measured
about 2,780 input tokens per 1024 px candidate (11,427 for four), so ten
1024 px candidates come to about 28k, under the 32k per-question limit.
Larger candidates cost more. When a request is over the context limit, the
node sends the candidates once more at a smaller size and says so in the
report.

The ``winner`` output is the winning candidate's original value, never the
resized copy that was sent. Output formats are the shared Jev contract in
services/jev_outputs.py and docs/api-guides/typesafe.md.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services import jev_outputs as out
from services.typesafe_client import (
    CREDENTIAL,
    ChoiceOptions,
    PreparedImage,
    TypeSafeError,
    check_model,
    prepare_images,
    system_one,
)

QUESTION_ID = "pick"
DEFAULT_QUESTION = "Which image best matches the brief?"
# Ten 1024 px candidates measured at about 28k tokens of the 32k per question.
MAX_CANDIDATES = 10
# Long side for the one retry after max_tokens_exceeded.
RETRY_SIDE = 768
# Sent as the state when no brief is connected, so the request always has one.
NO_BRIEF = "No brief was given. Judge the candidate images by the question alone."


def _fraction(raw: Any, default: float, name: str) -> float:
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number from 0 to 1, got {raw!r}") from None
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be from 0 to 1, got {value}")
    return value


def _brief_text(inputs: dict[str, PortValueDict]) -> str:
    entry = inputs.get("brief")
    if entry is None or entry.value in (None, ""):
        return ""
    value = entry.value
    if isinstance(value, list):
        return "\n\n".join(str(item) for item in value if item not in (None, "")).strip()
    return str(value).strip()


def candidate_values(inputs: dict[str, PortValueDict]) -> list[Any]:
    entry = inputs.get("candidates")
    if entry is None or entry.value in (None, ""):
        return []
    values = entry.value if isinstance(entry.value, list) else [entry.value]
    return [value for value in values if value not in (None, "")]


def build_question(question: str, options: ChoiceOptions, images: list[PreparedImage]) -> dict[str, Any]:
    """One Choice over the candidates: neutral key -> that image's placeholder."""
    return {"type": "choice", "instructions": question,
            "criteria": options.criteria([image.placeholder for image in images])}


def _over_context(exc: TypeSafeError) -> bool:
    return exc.status == 400 and "max_tokens_exceeded" in f"{exc.code or ''} {exc}"


async def handle_jev_pick_best(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get(CREDENTIAL)
    if not api_key:
        raise MissingCredentialError(f"{CREDENTIAL} is required")

    params = node.params
    question = str(params.get("question") or "").strip() or DEFAULT_QUESTION
    model = check_model(params.get("model"))
    min_confidence = _fraction(params.get("min_confidence"), 0.5, "min_confidence")

    values = candidate_values(inputs)
    if len(values) < 2:
        raise ValueError(f"Jev Pick Best needs at least two candidate images, got {len(values)}")
    if len(values) > MAX_CANDIDATES:
        raise ValueError(
            f"Jev Pick Best takes at most {MAX_CANDIDATES} candidates, got {len(values)}. Each 1024 px "
            "candidate is about 2,800 tokens, so larger sets may not fit one request. Split them "
            "across two Pick Best nodes and pick again between the winners.")
    brief = _brief_text(inputs)
    state = brief or NO_BRIEF
    options = ChoiceOptions.from_labels([str(index) for index in range(len(values))])

    notes: list[str] = []
    images = await prepare_images(values, label="Candidate", max_images=MAX_CANDIDATES)
    try:
        result = await system_one(api_key, model=model, state=state,
                                  questions={QUESTION_ID: build_question(question, options, images)},
                                  images=images)
    except TypeSafeError as exc:
        if not _over_context(exc):
            raise
        # Over the context limit at full size: send everything once more,
        # smaller. New placeholders come with the new copies.
        images = await prepare_images(values, label="Candidate", max_images=MAX_CANDIDATES, max_side=RETRY_SIDE)
        try:
            result = await system_one(api_key, model=model, state=state,
                                      questions={QUESTION_ID: build_question(question, options, images)},
                                      images=images)
        except TypeSafeError as retry_exc:
            if not _over_context(retry_exc):
                raise
            raise TypeSafeError(
                f"TypeSafe: {len(values)} candidates are over the model's context even at {RETRY_SIDE} px "
                "(400 max_tokens_exceeded). Split them across two Pick Best nodes and pick again between "
                "the winners, or shorten the brief.",
                status=retry_exc.status, code=retry_exc.code, request_id=retry_exc.request_id) from None
        notes.append(f"The first request was over the context limit, so the candidates were sent again "
                     f"at {RETRY_SIDE} px on the long side.")

    reading = options.read(result.answer(QUESTION_ID, "choice"))
    winner = values[reading.index]

    fields: list[tuple[str, Any]] = [("Question", question)]
    if brief:
        fields.append(("Brief", brief))
    fields += [
        ("Candidates", len(values)),
        ("Winner", reading.index),
        ("Probability", out.format_number(reading.probability)),
        ("Confidence", out.format_number(reading.confidence)),
    ]
    if reading.confidence < min_confidence:
        notes.append(f"Confidence {out.format_number(reading.confidence)} is below the minimum "
                     f"{out.format_number(min_confidence)}: the candidates are close, so any would do.")
        notes.append("Jev can lean toward the first option when options are close; reorder the "
                     "candidates to check.")
    for index, image in enumerate(images):
        transform = image.transform
        if transform.transposed or transform.frames > 1 or transform.padded:
            notes.append(f"Candidate at index {index}: {transform.describe()}.")

    return {
        "winner": {"type": "Image", "value": winner},
        "index": out.text(str(reading.index)),
        "probabilities": out.text(out.probabilities_json(reading.probabilities)),
        "confidence": out.text(out.format_number(reading.confidence)),
        "report": out.text(out.report(
            "Jev Pick Best", fields,
            model=result.model, requested_model=result.requested_model,
            input_tokens=result.input_tokens, images=len(images),
            request_id=result.request_id, notes=notes,
        )),
    }
