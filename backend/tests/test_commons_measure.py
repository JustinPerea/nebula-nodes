from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from commons.colour import delta_e00, hex_to_lab, lab_to_hex
from commons.measure import CODE_VERSION, measure_image, phash, phash_distance


@pytest.mark.parametrize("lab1,lab2,expected", [
    # Sharma, Wu & Dalal (2005) reference pairs 1-3.
    ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
    ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
    ((50.0, 2.8361, -74.0200), (50.0, 0.0, -82.7485), 3.4412),
])
def test_delta_e00_matches_reference(lab1, lab2, expected):
    assert float(delta_e00(np.array(lab1), np.array(lab2))) == pytest.approx(expected, abs=1e-4)


def test_hex_round_trip():
    assert lab_to_hex(hex_to_lab("#3366cc")) == "#3366cc"


def _white_with_red_button() -> Image.Image:
    img = Image.new("RGB", (400, 300), (245, 245, 240))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 200, 399, 299], fill=(40, 40, 48))     # dark footer, ~33%
    draw.rectangle([180, 90, 205, 110], fill=(230, 30, 40))    # small red button, ~0.4%
    return img


def test_palette_has_shares_merges_and_keeps_the_accent():
    m = measure_image(_white_with_red_button())
    palette = m["palette"]
    assert [p["index"] for p in palette] == list(range(len(palette)))
    mains = [p for p in palette if not p["is_accent"] or p["share"] > 0.05]
    assert sum(p["share"] for p in mains) == pytest.approx(1.0, abs=0.02)
    red = hex_to_lab("#e61e28")
    assert any(p["is_accent"] and float(delta_e00(hex_to_lab(p["hex"]), red)) <= 5 for p in palette)
    # merged: no two main entries closer than dE00 5
    for i, a in enumerate(mains):
        for b in mains[i + 1:]:
            assert float(delta_e00(hex_to_lab(a["hex"]), hex_to_lab(b["hex"]))) >= 5
    assert m["code_version"] == CODE_VERSION
    assert m["aspect"] == pytest.approx(400 / 300, abs=1e-3)
    assert 0 <= m["value_range"]["low"] < m["value_range"]["high"] <= 100


def test_measurement_is_deterministic_across_three_runs():
    img = _white_with_red_button()
    runs = [measure_image(img) for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]


def test_phash_is_stable_and_separates_different_images():
    a = _white_with_red_button()
    b = a.resize((200, 150))
    c = Image.new("RGB", (400, 300), (10, 120, 60))
    ImageDraw.Draw(c).ellipse([50, 50, 350, 250], fill=(250, 250, 250))
    assert len(phash(a)) == 16
    assert phash_distance(phash(a), phash(b)) <= 8
    assert phash_distance(phash(a), phash(c)) > 8
