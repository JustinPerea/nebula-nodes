"""Deterministic local analysis for native Nebula moodboards.

Colour comes from Commons' measurement (commons/measure.py): each image gets
the colours it's made of, with the share of pixels each covers, plus a
separate pass for small saturated accents (a button, a logo mark) that pixel
clustering would absorb. The board's palette ranks colours by image weight ×
share, merged across images in CIELAB; accents roll up into their own list.
Notes, mode and brightness fill in the rest. A vision reader can fill the
empty fields later without changing the saved Moodboard resource.

The brief and negatives are written by services/moodboard_brief.py, which
also joins in the person's Direction, Avoid and pinned colours (kept on the
board, not here, so analyzing again can't drop them).
"""
from __future__ import annotations

import copy
import functools
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
from PIL import Image, UnidentifiedImageError

from commons.colour import delta_e00, hex_to_lab, lab_to_hex
from commons.measure import MERGE_DELTA_E, measure_image
from services.file_access import ProtectedPathError, require_allowed_path
from services.moodboard_brief import DEFECT_NEGATIVES, generated_brief
from services.output import OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT

# 2: colours from Commons' measurement, ranked by weight × share, with accents
# kept apart; the source hash leaves out the board's name.
# 3: negatives are defects only and the brief states intent positively; the
# person's Direction, Avoid and pinned colours live on the board
# (services/moodboard_brief.py).
ANALYSIS_VERSION = 3
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


def steers(weight: float) -> bool:
    """Whether an image with this weight shapes the board.

    Weight 0 keeps an image on the board without using it: it adds nothing to
    the palette and isn't a representative image. Excluding is the separate
    switch that leaves an image out of the analysis altogether.
    """
    return weight > 0


def analyze_moodboard(moodboard: dict[str, Any]) -> dict[str, Any]:
    """Return a stable creative-direction analysis for a Moodboard dict.

    It reads every image file, so code on the event loop runs it in a thread.
    """
    images = [
        img for img in moodboard.get("images", [])
        if isinstance(img, dict) and not bool(img.get("excluded"))
    ]
    notes = str(moodboard.get("notes") or "").strip()
    mode = str(moodboard.get("mode") or "look")
    strength = _clamp_float(moodboard.get("strength"), 0.7, 0.0, 1.0)

    per_image: list[dict[str, Any]] = []
    weighted_colours: list[tuple[float, list[dict[str, Any]]]] = []
    analyzed_urls: set[str] = set()
    warnings: list[str] = []

    for img in images:
        url = str(img.get("url") or "").strip()
        if not url:
            continue
        weight = _clamp_float(img.get("weight"), 1.0, 0.0, 1.0)
        local_path = resolve_moodboard_image_path(url)
        item: dict[str, Any] = {
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
            measured = _measure(local_path)
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
            weighted_colours.append((weight, colours))
        per_image.append(item)

    if per_image and not any(steers(item["weight"]) for item in per_image):
        warnings.append("Every image has weight 0, so none of them shapes the board.")

    dominant, accent = _roll_up(weighted_colours)
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


def _measure(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return copy.deepcopy(_measure_file(str(path), stat.st_mtime_ns, stat.st_size))


@functools.lru_cache(maxsize=256)
def _measure_file(path: str, mtime_ns: int, size: int) -> dict[str, Any]:
    """Measure one image file. The key's mtime and size re-measure a changed file."""
    with Image.open(path) as pil:
        rgb = pil.convert("RGB")
    measured = measure_image(rgb)
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
class _Swatch:
    lab: np.ndarray
    share: float
    images: dict[int, float]  # image index → its part of the board's weight


def _roll_up(
    weighted_colours: list[tuple[float, list[dict[str, Any]]]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The board's dominant palette and its accents, from each image's colours.

    A colour's board share is the sum over images of (image weight / total
    weight) × its share of that image: the part of the weighted board it
    covers. Colours closer than dE00 5 (Commons' rule) merge across images.
    Dominants rank by share. Accents rank by how much of the weighted board
    carries them, then by share, since an accent is small by definition; one
    the dominant palette already holds is dropped.
    """
    total = sum(weight for weight, _ in weighted_colours)
    if total <= 0:
        return [], []
    dominant: list[_Swatch] = []
    accent: list[_Swatch] = []
    for index, (weight, colours) in enumerate(weighted_colours):
        part = weight / total
        for colour in colours:
            swatch = _Swatch(hex_to_lab(colour["hex"]), part * float(colour["share"]), {index: part})
            (accent if colour["accent"] else dominant).append(swatch)

    kept = sorted(_merge(dominant), key=lambda s: (-round(s.share, 6), float(s.lab[0])))[:PALETTE_SIZE]
    kept_labs = np.array([s.lab for s in kept])
    accents = [
        s for s in _merge(accent)
        if not len(kept) or float(np.min(delta_e00(s.lab[None, :], kept_labs))) >= MERGE_DELTA_E
    ]
    accents.sort(key=lambda s: (-round(sum(s.images.values()), 6), -round(s.share, 6), float(s.lab[0])))
    return (
        [_swatch_json(s, "dominant") for s in kept],
        [_swatch_json(s, "accent") for s in accents[:ACCENT_LIMIT]],
    )


def _merge(swatches: list[_Swatch]) -> list[_Swatch]:
    """Greedily merge the closest pair under dE00 5 until none remain.

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
        if not dist[i, j] < MERGE_DELTA_E:
            break
        a, b = items[i], items[j]
        share = a.share + b.share
        lab = (a.lab * a.share + b.lab * b.share) / share
        items[i] = _Swatch(lab, share, {**a.images, **b.images})
        labs[i] = lab
        alive[j] = False
        row = np.where(alive, delta_e00(lab[None, :], labs), np.inf)
        row[i] = np.inf
        dist[i, :] = row
        dist[:, i] = row
        dist[j, :] = np.inf
        dist[:, j] = np.inf
    return [items[k] for k in range(n) if alive[k]]


def _swatch_json(swatch: _Swatch, role: str) -> dict[str, Any]:
    return {
        "hex": lab_to_hex(swatch.lab),
        "share": round(swatch.share, 4),
        "role": role,
        "images": len(swatch.images),
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
    if mode == "look":
        keywords.extend(["style consistency", "visual language"])
    elif mode == "world":
        keywords.extend(["worldbuilding", "environmental continuity"])
    else:
        keywords.extend(["subject continuity", "silhouette consistency"])

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
