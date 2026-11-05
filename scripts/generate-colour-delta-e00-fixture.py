"""Write contracts/fixtures/colour/delta_e00.json from the backend's CIEDE2000.

Extract from reference (frontend/src/lib/paletteExtract.ts) merges swatches
with a TypeScript port of backend/commons/colour.delta_e00 on cinema.color's
Lab, at the backend's MERGE_DELTA_E (commons/measure.py), so Extract and the
moodboard palette agree on what "the same colour" is. This table is the
contract between the two: backend/tests/test_colour_delta_e00_contract.py
checks the Python against it, frontend/tests/colourDeltaE00Contract.test.ts
checks the port, so the two can't drift.

Run from the repo root: backend/.venv/bin/python scripts/generate-colour-delta-e00-fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np  # noqa: E402

from cinema.color import rgb_to_lab  # noqa: E402
from commons.colour import delta_e00  # noqa: E402
from commons.measure import MERGE_DELTA_E  # noqa: E402

OUT = ROOT / "contracts/fixtures/colour/delta_e00.json"

# sRGB pairs: near-blacks (where plain OKLab overstates), near-whites,
# mid-tones either side of the threshold, saturated hues, the hue wrap at
# 0/360 and greys against colours (zero chroma).
RGB_PAIRS = [
    ((0, 0, 0), (1, 1, 1)),
    ((0, 0, 0), (2, 2, 2)),
    ((0, 0, 0), (5, 5, 5)),
    ((0, 0, 0), (7, 7, 7)),
    ((3, 3, 3), (0, 0, 0)),
    ((7, 0, 3), (0, 6, 2)),
    ((248, 248, 248), (255, 255, 255)),
    ((252, 252, 252), (240, 240, 240)),
    ((120, 120, 120), (124, 124, 124)),
    ((120, 120, 120), (130, 130, 130)),
    ((120, 140, 160), (120, 140, 179)),
    ((128, 128, 128), (0, 0, 0)),
    ((128, 128, 128), (255, 255, 255)),
    ((240, 120, 20), (0, 0, 0)),
    ((240, 120, 20), (236, 118, 24)),
    ((232, 89, 60), (30, 90, 220)),
    ((131, 90, 140), (232, 89, 60)),
    ((17, 20, 19), (232, 89, 60)),
    ((255, 0, 0), (255, 0, 40)),
    ((255, 0, 60), (255, 40, 0)),
    ((200, 40, 40), (100, 100, 100)),
    ((40, 200, 70), (40, 180, 60)),
    ((40, 80, 220), (60, 40, 220)),
    ((240, 220, 40), (230, 230, 40)),
    ((10, 200, 90), (10, 200, 90)),
    ((0, 0, 255), (20, 0, 255)),
    ((0, 128, 128), (0, 120, 136)),
]

# All 34 Lab pairs of Sharma, Wu and Dalal (2005), "The CIEDE2000
# Color-Difference Formula: Implementation Notes, Supplementary Test Data, and
# Mathematical Observations", Table 1, with the published ΔE00 (4 dp) beside
# each. Copied from the authors' file ciede2000testdata.txt
# (hajim.rochester.edu/ece/sites/gsharma/ciede2000/), in its order, so pair n
# here is pair n there. They cover every hue-angle branch, the 180° h̄' boundary
# (pairs 13-15) and the a' rescaling near the neutral axis (pairs 21-24). The
# fixture keeps both the backend's own value (deltaE00, to 1e-6, the contract
# with the frontend port) and the published one (published, so a bug both sides
# share can't be certified).
SHARMA_PAIRS = [
    ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
    ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
    ((50.0, 2.8361, -74.0200), (50.0, 0.0, -82.7485), 3.4412),
    ((50.0, -1.3802, -84.2814), (50.0, 0.0, -82.7485), 1.0000),
    ((50.0, -1.1848, -84.8006), (50.0, 0.0, -82.7485), 1.0000),
    ((50.0, -0.9009, -85.5211), (50.0, 0.0, -82.7485), 1.0000),
    ((50.0, 0.0, 0.0), (50.0, -1.0, 2.0), 2.3669),
    ((50.0, -1.0, 2.0), (50.0, 0.0, 0.0), 2.3669),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0009), 7.1792),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0010), 7.1792),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0011), 7.2195),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0012), 7.2195),
    ((50.0, -0.001, 2.49), (50.0, 0.0009, -2.49), 4.8045),
    ((50.0, -0.001, 2.49), (50.0, 0.0010, -2.49), 4.8045),
    ((50.0, -0.001, 2.49), (50.0, 0.0011, -2.49), 4.7461),
    ((50.0, 2.5, 0.0), (50.0, 0.0, -2.5), 4.3065),
    ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
    ((50.0, 2.5, 0.0), (61.0, -5.0, 29.0), 22.8977),
    ((50.0, 2.5, 0.0), (56.0, -27.0, -3.0), 31.9030),
    ((50.0, 2.5, 0.0), (58.0, 24.0, 15.0), 19.4535),
    ((50.0, 2.5, 0.0), (50.0, 3.1736, 0.5854), 1.0000),
    ((50.0, 2.5, 0.0), (50.0, 3.2972, 0.0), 1.0000),
    ((50.0, 2.5, 0.0), (50.0, 1.8634, 0.5757), 1.0000),
    ((50.0, 2.5, 0.0), (50.0, 3.2592, 0.3350), 1.0000),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864), 1.2630),
    ((61.2901, 3.7196, -5.3901), (61.4292, 2.2480, -4.9620), 1.8731),
    ((35.0831, -44.1164, 3.7933), (35.0232, -40.0716, 1.5901), 1.8645),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ((36.4612, 47.8580, 18.3852), (36.2715, 50.5065, 21.2231), 1.4146),
    ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447), 1.4441),
    ((90.9257, -0.5406, -0.9208), (88.6381, -0.8985, -0.7239), 1.5381),
    ((6.7747, -0.2908, -2.4247), (5.8714, -0.0985, -2.2286), 0.6377),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
]

# The negative hue wrap (Δh' < -180°, review 4 N1). No Sharma pair reaches it
# away from zero chroma or exactly 180°, where dropping the branch changes
# nothing. (50, -40, -20) has h' ≈ 206°, (50, 60, 10) h' ≈ 9°: Δh' ≈ -197°,
# so without the wrap it gives 83.511, not 76.685. The reverse order takes the
# positive wrap. `independent` is the value outside this code: skimage 0.26
# deltaE_ciede2000 and an implementation written from the paper's equations
# both give 76.68502 (4 dp: 76.6850).
HUE_WRAP_PAIRS = [
    ((50.0, -40.0, -20.0), (50.0, 60.0, 10.0), 76.6850),
    ((50.0, 60.0, 10.0), (50.0, -40.0, -20.0), 76.6850),
]


def build() -> dict:
    rgb_cases = []
    for a, b in RGB_PAIRS:
        la, lb = rgb_to_lab(np.array(a, dtype=np.float64)), rgb_to_lab(np.array(b, dtype=np.float64))
        rgb_cases.append({
            "a": list(a), "b": list(b),
            "labA": [round(float(v), 6) for v in la],
            "labB": [round(float(v), 6) for v in lb],
            "deltaE00": round(float(delta_e00(la, lb)), 6),
        })
    def lab_delta(a, b) -> float:
        return round(float(delta_e00(np.array(a, dtype=np.float64), np.array(b, dtype=np.float64))), 6)

    lab_cases = [
        {"a": list(a), "b": list(b), "deltaE00": lab_delta(a, b), "sharmaPair": n, "published": published}
        for n, (a, b, published) in enumerate(SHARMA_PAIRS, start=1)
    ] + [
        {"a": list(a), "b": list(b), "deltaE00": lab_delta(a, b), "independent": independent}
        for a, b, independent in HUE_WRAP_PAIRS
    ]
    return {
        "about": (
            "CIEDE2000 on cinema.color's sRGB to Lab (D65), as backend/commons/colour.delta_e00 computes it, "
            "and the merge threshold of backend/commons/measure.py. frontend/src/lib/paletteExtract.ts ports both. "
            "deltaE00 is the backend's own value (to 1e-6). labPairs holds all 34 pairs of Sharma, Wu and Dalal "
            "(2005), numbered as in their table, with 'published' the value printed there (4 dp), so both sides are "
            "checked against the paper and not only against each other; the last two pairs take the negative and "
            "positive hue wraps away from zero chroma, with 'independent' from skimage and a from-the-paper "
            "implementation. Written by scripts/generate-colour-delta-e00-fixture.py; "
            "backend/tests/test_colour_delta_e00_contract.py and frontend/tests/colourDeltaE00Contract.test.ts "
            "fail if either side drifts."
        ),
        "mergeDeltaE": float(MERGE_DELTA_E),
        "rgbPairs": rgb_cases,
        "labPairs": lab_cases,
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
