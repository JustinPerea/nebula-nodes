from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from execution.engine import execute_graph, validate_graph
from models.graph import GraphEdge, GraphNode
from services.cache import ExecutionCache
from services.output import get_run_dir, read_manifest


def node(nid, definition, params=None):
    return GraphNode(id=nid, definitionId=definition, params=params or {})


def edge(src, dst, source="text", target="text1"):
    return GraphEdge(id=f"{src}-{dst}-{target}", source=src, sourceHandle=source,
                     target=dst, targetHandle=target)


def batch_graph(values=("first", "second"), cap=10):
    nodes = [node(f"source{i}", "text-input", {"value": value}) for i, value in enumerate(values)]
    nodes += [node("array", "array-builder"), node("iterator", "iterator-text", {"batch_size_cap": cap})]
    edges = [edge(f"source{i}", "array", target=f"item{i + 1}") for i in range(len(values))]
    edges += [edge("array", "iterator", "array", "array")]
    return nodes, edges


async def run(nodes, edges, handlers=None, cache=None):
    events = []
    async def emit(event):
        events.append(event)
    await execute_graph(nodes, edges, {}, handlers or {}, emit, cache=cache, run_id="iterator-tests")
    return events


def completed(events, nid):
    return [event for event in events if event.type == "executed" and event.node_id == nid]


@pytest.mark.asyncio
async def test_iterator_repeats_downstream_with_scalar_outputs_and_batch_snapshots():
    nodes, edges = batch_graph()
    nodes += [node("transform", "combine-text", {"template": "hello {text1}"}), node("preview", "preview")]
    edges += [edge("iterator", "transform"), edge("transform", "preview", target="input")]
    assert validate_graph(nodes, edges, {}) == []
    events = await run(nodes, edges)
    results = completed(events, "preview")
    assert [event.outputs["input"]["value"] for event in results] == ["hello first", "hello second"]
    assert results[-1].batch_outputs == [
        {"input": {"type": "Text", "value": "hello first"}},
        {"input": {"type": "Text", "value": "hello second"}},
    ]


@pytest.mark.asyncio
async def test_iterator_fork_join_matches_items_and_static_ancestor_runs_once():
    nodes, edges = batch_graph()
    nodes += [node("constant", "text-input", {"value": "constant"}),
              node("left", "combine-text", {"template": "L{text1}"}),
              node("right", "combine-text", {"template": "R{text1}"}),
              node("join", "combine-text", {"separator": "|"})]
    edges += [edge("iterator", "left"), edge("iterator", "right"),
              edge("left", "join"), edge("right", "join", target="text2"),
              edge("constant", "join", target="text3")]
    events = await run(nodes, edges)
    assert len(completed(events, "constant")) == 1
    assert [e.outputs["text"]["value"] for e in completed(events, "join")] == [
        "Lfirst|Rfirst|constant", "Lsecond|Rsecond|constant",
    ]


@pytest.mark.asyncio
async def test_nested_iterator_keeps_outer_inputs_and_item_order():
    nodes, edges = batch_graph()
    nodes += [node("duplicate", "array-builder"), node("inner", "iterator-text"),
              node("join", "combine-text", {"separator": "/"})]
    edges += [edge("iterator", "duplicate", target="item1"),
              edge("iterator", "duplicate", target="item2"),
              edge("duplicate", "inner", "array", "array"),
              edge("inner", "join"), edge("iterator", "join", target="text2")]
    assert validate_graph(nodes, edges, {}) == []
    events = await run(nodes, edges)
    assert [e.outputs["text"]["value"] for e in completed(events, "join")] == [
        "first/first", "first/first", "second/second", "second/second",
    ]


@pytest.mark.asyncio
async def test_independent_iterator_join_rejected_before_any_handler():
    nodes, edges = batch_graph()
    nodes += [node("other", "iterator-text"), node("join", "combine-text")]
    edges += [edge("array", "other", "array", "array"), edge("iterator", "join"),
              edge("other", "join", target="text2")]
    assert any("independent iterator" in issue.message for issue in validate_graph(nodes, edges, {}))
    handler = AsyncMock()
    with pytest.raises(ValueError, match="independent iterator"):
        await run(nodes, edges, {"combine-text": handler})
    handler.assert_not_called()


@pytest.mark.asyncio
async def test_batch_item_starts_with_saved_recipe_instead_of_previous_handler_mutations():
    nodes, edges = batch_graph()
    target = node("mutating", "combine-text", {"cursor": 0})
    nodes.append(target)
    edges.append(edge("iterator", "mutating"))
    observed = []
    async def handler(node, inputs, _keys):
        observed.append(node.params["cursor"])
        node.params["cursor"] += 1
        return {"text": {"type": "Text", "value": inputs["text1"].value}}
    events = await run(nodes, edges, {"combine-text": handler})
    assert observed == [0, 0]
    assert target.params["cursor"] == 1
    assert len(completed(events, "mutating")) == 2


@pytest.mark.asyncio
async def test_recovery_aware_worldlabs_batch_rejected_before_paid_handler():
    nodes, edges = batch_graph()
    nodes += [node("world", "worldlabs-environment")]
    edges += [edge("iterator", "world", target="prompt")]
    assert any("recovery-aware" in issue.message for issue in validate_graph(nodes, edges, {}))
    handler = AsyncMock()
    with pytest.raises(ValueError, match="recovery-aware"):
        await run(nodes, edges, {"worldlabs-environment": handler})
    handler.assert_not_called()


@pytest.mark.asyncio
async def test_image_iterator_repeats_consumer_with_static_prompt_and_multiple_images_port(tmp_path):
    paths = [tmp_path / "red.png", tmp_path / "blue.png"]
    for path, color in zip(paths, ["red", "blue"]):
        Image.new("RGB", (4, 4), color).save(path)
    nodes = [node(f"image{i}", "image-input", {"filePath": str(path)}) for i, path in enumerate(paths)]
    nodes += [node("array", "array-builder"), node("iterator", "iterator-image"),
              node("prompt", "text-input", {"value": "static prompt"}), node("consumer", "nano-banana")]
    edges = [edge(f"image{i}", "array", "image", f"item{i + 1}") for i in range(2)]
    edges += [edge("array", "iterator", "array", "array"), edge("iterator", "consumer", "image", "images"),
              edge("prompt", "consumer", target="prompt")]
    captured = []
    async def handler(_node, inputs, _keys):
        captured.append((inputs["prompt"].value, inputs["images"].value))
        return {"text": {"type": "Text", "value": "done"}}
    assert validate_graph(nodes, edges, {"GOOGLE_API_KEY": "test"}) == []
    events = await run(nodes, edges, {"nano-banana": handler})
    assert captured == [("static prompt", [str(path)]) for path in paths]
    assert len(completed(events, "prompt")) == 1


@pytest.mark.asyncio
async def test_empty_iterator_does_not_run_downstream():
    nodes = [node("array", "array-builder"), node("iterator", "iterator-text"), node("sink", "combine-text")]
    edges = [edge("array", "iterator", "array", "array"), edge("iterator", "sink")]
    handler = AsyncMock()
    events = await run(nodes, edges, {"combine-text": handler})
    handler.assert_not_called()
    assert completed(events, "iterator")[-1].batch_outputs == []


@pytest.mark.asyncio
async def test_batch_cap_limits_items_and_rejects_invalid_values():
    nodes, edges = batch_graph(cap=1)
    nodes += [node("preview", "preview")]
    edges += [edge("iterator", "preview", target="input")]
    events = await run(nodes, edges)
    assert [e.outputs["input"]["value"] for e in completed(events, "preview")] == ["first"]
    for cap in [0, -1, 26, True, "2"]:
        nodes[3].params["batch_size_cap"] = cap
        assert any("batch_size_cap" in issue.message for issue in validate_graph(nodes, edges, {}))


@pytest.mark.asyncio
async def test_nested_expansion_above_cap_blocks_downstream_without_truncation():
    nodes, edges = batch_graph()
    nodes += [node("duplicate", "array-builder"), node("inner", "iterator-text", {"batch_size_cap": 2}),
              node("sink", "combine-text")]
    edges += [edge("iterator", "duplicate", target="item1"), edge("iterator", "duplicate", target="item2"),
              edge("duplicate", "inner", "array", "array"), edge("inner", "sink")]
    handler = AsyncMock()
    events = await run(nodes, edges, {"combine-text": handler})
    handler.assert_not_called()
    assert any(event.type == "error" and "Nested iterator expands to 4" in event.error for event in events)


def image_handler(calls, fail_at=None, wait_at=None, started=None, cancelled=None):
    async def handler(_node, inputs, _keys):
        value = inputs["prompt"].value
        calls.append(value)
        if len(calls) == fail_at:
            raise ValueError("batch item failed")
        if len(calls) == wait_at:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
        path = get_run_dir() / "fixed-handler-name.png"
        Image.new("RGB", (4, 4), "red" if value == "first" else "blue").save(path)
        return {"image": {"type": "Image", "value": str(path)}}
    return handler


def image_graph(values=("first", "second")):
    nodes, edges = batch_graph(values)
    nodes += [node("image", "nano-banana"), node("preview", "preview")]
    edges += [edge("iterator", "image", target="prompt"), edge("image", "preview", "image", "input")]
    return nodes, edges


@pytest.mark.asyncio
async def test_batch_artifacts_are_immutable_manifested_and_rebound_on_cache_hits():
    nodes, edges = image_graph()
    calls = []
    cache = ExecutionCache()
    first = await run(nodes, edges, {"nano-banana": image_handler(calls)}, cache)
    paths = [Path(e.outputs["image"]["value"]) for e in completed(first, "image")]
    assert paths[0] != paths[1]
    assert paths[0].parent != paths[1].parent
    assert Image.open(paths[0]).getpixel((0, 0)) == (255, 0, 0)
    assert Image.open(paths[1]).getpixel((0, 0)) == (0, 0, 255)
    first_run = paths[0].parents[2]
    manifest = read_manifest(first_run)
    assert manifest["run_id"] == "iterator-tests"
    assert all(any(record["node_id"] == "image" and first_run / record["output_path"] == path
                   for record in manifest["outputs"]) for path in paths)
    second = await run(nodes, edges, {"nano-banana": image_handler(calls)}, cache)
    assert calls == ["first", "second"]
    cached_paths = [Path(e.outputs["image"]["value"]) for e in completed(second, "image")]
    assert all(path.is_file() and path.parent != first_run for path in cached_paths)
    assert [path.read_bytes() for path in cached_paths] == [path.read_bytes() for path in paths]
    assert all(any(record["node_id"] == "image" and cached_paths[0].parent / record["output_path"] == path
                   for record in read_manifest(cached_paths[0].parent)["outputs"]) for path in cached_paths)


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_at", [None, 2])
async def test_batch_manifest_retains_each_items_effective_seed_and_timeline(fail_at):
    nodes, edges = image_graph()
    calls = []

    async def handler(item_node, inputs, _keys):
        prompt = inputs["prompt"].value
        calls.append(prompt)
        if len(calls) == fail_at:
            raise ValueError("second item failed")
        duration = 2 if prompt == "first" else 5
        item_node.params.update({"prompt": prompt, "seed": 11 if prompt == "first" else 22,
                                 "sourceDuration": duration,
                                 "clips": [{"duration": duration}]})
        path = get_run_dir() / "fixed.png"
        Image.new("RGB", (4, 4), "red").save(path)
        return {"image": {"type": "Image", "value": str(path)}}

    events = await run(nodes, edges, {"nano-banana": handler})
    paths = [Path(event.outputs["image"]["value"]) for event in completed(events, "image")]
    manifest = read_manifest(paths[0].parents[2])
    records = [record for record in manifest["outputs"] if record["node_id"] == "image"]
    expected = [("first", 11, 2)] if fail_at else [("first", 11, 2), ("second", 22, 5)]
    assert [(record["prompt"], record["params"]["seed"], record["params"]["sourceDuration"])
            for record in records] == expected
    assert [record["params"]["clips"] for record in records] == [[{"duration": row[2]}] for row in expected]
    assert [record["batch_context"] for record in records] == [
        [{"iterator_node_id": "iterator", "item_index": index}] for index in range(len(expected))]


@pytest.mark.asyncio
async def test_warm_batch_manifest_retains_original_effective_settings_without_changing_recipe():
    cache = ExecutionCache()
    calls = []

    async def handler(item_node, inputs, _keys):
        prompt = inputs["prompt"].value
        calls.append(prompt)
        seed = 11 if prompt == "first" else 22
        item_node.params.update({"prompt": prompt, "seed": seed, "clips": [{"duration": seed}]})
        path = get_run_dir() / "fixed.png"
        Image.new("RGB", (4, 4), "red").save(path)
        return {"image": {"type": "Image", "value": str(path)}}

    cold_nodes, edges = image_graph()
    cold = await run(cold_nodes, edges, {"nano-banana": handler}, cache)
    # Canvas runtime metadata is still the latest item, but neither edits to
    # it nor a history replay may rewrite retained artifact provenance.
    cold_target = next(node for node in cold_nodes if node.id == "image")
    assert cold_target.params["seed"] == 22
    cold_target.params["clips"][0]["duration"] = 999
    warm_nodes, edges = image_graph()
    warm_target = next(node for node in warm_nodes if node.id == "image")
    warm = await run(warm_nodes, edges, {"nano-banana": handler}, cache)
    assert calls == ["first", "second"]
    assert warm_target.params == {}, "cache provenance must not replace the saved recipe"
    warm_paths = [Path(event.outputs["image"]["value"]) for event in completed(warm, "image")]
    cold_path = Path(completed(cold, "image")[0].outputs["image"]["value"])
    assert all(path.is_file() and path.parent != cold_path.parents[2] for path in warm_paths)
    manifest = read_manifest(warm_paths[0].parent)
    records = [record for record in manifest["outputs"] if record["node_id"] == "image"]
    assert [(record["prompt"], record["params"]["seed"], record["params"]["clips"])
            for record in records] == [("first", 11, [{"duration": 11}]), ("second", 22, [{"duration": 22}])]


@pytest.mark.asyncio
async def test_failed_batch_stops_remaining_items_and_preserves_successful_artifacts():
    nodes, edges = image_graph(("first", "second", "third"))
    calls = []
    events = await run(nodes, edges, {"nano-banana": image_handler(calls, fail_at=2)})
    assert calls == ["first", "second"]
    assert completed(events, "preview") == []
    success = completed(events, "image")[0]
    path = Path(success.outputs["image"]["value"])
    assert path.is_file()
    assert success.batch_outputs == [success.outputs]
    assert any(record["node_id"] == "image" for record in read_manifest(path.parents[2])["outputs"])
    assert any(event.type == "error" and event.node_id == "image" for event in events)


@pytest.mark.asyncio
async def test_cancelled_batch_cancels_active_handler_and_keeps_completed_items():
    nodes, edges = image_graph(("first", "second", "third"))
    calls, events = [], []
    started, cancelled = asyncio.Event(), asyncio.Event()
    async def emit(event):
        events.append(event)
    task = asyncio.create_task(execute_graph(nodes, edges, {},
        {"nano-banana": image_handler(calls, wait_at=2, started=started, cancelled=cancelled)},
        emit, run_id="cancelled-iterator"))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()
    assert calls == ["first", "second"]
    path = Path(completed(events, "image")[0].outputs["image"]["value"])
    assert path.is_file()
    assert any(record["node_id"] == "image" for record in read_manifest(path.parents[2])["outputs"])
    assert not any(event.type == "graph_complete" for event in events)
