"""Portable Paper lifecycle checks; transports only return synthetic PNG bytes.

These exercise the production snapshot store, CLI adapter and source handler.
They do not claim live Paper synchronization or call a generative provider.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image

from models.graph import GraphEdge, GraphNode
from services.paper_sources import PaperSources, SourceRefreshError
from services.paper_transport import PaperCLI, PaperError, decode_result


IDENTITY = {"fileId": "file-1", "pageId": "page-1", "objectId": "logo-1"}


def png(color=(255, 40, 60, 180), mode="RGBA", size=(12, 8)) -> bytes:
    out = io.BytesIO()
    Image.new(mode, size, color).save(out, format="PNG")
    return out.getvalue()


class CaptureFixture:
    """Mutable artwork and labels, stable exact identity, no selection lookup."""

    def __init__(self, raw=None):
        self.raw = raw or png()
        self.name = "Editable logo"
        self.calls = []
        self.error = None
        self.selected = "unrelated-logo"

    async def capture(self, identity, settings):
        self.calls.append((copy.deepcopy(identity), copy.deepcopy(settings)))
        if self.error:
            raise self.error
        resolved = {
            **identity,
            "fileName": "Brand fixture",
            "pageName": "Logos",
            "objectName": self.name,
            "openUrl": f"https://app.paper.design/file/{identity['fileId']}/{identity['pageId']}",
            "navigation": "file",
        }
        return resolved, self.raw, {"width": 12, "height": 8}


@pytest.mark.asyncio
async def test_link_records_artwork_bytes_hash_settings_and_honest_navigation(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    source = await sources.link(IDENTITY, scale="2x")
    snap = source["snapshot"]

    assert source["changed"] is True
    assert source["state"] == "current"
    assert source["identity"]["objectId"] == "logo-1"
    assert source["identity"]["objectName"] == "Editable logo"
    assert source["identity"]["navigation"] == "file"
    assert source["identity"]["openUrl"].endswith("/file-1/page-1")
    assert snap["hash"] == hashlib.sha256(transport.raw).hexdigest()
    assert Path(snap["filePath"]).read_bytes() == transport.raw
    assert snap["width"] == 12 and snap["height"] == 8
    assert snap["bounds"] == {"width": 12, "height": 8}
    assert snap["hasAlpha"] is True and snap["hasTransparency"] is True
    assert snap["exportSettings"] == {
        "format": "png", "scale": "2x", "bounds": "object", "background": "artwork",
    }
    assert snap["capturedAt"] and source["lastSuccessfulRefresh"]
    assert "revision" not in snap and "revision" not in source


@pytest.mark.asyncio
async def test_a_b_snapshots_remain_immutable_and_unchanged_refresh_adds_no_history(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    first = await sources.link(IDENTITY)
    a = copy.deepcopy(first["snapshot"])

    unchanged = await sources.refresh(first["id"])
    assert unchanged["changed"] is False
    assert unchanged["snapshot"] == a
    assert len(unchanged["snapshots"]) == 1

    transport.raw = png((40, 100, 255, 200))
    refreshed = await sources.refresh(first["id"])
    b = refreshed["snapshot"]
    assert refreshed["changed"] is True
    assert b["id"] != a["id"] and b["hash"] != a["hash"]
    assert [s["id"] for s in refreshed["snapshots"]] == [a["id"], b["id"]]
    assert sources.snapshot(a["id"], a["hash"]) == a
    assert Path(a["filePath"]).read_bytes() != Path(b["filePath"]).read_bytes()

    again = await sources.refresh(first["id"])
    assert again["changed"] is False
    assert again["snapshot"] == b
    assert len(again["snapshots"]) == 2


@pytest.mark.asyncio
async def test_rename_and_selection_changes_never_retarget_exact_object(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    source = await sources.link(IDENTITY)
    transport.name = "Renamed source logo"
    transport.selected = "different-logo-with-same-name"
    refreshed = await sources.refresh(source["id"])

    assert refreshed["changed"] is False
    assert refreshed["identity"]["objectName"] == "Renamed source logo"
    assert refreshed["identity"]["objectId"] == "logo-1"
    assert all(call[0]["objectId"] == "logo-1" for call in transport.calls)
    assert len(refreshed["snapshots"]) == 1
    # Immutable artwork records retain their own labels at capture time.
    assert refreshed["snapshot"]["identity"]["objectName"] == "Editable logo"


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["unavailable", "missing"])
async def test_failed_refresh_keeps_labeled_last_good_snapshot_and_success_time(tmp_path, state):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link(IDENTITY)
    transport.error = PaperError("Exact object deleted" if state == "missing" else "Disconnected", state)

    with pytest.raises(SourceRefreshError) as error:
        await sources.refresh(linked["id"])
    retained = sources.get(linked["id"])
    assert error.value.source == retained
    assert retained["state"] == state
    assert retained["snapshot"] == linked["snapshot"]
    assert retained["snapshots"] == linked["snapshots"]
    assert retained["lastSuccessfulRefresh"] == linked["lastSuccessfulRefresh"]
    assert retained["identity"] == linked["identity"]
    assert retained["lastError"]
    assert Path(retained["snapshot"]["filePath"]).read_bytes() == transport.raw


@pytest.mark.asyncio
async def test_bad_png_refresh_retains_last_good_artwork(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link(IDENTITY)
    transport.raw = b"not an image"
    with pytest.raises(SourceRefreshError, match="could not be validated"):
        await sources.refresh(linked["id"])
    assert sources.get(linked["id"])["snapshot"] == linked["snapshot"]


@pytest.mark.asyncio
async def test_explicit_reconnect_preserves_source_id_and_prior_snapshot_history(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link(IDENTITY)
    transport.error = PaperError("Deleted exact object", "missing")
    with pytest.raises(SourceRefreshError):
        await sources.refresh(linked["id"])
    transport.error = None
    replacement = {**IDENTITY, "objectId": "logo-2"}
    restored = await sources.refresh(linked["id"], identity=replacement)

    assert restored["id"] == linked["id"]
    assert restored["identity"]["objectId"] == "logo-2"
    assert restored["state"] == "current" and "lastError" not in restored
    assert len(restored["snapshots"]) == 2
    assert restored["snapshots"][0] == linked["snapshot"]
    assert restored["snapshot"]["id"] != linked["snapshot"]["id"]
    # Same bytes can be distinct snapshots when exact source identity changes.
    assert restored["snapshot"]["hash"] == linked["snapshot"]["hash"]

    back = await sources.refresh(linked["id"], identity=IDENTITY)
    assert back["snapshot"] == linked["snapshot"]
    assert len(back["snapshots"]) == 2


class RacingCapture(CaptureFixture):
    def __init__(self):
        super().__init__()
        self.block_next = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.late_error = False

    async def capture(self, identity, settings):
        if self.block_next:
            self.block_next = False
            raw = self.raw
            self.started.set()
            await self.release.wait()
            if self.late_error:
                raise PaperError("Old request failed", "missing")
            resolved, _, bounds = await super().capture(identity, settings)
            return resolved, raw, bounds
        return await super().capture(identity, settings)


@pytest.mark.asyncio
@pytest.mark.parametrize("late_error", [False, True])
async def test_late_refresh_success_or_failure_cannot_replace_newer_snapshot(tmp_path, late_error):
    transport = RacingCapture()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link(IDENTITY)
    transport.raw = png((230, 170, 10, 160))
    late_hash = hashlib.sha256(transport.raw).hexdigest()
    transport.block_next = True
    transport.late_error = late_error
    late_task = asyncio.create_task(sources.refresh(linked["id"]))
    await asyncio.wait_for(transport.started.wait(), 1)
    transport.raw = png((10, 240, 60, 255))
    latest = await sources.refresh(linked["id"])
    transport.release.set()
    late = await asyncio.wait_for(late_task, 1)

    assert late["superseded"] is True and late["changed"] is False
    assert late["snapshot"] == latest["snapshot"]
    stored = sources.get(linked["id"])
    assert stored["snapshot"] == latest["snapshot"]
    assert stored["state"] == "current" and "lastError" not in stored
    assert len(stored["snapshots"]) == 2
    assert late_hash not in {snapshot["hash"] for snapshot in stored["snapshots"]}


@pytest.mark.asyncio
async def test_restart_recovers_source_identity_and_both_exact_snapshots(tmp_path):
    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    a = await sources.link(IDENTITY)
    transport.raw = png((60, 120, 230, 255))
    b = await sources.refresh(a["id"])
    restarted = PaperSources(tmp_path, CaptureFixture())

    assert restarted.get(a["id"])["snapshot"] == b["snapshot"]
    assert restarted.snapshot(a["snapshot"]["id"]) == a["snapshot"]
    assert restarted.snapshot(b["snapshot"]["id"]) == b["snapshot"]
    assert len(restarted.get(a["id"])["snapshots"]) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,color,has_alpha,has_transparency", [
    ("RGB", (50, 80, 100), False, False),
    ("RGBA", (50, 80, 100, 255), True, False),
    ("RGBA", (50, 80, 100, 0), True, True),
])
async def test_transparency_describes_exported_pixels_not_requested_settings(
    tmp_path, mode, color, has_alpha, has_transparency,
):
    linked = await PaperSources(tmp_path, CaptureFixture(png(color, mode))).link(IDENTITY)
    assert linked["snapshot"]["hasAlpha"] is has_alpha
    assert linked["snapshot"]["hasTransparency"] is has_transparency


@pytest.mark.asyncio
async def test_pinned_handler_uses_a_after_refresh_b_without_contacting_paper(tmp_path, monkeypatch):
    import handlers.paper_source as handler

    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    a = await sources.link(IDENTITY)
    node = GraphNode(id="source", definitionId="paper-source", params={"_paperSource": a})
    transport.raw = png((20, 150, 240, 255))
    b = await sources.refresh(a["id"])
    transport.error = PaperError("Any new transport call is a failure")
    calls_before = len(transport.calls)
    monkeypatch.setattr(handler, "paper_sources", sources)

    result = await handler.handle_paper_source(node, {}, {})
    assert result == {"image": {"type": "Image", "value": a["snapshot"]["filePath"]}}
    assert result["image"]["value"] != b["snapshot"]["filePath"]
    assert len(transport.calls) == calls_before


@pytest.mark.asyncio
async def test_existing_provider_media_adapters_consume_png_bytes_without_localhost_fetch(tmp_path):
    from handlers.openai_image_edit import _resolve_image_bytes
    from handlers.runway import _resolve_image

    transport = CaptureFixture()
    source = await PaperSources(tmp_path, transport).link(IDENTITY)
    path = source["snapshot"]["filePath"]
    # The image-edit multipart adapter reads bytes; Runway's media adapter
    # constructs a data URI. Neither asks the provider to fetch this local path.
    assert _resolve_image_bytes(path) == transport.raw
    data_uri = await _resolve_image(path)
    header, encoded = data_uri.split(",", 1)
    assert header == "data:image/png;base64"
    assert base64.b64decode(encoded) == transport.raw


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", ["bytes", "missing", "hash"])
async def test_pinned_handler_stops_on_damaged_or_mismatched_snapshot(tmp_path, monkeypatch, tamper):
    import handlers.paper_source as handler

    sources = PaperSources(tmp_path, CaptureFixture())
    linked = await sources.link(IDENTITY)
    monkeypatch.setattr(handler, "paper_sources", sources)
    path = Path(linked["snapshot"]["filePath"])
    if tamper == "bytes":
        path.write_bytes(png((0, 0, 0, 255)))
    elif tamper == "missing":
        path.unlink()
    else:
        linked["snapshot"]["hash"] = "0" * 64
    node = GraphNode(id="source", definitionId="paper-source", params={"_paperSource": linked})
    with pytest.raises(PaperError, match="missing or damaged"):
        await handler.handle_paper_source(node, {}, {})


@pytest.mark.asyncio
async def test_unlinked_handler_requires_explicit_export(monkeypatch):
    from handlers.paper_source import handle_paper_source
    with pytest.raises(ValueError, match="Link and export"):
        await handle_paper_source(GraphNode(id="source", definitionId="paper-source"), {}, {})


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["id", "hash"])
@pytest.mark.parametrize("invalid", [
    pytest.param("missing", id="missing"),
    pytest.param(None, id="null"),
    pytest.param("", id="empty"),
    pytest.param("a" * 63, id="truncated"),
    pytest.param("A" * 64, id="uppercase"),
    pytest.param("g" * 64, id="nonhex"),
    pytest.param(123, id="number"),
])
async def test_incomplete_or_invalid_pinned_identity_fails_before_snapshot_lookup(monkeypatch, field, invalid):
    import handlers.paper_source as handler

    pinned = {"id": "0" * 64, "hash": "1" * 64}
    if invalid == "missing":
        pinned.pop(field)
    else:
        pinned[field] = invalid
    snapshot_lookup = Mock(side_effect=AssertionError("Malformed pins must fail before snapshot lookup"))
    monkeypatch.setattr(handler, "paper_sources", SimpleNamespace(snapshot=snapshot_lookup))
    node = GraphNode(id="source", definitionId="paper-source", params={"_paperSource": {"snapshot": pinned}})
    with pytest.raises(ValueError, match="exact ID and SHA-256 hash"):
        await handler.handle_paper_source(node, {}, {})
    snapshot_lookup.assert_not_called()


@pytest.mark.asyncio
async def test_preseeded_generic_cache_cannot_replace_pinned_source_or_bypass_integrity(tmp_path, monkeypatch):
    import handlers.paper_source as handler
    from execution.engine import execute_graph
    from models.events import ErrorEvent, ExecutedEvent
    from services.cache import ExecutionCache

    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    linked = await sources.link(IDENTITY)
    transport.error = PaperError("Execution must not refresh Paper")
    monkeypatch.setattr(handler, "paper_sources", sources)
    node = GraphNode(id="source", definitionId="paper-source", params={"_paperSource": linked})
    poison = tmp_path / "unrelated-cached-artwork.png"
    poison.write_bytes(png((0, 0, 0, 255)))
    cache = ExecutionCache()
    cache_key = cache.get_key(node.definition_id, dict(node.params), {}, node_id=node.id)
    cache.set(cache_key, {"image": {"type": "Image", "value": str(poison)}})
    cache_get = Mock(wraps=cache.get)
    cache_set = Mock(wraps=cache.set)
    monkeypatch.setattr(cache, "get", cache_get)
    monkeypatch.setattr(cache, "set", cache_set)
    events = []

    async def emit(event):
        events.append(event)

    kwargs = {"nodes": [node], "edges": [], "api_keys": {}, "cache": cache,
              "handler_registry": {"paper-source": handler.handle_paper_source}, "emit": emit}
    await execute_graph(**kwargs, run_id="paper-cache-original")
    completed = [event for event in events if isinstance(event, ExecutedEvent)]
    assert len(completed) == 1
    assert completed[0].outputs == {"image": {"type": "Image", "value": linked["snapshot"]["filePath"]}}
    assert not any(isinstance(event, ErrorEvent) for event in events)

    # A later run must check original snapshot bytes again, even with the
    # preseeded success still in the ordinary graph cache.
    Path(linked["snapshot"]["filePath"]).write_bytes(png((100, 80, 60, 255)))
    events.clear()
    await execute_graph(**kwargs, run_id="paper-cache-damaged")
    errors = [event for event in events if isinstance(event, ErrorEvent)]
    assert len(errors) == 1 and "Pinned snapshot is missing or damaged" in errors[0].error
    assert not any(isinstance(event, ExecutedEvent) for event in events)
    cache_get.assert_not_called()
    cache_set.assert_not_called()
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_inflight_downstream_run_finishes_with_a_then_explicit_rerun_uses_b(tmp_path, monkeypatch):
    import handlers.paper_source as handler
    from execution.engine import execute_graph
    from services.output import get_run_dir

    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    a = await sources.link(IDENTITY)
    monkeypatch.setattr(handler, "paper_sources", sources)
    nodes = [
        GraphNode(id="source", definitionId="paper-source", params={"_paperSource": a}),
        GraphNode(id="fixture", definitionId="paper-deterministic-fixture", params={"recipeVersion": "v1", "seed": 17}),
    ]
    edge = GraphEdge(id="edge-1", source="source", sourceHandle="image", target="fixture", targetHandle="image")
    started, release = asyncio.Event(), asyncio.Event()
    consumed = []
    events = []
    receipts = []
    output_paths = []

    async def fixture(_node, inputs, _keys):
        # Capture the exact immutable image before our synthetic long run waits.
        value = inputs["image"]
        image_path = value["value"] if isinstance(value, dict) else value.value
        consumed.append(hashlib.sha256(Path(image_path).read_bytes()).hexdigest())
        run_dir = get_run_dir()
        # A durable input/recipe receipt must exist before the handler starts.
        receipts.append(json.loads((run_dir / "paper-inputs.json").read_text()))
        started.set()
        await release.wait()
        output_path = run_dir / "fixture-output.png"
        output_path.write_bytes(Path(image_path).read_bytes())
        output_paths.append(output_path)
        return {"image": {"type": "Image", "value": str(output_path)}}

    async def emit(event):
        events.append(event)

    kwargs = dict(nodes=nodes, edges=[edge], api_keys={},
                  handler_registry={"paper-source": handler.handle_paper_source,
                                    "paper-deterministic-fixture": fixture}, emit=emit)
    running = asyncio.create_task(execute_graph(**kwargs, run_id="paper-fixture-a"))
    await asyncio.wait_for(started.wait(), 3)
    transport.raw = png((0, 240, 90, 255))
    b = await sources.refresh(a["id"])
    assert len(consumed) == 1, "Refresh must not start a downstream run"
    assert receipts[0]["paperInputs"][0]["snapshot"] == a["snapshot"]
    assert sources.get(a["id"])["snapshot"] == b["snapshot"]
    release.set()
    await asyncio.wait_for(running, 3)
    assert consumed == [a["snapshot"]["hash"]]
    assert nodes[1].params["recipeVersion"] == "v1"
    assert edge.model_dump() == GraphEdge(id="edge-1", source="source", sourceHandle="image",
                                         target="fixture", targetHandle="image").model_dump()

    # The graph explicitly adopts B, then a new run follows the same saved edge/recipe.
    nodes[0].params["_paperSource"] = b
    await execute_graph(**kwargs, run_id="paper-fixture-b")
    assert consumed == [a["snapshot"]["hash"], b["snapshot"]["hash"]]
    assert sources.snapshot(a["snapshot"]["id"])["hash"] == consumed[0]
    assert sources.snapshot(b["snapshot"]["id"])["hash"] == consumed[1]
    assert [receipt["runId"] for receipt in receipts] == ["paper-fixture-a", "paper-fixture-b"]
    assert receipts[1]["paperInputs"][0]["snapshot"] == b["snapshot"]
    assert receipts[0]["recipeRevision"] == receipts[1]["recipeRevision"]
    assert all(receipt["schemaVersion"] == 1 and receipt["capturedAt"] for receipt in receipts)
    assert output_paths[0] != output_paths[1]
    assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in output_paths] == consumed
    assert json.loads((output_paths[0].parent / "paper-inputs.json").read_text()) == receipts[0]


@pytest.mark.asyncio
async def test_receipt_recipe_revision_changes_for_settings_not_source_refresh_and_redacts_secrets(tmp_path):
    from services.paper_run import write_paper_receipt

    transport = CaptureFixture()
    sources = PaperSources(tmp_path, transport)
    a = await sources.link(IDENTITY)
    transport.raw = png((0, 80, 240, 200))
    b = await sources.refresh(a["id"])
    secrets = {
        "api_key": "fixture-api-key-secret",
        "OPENAI_API_KEY": "fixture-prefixed-key-secret",
        "apiToken": "fixture-api-token-secret",
        "bearer_token": "fixture-bearer-secret",
        "nested": [{"my_client_secret": "fixture-client-secret", "Authorization": "fixture-auth-secret"}],
    }
    nodes = [
        GraphNode(id="source", definitionId="paper-source", params={"_paperSource": a}),
        GraphNode(id="fixture", definitionId="paper-deterministic-fixture", params={"seed": 17, "providerConfig": secrets}),
    ]
    edges = [GraphEdge(id="edge", source="source", sourceHandle="image", target="fixture", targetHandle="image")]

    def receipt(name):
        directory = tmp_path / name
        directory.mkdir()
        write_paper_receipt(nodes, edges, directory, name)
        path = directory / "paper-inputs.json"
        return json.loads(path.read_text()), path

    first, first_path = receipt("accepted-a")
    for secret in ("fixture-api-key-secret", "fixture-prefixed-key-secret", "fixture-api-token-secret",
                   "fixture-bearer-secret", "fixture-client-secret", "fixture-auth-secret"):
        assert secret not in first_path.read_text()
    nodes[0].params["_paperSource"] = b
    nodes[1].params["_sourceDuration"] = 99
    nodes[1].params["_sourceFps"] = 24
    second, _ = receipt("accepted-b")
    assert first["paperInputs"][0]["snapshot"] == a["snapshot"]
    assert second["paperInputs"][0]["snapshot"] == b["snapshot"]
    assert first["recipeRevision"] == second["recipeRevision"]
    nodes[1].params["seed"] = 18
    changed, _ = receipt("changed-recipe")
    assert changed["recipeRevision"] != second["recipeRevision"]
    assert json.loads(first_path.read_text()) == first
    # Each accepted receipt is immutable; attempts to overwrite it fail.
    with pytest.raises(FileExistsError):
        write_paper_receipt(nodes, edges, first_path.parent, "accepted-a")


class ToolFixture:
    def __init__(self, export_path):
        self.path = export_path
        self.calls = []
        self.node_id = "logo-1"
        self.export_id = "logo-1"
        self.opened_url = "https://app.paper.design/file/file-1/page-1"

    async def call(self, name, args):
        self.calls.append((name, copy.deepcopy(args)))
        if name == "get_basic_info":
            return {"file": {"id": "file-1", "name": "Brand fixture"}, "pageId": "page-1", "pageName": "Logos"}
        if name == "get_node_info":
            if args["nodeId"] == "artboard-1":
                return {"id": "artboard-1", "parentId": "root_node_page-1", "childIds": ["logo-1"]}
            return {"id": self.node_id, "parentId": "artboard-1", "name": "Editable logo", "width": 12, "height": 8, "childIds": []}
        if name == "get_children":
            return {"children": [{"id": "artboard-1"}], "count": 1}
        if name == "export":
            return {"exports": [{"nodeId": self.export_id, "filePath": str(self.path)}]}
        if name == "open_file":
            return {"fileName": "Brand fixture", "pageName": "Logos", "url": self.opened_url}
        raise AssertionError(f"Unexpected tool {name}")


def adapter_with_tools(monkeypatch, tools):
    adapter = PaperCLI()

    @asynccontextmanager
    async def fixture_tools():
        yield tools

    monkeypatch.setattr(adapter, "tools", fixture_tools)
    return adapter


@pytest.mark.asyncio
@pytest.mark.parametrize("opened_url,opened", [
    ("https://app.paper.design/file/file-1/page-1", True),
    ("https://app.paper.design/file/file-2/page-1", False),
    ("https://app.paper.design/file/file-10/page-1", False),
    ("", False),
])
async def test_cli_native_open_normalizes_real_tool_shape_and_exact_file_match(monkeypatch, opened_url, opened):
    tools = ToolFixture(Path("/unused"))
    tools.opened_url = opened_url
    adapter = adapter_with_tools(monkeypatch, tools)
    identity = {**IDENTITY, "openUrl": "https://app.paper.design/file/file-1/page-1"}
    result = await adapter.open(identity)
    assert result == {"navigation": "file", "objectNavigation": False,
                      "url": identity["openUrl"], "opened": opened}
    assert tools.calls == [("open_file", {"fileId": "file-1", "pageId": "page-1"})]


@pytest.mark.asyncio
async def test_cli_native_open_can_open_exact_ids_before_first_successful_export(monkeypatch):
    tools = ToolFixture(Path("/unused"))
    adapter = adapter_with_tools(monkeypatch, tools)
    result = await adapter.open(IDENTITY)
    assert result == {"navigation": "file", "objectNavigation": False,
                      "url": "https://app.paper.design/file/file-1/page-1", "opened": True}


@pytest.mark.asyncio
async def test_cli_adapter_exports_exact_object_and_reads_actual_png(tmp_path, monkeypatch):
    path = tmp_path / "editable-logo.png"
    path.write_bytes(png())
    tools = ToolFixture(path)
    adapter = adapter_with_tools(monkeypatch, tools)
    resolved, raw, bounds = await adapter.capture(IDENTITY, {"scale": "2x"})

    assert raw == path.read_bytes()
    assert resolved["objectId"] == "logo-1" and resolved["navigation"] == "file"
    assert bounds == {"width": 12, "height": 8}
    assert tools.calls == [
        ("get_basic_info", {"fileId": "file-1", "pageId": "page-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "logo-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "artboard-1"}),
        ("get_children", {"fileId": "file-1", "nodeId": "root_node_page-1"}),
        ("export", {"fileId": "file-1", "pageId": "page-1", "type": "image",
                    "nodes": {"logo-1": [{"format": "png", "scale": "2x"}]}}),
        ("get_basic_info", {"fileId": "file-1", "pageId": "page-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "logo-1"}),
        ("get_node_info", {"fileId": "file-1", "nodeId": "artboard-1"}),
        ("get_children", {"fileId": "file-1", "nodeId": "root_node_page-1"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("wrong_step", ["lookup", "export"])
async def test_cli_adapter_never_falls_back_to_same_name_object(tmp_path, monkeypatch, wrong_step):
    path = tmp_path / "other-logo.png"
    path.write_bytes(png())
    tools = ToolFixture(path)
    if wrong_step == "lookup":
        tools.node_id = "same-name-other-id"
    else:
        tools.export_id = "same-name-other-id"
    adapter = adapter_with_tools(monkeypatch, tools)

    with pytest.raises(PaperError) as exc:
        await adapter.capture(IDENTITY, {"scale": "1x"})
    assert exc.value.state == "missing"
    assert all(name not in {"get_selection", "get_tree"} for name, _ in tools.calls)
    assert all(args.get("nodeId", "logo-1") in {"logo-1", "artboard-1", "root_node_page-1"}
               for _, args in tools.calls)
    assert all(args["nodes"] == {"logo-1": [{"format": "png", "scale": "1x"}]}
               for name, args in tools.calls if name == "export")


def test_decode_result_reads_json_payload_and_ignores_file_header():
    result = SimpleNamespace(isError=False, content=[
        SimpleNamespace(type="text", text="File: Brand fixture (file-1)"),
        SimpleNamespace(type="text", text='{"exports": [{"nodeId": "logo-1"}]}'),
    ])
    assert decode_result(result) == {"exports": [{"nodeId": "logo-1"}]}


def test_decode_result_redacts_relay_error_and_marks_missing():
    result = SimpleNamespace(isError=True, content=[
        SimpleNamespace(type="text", text="Object not found in /private/secret-relay-path"),
    ])
    with pytest.raises(PaperError) as exc:
        decode_result(result)
    assert exc.value.state == "missing"
    assert str(exc.value) == "Linked Paper object is missing"
    assert "private" not in str(exc.value)
