"""What model_catalog / model_schema say about a model's ports comes from
services/universal_ports.py, the function the canvas, edit_canvas and
look_at_canvas use (2026-10-21, the follow-up #128 and #132 both named).

#128 gave agents the model catalogs with its own reading of a Replicate
schema (`_replicate_inputs`, `_replicate_output`) and nothing about an
OpenRouter or Nous Portal model's ports; #132 moved the canvas's port rules
into the backend. Here the tools answer with that one function's ports, so
what an agent reads before an edit is what the edit accepts and what the
canvas draws after it.

Model data comes from the routes' own cache (no network, nothing billed).
"""
from __future__ import annotations

import asyncio
import copy
import json

import pytest
from fastapi.testclient import TestClient

import mcp_server
from nebula_api import NebulaAPI
from services import universal_ports
from services.model_cache import model_cache
from tests.conftest import PERSON

OPENROUTER = {"models": [
    # Vision in, image (and text) out.
    {"id": "google/gemini-3-pro-image", "name": "Google: Gemini 3 Pro Image", "input_modalities": ["text", "image"],
     "output_modalities": ["text", "image"], "context_length": 65536, "pricing": {}},
    # Vision in, text out.
    {"id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "input_modalities": ["text", "image"],
     "output_modalities": ["text"], "context_length": 1000000, "pricing": {"prompt": "0.000005"}},
    # Text only.
    {"id": "openai/gpt-6", "name": "OpenAI: GPT-6", "input_modalities": ["text"],
     "output_modalities": ["text"], "context_length": 400000, "pricing": {}},
    # Image only out (no text output port).
    {"id": "acme/painter", "name": "Acme Painter", "input_modalities": ["text"],
     "output_modalities": ["image"], "pricing": {}},
], "count": 4}
NOUS = {"models": [
    {"id": "hermes-5", "name": "Hermes 5", "input_modalities": ["text"], "output_modalities": ["text"]},
    {"id": "hermes-5-vision", "name": "Hermes 5 Vision", "input_modalities": ["text", "image"],
     "output_modalities": ["text", "image"]},
], "count": 2}
KONTEXT = {
    "version_id": "v123", "model_id": "black-forest-labs/flux-kontext-pro", "description": "Edit images with text",
    "input_schema": {"type": "object", "required": ["prompt", "input_image"], "properties": {
        "prompt": {"type": "string", "description": "What to change"},
        "input_image": {"type": "string", "format": "uri", "description": "Image to edit"},
        "style_ref": {"type": "string", "x-uploadable": True},
        "aspect_ratio": {"type": "string", "enum": ["match_input_image", "1:1", "16:9"], "default": "match_input_image"},
        "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647},
    }},
    "output_schema": {"type": "string", "format": "uri"},
    # The route keeps the model's example run's output (2026-10-21): it types the file.
    "default_example_output": "https://replicate.delivery/xezq/kontext/output.jpg",
}
CAPTIONER = {
    "version_id": "v9", "model_id": "acme/captioner", "description": "Captions an image",
    "input_schema": {"type": "object", "properties": {"image": {"type": "string", "format": "uri"}}},
    "output_schema": {"type": "array", "items": {"type": "string"}},
}


def _ids(ports):
    return [port["id"] for port in ports]


def _nous_signed_in(monkeypatch):
    from routes import nous_proxy

    class Cred:
        cache_identity = "fixture-identity"
        base_url = "https://nous.invalid"
        access_token = "unused"

    monkeypatch.setattr(nous_proxy, "load_nous_credential", lambda: Cred())
    model_cache.set("nous:models", ("fixture-identity", copy.deepcopy(NOUS)), ttl=300)


def _warm(monkeypatch):
    model_cache.set("openrouter:models", copy.deepcopy(OPENROUTER), ttl=300)
    model_cache.set("replicate:schema:black-forest-labs/flux-kontext-pro", copy.deepcopy(KONTEXT), ttl=300)
    model_cache.set("replicate:schema:acme/captioner", copy.deepcopy(CAPTIONER), ttl=300)
    _nous_signed_in(monkeypatch)


@pytest.fixture
def nebula(monkeypatch, person):
    import main

    monkeypatch.delenv("NEBULA_AGENT_TOKEN", raising=False)
    monkeypatch.delenv("NEBULA_AGENT_NAME", raising=False)
    model_cache.clear()
    with TestClient(main.app, client=("127.0.0.1", 50000)) as http:
        http.delete("/api/graph?force=true", headers=PERSON)
        monkeypatch.setattr(mcp_server, "_api", lambda: NebulaAPI("http://testserver", client=http))
        _warm(monkeypatch)
        yield http
        http.delete("/api/graph?force=true", headers=PERSON)
    model_cache.clear()


def _call_tool(name: str, arguments: dict) -> dict:
    """A tool called the way a client calls it, through FastMCP."""
    result = asyncio.run(mcp_server.mcp.call_tool(name, arguments))
    if isinstance(result, tuple):
        structured = result[1]
        return structured.get("result", structured) if isinstance(structured, dict) else structured
    return json.loads(result[0].text)


def _row(catalog: dict, model: str) -> dict:
    return next(row for row in catalog["models"] if row["id"] == model)


def _function_ports(definition_id: str, model: str, data: dict) -> dict:
    configured = universal_ports.configure(definition_id, {}, model, data)
    return {"inputs": configured.inputs, "outputs": configured.outputs}


def _drawn(http, node_id: str) -> dict:
    exported = http.get("/api/graph/export", headers=PERSON).json()
    node = next(node for node in exported["nodes"] if node["id"] == node_id)
    return {"inputs": node["data"]["dynamicInputPorts"], "outputs": node["data"]["dynamicOutputPorts"]}


# -- one source: model_schema's ports are universal_ports' --------------------

@pytest.mark.parametrize("model", [row["id"] for row in OPENROUTER["models"]])
def test_openrouter_model_schema_ports_are_the_functions(nebula, model):
    schema = mcp_server.model_schema("openrouter", model)
    assert schema["ports"] == _function_ports("openrouter-universal", model, _row(OPENROUTER, model))


def test_openrouter_model_schema_ports_literally(nebula):
    image = mcp_server.model_schema("openrouter", "google/gemini-3-pro-image")["ports"]
    assert _ids(image["inputs"]) == ["messages", "images"] and _ids(image["outputs"]) == ["text", "image"]
    assert image["inputs"][1] == {"id": "images", "label": "Images", "dataType": "Image", "required": False,
                                  "multiple": True}
    assert image["outputs"][1]["dataType"] == "Image"
    text = mcp_server.model_schema("openrouter", "openai/gpt-6")["ports"]
    assert _ids(text["inputs"]) == ["messages"] and _ids(text["outputs"]) == ["text"]
    painter = mcp_server.model_schema("openrouter", "acme/painter")["ports"]
    assert _ids(painter["outputs"]) == ["image"]


@pytest.mark.parametrize("model", [row["id"] for row in NOUS["models"]])
def test_nous_model_schema_ports_are_the_functions(nebula, model):
    schema = mcp_server.model_schema("nous", model)
    assert schema["node"] == "nous-portal-universal"
    assert schema["ports"] == _function_ports("nous-portal-universal", model, _row(NOUS, model))


def test_nous_model_schema_ports_literally(nebula):
    # As the model list declares it: a text model has no `images` input,
    # though the node's definition lists one for a node never configured.
    assert _ids(mcp_server.model_schema("nous", "hermes-5")["ports"]["inputs"]) == ["messages"]
    vision = mcp_server.model_schema("nous", "hermes-5-vision")["ports"]
    assert _ids(vision["inputs"]) == ["messages", "images"] and _ids(vision["outputs"]) == ["text", "image"]


@pytest.mark.parametrize("model,data", [("black-forest-labs/flux-kontext-pro", KONTEXT), ("acme/captioner", CAPTIONER)])
def test_replicate_model_schema_ports_and_params_are_the_functions(nebula, model, data):
    schema = mcp_server.model_schema("replicate", model)
    configured = universal_ports.configure("replicate-universal", {}, model, data)
    assert schema["ports"] == {"inputs": configured.inputs, "outputs": configured.outputs}
    # The model's other inputs are the Inspector's controls, from the same split.
    assert schema["params"] == configured.dynamic_params


def test_replicate_model_schema_ports_literally(nebula):
    kontext = mcp_server.model_schema("replicate", "black-forest-labs/flux-kontext-pro")
    assert kontext["ports"]["inputs"] == [
        {"id": "input_image", "label": "Input Image", "dataType": "Image", "required": True},
        {"id": "style_ref", "label": "Style Ref", "dataType": "Image", "required": False}]
    assert kontext["ports"]["outputs"] == [{"id": "image", "label": "Output", "dataType": "Image", "required": False}]
    params = {param["key"]: param for param in kontext["params"]}
    assert set(params) == {"prompt", "aspect_ratio", "seed"}
    assert params["prompt"]["required"] is True and params["seed"]["min"] == 0
    assert params["aspect_ratio"]["default"] == "match_input_image"
    assert kontext["versionId"] == "v123" and kontext["inputSchema"] == KONTEXT["input_schema"]
    # A list of plain strings is text, as the run names it.
    caption = mcp_server.model_schema("replicate", "acme/captioner")["ports"]
    assert _ids(caption["inputs"]) == ["image"] and caption["outputs"][0]["id"] == "text"


def test_the_mcp_server_keeps_no_port_rules_of_its_own():
    """No second derivation that can drift from services/universal_ports.py."""
    for name in ("_replicate_inputs", "_replicate_output", "_REPLICATE_OUTPUT_NOTE", "_REPLICATE_MODEL"):
        assert not hasattr(mcp_server, name), name


# -- model_catalog rows agree -------------------------------------------------

def test_openrouter_catalog_rows_show_the_functions_port_ids(nebula):
    rows = mcp_server.model_catalog("openrouter", limit=100)["models"]
    for row in rows:
        inputs, outputs = universal_ports.modality_ports(_row(OPENROUTER, row["id"]))
        assert row["ports"] == {"inputs": _ids(inputs), "outputs": _ids(outputs)}, row["id"]
    assert _row({"models": rows}, "google/gemini-3-pro-image")["ports"] == {
        "inputs": ["messages", "images"], "outputs": ["text", "image"]}
    assert _row({"models": rows}, "openai/gpt-6")["ports"] == {"inputs": ["messages"], "outputs": ["text"]}


def test_nous_catalog_rows_show_the_functions_port_ids(nebula):
    rows = mcp_server.model_catalog("nous")["models"]
    assert {row["id"]: row["ports"] for row in rows} == {
        "hermes-5": {"inputs": ["messages"], "outputs": ["text"]},
        "hermes-5-vision": {"inputs": ["messages", "images"], "outputs": ["text", "image"]}}


def test_quiver_rows_have_no_model_ports(nebula):
    # The Quiver nodes' ports are their definitions' (describe_node).
    model_cache.set("quiver:models", {"models": [{"id": "arrow-1.1", "name": "Arrow 1.1"}], "count": 1}, ttl=60)
    assert "ports" not in mcp_server.model_catalog("quiver")["models"][0]


# -- an agent builds what model_schema describes, in one edit -----------------

def test_an_agent_builds_an_openrouter_vision_and_image_model_in_one_edit(nebula):
    model = "google/gemini-3-pro-image"
    read = _call_tool("model_schema", {"provider": "openrouter", "model_id": model})
    assert "images" in _ids(read["ports"]["inputs"]) and "image" in _ids(read["ports"]["outputs"])
    built = _call_tool("edit_canvas", {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+paint", "definitionId": read["node"], "params": {read["param"]: model}},
                  {"ref": "+compare", "definitionId": "image-compare"}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+paint", "targetHandle": "images"},
                  {"source": "+paint", "sourceHandle": "image", "target": "+compare", "targetHandle": "imageA"}],
    })
    assert built["summary"] == "added 3, wired 2"
    paint = built["idMap"]["+paint"]
    expected = {"inputs": _ids(read["ports"]["inputs"]), "outputs": _ids(read["ports"]["outputs"])}
    assert built["modelPorts"][paint] == {"model": model, **expected}
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    assert canvas[paint]["ports"] == expected
    # And the canvas draws exactly the ports model_schema gave.
    assert _drawn(nebula, paint) == read["ports"]


def test_an_agent_builds_a_replicate_model_in_one_edit(nebula):
    model = "black-forest-labs/flux-kontext-pro"
    read = _call_tool("model_schema", {"provider": "replicate", "model_id": model})
    built = _call_tool("edit_canvas", {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+style", "definitionId": "image-input"},
                  {"ref": "+edit", "definitionId": read["node"],
                   "params": {read["param"]: model, "prompt": "make it dusk"}},
                  {"ref": "+compare", "definitionId": "image-compare"}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+edit", "targetHandle": "input_image"},
                  {"source": "+style", "sourceHandle": "image", "target": "+edit", "targetHandle": "style_ref"},
                  {"source": "+edit", "sourceHandle": "image", "target": "+compare", "targetHandle": "imageA"}],
    })
    assert built["summary"] == "added 4, wired 3"
    edit = built["idMap"]["+edit"]
    expected = {"inputs": _ids(read["ports"]["inputs"]), "outputs": _ids(read["ports"]["outputs"])}
    assert expected == {"inputs": ["input_image", "style_ref"], "outputs": ["image"]}
    assert built["modelPorts"][edit] == {"model": model, **expected}
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    assert canvas[edit]["ports"] == expected
    assert _drawn(nebula, edit) == read["ports"]


def test_an_agent_wires_a_nous_image_output_in_one_edit(nebula):
    read = _call_tool("model_schema", {"provider": "nous", "model_id": "hermes-5-vision"})
    built = _call_tool("edit_canvas", {
        "nodes": [{"ref": "+photo", "definitionId": "image-input"},
                  {"ref": "+hermes", "definitionId": read["node"], "params": {"model": "hermes-5-vision"}},
                  {"ref": "+compare", "definitionId": "image-compare"}],
        "edges": [{"source": "+photo", "sourceHandle": "image", "target": "+hermes", "targetHandle": "images"},
                  {"source": "+hermes", "sourceHandle": "image", "target": "+compare", "targetHandle": "imageA"}],
    })
    hermes = built["idMap"]["+hermes"]
    canvas = {node["id"]: node for node in _call_tool("look_at_canvas", {})["nodes"]}
    assert canvas[hermes]["ports"] == {"inputs": ["messages", "images"], "outputs": ["text", "image"]}
    assert _drawn(nebula, hermes) == read["ports"]


# -- docs ----------------------------------------------------------------------

def test_the_docs_say_the_ports_come_from_the_model():
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    setup = (repo / "docs" / "MCP-SETUP.md").read_text()
    assert "is open work" not in setup
    assert "keeps them in the browser only" not in setup
    assert "`ports`" in setup.split("### Universal nodes over MCP", 1)[1].split("\n### ", 1)[0]
    skill = (repo / "skills" / "nebula" / "SKILL.md").read_text()
    assert "model_schema" in skill
    for tool in (mcp_server.model_catalog, mcp_server.model_schema):
        assert "universal_ports" in (tool.__doc__ or "") or "ports" in (tool.__doc__ or "")
    assert "`ports`" in (mcp_server.model_schema.__doc__ or "")
    assert "`ports`" in (mcp_server.model_catalog.__doc__ or "")


def test_the_replicate_docs_agents_read_say_the_ports_come_from_the_model():
    """The project's `replicate` skill (both copies) and the API guide said the
    node declares no ports and to wire `prompt` or `video`; since #132 a set
    model gives only its file-input ports and one `image`/`text` output, and
    edit_canvas refuses anything else."""
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    skills = [repo / ".agents" / "skills" / "replicate" / "SKILL.md",
              repo / ".claude" / "skills" / "replicate" / "SKILL.md"]
    assert skills[0].read_text() == skills[1].read_text()
    for path in skills:
        text = path.read_text()
        assert "none declared" not in text, path
        assert "add ports at graph-build time" not in text, path
        assert "Text → `prompt`" not in text, path
        node_section = text.split("## In the nebula_nodes context", 1)[1].split("\n### ", 1)[0]
        for name in ("model_schema", "replicate_inputs", "replicate_output", "params"):
            assert name in node_section, (path, name)
    guide = (repo / "docs" / "api-guides" / "replicate.md").read_text()
    assert "None pre-defined" not in guide
    assert "no fixed input or output ports" not in guide
    assert "**no fixed ports**" not in guide
    assert "model_schema" in guide
