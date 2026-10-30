"""The moodboard reader: a vision model reads references and sorts them into looks.

docs/moodboard-canvas-plan.md sections 5.6 and 5.6.1 (PR4: the dry run). The
person names the model (``data/moodboard_reader_models.json``); nothing falls
back to another provider. Two phases:

1. **Reading.** References go out in batches of 6, longest edge 1024 px, as
   JPEG, under batch-local labels (``Image A`` to ``F``), never board numbers:
   numbers shift when an image is removed, so a reason that said "like #18"
   would later point at the wrong card. The answer is a response schema with
   ``ref`` first and ``reason`` last, sent as
   ``generationConfig.responseFormat.text`` (``responseSchema`` and
   ``responseJsonSchema`` are deprecated in the API reference, 2026-10-20).
   Each item is read as it closes (services/moodboard_reader_stream.py) and
   checked: a ref outside the batch is skipped, a duplicate keeps the first,
   an item that fails the schema counts as missing. At most 2 requests run at
   once, each under its time bounds. One retry per batch asks only for what
   didn't come back; after ``MAX_TOKENS`` it goes out as two halves, never the
   same request again. What is still missing is "couldn't read".
2. **Sorting.** One text-only call assigns each reading to at most two looks.
   Python then enforces the rules: a fit below 0.5, or a failed read, goes to
   Unsorted; at most 8 new looks; each image goes to its best look only, and a
   second fit becomes an ``alsoIn`` suggestion; when 3 or more references
   share a pair, one ``hybrid`` suggestion replaces their ``alsoIn`` ones.
   Result lines are written from what Python decided, never from the model.

Every step writes a trace line (``Trace``), the ``moodboardReadTrace`` shape
of section 5.6.1, numbered from 1 with no gaps. In PR4 a read is always a dry
run: nothing is saved and nothing moves.

**One swappable reading source (section 5.6.2).** The provider call sits
behind ``ReadingSource`` (``identity``, ``priced``, ``streams``,
``thoughts``, ``read(task, sink)``, ``sort(task, sink)``). The shared code
builds every task (labels, image parts, instructions and schema, notes per
the opt-in), so a source can't add or drop an instruction, and everything
after "the model said this" is shared too: the item check (``sink.item``),
the reason trim and strip, the new-look-name check, the retry for missing
refs (split only when the source reports ``truncated``), Python's sort rules,
the trace and its templates. ``GeminiSource`` is Argon's: it wraps
``GeminiTransport``, ``gemini_body`` and the stream parser, reports
``truncated`` for ``MAX_TOKENS``, and gives a lone cut-off image (or the
sort) more room through ``can_widen``. PR10c adds an agent's source and
changes nothing here. The estimate and the spend gate run only when
``source.priced`` ("Nebula pays"), which an Argon entry with no list price
still is.

Notes follow #18's opt-in in both phases and the retry: board and image notes
go only when the board's ``sendNotes`` is on; private notes never go.

``gemini_body`` and ``call_text`` are the text-call helper PR19 reuses for the
music direction.
"""
from __future__ import annotations

import abc
import asyncio
import base64
import io
import json
import math
import re
import time
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import httpx
from PIL import Image, ImageOps

from execution.missing_credential import MissingCredentialError
from handlers.google_gemini import (
    GEMINI_BASE_URL,
    GEMINI_CHAT_MAX_OUTPUT,
    GEMINI_CHAT_THINKING_LEVELS,
)
from services.http_errors import HTTP_ERRORS, describe
from services.moodboard_reader_stream import (
    GeminiStreamParser,
    StreamOutcome,
    clean_model_text,
    names_a_label_any_case,
    skeleton,
    skeletons,
    split_text,
    trim_reason,
)

MODELS_PATH = Path(__file__).resolve().parent.parent / "data" / "moodboard_reader_models.json"
READER_VERSION = 1
BATCH_SIZE = 6
LABELS = "ABCDEF"
MAX_PARALLEL = 2
IMAGE_EDGE = 1024  # Q13
JPEG_QUALITY = 85
# Google's inline request limit is 20 MB including prompts and JSON
# (services/vision_llm.py keeps the same headroom).
MAX_BASE64_CHARS = 16 * 1024 * 1024
MIN_FIT = 0.5          # Q17
MAX_NEW_LOOKS = 8
HYBRID_MIN = 3         # Q10
LINE_LIMIT = 200
THOUGHT_MERGE_SECONDS = 0.25
FRAME_NAME_LIMIT = 60
# A reading's look names are cut here, past a frame name's limit, so a cut
# name always fails the look-name check.
READING_LOOK_LIMIT = 2 * FRAME_NAME_LIMIT
FIELD_LIMIT = 80
MOTIF_LIMIT = 40
MAX_MOTIFS = 6
MAX_LOOKS = 3
# Characters per token for the prompt part of an estimate: a generous and a
# tight guess (Google counts text at about 4 characters a token).
CHARS_PER_TOKEN_LOW = 4.0
CHARS_PER_TOKEN_HIGH = 3.0
PRICE_UNITS = 1_000_000

SYSTEM_PROMPT = (
    "You read reference images for a designer's moodboard and say what each one looks like. "
    "Describe images; never identify people. Write plainly, as captions a person reads."
)


class ReaderError(ValueError):
    """A read that can't start as asked (an unknown model, a bad image id)."""


class MixedReadersError(RuntimeError):
    """A sort task built from readings another source wrote: a programming
    error, never a provider's or a person's. A run has one reader, and the
    sort prompt carries only that source's own readings (section 5.6.2)."""


class NoReaderKeyError(MissingCredentialError):
    """The reader's key isn't set. Raised before any request, so the hold is
    given back whole (still a ValueError)."""


# -- the model file ---------------------------------------------------------------

def load_models(path: Path | None = None) -> dict[str, Any]:
    with open(path or MODELS_PATH, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        raise ReaderError("moodboard_reader_models.json must be an object with a 'models' object")
    return data


def _is_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return len(value) == 10


def _positive_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def validate_models(data: Mapping[str, Any]) -> list[str]:
    """Every problem in the model file, as sentences (empty when it's sound)."""
    problems: list[str] = []
    models = data.get("models")
    if not isinstance(models, dict) or not models:
        return ["models must be a non-empty object"]
    for model_id, entry in models.items():
        where = f"models.{model_id}"
        if not isinstance(entry, dict):
            problems.append(f"{where} must be an object")
            continue
        for key in ("name", "provider", "model", "keyName", "definitionId", "units"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                problems.append(f"{where}.{key} must be a non-empty string")
        color = entry.get("color")
        if not (isinstance(color, str) and len(color) == 7 and color.startswith("#")
                and all(c in "0123456789abcdefABCDEF" for c in color[1:])):
            problems.append(f"{where}.color must be #rrggbb")
        if not isinstance(entry.get("streams"), bool):
            problems.append(f"{where}.streams must be true or false")
        summaries = entry.get("thoughtSummaries")
        if not (isinstance(summaries, bool) or summaries == "unconfirmed"):
            problems.append(f'{where}.thoughtSummaries must be true, false or "unconfirmed"')
        thinking = entry.get("thinking")
        if not isinstance(thinking, dict) or not thinking:
            problems.append(f"{where}.thinking must list each thinking level")
            thinking = {}
        for level, allowance in thinking.items():
            if not isinstance(allowance, dict) or not _positive_number(allowance.get("thinkingTokens")):
                problems.append(f"{where}.thinking.{level}.thinkingTokens must be a positive number")
        levels = GEMINI_CHAT_THINKING_LEVELS.get(str(entry.get("model")))
        if levels is not None and set(thinking) - set(levels):
            problems.append(f"{where}.thinking has levels {entry.get('model')} doesn't take: "
                            f"{', '.join(sorted(set(thinking) - set(levels)))}")
        if entry.get("defaultThinkingLevel") not in thinking:
            problems.append(f"{where}.defaultThinkingLevel must be one of its thinking levels")
        bounds = entry.get("timeBounds")
        for level in thinking:
            one = bounds.get(level) if isinstance(bounds, dict) else None
            if not isinstance(one, dict) or not all(_positive_number(one.get(k)) for k in ("firstByte", "quiet", "total")):
                problems.append(f"{where}.timeBounds.{level} needs firstByte, quiet and total in seconds")
        answer = entry.get("answerTokens")
        if not isinstance(answer, dict) or not all(_positive_number(answer.get(k)) for k in ("perImage", "base")):
            problems.append(f"{where}.answerTokens needs perImage and base")
        sort = entry.get("sortTokens")
        reading_input = sort.get("readingInput") if isinstance(sort, dict) else None
        if (not isinstance(sort, dict) or not all(_positive_number(sort.get(k)) for k in ("perImage", "base"))
                or not (isinstance(reading_input, list) and len(reading_input) == 2
                        and all(_positive_number(v) for v in reading_input) and reading_input[0] <= reading_input[1])):
            problems.append(f"{where}.sortTokens needs perImage, base and readingInput [low, high]")
        if not _positive_number(entry.get("imageTokens")):
            problems.append(f"{where}.imageTokens must be a positive number")
        cap = GEMINI_CHAT_MAX_OUTPUT.get(str(entry.get("model")))
        if cap is not None and isinstance(answer, dict) and _positive_number(answer.get("base")):
            for level, allowance in thinking.items():
                if isinstance(allowance, dict) and _positive_number(allowance.get("thinkingTokens")):
                    need = allowance["thinkingTokens"] + answer["base"] + answer.get("perImage", 0) * BATCH_SIZE
                    if need > cap:
                        problems.append(f"{where}: a full batch at {level} asks for {need} output tokens, "
                                        f"over {entry.get('model')}'s {cap}")
        prices = entry.get("prices")
        if prices is not None:
            if not isinstance(prices, list) or not prices:
                problems.append(f"{where}.prices must be a list of dated rows, or null for no list price")
            else:
                for i, row in enumerate(prices):
                    if not isinstance(row, dict) or not all(_positive_number(row.get(k)) for k in ("inputPerMTok", "outputPerMTok")):
                        problems.append(f"{where}.prices[{i}] needs inputPerMTok and outputPerMTok")
                        continue
                    for key in ("from", "until"):
                        if row.get(key) is not None and not _is_date(row.get(key)):
                            problems.append(f"{where}.prices[{i}].{key} must be YYYY-MM-DD or null")
                problems.extend(_price_gaps(where, prices))
        if not isinstance(entry.get("unconfirmed"), bool):
            problems.append(f"{where}.unconfirmed must be true or false")
        sources = entry.get("sources")
        if not isinstance(sources, list) or not sources or not all(
                isinstance(s, dict) and str(s.get("url", "")).startswith("https://") and s.get("quote") for s in sources):
            problems.append(f"{where}.sources must list each page with its url and a quote")
        if not _is_date(entry.get("checked")):
            problems.append(f"{where}.checked must be the date the prices were read, YYYY-MM-DD")
    return problems


def _price_gaps(where: str, prices: list[Any]) -> list[str]:
    """Dated rows must follow each other with no gap or overlap."""
    rows = [row for row in prices if isinstance(row, dict)]
    problems = []
    if rows and rows[0].get("from") is not None:
        problems.append(f"{where}.prices[0].from must be null (the first row has no start)")
    if rows and rows[-1].get("until") is not None:
        problems.append(f"{where}.prices[-1].until must be null (the last row has no end)")
    for before, after in zip(rows, rows[1:]):
        if not (_is_date(before.get("until")) and _is_date(after.get("from"))):
            problems.append(f"{where}.prices: each row but the last needs `until`, each but the first `from`")
            continue
        if date.fromisoformat(after["from"]) != date.fromisoformat(before["until"]) + timedelta(days=1):
            problems.append(f"{where}.prices: {after['from']} must be the day after {before['until']}")
    return problems


def reader_entry(model_id: str, models: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The model file's entry for ``model_id``, with its id."""
    catalog = (models or load_models()).get("models") or {}
    entry = catalog.get(str(model_id or "").strip())
    if not isinstance(entry, dict):
        known = ", ".join(sorted(catalog)) or "none"
        raise ReaderError(f"No reader called {model_id}. Read with one of: {known}.")
    return {**entry, "id": str(model_id).strip()}


def reader_identity(entry: Mapping[str, Any]) -> dict[str, str]:
    """The overseer's fixed identity (section 5.6.1): never a header identity.
    The estimate shows it as it is."""
    return {"kind": "reader", "id": f"reader:{entry['id']}", "name": str(entry["name"]),
            "model": str(entry["model"]), "provider": str(entry["provider"]), "color": str(entry["color"])}


def model_identity(entry: Mapping[str, Any]) -> dict[str, str]:
    """A model reader's identity as a source (section 5.6.2): the overseer's,
    with ``source: "model"``. An agent's reader (PR10c) has ``"agent"``."""
    return {**reader_identity(entry), "source": "model"}


def reader_key(identity: Mapping[str, Any]) -> str:
    """What a reading's ``reader`` holds (section 4.1): the identity's id
    without ``reader:``, so ``"gemini-4-argon"`` or ``"agent:<identity id>"``."""
    return str(identity["id"]).removeprefix("reader:")


def asks_for_thoughts(entry: Mapping[str, Any]) -> bool:
    """Only a model whose summaries are confirmed (``true``) is asked for them;
    ``false`` and ``"unconfirmed"`` send no ``includeThoughts`` (Q29 c falls
    back to b)."""
    return entry.get("thoughtSummaries") is True


def thinking_level(entry: Mapping[str, Any], level: str | None) -> str:
    chosen = (level or entry.get("defaultThinkingLevel") or "").strip()
    levels = entry.get("thinking") or {}
    if chosen not in levels:
        raise ReaderError(f"{entry.get('name')} reads at thinking level {', '.join(levels)}; not '{chosen}'.")
    return chosen


def check_key(entry: Mapping[str, Any], api_keys: Mapping[str, Any]) -> str:
    key = api_keys.get(str(entry["keyName"])) if api_keys else None
    if not key:
        raise NoReaderKeyError(f"Reading with {entry['name']} needs {entry['keyName']}. Add it in Settings > "
                               "API keys; nothing was sent and nothing was charged.")
    return str(key)


# -- targets and numbers --------------------------------------------------------------

@dataclass
class Target:
    index: int
    image: dict[str, Any]
    path: Path | None

    @property
    def number(self) -> int:
        return self.index + 1

    @property
    def id(self) -> str:
        return str(self.image.get("id"))

    def ref(self) -> dict[str, Any]:
        return {"imageId": self.id, "number": self.number}


def select_targets(board: Mapping[str, Any], image_ids: Sequence[str] | None = None,
                   resolve: Callable[[str], Path | None] | None = None) -> list[Target]:
    """The references a read covers, in board order: those named, or every
    image on the board (set-aside ones too: they are still read)."""
    if resolve is None:
        from services.moodboard_analysis import resolve_moodboard_image_path as resolve
    images = [img for img in board.get("images") or [] if isinstance(img, dict)]
    wanted: set[str] | None = None
    if image_ids is not None:
        known = {str(img.get("id")) for img in images}
        unknown = [str(i) for i in image_ids if str(i) not in known]
        if unknown:
            raise ReaderError(f"No image {', '.join(unknown[:5])} on this board.")
        wanted = {str(i) for i in image_ids}
        if not wanted:
            raise ReaderError("imageIds is empty: leave it out to read every reference.")
    targets = []
    for index, image in enumerate(images):
        if wanted is not None and str(image.get("id")) not in wanted:
            continue
        targets.append(Target(index, image, resolve(str(image.get("url") or ""))))
    return targets


def numbers_text(numbers: Iterable[int]) -> str:
    """"#1–#6", or runs and singles: "#1–#3, #7"."""
    ordered = sorted(set(numbers))
    runs: list[list[int]] = []
    for number in ordered:
        if runs and number == runs[-1][-1] + 1:
            runs[-1].append(number)
        else:
            runs.append([number])
    return ", ".join(f"#{run[0]}" if len(run) == 1 else f"#{run[0]}–#{run[-1]}" for run in runs)


def batches_of(targets: Sequence[Target], size: int = BATCH_SIZE) -> list[list[Target]]:
    return [list(targets[i:i + size]) for i in range(0, len(targets), size)]


# -- prompts and schemas -----------------------------------------------------------------

def _notes_sent(board: Mapping[str, Any]) -> bool:
    return board.get("sendNotes") is True


def look_names(board: Mapping[str, Any]) -> list[str]:
    return [str(frame.get("name")) for frame in board.get("frames") or []
            if isinstance(frame, dict) and frame.get("kind") == "look" and frame.get("name")]


def phase1_schema(labels: Sequence[str]) -> dict[str, Any]:
    """``ref`` first and ``reason`` last, so a ref is known before its
    reading streams and the reason closes the item. Strings take only ``enum``
    and ``format`` (no ``maxLength``), so the reason's cap is a request in its
    description and a trim in Python."""
    return {
        "type": "object",
        "properties": {
            "readings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "enum": list(labels),
                                "description": "The image's label, as given before it."},
                        "medium": {"type": "string", "description": "Photo, painting, render, collage, ..."},
                        "style": {"type": "string", "description": "The visual style in a few words."},
                        "light": {"type": "string", "description": "The light in a few words."},
                        "motifs": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_MOTIFS,
                                   "description": "Recurring subjects, shapes or textures."},
                        "looks": {
                            "type": "array", "maxItems": MAX_LOOKS,
                            "description": "Looks this image could belong to, best first.",
                            "items": {"type": "object",
                                      "properties": {"name": {"type": "string"},
                                                     "fit": {"type": "number", "minimum": 0, "maximum": 1}},
                                      "required": ["name", "fit"]},
                        },
                        "reason": {"type": "string",
                                   "description": "At most 120 characters: one plain sentence about this image "
                                                  "only. Never mention another image, a label or a number."},
                    },
                    "required": ["ref", "medium", "style", "light", "motifs", "looks", "reason"],
                },
            },
        },
        "required": ["readings"],
    }


def phase1_instructions(board: Mapping[str, Any], count: int) -> str:
    """What a reader is told for one batch of ``count`` images, the board's
    notes only when ``sendNotes`` is on."""
    labels = LABELS[:count]
    names = look_names(board)
    lines = [
        f"Read each of these {count} images. For each, give its medium, style and light in a few words, "
        f"up to {MAX_MOTIFS} motifs, and up to {MAX_LOOKS} looks it could belong to, best first, each with a fit "
        "from 0 to 1 (1: clearly belongs).",
    ]
    if names:
        lines.append("Looks already on the board: " + ", ".join(json.dumps(name) for name in names)
                     + ". Use one of these names when an image fits it; otherwise name a new look in one or two words.")
    else:
        lines.append("Name each look in one or two words, so images that share a look share its name.")
    lines.append("`reason` is at most 120 characters: one plain sentence about that image alone, as a caption. "
                 "Never mention another image, a label or a number.")
    lines.append(f"Answer once for every image, with its label ({', '.join(labels)}) as `ref`.")
    if _notes_sent(board) and str(board.get("notes") or "").strip():
        lines.append("The person's notes on the board: " + str(board["notes"]).strip())
    return "\n".join(lines)


def phase1_image_parts(board: Mapping[str, Any], targets: Sequence[Target],
                       images: Sequence[tuple[str, str]] | None) -> list[dict[str, Any]]:
    """Each image as a text part ``Image A`` followed by the image
    (``{"image": {mimeType, data}}``), and its note when notes are sent;
    private notes never. ``images`` None leaves the images out (the estimate
    counts their tokens separately)."""
    parts: list[dict[str, Any]] = []
    for i, (label, target) in enumerate(zip(LABELS[:len(targets)], targets)):
        parts.append({"text": f"Image {label}"})
        if images is not None:
            mime, data = images[i]
            parts.append({"image": {"mimeType": mime, "data": data}})
        note = str(target.image.get("notes") or "").strip()
        if _notes_sent(board) and note:
            parts.append({"text": f"The person's note on Image {label}: {note}"})
    return parts


def gemini_parts(instructions: str, parts: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """A task's text and images as Gemini parts: the instructions first,
    then each part, an image as ``inline_data``."""
    out: list[dict[str, Any]] = [{"text": instructions}]
    for part in parts:
        if "image" in part:
            out.append({"inline_data": {"mime_type": part["image"]["mimeType"], "data": part["image"]["data"]}})
        else:
            out.append({"text": part["text"]})
    return out


def phase1_parts(board: Mapping[str, Any], targets: Sequence[Target],
                 images: Sequence[tuple[str, str]] | None) -> list[dict[str, Any]]:
    """The user turn Argon gets for one batch: the instructions, then each
    image as a text part ``Image A`` followed by the image."""
    return gemini_parts(phase1_instructions(board, len(targets)), phase1_image_parts(board, targets, images))


def sort_labels(count: int) -> list[str]:
    return [f"R{i}" for i in range(1, count + 1)]


def phase2_schema(labels: Sequence[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "sort": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "enum": list(labels)},
                        "looks": {"type": "array", "maxItems": 2,
                                  "description": "The best look, then a second one only if it also fits well.",
                                  "items": {"type": "object",
                                            "properties": {"name": {"type": "string"},
                                                           "fit": {"type": "number", "minimum": 0, "maximum": 1}},
                                            "required": ["name", "fit"]}},
                    },
                    "required": ["ref", "looks"],
                },
            },
        },
        "required": ["sort"],
    }


def _reading_for_sort(label: str, reading: Mapping[str, Any]) -> dict[str, Any]:
    return {"ref": label, "medium": reading.get("medium"), "style": reading.get("style"),
            "light": reading.get("light"), "motifs": reading.get("motifs"), "looks": reading.get("looks"),
            "reason": reading.get("reason")}


def phase2_prompt(board: Mapping[str, Any], labelled: Sequence[tuple[str, Target, Mapping[str, Any]]]) -> str:
    names = look_names(board)
    lines = [
        "Sort these moodboard references into looks: groups that share a visual language. Each line is one "
        "reference's reading.",
        f"Give every reference its best look and, only if it also fits another one well, a second; each with a "
        f"fit from 0 to 1. Make at most {MAX_NEW_LOOKS} new looks, named in one or two words. Give no look when "
        "none fits.",
    ]
    if names:
        lines.append("Looks already on the board (keep their names exactly): "
                     + ", ".join(json.dumps(name) for name in names) + ".")
    if _notes_sent(board) and str(board.get("notes") or "").strip():
        lines.append("The person's notes on the board: " + str(board["notes"]).strip())
    for label, target, reading in labelled:
        entry = _reading_for_sort(label, reading)
        note = str(target.image.get("notes") or "").strip()
        if _notes_sent(board) and note:
            entry["note"] = note
        lines.append(json.dumps(entry, ensure_ascii=False))
    return "\n".join(lines)


def gemini_body(entry: Mapping[str, Any], *, parts: list[dict[str, Any]], schema: Mapping[str, Any] | None,
                level: str, max_output_tokens: int, system: str = SYSTEM_PROMPT) -> dict[str, Any]:
    """A ``generateContent`` body for the reader's model. The schema goes in
    ``responseFormat.text`` (the documented form; key order follows the
    schema). No temperature: Argon ignores sampling params
    (``GEMINI_CHAT_NO_SAMPLING``). ``includeThoughts`` only for a model whose
    summaries are confirmed."""
    levels = GEMINI_CHAT_THINKING_LEVELS.get(str(entry["model"]))
    if levels is not None and level not in levels:
        raise ReaderError(f"Thinking level '{level}' isn't available for {entry['model']}.")
    cap = GEMINI_CHAT_MAX_OUTPUT.get(str(entry["model"]))
    thinking: dict[str, Any] = {"thinkingLevel": level}
    if asks_for_thoughts(entry):
        thinking["includeThoughts"] = True
    config: dict[str, Any] = {
        "maxOutputTokens": int(min(max_output_tokens, cap) if cap else max_output_tokens),
        "thinkingConfig": thinking,
    }
    if schema is not None:
        config["responseFormat"] = {"text": {"mimeType": "APPLICATION_JSON", "schema": schema}}
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": config,
    }


def batch_cap(entry: Mapping[str, Any], level: str, count: int) -> int:
    """``maxOutputTokens`` for a batch: the level's thinking allowance plus the
    answer allowance, since the cap counts thinking and is a hard cutoff."""
    answer = entry["answerTokens"]
    need = entry["thinking"][level]["thinkingTokens"] + answer["base"] + answer["perImage"] * count
    cap = GEMINI_CHAT_MAX_OUTPUT.get(str(entry["model"]))
    return int(min(need, cap) if cap else need)


def raised_cap(entry: Mapping[str, Any], cap: int) -> int:
    """The cap for a retry after ``MAX_TOKENS`` that can't be split (one
    image, or the sort): twice ``cap``, bounded by the model's output limit.
    When it can't grow, the retry would be the same request again, so the
    reader doesn't send it."""
    limit = GEMINI_CHAT_MAX_OUTPUT.get(str(entry["model"]))
    return int(min(cap * 2, limit) if limit else cap * 2)


def sort_cap(entry: Mapping[str, Any], level: str, count: int) -> int:
    sort = entry["sortTokens"]
    need = entry["thinking"][level]["thinkingTokens"] + sort["base"] + sort["perImage"] * count
    cap = GEMINI_CHAT_MAX_OUTPUT.get(str(entry["model"]))
    return int(min(need, cap) if cap else need)


# -- price ----------------------------------------------------------------------------------

def price_row(entry: Mapping[str, Any], day: date) -> dict[str, Any] | None:
    for row in entry.get("prices") or []:
        start = date.fromisoformat(row["from"]) if row.get("from") else date.min
        end = date.fromisoformat(row["until"]) if row.get("until") else date.max
        if start <= day <= end:
            return row
    return None


def _usd(tokens_in: float, tokens_out: float, row: Mapping[str, Any]) -> float:
    return tokens_in / PRICE_UNITS * float(row["inputPerMTok"]) + tokens_out / PRICE_UNITS * float(row["outputPerMTok"])


def _text_tokens(chars: int) -> tuple[int, int]:
    return math.ceil(chars / CHARS_PER_TOKEN_LOW), math.ceil(chars / CHARS_PER_TOKEN_HIGH)


def _request_chars(parts: Sequence[Mapping[str, Any]], schema: Mapping[str, Any] | None) -> int:
    chars = len(SYSTEM_PROMPT) + sum(len(str(part.get("text") or "")) for part in parts)
    return chars + (len(json.dumps(schema)) if schema is not None else 0)


def estimate(board: Mapping[str, Any], entry: Mapping[str, Any], *, image_ids: Sequence[str] | None = None,
             level: str | None = None, today: date | None = None,
             targets: Sequence[Target] | None = None) -> dict[str, Any]:
    """What a read costs: ``{count, batches, low, high, unconfirmed, sources}``
    and the parts behind them.

    Per batch, input is the images' tokens (``imageTokens`` each at 1024 px)
    plus the prompt and schema, and output is the batch's ``maxOutputTokens``,
    which already counts thinking. Phase 2 adds the readings as text and its
    own cap. ``low`` is one attempt of each; ``high`` adds one retry per
    batch (split in two, the costlier way it can go: both halves' prompts and
    caps) and one for the sort at twice its cap, at the higher of today's and
    tomorrow's price (a read can run past midnight into a new price row).
    ``shares`` splits ``high`` per request, so a request that never starts
    can be given back. With no price row for today the read is unpriced:
    ``low``/``high`` are None."""
    level = thinking_level(entry, level)
    day = today or date.today()
    if targets is None:
        targets = select_targets(board, image_ids)
    readable = [t for t in targets if t.path is not None]
    row_low = price_row(entry, day)
    row_next = price_row(entry, day + timedelta(days=1))
    row_high = max((r for r in (row_low, row_next) if r), default=None,
                   key=lambda r: (float(r["outputPerMTok"]), float(r["inputPerMTok"])))
    image_tokens = float(entry["imageTokens"])
    per_batch = []
    shares: dict[str, float] = {}
    low_total = high_total = 0.0
    batches = batches_of(readable)
    for number, batch in enumerate(batches, 1):
        schema = phase1_schema(LABELS[:len(batch)])
        chars = _request_chars(phase1_parts(board, batch, None), schema)
        text_low, text_high = _text_tokens(chars)
        cap = batch_cap(entry, level, len(batch))
        images_in = image_tokens * len(batch)
        halves = [batch[: (len(batch) + 1) // 2], batch[(len(batch) + 1) // 2:]] if len(batch) > 1 else [batch]
        retry_in = images_in + sum(
            _text_tokens(_request_chars(phase1_parts(board, half, None), phase1_schema(LABELS[:len(half)])))[1]
            for half in halves)
        # A batch of one can't split: its retry after MAX_TOKENS goes out at a raised cap.
        retry_out = (sum(batch_cap(entry, level, len(half)) for half in halves) if len(batch) > 1
                     else raised_cap(entry, cap))
        line = {"batch": number, "images": [t.number for t in batch], "maxOutputTokens": cap,
                "inputTokens": [int(images_in + text_low), int(images_in + text_high)],
                "retryTokens": {"input": int(retry_in), "output": int(retry_out)}}
        if row_low and row_high:
            low = _usd(images_in + text_low, cap, row_low)
            attempt_high = _usd(images_in + text_high, cap, row_high)
            retry_high = _usd(retry_in, retry_out, row_high)
            shares[f"batch:{number}"] = attempt_high
            shares[f"retry:{number}"] = retry_high
            line.update({"low": round(low, 6), "high": round(attempt_high + retry_high, 6)})
            low_total += low
            high_total += attempt_high + retry_high
        per_batch.append(line)
    phase2: dict[str, Any] | None = None
    if readable:
        labels = sort_labels(len(readable))
        reading_low, reading_high = entry["sortTokens"]["readingInput"]
        empty = [(label, t, {}) for label, t in zip(labels, readable)]
        chars = _request_chars([{"text": phase2_prompt(board, empty)}], phase2_schema(labels))
        text_low, text_high = _text_tokens(chars)
        cap = sort_cap(entry, level, len(readable))
        retry_cap = raised_cap(entry, cap)
        sort_in_low = text_low + reading_low * len(readable)
        sort_in_high = text_high + reading_high * len(readable)
        phase2 = {"maxOutputTokens": cap, "retryMaxOutputTokens": int(retry_cap),
                  "inputTokens": [int(sort_in_low), int(sort_in_high)]}
        if row_low and row_high:
            low = _usd(sort_in_low, cap, row_low)
            attempt_high = _usd(sort_in_high, cap, row_high)
            retry_high = _usd(sort_in_high, retry_cap, row_high)
            shares["sort"] = attempt_high
            shares["sort-retry"] = retry_high
            phase2.update({"low": round(low, 6), "high": round(attempt_high + retry_high, 6)})
            low_total += low
            high_total += attempt_high + retry_high
    priced = row_low is not None and row_high is not None
    return {
        "model": entry["id"],
        "reader": reader_identity(entry),
        "thinkingLevel": level,
        "count": len(readable),
        "targets": len(targets),
        "unreadable": [t.number for t in targets if t.path is None],
        "batches": len(batches),
        "low": round(low_total, 6) if priced and readable else (0.0 if priced else None),
        "high": round(high_total, 6) if priced and readable else (0.0 if priced else None),
        "unpriced": not priced,
        "unconfirmed": bool(entry.get("unconfirmed")) or bool((row_low or {}).get("unconfirmed"))
                       or bool((row_high or {}).get("unconfirmed")),
        "allowancesUnconfirmed": bool(entry.get("allowancesUnconfirmed")),
        "price": ({"low": row_low, "high": row_high, "units": entry.get("units")} if priced else None),
        "perBatch": per_batch,
        "phase2": phase2,
        "shares": {key: round(value, 6) for key, value in shares.items()},
        "sources": list(entry.get("sources") or []),
        "checked": entry.get("checked"),
        "thoughtSummaries": entry.get("thoughtSummaries"),
        "streams": bool(entry.get("streams")),
    }


def spend_check(entry: Mapping[str, Any], est: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """What ``agent_spend.decide`` takes for a read (Q11): one item, the
    chat node the person sees in Settings (``gemini-chat`` with this model),
    priced by a one-off entry built from the estimate. An unpriced read gets
    no entry, so any USD limit refuses it, as for an unpriced node."""
    # An id starting with "_" is named by its node's display name alone in a refusal.
    item = {"id": "_moodboard-read", "definitionId": str(entry["definitionId"]), "params": {"model": entry["model"]}}
    nodes: dict[str, Any] = {}
    if not est.get("unpriced") and est.get("high") is not None:
        nodes[str(entry["definitionId"])] = {
            "currency": "usd", "per": "request",
            "rows": [{"match": {}, "price": [float(est["low"]), float(est["high"])]}],
            "unconfirmed": bool(est.get("unconfirmed")),
            "sources": est.get("sources") or [], "checked": est.get("checked"),
        }
    return [item], {"nodes": nodes}


# -- images ---------------------------------------------------------------------------------

def encode_image(path: Path) -> tuple[str, str]:
    """A reference as JPEG, longest edge 1024 px, base64, in memory. The
    file on disk is never changed."""
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((IMAGE_EDGE, IMAGE_EDGE), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return "image/jpeg", base64.b64encode(buffer.getvalue()).decode("ascii")


# -- requests -------------------------------------------------------------------------------

@dataclass(frozen=True)
class TimeBounds:
    first_byte: float
    quiet: float
    total: float

    @classmethod
    def of(cls, entry: Mapping[str, Any], level: str) -> "TimeBounds":
        one = entry["timeBounds"][level]
        return cls(float(one["firstByte"]), float(one["quiet"]), float(one["total"]))


class ReaderRequestError(RuntimeError):
    """One request that failed: ``text`` says how, in words a line can show."""

    def __init__(self, text: str, *, kind: str, status: int | None = None, retryable: bool = True) -> None:
        super().__init__(text)
        self.text = text
        self.kind = kind
        self.status = status
        self.retryable = retryable
        self.detail = ""


_NOT_RETRYABLE = {400, 401, 403, 404}


class GeminiTransport:
    """Sends one reader request and feeds the answer to a parser, under the
    time bounds of section 5.6.1: the first byte within ``first_byte``, no
    quiet stretch longer than ``quiet``, and the whole request within
    ``total``. The stream route's 60 s httpx timeout bounds only the
    connection (``execution/stream_runner.py``), so the bounds are enforced
    here on every read."""

    def __init__(self, entry: Mapping[str, Any], api_key: str, *, client: httpx.AsyncClient | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.model = str(entry["model"])
        self.streams = bool(entry.get("streams"))
        self._key = api_key
        self._client = client
        self._clock = clock

    async def send(self, body: Mapping[str, Any], parser: GeminiStreamParser, bounds: TimeBounds) -> None:
        method = "streamGenerateContent?alt=sse" if self.streams else "generateContent"
        url = f"{GEMINI_BASE_URL}/{self.model}:{method}"
        headers = {"Content-Type": "application/json", "x-goog-api-key": self._key}
        owns = self._client is None
        client = self._client or httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None))
        start = self._clock()
        try:
            request = client.build_request("POST", url, headers=headers, json=body)
            response = await self._within(client.send(request, stream=True), start, bounds.first_byte, bounds,
                                          f"Google sent nothing for {bounds.first_byte:g} s")
            try:
                if response.status_code != 200:
                    raw = await self._within(response.aread(), start, bounds.quiet, bounds, "")
                    failure = ReaderRequestError(
                        f"Google returned {response.status_code}", kind="http", status=response.status_code,
                        retryable=response.status_code not in _NOT_RETRYABLE)
                    failure.detail = raw[-1024:].decode("utf-8", "replace") if raw else ""
                    raise failure
                if not self.streams:
                    raw = await self._within(response.aread(), start, bounds.total, bounds, "")
                    try:
                        parser.feed_payload(json.loads(raw))
                    except ValueError as exc:
                        raise ReaderRequestError("Google's answer wasn't JSON", kind="invalid") from exc
                    return
                chunks = response.aiter_bytes().__aiter__()
                first = True
                while True:
                    if first:
                        bound, what = bounds.first_byte - (self._clock() - start), \
                            f"Google sent nothing for {bounds.first_byte:g} s"
                    else:
                        bound, what = bounds.quiet, f"Google went quiet for {bounds.quiet:g} s"
                    try:
                        chunk = await self._within(chunks.__anext__(), start, bound, bounds, what)
                    except StopAsyncIteration:
                        return
                    if chunk:
                        first = False
                        parser.feed_bytes(chunk)
            finally:
                await response.aclose()
        except HTTP_ERRORS as exc:
            raise ReaderRequestError(f"couldn't reach Google ({describe(exc)})", kind="network") from exc
        finally:
            if owns:
                await client.aclose()

    async def _within(self, awaitable: Any, start: float, bound: float, bounds: TimeBounds, what: str) -> Any:
        left = bounds.total - (self._clock() - start)
        limit = min(bound, left)
        try:
            return await asyncio.wait_for(awaitable, timeout=max(0.0, limit))
        except asyncio.TimeoutError as exc:
            if left <= bound:
                raise ReaderRequestError(f"the answer took longer than {bounds.total:g} s",
                                         kind="timeout-total") from exc
            raise ReaderRequestError(what or f"Google went quiet for {bound:g} s", kind="timeout") from exc


@dataclass
class TextResult:
    """One text call's answer (the sort, or PR19's music direction)."""
    outcome: StreamOutcome
    error: ReaderRequestError | None

    @property
    def value(self) -> Any:
        return self.outcome.value

    @property
    def text(self) -> str:
        return self.outcome.text


async def call_text(transport: GeminiTransport, body: Mapping[str, Any], bounds: TimeBounds, *,
                    on_thought: Callable[[str], None] | None = None) -> TextResult:
    """One request whose answer is read whole: thought parts kept apart,
    every part joined. It never raises for the provider: ``error`` says what
    went wrong, and ``outcome`` holds whatever arrived."""
    parser = GeminiStreamParser(on_thought=on_thought)
    error: ReaderRequestError | None = None
    try:
        await transport.send(body, parser, bounds)
    except ReaderRequestError as exc:
        error = exc
    return TextResult(parser.close(), error)


# -- reading sources (section 5.6.2) -----------------------------------------------------------

@dataclass(frozen=True)
class ReadTask:
    """One read request, built by the shared code (``build_read_task``) and
    never by a source, so every source gets the same instructions. ``parts``
    are, in label order, ``{"text": "Image A"}``, ``{"image": {mimeType,
    data}}`` and the image's note when notes are sent. ``wider`` asks for
    more room: the retry of a lone image whose answer was cut off."""
    kind: str                            # "read" or "retry"
    batch: int
    attempt: int
    labels: tuple[str, ...]
    system: str
    instructions: str
    schema: Mapping[str, Any]
    parts: tuple[Mapping[str, Any], ...]
    wider: bool = False


@dataclass(frozen=True)
class SortTask:
    """Phase 2's text-only task: each reading under a sort label in
    ``instructions``, no images."""
    attempt: int
    labels: tuple[str, ...]
    system: str
    instructions: str
    schema: Mapping[str, Any]
    wider: bool = False
    kind: str = "sort"
    parts: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class Cause:
    """Why a request left something out, in words a line can show."""
    kind: str
    text: str
    retryable: bool = True


MISSING = Cause("missing", "no answer came back for it")


@dataclass
class ReadOutcome:
    """What a source says about one task: the labels it saw close (the shared
    core counts only what its own check accepted), whether the answer was cut
    off, and why something is missing (None: nothing went wrong)."""
    closed: list[str]
    truncated: bool = False
    cause: Cause | None = None


@dataclass
class SortOutcome:
    """The sort's answer (``{"sort": [...]}``, checked by the shared core), or
    None with why."""
    value: Any = None
    truncated: bool = False
    cause: Cause | None = None


class ReadSink:
    """Where a source hands what it reads. ``focus(label)`` when an item's
    ref is known, ``item(raw)`` when it closes (the shared item check: it
    returns the label it accepted, or None), ``thought(text)`` for thought
    summaries, shown only when the source's ``thoughts`` is true."""

    def focus(self, label: Any) -> None:
        return None

    def item(self, raw: Any) -> str | None:
        return None

    def thought(self, text: str) -> None:
        return None


class ReadingSource(abc.ABC):
    """Who reads the references (section 5.6.2): Argon (``GeminiSource``), or
    in PR10c the person's agent. A source makes the provider call and nothing
    else: it gets tasks the shared code built and hands every item to the
    sink, and it never writes a trace line.

    - ``identity``: ``{kind: "reader", id, name, color, model?, provider,
      source: "model" | "agent"}``.
    - ``priced``: "Nebula pays". True for Argon even with no list price, so
      the unpriced-read refusal still applies (Q16); false only for an agent,
      which reads on its own plan. The estimate and the spend gate run only
      when it is true (``read_estimate``, ``gate_items``).
    - ``streams``: whether items arrive one by one; ``thoughts``: whether it
      gives thought summaries (an agent never does).
    - ``can_widen(task)``: whether a ``wider`` attempt would be a different
      request from ``task`` (Argon: a raised output cap). The shared retry
      sends a lone cut-off image again only when it would be."""

    identity: dict[str, Any]
    priced: bool
    streams: bool
    thoughts: bool
    level: str | None = None  # the thinking level, for a model that has them

    @property
    def thought_summaries(self) -> bool | str:
        """The result's ``thoughtSummaries``."""
        return self.thoughts

    @abc.abstractmethod
    async def read(self, task: ReadTask, sink: ReadSink) -> ReadOutcome:
        """Read one task; never raises for the provider."""

    @abc.abstractmethod
    async def sort(self, task: SortTask, sink: ReadSink) -> SortOutcome:
        """Sort the readings; never raises for the provider."""

    def can_widen(self, task: ReadTask | SortTask) -> bool:
        return False

    def spent(self) -> dict[str, Any] | None:
        """What the reads cost Nebula so far; None when Nebula doesn't pay."""
        return None

    def estimate(self, board: Mapping[str, Any], targets: Sequence[Target], *,
                 today: date | None = None) -> dict[str, Any]:
        """A priced source's price for a read (``read_estimate``)."""
        raise NotImplementedError

    def spend_items(self, est: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """What ``agent_spend.decide`` takes for a priced source's read."""
        raise NotImplementedError


def build_read_task(board: Mapping[str, Any], targets: Sequence[Target], images: Sequence[tuple[str, str]], *,
                    batch: int, attempt: int, wider: bool = False) -> ReadTask:
    """The task for ``targets`` (labelled A, B, ... in order), with notes per
    the board's opt-in, never private notes."""
    labels = tuple(LABELS[:len(targets)])
    return ReadTask(kind="read" if attempt == 1 else "retry", batch=batch, attempt=attempt, labels=labels,
                    system=SYSTEM_PROMPT, instructions=phase1_instructions(board, len(targets)),
                    schema=phase1_schema(labels), parts=tuple(phase1_image_parts(board, targets, images)),
                    wider=wider)


def build_sort_task(board: Mapping[str, Any], labelled: Sequence[tuple[str, Target, Mapping[str, Any]]], *,
                    attempt: int, reader: str, wider: bool = False) -> SortTask:
    """The sort task for ``labelled`` readings, to go to the source whose
    ``reader_key`` is ``reader``. A reading's look names and reason are that
    source's own text, unchecked as a prompt, so they may go back only to the
    source that wrote them: a reading from any other reader (or none) raises
    ``MixedReadersError`` (section 5.6.2, "never mix")."""
    mixed = sorted({str(reading.get("reader")) for _, _, reading in labelled if reading.get("reader") != reader})
    if mixed:
        raise MixedReadersError(f"the sort for {reader} was given readings by {', '.join(mixed)}")
    labels = tuple(label for label, _, _ in labelled)
    return SortTask(attempt=attempt, labels=labels, system=SYSTEM_PROMPT,
                    instructions=phase2_prompt(board, labelled), schema=phase2_schema(labels), wider=wider)


@dataclass
class _Usage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    thoughts_tokens: int = 0
    unknown: int = 0  # requests that ended without usageMetadata

    def add(self, usage: Mapping[str, Any]) -> None:
        self.requests += 1
        if not usage:
            self.unknown += 1
            return
        self.input_tokens += int(usage.get("promptTokenCount") or 0)
        self.output_tokens += int(usage.get("candidatesTokenCount") or 0)
        self.thoughts_tokens += int(usage.get("thoughtsTokenCount") or 0)


class GeminiSource(ReadingSource):
    """Argon's source: today's Gemini request (``gemini_body`` through
    ``GeminiTransport``, read by ``GeminiStreamParser``) under the model's
    time bounds. It reports ``truncated`` for ``finishReason: MAX_TOKENS``,
    asks for thought summaries only when the model file says ``true``, and
    counts the usage Google reports. A ``wider`` task goes out at twice its
    cap, bounded by the model's output limit (``raised_cap``).

    ``api_key`` may be left out for an estimate; reading then raises
    ``NoReaderKeyError``. ``today`` picks the price row the spend is counted at."""

    priced = True  # Nebula pays, with a list price or not (Q16)

    def __init__(self, entry: Mapping[str, Any], api_key: str | None = None, *, level: str | None = None,
                 client: httpx.AsyncClient | None = None, clock: Callable[[], float] = time.monotonic,
                 today: date | None = None) -> None:
        self.entry = entry
        self.level = thinking_level(entry, level)
        self.identity = model_identity(entry)
        self.streams = bool(entry.get("streams"))
        self.thoughts = asks_for_thoughts(entry)
        self.bounds = TimeBounds.of(entry, self.level)
        self.today = today or date.today()
        self._transport = GeminiTransport(entry, api_key, client=client, clock=clock) if api_key else None
        self._usage = _Usage()

    @property
    def thought_summaries(self) -> bool | str:
        return self.entry.get("thoughtSummaries")

    def transport(self) -> GeminiTransport:
        if self._transport is None:
            check_key(self.entry, {})  # raises NoReaderKeyError
        return self._transport  # type: ignore[return-value]

    def _cap(self, task: ReadTask | SortTask, *, wider: bool | None = None) -> int:
        count = len(task.labels)
        cap = sort_cap(self.entry, self.level, count) if isinstance(task, SortTask) \
            else batch_cap(self.entry, self.level, count)
        return raised_cap(self.entry, cap) if (task.wider if wider is None else wider) else cap

    def can_widen(self, task: ReadTask | SortTask) -> bool:
        return self._cap(task, wider=True) > self._cap(task, wider=False)

    def request_body(self, task: ReadTask | SortTask) -> dict[str, Any]:
        """The ``generateContent`` body for ``task``: its text and images as
        they are, at the task's output cap."""
        return gemini_body(self.entry, parts=gemini_parts(task.instructions, task.parts), schema=task.schema,
                           level=self.level, max_output_tokens=self._cap(task), system=task.system)

    async def read(self, task: ReadTask, sink: ReadSink) -> ReadOutcome:
        if sum(len(part["image"]["data"]) for part in task.parts if "image" in part) > MAX_BASE64_CHARS:
            return ReadOutcome([], cause=Cause("too_big", "the batch's images are too large to send", retryable=False))
        transport = self.transport()
        closed: list[str] = []

        def on_item(raw: Any) -> None:
            label = sink.item(raw)
            if label is not None:
                closed.append(label)

        parser = GeminiStreamParser(items_key="readings", on_focus=sink.focus, on_item=on_item,
                                    on_thought=sink.thought if self.thoughts else None)
        error: ReaderRequestError | None = None
        try:
            await transport.send(self.request_body(task), parser, self.bounds)
        except ReaderRequestError as exc:
            error = exc
        outcome = parser.close()
        self._usage.add(outcome.usage)
        cause = _cause(error, outcome)
        return ReadOutcome(closed, truncated=cause is not None and cause.kind == "max_tokens", cause=cause)

    async def sort(self, task: SortTask, sink: ReadSink) -> SortOutcome:
        result = await call_text(self.transport(), self.request_body(task), self.bounds,
                                 on_thought=sink.thought if self.thoughts else None)
        self._usage.add(result.outcome.usage)
        if result.error is None and result.outcome.complete and isinstance(result.value, dict):
            return SortOutcome(result.value)
        cause = _cause(result.error, result.outcome) or MISSING
        return SortOutcome(None, truncated=cause.kind == "max_tokens", cause=cause)

    def spent(self) -> dict[str, Any]:
        """The usage Google reported, priced at today's row. A minimum: a
        request that ended without ``usageMetadata`` adds nothing to ``usd``."""
        row = price_row(self.entry, self.today)
        usage = self._usage
        return {"inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens,
                "thoughtsTokens": usage.thoughts_tokens, "requests": usage.requests,
                "requestsWithoutUsage": usage.unknown,
                "usd": round(_usd(usage.input_tokens, usage.output_tokens + usage.thoughts_tokens, row), 6)
                if row else None}

    def estimate(self, board: Mapping[str, Any], targets: Sequence[Target], *,
                 today: date | None = None) -> dict[str, Any]:
        return estimate(board, self.entry, level=self.level, targets=targets, today=today)

    def spend_items(self, est: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        return spend_check(self.entry, est)


def model_source(entry: Mapping[str, Any], api_key: str | None = None, **options: Any) -> ReadingSource:
    """The source for a reader in the model file. Every reader there is
    Google's today; another maker's model gets its own source."""
    if str(entry.get("provider")) != "google":
        raise ReaderError(f"{entry.get('name')} is from {entry.get('provider')}, and Nebula reads only with "
                          "Google's models so far.")
    return GeminiSource(entry, api_key, **options)


def read_estimate(source: ReadingSource, board: Mapping[str, Any], targets: Sequence[Target], *,
                  today: date | None = None) -> dict[str, Any]:
    """The estimate route's answer. A priced source prices the read
    (``estimate``); a source Nebula doesn't pay for gets no estimate maths,
    only its counts and ``billedTo: "agent"`` (section 5.6.2)."""
    if source.priced:
        return source.estimate(board, targets, today=today)
    readable = [t for t in targets if t.path is not None]
    return {"model": reader_key(source.identity), "reader": dict(source.identity), "count": len(readable),
            "targets": len(targets), "unreadable": [t.number for t in targets if t.path is None],
            "batches": len(batches_of(readable)), "billedTo": "agent", "usd": None}


def gate_items(source: ReadingSource,
               est: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    """What ``agent_spend.decide`` takes for this read, or None when Nebula
    doesn't pay for it, so there is nothing to gate or hold. A priced read
    with no list price still comes back, with no pricing entry, so any USD
    limit refuses it."""
    if not source.priced:
        return None
    return source.spend_items(est)


# -- the trace --------------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Trace:
    """The run's lines, ``seq`` from 1 with no gaps, each sent to ``sink``
    as it is written. Thought text is merged per request into chunks of at
    least 250 ms, labels and ``#n`` stripped, and never carries refs."""

    def __init__(self, *, board_id: str, run_id: str, sink: Callable[[dict[str, Any]], None] | None = None,
                 clock: Callable[[], float] = time.monotonic, now: Callable[[], str] = _now) -> None:
        self.board_id = board_id
        self.run_id = run_id
        self.lines: list[dict[str, Any]] = []
        self._sink = sink
        self._clock = clock
        self._now = now
        self._thoughts: dict[Any, list[Any]] = {}

    def add(self, kind: str, text: str = "", *, source: str = "nebula", refs: Iterable[Target] = (),
            phase: str = "reading", batch: int | None = None, attempt: int | None = None,
            look: Mapping[str, Any] | None = None, fit: float | None = None) -> dict[str, Any]:
        line: dict[str, Any] = {
            "type": "moodboardReadTrace", "boardId": self.board_id, "jobId": self.run_id,
            "seq": len(self.lines) + 1, "kind": kind, "source": source, "text": text[:LINE_LIMIT],
            "refs": [target.ref() for target in refs], "phase": phase,
        }
        if batch is not None:
            line["batch"] = batch
        if attempt is not None:
            line["attempt"] = attempt
        if look is not None:
            line["look"] = dict(look)
        if fit is not None:
            line["fit"] = fit
        line["at"] = self._now()
        self.lines.append(line)
        if self._sink is not None:
            self._sink(line)
        return line

    def thought(self, key: Any, text: str, *, phase: str, batch: int | None, attempt: int | None) -> None:
        buffered = self._thoughts.get(key)
        if buffered is None:
            buffered = self._thoughts[key] = [self._clock(), "", phase, batch, attempt]
        buffered[1] += text
        if self._clock() - buffered[0] >= THOUGHT_MERGE_SECONDS:
            self.flush_thoughts(key)

    def flush_thoughts(self, key: Any) -> None:
        buffered = self._thoughts.pop(key, None)
        if buffered is None:
            return
        _, text, phase, batch, attempt = buffered
        for piece in split_text(clean_model_text(text), LINE_LIMIT):
            self.add("thought", piece, source="reader", phase=phase, batch=batch, attempt=attempt)


# -- one item ------------------------------------------------------------------------------------

class ItemProblem(ValueError):
    def __init__(self, kind: str, text: str) -> None:
        super().__init__(text)
        self.kind = kind


def _short(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        raise ItemProblem("schema", "a text field isn't text")
    return trim_reason(clean_model_text(value), limit)


def _looks(value: Any, limit: int, *, cut: bool = True) -> list[dict[str, Any]]:
    """Checked looks, names with their spaces collapsed. A reading's look
    names are cut at ``READING_LOOK_LIMIT`` (120), twice a frame name's
    limit, so a cut name is always too long and the look-name check refuses
    it wherever it is used (the reading line, the fallback draft); the
    sort's are kept whole (``cut`` False)."""
    if not isinstance(value, list):
        raise ItemProblem("schema", "looks isn't a list")
    looks = []
    for look in value[:limit]:
        if not isinstance(look, dict) or not isinstance(look.get("name"), str) or not look["name"].strip():
            raise ItemProblem("schema", "a look has no name")
        fit = look.get("fit")
        if isinstance(fit, bool) or not isinstance(fit, (int, float)) or not math.isfinite(fit) or not 0 <= fit <= 1:
            raise ItemProblem("schema", "a look's fit isn't from 0 to 1")
        # Composed before the cut, so composing it later (the look-name
        # check does) can't bring a cut name back under the limit.
        name = " ".join(unicodedata.normalize("NFC", look["name"]).split())
        looks.append({"name": name[:READING_LOOK_LIMIT] if cut else name, "fit": round(float(fit), 3)})
    return looks


def check_reading(item: Any, labels: Sequence[str]) -> tuple[str, dict[str, Any]]:
    """The label and the checked fields of one streamed item, or ItemProblem
    (``bad_ref`` for a label outside the batch, ``schema`` otherwise)."""
    if not isinstance(item, dict):
        raise ItemProblem("schema", "an item isn't an object")
    ref = item.get("ref")
    if not isinstance(ref, str):
        raise ItemProblem("schema", "an item has no ref")
    if ref not in labels:
        raise ItemProblem("bad_ref", f"ref {ref[:20]!r} isn't in this batch")
    motifs = item.get("motifs")
    if not isinstance(motifs, list) or not all(isinstance(m, str) for m in motifs):
        raise ItemProblem("schema", "motifs isn't a list of text")
    if not isinstance(item.get("reason"), str):
        raise ItemProblem("schema", "reason isn't text")
    fields = {
        "medium": _short(item.get("medium"), FIELD_LIMIT),
        "style": _short(item.get("style"), FIELD_LIMIT),
        "light": _short(item.get("light"), FIELD_LIMIT),
        "motifs": [m for m in (_short(m, MOTIF_LIMIT) for m in motifs[:MAX_MOTIFS]) if m],
        "looks": _looks(item.get("looks"), MAX_LOOKS),
        "reason": trim_reason(clean_model_text(item["reason"])),
    }
    return ref, fields


# -- the run ------------------------------------------------------------------------------------

@dataclass
class _Sorted:
    placements: dict[str, dict[str, Any]] = field(default_factory=dict)  # imageId -> result
    new_looks: list[str] = field(default_factory=list)
    suggestions: list[dict[str, Any]] = field(default_factory=list)


class _TaskSink(ReadSink):
    """The shared item check for one task: each item a source hands over is
    checked here and only then becomes a reading and its lines."""

    def __init__(self, run: "MoodboardRead", task: ReadTask, targets: Sequence[Target]) -> None:
        self.run = run
        self.task = task
        self.by_label = dict(zip(task.labels, targets))  # frozen when the task is made
        self.key = (task.batch, task.attempt, task.labels)
        self.done: dict[str, Target] = {}
        self.focused: set[str] = set()
        self.last_done: Target | None = None

    def focus(self, label: Any) -> None:
        if isinstance(label, str) and label in self.by_label and label not in self.focused and label not in self.done:
            self.run.trace.flush_thoughts(self.key)
            self.focused.add(label)
            self.run.trace.add("focus", refs=[self.by_label[label]], batch=self.task.batch, attempt=self.task.attempt)

    def item(self, raw: Any) -> str | None:
        run, task = self.run, self.task
        run.trace.flush_thoughts(self.key)
        try:
            ref, fields = check_reading(raw, task.labels)
        except ItemProblem as problem:
            run.log.append(f"batch {task.batch} attempt {task.attempt}: {problem}")
            if problem.kind == "bad_ref":
                run.trace.add("skipped", "Ignored an answer for an image not in this batch", batch=task.batch,
                              attempt=task.attempt)
            return None
        if ref in self.done:
            run.log.append(f"batch {task.batch} attempt {task.attempt}: a second answer for {ref}, kept the first")
            return None
        target = self.by_label[ref]
        if ref not in self.focused:
            self.focused.add(ref)
            run.trace.add("focus", refs=[target], batch=task.batch, attempt=task.attempt)
        self.done[ref] = target
        self.last_done = target
        reading = run.reading(target, fields)
        best = reading["looks"][0] if reading["looks"] else None
        # The reading's own look is model text: the line names it only as
        # the board's frame or after the look-name check, else not at all.
        look = run._checked_look_ref(best["name"]) if best else None
        text = reading["reason"] + (f" → {look['name']}" if look else "")
        run.trace.add("reading", text.strip(), source="reader", refs=[target], batch=task.batch, attempt=task.attempt,
                      look=look, fit=best["fit"] if look else None)
        return ref

    def thought(self, text: str) -> None:
        if self.run.source.thoughts:
            self.run.trace.thought(self.key, text, phase="reading", batch=self.task.batch, attempt=self.task.attempt)


class _SortSink(ReadSink):
    """The sort hands over its answer whole; only thoughts stream."""

    def __init__(self, run: "MoodboardRead", attempt: int) -> None:
        self.run = run
        self.attempt = attempt
        self.key = ("sort", attempt)

    def thought(self, text: str) -> None:
        if self.run.source.thoughts:
            self.run.trace.thought(self.key, text, phase="sorting", batch=None, attempt=self.attempt)


class MoodboardRead:
    """One read of a board, as a dry run (PR4): both phases, the trace, and
    what Analyze would do. Nothing is saved and nothing moves.

    This is the shared core of section 5.6.2: the tasks, the item check, the
    retry, the sort rules and every line are here, and ``source`` makes the
    provider calls. Without ``source``, ``entry`` and ``api_keys`` make
    Argon's (``GeminiSource``), with ``level``, ``client`` (the httpx client
    requests go through; tests pass a mock transport) and ``today`` (the
    price row the spend is counted at).

    ``sink`` gets each trace line as it is written."""

    def __init__(self, board: Mapping[str, Any], entry: Mapping[str, Any] | None = None, *,
                 api_keys: Mapping[str, Any] | None = None, image_ids: Sequence[str] | None = None,
                 level: str | None = None, sink: Callable[[dict[str, Any]], None] | None = None,
                 client: httpx.AsyncClient | None = None, clock: Callable[[], float] = time.monotonic,
                 now: Callable[[], str] = _now, today: date | None = None, run_id: str | None = None,
                 requested_by: Mapping[str, Any] | None = None, targets: Sequence[Target] | None = None,
                 encode: Callable[[Path], tuple[str, str]] = encode_image,
                 source: ReadingSource | None = None) -> None:
        if source is None:
            if entry is None:
                raise TypeError("MoodboardRead needs a source, or a reader entry and api_keys")
            level = thinking_level(entry, level)
        self.board = board
        self.targets = list(targets) if targets is not None else select_targets(board, image_ids)
        if source is None:
            assert entry is not None
            source = model_source(entry, check_key(entry, api_keys or {}), level=level, client=client, clock=clock,
                                  today=today)
        self.source = source
        self.run_id = run_id or uuid.uuid4().hex[:12]
        self.requested_by = dict(requested_by) if requested_by else None
        self.trace = Trace(board_id=str(board.get("id") or ""), run_id=self.run_id, sink=sink, clock=clock, now=now)
        self._now = now
        self._encode = encode
        self._encoded: dict[str, tuple[str, str]] = {}
        self._readings: dict[str, dict[str, Any]] = {}
        self._failed: dict[str, str] = {}  # imageId -> why it couldn't be read
        self._sent: list[str] = []
        self._sort_error: str | None = None
        self._semaphore = asyncio.Semaphore(MAX_PARALLEL)
        self.log: list[str] = []  # what was ignored, for the result; never shown as a line

    def sent_so_far(self) -> list[str]:
        """The requests started so far (``batch:N``, ``retry:N``, ``sort``,
        ``sort-retry``): what a hold keeps when a read stops part way."""
        return list(self._sent)

    def reading(self, target: Target, fields: Mapping[str, Any]) -> dict[str, Any]:
        """A checked item as the reading section 4.1 describes, kept for the
        sort: who read it (``reader``, ``readerName``) and its model where
        known."""
        identity = self.source.identity
        reading = {"model": identity.get("model"), "reader": reader_key(identity), "readerName": str(identity["name"]),
                   "at": self._now(), "url": str(target.image.get("url") or ""), "readerVersion": READER_VERSION,
                   **fields}
        self._readings[target.id] = reading
        return reading

    # -- phase 1 --------------------------------------------------------------------------

    async def run(self) -> dict[str, Any]:
        for target in self.targets:
            if target.path is None:
                self._fail(target, "its file isn't on this computer")
        readable = [t for t in self.targets if t.path is not None]
        batches = batches_of(readable)
        await asyncio.gather(*(self._batch(number, batch) for number, batch in enumerate(batches, 1)))
        sorted_result = await self._sort() if self._readings else _Sorted()
        return self._finish(sorted_result)

    def _fail(self, target: Target, why: str, *, batch: int | None = None, attempt: int | None = None) -> None:
        self._failed[target.id] = why
        self.trace.add("error", f"Couldn't read #{target.number}: {why}", refs=[target], batch=batch,
                       attempt=attempt)

    def _task(self, number: int, attempt: int, targets: Sequence[Target], *, wider: bool = False) -> ReadTask:
        return build_read_task(self.board, targets, [self._encoded[t.id] for t in targets], batch=number,
                               attempt=attempt, wider=wider)

    async def _batch(self, number: int, batch: list[Target]) -> None:
        async with self._semaphore:
            ready = await asyncio.to_thread(self._encode_batch, batch)
            failed = [t for t in batch if t not in ready]
            for target in failed:
                self._fail(target, "its file couldn't be opened as an image", batch=number)
            if not ready:
                return
            self.trace.add("batch", f"Reading {numbers_text(t.number for t in ready)}", refs=ready, batch=number,
                           attempt=1)
            self._sent.append(f"batch:{number}")
            first = self._task(number, 1, ready)
            missing, outcome, last_done = await self._attempt(first, ready)
        if not missing:
            return
        cause = outcome.cause or MISSING
        if not cause.retryable:
            for target in missing:
                self._fail(target, cause.text, batch=number, attempt=1)
            return
        # The retry asks only for what's missing. It goes out in two halves
        # only when the source said its answer was cut off.
        split = outcome.truncated and len(missing) > 1
        groups = [missing[: (len(missing) + 1) // 2], missing[(len(missing) + 1) // 2:]] if split else [missing]
        wider = False
        if outcome.truncated and not split:
            # One image left can't be split, so its retry asks for more room.
            # If the source can't give it and the image was the whole batch,
            # the retry would be the first request again: don't send it.
            if len(ready) == 1 and not self.source.can_widen(first):
                for target in missing:
                    self._fail(target, cause.text, batch=number, attempt=1)
                return
            wider = True
        self.trace.add("retry", _retry_text(cause, outcome.truncated, missing, last_done, split), refs=missing,
                       batch=number, attempt=2)
        self._sent.append(f"retry:{number}")
        still: list[tuple[Target, Cause]] = []
        async with self._semaphore:
            for group in groups:
                left, again, _ = await self._attempt(self._task(number, 2, group, wider=wider), group)
                still.extend((target, again.cause or MISSING) for target in left)
        for target, why in still:
            self._fail(target, why.text, batch=number, attempt=2)

    def _encode_batch(self, batch: list[Target]) -> list[Target]:
        ready = []
        for target in batch:
            if target.id not in self._encoded:
                try:
                    self._encoded[target.id] = self._encode(target.path)  # type: ignore[arg-type]
                except (OSError, ValueError, Image.DecompressionBombError):
                    continue
            ready.append(target)
        return ready

    async def _attempt(self, task: ReadTask,
                       targets: Sequence[Target]) -> tuple[list[Target], ReadOutcome, Target | None]:
        """One task for ``targets``: the items that closed are kept (and
        already shown); the rest come back as missing, with the source's
        outcome saying why."""
        sink = _TaskSink(self, task, targets)
        outcome = await self.source.read(task, sink)
        self.trace.flush_thoughts(sink.key)
        missing = [sink.by_label[label] for label in task.labels if label not in sink.done]
        return missing, outcome, sink.last_done

    # -- phase 2 --------------------------------------------------------------------------

    async def _sort(self) -> _Sorted:
        read = [t for t in self.targets if t.id in self._readings]
        labels = sort_labels(len(read))
        labelled = [(label, t, self._readings[t.id]) for label, t in zip(labels, read)]
        by_label = {label: t for label, t, _ in labelled}
        self.trace.add("batch", f"Sorting {len(read)} into looks", phase="sorting")
        proposal: dict[str, list[dict[str, Any]]] | None = None
        wider = False
        for attempt in (1, 2):
            task = build_sort_task(self.board, labelled, attempt=attempt, reader=reader_key(self.source.identity),
                                   wider=wider)
            self._sent.append("sort" if attempt == 1 else "sort-retry")
            sink = _SortSink(self, attempt)
            outcome = await self.source.sort(task, sink)
            self.trace.flush_thoughts(sink.key)
            if isinstance(outcome.value, dict):
                proposal = _sort_items(outcome.value, by_label, self.log)
                break
            cause = outcome.cause or MISSING
            if attempt == 2 or not cause.retryable:
                self._sort_error = cause.text
                break
            if outcome.truncated:
                if not self.source.can_widen(task):  # the same request again: don't send it
                    self._sort_error = cause.text
                    break
                wider = True
            self.trace.add("retry", f"Sort answer {_cause_phrase(cause, outcome.truncated)}; asking again",
                           phase="sorting", attempt=2)
        if proposal is None:
            # Each reading's own looks still give a draft.
            self.trace.add("error", f"Couldn't sort: {self._sort_error or 'no answer'}; using each reading's own looks",
                           phase="sorting")
            proposal = {t.id: list(self._readings[t.id]["looks"][:2]) for t in read}
        return enforce_sort(self.board, self.targets, proposal, self._failed)

    # -- the end ------------------------------------------------------------------------------

    def _checked_look_ref(self, name: str) -> dict[str, Any] | None:
        """``name`` as the board's frame (the person's name, not checked),
        or as a new look's name after ``check_look_name``; None when that
        check refuses it."""
        frame = _frame_named(_frames_by_key(self.board), name)
        if frame is not None:
            return {"frameId": frame.get("id"), "name": frame.get("name")}
        checked = check_look_name(name)
        return {"frameId": None, "name": checked} if checked is not None else None

    def _finish(self, result: _Sorted) -> dict[str, Any]:
        by_id = {t.id: t for t in self.targets}
        results = []
        for target in self.targets:
            placed = result.placements.get(target.id) or {"status": "couldntRead", "look": None, "frameId": None,
                                                           "fit": None, "why": self._failed.get(target.id)}
            reading = self._readings.get(target.id)
            results.append({"number": target.number, "id": target.id, **placed,
                            "reason": reading.get("reason") if reading else None})
            if placed["status"] == "sorted":
                text = f"#{target.number} → {placed['look']}" + (" (new look)" if placed.get("newLook") else "")
                self.trace.add("result", text, refs=[target], phase="sorting",
                               look={"frameId": placed["frameId"], "name": placed["look"]}, fit=placed["fit"])
            elif placed["status"] == "unsorted":
                self.trace.add("result", f"#{target.number} Unsorted: {placed['why']}", refs=[target],
                               phase="sorting", fit=placed["fit"])
            else:
                self.trace.add("result", f"#{target.number} Unsorted: couldn't read it", refs=[target],
                               phase="sorting")
        for suggestion in result.suggestions:
            members = [by_id[i] for i in suggestion["imageIds"] if i in by_id]
            numbers = numbers_text(t.number for t in members)
            if suggestion["kind"] == "hybrid":
                text = f"Make a {suggestion['name']} look for {numbers}?"
            else:
                text = f"{numbers} could also go in {suggestion['looks'][1]} ({suggestion['fit']:.2f})"
            self.trace.add("suggestion", text, refs=members, phase="sorting")
        sorted_count = sum(1 for r in results if r["status"] == "sorted")
        looks = sorted({r["look"] for r in results if r["status"] == "sorted"})
        unsorted = sum(1 for r in results if r["status"] != "sorted")
        summary = {"sorted": sorted_count, "looks": len(looks), "unsorted": unsorted,
                   "couldntRead": sum(1 for r in results if r["status"] == "couldntRead"),
                   "newLooks": len(result.new_looks), "suggestions": len(result.suggestions)}
        text = f"Dry run: would sort {sorted_count} into {len(looks)} look{'' if len(looks) == 1 else 's'}"
        if result.new_looks:
            text += f" ({len(result.new_looks)} new)"
        if unsorted:
            text += f" · {unsorted} Unsorted"
        self.trace.add("done", text + " · nothing moved", phase="done")
        source = self.source
        return {
            "dryRun": True, "applied": False, "runId": self.run_id, "boardId": self.board.get("id"),
            "reader": dict(source.identity), "requestedBy": self.requested_by, "model": reader_key(source.identity),
            "thinkingLevel": source.level, "thoughtSummaries": source.thought_summaries,
            "results": results, "suggestions": result.suggestions, "newLooks": result.new_looks,
            "readings": dict(self._readings), "summary": summary, "spent": source.spent(), "sent": list(self._sent),
            "sortError": self._sort_error, "ignored": list(self.log), "trace": list(self.trace.lines),
        }


def _cause(error: ReaderRequestError | None, outcome: StreamOutcome) -> Cause | None:
    """Why a Gemini request left something out; None when the answer ended
    cleanly (whatever is still missing was simply not answered)."""
    if error is not None:
        return Cause(error.kind, error.text, error.retryable)
    if outcome.block_reason:
        return Cause("blocked", f"Google blocked the request ({outcome.block_reason})", retryable=False)
    if outcome.error:
        return Cause("stream_error", f"Google stopped with an error: {outcome.error}"[:150])
    if outcome.finish_reason == "MAX_TOKENS":
        return Cause("max_tokens", "the answer hit its token cap")
    if not outcome.complete or outcome.value is None:
        return Cause("invalid_json", "the answer wasn't valid JSON")
    if outcome.finish_reason not in (None, "STOP"):
        return Cause("stopped", f"Google stopped the answer ({outcome.finish_reason})")
    return None


def _cause_phrase(cause: Cause, truncated: bool) -> str:
    if truncated:
        return "was cut off"
    return {"invalid_json": "wasn't valid JSON", "missing": "left some out"}.get(cause.kind, f"failed ({cause.text})")


def _retry_text(cause: Cause, truncated: bool, missing: list[Target], last_done: Target | None, split: bool) -> str:
    numbers = numbers_text(t.number for t in missing)
    tail = f"; asking again for {numbers}" + (" in two halves" if split else "")
    if truncated:
        return ("Answer cut off" + (f" after #{last_done.number}" if last_done else "")) + tail
    if cause.kind == "invalid_json":
        return "Answer wasn't valid JSON" + tail
    if cause.kind == "missing":
        return f"No answer for {numbers}; asking again"
    return cause.text[0].upper() + cause.text[1:] + tail


def _sort_items(value: Mapping[str, Any], by_label: Mapping[str, Target], log: list[str]) -> dict[str, list[dict[str, Any]]]:
    """The sort's looks per image id, checked like the readings: unknown
    refs and bad items are dropped and logged, a duplicate keeps the first."""
    out: dict[str, list[dict[str, Any]]] = {}
    items = value.get("sort")
    for item in items if isinstance(items, list) else []:
        ref = item.get("ref") if isinstance(item, dict) else None
        if not isinstance(ref, str) or ref not in by_label:
            log.append(f"sort: ref {str(ref)[:20]!r} isn't one of the references")
            continue
        target = by_label[ref]
        if target.id in out:
            log.append(f"sort: a second answer for {ref}, kept the first")
            continue
        try:
            out[target.id] = _looks(item.get("looks"), 2, cut=False)
        except ItemProblem as problem:
            log.append(f"sort: {ref}: {problem}")
    return out


def _frames_by_key(board: Mapping[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """The board's look frames by ``_look_key``, each key's frames in board
    order: two frames can share a key ("Mid–century" and "Mid-century")."""
    frames: dict[str, list[dict[str, Any]]] = {}
    for frame in board.get("frames") or []:
        if isinstance(frame, dict) and frame.get("kind") == "look" and frame.get("name"):
            frames.setdefault(_look_key(str(frame["name"])), []).append(frame)
    return frames


def _frame_named(frames: Mapping[str, list[dict[str, Any]]], name: str) -> dict[str, Any] | None:
    """The frame a look name means: of the frames sharing its key, the one
    whose name is exactly ``name`` as given, else the first on the board."""
    same = frames.get(_look_key(name)) or []
    return next((frame for frame in same if frame["name"] == name), same[0] if same else None)


# Typographic apostrophes and dashes that keyboards, autocorrect and models
# write for ' and -: right and left single quotation marks, the modifier
# letter apostrophe, the en and em dashes, the hyphen and the non-breaking
# hyphen. Nothing else is mapped (not primes, minus, bars or double quotes):
# a look-alike outside this set is refused, not guessed at.
_LOOK_NAME_TYPOGRAPHY = str.maketrans({"\u2019": "'", "\u2018": "'", "\u02bc": "'",
                                       "\u2013": "-", "\u2014": "-", "\u2010": "-", "\u2011": "-"})
_LOOK_NAME_PUNCTUATION = set(" &-'")
_LOOK_NAME_WORDS = 4
# A sort label ("R3", "r12", "R 3", as "# 18" is a #n) or a link ("https",
# "www") in a name, as whole words in any case.
_SORT_LABEL_OR_LINK = re.compile(r"(?i:\bR\s*\d+\b|\bhttps?\b|\bwww\b)")
# The words of a name, to tell a name that is only batch labels ("B", "'b'",
# "A & C"; "Plan B" and "B&W film" are names).
_LOOK_NAME_WORD = re.compile(r"[^\W_]+")
_BATCH_LABEL = re.compile(r"[A-Fa-f]")


def normalize_look_name(name: str) -> str:
    """``name`` composed (NFC, so "Café" has one spelling), with
    ``_LOOK_NAME_TYPOGRAPHY``'s apostrophes and dashes made plain and its
    spaces collapsed: the form a new look is stored and shown in."""
    return " ".join(unicodedata.normalize("NFC", name).translate(_LOOK_NAME_TYPOGRAPHY).split())


def _names_a_label_any_case(name: str) -> bool:
    """A batch label or ``#n`` in any case after its noun
    (``names_a_label_any_case``: "image b", never the article in "Photo a
    day"), or a name whose every word is a batch label ("B", "A & C"), read
    through ``skeleton`` so a look-alike ("Image В", Cyrillic) is the letter
    it copies. One letter repeated ("B&B") is a phrase, not labels: a batch
    never names one image twice in a list."""
    words = _LOOK_NAME_WORD.findall(skeleton(name))
    if words and all(_BATCH_LABEL.fullmatch(word) for word in words) and (
            len(words) == 1 or len({word.upper() for word in words}) > 1):
        return True
    return names_a_label_any_case(name)


def _look_words(name: str) -> int:
    """How many words ``name`` has: runs with a letter or digit in them, so
    a lone "&" or "-" isn't one ("Black & white film grain" is 4)."""
    return sum(1 for word in name.split() if any(map(_look_char, word)))


def _look_key(name: str) -> str:
    """How look names are matched: normalised, ignoring case, so the
    person's "Mid–century" frame is the sort's "mid-century"."""
    return normalize_look_name(name).casefold()


def _look_char(ch: str) -> bool:
    # isdecimal, not isdigit: "³", "①" and "⓵" aren't digits in a name.
    return ch.isalpha() or ch.isdecimal()


def check_look_name(name: Any) -> str | None:
    """A new look's name from the sort, normalised (``normalize_look_name``:
    composed, typographic apostrophes and dashes made plain, spaces
    collapsed), or None when it fails section 5.6.2's check: no
    compatibility characters, 1 to 60 characters, at most 4 words, only
    letters, decimal digits, spaces and ``&-'``, at least one letter or
    digit, and no ``#n``, batch or sort label (in any case), link or ``@``.
    A frame name is the
    one piece of model text that becomes board data and then shows in
    update templates, so it is checked for every source, Argon's too."""
    if not isinstance(name, str):
        return None
    name = normalize_look_name(name)
    # A compatibility character (fullwidth "Ｒ３", "𝐑", "ﬁ", "③") would
    # spell a label or link the checks below can't see: refused, not folded.
    if unicodedata.normalize("NFKC", name) != name:
        return None
    if not 1 <= len(name) <= FRAME_NAME_LIMIT or _look_words(name) > _LOOK_NAME_WORDS:
        return None
    # isalnum would let "½" and "Ⅻ" in.
    if not all(_look_char(ch) or ch in _LOOK_NAME_PUNCTUATION for ch in name) or not any(map(_look_char, name)):
        return None
    # The label and link checks read look-alikes from other scripts as the
    # letter or digit they copy (``skeletons``); the name keeps its own letters.
    if _names_a_label_any_case(name) or any(map(_SORT_LABEL_OR_LINK.search, skeletons(name))):
        return None
    return name


def enforce_sort(board: Mapping[str, Any], targets: Sequence[Target], proposal: Mapping[str, list[dict[str, Any]]],
                 failed: Mapping[str, str]) -> _Sorted:
    """Section 5.6's rules on the model's proposal, in Python. Only
    ``targets`` are placed. Existing looks keep their names (matched ignoring
    case); "Unsorted" is never a look; the best look is the highest fit. A
    fit below 0.5, no look, or a failed
    read goes to Unsorted. At most 8 new looks, the ones with the most images
    first (then the first named); an image whose best look didn't make it
    tries its second. Each image goes to its best look only; a second look
    with a fit of 0.5 or more becomes an ``alsoIn`` suggestion, and 3 or more
    images sharing the same pair become one ``hybrid`` suggestion instead.
    A new look whose name fails ``check_look_name`` is dropped: an image
    whose best look it was goes to Unsorted (not to its second look), and it
    is never a second look or a suggestion. Existing looks aren't checked:
    their names are the person's."""
    frames = _frames_by_key(board)
    out = _Sorted()

    def usable(looks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        seen, kept = set(), []
        for look in looks:
            given = str(look.get("name") or "")
            name = normalize_look_name(given)
            key = name.casefold()
            if not name or key == "unsorted" or key in seen:
                continue
            seen.add(key)
            # Two frames whose names normalise alike: the exact one, else
            # the first on the board (``_frame_named``), never dict order.
            frame = _frame_named(frames, given)
            # A new look is kept in its checked form; the check runs on the
            # whole name, so a reading's over-long look in the fallback draft
            # is refused, never cut until it fits.
            checked = None if frame else check_look_name(name)
            kept.append({"name": frame["name"] if frame else (checked or name), "fit": float(look.get("fit") or 0),
                         "frameId": frame.get("id") if frame else None,
                         "refused": frame is None and checked is None})
        # Best means the highest fit, whatever order the model gave.
        return sorted(kept, key=lambda look: -look["fit"])

    candidates = {t.id: usable(list(proposal.get(t.id) or [])) for t in targets if t.id not in failed}
    # One spelling per new look, the first given, so every image, line and
    # suggestion names the frame it would make ("Women's Wear" is "Women's wear").
    spelling: dict[str, str] = {}
    for looks in candidates.values():
        for look in looks:
            if look["frameId"] is None and not look["refused"]:
                look["name"] = spelling.setdefault(look["name"].casefold(), look["name"])
    counts: dict[str, int] = {}
    order: list[str] = []
    for looks in candidates.values():
        if looks and looks[0]["fit"] >= MIN_FIT and looks[0]["frameId"] is None and not looks[0]["refused"]:
            key = looks[0]["name"].casefold()
            if key not in counts:
                order.append(key)
            counts[key] = counts.get(key, 0) + 1
    allowed_new = set(sorted(order, key=lambda k: (-counts[k], order.index(k)))[:MAX_NEW_LOOKS])

    def allowed(look: dict[str, Any]) -> bool:
        return look["frameId"] is not None or look["name"].casefold() in allowed_new

    pairs: dict[tuple[str, str], list[tuple[str, float]]] = {}
    new_names: dict[str, str] = {}
    for target in targets:
        if target.id in failed:
            out.placements[target.id] = {"status": "couldntRead", "look": None, "frameId": None, "fit": None,
                                         "why": failed[target.id]}
            continue
        proposed = candidates.get(target.id, [])
        if proposed and proposed[0]["refused"] and proposed[0]["fit"] >= MIN_FIT:
            out.placements[target.id] = {"status": "unsorted", "look": None, "frameId": None,
                                         "fit": proposed[0]["fit"], "why": "its look's name was refused"}
            continue
        looks = [look for look in proposed if not look["refused"] and allowed(look)]
        best = looks[0] if looks else None
        if best is None or best["fit"] < MIN_FIT:
            fit = best["fit"] if best else None
            if best is None and proposed and proposed[0]["fit"] >= MIN_FIT:
                why = f"already {MAX_NEW_LOOKS} new looks"
            else:
                why = f"no look fits ({fit:.2f})" if fit is not None else "no look fits"
            out.placements[target.id] = {"status": "unsorted", "look": None, "frameId": None, "fit": fit, "why": why}
            continue
        new = best["frameId"] is None
        if new:
            new_names.setdefault(best["name"].casefold(), best["name"])
        out.placements[target.id] = {"status": "sorted", "look": best["name"], "frameId": best["frameId"],
                                     "fit": best["fit"], "newLook": new, "why": None}
        second = looks[1] if len(looks) > 1 else None
        if second is not None and second["fit"] >= MIN_FIT:
            pairs.setdefault((best["name"], second["name"]), []).append((target.id, second["fit"]))
    out.new_looks = list(new_names.values())
    grouped: dict[frozenset[str], list[tuple[tuple[str, str], str, float]]] = {}
    for pair, members in pairs.items():
        for image_id, fit in members:
            grouped.setdefault(frozenset(pair), []).append((pair, image_id, fit))
    for key, members in grouped.items():
        if len(members) >= HYBRID_MIN:
            first, second = members[0][0]
            out.suggestions.append({"kind": "hybrid", "imageIds": [m[1] for m in members],
                                    "looks": [first, second], "name": f"{first} × {second}",
                                    "by": "analyze"})
        else:
            for pair, image_id, fit in members:
                out.suggestions.append({"kind": "alsoIn", "imageIds": [image_id], "looks": list(pair),
                                        "fit": round(fit, 3), "by": "analyze"})
    return out
