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

# Lab pairs from Sharma, Wu and Dalal (2005), the CIEDE2000 reference set,
# for the hue-angle branches an sRGB pair may not reach.
LAB_PAIRS = [
    ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485)),
    ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485)),
    ((50.0, 2.8361, -74.0200), (50.0, 0.0, -82.7485)),
    ((50.0, -1.3802, -84.2814), (50.0, 0.0, -82.7485)),
    ((50.0, 0.0, 0.0), (50.0, -1.0, 2.0)),
    ((50.0, -1.0, 2.0), (50.0, 0.0, 0.0)),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0009)),
    ((50.0, 2.49, -0.001), (50.0, -2.49, 0.0011)),
    ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0)),
    ((50.0, 2.5, 0.0), (61.0, -5.0, 29.0)),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387)),
    ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864)),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619)),
    ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447)),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514)),
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
    lab_cases = [
        {"a": list(a), "b": list(b), "deltaE00": round(float(delta_e00(np.array(a), np.array(b))), 6)}
        for a, b in LAB_PAIRS
    ]
    return {
        "about": (
            "CIEDE2000 on cinema.color's sRGB to Lab (D65), as backend/commons/colour.delta_e00 computes it, "
            "and the merge threshold of backend/commons/measure.py. frontend/src/lib/paletteExtract.ts ports both. "
            "Written by scripts/generate-colour-delta-e00-fixture.py; backend/tests/test_colour_delta_e00_contract.py "
            "and frontend/tests/colourDeltaE00Contract.test.ts fail if either side drifts."
        ),
        "mergeDeltaE": float(MERGE_DELTA_E),
        "rgbPairs": rgb_cases,
        "labPairs": lab_cases,
    }


if __name__ == "__main__":
    OUT.write_text(json.dumps(build(), indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
