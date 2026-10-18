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
                             "POST /v1/text_to_image). width/height round to the nearest gen4_image size, and the "
                             "Inspector says when that changes them; Runway names only 720p and 1080p tiers, so the price is the range between them.",
                    "sources": [{"url": RUNWAY_PRICING_URL,
                                 "quote": "`gen4_image` | 5 credits per 720p image, or 8 credits per 1080p image"},
                                _RUNWAY_CREDIT],
                    "checked": MAKER_CHECKED},
    },
    "/generate/video/runway/gen-4.5": {
        "directKeyName": "RUNWAY_API_KEY", "translation": "krea-runway-gen4-5", "model": "gen4.5",
        "kreaOnly": [], "directParams": [],
        # Runway's gen4.5 request schema (sdk-python image_to_video_create_params /
        # text_to_video_create_params, read 2026-10-14): image-to-video ratio
        # "1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672";
        # text-to-video "1280:720", "720:1280". Runway's guide ("Gen-4.5
        # Image-to-Video supports ... Portrait 720:1280 832:1104 672:1584",
        # llms-full.txt) also lists Krea's 672:1584, but the schema refuses it, so
        # that ratio stays on Krea, and so does text-to-video at Krea's other ratios.
        "directRejects": {"aspect_ratio": ["672:1584"]},
        "directRejectsWhen": [
            {"match": {"aspect_ratio": ratio, "start_image": "(unset)"}, "label": f"text-to-video at {ratio}"}
            for ratio in ("1104:832", "832:1104", "960:960", "1584:672")
        ],
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
        "directRejects": {"resolution": ["4K"]},
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


# xAI video generations: duration "integer", "Range: [1, 15]" (videos REST
# reference); a fractional or longer Krea duration stays on Krea.
_XAI_VIDEO_SECONDS = {"integer": True, "min": 1, "max": 15}


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
        "directAccepts": {"duration": _XAI_VIDEO_SECONDS},
        # xAI documents an edit on its own and a start image or references on
        # one generation, not these together; such a run stays on Krea.
        "directRejectsWhen": [
            {"match": {"edit_video": "(set)", "start_image": "(set)"}, "label": "an edit video with a start image"},
            {"match": {"edit_video": "(set)", "reference_images": "(set)"},
             "label": "an edit video with reference images"},
            {"match": {"start_image": "(set)", "reference_images": "(set)"},
             "label": "a start image with reference images"}],
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
        "directAccepts": {"duration": _XAI_VIDEO_SECONDS},
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


# MiniMax (MINIMAX_API_KEY) and Meshy (MESHY_API_KEY) copies; backend
# execution/maker_routes_minimax_meshy.py translates them. Model ids, fields
# and limits: platform.minimax.io/docs/api-reference/video-generation-{t2v,i2v,
# fl2v,v2-create}.md and docs.meshy.ai/openapi.yaml, read 2026-10-14.
# `directAccepts` / `directRejectsWhen` keep a run MiniMax wouldn't take on Krea:
# "duration ... `6` or `10`" and 1080P "`6`" only (i2v.md, t2v.md, fl2v.md).
# Rules that need an input to be present (2.3 Fast needs a start image, 512P
# needs one, H3 text-to-video needs a concrete ratio) aren't route rules (a
# rule only matches what is set or wired), so the translation refuses those
# before any call.
MINIMAX_PRICING_URL = "https://platform.minimax.io/docs/pricing/overview"
MINIMAX_CHECKED = "2026-10-14"
_MINIMAX_NOTE = ("MiniMax pay-as-you-go list price (Global platform, USD), for runs on the person's MINIMAX_API_KEY "
                 "(model {model}). Video Packages deduct video points instead, and a Mainland China key "
                 "(api.minimaxi.com) bills that platform's own rates; neither is priced here.")
_MINIMAX_10S_1080P = {"match": {"resolution": "1080p", "duration": 10}, "label": "1080p at 10 seconds"}


def _hailuo_pricing(model, rows):
    return {"provider": "minimax", "per": "video", "priceParams": ["duration", "resolution"],
            "rows": [{"match": {"resolution": res, "duration": dur}, "price": price} for res, dur, price, _ in rows],
            "sources": [{"url": MINIMAX_PRICING_URL, "quote": f"| {model} | {quote} |"} for _, _, _, quote in rows],
            "notes": _MINIMAX_NOTE.format(model=model), "checked": MINIMAX_CHECKED}


def _h3_pricing():
    """MiniMax H3, billed per second of output: "768P | Billed per second | $0.08 / second", "2K | ... $0.13 /
    second". The high end adds the most reference input MiniMax takes: 9 reference images ("First 5 images
    free; $0.04 per additional image", so 4 billed) and 15 s of reference video ("total <= 15 s", billed "by
    input video duration and output video resolution"). Audio input is free."""
    rows = []
    for res, rate in (("2K", 0.13), ("768P", 0.08)):
        for seconds in range(5, 16):
            low = round(seconds * rate, 4)
            rows.append({"match": {"resolution": res, "duration": seconds},
                         "price": [low, round(low + 4 * 0.04 + 15 * rate, 4)]})
    return {"provider": "minimax", "per": "video", "priceParams": ["duration", "resolution"], "rows": rows,
            "sources": [
                {"url": MINIMAX_PRICING_URL, "quote": "| MiniMax-H3 | 768P | Billed per second | $0.08 / second |"},
                {"url": MINIMAX_PRICING_URL, "quote": "| MiniMax-H3 | 2K | Billed per second | $0.13 / second |"},
                {"url": MINIMAX_PRICING_URL,
                 "quote": "| MiniMax-H3 | Image | First 5 images free; $0.04 per additional image |"},
                {"url": MINIMAX_PRICING_URL, "quote": "| MiniMax-H3 | Video | Billed by input video duration and "
                                                      "output video resolution: 2K $0.13/sec, 768P $0.08/sec |"},
                {"url": "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
                 "quote": "Count | first frame <= 1, last frame <= 1, reference images <= 9 ... Per-clip duration "
                          "| [2, 15] s; total <= 15 s"}],
            "notes": (_MINIMAX_NOTE.format(model="MiniMax-H3") + " The low end is the output video alone; the "
                      "high end adds 4 billed reference images (of 9) and 15 s of reference video. Video Packages "
                      "don't cover H3 (MiniMax: \"MiniMax H3 is not supported yet\"); M Plan Explore/Build "
                      "Subscription Keys deduct the same list price from plan usage."),
            "checked": MINIMAX_CHECKED}


MINIMAX_MESHY_ROUTES = {
    "/generate/video/minimax/hailuo-02": {
        "directKeyName": "MINIMAX_API_KEY", "translation": "krea-minimax-hailuo", "model": "MiniMax-Hailuo-02",
        "kreaOnly": [], "directParams": [],
        "directAccepts": {"duration": {"values": [6, 10]}}, "directRejectsWhen": [_MINIMAX_10S_1080P],
        "pricing": _hailuo_pricing("MiniMax-Hailuo-02", [
            ("512p", 6, 0.10, "$0.10 per 512P, 6s video"), ("512p", 10, 0.15, "$0.15 per 512P, 10s video"),
            ("768p", 6, 0.28, "$0.28 per 768P, 6s video"), ("768p", 10, 0.56, "$0.56 per 768P, 10s video"),
            ("1080p", 6, 0.49, "$0.49 per 1080P, 6s video")]),
    },
    "/generate/video/minimax/hailuo-2.3": {
        "directKeyName": "MINIMAX_API_KEY", "translation": "krea-minimax-hailuo", "model": "MiniMax-Hailuo-2.3",
        # First & last frame is Hailuo 02 only (fl2v.md: "Supported values: `MiniMax-Hailuo-02`").
        "kreaOnly": ["end_image"], "directBlockedBy": ["end_image"], "directParams": [],
        "directRejectsWhen": [_MINIMAX_10S_1080P],
        "pricing": _hailuo_pricing("MiniMax-Hailuo-2.3", [
            ("768p", 6, 0.28, "$0.28 per 768P, 6s video"), ("768p", 10, 0.56, "$0.56 per 768P, 10s video"),
            ("1080p", 6, 0.49, "$0.49 per 1080P, 6s video")]),
    },
    "/generate/video/minimax/hailuo-2.3-fast": {
        "directKeyName": "MINIMAX_API_KEY", "translation": "krea-minimax-hailuo",
        "model": "MiniMax-Hailuo-2.3-Fast",
        "kreaOnly": ["end_image"], "directBlockedBy": ["end_image"], "directParams": [],
        "directRejectsWhen": [_MINIMAX_10S_1080P],
        "pricing": _hailuo_pricing("MiniMax-Hailuo-2.3-Fast", [
            ("768p", 6, 0.19, "$0.19 per 768P, 6s video"), ("768p", 10, 0.32, "$0.32 per 768P, 10s video"),
            ("1080p", 6, 0.33, "$0.33 per 1080P, 6s video")]),
    },
    "/generate/video/minimax/hailuo-3": {
        "directKeyName": "MINIMAX_API_KEY", "translation": "krea-minimax-h3", "model": "MiniMax-H3",
        # V2 has no field for how much of a reference video to use.
        "kreaOnly": ["reference_video_seconds"], "directBlockedBy": ["reference_video_seconds"],
        # V2 requires resolution; Krea's H3 bills $0.65 for 5 s = MiniMax's 2K rate x 5, so 2K is the default.
        "directParams": [{"key": "resolution", "label": "Resolution", "type": "enum", "required": False,
                          "options": [{"label": "2K", "value": "2K"}, {"label": "768P", "value": "768P"}],
                          "default": "2K"}],
        "pricing": _h3_pricing(),
    },
    "/generate/3d/meshy/meshy-7": {
        # Meshy prices in credits (docs.meshy.ai/api/pricing) and publishes no USD rate per API credit, so
        # the Meshy route stays unpriced, like the other Meshy nodes.
        "directKeyName": "MESHY_API_KEY", "translation": "krea-meshy", "model": "meshy-7",
        "kreaOnly": [], "directParams": [],
    },
}
DIRECT_ROUTES.update(MINIMAX_MESHY_ROUTES)


# ElevenLabs (execution/maker_routes_elevenlabs.py). Krea's TTS and music
# fields are ElevenLabs' own (Krea's schema: voice_id "ElevenLabs voice ID",
# model_id "ElevenLabs model ID"; music_length_ms "3s to 600s. Omit to let the
# model choose"), so nothing is Krea-only. Music is priced per minute of
# music_length_ms; TTS bills per character of the prompt, which isn't a
# number pricing can read, so its ElevenLabs route stays unpriced.
ELEVENLABS_PRICING_URL = "https://elevenlabs.io/pricing/api"
ELEVENLABS_MUSIC_URL = "https://elevenlabs.io/docs/api-reference/music/compose"
ELEVENLABS_CHECKED = "2026-10-14"
# $0.15 per minute = $0.0000025 per millisecond of music_length_ms. Unset, the
# model picks the length, so the price is the documented range: 3000 ms to
# 600000 ms (the API's bound; the pricing page's "5 minute duration limit" is
# lower, so the high end is conservative).
ELEVENLABS_MUSIC_PER_MS = 0.0000025  # 0.15 / 60000, written out so the JSON stays exact
ELEVENLABS_MUSIC_PRICING = {
    "provider": "elevenlabs", "currency": "usd", "per": "request", "priceParams": ["music_length_ms"],
    "multiplyBy": ["music_length_ms"],
    "rows": [{"match": {"music_length_ms": ""}, "price": [round(3000 * ELEVENLABS_MUSIC_PER_MS, 6),
                                                         round(600000 * ELEVENLABS_MUSIC_PER_MS, 6)]},
             {"match": {}, "price": ELEVENLABS_MUSIC_PER_MS}],
    "notes": ("ElevenLabs API price for runs on the person's ELEVENLABS_API_KEY: $0.15 per minute of music, "
              "so a set music_length_ms costs $0.0000025 per millisecond. With no length set the model picks "
              "it, so the price is the 3,000-600,000 ms range the API takes. The page lists one Music price for "
              "every model (music_v1, music_v2, music_v2_5)."),
    "sources": [{"url": ELEVENLABS_PRICING_URL, "quote": "Music Generation $0.15 Price per minute"},
                {"url": ELEVENLABS_MUSIC_URL,
                 "quote": "Must be between 3000ms and 600000ms. Optional - if not provided, the model will "
                          "choose a length based on the prompt."}],
    "checked": ELEVENLABS_CHECKED,
}
for _endpoint, _model in (("/generate/audio/elevenlabs/music", "music_v1"),
                          ("/generate/audio/elevenlabs/music-v2", "music_v2"),
                          ("/generate/audio/elevenlabs/music-v2.5", "music_v2_5")):
    DIRECT_ROUTES[_endpoint] = {
        "directKeyName": "ELEVENLABS_API_KEY", "translation": "krea-elevenlabs-music", "model": _model,
        "kreaOnly": [], "directParams": [], "pricing": ELEVENLABS_MUSIC_PRICING,
    }
DIRECT_ROUTES["/generate/audio/elevenlabs/tts"] = {
    "directKeyName": "ELEVENLABS_API_KEY", "translation": "krea-elevenlabs-tts",
    "model": "eleven_multilingual_v2", "kreaOnly": [], "directParams": [], "pricing": None,
}
# Seedream's Krea copies on BytePlus ModelArk, ByteDance's own international
# API, with the person's BYTEPLUS_API_KEY (backend handlers/byteplus.py,
# execution/maker_routes_byteplus.py). Read from BytePlus's docs 2026-10-14:
# - Model ids and size rules: docs.byteplus.com/en/docs/ModelArk/image-generation-api
#   ("Seedream 4.0 ... Total pixels range: [1280x720=921,600, 4096x4096=16,777,216]";
#   5.0 lite "[2560x1440(3,686,400), 4096x4096(16,777,216)]"; 5.0 pro / flash
#   "[1280x720(921,600), 2048x2048x1.1025(4,624,220)]"; "Aspect ratio range:
#   [1/16, 16]" for all). A Krea width/height outside them stays on Krea
#   (directSize -> directRoute.size; never resized).
# - Seedream 5.0 lite: the model list names "seedream-5-0-260128 (also
#   supports: seedream-5-0-lite-260128)"; the pricing page prices
#   seedream-5-0-lite-260128, so that id is the one called.
# - seed (default 1337) has no ModelArk equivalent: Krea-only. Its default
#   can't be a blocker (every new node would stay on Krea), so the default is
#   dropped on the maker route, and any other seed keeps the run on Krea
#   (directAccepts), where it is honored, instead of being dropped silently.
#   style_images carry a Krea `strength` (-2..2) ModelArk can't take, so
#   they're Krea-only and keep a run on Krea when set.
_BYTEPLUS_PRICING_URL = "https://docs.byteplus.com/en/docs/ModelArk/model-pricing"
_BYTEPLUS_NOTE = ("BytePlus ModelArk pay-as-you-go output price for runs on the person's BYTEPLUS_API_KEY (model "
                  "{model}). Images that fail (content moderation) aren't billed.")


KREA_SEEDREAM_DEFAULT_SEED = 1337  # Krea's own default (api.krea.ai/openapi.json), checked against the catalog below


def _byteplus_route(model, minimum, maximum, price, quote, note=""):
    return {
        "directKeyName": "BYTEPLUS_API_KEY", "translation": "krea-seedream", "model": model,
        "kreaOnly": ["seed", "style_images"], "directBlockedBy": ["style_images"], "directParams": [],
        "directAccepts": {"seed": {"values": [KREA_SEEDREAM_DEFAULT_SEED]}},
        # With no key set, setup suggests the Krea token: BytePlus doesn't
        # serve the United States and each model needs activating first.
        "directSetup": "fallback",
        "directSize": {"widthParam": "width", "heightParam": "height", "minPixels": minimum,
                       "maxPixels": maximum, "maxAspect": 16},
        "pricing": {"provider": "bytedance", "per": "image", "priceParams": [],
                    "rows": [{"match": {}, "price": price}],
                    "notes": _BYTEPLUS_NOTE.format(model=model) + note,
                    "sources": [{"url": _BYTEPLUS_PRICING_URL, "quote": quote}], "checked": "2026-10-14"},
    }


DIRECT_ROUTES.update({
    "/generate/image/bytedance/seedream-4": _byteplus_route(
        "seedream-4-0-250828", 921_600, 16_777_216, 0.03, "seedream-4-0-250828 | Free | 0.03"),
    "/generate/image/bytedance/seedream-5-lite": _byteplus_route(
        "seedream-5-0-lite-260128", 3_686_400, 16_777_216, 0.035, "seedream-5-0-lite-260128 | Free | 0.035"),
    "/generate/image/bytedance/seedream-5-pro": _byteplus_route(
        "dola-seedream-5-0-pro-260628", 921_600, 4_624_220, [0.045, 0.09],
        "Single image generation: ≤ 2.61 million pixels (1.5K or lower): 0.045; > 2.61 million pixels "
        "(higher than 1.5K): 0.09",
        " The price is per output pixel tier: 0.045 USD up to 2.61 million pixels, 0.09 USD above, so a run "
        "is quoted as that range (the price rows can't read width x height). The maker route sends no input "
        "images (style images keep a run on Krea), so the 0.003 USD per extra input image doesn't apply."),
})


# Seedance's Krea copies on BytePlus ModelArk (backend
# execution/maker_routes_byteplus_seedance.py). Read from BytePlus's docs
# 2026-10-14 (create-video-generation-task-api, model-pricing):
# - seed is documented for "Seedance 1.5 pro, Seedance 1.0 pro, Seedance 1.0
#   pro fast" only, so a set seed keeps a 2.x run on Krea.
# - Krea's effects, upscale, prompt enhancer and 2.5 draft, a start video, and
#   reference images on 1.0 pro have no ModelArk field: set (or switched on),
#   they keep the run on Krea. Krea's 9:21 ratio isn't one of BytePlus's
#   ("16:9, 4:3, 1:1, 3:4, 9:16, 21:9, and adaptive"), and BytePlus's duration
#   is whole seconds ("duration integer"; 2.5 "[4, 30]", 2.0 series "[4, 15]",
#   1.0 pro / pro fast "[2, 12]"), so other values stay on Krea too.
# - Price: BytePlus bills completion tokens; "Estimated token consumption =
#   (Input video duration + Output video duration) x Output video width x
#   Output video height x Output video frame rate / 1024", at the model's rate
#   per resolution, for input without video. A run with a reference video
#   bills another rate plus a minimum that depends on the input video's
#   length, so it's unpriced (the rows need reference_videos empty).
def _seedance_prices():
    import importlib.util

    path = ROOT / "backend/execution/byteplus_seedance_prices.py"
    spec = importlib.util.spec_from_file_location("byteplus_seedance_prices", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _byteplus_seedance_route(model, krea_only, blocked, accepts, resolutions, ratio_rows=True,
                             video_refs=True):
    prices = _seedance_prices()
    rows = []
    for resolution in resolutions:
        guard = {"reference_videos": ""} if video_refs else {}
        if ratio_rows:
            for ratio in prices.RATIOS:
                low, high = prices.per_second(model, resolution, ratio)
                rows.append({"match": {"resolution": resolution, "aspect_ratio": ratio, **guard},
                             "price": round(low, 6)})
        else:
            low, high = prices.per_second(model, resolution)
            rows.append({"match": {"resolution": resolution, **guard}, "price": [round(low, 6), round(high, 6)]})
    note = (f"BytePlus ModelArk online price for runs on the person's BYTEPLUS_API_KEY (model {model}), from "
            "BytePlus's token estimate at 24 fps: width x height x 24 / 1024 tokens a second, times the "
            "duration. BytePlus bills the usage.completion_tokens it reports, which can differ a little, and "
            "doesn't bill failed runs.")
    if video_refs:
        note += (" A run with reference videos bills a lower rate plus a minimum that depends on the input "
                 "video's length, so it's unpriced.")
    if not ratio_rows:
        note += (" Seedance 2.5 keeps a start image's shape (its only frame-run ratio is adaptive), so the "
                 "price is the range over the documented sizes for that resolution (assumes the output keeps "
                 "the tier's pixel count, as every documented ratio does).")
    return {
        "directKeyName": "BYTEPLUS_API_KEY", "translation": "krea-seedance", "model": model,
        "kreaOnly": krea_only, "directBlockedBy": blocked, "directParams": [], "directSetup": "fallback",
        "directAccepts": accepts,
        "pricing": {"provider": "bytedance", "per": "second", "priceParams": sorted({k for r in rows for k in r["match"]}),
                    "rows": rows, "multiplyBy": ["duration"], "notes": note,
                    "sources": [{"url": prices.PRICING_URL, "quote": prices.RATE_QUOTES[model]},
                                {"url": prices.PRICING_URL, "quote": prices.TOKEN_FORMULA_QUOTE},
                                {"url": prices.SIZES_URL, "quote": prices.SIZES_QUOTE}],
                    "checked": prices.CHECKED},
    }


def _seedance_accepts(model, **switches):
    prices = _seedance_prices()
    shortest, longest = prices.DURATIONS[model]
    return {"duration": {"integer": True, "min": shortest, "max": longest},
            **{key: {"values": [False]} for key in switches}}


def _seedance_routes():
    prices = _seedance_prices()
    ratios = {"aspect_ratio": {"values": list(prices.RATIOS)}}
    return {
        "/generate/video/bytedance/seedance-1.0-pro": _byteplus_seedance_route(
            prices.SEEDANCE_1_0_PRO, ["start_video", "reference_images"], ["start_video", "reference_images"],
            {**ratios, **_seedance_accepts(prices.SEEDANCE_1_0_PRO)}, ["720p", "1080p"], video_refs=False),
        "/generate/video/bytedance/seedance-1.0-pro-fast": _byteplus_seedance_route(
            prices.SEEDANCE_1_0_PRO_FAST, ["start_video"], ["start_video"],
            {**ratios, **_seedance_accepts(prices.SEEDANCE_1_0_PRO_FAST)}, ["480p", "720p", "1080p"],
            video_refs=False),
        "/generate/video/bytedance/seedance-2": _byteplus_seedance_route(
            prices.SEEDANCE_2_0, ["seed", "effects", "upscale", "enhance_prompt"], ["seed", "effects"],
            _seedance_accepts(prices.SEEDANCE_2_0, upscale=1, enhance_prompt=1), ["480p", "720p", "1080p", "4k"]),
        "/generate/video/bytedance/seedance-2-fast": _byteplus_seedance_route(
            prices.SEEDANCE_2_0_FAST, ["seed", "effects", "upscale", "enhance_prompt"], ["seed", "effects"],
            _seedance_accepts(prices.SEEDANCE_2_0_FAST, upscale=1, enhance_prompt=1), ["480p", "720p"]),
        "/generate/video/bytedance/seedance-2-mini": _byteplus_seedance_route(
            prices.SEEDANCE_2_0_MINI, ["seed"], ["seed"], _seedance_accepts(prices.SEEDANCE_2_0_MINI),
            ["480p", "720p"]),
        "/generate/video/bytedance/seedance-2-5": _byteplus_seedance_route(
            prices.SEEDANCE_2_5, ["seed", "effects", "enhance_prompt", "draft"], ["seed", "effects"],
            _seedance_accepts(prices.SEEDANCE_2_5, enhance_prompt=1, draft=1), ["480p", "720p", "1080p"],
            ratio_rows=False),
    }


DIRECT_ROUTES.update(_seedance_routes())


# Krea models folded into a hand-built route-table node (one node per model,
# docs/PROVIDER-ROUTES.md): Krea endpoint -> (node id, its Krea route id, the
# node's ports Krea names another way). No node is generated for these and no
# Krea price either: the node's own model_pricing.json entry prices its Krea
# route. Each catalog entry keeps "foldedInto" (and "portFields", which the
# Krea route client reads, backend execution/route_clients.py krea_inputs), and
# --check ties the node's Krea route to the entry's request schema
# (folded_problems).
FOLDED = {
    "/generate/video/black-forest-labs/flux-3-video": ("flux-3-video", "krea", {}),
    "/generate/video/black-forest-labs/flux-video-edit": ("flux-video-edit", "krea", {}),
    "/generate/enhance/black-forest-labs/flux-video-upscale": ("flux-video-upscale", "krea", {"video": "video_url"}),
    "/generate/image/krea/krea-3": ("krea-3", "krea", {"images": "image_urls"}),
}


def _node_route():
    """backend/services/node_route.py (stdlib only), for the rule checks below."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("node_route", ROOT / "backend/services/node_route.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _maker_sizes():
    """backend/services/maker_sizes.py (stdlib only): the size lists makers take."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("maker_sizes", ROOT / "backend/services/maker_sizes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _size_snap(endpoint, route, params):
    """``directRoute.snap`` for a maker that takes a fixed size list
    (maker_sizes.SNAPS, by translation): the list and how it is spelled, so
    the frontend snaps width/height to the same values the backend sends."""
    spec = _maker_sizes().SNAPS.get(route["translation"])
    if spec is None:
        return {}
    keys = {param["key"] for param in params}
    if not {"width", "height"} <= keys or {"width", "height"} & set(route["kreaOnly"]):
        raise ValueError(f"DIRECT_ROUTES {endpoint}: a size list needs shared width/height fields")
    return {"snap": {"widthParam": "width", "heightParam": "height", **spec, "choices": list(spec["choices"])}}


def _start_shape(endpoint, route, params):
    """``directRoute.startShape`` for a maker that doesn't take the aspect
    ratio on a start-image run (maker_sizes.START_SHAPES, by model), so the
    Inspector can say so before the run."""
    spec = _maker_sizes().START_SHAPES.get(route["model"])
    if spec is None:
        return {}
    keys = {param["key"] for param in params}
    if not {spec["ratioParam"], spec["imageParam"]} <= keys:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: a start-shape rule needs its ratio and start image fields")
    return {"startShape": dict(spec)}


def _route_rules(endpoint, route, params):
    """The overlay's directRoute rules (backend services/node_route.py
    direct_block reads them), checked: each names Krea fields, and none
    blocks a param's default (that would send every new node to Krea)."""
    rules = _node_route()
    keys = {param["key"] for param in params}
    defaults = {param["key"]: param.get("default") for param in params}
    blocked = route.get("directBlockedBy") or []
    if set(blocked) - set(route["kreaOnly"]):
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy must be kreaOnly fields")
    defaulted = sorted(key for key in blocked if defaults.get(key) is not None)
    if defaulted:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directBlockedBy fields have defaults: {defaulted}")
    accepts = route.get("directAccepts") or {}
    rejects = route.get("directRejects") or {}
    rejects_when = route.get("directRejectsWhen") or []
    named = set(accepts) | set(rejects) | {key for rule in rejects_when for key in rule.get("match") or {}}
    if named - keys:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: value rules name fields Krea doesn't take: {sorted(named - keys)}")
    for key, rule in accepts.items():
        if defaults.get(key) is not None and not rules.value_accepted(defaults[key], rule):
            raise ValueError(f"DIRECT_ROUTES {endpoint}: directAccepts refuses {key}'s default")
    for key, values in rejects.items():
        if rules.match_value(defaults.get(key)) in {rules.match_value(value) for value in values}:
            raise ValueError(f"DIRECT_ROUTES {endpoint}: directRejects refuses {key}'s default")
    for rule in rejects_when:
        match = rule.get("match") or {}
        if not match or not rule.get("label"):
            raise ValueError(f"DIRECT_ROUTES {endpoint}: a directRejectsWhen rule needs a match and a label: {rule}")
        if all((defaults.get(key) is not None) if want == rules.SET
               else (defaults.get(key) is None) if want == rules.NOT_SET
               else rules.match_value(defaults.get(key)) == rules.match_value(want) for key, want in match.items()):
            raise ValueError(f"DIRECT_ROUTES {endpoint}: directRejectsWhen refuses the defaults: {rule}")
    size = route.get("directSize")
    size_keys = {size[k] for k in ("widthParam", "heightParam", "param") if size and size.get(k)}
    if size_keys & set(route["kreaOnly"]) or size_keys - keys:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directSize must name shared Krea fields")
    return {**({"blockedBy": list(blocked)} if blocked else {}),
            **({"accepts": {key: dict(rule) for key, rule in accepts.items()}} if accepts else {}),
            **({"rejects": {key: list(values) for key, values in rejects.items()}} if rejects else {}),
            **({"rejectsWhen": [dict(rule) for rule in rejects_when]} if rejects_when else {}),
            **({"size": dict(size)} if size else {})}


def direct_route_definition(endpoint, params):
    """The dual-route fields a Krea node with a maker route adds (DIRECT_ROUTES)."""
    route = DIRECT_ROUTES.get(endpoint)
    if not route:
        return {}
    keys = {param["key"] for param in params}
    unknown = sorted(set(route["kreaOnly"]) - keys)
    if unknown:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: kreaOnly names fields Krea doesn't take: {unknown}")
    clash = sorted(keys & {param["key"] for param in route["directParams"]})
    if clash:
        raise ValueError(f"DIRECT_ROUTES {endpoint}: directParams repeat Krea fields: {clash}")
    rules = _route_rules(endpoint, route, params)
    return {
        "envKeyName": [route["directKeyName"], "KREA_API_TOKEN"],
        "directKeyName": route["directKeyName"],
        "sharedParams": [param for param in params if param["key"] not in route["kreaOnly"]],
        "falParams": [param for param in params if param["key"] in route["kreaOnly"]],
        "directParams": list(route["directParams"]),
        "directRoute": {"translation": route["translation"], "model": route["model"], **rules,
                        **_size_snap(endpoint, route, params), **_start_shape(endpoint, route, params),
                        **({"setup": route["directSetup"]} if route.get("directSetup") else {})},
    }


def direct_route_pricing(endpoint):
    route = DIRECT_ROUTES.get(endpoint)
    if not route or not route.get("pricing"):
        return None
    pricing = dict(route["pricing"])
    provider = pricing.pop("provider")
    if provider != "google":
        # A maker whose overlay entry is the whole price (sources, notes and
        # checked date included); the Google reference-image range below is
        # Gemini-specific.
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


def annotate_folded(model):
    """Mark a catalog entry FOLDED names (in place): the node it folds into
    and the ports it names another way."""
    model.pop("foldedInto", None)
    model.pop("portFields", None)
    folded = FOLDED.get(model["endpoint"])
    if folded:
        model["foldedInto"] = folded[0]
        if folded[2]:
            model["portFields"] = dict(folded[2])
    return model


def folded_problems(catalog, registry):
    """Every way a folded entry's node fails its Krea request schema: the node
    or its Krea route is missing, the route's endpoint doesn't name the entry,
    a param it sends (after ``rename``) isn't a request field, an option it
    offers (after ``valueMap``) is outside the field's enum or range, or a
    port it takes isn't a field (after ``portFields``)."""
    node_route = _node_route()
    problems = []
    seen = set()
    for key, model in catalog["models"].items():
        folded = FOLDED.get(model["endpoint"])
        if not folded:
            continue
        seen.add(model["endpoint"])
        node_id, route_id, port_fields = folded
        where = f"{key} (folded into {node_id}):"
        definition = registry.get(node_id)
        route = node_route.route_by_id(definition, route_id) if definition else None
        if not route or route.get("provider") != "krea" or route.get("handler") != "krea":
            problems.append(f"{where} {node_id} has no Krea route {route_id!r}")
            continue
        if route.get("endpoint") not in (key, model["endpoint"]):
            problems.append(f"{where} route endpoint {route.get('endpoint')!r} doesn't name {model['endpoint']}")
        properties = model["requestSchema"].get("properties", {})
        rename = route.get("rename") or {}
        value_map = route.get("valueMap") or {}
        for param in node_route.route_param_definitions(definition, route_id):
            name = param["key"]
            if name in node_route.BILLING_PARAMS:
                continue
            field = rename.get(name, name)
            if field not in properties:
                problems.append(f"{where} param {name} sends {field!r}, which the request schema lacks")
                continue
            schema = simple_schema(properties[field])
            mapped = value_map.get(name)
            for option in param.get("options") or []:
                value = option.get("value") if isinstance(option, dict) else option
                sent = mapped.get(str(value), mapped.get(value)) if mapped else value
                if "enum" in schema and sent not in schema["enum"]:
                    problems.append(f"{where} {name}={value!r} sends {sent!r}, not in {schema['enum']}")
            for bound, compare in (("min", "minimum"), ("max", "maximum")):
                limit = param.get(bound)
                if isinstance(limit, (int, float)) and compare in schema and (
                        limit < schema[compare] if bound == "min" else limit > schema[compare]):
                    problems.append(f"{where} {name} {bound} {limit} is outside {compare} {schema[compare]}")
        refused = {port for port, rule in ((route.get("rules") or {}).get("ports") or {}).items()
                   if isinstance(rule, dict) and rule.get("max") == 0}
        for port in definition.get("inputPorts") or []:
            if port["id"] in refused:
                continue
            field = port_fields.get(port["id"], port["id"])
            if field not in properties:
                problems.append(f"{where} port {port['id']} goes as {field!r}, which the request schema lacks")
    for endpoint in sorted(set(FOLDED) - seen):
        problems.append(f"FOLDED names {endpoint}, which the catalog doesn't have")
    return problems


def refresh_one(pinned, fresh, endpoint):
    """``pinned`` with one entry, ``endpoint``'s, taken from ``fresh`` (a
    refresh() result), stamped with the spec it came from. A full refresh
    also drops and adds unrelated models, which saved graphs depend on."""
    matches = [key for key, model in fresh["models"].items() if model["endpoint"] == endpoint]
    if len(matches) != 1:
        raise SystemExit(f"Krea's OpenAPI has no generation model at {endpoint}")
    key = matches[0]
    entry = {**fresh["models"][key], "fetchedAt": fresh["fetchedAt"], "openapiSha256": fresh["openapiSha256"]}
    return {**pinned, "models": {**pinned["models"], key: entry}}


def definitions(catalog):
    result = {}
    for node_id, model in catalog["models"].items():
        if model.get("foldedInto"):
            continue
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
        if model.get("foldedInto"):
            continue  # its route-table node's own entry prices the Krea route
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
    parser.add_argument("--only", metavar="ENDPOINT",
                        help="with --refresh or --openapi: refresh just this Krea endpoint's entry, which keeps "
                             "its own fetchedAt and openapiSha256; every other entry stays as pinned")
    args = parser.parse_args()
    if args.check and (args.refresh or args.openapi):
        parser.error("--check is offline; refresh separately")
    if args.only and not (args.refresh or args.openapi):
        parser.error("--only needs --refresh or --openapi")
    if args.refresh or args.openapi:
        if args.openapi:
            raw = args.openapi.read_bytes()
        else:
            with urllib.request.urlopen(SOURCE_URL, timeout=30) as response:
                raw = response.read()
        catalog = refresh(raw, args.date)
        if args.only:
            catalog = refresh_one(json.loads(CATALOG.read_text()), catalog, args.only)
    else:
        catalog = json.loads(CATALOG.read_text())
    # A change to FOLDED reaches the pinned entries too (--check: drift).
    for model in catalog["models"].values():
        annotate_folded(model)
    problems = folded_problems(catalog, json.loads(REGISTRY.read_text()))
    if problems:
        raise SystemExit("Folded Krea models don't match their nodes:\n  " + "\n  ".join(problems))
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
