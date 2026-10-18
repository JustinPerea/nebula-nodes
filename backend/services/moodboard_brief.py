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
(the engine calls it before any handler): the brief joins the prompt, the
negatives fill a ``negative_prompt`` field when the model has one, and the
Avoid list joins the prompt only for instruction-following models (GPT Image,
Nano Banana, Krea 2). Diffusion-style models read "no X" as "X", so they never
get it in the prompt.

``migrate_board`` moves boards saved before these fields existed (B7).
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


def brief_basis(board: dict[str, Any]) -> str:
    """What the brief is made from: the analysis's inputs plus the brief fields.

    An override written against one basis is "changed since you edited this"
    once the basis moves. The name is left out, as in ``source_hash``.
    """
    from services.moodboard_analysis import source_hash

    direction, avoid, pinned = board_fields(board)
    images = board.get("images")
    readable = board if isinstance(images, list) else {**board, "images": []}
    payload = {"source": source_hash(readable), "direction": direction, "avoid": avoid, "pinned": pinned}
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


def generated_brief(board: dict[str, Any], analysis: dict[str, Any] | None,
                    *, with_fields: bool = True) -> str:
    """The brief Nebula writes from an analysis, plus the board's fields.

    ``with_fields=False`` gives the analysis's own brief (what Analyze saves
    as ``styleBrief``). Colours the person kept out are dropped from the
    palette (within dE00 5, Commons' "same colour" rule).
    """
    if not isinstance(analysis, dict):
        return ""
    from services.moodboard_analysis import PALETTE_SIZE

    direction, _avoid, pinned = board_fields(board) if with_fields else ("", [], {"include": [], "exclude": []})
    mode = str(analysis.get("mode") or board.get("mode") or "look")
    try:
        strength = float(analysis.get("strength", board.get("strength", 0.7)))
    except (TypeError, ValueError):
        strength = 0.7
    name = str(board.get("name") or "Moodboard")
    notes = str(board.get("notes") or "").strip()
    palette = without_excluded(_str_list(analysis.get("palette"))[:PALETTE_SIZE], pinned["exclude"])
    accents = without_excluded(_str_list(analysis.get("accents")), pinned["exclude"])
    keywords = _str_list(analysis.get("keywords"))

    parts: list[str] = []
    if direction:
        parts.append(_sentence(direction))
    parts.append(f"Use the Nebula moodboard '{name}' as {mode} direction at strength {strength:.2f}.")
    parts.append(MODE_INTENTS.get(mode, MODE_INTENTS["look"]))
    if palette:
        parts.append(f"Color palette: {', '.join(palette)}.")
    if accents:
        parts.append(f"Accent colors, used sparingly: {', '.join(accents)}.")
    if pinned["include"]:
        parts.append(f"Make sure these colors appear: {', '.join(pinned['include'])}.")
    if keywords:
        parts.append(f"Visual cues: {', '.join(keywords[:10])}.")
    for key, label in _READER_FIELDS:
        values = _str_list(analysis.get(key))
        if values:
            parts.append(f"{label}: {', '.join(values[:8])}.")
    if notes:
        parts.append(f"Notes: {_sentence(notes)}")
    return " ".join(parts)


def compose(board: dict[str, Any], analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    """Everything a generator needs from the board, as one object.

    ``analysis`` defaults to the board's saved one. ``styleBrief`` is the
    override when there is one, else the generated brief ("" until the board
    is analyzed). ``avoidPrompt`` is the sentence instruction-following models
    get; ``negativePrompt`` fills a model's negative field.
    """
    if analysis is None:
        analysis = board.get("analysis") if isinstance(board.get("analysis"), dict) else None
    direction, avoid, pinned = board_fields(board)
    generated = generated_brief(board, analysis)
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
        # The board's colours as direction: kept-out colours removed.
        "palette": without_excluded(_str_list((analysis or {}).get("palette")), pinned["exclude"]),
        "accents": without_excluded(_str_list((analysis or {}).get("accents")), pinned["exclude"]),
        "override": {"active": active, "stale": stale},
        "needsAnalysis": analysis is None,
    }


def with_brief(board: Any) -> Any:
    """A board as the API returns it: the stored board plus its composed ``brief``.

    A board file that isn't a board (edited by hand, or cut short) comes back
    as it is, and one whose brief can't be composed gets ``brief: None``, so
    it never takes the board list down with it.
    """
    if not isinstance(board, dict):
        return board
    try:
        brief = compose(board)
    except Exception:  # noqa: BLE001 - one odd board must not break listing the rest
        logger.exception("Moodboard %s: brief not composed", board.get("id"))
        brief = None
    return {**board, "brief": brief}


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


def apply_to_generator(
    definition_id: str,
    definition: dict[str, Any] | None,
    inputs: dict[str, Any],
    params: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fold wired boards into a generator's prompt and negative field.

    Returns new ``inputs`` and the params to use for this call (the node's own
    params are left alone, so a saved recipe doesn't collect the board's
    negatives). The Moodboard port itself is not passed on unless the handler
    reads the board (``_HANDLER_READS_BOARD``). A node with no prompt, or no
    board wired, keeps its prompt and params as they are.
    """
    from models.graph import PortValueDict

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
    from services.moodboard_store import _write_json

    report: dict[str, Any] = {"migrated": [], "skipped": [], "backupDir": None}
    if not root.exists():
        return report
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = backup_root / f"brief-fields-{stamp}"
    for scope in sorted(p for p in root.iterdir() if p.is_dir()):
        for path in sorted(scope.glob("*.json")):
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
