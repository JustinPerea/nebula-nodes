"""Runway list prices in model_pricing.json (https://docs.dev.runwayml.com/guides/pricing.md, read 2026-10-14)."""
from __future__ import annotations

import json
from pathlib import Path

from services import model_pricing

DEFS = json.loads((Path(__file__).resolve().parents[2] / "backend" / "data" / "node_definitions.json").read_text())


def _price(node_id: str, params: dict) -> tuple[float, float] | None:
    entry = model_pricing.load_pricing()["nodes"][node_id]
    result = model_pricing.estimate_node(entry, DEFS[node_id], params, "runway")
    return None if result is None else (round(result["low"], 4), round(result["high"], 4))


def test_runway_video_prices_by_model_tier_audio_and_duration():
    assert _price("runway-video", {}) == (0.6, 0.6)  # gen4.5, 5 s at 12 credits/s
    assert _price("runway-video", {"model": "veo3.1", "duration": 8}) == (3.2, 3.2)
    assert _price("runway-video", {"model": "veo3.1", "duration": 8, "audio": False}) == (1.6, 1.6)
    assert _price("runway-video", {"model": "seedance2", "duration": 10, "ratio": "3840:2160"}) == (15.0, 15.0)
    assert _price("runway-video", {"model": "seedance2_5", "duration": 4, "ratio": "854:480"}) == (0.8, 0.8)
    assert _price("runway-video", {"model": "seedance2_5", "duration": 10, "ratio": "1920:1080"}) == (6.8, 6.8)
    assert _price("runway-video", {"model": "seedance2_mini", "duration": 4}) == (0.64, 0.64)
    assert _price("runway-video", {"model": "happyhorse_1_0", "duration": 10}) == (1.5, 1.5)
    assert _price("runway-video", {"model": "happyhorse_1_0", "duration": 10, "resolution": "1080p"}) == (1.5, 3.0)
    assert _price("runway-video", {"model": "seedance2", "duration": "auto"}) is None


def test_runway_image_prices_by_model_and_tier():
    assert _price("runway-image", {}) == (0.05, 0.08)  # gen4_image at 1360:768: tier not stated
    assert _price("runway-image", {"ratio": "1920:1080"}) == (0.08, 0.08)
    assert _price("runway-image", {"model": "gpt_image_2", "ratio": "auto"}) == (0.41, 0.41)
    assert _price("runway-image", {"model": "gemini_image3_pro", "ratio": "4096:4096"}) == (0.4, 0.4)
    assert _price("runway-image", {"model": "seedream5_pro", "ratio": "1024:1024"}) == (0.05, 0.05)
    assert _price("runway-image", {"model": "seedream5_pro", "ratio": "auto_2k"}) == (0.09, 0.09)
    assert _price("runway-image", {"model": "seedream5_lite", "ratio": "2048:2048"}) == (0.04, 0.04)
