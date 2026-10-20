"""Deterministic local analysis for native Nebula moodboards.

Colour comes from Commons' measurement (commons/measure.py): each image gets
the colours it's made of, with the share of pixels each covers, plus a
separate pass for small saturated accents (a button, a logo mark) that pixel
clustering would absorb. The board's palette ranks colours by image weight ×
share, merged across images in CIELAB; accents roll up into their own list.
Notes, mode and brightness fill in the rest. A vision reader can fill the
empty fields later without changing the saved Moodboard resource.

Each board colour lists its sources: the images it comes from, by their
number on the board (1-based, every image in board order, excluded ones
included, as `nebula moodboard show` numbers them), with the colour's share of
that image and its contribution to the board share.

The brief and negatives are written by services/moodboard_brief.py, which
also joins in the person's Direction, Avoid and pinned colours (kept on the
board, not here, so analyzing again can't drop them).

``dry_run`` analyzes without saving anything, optionally with other colour
thresholds (``Thresholds``), and says what would change. Nothing saves custom
thresholds: a normal analysis always uses Commons' constants.
"""
from __future__ import annotations

import copy
import functools
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
from PIL import Image, UnidentifiedImageError

from commons.colour import delta_e00, hex_to_lab, lab_to_hex
from commons.measure import ACCENT_MIN_CHROMA, ACCENT_SEPARATION, MERGE_DELTA_E, measure_image
from services.file_access import ProtectedPathError, require_allowed_path
from services.moodboard_brief import DEFECT_NEGATIVES, compose, generated_brief
from services.output import OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT

# 2: colours from Commons' measurement, ranked by weight × share, with accents
# kept apart; the source hash leaves out the board's name.
# 3: negatives are defects only and the brief states intent positively; the
# person's Direction, Avoid and pinned colours live on the board
# (services/moodboard_brief.py).
# 4: each board colour lists its source images (``sources``) and each image
# its number on the board. The colours themselves are as in 3, so a version 3
# analysis stays current; it just has no sources until analyzed again.
ANALYSIS_VERSION = 4
PALETTE_SIZE = 8
ACCENT_LIMIT = 4
REPRESENTATIVE_LIMIT = 10

_MODE_LABELS = {
    "look": "visual style only; the subject comes from the prompt",
    "world": "world, materials, environment, and production design",
    "subject": "subject, silhouette, costume, and identity-adjacent visual cues",
}

_PALETTE_WORDS = [
    ("deep shadows", lambda l, s: l < 70),
    ("muted color", lambda l, s: s < 35),
    ("high color energy", lambda l, s: s > 95),
    ("soft highlights", lambda l, s: l > 185),
]

# The cues each mode adds to ``keywords``.
_MODE_CUES = {
    "look": ("style consistency", "visual language"),
    "world": ("worldbuilding", "environmental continuity"),
    "subject": ("subject continuity", "silhouette consistency"),
}

# The keywords Nebula measured or set from the mode. Every other keyword is a
# word lifted from the board's notes, which generators get only when the
# board or node opts in (services/moodboard_brief.py, gap 18).
MEASURED_CUES = frozenset({"palette-led", *(cue for cues in _MODE_CUES.values() for cue in cues),
                           *(label for label, _ in _PALETTE_WORDS)})


@dataclass(frozen=True)
class Thresholds:
    """The colour thresholds an analysis uses: Commons' measurement constants.

    ``accent_min_chroma``: how saturated (CIELAB chroma) a colour must be to
    count as an accent. ``accent_separation``: how far (dE00) an accent's
    pixels must sit from every main colour. ``merge_delta_e``: colours closer
    than this (dE00) are one colour, within an image and across the board.
    Only a dry run passes other values.
    """

    accent_min_chroma: float = ACCENT_MIN_CHROMA
    accent_separation: float = ACCENT_SEPARATION
    merge_delta_e: float = MERGE_DELTA_E

    def as_json(self) -> dict[str, float]:
        return {THRESHOLD_KEYS[key]: value for key, value in asdict(self).items()}


# The API's names for the thresholds, and the values a dry run accepts.
THRESHOLD_KEYS = {"accent_min_chroma": "accentMinChroma", "accent_separation": "accentSeparation",
                  "merge_delta_e": "mergeDeltaE"}
THRESHOLD_RANGES = {"accentMinChroma": (0.0, 150.0), "accentSeparation": (0.0, 100.0), "mergeDeltaE": (0.0, 50.0)}


def parse_thresholds(raw: dict[str, Any] | None) -> Thresholds:
    """Thresholds from ``{"accentMinChroma", "accentSeparation", "mergeDeltaE"}``;
    a key left out (or null) keeps its default. Raises ValueError, naming the
    field, for an unknown key or a value that isn't a number in range."""
    if raw is None:
        return Thresholds()
    if not isinstance(raw, dict):
        raise ValueError("thresholds must be an object")
    unknown = sorted(set(raw) - set(THRESHOLD_RANGES))
    if unknown:
        raise ValueError(f"unknown threshold {', '.join(unknown)}: use {', '.join(THRESHOLD_RANGES)}")
    values: dict[str, float] = {}
    for attr, key in THRESHOLD_KEYS.items():
        value = raw.get(key)
        if value is None:
            continue
        low, high = THRESHOLD_RANGES[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{key} must be a number from {low:g} to {high:g}")
        if not low <= value <= high:
            raise ValueError(f"{key} must be from {low:g} to {high:g} (got {value:g})")
        values[attr] = float(value)
    return Thresholds(**values)


def steers(weight: float) -> bool:
    """Whether an image with this weight shapes the board.

    Weight 0 keeps an image on the board without using it: it adds nothing to
    the palette and isn't a representative image. Excluding is the separate
    switch that leaves an image out of the analysis altogether.
    """
    return weight > 0


def analyze_moodboard(moodboard: dict[str, Any], *, thresholds: Thresholds | None = None) -> dict[str, Any]:
    """Return a stable creative-direction analysis for a Moodboard dict.

    It reads every image file, so code on the event loop runs it in a thread.
    ``thresholds`` is for dry runs only; left out, Commons' constants apply.
    """
    thresholds = thresholds or Thresholds()
    # An image's number is its place among all the board's images, excluded
    # ones included: what Moodboard Studio's grid and the CLI count.
    numbered = [
        (number, img) for number, img in enumerate(moodboard.get("images", []), start=1)
        if isinstance(img, dict)
    ]
    images = [img for _, img in numbered if not bool(img.get("excluded"))]
    notes = str(moodboard.get("notes") or "").strip()
    mode = str(moodboard.get("mode") or "look")
    strength = _clamp_float(moodboard.get("strength"), 0.7, 0.0, 1.0)

    per_image: list[dict[str, Any]] = []
    weighted_colours: list[_Steering] = []
    analyzed_urls: set[str] = set()
    warnings: list[str] = []

    for number, img in numbered:
        if bool(img.get("excluded")):
            continue
        url = str(img.get("url") or "").strip()
        if not url:
            continue
        weight = _clamp_float(img.get("weight"), 1.0, 0.0, 1.0)
        local_path = resolve_moodboard_image_path(url)
        item: dict[str, Any] = {
            "number": number,
            "id": str(img.get("id") or ""),
            "url": url,
            "weight": weight,
            "notes": str(img.get("notes") or ""),
        }
        if local_path is None:
            item["status"] = "unresolved"
            item["palette"] = []
            warnings.append(f"Could not resolve image: {url}")
            per_image.append(item)
            continue
        try:
            measured = _measure(local_path, thresholds)
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            item["status"] = "error"
            item["error"] = str(exc)
            item["palette"] = []
            warnings.append(f"Could not analyze image: {url}")
            per_image.append(item)
            continue
        colours = measured["colors"]
        item.update({
            "status": "analyzed",
            "width": measured["width"],
            "height": measured["height"],
            "palette": [c["hex"] for c in colours if not c["accent"]],
            "accents": [c["hex"] for c in colours if c["accent"]],
            "colors": colours,
            "lightness": measured["lightness"],
            "saturation": measured["saturation"],
        })
        analyzed_urls.add(url)
        if steers(weight):
            weighted_colours.append(_Steering(weight, colours, number, item["id"]))
        per_image.append(item)

    if per_image and not any(steers(item["weight"]) for item in per_image):
        warnings.append("Every image has weight 0, so none of them shapes the board.")

    dominant, accent = _roll_up(weighted_colours, thresholds.merge_delta_e)
    palette = [colour["hex"] for colour in dominant]
    accents = [colour["hex"] for colour in accent]
    representative = rank_representative_images(images, only=analyzed_urls)
    steering = [item for item in per_image if item.get("status") == "analyzed" and steers(item["weight"])]
    keywords = _keywords_from_analysis(mode, notes, steering, palette)
    avoids = list(DEFECT_NEGATIVES)
    style_brief = generated_brief(
        moodboard,
        {"mode": mode, "strength": strength, "palette": palette, "accents": accents, "keywords": keywords},
        with_fields=False,
    )

    return {
        "version": ANALYSIS_VERSION,
        "sourceHash": source_hash(moodboard),
        "mode": mode,
        "modeIntent": _MODE_LABELS.get(mode, _MODE_LABELS["look"]),
        "strength": strength,
        "summary": _summary(mode, len(images), palette, accents, notes),
        "tasteProfile": _taste_profile(mode, keywords, palette),
        "styleBrief": style_brief,
        "negativePrompt": ", ".join(avoids),
        "keywords": keywords,
        "avoids": avoids,
        "palette": palette,
        "accents": accents,
        "colors": [*dominant, *accent],
        "lighting": _lighting_hint(steering),
        "composition": _composition_hint(steering),
        "materials": [],
        "textures": [],
        "motifs": [],
        "subjectBias": _subject_bias(mode, notes),
        "representativeImages": representative,
        "providerHints": {
            "krea": {
                "strategy": "image_style_references",
                "representativeImages": representative,
                "strength": strength,
                "styleBrief": style_brief,
            },
            "generic": {
                "promptSuffix": style_brief,
                "negativePrompt": ", ".join(avoids),
                "palette": palette,
                "accents": accents,
            },
        },
        "images": per_image,
        "warnings": warnings,
    }


def dry_run(moodboard: dict[str, Any], thresholds: Thresholds | None = None) -> dict[str, Any]:
    """What analyzing would give now, and how it differs from what's saved.

    Saves nothing: the caller passes the board as read, and nothing here
    writes. ``brief`` is what generators would get (moodboard_brief.compose
    with the new analysis); ``changes`` compares the palette, accents, brief
    and negatives with the board's saved analysis and brief. When the saved
    analysis is out of date (``saved.current`` false), the changes include
    edits to the board, not only the thresholds.
    """
    thresholds = thresholds or Thresholds()
    analysis = analyze_moodboard(moodboard, thresholds=thresholds)
    saved = moodboard.get("analysis") if isinstance(moodboard.get("analysis"), dict) else None
    before = compose(moodboard, saved)
    after = compose(moodboard, analysis)
    return {
        "dryRun": True,
        "id": moodboard.get("id"),
        "name": moodboard.get("name"),
        "thresholds": thresholds.as_json(),
        "defaults": Thresholds().as_json(),
        "saved": {"analyzed": saved is not None, "current": analysis_is_current(moodboard, saved)},
        "analysis": analysis,
        "brief": after,
        "changes": {
            "palette": colour_changes(_hex_list(saved, "palette"), analysis["palette"]),
            "accents": colour_changes(_hex_list(saved, "accents"), analysis["accents"]),
            "brief": _text_change(before["styleBrief"], after["styleBrief"]),
            "generatedBrief": _text_change(before["generatedStyleBrief"], after["generatedStyleBrief"]),
            "negativePrompt": _text_change(before["negativePrompt"], after["negativePrompt"]),
        },
    }


# Two colours this close (dE00) are the same colour nudged, not a swap.
_NUDGE_DELTA_E = 2.0


def colour_changes(before: list[str], after: list[str]) -> dict[str, Any]:
    """How a colour list changed: colours added, removed, nudged (a removed
    and an added colour within dE00 2 of each other, paired closest first)
    and whether the colours on both lists changed order."""
    removed = [c for c in before if c not in after]
    added = [c for c in after if c not in before]
    nudged: list[dict[str, str]] = []
    pairs = sorted(
        (float(delta_e00(hex_to_lab(old), hex_to_lab(new))), i, j)
        for i, old in enumerate(removed) for j, new in enumerate(added)
    )
    used_old: set[int] = set()
    used_new: set[int] = set()
    for distance, i, j in pairs:
        if distance >= _NUDGE_DELTA_E or i in used_old or j in used_new:
            continue
        used_old.add(i)
        used_new.add(j)
        nudged.append({"from": removed[i], "to": added[j]})
    # Order compares what both lists hold, a nudged colour standing for its
    # old self.
    renamed = {pair["to"]: pair["from"] for pair in nudged}
    kept_before = [c for c in before if c in after or c in renamed.values()]
    kept_after = [renamed.get(c, c) for c in after if c in before or c in renamed]
    removed = [c for i, c in enumerate(removed) if i not in used_old]
    added = [c for j, c in enumerate(added) if j not in used_new]
    reordered = kept_before != kept_after
    return {
        "before": list(before),
        "after": list(after),
        "added": added,
        "removed": removed,
        "nudged": nudged,
        "reordered": reordered,
        "changed": bool(added or removed or nudged or reordered),
    }


def _text_change(before: str, after: str) -> dict[str, Any]:
    return {"before": before, "after": after, "changed": before != after}


def _hex_list(analysis: dict[str, Any] | None, key: str) -> list[str]:
    values = (analysis or {}).get(key)
    return [str(v) for v in values if isinstance(v, str)] if isinstance(values, list) else []


def analysis_is_current(moodboard: dict[str, Any], analysis: Any) -> bool:
    """Whether a saved analysis still describes the board.

    An analysis from an older analyzer still counts while the board is
    unchanged, so hand edits to its brief keep working until someone analyzes
    again.
    """
    if not isinstance(analysis, dict) or not analysis.get("styleBrief"):
        return False
    try:
        version = int(analysis.get("version") or 1)
    except (TypeError, ValueError):
        return False
    return analysis.get("sourceHash") == source_hash(moodboard, version)


def rank_representative_images(
    images: list[Any],
    *,
    only: set[str] | None = None,
    limit: int = REPRESENTATIVE_LIMIT,
) -> list[str]:
    """The URLs that best stand for the board: heaviest first, board order on ties.

    Leaves out excluded images, weight 0 (see ``steers``) and, given ``only``,
    any URL outside it (the analysis passes the images it could read).
    """
    ranked: list[tuple[float, int, str]] = []
    for index, img in enumerate(images or []):
        if not isinstance(img, dict) or bool(img.get("excluded")):
            continue
        url = str(img.get("url") or "").strip()
        if not url or (only is not None and url not in only):
            continue
        weight = _clamp_float(img.get("weight"), 1.0, 0.0, 1.0)
        if steers(weight):
            ranked.append((-weight, index, url))
    ranked.sort()
    urls: list[str] = []
    for _, _, url in ranked:
        if url not in urls:
            urls.append(url)
    return urls[:limit]


def resolve_moodboard_image_path(value: str) -> Path | None:
    """Resolve a Nebula-local image URL/path to a filesystem path.

    Accepts `/api/outputs/<rel>`, absolute localhost URLs pointing at that path,
    and absolute filesystem paths already under OUTPUT_ROOT. External URLs are
    deliberately not downloaded in the deterministic analyzer.
    """
    raw = str(value or "").strip()
    if not raw:
        return None

    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https"}:
        if parsed.path.startswith("/api/outputs/"):
            raw = parsed.path
        else:
            return None

    # Dual-root resolution: prefer OUTPUT_ROOT, fall back to DEFAULT_OUTPUT_ROOT
    # so assets created before a relocation remain accessible.
    _roots = (
        (OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT)
        if DEFAULT_OUTPUT_ROOT != OUTPUT_ROOT
        else (OUTPUT_ROOT,)
    )

    if raw.startswith("/api/outputs/"):
        rel = raw[len("/api/outputs/"):].lstrip("/")
        for root in _roots:
            try:
                candidate = (root / rel).resolve()
                candidate.relative_to(root.resolve())
            except (ValueError, OSError):
                continue
            if candidate.exists():
                try:
                    return require_allowed_path(candidate)
                except ProtectedPathError:
                    return None
        return None

    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
        for root in _roots:
            try:
                resolved.relative_to(root.resolve())
                if resolved.exists():
                    try:
                        return require_allowed_path(resolved)
                    except ProtectedPathError:
                        return None
                return None
            except ValueError:
                continue
        return None

    return None


def source_hash(moodboard: dict[str, Any], version: int = ANALYSIS_VERSION) -> str:
    """A hash of what an analysis is made from, to tell whether a saved one is current.

    Version 1 also hashed the board's name; from version 2 a rename doesn't
    make the analysis out of date.
    """
    payload = {
        "mode": moodboard.get("mode"),
        "strength": moodboard.get("strength"),
        "notes": moodboard.get("notes"),
        "images": [
            {
                "url": img.get("url"),
                "weight": img.get("weight"),
                "notes": img.get("notes"),
                "excluded": img.get("excluded"),
            }
            for img in moodboard.get("images", [])
            if isinstance(img, dict)
        ],
    }
    if version < 2:
        payload["name"] = moodboard.get("name")
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _measure(path: Path, thresholds: Thresholds) -> dict[str, Any]:
    stat = path.stat()
    return copy.deepcopy(_measure_file(
        str(path), stat.st_mtime_ns, stat.st_size,
        thresholds.accent_min_chroma, thresholds.accent_separation, thresholds.merge_delta_e))


@functools.lru_cache(maxsize=256)
def _measure_file(path: str, mtime_ns: int, size: int, accent_min_chroma: float, accent_separation: float,
                  merge_delta_e: float) -> dict[str, Any]:
    """Measure one image file. The key's mtime and size re-measure a changed
    file; the thresholds keep a dry run's measurement apart from the default."""
    with Image.open(path) as pil:
        rgb = pil.convert("RGB")
    measured = measure_image(rgb, accent_min_chroma=accent_min_chroma, accent_separation=accent_separation,
                             merge_delta_e=merge_delta_e)
    lightness, saturation = _image_stats(rgb)
    return {
        "width": rgb.width,
        "height": rgb.height,
        "colors": [
            {"hex": entry["hex"], "share": entry["share"], "accent": entry["is_accent"]}
            for entry in measured["palette"]
        ],
        "lightness": round(lightness, 3),
        "saturation": round(saturation, 3),
    }


@dataclass
class _Steering:
    """An analyzed image that shapes the board: its weight, its colours, and
    its number and id on the board (for a colour's sources)."""
    weight: float
    colours: list[dict[str, Any]]
    number: int
    id: str


@dataclass
class _Swatch:
    lab: np.ndarray
    share: float
    images: dict[int, float]  # image index → its part of the board's weight
    # image index → this colour's share of that image. Two colours from one
    # image that merge add up here; ``images`` (which ranks accents) doesn't.
    sources: dict[int, float]


def _roll_up(
    steering: list[_Steering],
    merge_delta_e: float = MERGE_DELTA_E,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The board's dominant palette and its accents, from each image's colours.

    A colour's board share is the sum over images of (image weight / total
    weight) × its share of that image: the part of the weighted board it
    covers. Colours closer than dE00 5 (Commons' rule) merge across images.
    Dominants rank by share. Accents rank by how much of the weighted board
    carries them, then by share, since an accent is small by definition; one
    the dominant palette already holds is dropped.
    """
    total = sum(image.weight for image in steering)
    if total <= 0:
        return [], []
    parts = [image.weight / total for image in steering]
    dominant: list[_Swatch] = []
    accent: list[_Swatch] = []
    for index, image in enumerate(steering):
        part = parts[index]
        for colour in image.colours:
            share = float(colour["share"])
            swatch = _Swatch(hex_to_lab(colour["hex"]), part * share, {index: part}, {index: share})
            (accent if colour["accent"] else dominant).append(swatch)

    kept = sorted(_merge(dominant, merge_delta_e),
                  key=lambda s: (-round(s.share, 6), float(s.lab[0])))[:PALETTE_SIZE]
    kept_labs = np.array([s.lab for s in kept])
    accents = [
        s for s in _merge(accent, merge_delta_e)
        if not len(kept) or float(np.min(delta_e00(s.lab[None, :], kept_labs))) >= merge_delta_e
    ]
    accents.sort(key=lambda s: (-round(sum(s.images.values()), 6), -round(s.share, 6), float(s.lab[0])))
    return (
        [_swatch_json(s, "dominant", steering, parts) for s in kept],
        [_swatch_json(s, "accent", steering, parts) for s in accents[:ACCENT_LIMIT]],
    )


def _merge(swatches: list[_Swatch], merge_delta_e: float = MERGE_DELTA_E) -> list[_Swatch]:
    """Greedily merge the closest pair under dE00 5 (``merge_delta_e``) until none remain.

    The same rule as commons.measure._merge, with the distances kept in a
    matrix so a board of many images stays fast.
    """
    n = len(swatches)
    if n < 2:
        return list(swatches)
    items = list(swatches)
    labs = np.array([s.lab for s in items])
    dist = delta_e00(labs[:, None, :], labs[None, :, :])
    np.fill_diagonal(dist, np.inf)
    alive = np.ones(n, dtype=bool)
    while True:
        i, j = divmod(int(np.argmin(dist)), n)
        if not dist[i, j] < merge_delta_e:
            break
        a, b = items[i], items[j]
        share = a.share + b.share
        lab = (a.lab * a.share + b.lab * b.share) / share
        sources = dict(a.sources)
        for index, image_share in b.sources.items():
            sources[index] = sources.get(index, 0.0) + image_share
        items[i] = _Swatch(lab, share, {**a.images, **b.images}, sources)
        labs[i] = lab
        alive[j] = False
        row = np.where(alive, delta_e00(lab[None, :], labs), np.inf)
        row[i] = np.inf
        dist[i, :] = row
        dist[:, i] = row
        dist[j, :] = np.inf
        dist[:, j] = np.inf
    return [items[k] for k in range(n) if alive[k]]


def _swatch_json(swatch: _Swatch, role: str, steering: list[_Steering], parts: list[float]) -> dict[str, Any]:
    """A board colour as saved. ``sources``: each image it comes from, by its
    number and id, with the colour's share of that image and its contribution
    (the image's part of the board weight × that share), largest first."""
    sources = sorted(
        ((parts[index] * image_share, steering[index].number, steering[index].id, image_share)
         for index, image_share in swatch.sources.items()),
        key=lambda item: (-item[0], item[1]),
    )
    return {
        "hex": lab_to_hex(swatch.lab),
        "share": round(swatch.share, 4),
        "role": role,
        "images": len(swatch.images),
        "sources": [
            {"number": number, "id": image_id, "share": round(image_share, 4), "contribution": round(contribution, 4)}
            for contribution, number, image_id, image_share in sources
        ],
    }


def _clamp_float(raw: Any, default: float, lower: float, upper: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = default
    return max(lower, min(upper, value))


def _image_stats(img: Image.Image) -> tuple[float, float]:
    arr = np.asarray(img.resize((64, 64), Image.Resampling.BILINEAR), dtype=np.float64)
    maxc = arr.max(axis=2)
    minc = arr.min(axis=2)
    lightness = float(((maxc + minc) / 2.0).mean())
    saturation = np.where(maxc == 0, 0.0, (maxc - minc) / np.maximum(maxc, 1.0) * 255.0)
    return lightness, float(saturation.mean())


def _weighted_mean(images: list[dict[str, Any]], value: Any) -> float:
    """Mean of ``value(image)`` over images that steer the board, by weight."""
    weights = np.array([float(img["weight"]) for img in images])
    return float(np.average([value(img) for img in images], weights=weights))


def _keywords_from_analysis(
    mode: str,
    notes: str,
    images: list[dict[str, Any]],
    palette: list[str],
) -> list[str]:
    keywords: list[str] = []
    if palette:
        keywords.append("palette-led")
    # Anything but look or world reads as subject, as before.
    keywords.extend(_MODE_CUES.get(mode, _MODE_CUES["subject"]))

    if images:
        lightness = _weighted_mean(images, lambda img: img.get("lightness", 128))
        saturation = _weighted_mean(images, lambda img: img.get("saturation", 64))
        for label, pred in _PALETTE_WORDS:
            if pred(lightness, saturation):
                keywords.append(label)

    for token in notes.replace(",", " ").split():
        cleaned = token.strip().lower()
        if len(cleaned) >= 4 and cleaned.isalpha() and cleaned not in keywords:
            keywords.append(cleaned)
        if len(keywords) >= 12:
            break
    return keywords[:12]


def _summary(mode: str, count: int, palette: list[str], accents: list[str], notes: str) -> str:
    if count == 0:
        return "Empty moodboard; add images before using this as a strong creative reference."
    palette_text = ", ".join(palette[:5]) if palette else "no local palette extracted"
    accent_text = f" Accents: {', '.join(accents)}." if accents else ""
    note_text = f" Notes emphasize: {notes[:180]}" if notes else ""
    return f"{count} reference image(s) analyzed as {mode}. Palette: {palette_text}.{accent_text}{note_text}"


def _taste_profile(mode: str, keywords: list[str], palette: list[str]) -> str:
    key_text = ", ".join(keywords[:6]) if keywords else "balanced visual direction"
    palette_text = ", ".join(palette[:4]) if palette else "source-image palette"
    return f"{_MODE_LABELS.get(mode, _MODE_LABELS['look'])}; cues: {key_text}; colors: {palette_text}."


def _lighting_hint(images: list[dict[str, Any]]) -> str:
    if not images:
        return "derive lighting from source references"
    lightness = _weighted_mean(images, lambda img: img.get("lightness", 128))
    if lightness < 80:
        return "low-key, shadow-forward lighting"
    if lightness > 180:
        return "high-key, bright highlight-forward lighting"
    return "balanced mid-key lighting"


def _composition_hint(images: list[dict[str, Any]]) -> str:
    if not images:
        return "derive composition from source references"
    avg = _weighted_mean(
        images, lambda img: float(img.get("width", 1)) / max(1.0, float(img.get("height", 1))))
    if avg > 1.35:
        return "wide horizontal framing"
    if avg < 0.8:
        return "vertical portrait framing"
    return "balanced square-to-standard framing"


def _subject_bias(mode: str, notes: str) -> list[str]:
    if mode != "subject":
        return []
    return [token.lower() for token in notes.replace(",", " ").split() if len(token) >= 4][:8]
