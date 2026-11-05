"""The CIEDE2000 contract with the frontend (contracts/fixtures/colour/delta_e00.json).

Extract from reference merges swatches with a TypeScript port of
commons.colour.delta_e00 at commons.measure.MERGE_DELTA_E. The fixture holds
what the backend computes; frontend/tests/colourDeltaE00Contract.test.ts holds
the port to it. Its Lab pairs also carry Sharma, Wu and Dalal's published
values (all 34), and two hue-wrap pairs an independent value, which both
sides are checked against, so a bug they share fails too. If the backend's colour distance or threshold changes, this
fails until the fixture is written again
(scripts/generate-colour-delta-e00-fixture.py), and then the frontend test
fails until the port follows."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

from cinema.color import rgb_to_lab
from commons.colour import delta_e00
from commons.measure import MERGE_DELTA_E

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "contracts/fixtures/colour/delta_e00.json").read_text())


def test_the_fixture_holds_the_backend_merge_threshold():
    assert FIXTURE["mergeDeltaE"] == MERGE_DELTA_E == 5.0


@pytest.mark.parametrize("case", FIXTURE["rgbPairs"], ids=lambda c: f"{c['a']}-{c['b']}")
def test_rgb_pairs_match_the_backend(case):
    la = rgb_to_lab(np.array(case["a"], dtype=np.float64))
    lb = rgb_to_lab(np.array(case["b"], dtype=np.float64))
    assert la == pytest.approx(case["labA"], abs=1e-6)
    assert lb == pytest.approx(case["labB"], abs=1e-6)
    assert float(delta_e00(la, lb)) == pytest.approx(case["deltaE00"], abs=1e-6)


@pytest.mark.parametrize("case", FIXTURE["labPairs"], ids=lambda c: f"{c['a']}-{c['b']}")
def test_lab_pairs_match_the_backend(case):
    assert float(delta_e00(np.array(case["a"]), np.array(case["b"]))) == pytest.approx(case["deltaE00"], abs=1e-6)


SHARMA = [c for c in FIXTURE["labPairs"] if "published" in c]


def test_the_fixture_holds_every_published_sharma_pair():
    assert [c["sharmaPair"] for c in SHARMA] == list(range(1, 35))


@pytest.mark.parametrize("case", SHARMA, ids=lambda c: f"sharma{c['sharmaPair']}")
def test_lab_pairs_match_the_published_sharma_table(case):
    # Sharma, Wu and Dalal (2005) print ΔE00 to 4 dp: the paper, not this code,
    # is the reference, so a bug the TS port copied from here can't pass.
    assert float(delta_e00(np.array(case["a"]), np.array(case["b"]))) == pytest.approx(case["published"], abs=1e-4)


@pytest.mark.parametrize("case", [c for c in FIXTURE["labPairs"] if "independent" in c], ids=lambda c: f"{c['a']}-{c['b']}")
def test_the_hue_wrap_pairs_match_an_independent_ciede2000(case):
    assert float(delta_e00(np.array(case["a"]), np.array(case["b"]))) == pytest.approx(case["independent"], abs=1e-4)


def test_the_fixture_takes_both_hue_wraps_away_from_zero_chroma():
    # Review 4 N1: a pair at zero chroma or exactly 180° doesn't notice a
    # missing wrap, so keep one each way with real chroma and |Δh'| well past 180.
    def hue_step(case):
        lab1, lab2 = np.array(case["a"], float), np.array(case["b"], float)
        cbar = (np.hypot(*lab1[1:]) + np.hypot(*lab2[1:])) / 2
        g = 0.5 * (1 - np.sqrt(cbar**7 / (cbar**7 + 25.0**7)))
        h1, h2 = (np.degrees(np.arctan2(lab[2], (1 + g) * lab[1])) % 360 for lab in (lab1, lab2))
        chroma = min(np.hypot((1 + g) * lab1[1], lab1[2]), np.hypot((1 + g) * lab2[1], lab2[2]))
        return h2 - h1, chroma

    steps = [hue_step(c) for c in FIXTURE["labPairs"]]
    assert any(d < -190 and c > 10 for d, c in steps)
    assert any(d > 190 and c > 10 for d, c in steps)


def test_the_generator_writes_exactly_the_fixture():
    spec = importlib.util.spec_from_file_location("gen_de00", ROOT / "scripts/generate-colour-delta-e00-fixture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.build() == FIXTURE


def test_near_blacks_are_one_colour_and_mid_tones_past_the_threshold_are_two():
    # Why Extract uses this metric (review 3, M1): plain OKLab put #000000 and
    # #010101 twice its threshold apart, while CIEDE2000 keeps near-blacks and
    # near-whites alike under the merge threshold.
    def d(a, b):
        return float(delta_e00(rgb_to_lab(np.array(a, float)), rgb_to_lab(np.array(b, float))))

    assert d((0, 0, 0), (7, 7, 7)) < MERGE_DELTA_E
    assert d((248, 248, 248), (255, 255, 255)) < MERGE_DELTA_E
    assert d((120, 140, 160), (120, 140, 179)) > MERGE_DELTA_E
