"""Jev mode for the Video QC nodes: every check is one typed TypeSafe question.

The other QC modes measure pixels (heuristic, opencv) or ask a vision LLM for
a JSON blob (vision-llm). Jev mode asks TypeSafe Jev one atomic question per
check (a yes/no Noul, a pick-one Choice or a Score) over the sampled frames,
and reads back probabilities instead of prose. Each handler keeps its local
metrics as the baseline, then overwrites the fields a Jev check answers, so
the report keeps the same shape in every mode.

Rules every QC node follows here:

- Each frame goes in the request ``state`` once, under a name such as
  ``frame_3``. Questions refer to frames by name, so a frame is never sent
  twice however many checks use it.
- At most MAX_FRAMES frames, downscaled to FRAME_LONG_SIDE, so the frames and
  the longest question stay inside TypeSafe's 32k-token per-question limit
  (see FRAME_TOKEN_BUDGET). The report says which samples were sent.
- The overall verdict gates on the minimum: it is "true" only when every
  must-pass check passes, "false" when any fails, else "unsure". A check
  whose confidence is below ``min_confidence`` is "unsure", never a pass.
- Every check is in one request, priced per request like the other Jev nodes.

Image input is experimental at TypeSafe; every report says so.
"""
from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Sequence

from PIL import Image

from execution.missing_credential import MissingCredentialError
from services import jev_outputs as out
from services.typesafe_client import (
    CREDENTIAL,
    DEFAULT_MODEL,
    ChoiceOptions,
    JevResult,
    PreparedImage,
    check_model,
    noul_confidence,
    prepare_images,
    read_score,
    score_criteria,
    system_one,
)

JEV_MODE = "jev"
MAX_FRAMES = 8
FRAME_LONG_SIDE = 768
# TypeSafe hasn't published how many tokens an image costs. Budget as if each
# 16x16 pixel patch were one token (probably high), and keep every image the
# request carries under 24k of the 32k per question, leaving room for text.
# Eight 768 px frames plus a reference come to at most ~21k on that estimate.
TOKEN_PATCH = 16
FRAME_TOKEN_BUDGET = 24_000
DEFAULT_MIN_CONFIDENCE = 0.5

# Check verdicts. A must-pass check gates the overall verdict; "n/a" means
# the check didn't apply (no face to compare, say) and is left out of it.
PASS, FAIL, UNSURE, NOT_APPLICABLE = "true", "false", "unsure", "n/a"


@dataclass(frozen=True)
class Setup:
    api_key: str
    model: str
    min_confidence: float


def setup(params: Mapping[str, Any], api_keys: Mapping[str, str]) -> Setup:
    """Read the Jev params and the key before any frame is cut: no key is a
    MissingCredentialError, a bad model or min_confidence a ValueError."""
    key = api_keys.get(CREDENTIAL) or ""
    if not key:
        raise MissingCredentialError(f"{CREDENTIAL} is required for Jev mode")
    model = check_model(params.get("model") or DEFAULT_MODEL)
    raw = params.get("min_confidence")
    if raw is None or raw == "":
        return Setup(key, model, DEFAULT_MIN_CONFIDENCE)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"min_confidence must be a number from 0 to 1, got {raw!r}") from None
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"min_confidence must be from 0 to 1, got {value}")
    return Setup(key, model, value)


# -- frames --------------------------------------------------------------------


def pick_frames(count: int, cap: int = MAX_FRAMES) -> list[int]:
    """Up to ``cap`` evenly spaced indices into ``count`` samples, always
    including the first and the last."""
    if count <= cap:
        return list(range(count))
    if cap <= 1:
        return [0]
    step = (count - 1) / (cap - 1)
    return sorted({round(index * step) for index in range(cap)})


def estimated_tokens(width: int, height: int) -> int:
    return math.ceil(width / TOKEN_PATCH) * math.ceil(height / TOKEN_PATCH)


def _data_uri(image: Image.Image) -> str:
    frame = image.convert("RGB")
    frame.thumbnail((FRAME_LONG_SIDE, FRAME_LONG_SIDE), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    frame.save(buffer, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


@dataclass(frozen=True)
class Frames:
    """The images one Jev request carries, each named once in ``state``."""

    names: tuple[str, ...]
    prepared: tuple[PreparedImage, ...]
    sampled: int  # frames the node sampled from the clip
    sent: tuple[int, ...]  # 1-based sample numbers that went to Jev
    estimated_tokens: int

    def state(self) -> dict[str, str]:
        return {name: image.placeholder for name, image in zip(self.names, self.prepared)}

    def note(self) -> str | None:
        if len(self.sent) >= self.sampled:
            return None
        return (f"Sent {len(self.sent)} of {self.sampled} sampled frames (samples "
                f"{', '.join(str(n) for n in self.sent)}): Jev mode caps frames at {MAX_FRAMES} so the "
                "frames and each question fit TypeSafe's 32k-token per-question limit.")


async def prepare_frames(
    frames: Sequence[Image.Image],
    *,
    indices: Sequence[int] | None = None,
    names: Sequence[str] | None = None,
    extras: Sequence[tuple[str, Image.Image]] = (),
) -> Frames:
    """Downscale and prepare sampled frames (``indices`` into ``frames``,
    default pick_frames) plus named extras such as a reference image.

    Frames are named ``frame_<sample number>`` unless ``names`` is given.
    Drops middle frames if the estimate runs over FRAME_TOKEN_BUDGET."""
    chosen = list(indices) if indices is not None else pick_frames(len(frames))
    if names is not None and len(names) != len(chosen):
        raise ValueError("one name per chosen frame")
    labels = list(names) if names is not None else [f"frame_{index + 1}" for index in chosen]
    while True:
        values = [_data_uri(frames[index]) for index in chosen] + [_data_uri(image) for _, image in extras]
        prepared = await prepare_images(values, label="Frame", max_images=MAX_FRAMES + max(1, len(extras)))
        tokens = sum(estimated_tokens(item.transform.sent_width, item.transform.sent_height) for item in prepared)
        if tokens <= FRAME_TOKEN_BUDGET or len(chosen) <= 2:
            break
        drop = len(chosen) // 2
        chosen.pop(drop)
        labels.pop(drop)
    return Frames(
        names=tuple(labels + [name for name, _ in extras]), prepared=tuple(prepared), sampled=len(frames),
        sent=tuple(index + 1 for index in chosen), estimated_tokens=tokens,
    )


def frame_list(names: Sequence[str]) -> str:
    """"`frame_1`, `frame_3` and `frame_5`" for a question."""
    quoted = [f"`{name}`" for name in names]
    if len(quoted) <= 1:
        return "".join(quoted)
    return f"{', '.join(quoted[:-1])} and {quoted[-1]}"


# -- checks --------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    """One atomic question. ``kind`` is "noul", "choice" or "score".

    - noul: ``pass_on`` is "yes" or "no" (the answer that passes);
      ``yes_means`` / ``no_means`` become the Noul criteria.
    - choice: ``options`` are (short label, description) pairs; Jev sees
      neutral keys a, b, c with the descriptions. ``passing`` labels pass,
      ``not_applicable`` labels mean the check didn't apply.
    - score: ``levels`` low to high; it passes when the normalized score is
      at most ``pass_at_most`` or at least ``pass_at_least``.

    A check with no pass rule (a descriptive Choice such as camera angle)
    has verdict None and never gates.
    """

    id: str
    kind: str
    instructions: str
    must_pass: bool = True
    pass_on: str | None = None
    yes_means: str = ""
    no_means: str = ""
    options: tuple[tuple[str, str], ...] = ()
    passing: tuple[str, ...] = ()
    not_applicable: tuple[str, ...] = ()
    levels: tuple[str, ...] = ()
    pass_at_most: float | None = None
    pass_at_least: float | None = None

    def choice(self) -> ChoiceOptions:
        return ChoiceOptions.from_labels([label for label, _ in self.options])

    def question(self) -> dict[str, Any]:
        question: dict[str, Any] = {"type": self.kind, "instructions": self.instructions}
        if self.kind == "noul":
            criteria = {key: text for key, text in (("true", self.yes_means), ("false", self.no_means)) if text}
            if criteria:
                question["criteria"] = criteria
        elif self.kind == "choice":
            question["criteria"] = self.choice().criteria([text for _, text in self.options])
        elif self.kind == "score":
            question["criteria"] = score_criteria(self.levels)
        else:
            raise ValueError(f"unknown check kind {self.kind!r}")
        return question

    @property
    def gates(self) -> bool:
        return self.must_pass and self._has_rule()

    def _has_rule(self) -> bool:
        if self.kind == "noul":
            return self.pass_on in ("yes", "no")
        if self.kind == "choice":
            return bool(self.passing)
        return self.pass_at_most is not None or self.pass_at_least is not None


@dataclass(frozen=True)
class CheckResult:
    check: Check
    answer: str  # "yes"/"no", the Choice label, or the Score level text
    probabilities: dict[str, float]
    confidence: float
    confident: bool  # confidence >= min_confidence
    verdict: str | None  # PASS, FAIL, UNSURE, NOT_APPLICABLE, or None (no pass rule)
    pass_probability: float | None  # chance the check passes, for gating checks
    value: float  # noul: p(yes); choice: winner probability; score: normalized 0..1
    level: int | None = None  # score only

    def probability(self, label: str) -> float:
        return self.probabilities.get(label, 0.0)

    def as_report(self) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "type": self.check.kind,
            "question": self.check.instructions,
            "must_pass": self.check.gates,
            "answer": self.answer,
            "confidence": out.rounded(self.confidence),
            "probabilities": {key: out.rounded(value) for key, value in self.probabilities.items()},
            "verdict": self.verdict,
        }
        if self.pass_probability is not None:
            entry["pass_probability"] = out.rounded(self.pass_probability)
        if self.check.kind == "score":
            entry["score"] = out.rounded(self.value)
        return entry


def _read(check: Check, result: JevResult, min_confidence: float) -> CheckResult:
    if check.kind == "noul":
        p_yes = result.answer(check.id, "noul").noul or 0.0
        confidence = noul_confidence(p_yes)
        answer = "yes" if p_yes >= 0.5 else "no"
        probabilities = {"yes": p_yes, "no": 1.0 - p_yes}
        pass_probability = (p_yes if check.pass_on == "yes" else 1.0 - p_yes) if check.gates else None
        passed = pass_probability is not None and pass_probability >= 0.5
        value, level = p_yes, None
        not_applicable = False
    elif check.kind == "choice":
        reading = check.choice().read(result.answer(check.id, "choice"))
        answer, confidence, probabilities = reading.label, reading.confidence, reading.probabilities
        pass_probability = sum(probabilities.get(label, 0.0) for label in check.passing) if check.gates else None
        passed = answer in check.passing
        value, level = reading.probability, None
        not_applicable = answer in check.not_applicable
    else:
        score = read_score(result.answer(check.id, "score"), check.levels)
        answer, confidence, probabilities = score.label, score.confidence, score.probabilities
        top = max(1, len(check.levels) - 1)

        def passes(normalized: float) -> bool:
            if check.pass_at_most is not None and normalized > check.pass_at_most:
                return False
            return check.pass_at_least is None or normalized >= check.pass_at_least

        pass_probability = (sum(p for index, p in enumerate(probabilities.values()) if passes(index / top))
                            if check.gates else None)
        passed = passes(score.normalized)
        value, level = score.normalized, score.level
        not_applicable = False
    confident = confidence >= min_confidence
    if not check.gates:
        verdict = None
    elif not_applicable and confident:
        verdict = NOT_APPLICABLE
    else:
        verdict = out.verdict(passed, confidence, min_confidence)
    return CheckResult(check=check, answer=answer, probabilities=probabilities, confidence=confidence,
                       confident=confident, verdict=verdict, pass_probability=pass_probability,
                       value=value, level=level)


@dataclass
class JevRun:
    """Every check's answer from one request, plus the overall gate."""

    results: dict[str, CheckResult]
    result: JevResult
    frames: Frames
    min_confidence: float
    notes: list[str] = field(default_factory=list)

    def __getitem__(self, check_id: str) -> CheckResult:
        return self.results[check_id]

    def get(self, check_id: str) -> CheckResult | None:
        return self.results.get(check_id)

    def set_not_applicable(self, check_id: str, reason: str) -> None:
        """Leave a check out of the gate because another answer showed it
        doesn't apply (no face, so no expression to compare)."""
        item = self.results[check_id]
        if item.check.gates:
            self.results[check_id] = replace(item, verdict=NOT_APPLICABLE)
            self.notes.append(f"{check_id} is not applicable: {reason}.")

    def gating(self) -> list[CheckResult]:
        return [item for item in self.results.values()
                if item.check.gates and item.verdict != NOT_APPLICABLE]

    @property
    def verdict(self) -> str | None:
        """Gate on the minimum: any fail fails, any unsure is unsure, None
        when no must-pass check applied."""
        gating = self.gating()
        if not gating:
            return None
        verdicts = {item.verdict for item in gating}
        if FAIL in verdicts:
            return FAIL
        if UNSURE in verdicts:
            return UNSURE
        return PASS

    @property
    def min_pass_probability(self) -> float | None:
        values = [item.pass_probability for item in self.gating() if item.pass_probability is not None]
        return min(values) if values else None

    def failed(self) -> list[CheckResult]:
        return [item for item in self.gating() if item.verdict == FAIL]

    def unsure(self) -> list[str]:
        return [item.check.id for item in self.gating() if item.verdict == UNSURE]

    def report(self) -> dict[str, Any]:
        lowest = self.min_pass_probability
        frames = self.frames
        payload: dict[str, Any] = {
            "verdict": self.verdict,
            "min_pass_probability": None if lowest is None else out.rounded(lowest),
            "min_confidence": out.rounded(self.min_confidence),
            "checks": {check_id: item.as_report() for check_id, item in self.results.items()},
            "unsure": self.unsure(),
            "model": self.result.model,
            "requested_model": self.result.requested_model,
            "input_tokens": self.result.input_tokens,
            "request_id": self.result.request_id,
            "frames": {
                "sampled": frames.sampled, "sent": list(frames.sent), "cap": MAX_FRAMES,
                "long_side": FRAME_LONG_SIDE, "estimated_image_tokens": frames.estimated_tokens,
            },
            "images": out.EXPERIMENTAL_IMAGES,
            "notes": list(self.notes),
        }
        return payload

    def footer(self) -> str:
        lowest = self.min_pass_probability
        verdict = {PASS: "pass", FAIL: "fail", UNSURE: "unsure", None: "no must-pass checks"}[self.verdict]
        tail = f" · lowest pass p {lowest:.2f}" if lowest is not None else ""
        return f"TypeSafe {self.result.model}: {verdict}{tail} · {len(self.frames.sent)} frames (experimental)"


async def ask(
    jev: Setup,
    *,
    frames: Frames,
    checks: Sequence[Check],
    context: Mapping[str, Any] | None = None,
) -> JevRun:
    """Send every check in one request and read each answer."""
    if not checks:
        raise ValueError("Jev mode needs at least one check")
    ids = [check.id for check in checks]
    if len(set(ids)) != len(ids):
        raise ValueError("Jev check ids must be different")
    state: dict[str, Any] = dict(context or {})
    state.update(frames.state())
    min_confidence = jev.min_confidence
    result = await system_one(
        jev.api_key, model=jev.model, state=state,
        questions={check.id: check.question() for check in checks}, images=frames.prepared,
    )
    run = JevRun(results={check.id: _read(check, result, min_confidence) for check in checks},
                 result=result, frames=frames, min_confidence=min_confidence)
    note = frames.note()
    if note:
        run.notes.append(note)
    if any(check.kind == "choice" for check in checks) and any(
            not item.confident for item in run.results.values() if item.check.kind == "choice"):
        run.notes.append("Jev can lean toward the first option when options are close; an unsure "
                         "Choice may change if the options are reordered.")
    return run


def provenance_fields(run: JevRun) -> dict[str, Any]:
    """The who-answered fields the vision-llm mode also reports."""
    return {"vision_provider": "typesafe", "vision_model": run.result.model}
