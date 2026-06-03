"""Deterministic local analysis for native Nebula moodboards.

This is intentionally provider-neutral. It extracts facts Nebula can derive
without a vision model today (palette, weights, source coverage, notes) and
packages them into a richer creative-direction schema that a future LLM-backed
analyzer can fill in without changing the saved Moodboard resource.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
from PIL import Image, UnidentifiedImageError

from cinema.color import extract_palette
from services.output import OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT

_MODE_LABELS = {
    "look": "visual style only; avoid copying specific subjects or identities",
    "world": "world, materials, environment, and production design",
    "subject": "subject, silhouette, costume, and identity-adjacent visual cues",
}

_PALETTE_WORDS = [
    ("deep shadows", lambda l, s: l < 70),
    ("muted color", lambda l, s: s < 35),
    ("high color energy", lambda l, s: s > 95),
    ("soft highlights", lambda l, s: l > 185),
]


def analyze_moodboard(moodboard: dict[str, Any]) -> dict[str, Any]:
    """Return a stable creative-direction analysis for a Moodboard dict."""
    images = [
        img for img in moodboard.get("images", [])
        if isinstance(img, dict) and not bool(img.get("excluded"))
    ]
    notes = str(moodboard.get("notes") or "").strip()
    mode = str(moodboard.get("mode") or "look")
    strength = _clamp_float(moodboard.get("strength"), 0.7, 0.0, 1.0)

    per_image: list[dict[str, Any]] = []
    weighted_palette: list[str] = []
    representative: list[str] = []
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
            with Image.open(local_path) as pil:
                rgb = pil.convert("RGB")
                palette = extract_palette(rgb, k=6)
                avg_lightness, avg_saturation = _image_stats(rgb)
                item.update({
                    "status": "analyzed",
                    "width": rgb.width,
                    "height": rgb.height,
                    "palette": palette,
                    "lightness": round(avg_lightness, 3),
                    "saturation": round(avg_saturation, 3),
                })
                repeats = max(1, int(round(weight * 4)))
                weighted_palette.extend(palette[:4] * repeats)
                representative.append(url)
        except (OSError, UnidentifiedImageError) as exc:
            item["status"] = "error"
            item["error"] = str(exc)
            item["palette"] = []
            warnings.append(f"Could not analyze image: {url}")
        per_image.append(item)

    palette = _dedupe_palette(weighted_palette)[:8]
    representative = representative[:10]
    keywords = _keywords_from_analysis(mode, notes, per_image, palette)
    avoids = _avoids_for_mode(mode)
    style_brief = _style_brief(
        name=str(moodboard.get("name") or "Moodboard"),
        mode=mode,
        notes=notes,
        palette=palette,
        keywords=keywords,
        strength=strength,
    )

    return {
        "version": 1,
        "sourceHash": _source_hash(moodboard),
        "mode": mode,
        "modeIntent": _MODE_LABELS.get(mode, _MODE_LABELS["look"]),
        "strength": strength,
        "summary": _summary(mode, len(images), palette, notes),
        "tasteProfile": _taste_profile(mode, keywords, palette),
        "styleBrief": style_brief,
        "negativePrompt": ", ".join(avoids),
        "keywords": keywords,
        "avoids": avoids,
        "palette": palette,
        "lighting": _lighting_hint(per_image),
        "composition": _composition_hint(per_image),
        "materials": [],
        "textures": [],
        "motifs": [],
        "subjectBias": _subject_bias(mode, notes),
        "representativeImages": representative,
        "providerHints": {
            "krea": {
                "strategy": "image_style_references",
                "representativeImages": representative[:10],
                "strength": strength,
                "styleBrief": style_brief,
            },
            "generic": {
                "promptSuffix": style_brief,
                "negativePrompt": ", ".join(avoids),
                "palette": palette,
            },
        },
        "images": per_image,
        "warnings": warnings,
    }


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
                return candidate
        return None

    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
        for root in _roots:
            try:
                resolved.relative_to(root.resolve())
                return resolved if resolved.exists() else None
            except ValueError:
                continue
        return None

    return None


def _source_hash(moodboard: dict[str, Any]) -> str:
    payload = {
        "name": moodboard.get("name"),
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
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _clamp_float(raw: Any, default: float, lower: float, upper: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = default
    return max(lower, min(upper, value))


def _dedupe_palette(colors: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for color in colors:
        key = color.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(key)
    return deduped


def _image_stats(img: Image.Image) -> tuple[float, float]:
    arr = np.asarray(img.resize((64, 64), Image.Resampling.BILINEAR), dtype=np.float64)
    maxc = arr.max(axis=2)
    minc = arr.min(axis=2)
    lightness = float(((maxc + minc) / 2.0).mean())
    saturation = np.where(maxc == 0, 0.0, (maxc - minc) / np.maximum(maxc, 1.0) * 255.0)
    return lightness, float(saturation.mean())


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

    analyzed = [img for img in images if img.get("status") == "analyzed"]
    if analyzed:
        lightness = float(np.mean([img.get("lightness", 128) for img in analyzed]))
        saturation = float(np.mean([img.get("saturation", 64) for img in analyzed]))
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


def _avoids_for_mode(mode: str) -> list[str]:
    avoids = ["unrelated style drift", "conflicting palettes", "random artifacts"]
    if mode == "look":
        avoids.extend(["copying exact subjects", "identity transfer", "logo replication"])
    elif mode == "world":
        avoids.extend(["generic locations", "mixed eras", "inconsistent materials"])
    else:
        avoids.extend(["inconsistent facial features", "unmotivated wardrobe changes"])
    return avoids


def _summary(mode: str, count: int, palette: list[str], notes: str) -> str:
    if count == 0:
        return "Empty moodboard; add images before using this as a strong creative reference."
    palette_text = ", ".join(palette[:5]) if palette else "no local palette extracted"
    note_text = f" Notes emphasize: {notes[:180]}" if notes else ""
    return f"{count} reference image(s) analyzed as {mode}. Palette: {palette_text}.{note_text}"


def _taste_profile(mode: str, keywords: list[str], palette: list[str]) -> str:
    key_text = ", ".join(keywords[:6]) if keywords else "balanced visual direction"
    palette_text = ", ".join(palette[:4]) if palette else "source-image palette"
    return f"{_MODE_LABELS.get(mode, _MODE_LABELS['look'])}; cues: {key_text}; colors: {palette_text}."


def _style_brief(
    name: str,
    mode: str,
    notes: str,
    palette: list[str],
    keywords: list[str],
    strength: float,
) -> str:
    parts = [
        f"Use the Nebula moodboard '{name}' as {mode} direction at strength {strength:.2f}.",
        _MODE_LABELS.get(mode, _MODE_LABELS["look"]),
    ]
    if palette:
        parts.append(f"Color palette: {', '.join(palette[:8])}.")
    if keywords:
        parts.append(f"Visual cues: {', '.join(keywords[:10])}.")
    if notes:
        parts.append(f"User notes: {notes}")
    return " ".join(parts)


def _lighting_hint(images: list[dict[str, Any]]) -> str:
    analyzed = [img for img in images if img.get("status") == "analyzed"]
    if not analyzed:
        return "derive lighting from source references"
    lightness = float(np.mean([img.get("lightness", 128) for img in analyzed]))
    if lightness < 80:
        return "low-key, shadow-forward lighting"
    if lightness > 180:
        return "high-key, bright highlight-forward lighting"
    return "balanced mid-key lighting"


def _composition_hint(images: list[dict[str, Any]]) -> str:
    analyzed = [img for img in images if img.get("status") == "analyzed"]
    if not analyzed:
        return "derive composition from source references"
    ratios = [
        float(img.get("width", 1)) / max(1.0, float(img.get("height", 1)))
        for img in analyzed
    ]
    avg = float(np.mean(ratios))
    if avg > 1.35:
        return "wide horizontal framing"
    if avg < 0.8:
        return "vertical portrait framing"
    return "balanced square-to-standard framing"


def _subject_bias(mode: str, notes: str) -> list[str]:
    if mode != "subject":
        return []
    return [token.lower() for token in notes.replace(",", " ").split() if len(token) >= 4][:8]
