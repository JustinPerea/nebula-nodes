"""Contract tests for semantic reference roles on existing node ports.

Covers VAL-NODES-001 through VAL-NODES-004 (and the additive-only rule from
VAL-ROLE-005 applied to this feature's edits):

- Specific role assignments on the required nodes (nano-banana, flux-kontext,
  cinema-scene, runway-video, ideogram-edit).
- Only Image dataType ports carry a role; every role value is one of the 7
  standard roles.
- Mask ports never get a role.
- Role additions are purely additive vs. the pre-roles baseline commit: no
  existing node/port field (id, label, dataType, required, multiple,
  maxConnections, params, apiEndpoint, handler routing) may change.
- Frontend nodeDefinitions.ts mirrors the backend role metadata exactly.
- ModelNode.tsx renders an accessible colored badge for role ports and leaves
  role-less ports untouched.
"""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DEFS_PATH = REPO_ROOT / "backend" / "data" / "node_definitions.json"
FRONTEND_DEFS_PATH = REPO_ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts"
MODEL_NODE_PATH = REPO_ROOT / "frontend" / "src" / "components" / "nodes" / "ModelNode.tsx"
NODES_CSS_PATH = REPO_ROOT / "frontend" / "src" / "styles" / "nodes.css"
REFERENCE_ROLES_PATH = REPO_ROOT / "frontend" / "src" / "lib" / "referenceRoles.ts"
BASELINE_FINGERPRINTS_PATH = (
    Path(__file__).resolve().parent / "fixtures" / "reference_roles_baseline_sha256.json"
)

# Intentional post-baseline contract repairs. Fingerprinting rewrites only these
# exact current values back to their historical values before comparing against
# c708400, so the role feature still rejects every unapproved mutation.
APPROVED_EXECUTION_PATTERN_CHANGES = {
    "flux-schnell": ("sync", "async-poll"),
    "fast-sdxl": ("sync", "async-poll"),
    "ideogram-transparent": ("async-poll", "sync"),
    "ideogram-edit-prompt": ("async-poll", "sync"),
}

# Exact approved Cinema art-direction additions and truthfulness repairs. Keep
# the historical fingerprints: normalize only these reviewed values rather
# than exempting entire definitions or accepting an arbitrary new baseline.
APPROVED_INPUT_PORT_ADDITIONS = {
    "cinema-scene": [
        {"id": "camera_rig", "label": "Camera Rig", "dataType": "CameraRig", "required": False},
        {"id": "reference_set", "label": "Reference Set", "dataType": "ReferenceSet", "required": False},
    ],
    "seedream-4-5": [
        {"id": "images", "label": "References", "dataType": "Image", "required": False,
         "multiple": True, "maxConnections": 10},
    ],
}
APPROVED_CAPABILITY_NOTE_ADDITIONS = {
    "cinema-scene": "Camera Rig adds prompt guidance. Reference Set sends ordered images with role guidance. Neither provides a native camera or reference-strength control.",
    "identity-edit": "Identity guidance uses Character reference images and traits. This model has no identity-strength or mask control.",
}
APPROVED_PARAM_FIELD_ADDITIONS = {
    "character": {
        "strength_override": {"disabledReason": "Unavailable: current Character consumers use reference images and traits without a consistency-strength control. Your stored value is retained."},
    },
    "identity-edit": {
        "identity_strength": {"disabledReason": "Unavailable: this model uses reference images and traits without an identity-strength control. Your stored value is retained."},
    },
    "seedream-4-5": {"seed": {"visibleWhen": {"model": ["4.5"]}}},
}
APPROVED_PARAM_LABEL_CHANGES = {
    "reference-set": {
        "style_weight": ("Style Weight", "Style Priority"),
        "identity_weight": ("Identity Weight", "Identity Priority"),
        "composition_weight": ("Composition Weight", "Composition Priority"),
        "pose_weight": ("Pose Weight", "Pose Priority"),
        "lighting_weight": ("Lighting Weight", "Lighting Priority"),
        "subject_weight": ("Subject Weight", "Subject Priority"),
        "background_weight": ("Background Weight", "Background Priority"),
    },
}
APPROVED_PORT_LABEL_CHANGES = {
    "identity-edit": {"mask": ("Mask", "Mask (unavailable)")},
}
APPROVED_OPTION_FIELD_ADDITIONS = {
    "seedream-4-5": {"image_size": {"auto_3K": {"visibleWhen": {"model": ["5.0-lite"]}}}},
}
# ElevenLabs lists eleven_turbo_v2_5 and eleven_turbo_v2 as "Deprecated
# models" (https://elevenlabs.io/docs/overview/models, read 2026-10-16). The
# values stay so saved graphs still open; only their labels say so.
APPROVED_OPTION_LABEL_CHANGES = {
    "elevenlabs-tts": {"model_id": {
        "eleven_turbo_v2_5": ("Turbo v2.5 (Low Latency)", "Turbo v2.5 (deprecated: use Flash v2.5)"),
        "eleven_turbo_v2": ("Turbo v2", "Turbo v2 (deprecated: use Flash v2)"),
    }},
}
# Krea account billing (2026-10-09): the three original Krea nodes that call
# Krea gained the same `_kreaAuth` choice as the gateway catalog, prepended,
# and Style Train gained the training models Krea added since the baseline.
_KREA_AUTH_PARAM = {"key": "_kreaAuth", "label": "Krea connection", "type": "enum", "required": False,
                    "options": [{"value": "api-token", "label": "API token · API balance"},
                                {"value": "mcp", "label": "Krea account · workspace compute"}],
                    "default": "api-token"}
# Pricing and readiness (2026-10-13): cinema-scene declares the base models its
# handler calls (handlers/cinema_scene.py _guard_base_model), so readiness,
# pricing and the spend check read them. Exact value; test_node_readiness.py
# pins it to the handler constants.
APPROVED_TOP_LEVEL_FIELD_ADDITIONS = {
    "cinema-scene": {"providerVia": {
        "kind": "model", "path": ["scene", "base", "model"],
        "models": ["seedream-4-5", "nano-banana", "nano-banana-fal-edit", "flux-kontext"],
        "default": "seedream-4-5", "fallbackFor": ["flux-1-dev", "flux.1-dev", "flux-dev"],
    }},
}
# Output handle contract (2026-10-14): saving rejects output handles a
# definition doesn't declare. Meshy's direct route always wrote model_url, so it
# is now a declared port, and the two sink nodes declare what they keep only to
# show on the card. See tests/test_output_handle_contract.py.
APPROVED_OUTPUT_PORT_ADDITIONS = {
    node_id: [{"id": "model_url", "label": "Model URL", "dataType": "Text", "required": False}]
    for node_id in ("meshy-text-to-3d", "meshy-image-to-3d")
}
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["image-compare"] = {"displayOutputs": [
    {"id": "imageA", "label": "Image A", "dataType": "Image", "required": False},
    {"id": "imageB", "label": "Image B", "dataType": "Image", "required": False},
]}
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["preview"] = {"displayOutputs": [
    {"id": "input", "label": "Input", "dataType": "Any", "required": False},
]}
# Direct maker routes (2026-10-14): Nano Banana's two fal copies also run on
# the Gemini API with the person's GOOGLE_API_KEY (execution/maker_routes.py).
# The only contract change is the route split: GOOGLE_API_KEY joins
# envKeyName and becomes directKeyName, and the unchanged params move into
# sharedParams + falParams (none are direct-only). Normalizing rebuilds the
# baseline `params` list in its original order, so any change to a param
# itself still fails the fingerprint.
_NANO_BANANA_FAL_ORDER = ["model", "aspect_ratio", "resolution", "num_images", "output_format",
                          "thinking_level", "enable_web_search", "seed"]
APPROVED_DUAL_ROUTE_SPLITS = {
    node_id: {"envKeyName": ("FAL_KEY", ["GOOGLE_API_KEY", "FAL_KEY"]), "directKeyName": "GOOGLE_API_KEY",
              "falParams": ["output_format", "seed"], "order": _NANO_BANANA_FAL_ORDER}
    for node_id in ("nano-banana-fal", "nano-banana-fal-edit")
}
# Direct maker routes, Google lane (2026-10-14): identity-edit also runs on
# the Gemini API (gemini-3.1-flash-image) with GOOGLE_API_KEY. Same approved
# split as the Nano Banana fal copies; its three params all move, unchanged
# and in order, to sharedParams (none are route-only).
APPROVED_DUAL_ROUTE_SPLITS["identity-edit"] = {
    "envKeyName": ("FAL_KEY", ["GOOGLE_API_KEY", "FAL_KEY"]), "directKeyName": "GOOGLE_API_KEY",
    "falParams": [], "order": ["resolution", "thinking_level", "identity_strength"],
}
# Direct maker routes, xAI (2026-10-14): Grok Imagine's two fal copies also
# run on xAI's own API with the person's XAI_API_KEY
# (execution/maker_routes_xai.py). Same approved split: XAI_API_KEY joins
# envKeyName and becomes directKeyName; output_format (fal-only, xAI has no
# output-format field) is the only falParam; every param is unchanged and
# rebuilt in its baseline order.
APPROVED_DUAL_ROUTE_SPLITS.update({
    "grok-imagine-image": {"envKeyName": ("FAL_KEY", ["XAI_API_KEY", "FAL_KEY"]), "directKeyName": "XAI_API_KEY",
                           "falParams": ["output_format"],
                           "order": ["num_images", "aspect_ratio", "resolution", "output_format"]},
    "grok-imagine-image-edit": {"envKeyName": ("FAL_KEY", ["XAI_API_KEY", "FAL_KEY"]),
                                "directKeyName": "XAI_API_KEY", "falParams": ["output_format"],
                                "order": ["num_images", "resolution", "output_format"]},
})
# Direct ElevenLabs routes (2026-10-14): ElevenLabs Music on fal and Runway's
# resold ElevenLabs TTS / speech-to-speech / dubbing also run on ElevenLabs'
# own API with the person's ELEVENLABS_API_KEY
# (execution/maker_routes_elevenlabs.py). Same rule as above: the unchanged
# params are only split by route (order rebuilt from `order`), and the one
# direct-only param each gains is pinned exactly here (`directParams`), so a
# change to any existing param, or to the new one, still fails.
_ELEVENLABS_VOICE_ID = {"key": "voice_id", "label": "ElevenLabs voice ID", "type": "string", "required": False,
                        "placeholder": "ElevenLabs voice ID (runs on your ElevenLabs key)"}
APPROVED_DUAL_ROUTE_SPLITS.update({
    "elevenlabs-music": {
        "envKeyName": ("FAL_KEY", ["ELEVENLABS_API_KEY", "FAL_KEY"]), "directKeyName": "ELEVENLABS_API_KEY",
        "falParams": [], "order": ["music_length_ms", "force_instrumental"],
        "directParams": [{"key": "model_id", "label": "Model", "type": "enum", "required": False,
                          "default": "music_v1", "options": [
                              {"label": "Music v1", "value": "music_v1"},
                              {"label": "Music v2", "value": "music_v2"},
                              {"label": "Music v2.5", "value": "music_v2_5"}]}],
    },
    "runway-tts": {
        "envKeyName": ("RUNWAY_API_KEY", ["ELEVENLABS_API_KEY", "RUNWAY_API_KEY"]),
        "directKeyName": "ELEVENLABS_API_KEY", "falParams": ["voiceId"], "order": ["voiceId"],
        "directParams": [_ELEVENLABS_VOICE_ID],
    },
    "runway-sts": {
        "envKeyName": ("RUNWAY_API_KEY", ["ELEVENLABS_API_KEY", "RUNWAY_API_KEY"]),
        "directKeyName": "ELEVENLABS_API_KEY", "falParams": ["voiceId"],
        "order": ["voiceId", "removeBackgroundNoise"], "directParams": [_ELEVENLABS_VOICE_ID],
    },
    "runway-dubbing": {
        "envKeyName": ("RUNWAY_API_KEY", ["ELEVENLABS_API_KEY", "RUNWAY_API_KEY"]),
        "directKeyName": "ELEVENLABS_API_KEY", "falParams": [],
        "order": ["targetLang", "disableVoiceCloning", "dropBackgroundAudio", "numSpeakers"],
    },
})
# Seedream on BytePlus ModelArk (2026-10-14, execution/maker_routes_byteplus.py):
# BYTEPLUS_API_KEY joins envKeyName as the direct key, the unchanged params
# split into sharedParams (model, image_size, num_images, max_images) +
# falParams (enable_safety_checker, seed), and the exact directRoute rules
# below are the only new field.
APPROVED_DUAL_ROUTE_SPLITS["seedream-4-5"] = {
    "envKeyName": ("FAL_KEY", ["BYTEPLUS_API_KEY", "FAL_KEY"]), "directKeyName": "BYTEPLUS_API_KEY",
    "falParams": ["enable_safety_checker", "seed"],
    "order": ["model", "image_size", "num_images", "max_images", "enable_safety_checker", "seed"],
}
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["seedream-4-5"] = {"directRoute": {
    "setup": "fallback",
    "blockedBy": ["seed"],
    "size": {"param": "image_size", "minPixels": 3686400, "maxPixels": 16777216, "maxAspect": 16,
             "unsupported": ["square"]},
    # Review fix: ModelArk always runs its own content filter, so fal's
    # safety checker switched off keeps the run on fal.
    "accepts": {"enable_safety_checker": {"values": [True]}},
}}
# Seedance on BytePlus ModelArk (2026-10-14,
# execution/maker_routes_byteplus_seedance.py): BYTEPLUS_API_KEY joins
# envKeyName as the direct key and the unchanged params split into
# sharedParams + falParams (seed on the 2.x nodes, which BytePlus documents
# for 1.x only; enable_safety_checker on 1.0 T2V). The exact directRoute rules
# below are the only new field.
_SEEDANCE_2_ORDER = ["aspect_ratio", "duration", "resolution", "generate_audio", "seed"]
for _node_id in ("seedance-2-t2v", "seedance-2-i2v", "seedance-2-r2v", "seedance-2-fast-t2v", "seedance-2-fast-i2v"):
    APPROVED_DUAL_ROUTE_SPLITS[_node_id] = {
        "envKeyName": ("FAL_KEY", ["BYTEPLUS_API_KEY", "FAL_KEY"]), "directKeyName": "BYTEPLUS_API_KEY",
        "falParams": ["seed"], "order": _SEEDANCE_2_ORDER,
    }
    APPROVED_TOP_LEVEL_FIELD_ADDITIONS[_node_id] = {"directRoute": {"setup": "fallback", "blockedBy": ["seed"]}}
APPROVED_DUAL_ROUTE_SPLITS["seedance-v1-5"] = {
    "envKeyName": ("FAL_KEY", ["BYTEPLUS_API_KEY", "FAL_KEY"]), "directKeyName": "BYTEPLUS_API_KEY",
    "falParams": [], "order": ["model", "duration", "aspect_ratio", "resolution", "generate_audio", "camera_fixed",
                               "seed"],
}
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["seedance-v1-5"] = {"directRoute": {"setup": "fallback"}}
APPROVED_DUAL_ROUTE_SPLITS["seedance-1-0-t2v"] = {
    "envKeyName": ("FAL_KEY", ["BYTEPLUS_API_KEY", "FAL_KEY"]), "directKeyName": "BYTEPLUS_API_KEY",
    "falParams": ["enable_safety_checker"],
    "order": ["aspect_ratio", "resolution", "duration", "camera_fixed", "seed", "enable_safety_checker"],
}
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["seedance-1-0-t2v"] = {"directRoute": {
    "setup": "fallback", "accepts": {"enable_safety_checker": {"values": [True]}},  # review fix, as Seedream
}}
# Direct maker routes, review fix (2026-10-14): Meshy's own image-to-3D API
# takes texture_prompt ("Provide a text prompt to guide the texturing
# process", https://docs.meshy.ai/en/api/image-to-3d), so it moves from
# falParams to the end of sharedParams and reaches both routes. The param
# itself is unchanged; normalizing moves it back to its baseline slot
# (group, index), so any edit to it still fails the fingerprint.
APPROVED_PARAM_GROUP_MOVES = {
    "meshy-image-to-3d": {"texture_prompt": ("sharedParams", "falParams", 0)},
}
# Direct maker routes, OpenAI lane (2026-10-14): the fal copies of GPT Image
# 1.5 and 2 also run on OpenAI's Images API with the person's OPENAI_API_KEY
# (execution/maker_routes_openai.py). Every param reaches both routes, so
# nothing splits: only OPENAI_API_KEY joins envKeyName and becomes
# directKeyName. `params` is still hashed as it was.
APPROVED_DIRECT_KEY_ADDITIONS = {
    node_id: {"envKeyName": ("FAL_KEY", ["OPENAI_API_KEY", "FAL_KEY"]), "directKeyName": "OPENAI_API_KEY"}
    for node_id in ("gpt-image-1-5", "gpt-image-1-5-edit", "gpt-image-2-fal-generate", "gpt-image-2-fal-edit")
}
# GPT Image 2's fal presets under OpenAI's 655,360-pixel minimum stay on fal
# (execution/maker_routes_openai.py FAL_GPT_IMAGE_2_SIZES): the rule is the
# only new field.
for _node_id in ("gpt-image-2-fal-generate", "gpt-image-2-fal-edit"):
    APPROVED_TOP_LEVEL_FIELD_ADDITIONS[_node_id] = {
        "directRoute": {"rejects": {"image_size": ["square", "portrait_16_9", "landscape_16_9"]}}}
# Grok Imagine's fal copies: xAI's images API has no output-format field and
# returns JPEG (docs.x.ai images REST reference: no format field; upload_urls
# "`image/jpeg` unless the requested quality produces PNG"), so a recipe that
# asks fal for PNG or WebP stays on fal. The rule is the only new field.
for _node_id in ("grok-imagine-image", "grok-imagine-image-edit"):
    APPROVED_TOP_LEVEL_FIELD_ADDITIONS[_node_id] = {
        "directRoute": {"accepts": {"output_format": {"values": ["jpeg"]}}}}
# Runway speech-to-speech with only a video wired stays on Runway: ElevenLabs'
# speech-to-speech takes an audio file only (execution/maker_routes_elevenlabs.py
# runway_sts_to_elevenlabs). The rule is the only new field.
APPROVED_TOP_LEVEL_FIELD_ADDITIONS["runway-sts"] = {"directRoute": {"rejectsWhen": [
    {"match": {"video": "(set)", "audio": "(unset)"}, "label": "a video input without an audio input"}]}}
APPROVED_LEADING_PARAM_ADDITIONS = {
    "krea-2-generate": _KREA_AUTH_PARAM,
    "krea-style-search": _KREA_AUTH_PARAM,
    "krea-style-train": _KREA_AUTH_PARAM,
}
APPROVED_APPENDED_OPTIONS = {
    "krea-style-train": {"model": [
        {"label": "Krea 2", "value": "k2"}, {"label": "Krea 2 Large", "value": "k2-large"},
        {"label": "Krea 1 (Krea account)", "value": "k1"},
        {"label": "LTX 2.3 22B (Krea account)", "value": "ltx-23-22b"},
    ]},
}

# Chat model refresh (2026-10-16): newer Claude, GPT-6 and Gemini models are
# prepended to the three chat menus, retiring models get a date in their label,
# gemini-chat's default moves off the deprecated gemini-3.5-flash, and params a
# new model rejects get exact visibleWhen lists. Claude gains one param, Effort,
# after thinkingBudget. Every value is pinned here; normalizing restores the
# baseline, so any other edit to these nodes still fails the fingerprint.
_CLAUDE_OLD = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6",
               "claude-haiku-4-5-20251001", "claude-opus-4-7", "claude-opus-4-6"]
_CLAUDE_NEW = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
# Chat defaults and Opus 4.7/4.8 on Effort (2026-10-16, approved by Justin):
# claude-chat defaults to Opus 5.5 at Effort "medium", gpt-4o-chat to GPT-6.1
# Sol, gemini-chat to Gemini 4 Argon at Thinking Level "medium". Opus 4.7/4.8
# reject a thinking budget and non-default sampling params, so they leave the
# temperature/top_p/thinkingBudget lists and join Effort's.
_OPUS_47_48 = ["claude-opus-4-8", "claude-opus-4-7"]
_CLAUDE_SAMPLING = [m for m in _CLAUDE_OLD if m not in _OPUS_47_48]
_CLAUDE_BUDGET_BASELINE = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
                           "claude-opus-4-7", "claude-opus-4-6"]
# Justin's answers 2026-10-16, items 2-6: Opus 4.6 and Sonnet 4.6 move to
# Effort (no X-High, which Anthropic's effort page doesn't list for them) and
# leave Thinking Budget; Opus 4.6-4.8 and Sonnet 4.6 leave the 4096 Max Tokens
# list for the 64,000 default; deprecated Gemini 3.5 Flash (routed to 3.6 Flash)
# leaves the temperature/top_p/top_k lists.
_CLAUDE_46 = ["claude-sonnet-4-6", "claude-opus-4-6"]
_CLAUDE_MAX_4096 = ["claude-fable-5", "claude-haiku-4-5-20251001"]
_CLAUDE_EFFORT = _CLAUDE_NEW + ["claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-6"]
_GPT5 = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
# Follow-ups (2026-10-16): GPT-6 Sol and the GPT-5.6 models join the menu, each
# chat node's max-token param gets per-model defaults (defaultBy) and a max that
# matches the makers' output caps, and OpenAI's "nano" is lowercase as on its
# model pages.
_GPT_REASONING = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
                  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
# Max Tokens' `default` is the default model's value (Opus 5.5, GPT-6.1 Sol,
# Argon), and the models that had the old default are listed at it.
_GPT_BEFORE = _GPT5 + ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]
_GEM_OLD = ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite",
            "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
_GEM_NEW = ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
_GEM_THINKING_OLD = ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite"]
APPROVED_LEADING_OPTIONS = {
    "claude-chat": {"model": [
        {"label": "Claude Fable 5.1 (flagship)", "value": "claude-fable-5-1"},
        {"label": "Claude Opus 5.5", "value": "claude-opus-5-5"},
        {"label": "Claude Sonnet 5.5", "value": "claude-sonnet-5-5"},
        {"label": "Claude Haiku 5.5", "value": "claude-haiku-5-5"},
    ]},
    "gpt-4o-chat": {"model": [
        {"label": "GPT-6 Astra (flagship)", "value": "gpt-6-astra"},
        {"label": "GPT-6.1 Sol", "value": "gpt-6.1-sol"},
        {"label": "GPT-6 Sol", "value": "gpt-6-sol"},
        {"label": "GPT-6 Luna", "value": "gpt-6-luna"},
        {"label": "GPT-5.6 Sol", "value": "gpt-5.6-sol"},
        {"label": "GPT-5.6 Terra", "value": "gpt-5.6-terra"},
        {"label": "GPT-5.6 Luna", "value": "gpt-5.6-luna"},
    ]},
    "gemini-chat": {"model": [
        {"label": "Gemini 4 Argon", "value": "gemini-4-argon"},
        {"label": "Gemini 3.8 Flash", "value": "gemini-3.8-flash"},
        {"label": "Gemini 3.6 Flash", "value": "gemini-3.6-flash"},
        {"label": "Gemini 3.5 Flash-Lite", "value": "gemini-3.5-flash-lite"},
    ]},
}
APPROVED_OPTION_LABEL_CHANGES.update({
    "claude-chat": {"model": {"claude-fable-5": ("Claude Fable 5 (flagship)", "Claude Fable 5")}},
    "gpt-4o-chat": {"model": {
        "gpt-5.5": ("GPT-5.5 (flagship)", "GPT-5.5"),
        "gpt-5.4-nano": ("GPT-5.4 Nano", "GPT-5.4 nano (retiring 2027-04-01)"),
        "gpt-4o": ("GPT-4o (legacy)", "GPT-4o (legacy, retiring 2027-01-14)"),
        "gpt-4o-mini": ("GPT-4o Mini (legacy)", "GPT-4o Mini (legacy, retiring 2027-01-14)"),
        "gpt-4.1": ("GPT-4.1 (legacy)", "GPT-4.1 (legacy, retiring 2027-01-14)"),
        "gpt-4.1-mini": ("GPT-4.1 Mini (legacy)", "GPT-4.1 Mini (legacy, retiring 2027-01-14)"),
        "gpt-4.1-nano": ("GPT-4.1 Nano (legacy, sunsets 2026-10-23)", "GPT-4.1 nano (legacy, retiring 2026-10-23)"),
    }},
    "gemini-chat": {"model": {
        "gemini-3.5-flash": ("Gemini 3.5 Flash", "Gemini 3.5 Flash (deprecated, runs Gemini 3.6 Flash)"),
        "gemini-3.1-flash-lite": ("Gemini 3.1 Flash-Lite", "Gemini 3.1 Flash-Lite (retiring 2027-05-07)"),
    }},
})
APPROVED_PARAM_FIELD_CHANGES = {
    "claude-chat": {
        "model": {"default": ("claude-sonnet-4-6", "claude-opus-5-5")},
        "max_tokens": {"max": (200000, 128000), "default": (4096, 64000)},
        "thinkingBudget": {"visibleWhen": (
            {"model": _CLAUDE_BUDGET_BASELINE},
            {"model": [m for m in _CLAUDE_BUDGET_BASELINE if m not in _OPUS_47_48 + _CLAUDE_46]})},
    },
    "gpt-4o-chat": {
        "model": {"default": ("gpt-5.4", "gpt-6.1-sol")},
        "max_completion_tokens": {"default": (4096, 25000)},
        "reasoning_effort": {"visibleWhen": ({"model": _GPT5}, {"model": _GPT_REASONING + _GPT5})},
    },
    "gemini-chat": {
        "model": {"default": ("gemini-3.5-flash", "gemini-4-argon")},
        "max_tokens": {"max": (65535, 65536), "default": (8192, 65536)},
        "thinkingLevel": {
            "visibleWhen": ({"model": _GEM_THINKING_OLD}, {"model": _GEM_NEW + _GEM_THINKING_OLD}),
            "default": ("", "medium"),
        },
    },
}
APPROVED_PARAM_FIELD_ADDITIONS.update({
    "claude-chat": {
        # Justin, 2026-10-17: Claude Fable 5 leaves the sampling lists too
        # (Anthropic: non-default temperature/top_p/top_k are a 400 on it).
        **{key: {"visibleWhen": {"model": [m for m in _CLAUDE_SAMPLING if m != "claude-fable-5"]}}
           for key in ("temperature", "top_p")},
        "max_tokens": {"defaultBy": {"model": {model: 4096 for model in _CLAUDE_MAX_4096}}},
    },
    "gpt-4o-chat": {"max_completion_tokens": {"defaultBy": {"model": {model: 4096 for model in _GPT_BEFORE}}}},
    "gemini-chat": {
        **{key: {"visibleWhen": {"model": [m for m in _GEM_OLD if m != "gemini-3.5-flash"]}}
           for key in ("temperature", "top_p", "top_k")},
        "max_tokens": {"defaultBy": {"model": {model: 8192 for model in _GEM_NEW + _GEM_OLD
                                               if model != "gemini-4-argon"}}},
    },
})
APPROVED_OPTION_FIELD_ADDITIONS.update({
    "gpt-4o-chat": {"reasoning_effort": {"none": {"visibleWhen": {"model": [
        "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] + _GPT5}}}},
    "gemini-chat": {"thinkingLevel": {"minimal": {
        # Google's thinking table lists gemini-3.1-pro-preview as low/medium/high only.
        "visibleWhen": {"model": ["gemini-3.6-flash", "gemini-3.5-flash-lite"]
                        + [m for m in _GEM_THINKING_OLD if m != "gemini-3.1-pro-preview"]}}}},
})
APPROVED_APPENDED_OPTIONS["gpt-4o-chat"] = {"reasoning_effort": [
    {"label": "Max", "value": "max", "visibleWhen": {"model": _GPT_REASONING}},
]}
APPROVED_INSERTED_PARAMS = {
    "claude-chat": [("thinkingBudget", {
        "key": "effort", "label": "Effort", "type": "enum", "required": False, "default": "medium",
        "visibleWhen": {"model": _CLAUDE_EFFORT},
        "options": [{"label": "Default", "value": ""}, {"label": "Low", "value": "low"},
                    {"label": "Medium", "value": "medium"}, {"label": "High", "value": "high"},
                    {"label": "X-High", "value": "xhigh", "visibleWhen": {"model": _CLAUDE_NEW + _OPUS_47_48}},
                    {"label": "Max", "value": "max"}],
    })],
}

# The 7 standard roles — mirrors REFERENCE_ROLE_IDS in referenceRoles.ts.
STANDARD_ROLES = {
    "style",
    "identity",
    "composition",
    "pose",
    "lighting",
    "subject",
    "background",
}

# Complete role assignment map for this feature. Conventions:
# - character/face-consistency reference ports -> "identity"
# - style-reference ports (incl. Ideogram "Style Refs", Krea style images) -> "style"
# - i2v first-frame / source-image ports (what to generate) -> "subject"
# - end-frame / last-frame / tail ports are trajectory constraints, NOT
#   references, and intentionally get no role.
EXPECTED_ROLES: dict[str, dict[str, str]] = {
    # --- Required assignments (VAL-NODES-001) ---
    "nano-banana": {"images": "identity"},
    "flux-kontext": {"image": "subject"},
    "cinema-scene": {"character_refs": "identity"},
    "runway-video": {"image": "style"},
    "ideogram-edit": {"image": "subject", "images": "style"},
    # --- Identity references ---
    "nano-banana-fal-edit": {"images": "identity"},
    "runway-act-two": {"character_image": "identity"},
    "minimax-s2v": {"subject_reference": "identity"},
    "ideogram-character": {"reference_images": "identity", "images": "style"},
    "kling-motion": {"image": "identity"},
    "identity-edit": {"image": "identity"},
    "wan-animate-move": {"image": "identity"},
    "wan-animate-replace": {"image": "identity"},
    "seedance-2-r2v": {"images": "identity"},
    "kling-o3-ref": {"image": "subject", "images": "identity"},
    # --- Style references ---
    "ideogram-remix": {"image": "subject", "images": "style"},
    "ideogram-reframe": {"image": "subject", "images": "style"},
    "ideogram-replace-background": {"image": "subject", "images": "style"},
    "krea-2-generate": {"style_images": "style"},
    "krea-image-style-reference": {"image": "style"},
    "luma-ray2-flash-modify": {"image": "style"},
    "runway-image": {"images": "subject"},
    # --- Subject references (i2v first frame / source image) ---
    "veo-3": {"image": "subject"},
    "veo-3-flf": {"image": "subject"},
    "kling-v2-1": {"image": "subject"},
    "kling-v3": {"image": "subject"},
    "kling-pro": {"image": "subject"},
    "kling-o3": {"image": "subject"},
    "minimax-i2v": {"first_frame_image": "subject"},
    "seedance-v1-5": {"image": "subject"},
    "seedance-2-i2v": {"image": "subject"},
}

# Mask ports (and any other non-reference ports) must never receive a role.
NO_ROLE_PORTS = [
    ("ideogram-edit", "mask"),
    ("flux-fill-inpaint", "mask"),
]


@pytest.fixture(scope="module")
def definitions() -> dict[str, dict[str, Any]]:
    return json.loads(BACKEND_DEFS_PATH.read_text())


def _sole_entry(entries: list[dict[str, Any]], key: str, value: str) -> dict[str, Any]:
    matches = [entry for entry in entries if entry.get(key) == value]
    assert len(matches) == 1, f"expected exactly one {key}={value!r}, got {len(matches)}"
    return matches[0]


def _remove_approved_fields(container: dict[str, Any], additions: dict[str, Any]) -> None:
    for key, approved_value in additions.items():
        assert container.get(key) == approved_value, f"unapproved value for {key}: {container.get(key)!r}"
        del container[key]


def _without_role_additions(node_id: str, node: dict[str, Any]) -> dict[str, Any]:
    """Normalize exact approved deltas without mutating shared fixture data."""
    normalized = deepcopy(node)
    for key, (now_in, baseline_in, index) in APPROVED_PARAM_GROUP_MOVES.get(node_id, {}).items():
        moved = [param for param in normalized.get(now_in) or [] if param.get("key") == key]
        assert len(moved) == 1, f"unapproved param move: {node_id}.{key}"
        normalized[now_in] = [param for param in normalized[now_in] if param.get("key") != key]
        normalized.setdefault(baseline_in, []).insert(index, moved[0])
    keys_added = APPROVED_DIRECT_KEY_ADDITIONS.get(node_id)
    if keys_added is not None:
        baseline_env, current_env = keys_added["envKeyName"]
        assert normalized.get("envKeyName") == current_env, f"unapproved envKeyName: {node_id}"
        normalized["envKeyName"] = baseline_env
        _remove_approved_fields(normalized, {"directKeyName": keys_added["directKeyName"]})
    split = APPROVED_DUAL_ROUTE_SPLITS.get(node_id)
    if split is not None:
        baseline_env, current_env = split["envKeyName"]
        assert normalized.get("envKeyName") == current_env, f"unapproved envKeyName: {node_id}"
        normalized["envKeyName"] = baseline_env
        _remove_approved_fields(normalized, {"directKeyName": split["directKeyName"], "params": [],
                                             "directParams": split.get("directParams", [])})
        shared, fal = normalized.pop("sharedParams"), normalized.pop("falParams")
        assert [param["key"] for param in fal] == split["falParams"], f"unapproved falParams: {node_id}"
        by_key = {param["key"]: param for param in shared + fal}
        assert sorted(by_key) == sorted(split["order"]) and len(by_key) == len(shared + fal), (
            f"unapproved route split: {node_id}")
        normalized["params"] = [by_key[key] for key in split["order"]]
    added_ports = APPROVED_INPUT_PORT_ADDITIONS.get(node_id, [])
    if added_ports:
        assert normalized["inputPorts"][-len(added_ports):] == added_ports, (
            f"unapproved appended input ports: {node_id}"
        )
    for approved_port in added_ports:
        port = _sole_entry(normalized["inputPorts"], "id", approved_port["id"])
        assert port == approved_port, f"unapproved added port: {node_id}.{approved_port['id']}"
        normalized["inputPorts"].remove(port)
    added_outputs = APPROVED_OUTPUT_PORT_ADDITIONS.get(node_id, [])
    if added_outputs:
        assert normalized["outputPorts"][-len(added_outputs):] == added_outputs, (
            f"unapproved appended output ports: {node_id}"
        )
        del normalized["outputPorts"][-len(added_outputs):]
    capability_note = APPROVED_CAPABILITY_NOTE_ADDITIONS.get(node_id)
    if capability_note is not None:
        _remove_approved_fields(normalized, {"capabilityNote": capability_note})
    _remove_approved_fields(normalized, APPROVED_TOP_LEVEL_FIELD_ADDITIONS.get(node_id, {}))
    for param_key, additions in APPROVED_PARAM_FIELD_ADDITIONS.get(node_id, {}).items():
        _remove_approved_fields(_sole_entry(normalized["params"], "key", param_key), additions)
    for param_key, (baseline_label, current_label) in APPROVED_PARAM_LABEL_CHANGES.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        assert param["label"] == current_label, f"unapproved label: {node_id}.{param_key}"
        param["label"] = baseline_label
    for port_id, (baseline_label, current_label) in APPROVED_PORT_LABEL_CHANGES.get(node_id, {}).items():
        port = _sole_entry(normalized["inputPorts"], "id", port_id)
        assert port["label"] == current_label, f"unapproved label: {node_id}.{port_id}"
        port["label"] = baseline_label
    for after_key, inserted in APPROVED_INSERTED_PARAMS.get(node_id, []):
        index = next(i for i, param in enumerate(normalized["params"]) if param.get("key") == after_key)
        assert normalized["params"][index + 1] == inserted, f"unapproved inserted param: {node_id}.{inserted['key']}"
        del normalized["params"][index + 1]
    for param_key, leading in APPROVED_LEADING_OPTIONS.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        assert param["options"][:len(leading)] == leading, f"unapproved leading options: {node_id}.{param_key}"
        del param["options"][:len(leading)]
    for param_key, labels in APPROVED_OPTION_LABEL_CHANGES.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        for option_value, (baseline_label, current_label) in labels.items():
            option = _sole_entry(param["options"], "value", option_value)
            assert option["label"] == current_label, f"unapproved option label: {node_id}.{param_key}.{option_value}"
            option["label"] = baseline_label
    for param_key, fields in APPROVED_PARAM_FIELD_CHANGES.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        for field, (baseline_value, current_value) in fields.items():
            assert param.get(field) == current_value, f"unapproved {field}: {node_id}.{param_key}"
            param[field] = baseline_value
    leading_param = APPROVED_LEADING_PARAM_ADDITIONS.get(node_id)
    if leading_param is not None:
        assert normalized["params"][0] == leading_param, f"unapproved leading param: {node_id}"
        normalized["params"].pop(0)
    for param_key, appended in APPROVED_APPENDED_OPTIONS.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        assert param["options"][-len(appended):] == appended, f"unapproved options: {node_id}.{param_key}"
        del param["options"][-len(appended):]
    for param_key, options in APPROVED_OPTION_FIELD_ADDITIONS.get(node_id, {}).items():
        param = _sole_entry(normalized["params"], "key", param_key)
        for option_value, additions in options.items():
            _remove_approved_fields(_sole_entry(param["options"], "value", option_value), additions)
    for section in ("inputPorts", "outputPorts"):
        normalized[section] = [
            {key: value for key, value in port.items() if key not in {"role", "weight"}}
            for port in normalized.get(section, [])
        ]
    approved = APPROVED_EXECUTION_PATTERN_CHANGES.get(node_id)
    if approved is not None:
        baseline_value, current_value = approved
        assert normalized.get("executionPattern") == current_value, (
            f"{node_id}.executionPattern must remain {current_value!r} after its "
            "approved lifecycle repair"
        )
        normalized["executionPattern"] = baseline_value
    return normalized


def _node_fingerprint(node_id: str, node: dict[str, Any]) -> str:
    canonical = json.dumps(
        _without_role_additions(node_id, node),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _baseline_fingerprints() -> dict[str, str]:
    payload = json.loads(BASELINE_FINGERPRINTS_PATH.read_text())
    assert payload["baselineCommit"] == "c708400"
    return payload["nodes"]


def _role_map(defs: dict[str, dict[str, Any]]) -> dict[str, dict[str, str]]:
    """Map of node id -> {port id: role} for every port carrying a role."""
    out: dict[str, dict[str, str]] = {}
    for node_id, node in defs.items():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if "role" in port:
                    out.setdefault(node_id, {})[port["id"]] = port["role"]
    return out


def _frontend_role_map() -> dict[str, dict[str, str]]:
    """Extract node id -> {port id: role} from the TS mirror.

    Port objects in nodeDefinitions.ts are single-line literals
    (`{ id: 'images', ..., role: 'identity' },`), so a line-based scan with
    node-block tracking is sufficient.
    """
    source = FRONTEND_DEFS_PATH.read_text()
    node_re = re.compile(r"^  '([^']+)': \{$")
    port_re = re.compile(r"^\s*\{ id: '([^']+)'.*\},?$")
    role_re = re.compile(r"role: '([^']+)'")
    roles: dict[str, dict[str, str]] = {}
    current_node: str | None = None
    for line in source.splitlines():
        node_match = node_re.match(line)
        if node_match:
            current_node = node_match.group(1)
            continue
        if current_node is None:
            continue
        port_match = port_re.match(line)
        if port_match:
            role_match = role_re.search(line)
            if role_match:
                roles.setdefault(current_node, {})[port_match.group(1)] = role_match.group(1)
    return roles


# ---------------------------------------------------------------------------
# VAL-NODES-001: specific assignments + minimum coverage
# ---------------------------------------------------------------------------


def test_required_role_assignments(definitions: dict[str, dict[str, Any]]) -> None:
    actual = _role_map(definitions)
    for node_id, ports in EXPECTED_ROLES.items():
        assert node_id in definitions, f"{node_id} missing from node definitions"
        for port_id, role in ports.items():
            assert actual.get(node_id, {}).get(port_id) == role, (
                f"{node_id}.{port_id} should have role {role!r}, "
                f"got {actual.get(node_id, {}).get(port_id)!r}"
            )


def test_at_least_five_nodes_have_roles(definitions: dict[str, dict[str, Any]]) -> None:
    nodes_with_roles = _role_map(definitions)
    assert len(nodes_with_roles) >= 5, (
        f"expected at least 5 nodes with role metadata, found {len(nodes_with_roles)}"
    )


# ---------------------------------------------------------------------------
# VAL-NODES-002: only Image ports, valid standard roles only
# ---------------------------------------------------------------------------


def test_only_image_ports_have_roles(definitions: dict[str, dict[str, Any]]) -> None:
    offenders: list[str] = []
    for node_id, node in definitions.items():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if "role" in port and port.get("dataType") != "Image":
                    offenders.append(
                        f"{node_id}.{section}.{port.get('id')} "
                        f"(dataType={port.get('dataType')!r})"
                    )
    assert offenders == [], f"non-Image ports with role: {offenders}"


def test_all_role_values_are_valid_standard_roles(
    definitions: dict[str, dict[str, Any]],
) -> None:
    invalid: list[str] = []
    for node_id, ports in _role_map(definitions).items():
        for port_id, role in ports.items():
            if role not in STANDARD_ROLES:
                invalid.append(f"{node_id}.{port_id}={role!r}")
    assert invalid == [], f"invalid role values: {invalid}"


def test_mask_ports_have_no_role(definitions: dict[str, dict[str, Any]]) -> None:
    for node_id, port_id in NO_ROLE_PORTS:
        node = definitions[node_id]
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                if port["id"] == port_id:
                    assert "role" not in port, (
                        f"{node_id}.{port_id} is a mask port and must not have a role"
                    )


# ---------------------------------------------------------------------------
# VAL-ROLE-005 / feature rule 3: role additions are additive only
# ---------------------------------------------------------------------------


def test_role_additions_are_additive_only(
    definitions: dict[str, dict[str, Any]],
) -> None:
    baseline = _baseline_fingerprints()

    # This feature contract protects every node that existed at its baseline;
    # later first-class nodes are allowed as long as none of the baseline nodes
    # disappear or mutate outside role/weight additions.
    assert set(baseline) <= set(definitions), (
        f"baseline nodes removed: {sorted(set(baseline) - set(definitions))}"
    )

    mismatches = sorted(
        node_id
        for node_id, expected_fingerprint in baseline.items()
        if _node_fingerprint(node_id, definitions[node_id]) != expected_fingerprint
    )
    assert mismatches == [], (
        "baseline nodes changed outside additive port role/weight metadata: "
        f"{mismatches}"
    )


@pytest.mark.parametrize(
    "node_id", ["cinema-scene", "character", "reference-set", "seedream-4-5", "identity-edit"],
)
def test_approved_art_direction_normalization_preserves_fixture_and_other_fields(definitions, node_id):
    original = deepcopy(definitions[node_id])
    assert _node_fingerprint(node_id, definitions[node_id]) == _baseline_fingerprints()[node_id]
    assert definitions[node_id] == original

    # These five nodes are still fully fingerprinted. An unrelated field change
    # must not disappear along with their specifically approved repairs.
    changed = deepcopy(original)
    changed["displayName"] += " unauthorized change"
    assert _node_fingerprint(node_id, changed) != _baseline_fingerprints()[node_id]


@pytest.mark.parametrize("node_id,section,selector,field,value", [
    ("cinema-scene", "inputPorts", "camera_rig", "required", True),
    ("cinema-scene", None, None, "capabilityNote", "Native camera control"),
    ("seedream-4-5", "inputPorts", "images", "maxConnections", 14),
    ("character", "params", "strength_override", "disabledReason", "Strength works"),
    # identity-edit's params live in sharedParams since its Google route (2026-10-14).
    ("identity-edit", "sharedParams", "identity_strength", "disabledReason", "Strength works"),
    ("reference-set", "params", "style_weight", "label", "Style Strength"),
    ("seedream-4-5", "falParams", "seed", "visibleWhen", {"model": ["4.5", "5.0-lite"]}),
    ("seedream-4-5", None, None, "directKeyName", "FAL_KEY"),
    ("identity-edit", "inputPorts", "mask", "label", "Mask"),
])
def test_approved_art_direction_values_cannot_drift(definitions, node_id, section, selector, field, value):
    changed = deepcopy(definitions[node_id])
    target = changed if section is None else _sole_entry(
        changed[section], "key" if section.endswith(("params", "Params")) else "id", selector,
    )
    target[field] = value
    with pytest.raises(AssertionError):
        _node_fingerprint(node_id, changed)


@pytest.mark.parametrize("change", [
    lambda node: _sole_entry(node["sharedParams"], "key", "image_size").update(default="landscape_16_9"),
    lambda node: node["falParams"].reverse(),
    lambda node: node["sharedParams"].append(node["falParams"].pop()),
    lambda node: node["directRoute"]["size"].update(minPixels=921600),
])
def test_seedream_route_split_still_fingerprints_every_param(definitions, change):
    """The approved BytePlus split rebuilds the baseline params, so a real
    param edit, a regrouping or a looser size rule still fails."""
    changed = deepcopy(definitions["seedream-4-5"])
    change(changed)
    try:
        fingerprint = _node_fingerprint("seedream-4-5", changed)
    except AssertionError:
        return
    assert fingerprint != _baseline_fingerprints()["seedream-4-5"]


def test_seedream_auto_3k_approved_visibility_cannot_expand(definitions):
    changed = deepcopy(definitions["seedream-4-5"])
    sizes = _sole_entry(changed["sharedParams"], "key", "image_size")
    _sole_entry(sizes["options"], "value", "auto_3K")["visibleWhen"] = {"model": ["4.5", "5.0-lite"]}
    with pytest.raises(AssertionError):
        _node_fingerprint("seedream-4-5", changed)


# ---------------------------------------------------------------------------
# VAL-NODES-004: frontend/backend mirror parity for role metadata
# ---------------------------------------------------------------------------


def test_frontend_mirrors_backend_roles(definitions: dict[str, dict[str, Any]]) -> None:
    backend_roles = _role_map(definitions)
    frontend_roles = _frontend_role_map()
    assert frontend_roles == backend_roles, (
        f"role metadata mismatch:\n"
        f"backend-only: { {k: v for k, v in backend_roles.items() if frontend_roles.get(k) != v} }\n"
        f"frontend-only: { {k: v for k, v in frontend_roles.items() if backend_roles.get(k) != v} }"
    )


# ---------------------------------------------------------------------------
# VAL-NODES-003: ModelNode renders an accessible role badge
# ---------------------------------------------------------------------------


def test_model_node_renders_role_badge() -> None:
    source = MODEL_NODE_PATH.read_text()

    # Badge data comes from referenceRoles.ts via the lookup helper.
    assert "getReferenceRole" in source, (
        "ModelNode.tsx must resolve role metadata via getReferenceRole"
    )
    roles_source = REFERENCE_ROLES_PATH.read_text()
    assert "export function getReferenceRole" in roles_source, (
        "referenceRoles.ts must export getReferenceRole"
    )

    # Badge element: colored dot/pill with an accessible name.
    assert "model-node__role-badge" in source, "ModelNode.tsx must render a role badge element"
    badge_block_start = source.index("model-node__role-badge")
    badge_block = source[max(0, badge_block_start - 600) : badge_block_start + 600]
    assert "aria-label" in badge_block, "role badge must have an aria-label"
    assert "backgroundColor: roleDef.color" in badge_block, (
        "role badge color must come from referenceRoles.ts"
    )

    # Badge is conditional on the port having a role — role-less ports render
    # exactly as before.
    assert "port.role" in source, "badge rendering must be gated on port.role"

    # The badge belongs to the input-port rows only; the output-port block
    # renders unchanged.
    output_block = source.split("definition.outputPorts.map", 1)[1]
    assert "model-node__role-badge" not in output_block, (
        "output ports must not render role badges"
    )

    # Badge styling exists.
    css = NODES_CSS_PATH.read_text()
    assert ".model-node__role-badge" in css, (
        "nodes.css must define the .model-node__role-badge style"
    )


# ---------------------------------------------------------------------------
# VAL-CROSS-004: role metadata stays optional (legacy graphs unaffected)
# ---------------------------------------------------------------------------


def test_role_metadata_remains_optional(definitions: dict[str, dict[str, Any]]) -> None:
    """Ports without role/weight must still dominate the registry — role is
    opt-in metadata, so legacy graphs (serialized before roles existed) load,
    validate, and execute identically."""
    total_ports = 0
    ports_with_role = 0
    for node in definitions.values():
        for section in ("inputPorts", "outputPorts"):
            for port in node.get(section, []):
                total_ports += 1
                if "role" in port:
                    ports_with_role += 1
    assert ports_with_role > 0
    assert ports_with_role < total_ports, "every port has a role — role is no longer optional"
    # reference-set node itself keeps its role-slot ports free of `role`
    # metadata (the slot id already IS the role).
    refset = definitions["reference-set"]
    for port in refset["inputPorts"]:
        assert "role" not in port, "reference-set role slots must not carry role metadata"
