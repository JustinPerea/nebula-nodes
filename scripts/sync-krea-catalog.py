#!/usr/bin/env python3
"""Generate Nebula's explicit Krea generation nodes from a pinned API catalog.

Covers image, video, audio, enhance (upscale) and 3D routes.

Default and --check are offline. --refresh fetches Krea's official public
OpenAPI (or --openapi reads a previously fetched copy); no token or job is used.

Also writes the Krea entries of backend/data/model_pricing.json from each
operation's `x-krea-pricing` block. These are API-token (USD) prices; Krea
account runs bill workspace compute units, which Krea doesn't publish per
option, so they stay unpriced. A model whose price dimensions don't map onto
its request fields is left unpriced and listed, never guessed.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "backend/data/krea_gateway_models.json"
REGISTRY = ROOT / "backend/data/node_definitions.json"
PRICING = ROOT / "backend/data/model_pricing.json"
PRICING_GENERATOR = "scripts/sync-krea-catalog.py"
FRONTEND = ROOT / "frontend/src/constants/nodeDefinitions.ts"
SOURCE_URL = "https://api.krea.ai/openapi.json"
DOC_URL = "docs/model-providers/krea/krea-gateway.md"
# Route family -> output media type. Enhance outputs whatever it was given:
# routes with a video_url input upscale video, the rest upscale images.
MEDIA_ROUTES = {"/generate/image/": "Image", "/generate/video/": "Video",
                "/generate/audio/": "Audio", "/generate/enhance/": "Enhance",
                "/generate/3d/": "Mesh"}
CATEGORIES = {"Image": "image-gen", "Video": "video-gen", "Audio": "audio-gen",
              "Mesh": "3d-gen"}
PLURALS = {"Image": "images", "Video": "videos", "Audio": "audios", "Mesh": "meshes"}
# Price rows that only hold when a request field is left empty. Kling 3.0
# takes multi_prompt (shots, each with its own duration), and Kling's API
# reference says "sum of all shot durations must equal the total video
# duration"; Krea's price list keys on the duration field and doesn't say how
# a multi-shot run is billed (NOT VERIFIED). So a multi-shot run is unpriced.
# A multi_prompt that arrives by wire is caught by the wired-port rule
# (backend services/model_pricing.py).
PRICE_GUARDS = {
    "/generate/video/kling/kling-3.0": {
        "match": {"multi_prompt": ""},
        "note": "Multi-prompt runs are unpriced: Krea's price list keys on the duration field and doesn't say "
                "how shot durations are billed.",
        "source": {"url": "https://kling.ai/document-api/apiReference/model/textToVideo",
                   "quote": "sum of all shot durations must equal the total video duration"},
    },
}
# Request fields a model takes that Krea's price list leaves out, said
# outright so an audit doesn't flag them again: Krea does price audio where it
# charges for it (Veo 3, Kling 3.0 list generateAudio as a dimension).
UNPRICED_FIELD_NOTES = {
    "generate_audio": "Krea's price doesn't vary with generate_audio (x-krea-pricing dimensions: {dims}).",
}


# Krea copies that can also run on the model maker's own API with the
# person's key (backend execution/maker_routes.py, services/node_route.py).
# Keyed by Krea endpoint. Each generated node then gets envKeyName [maker key,
# KREA_API_TOKEN], directKeyName, and its params split by route: `params`
# keeps the full Krea request list (so every `_kreaAuth` reader still finds the
# billing choice there), sharedParams are what both routes read, falParams
# the Krea-only fields the maker has no equivalent for (`kreaOnly`), and
# directParams the maker-only extras. `directRoute` names the backend
# translation and the maker's model id, plus `blockedBy` (`directBlockedBy`):
# Krea-only fields that keep a run on Krea when set, since the maker can't
# honor them (an explicit width/height would otherwise silently become
# Google's default shape). `pricing` is the maker route's
# model_pricing.json entry, in the node's own param names; the Krea route's
# entry is generated from x-krea-pricing as for every other model.
#
# Route precedence (the same in pricing, readiness, the engine and the
# router): _kreaAuth "mcp" bills the Krea plan; else the maker key; else
# KREA_API_TOKEN.
GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing"
GOOGLE_CHECKED = "2026-10-14"
# Reference images cost input tokens on every call. Google: "Up to 14
# reference images" (https://ai.google.dev/gemini-api/docs/image-generation),
# so a Google-route price is a range: the output image alone, up to the output
# plus 14 references. Per-image input cost, by model:
# - gemini-3-pro-image: "Image input is set at 560 tokens or $0.0011 per image"
#   (pricing page).
# - gemini-3.1-flash-image / -flash-lite-image: Gemini 3's default image media
#   resolution, 1120 tokens (docs/media-resolution), at $0.50 / $0.25 per 1M.
# - gemini-2.5-flash-image: 258 tokens per 768x768 tile (docs/image-
#   understanding); up to 8 tiles for an image up to 21:9, at $0.30 per 1M.
MAX_REFERENCE_IMAGES = 14
REFERENCE_IMAGE_COST = {
    "gemini-3-pro-image": (0.0011, "$0.0011 per reference image"),
    "gemini-3.1-flash-image": (1120 * 0.50 / 1e6, "1,120 tokens per reference image at $0.50 per 1M"),
    "gemini-3.1-flash-lite-image": (1120 * 0.25 / 1e6, "1,120 tokens per reference image at $0.25 per 1M"),
    # gemini-nano-banana-2.1 is a Gemini 3 image model ("An update to Nano
    # Banana 2 (Gemini 3.1 Flash Image)"), read at the same 1,120 tokens.
    "gemini-nano-banana-2.1": (1120 * 1.50 / 1e6, "1,120 tokens per reference image at $1.50 per 1M"),
    "gemini-2.5-flash-image": (8 * 258 * 0.30 / 1e6,
                               "up to 8 tiles of 258 tokens per reference image (up to 21:9) at $0.30 per 1M"),
}
_GOOGLE_NOTE = ("Gemini API standard (paid tier) price, for runs on the person's GOOGLE_API_KEY (model {model}). "
                "The low end is the output image; the high end adds up to {refs} reference images "
                "(Google's limit) at {ref_cost}. Prompt text input isn't counted (well under $0.01 for a normal "
                "prompt). Ignores Batch/Flex/Priority rates.")
_GOOGLE_INPUT_SOURCES = {
    "gemini-3-pro-image": {"url": GOOGLE_PRICING_URL,
                           "quote": "Image input is set at 560 tokens or $0.0011 per image."},
    "gemini-3.1-flash-image": {"url": "https://ai.google.dev/gemini-api/docs/media-resolution",
                               "quote": "`unspecified` (Default) | 1120 | ... (Gemini 3 models, Image)"},
    "gemini-3.1-flash-lite-image": {"url": "https://ai.google.dev/gemini-api/docs/media-resolution",
                                    "quote": "`unspecified` (Default) | 1120 | ... (Gemini 3 models, Image)"},
    "gemini-nano-banana-2.1": {"url": "https://ai.google.dev/gemini-api/docs/media-resolution",
                               "quote": "`unspecified` (Default) | 1120 | ... (Gemini 3 models, Image)"},
    "gemini-2.5-flash-image": {"url": "https://ai.google.dev/gemini-api/docs/image-understanding",
                               "quote": "Larger images are tiled into 768x768 pixel tiles, each costing 258 tokens."},
}
_REFERENCE_LIMIT_SOURCE = {"url": "https://ai.google.dev/gemini-api/docs/image-generation",
                           "quote": "Up to 14 reference images: Mix up to 14 reference images to produce the final image."}


def with_references(price, model):
    """[output price, output price + the most reference images Google takes]."""
    import math

    per_image = REFERENCE_IMAGE_COST[model][0]
    return [price, math.ceil((price + MAX_REFERENCE_IMAGES * per_image) * 1e5) / 1e5]


# Krea's Ideogram and Runway copies on the makers' own APIs
# (execution/maker_routes_ideogram_runway.py). Prices from each maker's own
# page, read 2026-10-14. Not routed: ideogram-4.5 (Ideogram doesn't publish the
# 4.5 text-to-image size presets Krea's aspect_ratio would need) and
# runway/gen-4-video (Krea doesn't name its upstream Runway model).
IDEOGRAM_PRICING_URL = "https://ideogram.ai/pricing/?pricing_tab=api"
RUNWAY_PRICING_URL = "https://docs.dev.runwayml.com/guides/pricing.md"
MAKER_CHECKED = "2026-10-14"
_RUNWAY_CREDIT = {"url": RUNWAY_PRICING_URL, "quote": "Credits can be purchased for $0.01 per credit"}
IDEOGRAM_RUNWAY_DIRECT_ROUTES = {
    "/generate/image/ideogram/ideogram-4.5-precise": {
        "directKeyName": "IDEOGRAM_API_KEY", "translation": "krea-ideogram-precise-edit", "model": "ideogram-4-5",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "ideogram", "per": "image", "priceParams": ["quality"],
                    "rows": [{"match": {"quality": "very_low"}, "price": 0.008},
                             {"match": {"quality": "low"}, "price": 0.03},
                             {"match": {"quality": "medium"}, "price": 0.06},
                             {"match": {"quality": "high"}, "price": 0.22}],
                    "notes": "Ideogram API price for runs on the person's IDEOGRAM_API_KEY "
                             "(POST /v2/image/precise-edit/ideogram-4-5, one image per run). Same at 1K and 2K.",
                    "sources": [{"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 4.5 Precise Edit Very Low 1K — US $0.008"},
                                {"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 4.5 Precise Edit Low 2K — US $0.03"},
                                {"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 4.5 Precise Edit Medium 2K — US $0.06"},
                                {"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 4.5 Precise Edit High 2K — US $0.22"}],
                    "checked": MAKER_CHECKED},
    },
    "/generate/image/ideogram/ideogram-3": {
        # Krea's style_images carry a per-image `strength` Ideogram's API has
        # no field for, so a recipe that sets them stays on Krea.
        "directKeyName": "IDEOGRAM_API_KEY", "translation": "krea-ideogram-3", "model": "ideogram-v3",
        "kreaOnly": ["style_images"], "directBlockedBy": ["style_images"], "directParams": [],
        "pricing": {"provider": "ideogram", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": [0.06, 0.15]}],
                    "notes": "Ideogram API price for runs on the person's IDEOGRAM_API_KEY "
                             "(POST /v1/ideogram-v3/generate at rendering_speed DEFAULT, one image per run). "
                             "The low end is a run without a character reference, the high end one with it "
                             "(a wired reference is only known at run time).",
                    "sources": [{"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 3.0 Default — US $0.06"},
                                {"url": IDEOGRAM_PRICING_URL,
                                 "quote": "Ideogram 3.0 Default with Character Reference — US $0.15"}],
                    "checked": MAKER_CHECKED},
    },
    "/generate/image/ideogram/ideogram-2-turbo": {
        # Krea's own docs call this model "Ideogram 2.0A Turbo", and Krea's
        # $0.025 matches Ideogram's 2a Turbo price ($0.05 is 2.0 Turbo).
        "directKeyName": "IDEOGRAM_API_KEY", "translation": "krea-ideogram-2a", "model": "ideogram-2a",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "ideogram", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": 0.025}],
                    "notes": "Ideogram API price for runs on the person's IDEOGRAM_API_KEY "
                             "(POST /v2/image/generate/ideogram-2a, rendering_speed turbo, one image per run).",
                    "sources": [{"url": IDEOGRAM_PRICING_URL, "quote": "Ideogram 2a Turbo — US $0.025"}],
                    "checked": MAKER_CHECKED},
    },
    "/generate/image/runway/gen-4-image": {
        "directKeyName": "RUNWAY_API_KEY", "translation": "krea-runway-gen4-image", "model": "gen4_image",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "runway", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": [0.05, 0.08]}],
                    "notes": "Runway API price for runs on the person's RUNWAY_API_KEY (gen4_image on "
                             "POST /v1/text_to_image). width/height snap to the nearest gen4_image ratio; Runway "
                             "names only 720p and 1080p tiers, so the price is the range between them.",
                    "sources": [{"url": RUNWAY_PRICING_URL,
                                 "quote": "`gen4_image` | 5 credits per 720p image, or 8 credits per 1080p image"},
                                _RUNWAY_CREDIT],
                    "checked": MAKER_CHECKED},
    },
    "/generate/video/runway/gen-4.5": {
        "directKeyName": "RUNWAY_API_KEY", "translation": "krea-runway-gen4-5", "model": "gen4.5",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "runway", "per": "request", "priceParams": ["duration"],
                    # Runway bills whole seconds; a fractional duration is
                    # rounded before the run, so only whole seconds are priced.
                    "rows": [{"match": {"duration": seconds}, "price": round(0.12 * seconds, 2)}
                             for seconds in range(2, 11)],
                    "notes": "Runway API price for runs on the person's RUNWAY_API_KEY (gen4.5 on "
                             "POST /v1/image_to_video or /v1/text_to_video): 12 credits per second at $0.01 each. "
                             "A fractional duration is rounded to whole seconds before the run and stays unpriced.",
                    "sources": [{"url": RUNWAY_PRICING_URL, "quote": "`gen4.5` | 12 credits per second"},
                                _RUNWAY_CREDIT],
                    "checked": MAKER_CHECKED},
    },
    "/generate/enhance/runway/ruby": {
        # Unpriced on Runway too: "ruby | 20 credits per second; 40 credits
        # per second when the source is larger than 4 megapixels", and both
        # the length and the size of the source are only known at run time.
        "directKeyName": "RUNWAY_API_KEY", "translation": "krea-runway-ruby", "model": "ruby",
        "kreaOnly": [], "directParams": [], "pricing": None,
    },
}


DIRECT_ROUTES = {
    "/generate/image/google/nano-banana-2": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-3.1-flash-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "1K"}, "price": 0.067},
                             {"match": {"resolution": "2K"}, "price": 0.101},
                             {"match": {"resolution": "4K"}, "price": 0.151}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$60.00 (images) Equivalent to $0.045 per 0.5K image* $0.067 per 1K "
                                          "image*, $0.101 per 2K image*, and $0.151 per 4K image*."},
                                {"url": GOOGLE_PRICING_URL, "quote": "Input price | Not available | $0.50 (text/image)"}]},
    },
    "/generate/image/google/nano-banana-pro": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-3-pro-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "1K"}, "price": 0.134},
                             {"match": {"resolution": "2K"}, "price": 0.134},
                             {"match": {"resolution": "4K"}, "price": 0.24}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$120.00 (images) Equivalent to $0.134 per 1K/2K image** and $0.24 per "
                                          "4K image**"}]},
    },
    "/generate/image/google/nano-banana-flash-lite": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana",
        "model": "gemini-3.1-flash-lite-image", "kreaOnly": ["width", "height"],
        "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": 0.0336}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$30.00 (images) Equivalent to $0.0336 per 1K resolution image*"},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Input price | Not available | $0.25 (text/image/video)"}]},
    },
    "/generate/image/google/nano-banana": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana", "model": "gemini-2.5-flash-image",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": 0.039}],
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "Output images up to 1024x1024px consume 1290 tokens and are equivalent "
                                          "to $0.039 per image."},
                                {"url": GOOGLE_PRICING_URL, "quote": "Input price | Not available | $0.30 (text / image)"}]},
    },
    "/generate/image/openai/gpt-image-2": {
        # Krea's width/height are free numbers; OpenAI takes WIDTHxHEIGHT only
        # within its size rules, so a recipe that sets either stays on Krea.
        # aspect_ratio + resolution map to an exact OpenAI size (backend
        # execution/maker_routes_openai.py KREA_OPENAI_SIZES). Unpriced (see below).
        "directKeyName": "OPENAI_API_KEY", "translation": "krea-openai-image", "model": "gpt-image-2",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": None,
    },
    "/generate/image/openai/gpt-image-2.5-flare": {
        "directKeyName": "OPENAI_API_KEY", "translation": "krea-openai-image", "model": "gpt-image-2.5-flare",
        "kreaOnly": [], "directParams": [], "pricing": None,
    },
    "/generate/image/openai/gpt-image-2.5-sunburst": {
        "directKeyName": "OPENAI_API_KEY", "translation": "krea-openai-image", "model": "gpt-image-2.5-sunburst",
        "kreaOnly": [], "directParams": [], "pricing": None,
    },
    **IDEOGRAM_RUNWAY_DIRECT_ROUTES,
}

# The Krea OpenAI copies' OpenAI route is unpriced. OpenAI tabulates GPT
# Image 2 per image only at 1024x1024, 1024x1536 and 1536x1024 (image
# generation guide, "Calculating costs", checked 2026-10-14), and a new Krea
# GPT Image 2 node sets no aspect_ratio or resolution, so OpenAI picks the
# size ('auto') and the default can't be priced; every other size is only in
# OpenAI's calculator. GPT Image 2.5 has no per-image figure at all ("The GPT
# Image 2 calculator does not estimate GPT Image 2.5 token consumption", model
# pages).


# -- Google lane (2026-10-14): Nano Banana 2.1, Veo 3.1 on Vertex, Gemini Omni Flash 1.1 ---------
# Translations live in backend/execution/maker_routes_google.py. Every price
# below was read on the maker's own page on 2026-10-14 (quotes in `sources`).
VERTEX_PRICING_URL = "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
VERTEX_VEO_MODEL_URL = "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate"
_VERTEX_VEO_NOTE = ("Vertex AI (Gemini Enterprise Agent Platform) list price for runs on the person's "
                    "GOOGLE_VERTEX_CREDENTIALS (model {model}), per second of the node's duration. Vertex lists "
                    "Veo per \"count\" without saying what a count is; it is read as per second, the higher "
                    "reading and the Gemini API's unit for the same amounts. {audio}")
_VEO_STANDARD_SOURCES = [
    {"url": VERTEX_PRICING_URL, "quote": "Veo 3.1 Video + Audio generation ... 720p, 1080p $0.40 / 1 count 4k $0.60 / 1 count"},
    {"url": VERTEX_PRICING_URL, "quote": "Video generation ... Video 720p, 1080p $0.20 / 1 count 4k $0.40 / 1 count"},
    {"url": GOOGLE_PRICING_URL, "quote": "Veo 3.1 Standard video with audio price (default) | Not available | "
                                         "$0.40 (720p and 1080p) $0.60 (4k)"},
]
_VEO_FAST_SOURCES = [
    {"url": VERTEX_PRICING_URL, "quote": "Veo 3.1 Fast Video + Audio generation ... 720p $0.10 / 1 count 1080p "
                                         "$0.12 / 1 count 4k $0.30 / 1 count"},
    {"url": VERTEX_PRICING_URL, "quote": "Video generation ... Video 720p $0.08 / 1 count 1080p $0.10 / 1 count "
                                         "4k $0.25 / 1 count"},
    {"url": VERTEX_VEO_MODEL_URL, "quote": "veo-3.1-fast-generate-001 ... Supported output resolutions: 720p, 1080p"},
]
_VEO_LITE_SOURCES = [
    {"url": VERTEX_PRICING_URL, "quote": "Veo 3.1 Lite ... Video generation ... Video 720p $0.03 / 1 count 1080p "
                                         "$0.05 / 1 count"},
    {"url": VERTEX_VEO_MODEL_URL, "quote": "veo-3.1-lite-generate-001 - Launch stage: Preview"},
]


def _veo_rows(prices):
    """{(resolution, generate_audio): price} -> rows, audio-on first."""
    return [{"match": {"resolution": resolution, "generate_audio": audio}, "price": price}
            for (resolution, audio), price in prices.items()]


GOOGLE_LANE_ROUTES = {
    "/generate/image/google/nano-banana-2.1": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-nano-banana-2-1", "model": "gemini-nano-banana-2.1",
        "kreaOnly": ["width", "height"], "directBlockedBy": ["width", "height"], "directParams": [],
        "pricing": {"provider": "google", "per": "image", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "1K"}, "price": 0.0336},
                             {"match": {"resolution": "2K"}, "price": 0.0504},
                             {"match": {"resolution": "4K"}, "price": 0.113}],
                    "plus": "thinking tokens",
                    "noteExtra": " Thinking tokens bill extra at $7.50 per 1M (Google: \"thinking tokens are billed by "
                                 "default for thinking models\"; 2.1 defaults to medium) and can't be counted ahead, "
                                 "so the estimate is open-ended.",
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "$30.00 (images) Equivalent to $0.0336 per 1K image*, $0.0504 per 2K image*, "
                                          "and $0.113 per 4K image*."},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Input price | Not available | $1.50 (text/image/video)"},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Output price | Not available | $7.50 (text and thinking)"}]},
    },
    "/generate/video/google/veo-3.1": {
        "directKeyName": "GOOGLE_VERTEX_CREDENTIALS", "translation": "krea-veo-vertex", "model": "veo-3.1-generate-001",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "google", "per": "second", "priceParams": ["resolution", "generate_audio"],
                    "rows": _veo_rows({("720p", True): 0.40, ("1080p", True): 0.40, ("4K", True): 0.60,
                                       ("720p", False): 0.20, ("1080p", False): 0.20, ("4K", False): 0.40}),
                    "multiplyBy": ["duration"],
                    "notes": _VERTEX_VEO_NOTE.format(model="veo-3.1-generate-001",
                                                     audio="generate_audio picks the Video + Audio or Video row."),
                    "sources": _VEO_STANDARD_SOURCES},
    },
    "/generate/video/google/veo-3.1-fast": {
        # Vertex's model card lists Fast at 720p and 1080p only (its pricing
        # page still lists a 4k price), so a 4K run stays on Krea.
        "directKeyName": "GOOGLE_VERTEX_CREDENTIALS", "translation": "krea-veo-vertex",
        "model": "veo-3.1-fast-generate-001", "kreaOnly": [], "directParams": [],
        "directBlockedWhen": {"resolution": ["4K"]},
        "pricing": {"provider": "google", "per": "second", "priceParams": ["resolution", "generate_audio"],
                    "rows": _veo_rows({("720p", True): 0.10, ("1080p", True): 0.12,
                                       ("720p", False): 0.08, ("1080p", False): 0.10}),
                    "multiplyBy": ["duration"],
                    "notes": _VERTEX_VEO_NOTE.format(
                        model="veo-3.1-fast-generate-001",
                        audio="generate_audio picks the Video + Audio or Video row. 4K runs stay on Krea."),
                    "sources": _VEO_FAST_SOURCES},
    },
    "/generate/video/google/veo-3.1-lite": {
        # Krea's Lite takes no generate_audio and prices it at Google's
        # video-only rate, so the Vertex run sends generateAudio false.
        "directKeyName": "GOOGLE_VERTEX_CREDENTIALS", "translation": "krea-veo-vertex",
        "model": "veo-3.1-lite-generate-001", "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "google", "per": "second", "priceParams": ["resolution"],
                    "rows": [{"match": {"resolution": "720p"}, "price": 0.03},
                             {"match": {"resolution": "1080p"}, "price": 0.05}],
                    "multiplyBy": ["duration"],
                    "notes": _VERTEX_VEO_NOTE.format(
                        model="veo-3.1-lite-generate-001",
                        audio="Sent with generateAudio false (the node has no audio choice), so the Video row."),
                    "sources": _VEO_LITE_SOURCES},
    },
    "/generate/video/google/gemini-omni-flash-1.1": {
        "directKeyName": "GOOGLE_API_KEY", "translation": "krea-gemini-omni", "model": "gemini-omni-1.1-flash",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "google", "per": "second", "priceParams": [],
                    # 5,792 output tokens per second of 720p video x $17.50 per 1M.
                    "rows": [{"match": {}, "price": 0.10136}],
                    "multiplyBy": ["duration"],
                    "plus": "input media and thinking tokens",
                    "notes": "Gemini API standard (paid tier) price for runs on the person's GOOGLE_API_KEY (model "
                             "gemini-omni-1.1-flash): 5,792 output tokens per second of 720p video (the resolution "
                             "the run uses) at $17.50 per 1M, times the node's duration. Input media (start image, "
                             "reference images and videos) at $1.50 per 1M and thinking tokens at $9.00 per 1M bill "
                             "extra; Google doesn't publish their token counts for Omni, so they aren't counted.",
                    "sources": [{"url": GOOGLE_PRICING_URL,
                                 "quote": "Output price (including thinking tokens) | Not available | $9.00 (text) "
                                          "$17.50 (video)*"},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Billing is based on total output token consumption, calculated at a rate "
                                          "of 5,792 tokens per second of 720p video."},
                                {"url": GOOGLE_PRICING_URL,
                                 "quote": "Input price | Not available | $1.50 (text / image / video / audio)"}]},
    },
}
DIRECT_ROUTES.update(GOOGLE_LANE_ROUTES)

# xAI (Grok Imagine) on the person's XAI_API_KEY (backend
# execution/maker_routes_xai.py). Prices are xAI's own Imagine API table on
# https://docs.x.ai/developers/pricing as the page renders it (checked
# 2026-10-14; the .md copy lists only each model's lowest rate). Each route
# entry is final here: no Google reference-image treatment.
XAI_PRICING_URL = "https://docs.x.ai/developers/pricing"
XAI_CHECKED = "2026-10-14"
_XAI_IMAGE_2_QUOTE = ("grok-imagine-image-2.0 | Text, Image -> Image | $0.01 / img (media input) | 1K Low $0.04 / img | "
                      "1.5K Low $0.05 / img | 2K Low $0.06 / img | 1K Medium $0.06 / img | 1.5K Medium $0.07 / img | "
                      "2K Medium $0.08 / img")
_XAI_IMAGE_2_OUTPUT = {("low", "1K"): 0.04, ("low", "2K"): 0.06, ("medium", "1K"): 0.06, ("medium", "2K"): 0.08}
_XAI_IMAGE_2_INPUT = 0.01
_XAI_EDIT_SOURCE = {"url": "https://docs.x.ai/developers/model-capabilities/imagine",
                    "quote": "Image edits are billed for both the input image and the generated output image."}
_XAI_QUALITY_SOURCE = {"url": "https://docs.x.ai/developers/model-capabilities/images/generation",
                       "quote": "Images are billed at the quality they are served at"}


def _xai_video_rows(rates, input_high, guards):
    """Per-request rows for each whole-second duration Krea's node takes
    (1-15): rate x duration, up to that plus the most input images the route
    can send. A fractional duration matches no row (xAI takes whole seconds,
    and the direct route refuses it)."""
    return [{"match": {"resolution": resolution, "duration": seconds, **guards},
             "price": [round(rate * seconds, 4), round(rate * seconds + input_high, 4)]}
            for resolution, rate in rates.items() for seconds in range(1, 16)]


XAI_DIRECT_ROUTES = {
    "/generate/image/xai/grok-imagine-2": {
        "directKeyName": "XAI_API_KEY", "translation": "krea-xai-image", "model": "grok-imagine-image-2.0",
        "kreaOnly": ["style_images"], "directBlockedBy": ["style_images"], "directParams": [],
        "pricing": {"provider": "xai", "per": "request", "priceParams": ["quality", "resolution"],
                    "rows": [{"match": {"quality": quality, "resolution": resolution}, "price": price}
                             for (quality, resolution), price in _XAI_IMAGE_2_OUTPUT.items()],
                    # An unset resolution isn't sent, and xAI renders "`1k` (default when omitted)".
                    "defaults": {"resolution": "1K"},
                    "notes": "xAI list price for one grok-imagine-image-2.0 image on the person's XAI_API_KEY, by "
                             "quality and resolution (unset renders at xAI's default, 1k). Style images keep the "
                             "run on Krea (xAI has none).",
                    "sources": [{"url": XAI_PRICING_URL, "quote": _XAI_IMAGE_2_QUOTE}, _XAI_QUALITY_SOURCE,
                                {"url": "https://docs.x.ai/developers/model-capabilities/images/generation",
                                 "quote": "`1k` (default when omitted)"}],
                    "checked": XAI_CHECKED},
    },
    "/generate/image/xai/grok-imagine-2-edit": {
        "directKeyName": "XAI_API_KEY", "translation": "krea-xai-image", "model": "grok-imagine-image-2.0",
        "kreaOnly": [], "directParams": [],
        "pricing": {"provider": "xai", "per": "request", "priceParams": ["quality", "resolution"],
                    "rows": [{"match": {"quality": quality, "resolution": resolution},
                              "price": [round(price + _XAI_IMAGE_2_INPUT, 4), round(price + 3 * _XAI_IMAGE_2_INPUT, 4)]}
                             for (quality, resolution), price in _XAI_IMAGE_2_OUTPUT.items()],
                    "notes": "xAI list price for one grok-imagine-image-2.0 edit on the person's XAI_API_KEY: the "
                             "output image by quality and resolution, plus $0.01 per source image (1 to 3, this "
                             "node's limit).",
                    "sources": [{"url": XAI_PRICING_URL, "quote": _XAI_IMAGE_2_QUOTE}, _XAI_EDIT_SOURCE,
                                _XAI_QUALITY_SOURCE],
                    "checked": XAI_CHECKED},
    },
    "/generate/video/xai/grok-video": {
        # Krea's schema doesn't say what start_video does (it also appears on
        # 1.5 and Veo 2, neither of which xAI or Google extends), so it is
        # Krea-only rather than guessed onto xAI's /v1/videos/extensions.
        "directKeyName": "XAI_API_KEY", "translation": "krea-xai-video", "model": "grok-imagine-video",
        "kreaOnly": ["start_video"], "directBlockedBy": ["start_video"], "directParams": [],
        "pricing": {"provider": "xai", "per": "request", "priceParams": ["duration", "edit_video", "resolution"],
                    "rows": _xai_video_rows({"480p": 0.05, "720p": 0.07}, 7 * 0.002, {"edit_video": ""}),
                    "notes": "xAI list price for grok-imagine-video on the person's XAI_API_KEY: per second by "
                             "resolution, up to that plus $0.002 per input image (a start image, or up to 7 "
                             "reference images). An edit (edit_video) bills the source video at $0.01/sec and "
                             "returns a clip as long as the source, so it is unpriced. A start video keeps the "
                             "run on Krea.",
                    "sources": [{"url": XAI_PRICING_URL,
                                 "quote": "grok-imagine-video | Text, Image, Video -> Video | $0.01 / sec | $0.002 / "
                                          "img (media input) | 480p $0.05 / sec | 720p $0.07 / sec"}],
                    "checked": XAI_CHECKED},
    },
    "/generate/video/xai/grok-video-1.5": {
        "directKeyName": "XAI_API_KEY", "translation": "krea-xai-video", "model": "grok-imagine-video-1.5",
        "kreaOnly": ["start_video"], "directBlockedBy": ["start_video"], "directParams": [],
        "pricing": {"provider": "xai", "per": "request", "priceParams": ["duration", "resolution"],
                    "rows": _xai_video_rows({"480p": 0.08, "720p": 0.14, "1080p": 0.25}, 0.01, {}),
                    "notes": "xAI list price for grok-imagine-video-1.5 on the person's XAI_API_KEY: per second by "
                             "resolution, up to that plus $0.01 for a start image. A start video keeps the run on "
                             "Krea.",
                    "sources": [{"url": XAI_PRICING_URL,
                                 "quote": "grok-imagine-video-1.5 | Text, Image, Audio -> Video | $0.01 / img (media "
                                          "input) | 480p $0.08 / sec | 720p $0.14 / sec | 1080p $0.25 / sec"}],
                    "checked": XAI_CHECKED},
    },
}
DIRECT_ROUTES.update(XAI_DIRECT_ROUTES)


def direct_route_definition(endpoint, params):
    """The dual-route fields a Krea node with a maker route adds (DIRECT_ROUTES)."""
    route = DIRECT_ROUTES.get(endpoint)
    if not route:
        return {}
    keys = {param["key"] for param in params}
    unknown = sorted(set(route["kreaOnly"]) - keys)
    if unknown:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: kreaOnly names fields Krea doesn't take: {unknown}")
    blocked = route.get("directBlockedBy") or []
    if set(blocked) - set(route["kreaOnly"]):
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy must be kreaOnly fields")
    defaulted = sorted(param["key"] for param in params if param["key"] in blocked and param.get("default") is not None)
    if defaulted:
        # A default would block the maker route for every new node.
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy fields have defaults: {defaulted}")
    blocked_when = route.get("directBlockedWhen") or {}
    for key, values in blocked_when.items():
        param = next((p for p in params if p["key"] == key), None)
        if param is None or key in route["kreaOnly"]:
            raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedWhen names {key!r}, not a shared Krea field")
        if param.get("default") in values:
            # The default would block the maker route for every new node.
            raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedWhen blocks {key}'s default")
    clash = sorted(keys & {param["key"] for param in route["directParams"]})
    if clash:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directParams repeat Krea fields: {clash}")
    return {
        "envKeyName": [route["directKeyName"], "KREA_API_TOKEN"],
        "directKeyName": route["directKeyName"],
        "sharedParams": [param for param in params if param["key"] not in route["kreaOnly"]],
        "falParams": [param for param in params if param["key"] in route["kreaOnly"]],
        "directParams": list(route["directParams"]),
        "directRoute": {"translation": route["translation"], "model": route["model"],
                        **({"blockedBy": list(blocked)} if blocked else {}),
                        **({"blockedWhen": {k: list(v) for k, v in blocked_when.items()}} if blocked_when else {})},
    }


def direct_route_pricing(endpoint):
    route = DIRECT_ROUTES.get(endpoint)
    if not route or not route.get("pricing"):
        return None
    pricing = dict(route["pricing"])
    provider = pricing.pop("provider")
    if provider != "google":
        # Other makers' entries are complete as written (notes, sources, checked).
        return provider, {"currency": "usd", **pricing}
    model = route["model"]
    note_extra = pricing.pop("noteExtra", "")
    if model not in REFERENCE_IMAGE_COST:
        # Video routes carry their own notes and sources.
        return provider, {"currency": "usd", **pricing, "checked": GOOGLE_CHECKED}
    pricing["rows"] = [{**row, "price": with_references(row["price"], model)} for row in pricing["rows"]]
    pricing["sources"] = [*pricing["sources"], _GOOGLE_INPUT_SOURCES[model], _REFERENCE_LIMIT_SOURCE]
    note = _GOOGLE_NOTE.format(model=model, refs=MAX_REFERENCE_IMAGES, ref_cost=REFERENCE_IMAGE_COST[model][1]) + note_extra
    return provider, {"currency": "usd", **pricing, "notes": note, "checked": GOOGLE_CHECKED}


def route_family(endpoint):
    return endpoint[len("/generate/"):].split("/", 1)[0]


def category_for(endpoint, media_type):
    return "transform" if route_family(endpoint) == "enhance" else CATEGORIES[media_type]
BEGIN = "  // BEGIN GENERATED KREA CATALOG (scripts/sync-krea-catalog.py)"
END = "  // END GENERATED KREA CATALOG"


def compact_schema(value):
    if isinstance(value, list):
        return [compact_schema(item) for item in value]
    if isinstance(value, dict):
        return {key: compact_schema(item) for key, item in value.items()
                if key not in {"description", "examples", "example", "title"}}
    return value


def branches(schema):
    alternatives = schema.get("anyOf", schema.get("oneOf"))
    if alternatives:
        return [leaf for part in alternatives for leaf in branches(part)
                if leaf.get("type") != "null"]
    if isinstance(schema.get("type"), list):
        return [{**schema, "type": kind} for kind in schema["type"] if kind != "null"]
    return [schema] if schema.get("type") != "null" else []


def simple_schema(schema):
    parts = branches(schema)
    if len(parts) == 1:
        return {**parts[0], **{key: value for key, value in schema.items()
                              if key not in {"anyOf", "oneOf"}
                              and not (key == "type" and isinstance(value, list))}}
    if parts and all("const" in part for part in parts):
        return {**schema, "type": parts[0].get("type"),
                "enum": [part["const"] for part in parts]}
    return schema


def label(field):
    return field.replace("_", " ").capitalize().replace(" url", " URL")


def port_type(field, schema):
    simple = simple_schema(schema)
    if simple.get("type") == "array":
        simple = simple_schema(simple.get("items", {}))
    if field == "prompt":
        return "Text"
    if simple.get("type") == "string" and simple.get("format") == "uri":
        if "mask" in field:
            return "Mask"
        if "video" in field:
            return "Video"
        if "audio" in field:
            return "Audio"
        return "Image"
    return "Any" if simple.get("type") in ("object", "array") else None


def fields_for(schema):
    params, ports, json_params = [], [], []
    required = set(schema.get("required", []))
    for field, original in schema.get("properties", {}).items():
        simple = simple_schema(original)
        kind = simple.get("type")
        param = {"key": field, "label": label(field), "required": field in required}
        if "enum" in simple:
            param.update(type="enum", options=[{"label": str(item), "value": item}
                                               for item in simple["enum"]])
        elif kind == "boolean":
            param["type"] = "boolean"
        elif kind in ("number", "integer"):
            param["type"] = "integer" if kind == "integer" else "float"
            for source, target in (("minimum", "min"), ("maximum", "max")):
                if source in simple:
                    param[target] = simple[source]
            param["step"] = 1 if kind == "integer" else 0.01
        elif kind == "string":
            param["type"] = "textarea" if field == "prompt" else "string"
        else:
            param.update(type="textarea", label=label(field) + " (JSON)",
                         placeholder="JSON array or object matching this model")
            json_params.append(field)
        if "default" in simple and simple["default"] is not None:
            default = simple["default"]
            param["default"] = json.dumps(default, ensure_ascii=False) if field in json_params else default
        params.append(param)
        data_type = port_type(field, original)
        if data_type:
            port = {"id": field, "label": label(field), "dataType": data_type,
                    "required": False}
            if kind == "array":
                port["multiple"] = True
                if "maxItems" in simple:
                    port["maxConnections"] = simple["maxItems"]
            ports.append(port)
    return params, ports, json_params


def snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def refresh(raw, checked_on):
    api = json.loads(raw)
    models = {}
    for endpoint, operations in api["paths"].items():
        media_type = next((kind for prefix, kind in MEDIA_ROUTES.items()
                           if endpoint.startswith(prefix)), None)
        if media_type is None:
            continue
        operation = operations.get("post")
        if not operation or operation.get("deprecated"):
            continue
        schema = compact_schema(operation["requestBody"]["content"]["application/json"]["schema"])
        if media_type == "Enhance":
            media_type = "Video" if "video_url" in schema.get("properties", {}) else "Image"
        node_id = "krea-" + re.sub(r"[^a-z0-9]+", "-", endpoint[len("/generate/"):].lower()).strip("-")
        if node_id in models:
            raise ValueError(f"Krea ID collision: {node_id}")
        _, ports, json_params = fields_for(schema)
        models[node_id] = {"endpoint": endpoint, "displayName": operation["summary"],
                           "requestSchema": schema, "mediaType": media_type,
                           "inputPorts": ports, "jsonParams": json_params}
        pricing = operation.get("x-krea-pricing")
        if isinstance(pricing, dict):
            # Keep price points only when every dimension is a request field we
            # send; the rest can't be estimated before a run, so record why.
            fields = set(schema.get("properties", {}))
            unmapped = sorted({key for point in pricing.get("price_points") or []
                               for key in point.get("dimensions", {}) if snake(key) not in fields})
            if unmapped:
                models[node_id]["pricingUnmapped"] = unmapped
            else:
                models[node_id]["pricing"] = {key: pricing[key] for key in
                                              ("type", "currency", "unit", "price_points") if key in pricing}
    if not models:
        raise ValueError("Krea OpenAPI has no generation models")
    return {"sourceUrl": SOURCE_URL, "fetchedAt": checked_on,
            "openapiSha256": hashlib.sha256(raw).hexdigest(), "models": models}


def definitions(catalog):
    result = {}
    for node_id, model in catalog["models"].items():
        media_type = model["mediaType"]
        params, ports, json_params = fields_for(model["requestSchema"])
        params.insert(0, {"key": "_kreaAuth", "label": "Krea connection", "type": "enum",
                          "required": False, "options": [
                              {"value": "api-token", "label": "API token · API balance"},
                              {"value": "mcp", "label": "Krea account · workspace compute"}],
                          "default": "api-token"})
        if ports != model["inputPorts"] or json_params != model["jsonParams"]:
            raise ValueError(f"Catalog mapping drift: {node_id}; refresh the catalog")
        singular = media_type.lower()
        plural = PLURALS[media_type]
        name = model["displayName"]
        if model["endpoint"] == "/generate/image/openai/gpt-image-2":
            name = "GPT Image 2"
        if model["endpoint"].endswith("/grok-imagine-2-edit"):
            name += " Edit"
        result[node_id] = {
            "id": node_id, "displayName": name + " (Krea)",
            "category": category_for(model["endpoint"], media_type),
            "apiProvider": "krea", "apiEndpoint": model["endpoint"],
            "envKeyName": "KREA_API_TOKEN", "executionPattern": "async-poll",
            "inputPorts": ports,
            "outputPorts": [
                {"id": singular, "label": media_type, "dataType": media_type, "required": True},
                {"id": plural, "label": "All " + plural, "dataType": "Array", "required": False},
                {"id": "artifacts", "label": "All artifacts", "dataType": "Array", "required": False},
                {"id": "job", "label": "Job", "dataType": "Any", "required": False},
            ],
            "params": params, "docUrl": DOC_URL,
        }
        result[node_id].update(direct_route_definition(model["endpoint"], params))
    return result


def pricing_entries(catalog):
    """model_pricing.json entries for every Krea model whose price points map
    onto its own request fields. Returns (entries, skipped reasons)."""
    entries, skipped = {}, {}
    for node_id, model in catalog["models"].items():
        krea_entry(node_id, model, catalog, entries, skipped)
        direct = direct_route_pricing(model["endpoint"])
        if direct or (model["endpoint"] in DIRECT_ROUTES and node_id in entries):
            # A dual-route node prices each route; the Krea plan stays unpriced,
            # and so does a maker route without a price.
            routes = {}
            if node_id in entries:
                entries[node_id].pop("generatedBy")
                routes["krea"] = entries[node_id]
            if direct:
                routes[direct[0]] = direct[1]
            entries[node_id] = {"routes": routes, "generatedBy": PRICING_GENERATOR}
    return entries, skipped


def krea_entry(node_id, model, catalog, entries, skipped):
    """The Krea API-token entry for one model, into ``entries`` (or a reason into ``skipped``)."""
    if model.get("pricingUnmapped"):
        skipped[node_id] = ("price depends on " + ", ".join(model["pricingUnmapped"])
                            + ", which the request doesn't set directly")
        return
    pricing = model.get("pricing")
    if not pricing:
        return
    points = pricing.get("price_points") or []
    fields = set(model["requestSchema"].get("properties", {}))
    if pricing.get("currency") != "USD" or pricing.get("unit") != "request" or not points:
        skipped[node_id] = f"unsupported pricing {pricing.get('currency')}/{pricing.get('unit')}"
        return
    unmapped = sorted({key for point in points for key in point.get("dimensions", {})
                       if snake(key) not in fields})
    if unmapped:
        skipped[node_id] = "price depends on " + ", ".join(unmapped) + ", which the request doesn't set directly"
        return
    properties = model["requestSchema"].get("properties", {})

    def reachable(point):
        # Krea's price list sometimes covers values its own request schema
        # rejects (e.g. a 5 s Veo clip); a run can never match those.
        for key, value in point.get("dimensions", {}).items():
            allowed = simple_schema(properties[snake(key)]).get("enum")
            if allowed is not None and value not in allowed:
                return False
        return True

    guard = PRICE_GUARDS.get(model["endpoint"], {})
    rows = [{"match": {"_kreaAuth": "api-token",
                       **{snake(key): value for key, value in point.get("dimensions", {}).items()},
                       **guard.get("match", {})},
             "price": point["amount"]} for point in points if reachable(point)]
    if not rows:
        skipped[node_id] = "no price point matches values the request accepts"
        return
    notes = ["API-token runs only. Krea account runs bill workspace compute units, "
             "which Krea doesn't publish per option, so they stay unpriced."]
    if guard.get("note"):
        notes.append(guard["note"])
    dimensions = sorted({snake(key) for point in points for key in point.get("dimensions", {})})
    for field, note in UNPRICED_FIELD_NOTES.items():
        if field in properties and field not in dimensions:
            notes.append(note.format(dims=", ".join(dimensions) or "none"))
    sources = [{"url": catalog["sourceUrl"],
                "quote": f"x-krea-pricing on POST {model['endpoint']} "
                         f"(spec sha256 {catalog['openapiSha256'][:12]})"}]
    if guard.get("source"):
        sources.append(guard["source"])
    entries[node_id] = {
        "currency": "usd", "per": "request",
        "priceParams": sorted({key for row in rows for key in row["match"]}),
        "rows": rows,
        "notes": " ".join(notes),
        "sources": sources,
        "checked": catalog["fetchedAt"],
        "generatedBy": PRICING_GENERATOR,
    }


def pricing_source(source, entries):
    """Replace only this script's entries; hand-curated ones stay as they are."""
    data = json.loads(source)
    nodes = {key: value for key, value in data["nodes"].items()
             if value.get("generatedBy") != PRICING_GENERATOR}
    collisions = sorted(set(nodes) & set(entries))
    if collisions:
        raise ValueError(f"Hand-curated pricing collides with generated Krea pricing: {collisions}")
    data["nodes"] = dict(sorted({**nodes, **entries}.items()))
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def frontend_source(source, generated):
    blocks = [BEGIN]
    for node_id, definition in generated.items():
        body = json.dumps(definition, indent=2, ensure_ascii=False).splitlines()
        blocks.append(f"  '{node_id}': " + body[0])
        blocks.extend("  " + line for line in body[1:-1])
        blocks.append("  " + body[-1] + ",")
    blocks.append(END)
    block = "\n".join(blocks)
    if BEGIN in source:
        start = source.index(BEGIN)
        end = source.index(END, start) + len(END)
        return source[:start] + block + source[end:]
    insertion = source.index("\n};", source.index("export const NODE_DEFINITIONS"))
    return source[:insertion] + "\n" + block + source[insertion:]


def registry_source(source, generated):
    """Keep existing node formatting while replacing only this catalog."""
    decoder = json.JSONDecoder()
    position = source.index("{") + 1
    blocks = []
    while True:
        while source[position].isspace() or source[position] == ",":
            position += 1
        if source[position] == "}":
            break
        key, position = decoder.raw_decode(source, position)
        while source[position].isspace():
            position += 1
        if source[position] != ":":
            raise ValueError("Invalid node registry entry")
        position += 1
        while source[position].isspace():
            position += 1
        start = position
        value, position = decoder.raw_decode(source, position)
        if value.get("docUrl") != DOC_URL:
            if key in generated:
                raise ValueError(f"Existing node ID collision: {key}")
            blocks.append(f"  {json.dumps(key)}: {source[start:position]}")
    for key, value in generated.items():
        lines = json.dumps(value, indent=2, ensure_ascii=False).splitlines()
        blocks.append(f"  {json.dumps(key)}: " + lines[0] + "\n" +
                      "\n".join("  " + line for line in lines[1:]))
    return "{\n" + ",\n".join(blocks) + "\n}\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--openapi", type=Path)
    parser.add_argument("--date", default=datetime.date.today().isoformat())
    args = parser.parse_args()
    if args.check and (args.refresh or args.openapi):
        parser.error("--check is offline; refresh separately")
    if args.refresh or args.openapi:
        if args.openapi:
            raw = args.openapi.read_bytes()
        else:
            with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
                raw = response.read()
        catalog = refresh(raw, args.date)
    else:
        catalog = json.loads(CATALOG.read_text())
    generated = definitions(catalog)
    prices, unpriced = pricing_entries(catalog)
    expected = {
        CATALOG: json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
        REGISTRY: registry_source(REGISTRY.read_text(), generated),
        FRONTEND: frontend_source(FRONTEND.read_text(), generated),
        PRICING: pricing_source(PRICING.read_text(), prices),
    }
    for path, content in expected.items():
        if args.check:
            if path.read_text() != content:
                raise SystemExit(f"Krea catalog drift: {path.relative_to(ROOT)}; run scripts/sync-krea-catalog.py")
        else:
            path.write_text(content)
    print(f"Krea catalog {'check passed' if args.check else 'generated'}: {len(generated)} generation models, "
          f"{len(prices)} priced")
    for node_id, reason in sorted(unpriced.items()):
        print(f"  unpriced {node_id}: {reason}")


if __name__ == "__main__":
    main()
