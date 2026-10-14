"""jev-decide: one typed question to TypeSafe Jev about text and images.

The question is a yes/no (Noul), a pick-one (Choice) or a rating (Score).
Jev returns probabilities rather than prose, so the node reports the answer,
how likely it is, how confident Jev is, and a pass verdict that turns
"unsure" below ``min_confidence`` instead of passing silently.

It is also a gate. Whatever is wired into ``through`` comes out of exactly
one of ``on_pass`` / ``on_fail`` (the pass verdict when nothing is wired),
and the other port is withheld, so the engine skips the nodes wired to it
(execution/gating.py). ``when_unsure`` picks the branch for an unsure
verdict: fail (default), pass, or neither (both withheld).

Output formats are the shared Jev contract in services/jev_outputs.py and
docs/api-guides/typesafe.md. Request building, image preparation, retries
and error messages live in services/typesafe_client.py.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from execution.gating import withheld
from execution.missing_credential import MissingCredentialError
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services import jev_outputs as out
from services.typesafe_client import (
    CREDENTIAL,
    ChoiceOptions,
    PreparedImage,
    check_model,
    noul_confidence,
    prepare_images,
    read_score,
    score_criteria,
    split_lines,
    system_one,
)

ANSWER_TYPES = {"yes_no": "yes/no", "choice": "choice", "score": "score"}
QUESTION_ID = "decide"
WHEN_UNSURE = ("fail", "pass", "neither")
NAME = "Jev Decide"


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


def _flag(raw: Any) -> bool:
    """On only for the values the price table reads as on (model_pricing's
    row match: True or "true"). Anything looser ("yes", 1) would send the
    long-context header while the spend check priced the cheaper row."""
    return raw is True or raw == "true"


def _context_text(inputs: dict[str, PortValueDict]) -> str:
    entry = inputs.get("state")
    if entry is None or entry.value in (None, ""):
        return ""
    value = entry.value
    if isinstance(value, list):
        return "\n\n".join(str(item) for item in value if item not in (None, ""))
    return str(value)


def _image_values(inputs: dict[str, PortValueDict]) -> list[Any]:
    entry = inputs.get("images")
    if entry is None or entry.value in (None, ""):
        return []
    return list(entry.value) if isinstance(entry.value, list) else [entry.value]


def gate_outputs(verdict: str, when_unsure: str, through: PortValueDict | None, *,
                 answer: str, probability: str, confidence: str, min_confidence: str) -> dict[str, Any]:
    """``on_pass`` and ``on_fail``: one carries ``through`` (or the verdict
    text), the other is withheld with a reason naming the decision."""
    if verdict == "unsure":
        reason = f"{NAME} was unsure (confidence {confidence}, below {min_confidence})"
        branch = when_unsure
        if branch != "neither":
            reason += f"; unsure counts as {branch}"
    else:
        branch = "pass" if verdict == "true" else "fail"
        shown = answer if len(answer) <= 60 else answer[:59] + "…"
        reason = f"{NAME} {'passed' if branch == 'pass' else 'failed'} (answered {shown}, {probability})"
    if through is not None and through.value is not None:
        carried = {"type": through.type, "value": through.value}
    else:
        carried = out.text(verdict)
    return {
        "on_pass": carried if branch == "pass" else withheld(reason),
        "on_fail": carried if branch == "fail" else withheld(reason),
    }


def build_state(context: str, images: list[PreparedImage]) -> Any:
    """Plain text when there are no images; otherwise an object holding the
    context and the image placeholders, each exactly once. A question can say
    `image` (or `images[0]`, `images[1]` ...) to point at one."""
    if not images:
        return context
    state: dict[str, Any] = {}
    if context:
        state["context"] = context
    if len(images) == 1:
        state["image"] = images[0].placeholder
    else:
        state["images"] = [image.placeholder for image in images]
    return state


async def handle_jev_decide(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get(CREDENTIAL)
    if not api_key:
        raise MissingCredentialError(f"{CREDENTIAL} is required")

    params = node.params
    question_text = str(params.get("question") or "").strip()
    if not question_text:
        raise ValueError("Jev Decide needs a question")
    answer_type = str(params.get("answer_type") or "yes_no")
    if answer_type not in ANSWER_TYPES:
        raise ValueError(f"answer_type must be one of {', '.join(ANSWER_TYPES)}, got {answer_type!r}")
    model = check_model(params.get("model"))
    threshold = _fraction(params.get("threshold"), 0.5, "threshold")
    min_confidence = _fraction(params.get("min_confidence"), 0.5, "min_confidence")
    long_context = _flag(params.get("long_context"))
    when_unsure = str(params.get("when_unsure") or "fail")
    if when_unsure not in WHEN_UNSURE:
        raise ValueError(f"when_unsure must be one of {', '.join(WHEN_UNSURE)}, got {when_unsure!r}")

    question: dict[str, Any] = {"instructions": question_text}
    choice: ChoiceOptions | None = None
    levels: list[str] = []
    passing: list[str] = []
    if answer_type == "yes_no":
        question["type"] = "noul"
        criteria = {key: str(params.get(param) or "").strip()
                    for key, param in (("true", "yes_means"), ("false", "no_means"))}
        criteria = {key: value for key, value in criteria.items() if value}
        if criteria:
            question["criteria"] = criteria
    elif answer_type == "choice":
        choice = ChoiceOptions.from_labels(split_lines(params.get("options")))
        passing = split_lines(params.get("pass_when"))
        unknown = [label for label in passing if label not in choice.labels]
        if unknown:
            raise ValueError(f"pass_when names {unknown[0]!r}, which isn't one of the options")
        question.update(type="choice", criteria=choice.criteria())
    else:
        levels = score_criteria(split_lines(params.get("levels")))
        question.update(type="score", criteria=levels)

    context = _context_text(inputs)
    images = await prepare_images(_image_values(inputs), label="Image")
    if not context and not images:
        raise ValueError("Jev Decide needs something to judge: connect Context text, Images, or both")

    result = await system_one(
        api_key, model=model, state=build_state(context, images),
        questions={QUESTION_ID: question}, images=images, long_context=long_context,
    )

    fields: list[tuple[str, Any]] = [("Question", question_text)]
    notes: list[str] = []
    if answer_type == "yes_no":
        probability = result.answer(QUESTION_ID, "noul").noul or 0.0
        answer = "yes" if probability >= 0.5 else "no"
        confidence = noul_confidence(probability)
        passed = probability >= threshold
        probabilities = {"yes": probability, "no": 1.0 - probability}
    elif answer_type == "choice":
        assert choice is not None
        reading = choice.read(result.answer(QUESTION_ID, "choice"))
        answer, probability, confidence = reading.label, reading.probability, reading.confidence
        probabilities = reading.probabilities
        # Without passing options, pass only says the answer is confident enough to use.
        passed = answer in passing if passing else True
        fields.append(("Options", len(choice.labels)))
    else:
        score = read_score(result.answer(QUESTION_ID, "score"), levels)
        answer, probability, confidence = score.label, score.normalized, score.confidence
        probabilities = score.probabilities
        passed = score.normalized >= threshold
        fields.append(("Score", f"{out.format_number(score.score)} on 0..{len(levels) - 1}"))

    verdict = out.verdict(passed, confidence, min_confidence)
    fields += [
        ("Answer", answer),
        ("Pass", verdict),
        ("Probability", out.format_number(probability)),
        ("Confidence", out.format_number(confidence)),
    ]
    if verdict == "unsure":
        notes.append(f"Confidence {out.format_number(confidence)} is below the minimum "
                     f"{out.format_number(min_confidence)}, so pass is unsure.")
        if answer_type == "choice":
            notes.append("Jev can lean toward the first option when options are close; "
                         "reorder them to check.")
    for index, image in enumerate(images):
        transform = image.transform
        if transform.transposed or transform.frames > 1 or transform.padded:
            notes.append(f"Image {index + 1}: {transform.describe()}.")

    gate = gate_outputs(
        verdict, when_unsure, inputs.get("through"), answer=answer,
        probability=out.format_number(probability), confidence=out.format_number(confidence),
        min_confidence=out.format_number(min_confidence),
    )
    return {
        "answer": out.text(answer),
        "pass": out.text(verdict),
        "probability": out.text(out.format_number(probability)),
        "confidence": out.text(out.format_number(confidence)),
        "probabilities": out.text(out.probabilities_json(probabilities)),
        "report": out.text(out.report(
            f"Jev Decide ({ANSWER_TYPES[answer_type]})", fields,
            model=result.model, requested_model=result.requested_model,
            input_tokens=result.input_tokens, images=len(images),
            request_id=result.request_id, notes=notes,
        )),
        **gate,
    }
