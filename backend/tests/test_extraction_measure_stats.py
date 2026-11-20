"""``measure_image_stats`` is ``_measure_file`` without the file: the fixture is what
``_measure_file`` returned before the split (ANALYSIS_VERSION 6), byte for byte."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from services import moodboard_analysis as ma
from services.moodboard_analysis import _measure_file, file_version, measure_image_stats

FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
BASELINE = json.loads((FIXTURES / "measure_file_v6.json").read_text())
THRESHOLDS = (ma.ACCENT_MIN_CHROMA, ma.ACCENT_SEPARATION, ma.MERGE_DELTA_E)


def _decoded(path: Path) -> Image.Image:
    with Image.open(path) as pil:
        return ma.as_rgba(pil) if ma.has_transparency(pil) else ma.as_rgb(pil)


def test_the_fixture_covers_each_kind_of_image():
    assert sorted(BASELINE) == ["fully_transparent.png", "gradient_accent.png", "one_pixel.png",
                                "partly_transparent.png", "tall_narrow.png"]
    assert ma.ANALYSIS_VERSION == 6


@pytest.mark.parametrize("name", sorted(BASELINE))
def test_measure_file_is_unchanged(name):
    _measure_file.cache_clear()
    path = FIXTURES / name
    measured = _measure_file(str(path), file_version(path.stat()), *THRESHOLDS)
    assert json.dumps(measured, sort_keys=True) == json.dumps(BASELINE[name], sort_keys=True)


@pytest.mark.parametrize("name", sorted(BASELINE))
def test_measure_image_stats_gives_the_same_dict(name):
    _measure_file.cache_clear()
    path = FIXTURES / name
    stats = measure_image_stats(_decoded(path))
    assert json.dumps(stats, sort_keys=True) == json.dumps(BASELINE[name], sort_keys=True)
    assert stats == _measure_file(str(path), file_version(path.stat()), *THRESHOLDS)


def test_thresholds_pass_through():
    image = _decoded(FIXTURES / "gradient_accent.png")
    loose = measure_image_stats(image, accent_min_chroma=10.0, merge_delta_e=30.0)
    assert loose != measure_image_stats(image)
    assert loose["width"] == 96 and loose["height"] == 64
