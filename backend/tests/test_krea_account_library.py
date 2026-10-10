"""Krea styles, moodboards and Krea 2 on the signed-in Krea account.

Every case pins two things: the exact Krea tool call that is made, and that a
control the chosen billing path cannot honor fails before any request.
"""
from __future__ import annotations

import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from mcp.types import CallToolResult, Tool
from PIL import Image

from handlers import krea as legacy
from handlers import krea_gateway as gateway
from models.graph import GraphNode, PortValueDict
from services import output

TOOLS = Path(__file__).with_name("fixtures") / "krea_mcp_tools.json"
UPLOAD = "https://api.krea.ai/assets/presigned?sig=fixture"
ASSET = "https://assets.krea.ai/uploaded.png"
CDN = "https://media.example.test/krea-2.png"
MOODBOARD = "19c7ee04-7c40-46fa-a69d-96345bb15787"


def png():
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 40, 90)).save(buffer, format="PNG")
    return buffer.getvalue()


class Session:
    def __init__(self):
        self.calls = []
        self.definitions = [Tool.model_validate(value) for value in json.loads(TOOLS.read_text())]
        self.styles = [{"id": "style-a", "title": "Ink", "models": ["k2"]},
                       {"id": "style-b", "title": "Chrome", "models": ["flux_dev"]}]
        self.jobs = []

    async def list_tools(self):
        return SimpleNamespace(tools=self.definitions)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "get_job":
            return CallToolResult(content=[], structuredContent=self.jobs.pop(0))
        answer = {
            "list_styles": {"styles": self.styles, "next_cursor": None},
            "list_moodboards": {"moodboards": [
                {"id": MOODBOARD, "name": "Retro Web", "kind": "Preset"},
                {"id": "07a67df9-6ffa-433f-be0d-fdef62935d4b", "name": "Futurist Glam", "kind": "Preset"}]},
            "get_upload_url": {"url": UPLOAD},
            "create_style": {"job_id": "train-job", "status": "queued"},
            "create_moodboard": {"job_id": "board-job", "status": "queued"},
            "list_models": {"models": [{"id": "krea/krea-2/medium", "category": "image"}]},
            "get_model_schema": {"model": "krea/krea-2/medium", "category": "image", "endpointPath": "image/krea/krea-2/medium",
                                 "inputSchema": gateway.catalog_models()["krea-image-krea-krea-2-medium"]["requestSchema"]},
            "generate_image": {"job_id": "image-job", "status": "completed", "result": {"urls": [CDN]}},
        }.get(name, {"ok": True})
        return CallToolResult(content=[], structuredContent=answer)

    def names(self):
        return [name for name, _ in self.calls]


@pytest.fixture
def session(monkeypatch, tmp_path):
    from services import krea_connector
    active = Session()

    class Connector:
        async def list_tools(self, current):
            return (await current.list_tools()).tools

        @asynccontextmanager
        async def session(self, **_kwargs):
            yield active

    monkeypatch.setattr(krea_connector, "get_connector", Connector)
    monkeypatch.setattr(krea_connector, "connection_revision", lambda: "fixture-workspace")
    monkeypatch.setattr(gateway, "get_run_dir", lambda: tmp_path)
    monkeypatch.setattr(gateway, "POLL_INTERVAL", 0)
    monkeypatch.setattr(output, "OUTPUT_ROOT", tmp_path)
    monkeypatch.setattr(legacy, "OUTPUT_ROOT", tmp_path)
    active.root = tmp_path
    return active


def node(definition_id, **params):
    return GraphNode(id=f"{definition_id}-node", definitionId=definition_id, params=params)


def registry():
    return json.loads((Path(__file__).resolve().parents[1] / "data/node_definitions.json").read_text())


def test_legacy_krea_nodes_offer_account_billing_and_account_only_nodes_say_so():
    defs = registry()
    for node_id in ("krea-2-generate", "krea-style-search", "krea-style-train", "krea-library-manage"):
        param = next(p for p in defs[node_id]["params"] if p["key"] == "_kreaAuth")
        assert param["default"] == "api-token"
        assert [o["value"] for o in param["options"]] == ["api-token", "mcp"]
    for node_id in ("krea-moodboard-search", "krea-moodboard-create"):
        param = next(p for p in defs[node_id]["params"] if p["key"] == "_kreaAuth")
        assert [o["value"] for o in param["options"]] == ["mcp"]
        assert defs[node_id]["envKeyName"] == []
    train_models = {o["value"] for o in next(p for p in defs["krea-style-train"]["params"] if p["key"] == "model")["options"]}
    assert {"k2", "k2-large", "k1", "ltx-23-22b"} <= train_models
    # Value-only helpers never call Krea and never get a billing choice.
    for node_id in ("krea-style", "krea-moodboard", "krea-image-style-reference"):
        assert all(p["key"] != "_kreaAuth" for p in defs[node_id]["params"])


def test_engine_requires_the_connection_for_account_nodes_only(monkeypatch):
    from execution.engine import validate_graph
    from services import krea_connector
    monkeypatch.setattr(krea_connector, "is_krea_connected", lambda: False)
    for account in (node("krea-moodboard-search"), node("krea-style-train", _kreaAuth="mcp", name="x")):
        assert any("Connect your Krea account" in e.message for e in validate_graph([account], [], {}))
    old = node("krea-style-search")
    messages = [e.message for e in validate_graph([old], [], {})]
    assert any("Missing API key" in m for m in messages) and not any("Connect your Krea" in m for m in messages)


@pytest.mark.asyncio
async def test_krea_2_account_run_uses_the_gateway_route_and_uploads_through_the_account(session):
    reference = session.root / "ref.png"
    reference.write_bytes(png())
    with respx.mock as router:
        upload = router.post(UPLOAD).respond(200, content=ASSET.encode())
        router.get(CDN).respond(200, content=png(), headers={"content-type": "image/png"})
        api = router.route(host="api.krea.ai", path__startswith="/generate").respond(500)
        result = await legacy.handle_krea_generate(
            node("krea-2-generate", _kreaAuth="mcp", variant="medium", aspect_ratio="1:1", creativity="low"),
            {"prompt": PortValueDict(type="Text", value="ink fox"),
             "style_images": PortValueDict(type="Image", value=str(reference)),
             "moodboard": PortValueDict(type="Any", value={"kind": "krea_moodboard", "id": MOODBOARD, "strength": 0.4})},
            {}, emit=AsyncMock())
        assert upload.call_count == 1 and not api.called
    generate = dict(session.calls)["generate_image"]
    assert generate["model"] == "krea/krea-2/medium"
    assert generate["input"]["image_style_references"] == [{"url": ASSET, "strength": 0.5}]
    assert generate["input"]["moodboards"] == [{"id": MOODBOARD, "strength": 0.4}]
    assert Path(result["image"]["value"]).exists()


@pytest.mark.asyncio
async def test_account_style_search_lists_and_filters_without_api_token(session):
    result = await legacy.handle_krea_style_search(node("krea-style-search", _kreaAuth="mcp", model="k2", limit=5), {}, {})
    assert session.calls == [("list_styles", {})]
    assert [item["id"] for item in result["styles"]["value"]] == ["style-a"]


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [{"filter": "community"}, {"user": "someone"}, {"liked": True}])
async def test_account_style_search_rejects_api_only_filters_before_any_request(session, params):
    with pytest.raises(ValueError, match="needs a Krea API token"):
        await legacy.handle_krea_style_search(node("krea-style-search", _kreaAuth="mcp", **params), {}, {})
    assert session.calls == []


@pytest.mark.asyncio
async def test_account_style_training_uploads_then_trains_once(session):
    image = session.root / "train.png"
    image.write_bytes(png())
    session.jobs = [{"job_id": "train-job", "status": "completed", "result": {"style_id": "style-new"}}]
    with respx.mock as router:
        router.post(UPLOAD).respond(200, content=ASSET.encode())
        result = await legacy.handle_krea_style_train(
            node("krea-style-train", _kreaAuth="mcp", name="Ink", model="k1", training_type="Character", trigger_word="inkx"),
            {"images": PortValueDict(type="Image", value=[str(image)])}, {}, emit=AsyncMock())
    create = dict(session.calls)["create_style"]
    assert create == {"name": "Ink", "model": "k1", "train_type": "Character", "trigger_word": "inkx", "images": [ASSET]}
    assert session.names().count("create_style") == 1
    assert result["style_id"]["value"] == "style-new"
    assert result["style"]["value"] == {"kind": "krea_style", "id": "style-new", "strength": 1.0}


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [{"learning_rate": 0.001}, {"batch_size": 2}, {"max_train_steps": 500},
                                    {"share_with_workspace": True}, {"training_type": "Default"}])
async def test_account_style_training_rejects_api_only_knobs_before_upload(session, params):
    with pytest.raises(ValueError, match="needs a Krea API token"):
        await legacy.handle_krea_style_train(
            node("krea-style-train", _kreaAuth="mcp", name="Ink", model="flux_dev", **params),
            {"images": PortValueDict(type="Image", value=["https://example.test/a.png"])}, {}, emit=AsyncMock())
    assert session.calls == []


@pytest.mark.asyncio
async def test_api_token_training_refuses_account_only_models_before_spend(session):
    with respx.mock(assert_all_called=False) as router:
        api = router.route(host="api.krea.ai").respond(500)
        with pytest.raises(ValueError, match="only on a connected Krea account"):
            await legacy.handle_krea_style_train(
                node("krea-style-train", name="Ink", model="ltx-23-22b"),
                {"images": PortValueDict(type="Image", value=["https://example.test/a.png"])}, {"KREA_API_TOKEN": "fixture"})
        assert not api.called


@pytest.mark.asyncio
async def test_moodboard_search_outputs_a_wireable_moodboard(session):
    result = await legacy.handle_krea_moodboard_search(node("krea-moodboard-search", name="retro", strength=0.3), {}, {})
    assert session.calls == [("list_moodboards", {})]
    assert result["moodboard"]["value"] == {"kind": "krea_moodboard", "id": MOODBOARD, "strength": 0.3}
    assert [board["name"] for board in result["moodboards"]["value"]] == ["Retro Web"]


@pytest.mark.asyncio
async def test_moodboard_create_uploads_analyzes_and_returns_its_id(session):
    image = session.root / "board.png"
    image.write_bytes(png())
    session.jobs = [{"job_id": "board-job", "status": "completed", "result": {"moodboard_id": MOODBOARD}}]
    with respx.mock as router:
        router.post(UPLOAD).respond(200, content=ASSET.encode())
        result = await legacy.handle_krea_moodboard_create(
            node("krea-moodboard-create", name="Launch"),
            {"images": PortValueDict(type="Image", value=[str(image), "https://example.test/b.png"])}, {}, emit=AsyncMock())
    assert dict(session.calls)["create_moodboard"] == {"name": "Launch", "images": [ASSET, "https://example.test/b.png"]}
    assert result["moodboard_id"]["value"] == MOODBOARD


@pytest.mark.asyncio
async def test_library_rename_and_confirmed_delete_call_the_exact_tool(session):
    await legacy.handle_krea_library_manage(
        node("krea-library-manage", _kreaAuth="mcp", action="rename-moodboard", new_name="Launch v2"),
        {"id": PortValueDict(type="Any", value={"kind": "krea_moodboard", "id": MOODBOARD})}, {})
    await legacy.handle_krea_library_manage(
        node("krea-library-manage", _kreaAuth="mcp", action="delete-style", item_id="style-a", confirm_delete=True), {}, {})
    assert session.calls == [("update_moodboard", {"id": MOODBOARD, "name": "Launch v2"}),
                             ("delete_style", {"id": "style-a"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("params,match", [
    ({"action": "delete-style", "item_id": "style-a"}, "Confirm delete"),
    ({"action": "rename-style", "item_id": "../usage", "new_name": "x"}, "valid Krea"),
    ({"action": "rename-style", "item_id": "style-a"}, "new name"),
])
async def test_library_refuses_unconfirmed_or_malformed_changes_before_any_request(session, params, match):
    with pytest.raises(ValueError, match=match):
        await legacy.handle_krea_library_manage(node("krea-library-manage", _kreaAuth="mcp", **params), {}, {})
    assert session.calls == []


@pytest.mark.asyncio
async def test_api_token_library_renames_styles_only(session):
    with respx.mock as router:
        patch = router.patch("https://api.krea.ai/styles/style-a").respond(200, json={"id": "style-a", "title": "Ink 2"})
        await legacy.handle_krea_library_manage(
            node("krea-library-manage", action="rename-style", item_id="style-a", new_name="Ink 2"), {}, {"KREA_API_TOKEN": "fixture"})
        assert json.loads(patch.calls[0].request.content) == {"title": "Ink 2"}
    with pytest.raises(ValueError, match="Only renaming a style"):
        await legacy.handle_krea_library_manage(
            node("krea-library-manage", action="delete-moodboard", item_id=MOODBOARD, confirm_delete=True), {}, {"KREA_API_TOKEN": "fixture"})
    assert session.calls == []
