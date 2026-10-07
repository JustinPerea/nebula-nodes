from __future__ import annotations

import asyncio
import copy
from unittest.mock import AsyncMock

import httpx
import pytest

import main as main_module
from services.cache import ExecutionCache
from services.cli_graph import CLIGraph
from services.execution_runs import ExecutionRunRegistry


REPLACEMENT = {
    "nodes": [{"id": "replacement", "definitionId": "text-input", "params": {"value": "new graph"}}],
    "edges": [],
}


def prepare_run(monkeypatch, kind):
    graph = CLIGraph()
    registry = ExecutionRunRegistry()
    monkeypatch.setattr(main_module, "cli_graph", graph)
    monkeypatch.setattr(main_module, "execution_runs", registry)
    monkeypatch.setattr(main_module, "execution_cache", ExecutionCache())
    monkeypatch.setattr(main_module, "load_settings", lambda: {"apiKeys": {"GOOGLE_API_KEY": "local-test-only"}})
    monkeypatch.setattr(main_module.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(main_module.manager, "broadcast_raw", AsyncMock())
    main_module._shot_merge_locks.clear()
    if kind == "graph":
        source = graph.add_node("text-input", {"value": "old graph"})
        target = graph.add_node("combine-text", {})
        graph.connect(source, "text", target, "text1")
        route = "/api/execute"
        extra = {}
    else:
        target = graph.add_node("cinema-scene", {"scene": {
            "version": 1, "base": {"model": "nano-banana"}, "aspectRatio": "1:1",
            "shots": [{"id": "opening", "prompt": "local fixture"}],
        }})
        route = "/api/cinema/generate-shot"
        extra = {"nodeId": target, "shotId": "opening"}
    nodes, edges = graph.to_execute_format()
    return graph, registry, route, {"nodes": nodes, "edges": edges, "runId": f"held-{kind}", **extra}


def held_handler(monkeypatch, kind, *, cancelling=False):
    started, release, stopping = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def handler(node, inputs, _keys):
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            stopping.set()
            if cancelling:
                # The run is still owned while local handler cleanup drains.
                await release.wait()
            raise
        if kind == "graph":
            return {"text": {"type": "Text", "value": inputs["text1"].value}}
        return {"shot_opening": {"type": "Image", "value": None}}

    definition = "combine-text" if kind == "graph" else "cinema-scene"
    monkeypatch.setattr(main_module, "get_handler_registry", lambda **_kwargs: {definition: handler})
    return started, release, stopping


def graph_snapshot(graph):
    return copy.deepcopy((graph.nodes, graph.edges))


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["graph", "cinema"])
async def test_import_blocks_real_active_run_without_graph_commit_or_replacement_sync(monkeypatch, kind):
    graph, registry, route, request = prepare_run(monkeypatch, kind)
    started, release, _stopping = held_handler(monkeypatch, kind)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_module.app), base_url="http://test") as client:
        response = await client.post(route, json=request)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "started"
        record = registry.get(request["runId"])
        assert record is not None
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            assert record.status == "running" and registry.has_active()
            snapshot = graph_snapshot(graph)
            sync = AsyncMock(return_value={"nodes": [], "edges": []})
            monkeypatch.setattr(main_module, "_broadcast_graph_sync", sync)
            denied = await client.post("/api/graph/import", json=REPLACEMENT)
            assert denied.status_code == 409, denied.text
            assert "run is active" in denied.json()["detail"]
            assert graph_snapshot(graph) == snapshot
            sync.assert_not_awaited()
            release.set()
            await asyncio.wait_for(record.task, timeout=1)
            await asyncio.sleep(0)  # registry's real done callback settles status
            assert record.status == "completed" and not registry.has_active()
            sync.reset_mock()
            accepted = await client.post("/api/graph/import", json=REPLACEMENT)
            assert accepted.status_code == 200, accepted.text
            assert [node["params"]["value"] for node in graph.nodes.values()] == ["new graph"]
            sync.assert_awaited_once()
        finally:
            release.set()
            if not record.task.done():
                record.task.cancel()
            await asyncio.gather(record.task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["graph", "cinema"])
async def test_import_stays_blocked_until_cancelled_handler_cleanup_is_terminal(monkeypatch, kind):
    graph, registry, route, request = prepare_run(monkeypatch, kind)
    started, release, stopping = held_handler(monkeypatch, kind, cancelling=True)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_module.app), base_url="http://test") as client:
        response = await client.post(route, json=request)
        assert response.status_code == 200, response.text
        record = registry.get(request["runId"])
        assert record is not None
        try:
            await asyncio.wait_for(started.wait(), timeout=1)
            registry.cancel(request["runId"])
            await asyncio.wait_for(stopping.wait(), timeout=1)
            assert record.status == "cancelling" and registry.has_active()
            snapshot = graph_snapshot(graph)
            sync = AsyncMock(return_value={"nodes": [], "edges": []})
            monkeypatch.setattr(main_module, "_broadcast_graph_sync", sync)
            denied = await client.post("/api/graph/import", json=REPLACEMENT)
            assert denied.status_code == 409, denied.text
            assert graph_snapshot(graph) == snapshot
            sync.assert_not_awaited()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(record.task, timeout=1)
            await asyncio.sleep(0)
            assert record.status == "cancelled" and not registry.has_active()
            sync.reset_mock()
            accepted = await client.post("/api/graph/import", json=REPLACEMENT)
            assert accepted.status_code == 200, accepted.text
            sync.assert_awaited_once()
        finally:
            release.set()
            if not record.task.done():
                record.task.cancel()
            await asyncio.gather(record.task, return_exceptions=True)
