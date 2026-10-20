"""With default settings, analysis colours are pinned (gap #20 is on hold).

How colours merge and which accents survive waits on Justin's pick (gap #20).
Until then nothing may change what a board's analysis produces with default
settings: the palette, the accents, their order and shares, the brief and the
negatives. ``fixtures/moodboard_defaults_pin.json`` holds what the analyzer
produced for the boards below before colour provenance and the dry run were
added (bf488a80); this test compares against it.

To re-pin after a deliberate change (gap #20 itself), run this file with
NEBULA_REPIN_MOODBOARD=1 and review the fixture diff.

Analysis version 5 (moodboard canvas PR2, Q7) measures set-aside images: the
"brand" board's excluded image gains an ``images`` entry with
``setAside: true`` and its colours. The steering view below leaves those
entries out, so its fixture is unchanged; ``fixtures/moodboard_set_aside_pin.json``
pins the set-aside images' colours on their own.

Re-pinned 2026-10-20 (weight 0 out of the summary's count, plan section
4.4): one path moved, ``brand.summary`` "4 reference image(s)" to "3", since
its image 5 is at weight 0. Its colours, brief, negatives, keywords and
per-image colours are as they were.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from services.moodboard_analysis import analyze_moodboard
from services.moodboard_brief import compose
from services.output import OUTPUT_ROOT

FIXTURE = Path(__file__).parent / "fixtures" / "moodboard_defaults_pin.json"
SET_ASIDE_FIXTURE = Path(__file__).parent / "fixtures" / "moodboard_set_aside_pin.json"

CREAM = (235, 225, 205)
NAVY = (30, 40, 90)
SAGE = (120, 150, 120)
ORANGE = (240, 110, 30)
CHARCOAL = (40, 40, 44)
BLUE = (20, 90, 230)
MAGENTA = (220, 30, 160)
TERRACOTTA = (190, 95, 70)


def _blocks(name: str, regions: list[tuple[tuple[int, int, int], tuple[int, int, int, int]]],
            background: tuple[int, int, int], *, noise: int = 6, seed: int = 0) -> str:
    """A 96×72 image: a background, rectangles (colour, (y0, y1, x0, x1)) on
    top, and seeded noise of ±``noise`` per channel. The same name and spec
    always give the same pixels."""
    rng = np.random.default_rng(seed)
    pixels = np.zeros((72, 96, 3), dtype=np.int16)
    pixels[:] = background
    for colour, (y0, y1, x0, x1) in regions:
        pixels[y0:y1, x0:x1] = colour
    if noise:
        pixels += rng.integers(-noise, noise + 1, size=pixels.shape, dtype=np.int16)
    path = OUTPUT_ROOT / "moodboard-pin-tests" / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _image(url: str, weight: float = 1.0, *, excluded: bool = False, image_id: str = "") -> dict[str, Any]:
    return {"id": image_id or url.rsplit("/", 1)[-1][:-4], "url": url, "weight": weight, "notes": "",
            "excluded": excluded}


def pinned_boards() -> dict[str, dict[str, Any]]:
    """The boards the pin covers. Each exercises a part of the roll-up."""
    brand = [
        _image(_blocks("brand-1", [(NAVY, (0, 18, 0, 96)), (ORANGE, (40, 43, 10, 14))], CREAM, seed=1)),
        _image(_blocks("brand-2", [(CREAM, (0, 26, 0, 96)), (ORANGE, (50, 54, 70, 75))], SAGE, seed=2), 0.6),
        _image(_blocks("brand-3", [(ORANGE, (0, 11, 0, 96))], CHARCOAL, seed=3)),
        _image(_blocks("brand-4", [], BLUE, seed=4), excluded=True),
        _image(_blocks("brand-5", [], MAGENTA, seed=5), 0.0),
    ]
    # Near shades of one colour, a few dE00 apart, so the roll-up merges some.
    shades = [
        _image(_blocks(f"shade-{n}", [(CHARCOAL, (60, 72, 0, 96))],
                       (TERRACOTTA[0] + 6 * n, TERRACOTTA[1] + 3 * n, TERRACOTTA[2] - 2 * n), seed=10 + n),
               weight)
        for n, weight in enumerate((1.0, 0.8, 0.5, 0.3))
    ]
    busy = [
        _image(_blocks("busy-1", [(NAVY, (0, 24, 0, 32)), (SAGE, (0, 24, 32, 64)), (ORANGE, (0, 24, 64, 96)),
                                  (CHARCOAL, (24, 48, 0, 48)), (BLUE, (24, 48, 48, 96)),
                                  (MAGENTA, (70, 72, 0, 4))], CREAM, noise=14, seed=20)),
        _image(_blocks("busy-2", [(TERRACOTTA, (0, 36, 0, 96)), (BLUE, (36, 38, 0, 6))], CREAM, noise=10, seed=21),
               0.7),
    ]
    # The orange is a small accent in every image, so it stays an accent.
    accent = [
        _image(_blocks("accent-1", [], NAVY, noise=2, seed=30)),
        _image(_blocks("accent-2", [(ORANGE, (2, 6, 2, 8))], CREAM, noise=2, seed=31)),
        _image(_blocks("accent-3", [(ORANGE, (60, 63, 80, 86)), (BLUE, (10, 13, 40, 45))], SAGE, noise=2, seed=32),
               0.5),
    ]
    return {
        "accent": {"name": "Accent", "mode": "look", "strength": 0.7, "notes": "", "images": accent},
        "brand": {"name": "Brand", "mode": "look", "strength": 0.7, "notes": "warm paper, one hot accent",
                  "images": brand, "direction": "quiet product shots",
                  "avoid": ["neon signage"], "pinnedColors": {"include": ["#e8593c"], "exclude": []}},
        "shades": {"name": "Shades", "mode": "world", "strength": 0.5, "notes": "", "images": shades},
        "busy": {"name": "Busy", "mode": "subject", "strength": 0.9, "notes": "many colours",
                 "images": busy, "pinnedColors": {"include": [], "exclude": ["#1e285a"]}},
    }


def pinned_view(board: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    """What must not change: the colours, their order and shares, the brief
    and the negatives. Per-image colours are those of the images that aren't
    set aside (``set_aside_view`` has the others)."""
    composed = compose(board, analysis)
    return {
        "palette": analysis["palette"],
        "accents": analysis["accents"],
        "colors": [{key: colour[key] for key in ("hex", "share", "role", "images")} for colour in analysis["colors"]],
        "styleBrief": analysis["styleBrief"],
        "negativePrompt": analysis["negativePrompt"],
        "avoids": analysis["avoids"],
        "keywords": analysis["keywords"],
        "summary": analysis["summary"],
        "imageColors": [item.get("colors") for item in analysis["images"] if not item.get("setAside")],
        "composed": {key: composed[key] for key in ("styleBrief", "negativePrompt", "avoidPrompt", "palette",
                                                    "accents")},
    }


def set_aside_view(analysis: dict[str, Any]) -> list[dict[str, Any]]:
    """The set-aside images as the analysis lists them: number, id, status and colours."""
    return [{key: item.get(key) for key in ("number", "id", "status", "colors")}
            for item in analysis["images"] if item.get("setAside")]


def _current() -> dict[str, Any]:
    return {name: pinned_view(board, analyze_moodboard(board)) for name, board in pinned_boards().items()}


def test_default_analysis_matches_the_pin() -> None:
    current = _current()
    if os.environ.get("NEBULA_REPIN_MOODBOARD") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        pytest.skip("re-pinned; review the fixture diff")
    pinned = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for name in pinned:
        assert current[name] == pinned[name], name


def test_set_aside_colours_match_the_pin() -> None:
    boards = pinned_boards()
    current = {name: set_aside_view(analyze_moodboard(board)) for name, board in boards.items()}
    if os.environ.get("NEBULA_REPIN_MOODBOARD") == "1":
        SET_ASIDE_FIXTURE.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        pytest.skip("re-pinned; review the fixture diff")
    assert current == json.loads(SET_ASIDE_FIXTURE.read_text(encoding="utf-8"))
    # Only the brand board sets one aside: image 4, measured as if it steered.
    assert [len(entries) for entries in current.values()] == [0, 1, 0, 0]
    (entry,) = current["brand"]
    assert (entry["number"], entry["id"], entry["status"]) == (4, "brand-4", "analyzed")
    alone = boards["brand"]["images"][3]
    assert entry["colors"] == analyze_moodboard({**boards["brand"], "images": [{**alone, "excluded": False}]}
                                                )["images"][0]["colors"]
