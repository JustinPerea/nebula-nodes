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
    ltx = definitions["ltx-video-2"]
    ltx_resolution_values = {option["value"] for option in _param_by_key(ltx, "resolution")["options"]}
    ltx_duration_values = {str(option["value"]) for option in _param_by_key(ltx, "duration")["options"]}
    assert ltx_resolution_values == {"1080p", "1440p", "2160p"}
    assert ltx_duration_values == {"6", "8", "10"}

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
