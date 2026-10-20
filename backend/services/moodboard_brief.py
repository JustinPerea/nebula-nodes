"""The brief a moodboard sends to generators (design-canvas gap 14).

A board keeps the person's own direction on the board itself, outside the
analysis, so analyzing again can't drop it:

- ``direction``: what the board is for, in positive words.
- ``avoid``: a list of things to keep out of the image.
- ``pinnedColors``: ``{"include": [...], "exclude": [...]}`` hex colours that
  must appear or must not appear.
- ``briefOverride``: ``{"text", "basis", "updatedAt"}`` or ``None``, a
  hand-written brief that replaces the generated one. ``basis`` is the
  board's ``brief_basis`` when the text was written, so a later change to the
  board shows as "changed since you edited this".

``compose`` joins the analysis with those fields into what a generator gets.
Negatives are defects only ("blurry, low-detail artifacts") plus the person's
Avoid list; content intent goes into the brief as positive sentences.

``apply_to_generator`` is the one place a board reaches a generator's request
(the engine calls it before any handler). A board at strength 0 is dropped
first, as if it weren't wired (Q36 a). Otherwise the brief joins the prompt, the
negatives fill a ``negative_prompt`` field when the model has one, and the
Avoid list joins the prompt only for instruction-following models (GPT Image,
Nano Banana, Krea 2). Diffusion-style models read "no X" as "X", so they never
get it in the prompt.

``migrate_board`` moves boards saved before these fields existed (B7).

**Precedence (gap 18).** Where two parts of a board disagree, the higher
wins; where the higher says nothing, the lower fills in:

1. the hand-written brief (``briefOverride``), as is; no check runs on it;
2. pinned colours: "must appear" always go, even against Avoid (the clash
   is flagged, ``pinnedClashes``); "keep out" drops near measured colours;
3. Direction and Avoid: the colour-word check
   (services/moodboard_colour_words.py) compares them with the measured
   colours, and ``clashMode`` says what happens to a clash;
4. board notes: sent only when the board (``sendNotes``) or the node
   (``send_notes``) opts in. Image notes and the cues lifted from the notes
   follow the same switch;
5. what Nebula measured: palette, accents, measured cues.

More fields, all optional on old boards (read with their defaults, never
rewritten on read):

- ``clashMode``: ``leave-out`` (default: conflicts leave the brief, listed
  with the reason), ``flag`` (nothing left out, clashes listed),
  ``no-measured`` (with a Direction, no measured colour goes) or
  ``keep-all`` (as before: the check runs, nothing is applied).
- ``colorChoices``: ``{"keep": [...], "leaveOut": [...]}``, the person's
  Keep anyway and Leave out, matched to measured colours within dE00 5.
- ``sendNotes``: board notes to generators. Off by default. Only the person
  may turn it on (the store refuses an agent, ``NotesOptInProtected``).
- ``colorCheck``: the saved check, written by the store whenever its basis
  (Direction, Avoid, pinned "must appear", the measured colours and
  ``LEXICON_VERSION``) moves. ``compose`` uses it at its basis, else checks
  in memory. Findings from any check carry ``foundBy``; a second check adds
  ``checks.<name>`` and its findings under the same basis.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Bumped when the board's brief fields change shape; a board without it is
# migrated once (see migrate_board).
BRIEF_FIELDS_VERSION = 1

DEFECT_NEGATIVES: tuple[str, ...] = ("blurry", "low-detail artifacts")

AVOID_LIMIT = 40
AVOID_ITEM_LIMIT = 200
PINNED_LIMIT = 12
DIRECTION_LIMIT = 4000
OVERRIDE_LIMIT = 20000
# Keep anyway and Leave out: at most this many colours in each list.
COLOR_CHOICES_LIMIT = 24

# What a board does when its words clash with a measured colour (gap 18, P1).
CLASH_MODES = ("leave-out", "flag", "no-measured", "keep-all")
DEFAULT_CLASH_MODE = "leave-out"
# The saved check's own shape; LEXICON_VERSION (in its basis) covers the rules.
COLOR_CHECK_VERSION = 1
MODE_OFF_REASON = "Measured colors are off for this board"
# What the node's ``send_notes`` param says (services/moodboard_brief.compose's send_notes).
NODE_NOTES_CHOICES = {"board": None, "yes": True, "no": False}

# What each mode asks of a generator, phrased as what to do.
MODE_INTENTS = {
    "look": "Take the visual style only: palette, light, texture and finish. The subject comes from the prompt.",
    "world": ("Carry the world: its materials, environment and production design, "
              "kept to one era and one consistent material language, in specific places."),
    "subject": ("Keep the subject consistent: the same silhouette, costume and identifying features, "
                "changing wardrobe only when the prompt asks."),
}

# Fields a vision reader fills (empty from the colour analyzer today).
_READER_FIELDS = (("motifs", "Motifs"), ("materials", "Materials"), ("textures", "Textures"))

# Model families that follow written instructions, so "keep X out" works in
# the prompt. Everything else is treated as diffusion-style.
_INSTRUCTION_FOLLOWING_PREFIXES = (
    "gpt-image-",
    "nano-banana",
    "krea-2-",
    "krea-image-openai-gpt-image",
    "krea-image-google-nano-banana",
    "krea-image-krea-krea-2",
)

# Nodes whose handler reads the wired board itself (Krea 2 turns its images
# into style references). Every other generator's Moodboard port exists only
# for the brief, so the port is folded into the prompt and not passed on: a
# handler that sends wired ports by name (Krea's catalog routes) would
# otherwise send the bundle to the provider.
_HANDLER_READS_BOARD = frozenset({"krea-2-generate"})

# A board at strength 0 is off for every node it's wired into, text included
# (Q36 a, Justin 2026-10-20): no brief, Avoid, negatives or images. The
# node's "Send board images" switch is how to keep the text without images.
BOARD_STRENGTH_ZERO_NOTE = "Board strength is 0: board not sent"

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


# -- the fields --------------------------------------------------------------

def normalize_direction(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > DIRECTION_LIMIT:
        raise ValueError(f"direction is longer than {DIRECTION_LIMIT} characters")
    return text


def normalize_avoid(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        raise ValueError("avoid must be a list of strings")
    items: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, str):
            raise ValueError(f"avoid[{index}] must be a string")
        text = " ".join(raw.split()).strip(" ,.")
        if not text:
            continue
        if len(text) > AVOID_ITEM_LIMIT:
            raise ValueError(f"avoid[{index}] is longer than {AVOID_ITEM_LIMIT} characters")
        if text.lower() in seen:
            continue
        seen.add(text.lower())
        items.append(text)
    if len(items) > AVOID_LIMIT:
        raise ValueError(f"avoid holds at most {AVOID_LIMIT} items")
    return items


def normalize_hex(value: Any) -> str:
    match = _HEX_RE.match(str(value or "").strip())
    if not match:
        raise ValueError(f"not a hex colour: {value!r}")
    digits = match.group(1).lower()
    if len(digits) == 3:
        digits = "".join(ch * 2 for ch in digits)
    return f"#{digits}"


def normalize_pinned_colors(value: Any) -> dict[str, list[str]]:
    if value is None:
        return {"include": [], "exclude": []}
    if not isinstance(value, dict):
        raise ValueError("pinnedColors must be an object with include and exclude lists")
    unknown = set(value) - {"include", "exclude"}
    if unknown:
        raise ValueError(f"pinnedColors has unknown keys: {', '.join(sorted(unknown))}")
    result: dict[str, list[str]] = {}
    for key in ("include", "exclude"):
        raw = value.get(key) or []
        if not isinstance(raw, list):
            raise ValueError(f"pinnedColors.{key} must be a list of hex colours")
        colours: list[str] = []
        for item in raw:
            hex_value = normalize_hex(item)
            if hex_value not in colours:
                colours.append(hex_value)
        if len(colours) > PINNED_LIMIT:
            raise ValueError(f"pinnedColors.{key} holds at most {PINNED_LIMIT} colours")
        result[key] = colours
    both = set(result["include"]) & set(result["exclude"])
    if both:
        raise ValueError(f"a colour can't be both pinned and kept out: {', '.join(sorted(both))}")
    return result


def normalize_override_text(value: Any) -> str:
    text = str(value or "").strip()
    if len(text) > OVERRIDE_LIMIT:
        raise ValueError(f"briefOverride.text is longer than {OVERRIDE_LIMIT} characters")
    return text


def board_fields(board: dict[str, Any]) -> tuple[str, list[str], dict[str, list[str]]]:
    """The board's direction, avoid list and pinned colours, read leniently:
    a board file edited by hand (``"avoid": 5``) still opens."""
    try:
        direction = normalize_direction(board.get("direction"))
    except ValueError:
        direction = str(board.get("direction") or "").strip()
    try:
        avoid = normalize_avoid(board.get("avoid"))
    except ValueError:
        raw_avoid = board.get("avoid")
        avoid = [item for item in raw_avoid if isinstance(item, str) and item.strip()] \
            if isinstance(raw_avoid, list) else []
    try:
        pinned = normalize_pinned_colors(board.get("pinnedColors"))
    except ValueError:
        pinned = {"include": [], "exclude": []}
    return direction, avoid, pinned


def normalize_clash_mode(value: Any) -> str:
    if value is None:
        return DEFAULT_CLASH_MODE
    if value not in CLASH_MODES:
        raise ValueError(f"clashMode must be one of {', '.join(CLASH_MODES)}")
    return str(value)


def normalize_color_choices(value: Any, kept_out: list[str] | None = None) -> dict[str, list[str]]:
    """``{"keep": [...], "leaveOut": [...]}``, hex normalized like pins. A
    colour can be in one list only, and a Keep anyway colour can't be one
    the person pinned to keep out."""
    if value is None:
        return {"keep": [], "leaveOut": []}
    if not isinstance(value, dict):
        raise ValueError("colorChoices must be an object with keep and leaveOut lists")
    unknown = set(value) - {"keep", "leaveOut"}
    if unknown:
        raise ValueError(f"colorChoices has unknown keys: {', '.join(sorted(unknown))}")
    result: dict[str, list[str]] = {}
    for key in ("keep", "leaveOut"):
        raw = value.get(key) or []
        if not isinstance(raw, list):
            raise ValueError(f"colorChoices.{key} must be a list of hex colours")
        colours: list[str] = []
        for item in raw:
            hex_value = normalize_hex(item)
            if hex_value not in colours:
                colours.append(hex_value)
        if len(colours) > COLOR_CHOICES_LIMIT:
            raise ValueError(f"colorChoices.{key} holds at most {COLOR_CHOICES_LIMIT} colours")
        result[key] = colours
    both = set(result["keep"]) & set(result["leaveOut"])
    if both:
        raise ValueError(f"a colour can't be both kept and left out: {', '.join(sorted(both))}")
    pinned_out = set(result["keep"]) & set(kept_out or [])
    if pinned_out:
        raise ValueError(f"a colour pinned to keep out can't be kept anyway: {', '.join(sorted(pinned_out))}. "
                         "Unpin it first")
    return result


def normalize_send_notes(value: Any) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ValueError("sendNotes must be true or false")
    return value


def board_options(board: dict[str, Any]) -> tuple[str, dict[str, list[str]], bool]:
    """The board's clash mode, colour choices and notes switch, read
    leniently: anything odd reads as the default."""
    mode = board.get("clashMode")
    mode = mode if mode in CLASH_MODES else DEFAULT_CLASH_MODE
    try:
        choices = normalize_color_choices(board.get("colorChoices"))
    except ValueError:
        choices = {"keep": [], "leaveOut": []}
    return mode, choices, board.get("sendNotes") is True


def brief_basis(board: dict[str, Any]) -> str:
    """What the brief is made from: the analysis's inputs plus the brief fields.

    An override written against one basis is "changed since you edited this"
    once the basis moves. The name is left out, as in ``source_hash``.
    """
    from services.moodboard_analysis import source_hash

    direction, avoid, pinned = board_fields(board)
    images = board.get("images")
    readable = board if isinstance(images, list) else {**board, "images": []}
    payload: dict[str, Any] = {"source": source_hash(readable), "direction": direction, "avoid": avoid,
                               "pinned": pinned}
    # Gap 18's fields count only when they differ from the defaults, so an
    # override written before them keeps its basis.
    mode, choices, send_notes = board_options(board)
    options: dict[str, Any] = {}
    if mode != DEFAULT_CLASH_MODE:
        options["clashMode"] = mode
    if choices["keep"] or choices["leaveOut"]:
        options["colorChoices"] = choices
    if send_notes:
        options["sendNotes"] = True
    if options:
        payload["options"] = options
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


# -- composing the brief -----------------------------------------------------

def without_excluded(colours: list[str], excluded: list[str]) -> list[str]:
    if not excluded:
        return list(colours)
    import numpy as np

    from commons.colour import delta_e00, hex_to_lab
    from commons.measure import MERGE_DELTA_E

    labs = np.array([hex_to_lab(hex_value) for hex_value in excluded])
    kept: list[str] = []
    for colour in colours:
        try:
            distance = float(np.min(delta_e00(hex_to_lab(colour)[None, :], labs)))
        except (ValueError, TypeError):
            kept.append(colour)
            continue
        if distance >= MERGE_DELTA_E:
            kept.append(colour)
    return kept


def _choice_near(hex_value: str, choices: dict[str, list[str]]) -> str | None:
    """Which list (``keep`` or ``leaveOut``) holds the choice nearest a
    measured colour, within dE00 5 (Commons' "same colour", as
    ``without_excluded``), so a choice survives a re-analysis that shifts the
    hex a little. None when no choice is that close."""
    import numpy as np

    from commons.colour import delta_e00, hex_to_lab
    from commons.measure import MERGE_DELTA_E

    best: tuple[float, str] | None = None
    for key in ("leaveOut", "keep"):
        if not choices[key]:
            continue
        try:
            labs = np.array([hex_to_lab(choice) for choice in choices[key]])
            distance = float(np.min(delta_e00(hex_to_lab(hex_value)[None, :], labs)))
        except (ValueError, TypeError):
            continue
        if distance < MERGE_DELTA_E and (best is None or distance < best[0]):
            best = (distance, key)
    return best[1] if best else None


# -- the colour-word check (gap 18) -------------------------------------------

def _measured_colours(analysis: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The colours an analysis measured: palette and accents with their role
    and share (None when the analysis has no shares)."""
    if not isinstance(analysis, dict):
        return []
    shares: dict[tuple[str, str], float] = {}
    for colour in analysis.get("colors") or []:
        if isinstance(colour, dict) and isinstance(colour.get("hex"), str):
            role = "accent" if colour.get("role") == "accent" else "palette"
            try:
                shares[(colour["hex"].lower(), role)] = float(colour.get("share"))
            except (TypeError, ValueError):
                pass
    out: list[dict[str, Any]] = []
    for key, role in (("palette", "palette"), ("accents", "accent")):
        for hex_value in _str_list(analysis.get(key)):
            out.append({"hex": hex_value.lower(), "role": role, "share": shares.get((hex_value.lower(), role))})
    return out


def colour_check_basis(board: dict[str, Any], analysis: dict[str, Any] | None = None) -> str:
    """What the colour check reads: Direction, Avoid, pinned "must appear",
    the measured colours (hex, role, share) and the lexicon's version."""
    from services.moodboard_colour_words import LEXICON_VERSION

    if analysis is None:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    direction, avoid, pinned = board_fields(board)
    payload = {"direction": direction, "avoid": avoid, "include": pinned["include"],
               "colours": [[c["hex"], c["role"], c["share"]] for c in _measured_colours(analysis)],
               "lexicon": LEXICON_VERSION, "version": COLOR_CHECK_VERSION}
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def colour_check(board: dict[str, Any], analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    """The colour-word check, run now: ``{"version", "basis", "checks":
    {"words": {"version"}}, "findings"}``. Each finding records ``foundBy``."""
    from services.moodboard_colour_words import LEXICON_VERSION, check

    if analysis is None:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    direction, avoid, pinned = board_fields(board)
    findings = check(direction, avoid, _measured_colours(analysis), pinned["include"])
    return {"version": COLOR_CHECK_VERSION, "basis": colour_check_basis(board, analysis),
            "checks": {"words": {"version": LEXICON_VERSION}}, "findings": findings}


def current_colour_check(board: dict[str, Any], analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    """The saved check when it was made from what the board holds now
    (its basis matches), so findings another check added count; else the
    words check run in memory, saving nothing. A stale saved check's other
    findings wait until that check runs again."""
    if analysis is None:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    saved = board.get("colorCheck")
    if (isinstance(saved, dict) and isinstance(saved.get("findings"), list)
            and saved.get("basis") == colour_check_basis(board, analysis)):
        return saved
    return colour_check(board, analysis)


def refresh_colour_check(board: dict[str, Any]) -> None:
    """Save the check on the board when what it reads has changed (the store
    calls this on every create and update). A check that fails leaves the
    saved one as it was: compose checks in memory when the basis moved."""
    try:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
        saved = board.get("colorCheck")
        if isinstance(saved, dict) and saved.get("basis") == colour_check_basis(board, analysis):
            return
        board["colorCheck"] = colour_check(board, analysis)
    except Exception:  # noqa: BLE001 - a board must always save
        logger.exception("Moodboard %s: colour check not saved", board.get("id"))


_LEVEL_ORDER = {"conflict": 0, "warning": 1}


def _merged_findings(findings: list[Any]) -> dict[tuple[str | None, str], dict[str, Any]]:
    """Findings per (hex, role): the worst level, every reason (conflicts
    first, Avoid before Direction) and every check that found one."""
    merged: dict[tuple[str | None, str], dict[str, Any]] = {}
    ordered = sorted(
        (f for f in findings if isinstance(f, dict) and f.get("level") in _LEVEL_ORDER),
        key=lambda f: (_LEVEL_ORDER[f["level"]], f.get("source") != "avoid"))
    for finding in ordered:
        hex_value = finding.get("hex")
        key = (hex_value.lower() if isinstance(hex_value, str) else None, str(finding.get("role") or "palette"))
        entry = merged.setdefault(key, {"hex": key[0], "role": key[1], "share": finding.get("share"),
                                        "level": finding["level"], "reason": "", "reasons": [], "foundBy": []})
        reason = str(finding.get("reason") or "")
        if reason and reason not in entry["reasons"]:
            entry["reasons"].append(reason)
        found_by = str(finding.get("foundBy") or "")
        if found_by and found_by not in entry["foundBy"]:
            entry["foundBy"].append(found_by)
    for entry in merged.values():
        entry["reason"] = entry["reasons"][0] if entry["reasons"] else ""
    return merged


def _listed(entry: dict[str, Any] | None, hex_value: str, role: str, why: str, *,
            reason: str | None = None) -> dict[str, Any]:
    item = {"hex": hex_value, "role": role, "share": None, "level": "off", "reason": "", "reasons": [],
            "foundBy": []}
    if entry is not None:
        item.update({key: (list(value) if isinstance(value, list) else value) for key, value in entry.items()})
        item["hex"], item["role"] = hex_value, role
    if reason is not None:
        item["reasons"] = [reason, *[r for r in item["reasons"] if r != reason]]
        item["reason"] = reason
    item["why"] = why
    return item


def resolve_colours(board: dict[str, Any], analysis: dict[str, Any] | None) -> dict[str, Any]:
    """Which measured colours generators get, and the lists that say why
    the rest don't (``clashMode``, ``colorChoices``, the check)."""
    direction, _avoid, pinned = board_fields(board)
    mode, choices, _notes = board_options(board)
    palette = without_excluded(_str_list((analysis or {}).get("palette")), pinned["exclude"])
    accents = without_excluded(_str_list((analysis or {}).get("accents")), pinned["exclude"])
    result: dict[str, Any] = {"palette": palette, "accents": accents, "leftOut": [], "mayClash": [], "kept": [],
                              "pinnedClashes": [], "paletteClashes": []}
    if mode == "keep-all":
        return result
    check = current_colour_check(board, analysis)
    merged = _merged_findings(check.get("findings") or [])
    effective = "leave-out" if mode == "no-measured" and not direction else mode
    lists = {"palette": [], "accent": []}
    for role, hexes in (("palette", palette), ("accent", accents)):
        for hex_value in hexes:
            entry = merged.get((hex_value.lower(), role))
            choice = _choice_near(hex_value, choices)
            if effective == "no-measured":
                if choice == "keep":
                    result["kept"].append(_listed(entry, hex_value, role, "choice", reason=MODE_OFF_REASON))
                    lists[role].append(hex_value)
                else:
                    result["leftOut"].append(_listed(entry, hex_value, role, "mode", reason=MODE_OFF_REASON))
                continue
            if entry is None:
                lists[role].append(hex_value)
                continue
            if effective == "leave-out" and entry["level"] == "conflict":
                if choice == "keep":
                    result["kept"].append(_listed(entry, hex_value, role, "choice"))
                    lists[role].append(hex_value)
                else:
                    result["leftOut"].append(_listed(entry, hex_value, role, "check"))
            elif choice == "leaveOut":
                result["leftOut"].append(_listed(entry, hex_value, role, "choice"))
            elif effective == "flag" and choice == "keep":
                result["kept"].append(_listed(entry, hex_value, role, "choice"))
                lists[role].append(hex_value)
            else:
                result["mayClash"].append(_listed(entry, hex_value, role, "check"))
                lists[role].append(hex_value)
    result["palette"], result["accents"] = lists["palette"], lists["accent"]
    for hex_value in pinned["include"]:
        entry = merged.get((hex_value, "pinned"))
        if entry is not None:
            result["pinnedClashes"].append(_listed(entry, hex_value, "pinned", "check"))
    result["paletteClashes"] = [_listed(entry, None, "palette", "check")  # type: ignore[arg-type]
                                for key, entry in merged.items() if key[0] is None]
    return result


# -- the brief text ----------------------------------------------------------------

def _brief_text(board: dict[str, Any], analysis: dict[str, Any], *, direction: str, include: list[str],
                palette: list[str], accents: list[str], keywords: list[str], notes: str) -> str:
    from services.moodboard_analysis import PALETTE_SIZE

    mode = str(analysis.get("mode") or board.get("mode") or "look")
    try:
        strength = float(analysis.get("strength", board.get("strength", 0.7)))
    except (TypeError, ValueError):
        strength = 0.7
    name = str(board.get("name") or "Moodboard")
    parts: list[str] = []
    if direction:
        parts.append(_sentence(direction))
    parts.append(f"Use the Nebula moodboard '{name}' as {mode} direction at strength {strength:.2f}.")
    parts.append(MODE_INTENTS.get(mode, MODE_INTENTS["look"]))
    if palette[:PALETTE_SIZE]:
        parts.append(f"Color palette: {', '.join(palette[:PALETTE_SIZE])}.")
    if accents:
        parts.append(f"Accent colors, used sparingly: {', '.join(accents)}.")
    if include:
        parts.append(f"Make sure these colors appear: {', '.join(include)}.")
    if keywords:
        parts.append(f"Visual cues: {', '.join(keywords[:10])}.")
    for key, label in _READER_FIELDS:
        values = _str_list(analysis.get(key))
        if values:
            parts.append(f"{label}: {', '.join(values[:8])}.")
    if notes:
        parts.append(f"Notes: {_sentence(notes)}")
    return " ".join(parts)


def _brief_palette(analysis: dict[str, Any], palette: list[str]) -> list[str]:
    """The palette the brief names: the analysis's first PALETTE_SIZE
    colours, less the ones that don't go (cut first, as it always was, so a
    removal never pulls a ninth colour in)."""
    from services.moodboard_analysis import PALETTE_SIZE

    top = set(_str_list(analysis.get("palette"))[:PALETTE_SIZE])
    return [hex_value for hex_value in palette if hex_value in top]


def generator_keywords(analysis: dict[str, Any] | None, notes_sent: bool) -> list[str]:
    """The analysis's keywords a generator may get: all of them when notes
    go, else only the ones Nebula measured (not the words lifted from the
    notes, gap 5)."""
    from services.moodboard_analysis import MEASURED_CUES

    keywords = _str_list((analysis or {}).get("keywords"))
    return keywords if notes_sent else [keyword for keyword in keywords if keyword in MEASURED_CUES]


def generated_brief(board: dict[str, Any], analysis: dict[str, Any] | None,
                    *, with_fields: bool = True) -> str:
    """The brief Nebula writes from an analysis.

    ``with_fields=False`` gives the analysis's own brief (what Analyze saves
    as ``styleBrief``): every measured colour, its keywords and the board's
    notes, as it always has. With the fields it is ``compose``'s
    ``generatedStyleBrief``: the board's Direction and pins, minus colours
    kept out or left out, with notes only when the board sends them.
    """
    if not isinstance(analysis, dict):
        return ""
    if with_fields:
        return compose(board, analysis)["generatedStyleBrief"]
    return _brief_text(board, analysis, direction="", include=[],
                       palette=_str_list(analysis.get("palette")), accents=_str_list(analysis.get("accents")),
                       keywords=_str_list(analysis.get("keywords")), notes=str(board.get("notes") or "").strip())


def compose(board: dict[str, Any], analysis: dict[str, Any] | None = None, *,
            send_notes: bool | None = None) -> dict[str, Any]:
    """Everything a generator needs from the board, as one object.

    ``analysis`` defaults to the board's saved one. ``styleBrief`` is the
    override when there is one, else the generated brief ("" until the board
    is analyzed). ``avoidPrompt`` is the sentence instruction-following models
    get; ``negativePrompt`` fills a model's negative field. ``send_notes``
    is a node's own choice (True/False); None follows the board's
    ``sendNotes``.

    ``palette``/``accents`` are what generators get. ``leftOut`` (colours
    that don't go, each with ``reason``, ``reasons``, ``level``, ``why``:
    check, choice or mode, and ``foundBy``), ``mayClash`` (still sent),
    ``kept`` (Keep anyway), ``pinnedClashes`` and ``paletteClashes`` (a
    whole-palette finding, such as a cast) say why.
    """
    if analysis is None:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    direction, avoid, pinned = board_fields(board)
    mode, _choices, board_notes = board_options(board)
    notes_sent = board_notes if send_notes is None else bool(send_notes)
    colours = resolve_colours(board, analysis)
    generated = "" if not isinstance(analysis, dict) else _brief_text(
        board, analysis, direction=direction, include=pinned["include"],
        palette=_brief_palette(analysis, colours["palette"]), accents=colours["accents"],
        keywords=generator_keywords(analysis, notes_sent),
        notes=str(board.get("notes") or "").strip() if notes_sent else "")
    override = board.get("briefOverride") if isinstance(board.get("briefOverride"), dict) else None
    override_text = str((override or {}).get("text") or "").strip()
    active = bool(override_text)
    stale = active and str(override.get("basis") or "") != brief_basis(board)

    avoid_terms = [*avoid, *(f"colors close to {hex_value}" for hex_value in pinned["exclude"])]
    negatives = _dedupe([*DEFECT_NEGATIVES, *avoid])
    return {
        "styleBrief": override_text if active else generated,
        "generatedStyleBrief": generated,
        "negativePrompt": ", ".join(negatives),
        "avoid": avoid,
        "avoidPrompt": f"Keep these out of the image: {', '.join(avoid_terms)}." if avoid_terms else "",
        "direction": direction,
        "pinnedColors": pinned,
        # The board's colours as direction: kept-out and left-out colours removed.
        "palette": colours["palette"],
        "accents": colours["accents"],
        "leftOut": colours["leftOut"],
        "mayClash": colours["mayClash"],
        "kept": colours["kept"],
        "pinnedClashes": colours["pinnedClashes"],
        "paletteClashes": colours["paletteClashes"],
        "clashMode": mode,
        "notesSent": notes_sent,
        "override": {"active": active, "stale": stale},
        "needsAnalysis": analysis is None,
    }


def generator_analysis(board: dict[str, Any], analysis: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """The analysis as a Moodboard node's bundle carries it: what a
    generator (or an LLM node on an Any port) may read. Without the notes
    unless ``brief`` sent them: keywords measured only, the summary without
    its "Notes emphasize" tail, the taste profile rebuilt, no subject words
    from the notes, image notes empty. Its colours are the brief's:
    ``palette``, ``accents`` and ``colors`` hold only what generators get,
    and each image's colours drop the ones near a colour left out or pinned
    to keep out, so an LLM node reading the bundle can't put a left-out
    colour back. The bundle's ``leftOut`` names what went, with why.

    Set-aside images are left out, as the bundle's own ``images`` leaves
    them out: the switch (``images[].setAside``, analysis version 5) and
    weight 0 (plan section 4.4). They never steer, so a generator never sees
    them or their colours, and the summary counts only the images that
    steer. The representative images keep only images that steer too: an
    analysis from version 1 (before 2026-10-18) ranked weight-0 images
    among them and stays current while the board is unchanged."""
    from services.moodboard_analysis import _clamp_float, _summary, _taste_profile, steering_count, steers

    view = copy.deepcopy(analysis)
    if isinstance(view.get("images"), list):
        view["images"] = [item for item in view["images"] if not (isinstance(item, dict) and (
            item.get("setAside") or _clamp_float(item.get("weight"), 1.0, 0.0, 1.0) <= 0))]
    steering_urls = {str(img.get("url") or "").strip() for img in board.get("images") or []
                     if isinstance(img, dict) and steers(img)}
    # A URL no board image has is left as it was: only a set-aside one goes.
    held_urls = {str(img.get("url") or "").strip() for img in board.get("images") or [] if isinstance(img, dict)}

    def steering_only(urls: Any) -> Any:
        if not isinstance(urls, list):
            return urls
        return [url for url in urls if not isinstance(url, str) or url.strip() not in held_urls
                or url.strip() in steering_urls]

    if "representativeImages" in view:
        view["representativeImages"] = steering_only(view["representativeImages"])
    krea_hint = (view.get("providerHints") or {}).get("krea") if isinstance(view.get("providerHints"), dict) else None
    if isinstance(krea_hint, dict) and "representativeImages" in krea_hint:
        krea_hint["representativeImages"] = steering_only(krea_hint["representativeImages"])
    notes_sent = bool(brief.get("notesSent"))
    notes = str(board.get("notes") or "").strip() if notes_sent else ""
    mode = str(analysis.get("mode") or board.get("mode") or "look")
    keywords = generator_keywords(analysis, notes_sent)
    palette, accents = list(brief.get("palette") or []), list(brief.get("accents") or [])
    count, has_images = steering_count(board)
    view["keywords"] = keywords
    view["summary"] = _summary(mode, count, palette, accents, notes, has_images=has_images)
    view["tasteProfile"] = _taste_profile(mode, keywords, palette)
    if not notes_sent:
        view["subjectBias"] = []
        view["images"] = [{**item, "notes": ""} if isinstance(item, dict) and "notes" in item else item
                          for item in view.get("images") or []]
    view["palette"], view["accents"] = palette, accents
    sent = {("palette", h.lower()) for h in palette} | {("accent", h.lower()) for h in accents}
    view["colors"] = [colour for colour in view.get("colors") or []
                      if isinstance(colour, dict) and isinstance(colour.get("hex"), str)
                      and ("accent" if colour.get("role") == "accent" else "palette", colour["hex"].lower()) in sent]
    _, _, pinned = board_fields(board)
    gone = _dedupe([*(str(item.get("hex")) for item in brief.get("leftOut") or []
                      if isinstance(item, dict) and item.get("hex")), *pinned["exclude"]])
    if gone:
        view["images"] = [_without_colours(item, gone) for item in view.get("images") or []]
    view["styleBrief"] = _brief_text(board, analysis, direction="", include=[],
                                     palette=_brief_palette(analysis, palette), accents=accents,
                                     keywords=keywords, notes=notes)
    hints = view.get("providerHints") if isinstance(view.get("providerHints"), dict) else {}
    if isinstance(hints.get("generic"), dict):
        hints["generic"]["palette"] = palette
        hints["generic"]["accents"] = accents
    return view


def _without_colours(image: Any, gone: list[str]) -> Any:
    """An analysis image without its colours near any of ``gone``."""
    if not isinstance(image, dict):
        return image
    item = dict(image)
    for key in ("palette", "accents"):
        if isinstance(item.get(key), list):
            item[key] = without_excluded(_str_list(item[key]), gone)
    if isinstance(item.get("colors"), list):
        kept = set(without_excluded([c["hex"] for c in item["colors"]
                                     if isinstance(c, dict) and isinstance(c.get("hex"), str)], gone))
        item["colors"] = [c for c in item["colors"] if isinstance(c, dict) and c.get("hex") in kept]
    return item


def with_brief(board: Any) -> Any:
    """A board as the API returns it: the stored board plus its composed
    ``brief`` and the colour check it used (``colorCheck``: the saved one
    at its basis, else the one run now; never saved here).

    A board file that isn't a board (edited by hand, or cut short) comes back
    as it is, and one whose brief can't be composed gets ``brief: None``, so
    it never takes the board list down with it.
    """
    if not isinstance(board, dict):
        return board
    try:
        brief = compose(board)
        check = current_colour_check(board)
    except Exception:  # noqa: BLE001 - one odd board must not break listing the rest
        logger.exception("Moodboard %s: brief not composed", board.get("id"))
        return {**board, "brief": None}
    mode, choices, send_notes = board_options(board)
    return {**board, "clashMode": mode, "colorChoices": choices, "sendNotes": send_notes, "colorCheck": check,
            "brief": brief}


# -- reaching a generator ----------------------------------------------------

def follows_instructions(definition_id: str) -> bool:
    """Whether a model reads "keep X out" as an instruction (GPT Image,
    Nano Banana, Krea 2). Others are diffusion-style: the words would pull X in."""
    return str(definition_id or "").startswith(_INSTRUCTION_FOLLOWING_PREFIXES)


def has_negative_field(definition: dict[str, Any] | None) -> bool:
    if not isinstance(definition, dict):
        return False
    return any(isinstance(p, dict) and p.get("key") == "negative_prompt" for p in definition.get("params") or [])


def has_board_port(definition: dict[str, Any] | None) -> bool:
    if not isinstance(definition, dict):
        return False
    return any(isinstance(p, dict) and p.get("id") == "moodboard" and p.get("dataType") == "Moodboard"
               for p in definition.get("inputPorts") or [])


def board_bundles(inputs: dict[str, Any]) -> list[dict[str, Any]]:
    """The Nebula moodboard bundles wired into a node's ``moodboard`` port.

    Only that port counts: a board passed to some other input (an Any port on
    a chat node, say) is data, not direction.
    """
    value = getattr(inputs.get("moodboard"), "value", None)
    return [item for item in (value if isinstance(value, list) else [value])
            if isinstance(item, dict) and str(item.get("kind") or "") == "nebula_moodboard"]


def board_is_off(bundle: dict[str, Any]) -> bool:
    """Whether a wired board is at strength 0. A missing or unreadable
    strength reads as the board default (0.7), as Krea 2's handler reads it."""
    raw = bundle.get("strength")
    if raw is None or raw == "" or isinstance(raw, bool):
        return False
    try:
        return float(raw) <= 0
    except (TypeError, ValueError):
        return False


def _without_off_boards(inputs: dict[str, Any]) -> dict[str, Any]:
    """``inputs`` with every strength-0 board taken out of the ``moodboard``
    port, and the port dropped if nothing is left, so the node runs as it
    would with only the other boards wired (or none)."""
    from models.events import add_run_note
    from models.graph import PortValueDict

    port = inputs.get("moodboard")
    value = getattr(port, "value", None)
    items = value if isinstance(value, list) else [value]
    off = [item for item in items if isinstance(item, dict)
           and str(item.get("kind") or "") == "nebula_moodboard" and board_is_off(item)]
    if not off:
        return inputs
    add_run_note(BOARD_STRENGTH_ZERO_NOTE)
    kept = [item for item in items if not any(item is board for board in off)]
    rest = {key: item for key, item in inputs.items() if key != "moodboard"}
    if kept:
        rest["moodboard"] = PortValueDict(type=port.type, value=kept if isinstance(value, list) else kept[0])
    return rest


def apply_to_generator(
    definition_id: str,
    definition: dict[str, Any] | None,
    inputs: dict[str, Any],
    params: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fold wired boards into a generator's prompt and negative field.

    Returns new ``inputs`` and the params to use for this call (the node's own
    params are left alone, so a saved recipe doesn't collect the board's
    negatives). A board at strength 0 is taken out first, with the run note
    ``BOARD_STRENGTH_ZERO_NOTE`` (Q36 a), so none of its text, negatives or
    images reach the node. The Moodboard port itself is not passed on unless
    the handler reads the board (``_HANDLER_READS_BOARD``). A node with no
    prompt, or no board wired, keeps its prompt and params as they are.
    """
    from models.graph import PortValueDict

    inputs = _without_off_boards(inputs)
    bundles = board_bundles(inputs)
    prompt_port = inputs.get("prompt")
    prompt = getattr(prompt_port, "value", None)
    passed_on = inputs
    if "moodboard" in inputs and definition_id not in _HANDLER_READS_BOARD and has_board_port(definition):
        passed_on = {key: port for key, port in inputs.items() if key != "moodboard"}
    if not bundles or not isinstance(prompt, str) or not prompt.strip():
        return passed_on, params

    instructions = follows_instructions(definition_id)
    briefs = [str(b.get("styleBrief") or "").strip() for b in bundles]
    sections = [prompt.rstrip()]
    joined = " ".join(brief for brief in briefs if brief)
    if joined:
        sections.append(f"Moodboard direction: {joined}")
    if instructions:
        avoid = [str(b.get("avoidPrompt") or "").strip() for b in bundles]
        sections.extend(text for text in avoid if text)

    new_params = params
    if has_negative_field(definition):
        board_negatives = [term.strip() for b in bundles
                           for term in str(b.get("negativePrompt") or "").split(",") if term.strip()]
        own = [term.strip() for term in str(params.get("negative_prompt") or "").split(",") if term.strip()]
        merged = _dedupe([*own, *board_negatives])
        if merged:
            new_params = {**params, "negative_prompt": ", ".join(merged)}

    new_inputs = dict(passed_on)
    new_inputs["prompt"] = PortValueDict(type=prompt_port.type, value="\n\n".join(sections))
    return new_inputs, new_params


# -- migration (B7) ----------------------------------------------------------

_OLD_COMMON_NEGATIVES = ("unrelated style drift", "conflicting palettes", "random artifacts")
_OLD_MODE_NEGATIVES = {
    "look": ("copying exact subjects", "identity transfer", "logo replication"),
    "world": ("generic locations", "mixed eras", "inconsistent materials"),
    "subject": ("inconsistent facial features", "unmotivated wardrobe changes"),
}
_OLD_MODE_LABELS = {
    "look": "visual style only; avoid copying specific subjects or identities",
    "world": "world, materials, environment, and production design",
    "subject": "subject, silhouette, costume, and identity-adjacent visual cues",
}


def _old_generated_briefs(board: dict[str, Any], analysis: dict[str, Any], notes: str) -> list[re.Pattern[str]]:
    """Patterns for what analyzer versions 1 and 2 wrote as ``styleBrief``.

    The name is a wildcard: version 2's hash leaves it out, so a renamed
    board's analysis is still current but names the old name.
    """
    mode = str(analysis.get("mode") or board.get("mode") or "look")
    try:
        strength = float(analysis.get("strength", 0.7))
    except (TypeError, ValueError):
        strength = 0.7
    label = _OLD_MODE_LABELS.get(mode, _OLD_MODE_LABELS["look"])
    palette = _str_list(analysis.get("palette"))[:8]
    accents = _str_list(analysis.get("accents"))
    keywords = _str_list(analysis.get("keywords"))[:10]
    head = "Use the Nebula moodboard '\x00' as " + f"{mode} direction at strength {strength:.2f}."
    tail: list[str] = []
    if keywords:
        tail.append(f"Visual cues: {', '.join(keywords)}.")
    if notes:
        tail.append(f"User notes: {notes}")
    colours_v1 = [f"Color palette: {', '.join(palette)}."] if palette else []
    colours_v2 = list(colours_v1)
    if accents:
        colours_v2.append(f"Accent colors, used sparingly: {', '.join(accents)}.")
    candidates = [
        " ".join([head, label, *colours_v1, *tail]),                          # version 1
        " ".join([head, f"{label.capitalize()}.", *colours_v2, *tail]),       # version 2
        " ".join([head, label.capitalize(), *colours_v2, *tail]),             # version 2 before the full stop fix
    ]
    return [re.compile(re.escape(c).replace("\x00", "[^\\n]*"), re.DOTALL) for c in candidates]


def _brief_was_edited(board: dict[str, Any], analysis: dict[str, Any], brief: str) -> bool:
    """Whether a saved ``styleBrief`` differs from what its analysis wrote.

    The board's current notes are tried first. If the analysis is out of date,
    the notes it saw are read back from its summary when the summary holds
    them whole. Anything that matches neither counts as edited, so a person's
    text is never lost to a guess.
    """
    notes_tried = [str(board.get("notes") or "").strip()]
    summary = str(analysis.get("summary") or "")
    marker = " Notes emphasize: "
    if marker in summary:
        old_notes = summary.split(marker, 1)[1]
        if len(old_notes) < 180:
            notes_tried.append(old_notes)
    else:
        notes_tried.append("")
    for notes in dict.fromkeys(notes_tried):
        if any(p.fullmatch(brief) for p in _old_generated_briefs(board, analysis, notes)):
            return False
    # An analysis from this analyzer (version 3 on) on a board that somehow
    # missed the migration, such as a file copied in from an older backup.
    if brief == generated_brief(board, analysis, with_fields=False):
        return False
    return True


def migrate_board(board: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Give a board saved before the brief fields its fields, once.

    Negatives beyond the old defaults move to ``avoid``; a ``styleBrief`` that
    differs from what its analysis wrote becomes the override. Returns the new
    board and a record of what moved, or None when the board is already
    migrated. The saved analysis is left as it was.
    """
    if not isinstance(board, dict):
        return None
    version = board.get("briefVersion")
    # A board saved by a newer Nebula (after a downgrade) is left alone, not
    # migrated back down.
    if isinstance(version, int) and not isinstance(version, bool) and version >= BRIEF_FIELDS_VERSION:
        return None
    from services.moodboard_analysis import analysis_is_current

    new = copy.deepcopy(board)
    direction, avoid, pinned = board_fields(board)
    record: dict[str, Any] = {"id": board.get("id"), "name": board.get("name"),
                              "avoidAdded": [], "overrideFromEditedBrief": False}
    analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    override = board.get("briefOverride") if isinstance(board.get("briefOverride"), dict) else None

    if analysis is not None:
        mode = str(analysis.get("mode") or board.get("mode") or "look")
        defaults = {term.lower() for term in (*_OLD_COMMON_NEGATIVES, *_OLD_MODE_NEGATIVES.get(mode, ()),
                                              *DEFECT_NEGATIVES)}
        known = {item.lower() for item in avoid}
        for term in str(analysis.get("negativePrompt") or "").split(","):
            text = " ".join(term.split()).strip(" .")
            if text and text.lower() not in defaults and text.lower() not in known:
                avoid.append(text)
                known.add(text.lower())
                record["avoidAdded"].append(text)

        brief = str(analysis.get("styleBrief") or "").strip()
        if override is None and brief and _brief_was_edited(board, analysis, brief):
            fielded = {**new, "direction": direction, "avoid": avoid, "pinnedColors": pinned}
            # Written against the board as it was analyzed: if the board has
            # changed since, the badge shows straight away.
            basis = brief_basis(fielded) if analysis_is_current(board, analysis) else "migrated"
            override = {"text": brief, "basis": basis, "updatedAt": _now_iso()}
            record["overrideFromEditedBrief"] = True
            record["overrideCurrent"] = basis != "migrated"

    # Keep within what the store accepts on the next save, or every Studio
    # autosave of this board would be refused. The full text stays in the
    # backup file, the log and the saved analysis.
    clipped = [item[:AVOID_ITEM_LIMIT].rstrip() for item in avoid]
    if clipped[:AVOID_LIMIT] != avoid:
        record["avoidClipped"] = {"original": list(avoid), "kept": clipped[:AVOID_LIMIT]}
    if override is not None and len(str(override.get("text") or "")) > OVERRIDE_LIMIT:
        record["overrideClipped"] = True
        override = {**override, "text": str(override["text"])[:OVERRIDE_LIMIT]}
    if len(direction) > DIRECTION_LIMIT:
        record["directionClipped"] = True
        direction = direction[:DIRECTION_LIMIT]

    new["direction"] = direction
    new["avoid"] = clipped[:AVOID_LIMIT]
    new["pinnedColors"] = pinned
    new["briefOverride"] = override
    new["briefVersion"] = BRIEF_FIELDS_VERSION
    return new, record


def migrate_store(root: Path, backup_root: Path) -> dict[str, Any]:
    """Migrate every board file under ``root`` once, backing each up first.

    Each changed file is copied to ``backup_root/brief-fields-<time>/<scope>/``
    before it is rewritten, and ``migration-log.json`` there records what
    moved. Restoring a backup file undoes that board. Boards already migrated
    are not touched, so running it again does nothing.
    """
    from services.asset_trash import RECORD_SUFFIX, is_trash_folder
    from services.moodboard_store import _write_json

    report: dict[str, Any] = {"migrated": [], "skipped": [], "backupDir": None}
    if not root.exists():
        return report
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = backup_root / f"brief-fields-{stamp}"
    for scope in sorted(p for p in root.iterdir() if p.is_dir()):
        files = sorted(scope.glob("*.json"))
        if is_trash_folder(scope):
            # Boards in Recently deleted migrate too, so a restore brings one
            # back with its fields. The trash records beside them aren't boards.
            files = [path for path in files if not path.name.endswith(RECORD_SUFFIX)]
        for path in files:
            try:
                board = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                report["skipped"].append({"file": str(path), "reason": str(exc)})
                continue
            try:
                result = migrate_board(board)
            except Exception as exc:  # one odd board must not stop the rest, or startup
                logger.exception("Moodboard brief fields: could not migrate %s", path)
                report["skipped"].append({"file": str(path), "reason": f"{type(exc).__name__}: {exc}"})
                continue
            if result is None:
                continue
            new, record = result
            target = backup_dir / scope.name / path.name
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                _write_json(path, new)
            except OSError as exc:  # no backup, no rewrite; the board still migrates in memory on read
                logger.exception("Moodboard brief fields: could not back up or write %s", path)
                report["skipped"].append({"file": str(path), "reason": f"{type(exc).__name__}: {exc}"})
                continue
            report["migrated"].append({**record, "file": str(path), "backup": str(target)})
    if report["skipped"]:
        logger.warning("Moodboard brief fields: %d board file(s) not migrated: %s", len(report["skipped"]),
                       "; ".join(f"{item['file']} ({item['reason']})" for item in report["skipped"]))
    # A log only when something changed: a file that can't be read would
    # otherwise leave a new, empty backup folder on every start.
    if report["migrated"]:
        backup_dir.mkdir(parents=True, exist_ok=True)
        report["backupDir"] = str(backup_dir)
        (backup_dir / "migration-log.json").write_text(json.dumps(report, ensure_ascii=False, indent=2),
                                                       encoding="utf-8")
        moved = [r for r in report["migrated"] if r["avoidAdded"] or r["overrideFromEditedBrief"]]
        logger.warning(
            "Moodboard brief fields: migrated %d board(s), %d with moved negatives or an edited brief; "
            "backups and log in %s", len(report["migrated"]), len(moved), backup_dir)
    return report


def save_colour_checks(root: Path) -> dict[str, Any]:
    """Save the colour check on every board file whose saved one is missing
    or stale (a board saved before gap 18, or a ``LEXICON_VERSION`` bump),
    so generations and API reads use the saved check instead of running it
    each time. Only ``colorCheck`` is written: a cache of what the board
    holds, so no backup. Boards in Recently deleted get one too. Running it
    again does nothing."""
    from services.asset_trash import RECORD_SUFFIX, is_trash_folder
    from services.moodboard_store import _write_json

    report: dict[str, Any] = {"saved": [], "skipped": []}
    if not root.exists():
        return report
    for scope in sorted(p for p in root.iterdir() if p.is_dir()):
        files = sorted(scope.glob("*.json"))
        if is_trash_folder(scope):
            files = [path for path in files if not path.name.endswith(RECORD_SUFFIX)]
        for path in files:
            try:
                board = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                report["skipped"].append({"file": str(path), "reason": str(exc)})
                continue
            if not isinstance(board, dict):
                continue
            before = board.get("colorCheck")
            refresh_colour_check(board)
            if board.get("colorCheck") == before:
                continue
            try:
                _write_json(path, board)
            except OSError as exc:  # it is computed in memory on read until the next save
                report["skipped"].append({"file": str(path), "reason": f"{type(exc).__name__}: {exc}"})
                continue
            report["saved"].append(str(path))
    if report["saved"]:
        logger.info("Moodboard colour check: saved on %d board(s)", len(report["saved"]))
    return report


# -- helpers -----------------------------------------------------------------

def _str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, (str, int, float)) and str(item).strip()]


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out


def _sentence(text: str) -> str:
    text = " ".join(text.split())
    return text if text.endswith((".", "!", "?")) else f"{text}."


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
