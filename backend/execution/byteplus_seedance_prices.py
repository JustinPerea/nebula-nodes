"""Seedance on BytePlus ModelArk: model ids, output sizes and token prices.

Stdlib only, so scripts/sync-krea-catalog.py can load it by path to write
the Krea copies' BytePlus prices, and execution/maker_routes_byteplus_seedance.py
(the translations and handlers) and the fal copies' entries in
data/model_pricing.json use the same numbers (tests/test_byteplus_seedance.py
recomputes every priced row from here).
"""
from __future__ import annotations

# ModelArk model ids (model-list, video-generation-tutorial "Model ID" row,
# 2026-10-14). seedance-1-5-pro-251215 is marked "Retiring" with "Recommended
# replacement: dreamina-seedance-2-0-mini-260615"; BytePlus publishes no date,
# so there is no DIRECT_RETIRES entry for it.
SEEDANCE_2_5 = "dreamina-seedance-2-5-260628"
SEEDANCE_2_0 = "dreamina-seedance-2-0-260128"
SEEDANCE_2_0_FAST = "dreamina-seedance-2-0-fast-260128"
SEEDANCE_2_0_MINI = "dreamina-seedance-2-0-mini-260615"
SEEDANCE_1_5_PRO = "seedance-1-5-pro-251215"
SEEDANCE_1_0_PRO = "seedance-1-0-pro-250528"
SEEDANCE_1_0_PRO_FAST = "seedance-1-0-pro-fast-251015"

RATIOS = ("16:9", "4:3", "1:1", "3:4", "9:16", "21:9")
DURATIONS: dict[str, tuple[int, int]] = {
    SEEDANCE_2_5: (4, 30), SEEDANCE_2_0: (4, 15), SEEDANCE_2_0_FAST: (4, 15), SEEDANCE_2_0_MINI: (4, 15),
    SEEDANCE_1_5_PRO: (4, 12), SEEDANCE_1_0_PRO: (2, 12), SEEDANCE_1_0_PRO_FAST: (2, 12),
}
# -- prices ------------------------------------------------------------------
# docs.byteplus.com/en/docs/ModelArk/model-pricing, "Video generation models",
# read 2026-10-14. Online inference, USD per million tokens; 2.x prices are
# for "Input without video" (a run with a reference video bills a different
# rate plus a minimum and is left unpriced).
PRICING_URL = "https://docs.byteplus.com/en/docs/ModelArk/model-pricing"
CHECKED = "2026-10-14"
RATES: dict[str, dict[str, float]] = {
    SEEDANCE_2_5: {"480p": 10.70, "720p": 10.70, "1080p": 11.7},
    SEEDANCE_2_0: {"480p": 7.0, "720p": 7.0, "1080p": 7.7, "4k": 4.0},
    SEEDANCE_2_0_FAST: {"480p": 5.6, "720p": 5.6},
    SEEDANCE_2_0_MINI: {"480p": 3.5, "720p": 3.5},
    SEEDANCE_1_0_PRO: {"480p": 2.5, "720p": 2.5, "1080p": 2.5},
    SEEDANCE_1_0_PRO_FAST: {"480p": 1.0, "720p": 1.0, "1080p": 1.0},
}
RATES_1_5_PRO = {True: 2.4, False: 1.2}  # with audio / silent
RATE_QUOTES: dict[str, str] = {
    SEEDANCE_2_5: "dreamina-seedance-2-5-260628 | For 480p and 720p outputs: Input without video: 10.70 | For "
                  "1080p outputs: Input without video: 11.7",
    SEEDANCE_2_0: "dreamina-seedance-2-0-260128 | For 480p and 720p outputs: Input without video: 7.0 | For "
                  "1080p outputs: Input without video: 7.7 | For 4K outputs: Input without video: 4.0",
    SEEDANCE_2_0_FAST: "dreamina-seedance-2-0-fast-260128 | For 480p and 720p outputs: Input without video: 5.6",
    SEEDANCE_2_0_MINI: "dreamina-seedance-2-0-mini-260615 | For 480p and 720p outputs: Input without video: 3.5",
    SEEDANCE_1_5_PRO: "seedance-1-5-pro-251215 | Video with audio: 2.4 | Video without audio: 1.2",
    SEEDANCE_1_0_PRO: "seedance-1-0-pro-250528 | 2.5",
    SEEDANCE_1_0_PRO_FAST: "seedance-1-0-pro-fast-251015 | 1",
}
TOKEN_FORMULA_QUOTE = ("Estimated token consumption = (Input video duration + Output video duration) x Output "
                       "video width x Output video height x Output video frame rate / 1024")
FPS = 24  # every Seedance model: "Frame rate: 24 fps" (video-generation-tutorial)

# Output width x height by resolution and ratio (create-video-generation-task-api,
# "Width and height pixel values corresponding to different aspect ratios").
SIZES_URL = "https://docs.byteplus.com/en/docs/ModelArk/create-video-generation-task-api"
SIZES_QUOTE = ("Width and height pixel values corresponding to different aspect ratios: 720p | 16:9 | 1280x720 "
               "(Dreamina Seedance 2.5, 2.0 series, 1.5 pro) | 1248x704 (Seedance 1.0 series)")
_SIZES_2_5 = {
    "480p": {"16:9": (854, 480), "4:3": (752, 560), "1:1": (640, 640), "3:4": (560, 752), "9:16": (480, 854),
             "21:9": (992, 432)},
    "720p": {"16:9": (1280, 720), "4:3": (1112, 834), "1:1": (960, 960), "3:4": (834, 1112),
             "9:16": (720, 1280), "21:9": (1470, 630)},
    "1080p": {"16:9": (1920, 1080), "4:3": (1664, 1248), "1:1": (1440, 1440), "3:4": (1248, 1664),
              "9:16": (1080, 1920), "21:9": (2206, 946)},
}
_SIZES_2_0 = {  # the 2.0 series and 1.5 pro
    "480p": {"16:9": (864, 496), "4:3": (752, 560), "1:1": (640, 640), "3:4": (560, 752), "9:16": (496, 864),
             "21:9": (992, 432)},
    "720p": _SIZES_2_5["720p"],
    "1080p": _SIZES_2_5["1080p"],
    "4k": {"16:9": (3840, 2160), "4:3": (3326, 2494), "1:1": (2880, 2880), "3:4": (2494, 3326),
           "9:16": (2160, 3840), "21:9": (4398, 1886)},
}
_SIZES_1_0 = {
    "480p": {"16:9": (864, 480), "4:3": (736, 544), "1:1": (640, 640), "3:4": (544, 736), "9:16": (480, 864),
             "21:9": (960, 416)},
    "720p": {"16:9": (1248, 704), "4:3": (1120, 832), "1:1": (960, 960), "3:4": (832, 1120),
             "9:16": (704, 1248), "21:9": (1504, 640)},
    "1080p": {"16:9": (1920, 1088), "4:3": (1664, 1248), "1:1": (1440, 1440), "3:4": (1248, 1664),
              "9:16": (1088, 1920), "21:9": (2176, 928)},
}


def output_sizes(model: str, resolution: str) -> dict[str, tuple[int, int]]:
    table = _SIZES_2_5 if model == SEEDANCE_2_5 else _SIZES_1_0 if model in (
        SEEDANCE_1_0_PRO, SEEDANCE_1_0_PRO_FAST) else _SIZES_2_0
    return table[resolution]


def rate(model: str, resolution: str, audio: bool = True) -> float:
    return RATES_1_5_PRO[bool(audio)] if model == SEEDANCE_1_5_PRO else RATES[model][resolution]


def per_second(model: str, resolution: str, ratio: str | None = None, audio: bool = True) -> tuple[float, float]:
    """USD per output second, from BytePlus's token formula (no input video):
    width x height x 24 / 1024 tokens a second, at the model's rate. With no
    ratio (adaptive) it's the range over every documented ratio's size."""
    sizes = output_sizes(model, resolution)
    pixels = [w * h for key, (w, h) in sizes.items() if ratio in (None, key)]
    unit = FPS / 1024 * rate(model, resolution, audio) / 1e6
    return min(pixels) * unit, max(pixels) * unit


def video_price(model: str, resolution: str, duration: str, ratio: str | None = None,
                audio: bool = True) -> float | list[float]:
    """One video's price for a fal duration choice ("auto" -> the model's whole range)."""
    low, high = per_second(model, resolution, ratio, audio)
    shortest, longest = DURATIONS[model]
    first, last = (shortest, longest) if duration == "auto" else (int(duration), int(duration))
    bounds = [round(low * first, 6), round(high * last, 6)]
    return bounds[0] if bounds[0] == bounds[1] else bounds
