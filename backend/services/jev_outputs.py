"""The output contract shared by every Jev node (Decide, Pick Best, Box).

Every Jev output port carries Text (or an Image/Mask for Box's crops), and
the exact string format of each value is fixed here so the canvas, agents and
downstream nodes can read them without guessing. docs/api-guides/typesafe.md
describes the same contract in prose, and frontend/src/lib/jev.ts parses it.
backend/tests/fixtures/jev_outputs.json holds sample outputs both sides test
against, so the two can't drift.

Value formats:

- numbers (probability, confidence): a plain decimal in 0..1, at most four
  places, no exponent or trailing zeros: "0.93", "1", "0".
- pass / found: "true", "false" or "unsure".
- probabilities: a JSON object of label -> number (four places), in the
  order the options were given.
- box: JSON {"top","bottom","left","right","confidence","px","image"}, or
  the JSON text "null" unless the target was found ("unsure" gives null
  too: Nebula never hands on a box that may point at nothing).
- report: plain text. Line 1 is the title, then "Key: value" lines, then
  zero or more "Note: ..." lines. "Model:" and "Input tokens:" are always
  there.
- on_pass / on_fail (Decide's gate): one carries the ``through`` input
  unchanged (or the pass verdict as Text), the other is a withheld entry
  (execution/gating.py). When pass is "unsure" either or neither may carry
  it, depending on ``when_unsure``.
"""
from __future__ import annotations

import json
import math
from typing import Any, Iterable, Mapping, Sequence

from execution.gating import is_withheld

DECIDE = "jev-decide"
PICK_BEST = "jev-pick-best"
BOX = "jev-box"
NODE_IDS = (DECIDE, PICK_BEST, BOX)

VERDICTS = ("true", "false", "unsure")
EXPERIMENTAL_IMAGES = "experimental"

# Port id -> data type, per node. Optional ports may be left out of a result
# (Box gives crop/mask/annotated only when found is "true").
PORTS: dict[str, dict[str, str]] = {
    DECIDE: {"answer": "Text", "pass": "Text", "probability": "Text", "confidence": "Text",
             "probabilities": "Text", "report": "Text", "on_pass": "Any", "on_fail": "Any"},
    PICK_BEST: {"winner": "Image", "index": "Text", "probabilities": "Text", "confidence": "Text",
                "report": "Text"},
    BOX: {"found": "Text", "box": "Text", "crop": "Image", "mask": "Mask", "annotated": "Image",
          "report": "Text"},
}
OPTIONAL_PORTS: dict[str, frozenset[str]] = {
    DECIDE: frozenset(),
    PICK_BEST: frozenset(),
    BOX: frozenset({"crop", "mask", "annotated"}),
}


def format_number(value: float) -> str:
    """0.93 -> "0.93", 1.0 -> "1", 0.123456 -> "0.1235"."""
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Jev outputs hold finite numbers only")
    text = f"{round(number, 4):.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def rounded(value: float) -> float:
    return round(float(value), 4) + 0.0


def verdict(passed: bool, confidence: float | None, min_confidence: float) -> str:
    """"unsure" when the model isn't confident enough to act on, else true/false."""
    if confidence is None or confidence < min_confidence:
        return "unsure"
    return "true" if passed else "false"


def probabilities_json(probabilities: Mapping[str, float]) -> str:
    return json.dumps({str(key): rounded(value) for key, value in probabilities.items()}, ensure_ascii=False)


def box_json(mapped: Mapping[str, Any] | None, confidence: float | None) -> str:
    """The Box ``box`` output. ``mapped`` is ImageTransform.to_original_box()."""
    if mapped is None:
        return "null"
    return json.dumps({
        "top": mapped["top"], "bottom": mapped["bottom"], "left": mapped["left"], "right": mapped["right"],
        # null, never 0, when TypeSafe sends no confidence for the box.
        "confidence": None if confidence is None else rounded(confidence),
        "px": dict(mapped["px"]), "image": dict(mapped["image"]),
    })


def _one_line(text: Any, limit: int = 300) -> str:
    # 0 is a real value (a Pick Best winner at index 0), so only None is empty.
    flat = " ".join(("" if text is None else str(text)).split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def report(title: str, fields: Iterable[tuple[str, Any]], *, model: str, requested_model: str,
           input_tokens: int | None, images: int = 0, request_id: str | None = None,
           notes: Sequence[str] = ()) -> str:
    """The ``report`` output, in the fixed line format above."""
    lines = [_one_line(title)]
    for key, value in fields:
        lines.append(f"{key}: {_one_line(value)}")
    shown_model = model if model == requested_model else f"{model} (asked for {requested_model})"
    lines.append(f"Model: {shown_model}")
    lines.append(f"Input tokens: {input_tokens if input_tokens is not None else 'unknown'}")
    if images:
        lines.append(f"Images: {images} ({EXPERIMENTAL_IMAGES})")
    if request_id:
        lines.append(f"Request id: {_one_line(request_id, 120)}")
    lines.extend(f"Note: {_one_line(note, 400)}" for note in notes if note)
    return "\n".join(lines)


def text(value: str) -> dict[str, str]:
    return {"type": "Text", "value": value}


# -- contract check (tests of every Jev node use this) -----------------------


def _number_problem(value: Any) -> str | None:
    if not isinstance(value, str):
        return "is not a string"
    try:
        number = float(value)
    except ValueError:
        return f"{value!r} is not a number"
    if not math.isfinite(number) or not 0.0 <= number <= 1.0:
        return f"{value!r} is outside 0..1"
    if value != format_number(number):
        return f"{value!r} should be written {format_number(number)!r}"
    return None


def _probabilities_problem(value: Any) -> str | None:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return "is not JSON"
    if not isinstance(parsed, dict) or not parsed:
        return "is not a non-empty JSON object"
    for key, number in parsed.items():
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number <= 1:
            return f"{key!r} has a value outside 0..1"
    return None


def _report_problem(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return "is empty"
    lines = value.split("\n")
    keys = {line.split(": ", 1)[0] for line in lines[1:] if ": " in line}
    if "Model" not in keys or "Input tokens" not in keys:
        return "needs Model and Input tokens lines"
    for line in lines[1:]:
        if ": " not in line:
            return f"line {line!r} is not 'Key: value'"
    return None


def _box_problem(value: Any, found: Any) -> str | None:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return "is not JSON"
    if parsed is None:
        return "is null although found is true" if found == "true" else None
    if found != "true":
        return f"must be null when found is {found}"
    if not isinstance(parsed, dict):
        return "is not a JSON object"
    for edge in ("top", "bottom", "left", "right"):
        number = parsed.get(edge)
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not 0 <= number <= 1:
            return f"{edge} is not a fraction 0..1"
    if parsed["top"] > parsed["bottom"] or parsed["left"] > parsed["right"]:
        return "edges are out of order"
    confidence = parsed.get("confidence", "missing")
    if confidence is not None and (isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                                   or not 0 <= confidence <= 1):
        return "confidence must be a number 0..1 or null"
    px, image = parsed.get("px"), parsed.get("image")
    if not isinstance(px, dict) or set(px) != {"x", "y", "w", "h"} or not all(
            isinstance(px[k], int) and not isinstance(px[k], bool) and px[k] >= 0 for k in px):
        return "px must be {x, y, w, h} non-negative integers"
    if not isinstance(image, dict) or set(image) != {"w", "h"} or not all(
            isinstance(image[k], int) and not isinstance(image[k], bool) and image[k] > 0 for k in image):
        return "image must be {w, h} positive integers"
    if px["x"] + px["w"] > image["w"] or px["y"] + px["h"] > image["h"]:
        return "px runs outside the image"
    return None


def validate_outputs(definition_id: str, outputs: Mapping[str, Any]) -> list[str]:
    """Every way ``outputs`` breaks the contract, as readable strings."""
    ports = PORTS.get(definition_id)
    if ports is None:
        return [f"{definition_id} is not a Jev node"]
    problems: list[str] = []
    for port, kind in ports.items():
        entry = outputs.get(port)
        if kind == "Any":
            # A gate port: withheld, or any typed value passed through.
            if not isinstance(entry, Mapping) or not (
                    is_withheld(entry) or (isinstance(entry.get("type"), str) and "value" in entry)):
                problems.append(f"{port}: must be a value or withheld")
            continue
        if entry is None:
            if port not in OPTIONAL_PORTS[definition_id]:
                problems.append(f"{port}: missing")
            continue
        if not isinstance(entry, Mapping) or entry.get("type") != kind:
            problems.append(f"{port}: must be {{type: {kind}, value}}")
            continue
        if kind != "Text" and (not isinstance(entry.get("value"), str) or not entry["value"]):
            problems.append(f"{port}: needs a media reference")
    for port in outputs:
        if port not in ports:
            problems.append(f"{port}: not a {definition_id} output")

    def value(port: str) -> Any:
        entry = outputs.get(port)
        return entry.get("value") if isinstance(entry, Mapping) else None

    checks: list[tuple[str, str | None]] = [("report", _report_problem(value("report")))]
    if definition_id == DECIDE:
        checks += [
            ("answer", None if isinstance(value("answer"), str) and value("answer") else "is empty"),
            ("pass", None if value("pass") in VERDICTS else "must be true, false or unsure"),
            ("probability", _number_problem(value("probability"))),
            ("confidence", _number_problem(value("confidence"))),
            ("probabilities", _probabilities_problem(value("probabilities"))),
        ]
        carried = {port for port in ("on_pass", "on_fail")
                   if isinstance(outputs.get(port), Mapping) and not is_withheld(outputs[port])}
        expected = {"true": {"on_pass"}, "false": {"on_fail"}}.get(value("pass"))
        if expected is not None and carried != expected:
            checks.append(("on_pass", f"exactly {next(iter(expected))} must carry the value when pass is {value('pass')}"))
        elif expected is None and len(carried) > 1:
            checks.append(("on_pass", "at most one of on_pass / on_fail may carry the value"))
    elif definition_id == PICK_BEST:
        index = value("index")
        index_ok = isinstance(index, str) and index.isdigit() and str(int(index)) == index
        checks += [
            ("index", None if index_ok else "must be a 0-based integer written as text"),
            ("confidence", _number_problem(value("confidence"))),
            ("probabilities", _probabilities_problem(value("probabilities"))),
        ]
        if index_ok and not _probabilities_problem(value("probabilities")):
            keys = list(json.loads(value("probabilities")))
            if keys != [str(i) for i in range(len(keys))]:
                checks.append(("probabilities", "must be keyed '0', '1', ... in order"))
            elif int(index) >= len(keys):
                checks.append(("index", "is past the last candidate"))
    elif definition_id == BOX:
        found = value("found")
        checks += [
            ("found", None if found in VERDICTS else "must be true, false or unsure"),
            ("box", _box_problem(value("box"), found)),
        ]
        for port in ("crop", "mask", "annotated"):
            if found == "true" and port not in outputs:
                checks.append((port, "missing although found is true"))
            elif found != "true" and port in outputs:
                checks.append((port, "only when found is true"))
    problems += [f"{port}: {problem}" for port, problem in checks if problem]
    return problems
