from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from execution.engine import LOCAL_EXECUTION_NODE_IDS
from execution.sync_runner import get_handler_registry
from services.node_registry import NodeRegistry

REPO_ROOT = Path(__file__).resolve().parents[2]

VALID_CATEGORIES = {
    "image-gen",
    "video-gen",
    "text-gen",
    "audio-gen",
    "3d-gen",
    "transform",
    "analyzer",
    "utility",
    "universal",
}
VALID_PROVIDERS = {
    "openai",
    "anthropic",
    "google",
    "runway",
    "kling",
    "elevenlabs",
    "replicate",
    "fal",
    "bytedance",
    "minimax",
    "luma",
    "xai",
    "recraft",
    "ideogram",
    "openrouter",
    "bfl",
    "higgsfield",
    "meshy",
    "nous",
    "utility",
}
VALID_EXECUTION_PATTERNS = {"sync", "async-poll", "stream"}
VALID_PORT_TYPES = {"Text", "Image", "Video", "Audio", "Mask", "Array", "SVG", "Mesh", "Any"}
VALID_PARAM_TYPES = {"string", "integer", "float", "boolean", "enum", "textarea", "file"}
PARAM_GROUPS = ("params", "sharedParams", "falParams", "directParams")


@pytest.fixture(scope="module")
def definitions() -> dict[str, dict[str, Any]]:
    return NodeRegistry().get_all()


def _port_errors(node_id: str, field: str, ports: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(ports, list):
        return [f"{node_id}.{field} must be a list"]

    seen: set[str] = set()
    for port in ports:
        if not isinstance(port, dict):
            errors.append(f"{node_id}.{field} contains a non-object port")
            continue
        port_id = port.get("id")
        if not isinstance(port_id, str) or not port_id:
            errors.append(f"{node_id}.{field} has a port without an id")
            continue
        if port_id in seen:
            errors.append(f"{node_id}.{field} has duplicate port id {port_id}")
        seen.add(port_id)
        if not isinstance(port.get("label"), str) or not port.get("label"):
            errors.append(f"{node_id}.{field}.{port_id} is missing label")
        if port.get("dataType") not in VALID_PORT_TYPES:
            errors.append(f"{node_id}.{field}.{port_id} has invalid dataType {port.get('dataType')!r}")
        if not isinstance(port.get("required"), bool):
            errors.append(f"{node_id}.{field}.{port_id}.required must be bool")
        if "multiple" in port and not isinstance(port["multiple"], bool):
            errors.append(f"{node_id}.{field}.{port_id}.multiple must be bool when present")
        if "maxConnections" in port and not isinstance(port["maxConnections"], int):
            errors.append(f"{node_id}.{field}.{port_id}.maxConnections must be int when present")
    return errors


def _param_errors(node_id: str, field: str, params: Any) -> list[str]:
    errors: list[str] = []
    if params is None:
        return errors
    if not isinstance(params, list):
        return [f"{node_id}.{field} must be a list"]

    seen: set[str] = set()
    for param in params:
        if not isinstance(param, dict):
            errors.append(f"{node_id}.{field} contains a non-object param")
            continue
        key = param.get("key")
        if not isinstance(key, str) or not key:
            errors.append(f"{node_id}.{field} has a param without key")
            continue
        if key in seen:
            errors.append(f"{node_id}.{field} has duplicate param key {key}")
        seen.add(key)
        if not isinstance(param.get("label"), str) or not param.get("label"):
            errors.append(f"{node_id}.{field}.{key} is missing label")
        if param.get("type") not in VALID_PARAM_TYPES:
            errors.append(f"{node_id}.{field}.{key} has invalid type {param.get('type')!r}")
        if not isinstance(param.get("required"), bool):
            errors.append(f"{node_id}.{field}.{key}.required must be bool")
        if param.get("type") == "enum":
            options = param.get("options")
            if not isinstance(options, list) or not options:
                errors.append(f"{node_id}.{field}.{key} enum must have options")
            else:
                option_values: set[str] = set()
                for option in options:
                    if not isinstance(option, dict) or "label" not in option or "value" not in option:
                        errors.append(f"{node_id}.{field}.{key} has malformed enum option")
                        continue
                    value_key = json.dumps(option["value"], sort_keys=True)
                    if value_key in option_values:
                        errors.append(f"{node_id}.{field}.{key} has duplicate enum value {option['value']!r}")
                    option_values.add(value_key)
                if "default" in param:
                    default_key = json.dumps(param["default"], sort_keys=True)
                    if default_key not in option_values:
                        errors.append(
                            f"{node_id}.{field}.{key} default {param['default']!r} is not an enum option"
                        )
    return errors


def test_registry_definitions_have_valid_contract_shape(definitions: dict[str, dict[str, Any]]) -> None:
    errors: list[str] = []

    for node_id, definition in definitions.items():
        if definition.get("id") != node_id:
            errors.append(f"{node_id}.id must match registry key")
        if not isinstance(definition.get("displayName"), str) or not definition.get("displayName"):
            errors.append(f"{node_id}.displayName is required")
        if definition.get("category") not in VALID_CATEGORIES:
            errors.append(f"{node_id}.category has invalid value {definition.get('category')!r}")
        if definition.get("apiProvider") not in VALID_PROVIDERS:
            errors.append(f"{node_id}.apiProvider has invalid value {definition.get('apiProvider')!r}")
        if definition.get("executionPattern") not in VALID_EXECUTION_PATTERNS:
            errors.append(f"{node_id}.executionPattern has invalid value {definition.get('executionPattern')!r}")

        env_key = definition.get("envKeyName")
        if not isinstance(env_key, (str, list)):
            errors.append(f"{node_id}.envKeyName must be string or list")
        elif isinstance(env_key, list) and not all(isinstance(item, str) for item in env_key):
            errors.append(f"{node_id}.envKeyName list values must be strings")

        errors.extend(_port_errors(node_id, "inputPorts", definition.get("inputPorts")))
        errors.extend(_port_errors(node_id, "outputPorts", definition.get("outputPorts")))
        for group in PARAM_GROUPS:
            errors.extend(_param_errors(node_id, group, definition.get(group)))

    assert errors == []


@pytest.mark.asyncio
async def test_every_nonlocal_node_has_execution_handler(definitions: dict[str, dict[str, Any]]) -> None:
    async def fake_emit(_event):
        return None

    handlers = get_handler_registry(emit=fake_emit)
    missing = sorted(set(definitions) - set(handlers) - set(LOCAL_EXECUTION_NODE_IDS))
    extra = sorted(set(handlers) - set(definitions))

    assert missing == []
    assert extra == []


def test_frontend_and_backend_registry_ids_match(definitions: dict[str, dict[str, Any]]) -> None:
    source = (REPO_ROOT / "frontend" / "src" / "constants" / "nodeDefinitions.ts").read_text()
    frontend_ids = set(re.findall(r"^\s+'([^']+)':\s+\{", source, flags=re.MULTILINE))

    assert len(frontend_ids) == len(definitions)
    assert sorted(set(definitions) - frontend_ids) == []
    assert sorted(frontend_ids - set(definitions)) == []


def test_env_example_covers_all_registry_api_keys(definitions: dict[str, dict[str, Any]]) -> None:
    env_example = (REPO_ROOT / ".env.example").read_text()
    required_keys: set[str] = set()

    for definition in definitions.values():
        env_key = definition.get("envKeyName")
        if isinstance(env_key, str) and env_key:
            required_keys.add(env_key)
        elif isinstance(env_key, list):
            required_keys.update(key for key in env_key if key)

    missing = sorted(key for key in required_keys if f"{key}=" not in env_example)
    assert missing == []


def test_model_reference_no_longer_claims_stale_full_count(definitions: dict[str, dict[str, Any]]) -> None:
    model_reference = (REPO_ROOT / "docs" / "MODEL_REFERENCE.md").read_text()

    assert "Complete reference for all 77 nodes" not in model_reference
    assert f"live registry currently contains {len(definitions)} nodes" in model_reference


def _param_by_key(definition: dict[str, Any], key: str) -> dict[str, Any]:
    for group in PARAM_GROUPS:
        for param in definition.get(group, []) or []:
            if param.get("key") == key:
                return param
    raise AssertionError(f"Param {key!r} not found on {definition.get('id')}")


def test_local_execution_nodes_have_utility_provider(definitions: dict[str, dict[str, Any]]) -> None:
    errors: list[str] = []
    for node_id in LOCAL_EXECUTION_NODE_IDS:
        definition = definitions.get(node_id)
        if definition is None:
            errors.append(f"LOCAL_EXECUTION_NODE_IDS contains unknown node: {node_id}")
            continue
        if definition.get("apiProvider") != "utility":
            errors.append(
                f"{node_id} is a local utility node and must have apiProvider 'utility'"
                f" (got {definition.get('apiProvider')!r})"
            )
        env_key = definition.get("envKeyName")
        env_is_empty = (isinstance(env_key, list) and not env_key) or env_key in ("", None)
        if not env_is_empty:
            errors.append(
                f"{node_id} is a local utility node and must have empty envKeyName"
                f" (got {env_key!r})"
            )
    assert errors == []


def test_researched_provider_corrections_are_pinned(definitions: dict[str, dict[str, Any]]) -> None:
    # --- ltx-video-2 (verified 2026-05-17 against fal.ai/models/fal-ai/ltx-2/image-to-video/api) ---
    ltx = definitions["ltx-video-2"]
    ltx_resolution_values = {option["value"] for option in _param_by_key(ltx, "resolution")["options"]}
    ltx_duration_values = {str(option["value"]) for option in _param_by_key(ltx, "duration")["options"]}
    assert ltx_resolution_values == {"1080p", "1440p", "2160p"}
    assert ltx_duration_values == {"6", "8", "10"}
    # fps and generate_audio are API params and must be exposed
    ltx_fps_values = {str(o["value"]) for o in _param_by_key(ltx, "fps")["options"]}
    assert ltx_fps_values == {"25", "50"}, "ltx-video-2 fps must be 25 or 50"
    assert _param_by_key(ltx, "fps")["default"] == "25"
    assert _param_by_key(ltx, "generate_audio")["default"] is True, (
        "ltx-video-2 generate_audio default must be True (API default)"
    )

    # --- ltx-2-3 (verified 2026-05-17 against fal.ai/models/fal-ai/ltx-2.3/image-to-video/api) ---
    ltx23 = definitions["ltx-2-3"]
    # duration must be an enum (string values), not integer type
    ltx23_duration_param = _param_by_key(ltx23, "duration")
    assert ltx23_duration_param["type"] == "enum", "ltx-2-3 duration must be enum, not integer"
    ltx23_duration_values = {str(o["value"]) for o in ltx23_duration_param["options"]}
    assert ltx23_duration_values == {"6", "8", "10"}, "ltx-2-3 duration options must be 6, 8, 10"
    assert str(ltx23_duration_param["default"]) == "6"
    # aspect_ratio must include 'auto' as default (API: auto, 16:9, 9:16)
    ltx23_ar_param = _param_by_key(ltx23, "aspect_ratio")
    ltx23_ar_values = {o["value"] for o in ltx23_ar_param["options"]}
    assert "auto" in ltx23_ar_values, "ltx-2-3 aspect_ratio must include 'auto'"
    assert "1:1" not in ltx23_ar_values, "ltx-2-3 aspect_ratio must not include '1:1' (not in API)"
    assert ltx23_ar_param["default"] == "auto", "ltx-2-3 aspect_ratio default must be 'auto'"
    # fps must expose all four API options as string values
    ltx23_fps_values = {str(o["value"]) for o in _param_by_key(ltx23, "fps")["options"]}
    assert ltx23_fps_values == {"24", "25", "48", "50"}, "ltx-2-3 fps must be 24, 25, 48, 50"
    assert str(_param_by_key(ltx23, "fps")["default"]) == "25"
    # generate_audio default must be True (API default)
    assert _param_by_key(ltx23, "generate_audio")["default"] is True, (
        "ltx-2-3 generate_audio default must be True (API default)"
    )
    # end_image input port must be present (maps to end_image_url via universal handler)
    ltx23_input_ids = {p["id"] for p in ltx23["inputPorts"]}
    assert "end_image" in ltx23_input_ids, "ltx-2-3 must have end_image input port"
    assert "audio" in ltx23_input_ids, "ltx-2-3 must retain audio input port"

    for node_id in ("minimax-t2v", "minimax-i2v"):
        mm = definitions[node_id]
        assert _param_by_key(mm, "model")["default"] == "MiniMax-Hailuo-2.3"
        mm_duration_values = {str(o["value"]) for o in _param_by_key(mm, "duration")["options"]}
        assert mm_duration_values == {"6", "10"}, f"{node_id} duration options should be 6 and 10 (not 9)"
        mm_resolution_values = {o["value"] for o in _param_by_key(mm, "resolution")["options"]}
        assert "768P" in mm_resolution_values, f"{node_id} resolution options must include 768P"
        assert "720P" not in mm_resolution_values, f"{node_id} should not expose legacy 720P option"
        assert _param_by_key(mm, "resolution")["default"] == "768P"

    mm_s2v = definitions["minimax-s2v"]
    assert _param_by_key(mm_s2v, "model")["default"] == "S2V-01"
    s2v_input_ids = {p["id"] for p in mm_s2v["inputPorts"]}
    assert "subject_reference" in s2v_input_ids, "minimax-s2v must use port id 'subject_reference'"
    assert "image" not in s2v_input_ids, "minimax-s2v must not use generic 'image' port id"

    mm_i2v = definitions["minimax-i2v"]
    i2v_input_ids = {p["id"] for p in mm_i2v["inputPorts"]}
    assert "first_frame_image" in i2v_input_ids, "minimax-i2v must use port id 'first_frame_image'"
    assert "image" not in i2v_input_ids, "minimax-i2v must not use generic 'image' port id"
    assert "last_frame" not in i2v_input_ids, "minimax-i2v must not expose last_frame (not in API)"

    elevenlabs_tts = definitions["elevenlabs-tts"]
    for key in ("similarity_boost", "style", "use_speaker_boost", "speed", "output_format", "seed"):
        _param_by_key(elevenlabs_tts, key)

    # --- OpenAI image nodes (verified 2026-05-16 against openai-python SDK types) ---

    # gpt-image-1-generate: quality must include "auto" (API default); output_format and
    # background must be present (handler now forwards them).
    gpt1_gen = definitions["gpt-image-1-generate"]
    gpt1_gen_quality_values = {o["value"] for o in _param_by_key(gpt1_gen, "quality")["options"]}
    assert "auto" in gpt1_gen_quality_values, "gpt-image-1-generate quality must include 'auto'"
    assert "low" in gpt1_gen_quality_values
    assert "medium" in gpt1_gen_quality_values
    assert "high" in gpt1_gen_quality_values
    _param_by_key(gpt1_gen, "output_format")   # must exist
    _param_by_key(gpt1_gen, "background")       # must exist

    # gpt-image-1-edit: quality must include "auto" (matches generate node and API spec);
    # size must include "auto" option.
    gpt1_edit = definitions["gpt-image-1-edit"]
    gpt1_edit_quality_values = {o["value"] for o in _param_by_key(gpt1_edit, "quality")["options"]}
    assert "auto" in gpt1_edit_quality_values, "gpt-image-1-edit quality must include 'auto'"
    assert _param_by_key(gpt1_edit, "quality")["default"] == "auto"
    gpt1_edit_size_values = {o["value"] for o in _param_by_key(gpt1_edit, "size")["options"]}
    assert "auto" in gpt1_edit_size_values, "gpt-image-1-edit size must include 'auto'"
    assert _param_by_key(gpt1_edit, "size")["default"] == "auto"

    # dalle-3-generate: must have style param with vivid/natural options; must NOT have
    # output_format or background (DALL-E 3 does not support GPT-image-only params).
    dalle3 = definitions["dalle-3-generate"]
    dalle3_style_values = {o["value"] for o in _param_by_key(dalle3, "style")["options"]}
    assert dalle3_style_values == {"vivid", "natural"}, "dalle-3 style must be vivid or natural"
    assert _param_by_key(dalle3, "style")["default"] == "vivid"
    dalle3_quality_values = {o["value"] for o in _param_by_key(dalle3, "quality")["options"]}
    assert dalle3_quality_values == {"standard", "hd"}, "dalle-3 quality must be standard or hd"

    # gpt-image-2-generate: must have moderation param with auto/low; no background or style.
    gpt2_gen = definitions["gpt-image-2-generate"]
    gpt2_mod_values = {o["value"] for o in _param_by_key(gpt2_gen, "moderation")["options"]}
    assert gpt2_mod_values == {"auto", "low"}, "gpt-image-2-generate moderation must be auto or low"
    gpt2_gen_quality_values = {o["value"] for o in _param_by_key(gpt2_gen, "quality")["options"]}
    assert "auto" in gpt2_gen_quality_values
    assert "high" in gpt2_gen_quality_values

    # gpt-image-2-edit: same param surface as generate.
    gpt2_edit = definitions["gpt-image-2-edit"]
    gpt2_edit_mod_values = {o["value"] for o in _param_by_key(gpt2_edit, "moderation")["options"]}
    assert gpt2_edit_mod_values == {"auto", "low"}, "gpt-image-2-edit moderation must be auto or low"
    # edit uses 'images' port (plural), not 'image'
    gpt2_edit_input_ids = {p["id"] for p in gpt2_edit["inputPorts"]}
    assert "images" in gpt2_edit_input_ids, "gpt-image-2-edit must use port id 'images' (plural)"

    # --- Wan 2.6 nodes (verified 2026-05-17 against fal.ai/models/wan/v2.6/*) ---

    # wan-2-6-t2v: duration must be integer enum (5/10/15, no 's' suffix);
    # aspect_ratio must expose all 5 API options; generate_audio default must be True.
    wan_t2v = definitions["wan-2-6-t2v"]
    wan_t2v_duration_values = {o["value"] for o in _param_by_key(wan_t2v, "duration")["options"]}
    assert wan_t2v_duration_values == {5, 10, 15}, (
        "wan-2-6-t2v duration must be integer enum {5, 10, 15}, not string '5s'"
    )
    assert _param_by_key(wan_t2v, "duration")["default"] == 5
    wan_t2v_ar_values = {o["value"] for o in _param_by_key(wan_t2v, "aspect_ratio")["options"]}
    assert wan_t2v_ar_values == {"16:9", "9:16", "1:1", "4:3", "3:4"}, (
        "wan-2-6-t2v aspect_ratio must expose all 5 API options"
    )
    assert _param_by_key(wan_t2v, "generate_audio")["default"] is True, (
        "wan-2-6-t2v generate_audio default must be True (API default)"
    )
    _param_by_key(wan_t2v, "enable_prompt_expansion")   # must exist
    _param_by_key(wan_t2v, "multi_shots")                # must exist
    _param_by_key(wan_t2v, "enable_safety_checker")      # must exist
    # resolution must NOT expose 480p (not in API)
    wan_t2v_res_values = {o["value"] for o in _param_by_key(wan_t2v, "resolution")["options"]}
    assert "480p" not in wan_t2v_res_values, "wan-2-6-t2v must not expose 480p (not in API)"
    assert wan_t2v_res_values == {"720p", "1080p"}
    # apiEndpoint must not have fal-ai/ prefix
    assert wan_t2v["apiEndpoint"] == "wan/v2.6/text-to-video", (
        "wan-2-6-t2v apiEndpoint must be 'wan/v2.6/text-to-video' (no fal-ai/ prefix)"
    )

    # wan-2-6-i2v: same duration/resolution fixes; generate_audio default True;
    # apiEndpoint must not have fal-ai/ prefix.
    wan_i2v = definitions["wan-2-6-i2v"]
    wan_i2v_duration_values = {o["value"] for o in _param_by_key(wan_i2v, "duration")["options"]}
    assert wan_i2v_duration_values == {5, 10, 15}, (
        "wan-2-6-i2v duration must be integer enum {5, 10, 15}"
    )
    assert _param_by_key(wan_i2v, "duration")["default"] == 5
    wan_i2v_res_values = {o["value"] for o in _param_by_key(wan_i2v, "resolution")["options"]}
    assert "480p" not in wan_i2v_res_values, "wan-2-6-i2v must not expose 480p (not in API)"
    assert wan_i2v_res_values == {"720p", "1080p"}
    assert _param_by_key(wan_i2v, "generate_audio")["default"] is True, (
        "wan-2-6-i2v generate_audio default must be True"
    )
    _param_by_key(wan_i2v, "enable_prompt_expansion")
    _param_by_key(wan_i2v, "multi_shots")
    _param_by_key(wan_i2v, "enable_safety_checker")
    assert wan_i2v["apiEndpoint"] == "wan/v2.6/image-to-video", (
        "wan-2-6-i2v apiEndpoint must be 'wan/v2.6/image-to-video' (no fal-ai/ prefix)"
    )

    # wan-2-6-r2v: duration only 5/10 (API limit); no 480p; default resolution 1080p;
    # apiEndpoint must not have fal-ai/ prefix; video1/video2/video3 ports present.
    wan_r2v = definitions["wan-2-6-r2v"]
    wan_r2v_duration_values = {o["value"] for o in _param_by_key(wan_r2v, "duration")["options"]}
    assert wan_r2v_duration_values == {5, 10}, (
        "wan-2-6-r2v duration must be {5, 10} only (API does not support 15s)"
    )
    assert _param_by_key(wan_r2v, "duration")["default"] == 5
    wan_r2v_res_values = {o["value"] for o in _param_by_key(wan_r2v, "resolution")["options"]}
    assert "480p" not in wan_r2v_res_values, "wan-2-6-r2v must not expose 480p"
    assert wan_r2v_res_values == {"720p", "1080p"}
    assert _param_by_key(wan_r2v, "resolution")["default"] == "1080p", (
        "wan-2-6-r2v resolution default must be 1080p (API default)"
    )
    wan_r2v_ar_values = {o["value"] for o in _param_by_key(wan_r2v, "aspect_ratio")["options"]}
    assert wan_r2v_ar_values == {"16:9", "9:16", "1:1", "4:3", "3:4"}, (
        "wan-2-6-r2v aspect_ratio must expose all 5 API options"
    )
    _param_by_key(wan_r2v, "enable_prompt_expansion")
    _param_by_key(wan_r2v, "multi_shots")
    _param_by_key(wan_r2v, "enable_safety_checker")
    assert wan_r2v["apiEndpoint"] == "wan/v2.6/reference-to-video", (
        "wan-2-6-r2v apiEndpoint must be 'wan/v2.6/reference-to-video' (no fal-ai/ prefix)"
    )
    wan_r2v_input_ids = {p["id"] for p in wan_r2v["inputPorts"]}
    assert "video1" in wan_r2v_input_ids, "wan-2-6-r2v must have video1 input port"
    assert "video2" in wan_r2v_input_ids, "wan-2-6-r2v must have video2 input port"
    assert "video3" in wan_r2v_input_ids, "wan-2-6-r2v must have video3 input port"
    assert "image" not in gpt2_edit_input_ids, "gpt-image-2-edit must not use singular 'image' input port"

    # --- Luma Ray 2 nodes (verified 2026-05-17 against fal.ai/models/fal-ai/luma-dream-machine/ray-2/api) ---

    # luma-ray2-t2v: aspect_ratio must expose all 6 API options (16:9, 9:16, 4:3, 3:4, 21:9, 9:21);
    # must NOT expose 1:1 (not in API); resolution default must be 540p (API default, not 720p).
    luma_t2v = definitions["luma-ray2-t2v"]
    luma_t2v_ar_values = {o["value"] for o in _param_by_key(luma_t2v, "aspect_ratio")["options"]}
    assert luma_t2v_ar_values == {"16:9", "9:16", "4:3", "3:4", "21:9", "9:21"}, (
        "luma-ray2-t2v aspect_ratio must expose all 6 API options (16:9, 9:16, 4:3, 3:4, 21:9, 9:21)"
    )
    assert "1:1" not in luma_t2v_ar_values, (
        "luma-ray2-t2v must not expose 1:1 aspect_ratio (not in API)"
    )
    assert _param_by_key(luma_t2v, "resolution")["default"] == "540p", (
        "luma-ray2-t2v resolution default must be '540p' (API default)"
    )
    luma_t2v_duration_values = {o["value"] for o in _param_by_key(luma_t2v, "duration")["options"]}
    assert luma_t2v_duration_values == {"5s", "9s"}, (
        "luma-ray2-t2v duration must be {'5s', '9s'}"
    )
    assert luma_t2v["apiEndpoint"] == "fal-ai/luma-dream-machine/ray-2"

    # luma-ray2-i2v: aspect_ratio must expose all 6 API options including 9:21.
    luma_i2v = definitions["luma-ray2-i2v"]
    luma_i2v_ar_values = {o["value"] for o in _param_by_key(luma_i2v, "aspect_ratio")["options"]}
    assert luma_i2v_ar_values == {"16:9", "9:16", "4:3", "3:4", "21:9", "9:21"}, (
        "luma-ray2-i2v aspect_ratio must expose all 6 API options including 9:21"
    )
    assert luma_i2v["apiEndpoint"] == "fal-ai/luma-dream-machine/ray-2/image-to-video"
    luma_i2v_input_ids = {p["id"] for p in luma_i2v["inputPorts"]}
    assert "image" in luma_i2v_input_ids, "luma-ray2-i2v must have image input port"
    assert "end_image" in luma_i2v_input_ids, "luma-ray2-i2v must have end_image input port"

    # luma-ray2-flash-modify: must have mode param (not aspect_ratio/resolution/duration);
    # prompt must NOT be required; must have image input port for reference image.
    luma_fm = definitions["luma-ray2-flash-modify"]
    luma_fm_mode = _param_by_key(luma_fm, "mode")
    luma_fm_mode_values = {o["value"] for o in luma_fm_mode["options"]}
    assert luma_fm_mode_values == {
        "adhere_1", "adhere_2", "adhere_3",
        "flex_1", "flex_2", "flex_3",
        "reimagine_1", "reimagine_2", "reimagine_3",
    }, "luma-ray2-flash-modify mode must have all 9 ModeEnum values"
    assert luma_fm_mode["default"] == "flex_1", (
        "luma-ray2-flash-modify mode default must be 'flex_1'"
    )
    # Must NOT have aspect_ratio, resolution, or duration — they are not in the flash-modify API
    luma_fm_param_keys = {
        p["key"]
        for group in ("params", "sharedParams", "falParams", "directParams")
        for p in luma_fm.get(group, []) or []
    }
    assert "aspect_ratio" not in luma_fm_param_keys, (
        "luma-ray2-flash-modify must not have aspect_ratio param (not in API)"
    )
    assert "resolution" not in luma_fm_param_keys, (
        "luma-ray2-flash-modify must not have resolution param (not in API)"
    )
    assert "duration" not in luma_fm_param_keys, (
        "luma-ray2-flash-modify must not have duration param (not in API)"
    )
    luma_fm_input_ids = {p["id"] for p in luma_fm["inputPorts"]}
    assert "video" in luma_fm_input_ids, "luma-ray2-flash-modify must have video input port"
    assert "image" in luma_fm_input_ids, "luma-ray2-flash-modify must have image input port (reference)"
    luma_fm_prompt_port = next(p for p in luma_fm["inputPorts"] if p["id"] == "prompt")
    assert luma_fm_prompt_port["required"] is False, (
        "luma-ray2-flash-modify prompt port must not be required (API: optional)"
    )
    assert luma_fm["apiEndpoint"] == "fal-ai/luma-dream-machine/ray-2-flash/modify"
