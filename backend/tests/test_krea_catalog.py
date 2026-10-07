"""Pins provider contracts that must survive future public-catalog refreshes."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator
import pytest

ROOT = Path(__file__).resolve().parents[2]
CATALOG = json.loads((ROOT / "backend/data/krea_gateway_models.json").read_text())
REGISTRY = json.loads((ROOT / "backend/data/node_definitions.json").read_text())
SPEC = importlib.util.spec_from_file_location("sync_krea_catalog", ROOT / "scripts/sync-krea-catalog.py")
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


def test_public_catalog_and_offline_sync_are_pinned(monkeypatch):
    assert CATALOG["sourceUrl"] == "https://api.krea.ai/openapi.json"
    assert len(CATALOG["openapiSha256"]) == 64

    def network_forbidden(*_args, **_kwargs):
        raise AssertionError("Catalog checks must not contact the provider")

    monkeypatch.setattr(SYNC.urllib.request, "urlopen", network_forbidden)
    monkeypatch.setattr(sys, "argv", ["sync-krea-catalog.py", "--check"])
    SYNC.main()


@pytest.mark.parametrize("node_id,model", CATALOG["models"].items())
def test_each_model_has_a_valid_request_contract_and_valid_control_defaults(node_id, model):
    schema = model["requestSchema"]
    Draft202012Validator.check_schema(schema)
    definition = REGISTRY[node_id]
    assert definition["apiProvider"] == "krea"
    assert definition["envKeyName"] == "KREA_API_TOKEN"
    assert definition["apiEndpoint"] == model["endpoint"]
    assert model["endpoint"].startswith(("/generate/image/", "/generate/video/"))
    assert {param["key"] for param in definition["params"]} == set(schema["properties"]) | {"_kreaAuth"}
    for param in definition["params"]:
        if param["key"] == "_kreaAuth":
            assert param["default"] == "api-token"
            assert {option["value"] for option in param["options"]} == {"api-token", "mcp"}
            continue
        assert param["required"] == (param["key"] in schema.get("required", []))
        if "default" in param:
            default = param["default"]
            if param["key"] in model["jsonParams"]:
                default = json.loads(default)
            Draft202012Validator(schema["properties"][param["key"]]).validate(default)


def test_google_and_openai_reference_ports_keep_provider_limits():
    for node_id in ("krea-image-openai-gpt-image-2", "krea-image-google-nano-banana-2"):
        model = CATALOG["models"][node_id]
        port = next(port for port in model["inputPorts"] if port["id"] == "image_urls")
        assert port["dataType"] == "Image" and port["multiple"]
        assert port.get("maxConnections") == model["requestSchema"]["properties"]["image_urls"].get("maxItems")
    video = REGISTRY["krea-video-kling-kling-3-0"]
    inputs = {port["id"]: port["dataType"] for port in video["inputPorts"]}
    assert inputs["start_image"] == inputs["end_image"] == "Image"
    assert video["outputPorts"][0]["dataType"] == "Video"


def test_nullable_scalar_controls_are_numeric_and_preserve_bounds():
    schema = {"properties": {"seed": {"type": ["number", "null"], "minimum": 0, "maximum": 10}}}
    params, _, json_params = SYNC.fields_for(schema)
    assert params == [{"key": "seed", "label": "Seed", "required": False,
                       "type": "float", "min": 0, "max": 10, "step": 0.01}]
    assert not json_params


def test_nested_duration_choices_become_real_numeric_enums():
    schema = {"properties": {"duration": {"anyOf": [
        {"anyOf": [{"type": "number", "const": 5}, {"type": "number", "const": 10}]},
        {"type": "number", "const": 15}], "default": 5}}}
    params, _, json_params = SYNC.fields_for(schema)
    assert params[0]["type"] == "enum"
    assert [option["value"] for option in params[0]["options"]] == [5, 10, 15]
    assert params[0]["default"] == 5
    assert not json_params


def test_gateway_additions_preserve_original_provider_choices():
    assert REGISTRY["gpt-image-2-generate"]["apiProvider"] == "openai"
    assert REGISTRY["nano-banana"]["apiProvider"] == "google"
    assert REGISTRY["krea-2-generate"]["apiEndpoint"] == "/generate/image/krea/krea-2/{variant}"
    assert {"krea-style-train", "krea-style-search", "krea-image-style-reference",
            "krea-style", "krea-moodboard"}.issubset(REGISTRY)


def test_regeneration_preserves_unrelated_inline_registry_formatting():
    source = '{\n  "existing": { "params": [{ "value": 1 }], "id": "existing" }\n}\n'
    updated = SYNC.registry_source(source, {"new": {"docUrl": SYNC.DOC_URL}})
    assert source[:-3] in updated
    assert SYNC.registry_source(updated, {"new": {"docUrl": SYNC.DOC_URL}}) == updated
