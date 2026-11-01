"""The CIEDE2000 contract with the frontend (contracts/fixtures/colour/delta_e00.json).

Extract from reference merges swatches with a TypeScript port of
commons.colour.delta_e00 at commons.measure.MERGE_DELTA_E. The fixture holds
what the backend computes; frontend/tests/colourDeltaE00Contract.test.ts holds
the port to it. If the backend's colour distance or threshold changes, this
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
