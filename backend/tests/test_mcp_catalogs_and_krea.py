"""MCP twins of the universal nodes' model catalogs and of Krea discovery
(MCP parity audit U10 and U14, 2026-10-20).

Each tool goes through the route the canvas uses (/api/openrouter/models,
/api/nous/models, /api/quiver/models, /api/replicate/schema/..., and
/api/krea/tools[/call]), here with the HTTP routed into the FastAPI app and
the provider answers seeded in the routes' own cache, so nothing leaves
the machine and nothing is spent.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import mcp_server
from nebula_api import NebulaAPI, NebulaAPIError
from services import krea_agent_mcp
from services.model_cache import model_cache

REPO = Path(__file__).resolve().parents[2]

OPENROUTER = {"models": [
    {"id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "input_modalities": ["text", "image"],
     "output_modalities": ["text"], "context_length": 1000000, "pricing": {"prompt": "0.000005"}},
    {"id": "google/gemini-3-pro-image", "name": "Google: Gemini 3 Pro Image", "input_modalities": ["text", "image"],
     "output_modalities": ["text", "image"], "context_length": 65536, "pricing": {}},
    {"id": "openai/gpt-6", "name": "OpenAI: GPT-6", "input_modalities": ["text"],
     "output_modalities": ["text"], "context_length": 400000, "pricing": {}},
], "count": 3}
QUIVER = {"models": [{"id": "arrow-1.1", "name": "Arrow 1.1", "description": "SVG", "input_modalities": ["text"],
                      "output_modalities": ["svg"], "supported_operations": ["generate"], "pricing_credits": 1}],
          "count": 1}
REPLICATE = {
    "version_id": "v123", "model_id": "black-forest-labs/flux-kontext-pro", "description": "Edit images with text",
    "input_schema": {"type": "object", "required": ["prompt"], "properties": {
        "prompt": {"type": "string", "description": "What to change"},
        "input_image": {"type": "string", "format": "uri", "description": "Image to edit"},
        "aspect_ratio": {"type": "string", "enum": ["match_input_image", "1:1", "16:9"], "default": "match_input_image"},
        "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647},
    }},
    "output_schema": {"type": "string", "format": "uri"},
}


@pytest.fixture
def nebula(monkeypatch):
    import main

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    model_cache.clear()
    # A loopback client, as an MCP server on this machine is (the Krea routes check it).
    with TestClient(main.app, client=("127.0.0.1", 50000)) as http:
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
        yield http
    model_cache.clear()


# -- U10: model catalogs ------------------------------------------------------

def test_model_catalog_searches_openrouter_and_names_the_node_it_fills(nebula):
    model_cache.set("openrouter:models", OPENROUTER, ttl=60)
    found = mcp_server.model_catalog("openrouter", query="claude")
    assert [model["id"] for model in found["models"]] == ["anthropic/claude-opus-5.5"]
    assert found["total"] == 3 and found["matched"] == 1
    assert found["node"] == "openrouter-universal" and found["param"] == "model"
    # Every word must match, in the id or the name, any case.
    assert [m["id"] for m in mcp_server.model_catalog("OpenRouter", query="google IMAGE")["models"]] == [
        "google/gemini-3-pro-image"]
    capped = mcp_server.model_catalog("openrouter", limit=2)
    assert len(capped["models"]) == 2 and capped["matched"] == 3 and "limit" in capped["note"]


def test_model_catalog_reads_quiver_and_nous(nebula, monkeypatch):
    model_cache.set("quiver:models", QUIVER, ttl=60)
    quiver = mcp_server.model_catalog("quiver")
    assert quiver["models"][0]["id"] == "arrow-1.1"
    assert quiver["node"] == ["quiver-arrow-generate", "quiver-arrow-vectorize"]

    from routes import nous_proxy

    class Cred:
        cache_identity = "fixture-identity"
        base_url = "https://nous.invalid"
        access_token = "unused"

    monkeypatch.setattr(nous_proxy, "load_nous_credential", lambda: Cred())
    model_cache.set("nous:models", ("fixture-identity", {"models": [{"id": "hermes-5", "name": "Hermes 5"}], "count": 1}),
                    ttl=60)
    nous = mcp_server.model_catalog("nous", query="hermes")
    assert nous["models"][0]["id"] == "hermes-5" and nous["node"] == "nous-portal-universal"


def test_model_catalog_says_what_to_do_without_a_key_or_for_replicate(nebula, monkeypatch):
    import main

    monkeypatch.setattr("routes.openrouter_proxy.load_settings", lambda: {"apiKeys": {}})
    with pytest.raises(NebulaAPIError) as missing:
        mcp_server.model_catalog("openrouter")
    assert missing.value.status == 400 and "OPENROUTER_API_KEY" in missing.value.detail
    with pytest.raises(ValueError, match="model_schema"):
        mcp_server.model_catalog("replicate")
    with pytest.raises(ValueError, match="openrouter, nous, quiver"):
        mcp_server.model_catalog("midjourney")
    assert main  # the app is the one the canvas talks to


def test_model_schema_reads_a_replicate_model_into_ports_and_params(nebula):
    model_cache.set("replicate:schema:black-forest-labs/flux-kontext-pro", REPLICATE, ttl=60)
    schema = mcp_server.model_schema("replicate", "black-forest-labs/flux-kontext-pro")
    assert schema["node"] == "replicate-universal" and schema["param"] == "model_id"
    assert schema["versionId"] == "v123"
    inputs = {entry["key"]: entry for entry in schema["inputs"]}
    assert inputs["input_image"]["port"] is True and inputs["prompt"]["port"] is False
    assert inputs["prompt"]["required"] is True
    assert inputs["aspect_ratio"]["options"] == ["match_input_image", "1:1", "16:9"]
    assert inputs["seed"]["min"] == 0
    assert schema["inputSchema"] == REPLICATE["input_schema"]
    assert schema["outputSchema"] == REPLICATE["output_schema"]
    with pytest.raises(ValueError, match="owner/name"):
        mcp_server.model_schema("replicate", "not-a-model")


@pytest.mark.parametrize("output_schema,port", [
    ({"type": "string", "format": "uri"}, "image"),
    ({"type": "array", "items": {"type": "string", "format": "uri"}}, "image"),
    ({"type": "string"}, "text"),
    ({"type": "array", "items": {"type": "string"}}, "text"),
    ({}, "text"),
])
def test_model_schema_says_which_output_port_to_wire_from(nebula, output_schema, port):
    """The Replicate node declares no output ports: the run names its output by
    what Replicate returns (handlers/replicate_universal.py _infer_output_type),
    so an agent wiring the node onward needs to be told which handle to use."""
    model_cache.set("replicate:schema:acme/model", {**REPLICATE, "model_id": "acme/model",
                                                   "output_schema": output_schema}, ttl=60)
    schema = mcp_server.model_schema("replicate", "acme/model")
    assert schema["output"]["port"] == port
    assert "video" in schema["output"]["note"] and "audio" in schema["output"]["note"]


def test_model_schema_finds_one_catalog_model(nebula):
    model_cache.set("openrouter:models", OPENROUTER, ttl=60)
    entry = mcp_server.model_schema("openrouter", "google/gemini-3-pro-image")
    assert entry["model"]["output_modalities"] == ["text", "image"]
    assert entry["node"] == "openrouter-universal"
    with pytest.raises(ValueError, match="model_catalog"):
        mcp_server.model_schema("openrouter", "nobody/none")


# -- U14: Krea discovery for outside agents ----------------------------------

class _FakeKrea:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def tools(self):
        return {"tools": [
            {"name": "list_styles", "description": "Styles", "inputSchema": {"type": "object"}},
            {"name": "get_model_schema", "description": "Schema", "inputSchema": {"type": "object"}},
        ]}

    async def call_readonly(self, name, arguments):
        from services.krea_connector import ConnectorError

        self.calls.append((name, arguments))
        if name == "get_model_schema" and not arguments:
            raise ConnectorError("Invalid Krea discovery arguments")
        return {"content": [{"type": "text", "text": json.dumps({"styles": [{"id": "s1", "name": "Ink"}]})}],
                "isError": False}


@pytest.fixture
def krea(nebula, monkeypatch):
    fake = _FakeKrea()
    monkeypatch.setattr("routes.krea_connector.get_connector", lambda: fake)
    return fake


def test_krea_discovery_tools_lists_the_read_only_calls(krea):
    listed = mcp_server.krea_discovery_tools()
    assert [tool["name"] for tool in listed["tools"]] == ["list_styles", "get_model_schema"]
    assert set(listed["allowed"]) == set(krea_agent_mcp.KREA_READONLY_TOOLS)


def test_krea_discover_goes_through_the_backends_read_only_call(krea):
    answer = mcp_server.krea_discover("list_styles", {})
    assert answer["tool"] == "list_styles"
    assert answer["result"] == {"styles": [{"id": "s1", "name": "Ink"}]}
    assert krea.calls == [("list_styles", {})]
    # Krea's own validation error comes back as Nebula's refusal.
    with pytest.raises(NebulaAPIError) as invalid:
        mcp_server.krea_discover("get_model_schema", {})
    assert invalid.value.status == 400 and "Invalid Krea discovery arguments" in invalid.value.detail


def test_krea_discover_refuses_anything_but_discovery_without_calling_krea(krea):
    with pytest.raises(ValueError, match="list_models"):
        mcp_server.krea_discover("generate_image", {"prompt": "a fox"})
    assert krea.calls == []


# -- registration, annotations, docs -----------------------------------------

NEW_TOOLS = ("model_catalog", "model_schema", "krea_discovery_tools", "krea_discover")


def test_the_new_tools_are_read_only_open_world_and_listed():
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.mcp.list_tools())}
    for name in NEW_TOOLS:
        assert name in krea_agent_mcp.NEBULA_MCP_TOOLS
        annotations = tools[name].annotations
        assert annotations.readOnlyHint is True and annotations.openWorldHint is True, name
    for name in NEW_TOOLS:
        assert name in mcp_server.INSTRUCTIONS


def test_the_setup_doc_lists_the_new_tools_and_the_stop_rule():
    doc = (REPO / "docs" / "MCP-SETUP.md").read_text()
    for name in NEW_TOOLS:
        assert f"`{name}`" in doc
    assert "press Stop" in doc


def test_krea_not_connected_tells_the_agent_who_connects_it(nebula, monkeypatch):
    from services.krea_connector import ConnectorError

    class Disconnected:
        async def tools(self):
            raise ConnectorError("Connect your Krea account first")

        async def call_readonly(self, name, arguments):
            raise ConnectorError("Connect your Krea account first")

    monkeypatch.setattr("routes.krea_connector.get_connector", lambda: Disconnected())
    for call in (lambda: mcp_server.krea_discovery_tools(), lambda: mcp_server.krea_discover("list_styles")):
        with pytest.raises(NebulaAPIError) as refused:
            call()
        assert "Connect your Krea account first" in refused.value.detail
        assert "Settings > Connections > Krea" in refused.value.detail and "the person" in refused.value.detail
