"""Moodboard analysis on Commons' measurement (design-canvas gaps 6 and 17).

Before: each image gave its four darkest colours, a dedupe erased the weights,
so the palette was the darkest colours of the first images in upload order,
small accents never made it, and representative images followed upload order.
"""
from __future__ import annotations

from uuid import uuid4

import numpy as np
from PIL import Image

from commons.colour import delta_e00, hex_to_lab
from services.moodboard_analysis import (
    ANALYSIS_VERSION,
    analysis_is_current,
    analyze_moodboard,
    rank_representative_images,
    source_hash,
)
from services.output import OUTPUT_ROOT

NAVY = (30, 40, 90)
CREAM = (235, 225, 205)
SAGE = (120, 150, 120)
ORANGE = (240, 110, 30)


def _image(color: tuple[int, int, int], *, accent: tuple[int, int, int] | None = None,
           dark_edge: bool = False) -> str:
    """An 80×60 image of one colour; ``accent`` paints 0.5% of it, ``dark_edge`` 10% near-black."""
    pixels = np.zeros((60, 80, 3), dtype=np.uint8)
    pixels[:] = color
    if accent:
        pixels[2:6, 2:8] = accent
    if dark_edge:
        pixels[:6] = (12, 12, 14)
    path = OUTPUT_ROOT / "moodboard-analysis-tests" / f"{uuid4().hex[:10]}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels).save(path)
    return f"/api/outputs/{path.resolve().relative_to(OUTPUT_ROOT.resolve()).as_posix()}"


def _board(*images: tuple[str, float], **fields) -> dict:
    return {"name": "Board", "mode": "look", "strength": 0.7, "notes": "", **fields,
            "images": [{"id": f"i{n}", "url": url, "weight": weight, "notes": "", "excluded": False}
                       for n, (url, weight) in enumerate(images)]}


def _close(hex_value: str, rgb: tuple[int, int, int]) -> bool:
    target = hex_to_lab("#{:02x}{:02x}{:02x}".format(*rgb))
    return float(delta_e00(hex_to_lab(hex_value), target)) < 3


def test_weights_decide_the_palette_order() -> None:
    navy, cream = _image(NAVY), _image(CREAM)

    navy_first = analyze_moodboard(_board((navy, 1.0), (cream, 0.2)))
    cream_first = analyze_moodboard(_board((navy, 0.2), (cream, 1.0)))

    assert _close(navy_first["palette"][0], NAVY) and _close(navy_first["palette"][1], CREAM)
    assert _close(cream_first["palette"][0], CREAM) and _close(cream_first["palette"][1], NAVY)
    shares = [c["share"] for c in cream_first["colors"] if c["role"] == "dominant"]
    assert shares == sorted(shares, reverse=True) and abs(sum(shares) - 1.0) < 0.01
    assert cream_first["version"] == ANALYSIS_VERSION == 5


def test_the_largest_colour_leads_not_the_darkest() -> None:
    analysis = analyze_moodboard(_board((_image(CREAM, dark_edge=True), 1.0)))

    assert _close(analysis["palette"][0], CREAM)
    assert len(analysis["palette"]) == 2


def test_a_small_accent_is_kept_in_its_own_list() -> None:
    board = _board((_image(NAVY), 1.0), (_image(CREAM, accent=ORANGE), 1.0), (_image(SAGE, accent=ORANGE), 0.5))

    analysis = analyze_moodboard(board)

    assert len(analysis["accents"]) == 1 and _close(analysis["accents"][0], ORANGE)
    assert not any(_close(color, ORANGE) for color in analysis["palette"])
    (accent,) = [c for c in analysis["colors"] if c["role"] == "accent"]
    assert accent["images"] == 2
    assert "Accent colors, used sparingly: " + analysis["accents"][0] in analysis["styleBrief"]
    assert "The subject comes from the prompt. Color palette: " in analysis["styleBrief"]
    assert analysis["providerHints"]["generic"]["accents"] == analysis["accents"]
    cream_item = analysis["images"][1]
    assert _close(cream_item["palette"][0], CREAM) and _close(cream_item["accents"][0], ORANGE)


def test_the_same_colour_on_two_images_is_one_swatch() -> None:
    analysis = analyze_moodboard(_board((_image(NAVY), 1.0), (_image((32, 41, 92)), 1.0)))

    assert len(analysis["palette"]) == 1
    assert analysis["colors"][0]["images"] == 2 and analysis["colors"][0]["share"] == 1.0


def test_weight_zero_stays_on_the_board_without_shaping_it() -> None:
    navy, cream = _image(NAVY), _image(CREAM)

    analysis = analyze_moodboard(_board((navy, 1.0), (cream, 0.0)))

    assert [item["status"] for item in analysis["images"]] == ["analyzed", "analyzed"]
    assert len(analysis["palette"]) == 1 and _close(analysis["palette"][0], NAVY)
    assert analysis["representativeImages"] == [navy]
    assert analysis["warnings"] == []

    nothing = analyze_moodboard(_board((cream, 0.0)))
    assert nothing["palette"] == [] and nothing["representativeImages"] == []
    assert nothing["warnings"] == ["Every reference is set aside, so none of them shapes the board."]


def test_representative_images_rank_by_weight_then_board_order() -> None:
    images = [{"url": "/a.png", "weight": 0.7}, {"url": "/b.png", "weight": 1.0}, {"url": "/c.png", "weight": 1.0},
              {"url": "/d.png", "weight": 1.0, "excluded": True}, {"url": "/e.png", "weight": 0.0},
              {"url": "/b.png", "weight": 0.4}, {"url": ""}]
    assert rank_representative_images(images) == ["/b.png", "/c.png", "/a.png"]
    assert rank_representative_images(images, only={"/a.png", "/c.png"}) == ["/c.png", "/a.png"]

    twelve = [{"url": f"/{n}.png", "weight": 1.0} for n in range(12)]
    assert rank_representative_images(twelve) == [f"/{n}.png" for n in range(10)]


def test_the_analysis_ranks_only_images_it_could_read() -> None:
    light, heavy = _image(CREAM), _image(NAVY)
    board = _board((light, 0.4), ("https://elsewhere.example/x.png", 1.0), (heavy, 0.9))

    analysis = analyze_moodboard(board)

    assert analysis["representativeImages"] == [heavy, light]
    assert analysis["providerHints"]["krea"]["representativeImages"] == [heavy, light]
    # A link to another site is never fetched or read (Q98): "outside", not "unresolved".
    assert analysis["images"][1]["status"] == "outside"


def test_a_saved_analysis_is_current_until_the_board_changes() -> None:
    board = _board((_image(NAVY), 1.0), (_image(CREAM), 0.5))
    analysis = analyze_moodboard(board)
    assert analysis_is_current(board, analysis)

    assert analysis_is_current({**board, "name": "Renamed"}, analysis)
    assert analysis_is_current(board, {**analysis, "styleBrief": "Edited by hand"})
    reweighted = {**board, "images": [board["images"][0], {**board["images"][1], "weight": 1.0}]}
    assert not analysis_is_current(reweighted, analysis)
    assert not analysis_is_current({**board, "notes": "warmer"}, analysis)
    assert not analysis_is_current(board, None)
    assert not analysis_is_current(board, {**analysis, "styleBrief": ""})


def test_an_older_analysis_is_checked_against_its_own_hash() -> None:
    board = _board((_image(NAVY), 1.0))
    old = {"version": 1, "sourceHash": source_hash(board, 1), "styleBrief": "Hand-edited brief"}

    assert analysis_is_current(board, old)
    assert not analysis_is_current({**board, "name": "Renamed"}, old)
    assert not analysis_is_current(board, {**old, "version": "two"})
