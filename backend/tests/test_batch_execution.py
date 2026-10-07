from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from execution.engine import execute_graph, validate_graph
from execution.sync_runner import get_handler_registry
from models.events import ExecutedEvent, ProgressEvent, execution_variant
from models.graph import GraphEdge, GraphNode
from services.cache import ExecutionCache
from services.output import get_run_dir, read_manifest


COLORS = ["red", "orange", "yellow", "green", "blue", "indigo", "violet"]


def node(nid, definition, params=None):
    return GraphNode(id=nid, definitionId=definition, params=params or {})


def edge(src, dst, source="set", target="input"):
    return GraphEdge(id=f"{src}-{dst}-{target}", source=src, sourceHandle=source,
                     target=dst, targetHandle=target)


def batch(values=COLORS, **params):
    return node("batch", "batch", {"display_name": "colors", "items_text": "\n".join(values), **params})


async def run(nodes, edges, handlers=None, cache=None):
    events = []
    async def emit(event):
        events.append(event)
    await execute_graph(nodes, edges, {}, handlers or {}, emit, cache=cache, run_id="batch-tests")
    return events


def completed(events, nid):
    return [event for event in events if event.type == "executed" and event.node_id == nid]


def expected_scope(index, label):
    return {"index": index, "label": label,
            "lineage": [{"source_node_id": "batch", "source_label": "colors",
                         "index": index, "item_label": label}]}


@pytest.mark.asyncio
async def test_seven_colors_batch_to_preview_keeps_scalar_outputs_and_parallel_metadata():
    nodes = [batch(), node("preview", "preview")]
    edges = [edge("batch", "preview")]
    assert validate_graph(nodes, edges, {}) == []
    events = await run(nodes, edges)
    outputs = completed(events, "preview")
    assert [event.outputs["input"] for event in outputs] == [
        {"type": "Text", "value": color} for color in COLORS]
    assert [event.variant for event in outputs] == [expected_scope(i, color) for i, color in enumerate(COLORS)]
    assert outputs[-1].batch_outputs == [event.outputs for event in outputs]
    assert outputs[-1].batch_variants == [event.variant for event in outputs]
    assert len(completed(events, "batch")) == 7
    assert completed(events, "batch")[-1].outputs == {"set": {"type": "Text", "value": "violet"}}


@pytest.mark.asyncio
async def test_registered_combine_text_utility_cascades_to_preview():
    nodes = [batch(), node("transform", "combine-text", {"template": "logo in {text1}"}),
             node("preview", "preview")]
    edges = [edge("batch", "transform", target="text1"), edge("transform", "preview", "text")]
    assert validate_graph(nodes, edges, {}) == []
    events = await run(nodes, edges, get_handler_registry())
    outputs = completed(events, "preview")
    assert [event.outputs["input"]["value"] for event in outputs] == [f"logo in {color}" for color in COLORS]
    assert [event.variant["label"] for event in outputs] == COLORS
    assert not any(event.type == "error" for event in events)


@pytest.mark.asyncio
async def test_batch_fork_join_pairs_same_items_and_runs_static_ancestor_once():
    nodes = [batch(["red", "blue"]), node("static", "text-input", {"value": "logo"}),
             node("left", "combine-text", {"template": "L{text1}"}),
             node("right", "combine-text", {"template": "R{text1}"}),
             node("join", "combine-text", {"separator": "/"})]
    edges = [edge("batch", "left", target="text1"), edge("batch", "right", target="text1"),
             edge("left", "join", "text", "text1"), edge("right", "join", "text", "text2"),
             edge("static", "join", "text", "text3")]
    events = await run(nodes, edges)
    assert len(completed(events, "static")) == 1
    assert [e.outputs["text"]["value"] for e in completed(events, "join")] == [
        "Lred/Rred/logo", "Lblue/Rblue/logo"]
    assert [e.variant["index"] for e in completed(events, "join")] == [0, 1]
    assert completed(events, "static")[0].variant is None


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["", "  \n\t ", "\r\n"])
async def test_empty_batch_finishes_without_children(text):
    nodes = [batch([], items_text=text), node("sink", "combine-text")]
    handler = AsyncMock()
    events = await run(nodes, [edge("batch", "sink", target="text1")], {"combine-text": handler})
    handler.assert_not_called()
    assert completed(events, "batch")[0].outputs == {}
    assert completed(events, "batch")[0].batch_outputs == []
    assert completed(events, "batch")[0].batch_variants == []
    assert not completed(events, "sink")
    assert events[-1].type == "graph_complete"


@pytest.mark.asyncio
async def test_batch_parsing_trims_lines_but_none_preserves_multiline_item():
    first = await run([batch([], items_text=" red\r\n\r\n blue \n\t")], [])
    assert [e.outputs["set"]["value"] for e in completed(first, "batch")] == ["red", "blue"]
    text = " red\nblue "
    second = await run([batch([], items_text=text, split_mode="none")], [])
    assert [e.outputs["set"]["value"] for e in completed(second, "batch")] == [text]
    long = await run([batch(["r" * 80])], [])
    assert completed(long, "batch")[0].variant["label"] == "r" * 37 + "…"


@pytest.mark.asyncio
@pytest.mark.parametrize("text", [" ", "\t", "\r\n", "\ufeff", "\u0085", "\u001c"])
async def test_split_none_preserves_every_nonempty_raw_string(text):
    events = await run([batch([], items_text=text, split_mode="none")], [])
    assert [event.outputs["set"]["value"] for event in completed(events, "batch")] == [text]


@pytest.mark.asyncio
@pytest.mark.parametrize("text, expected", [
    ("red\rblue", ["red\rblue"]),
    ("red\r\nblue", ["red", "blue"]),
    ("red\u2028blue", ["red\u2028blue"]),
])
async def test_by_line_splits_only_newline_matching_visible_source_item_count(text, expected):
    events = await run([batch([], items_text=text)], [])
    assert [event.outputs["set"]["value"] for event in completed(events, "batch")] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("text, expected", [
    ("\ufeff", []),
    ("\ufeffred\ufeff", ["red"]),
    ("\u0085", ["\u0085"]),
    ("\u001c", ["\u001c"]),
    ("\u0085red\u001c", ["\u0085red\u001c"]),
    ("\u180e", ["\u180e"]),
    ("\u200b", ["\u200b"]),
])
async def test_by_line_uses_ecmascript_trim_not_python_strip(text, expected):
    events = await run([batch([], items_text=text)], [])
    assert [event.outputs["set"]["value"] for event in completed(events, "batch")
            if "set" in event.outputs] == expected
    if not expected:
        assert completed(events, "batch")[0].batch_outputs == []


@pytest.mark.asyncio
async def test_by_line_trims_entire_ecmascript_whitespace_set():
    # ECMAScript WhiteSpace + LineTerminator, verified against the canonical
    # specification. Include all characters together and at both item ends.
    whitespace = "".join(chr(codepoint) for codepoint in [
        0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680,
        *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ])
    blank = await run([batch([], items_text=whitespace)], [])
    assert completed(blank, "batch")[0].batch_outputs == []
    padded = await run([batch([], items_text=whitespace + "red" + whitespace)], [])
    assert [event.outputs["set"]["value"] for event in completed(padded, "batch")] == ["red"]


@pytest.mark.asyncio
@pytest.mark.parametrize("name, expected", [
    ("", "Batch"), (" \t ", "Batch"), ("\ufeff", "Batch"),
    ("\u0085", "\u0085"), ("\u001c", "\u001c"), (" colors ", " colors "),
])
async def test_source_display_label_matches_card_without_changing_saved_name(name, expected):
    source = batch(["red"], display_name=name)
    events = await run([source, node("preview", "preview")], [edge("batch", "preview")])
    assert completed(events, "preview")[0].variant["lineage"][0]["source_label"] == expected
    assert source.params["display_name"] == name


@pytest.mark.asyncio
@pytest.mark.parametrize("params, message", [
    ({"items_text": None}, "items_text must be a string"),
    ({"items_text": 123}, "items_text must be a string"),
    ({"items_text": ["red"]}, "items_text must be a string"),
    ({"display_name": False}, "display_name must be a string"),
    ({"split_mode": None}, "split_mode"),
    ({"split_mode": "custom"}, "split_mode"),
    ({"batch_size_cap": 0}, "batch_size_cap"),
    ({"batch_size_cap": 26}, "batch_size_cap"),
    ({"batch_size_cap": True}, "batch_size_cap"),
    ({"batch_size_cap": "2"}, "batch_size_cap"),
    ({"batch_size_cap": 2.0}, "batch_size_cap"),
    ({"batch_size_cap": 1}, "Batch has 7 items"),
])
async def test_invalid_source_is_rejected_by_preflight_before_any_handler(params, message):
    nodes = [batch(**params), node("provider", "nano-banana"), node("independent", "nano-banana")]
    edges = [edge("batch", "provider", target="prompt")]
    assert any(message in issue.message for issue in validate_graph(nodes, edges, {}))
    handler = AsyncMock()
    with pytest.raises(ValueError, match=message):
        await run(nodes, edges, {"nano-banana": handler})
    handler.assert_not_called()


@pytest.mark.asyncio
async def test_default_cap_rejects_overflow_and_explicit_25_runs_full_list():
    items = [str(i) for i in range(25)]
    with pytest.raises(ValueError, match="batch_size_cap of 10"):
        await run([batch(items)], [])
    events = await run([batch(items, batch_size_cap=25)], [])
    assert len(completed(events, "batch")) == 25


@pytest.mark.asyncio
@pytest.mark.parametrize("other_definition", ["batch", "iterator-text"])
async def test_independent_batch_join_is_rejected_without_implicit_cross_or_pair(other_definition):
    other = node("other", other_definition, {"items_text": "x\ny"})
    nodes = [batch(), other, node("join", "combine-text")]
    edges = [edge("batch", "join", target="text1"),
             edge("other", "join", "set" if other_definition == "batch" else "text", "text2")]
    if other_definition == "iterator-text":
        nodes += [node("array", "array-builder")]
        edges += [edge("array", "other", "array", "array")]
    assert any("independent iterator" in issue.message for issue in validate_graph(nodes, edges, {}))
    handler = AsyncMock()
    with pytest.raises(ValueError, match="independent iterator"):
        await run(nodes, edges, {"combine-text": handler})
    handler.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("definition", ["worldlabs-environment", "worldlabs-world-export"])
async def test_batch_worldlabs_preflight_preserves_operation_recovery_guard(definition):
    nodes = [batch(), node("world", definition)]
    edges = [edge("batch", "world", target="prompt")]
    assert any("recovery-aware" in issue.message for issue in validate_graph(nodes, edges, {}))
    handler = AsyncMock()
    with pytest.raises(ValueError, match="recovery-aware"):
        await run(nodes, edges, {definition: handler})
    handler.assert_not_called()


def image_graph(values=("red", "blue")):
    return [batch(values), node("image", "nano-banana"), node("preview", "preview")], [
        edge("batch", "image", target="prompt"), edge("image", "preview", "image")]


def image_handler(calls, *, fail_at=None, wait_at=None, started=None, cancelled=None):
    async def handler(item_node, inputs, _keys):
        value = inputs["prompt"].value
        calls.append(value)
        if len(calls) == fail_at:
            raise ValueError("fixture item failed")
        if len(calls) == wait_at:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
        item_node.params.update({"prompt": value, "seed": len(calls)})
        path = get_run_dir() / "fixed.png"
        Image.new("RGB", (4, 4), "red" if len(calls) == 1 else "blue").save(path)
        return {"image": {"type": "Image", "value": str(path)}}
    return handler


@pytest.mark.asyncio
async def test_duplicate_batch_items_have_distinct_initial_generations_and_cache_replay():
    cache, calls = ExecutionCache(), []
    first_nodes, edges = image_graph(["same", "same"])
    original_recipe = copy.deepcopy(first_nodes[1].params)
    first = await run(first_nodes, edges, {"nano-banana": image_handler(calls)}, cache)
    paths = [Path(e.outputs["image"]["value"]) for e in completed(first, "image")]
    assert calls == ["same", "same"]
    assert paths[0] != paths[1] and paths[0].parent != paths[1].parent
    assert Image.open(paths[0]).getpixel((0, 0)) == (255, 0, 0)
    assert Image.open(paths[1]).getpixel((0, 0)) == (0, 0, 255)
    first_bytes = [path.read_bytes() for path in paths]
    first_run = paths[0].parents[2]
    first_manifest_bytes = (first_run / "manifest.json").read_bytes()
    assert [record["params"]["seed"] for record in read_manifest(first_run)["outputs"]
            if record["node_id"] == "image"] == [1, 2]
    warm_nodes, edges = image_graph(["same", "same"])
    warm = await run(warm_nodes, edges, {"nano-banana": image_handler(calls)}, cache)
    assert calls == ["same", "same"]
    warm_paths = [Path(e.outputs["image"]["value"]) for e in completed(warm, "image")]
    assert [path.read_bytes() for path in warm_paths] == first_bytes
    assert all(path.parent != first_run for path in warm_paths)
    assert warm_nodes[1].params == original_recipe
    assert [event.variant for event in completed(warm, "image")] == [
        expected_scope(0, "same"), expected_scope(1, "same")]
    assert (first_run / "manifest.json").read_bytes() == first_manifest_bytes
    assert [path.read_bytes() for path in paths] == first_bytes


@pytest.mark.asyncio
async def test_failed_batch_stops_remaining_items_and_retains_first_artifact_and_scope():
    nodes, edges = image_graph(["red", "blue", "green"])
    calls = []
    events = await run(nodes, edges, {"nano-banana": image_handler(calls, fail_at=2)})
    assert calls == ["red", "blue"]
    first = completed(events, "image")[0]
    assert first.variant == expected_scope(0, "red")
    assert first.batch_variants == [first.variant]
    path = Path(first.outputs["image"]["value"])
    assert path.is_file()
    records = read_manifest(path.parents[2])["outputs"]
    assert any(record["node_id"] == "image" and record["params"]["seed"] == 1 for record in records)
    error = next(event for event in events if event.type == "error" and event.node_id == "image")
    assert error.variant == expected_scope(1, "blue")
    assert not completed(events, "preview")


@pytest.mark.asyncio
async def test_cancelled_batch_cleans_up_active_handler_and_preserves_completed_artifact():
    nodes, edges = image_graph(["red", "blue", "green"])
    calls, events = [], []
    started, cancelled = asyncio.Event(), asyncio.Event()
    async def emit(event):
        events.append(event)
    task = asyncio.create_task(execute_graph(nodes, edges, {},
        {"nano-banana": image_handler(calls, wait_at=2, started=started, cancelled=cancelled)},
        emit, run_id="batch-cancel"))
    await asyncio.wait_for(started.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()
    assert calls == ["red", "blue"]
    path = Path(completed(events, "image")[0].outputs["image"]["value"])
    assert path.is_file()
    assert any(record["node_id"] == "image" for record in read_manifest(path.parents[2])["outputs"])
    assert not any(event.type == "graph_complete" for event in events)
    assert execution_variant.get() is None


@pytest.mark.asyncio
async def test_batch_nested_iterator_propagates_actual_item_lineage_and_checks_total_cap():
    nodes = [batch(["red", "blue"]), node("array", "array-builder"),
             node("nested", "iterator-text", {"batch_size_cap": 4}), node("sink", "combine-text")]
    edges = [edge("batch", "array", target="item1"), edge("batch", "array", target="item2"),
             edge("array", "nested", "array", "array"), edge("nested", "sink", "text", "text1")]
    events = await run(nodes, edges)
    outputs = completed(events, "sink")
    assert [event.outputs["text"]["value"] for event in outputs] == ["red", "red", "blue", "blue"]
    assert [event.variant["index"] for event in outputs] == [0, 1, 2, 3]
    assert [[item["index"] for item in event.variant["lineage"]] for event in outputs] == [
        [0, 0], [0, 1], [1, 0], [1, 1]]
    assert [event.variant["label"] for event in outputs] == ["red × red", "red × red", "blue × blue", "blue × blue"]
    nodes[2].params["batch_size_cap"] = 3
    handler = AsyncMock()
    blocked = await run(nodes, edges, {"combine-text": handler})
    handler.assert_not_called()
    assert any(event.type == "error" and "Nested iterator expands to 4" in event.error for event in blocked)


@pytest.mark.asyncio
async def test_saved_recipe_replay_preserves_original_batch_after_live_edit_and_disconnect():
    nodes, edges = image_graph()
    saved = json.dumps({"nodes": [node.model_dump(by_alias=True) for node in nodes],
                        "edges": [edge.model_dump(by_alias=True) for edge in edges]})
    calls = []
    first = await run(nodes, edges, {"nano-banana": image_handler(calls)})
    paths = [Path(event.outputs["image"]["value"]) for event in completed(first, "image")]
    old_bytes = [path.read_bytes() for path in paths]
    manifest_path = paths[0].parents[2] / "manifest.json"
    old_manifest = manifest_path.read_bytes()
    nodes[0].params["items_text"] = "yellow"
    edges.clear()
    assert calls == ["red", "blue"], "editing and disconnecting must not execute a handler"
    recipe = json.loads(saved)
    replay_nodes = [GraphNode.model_validate(value) for value in recipe["nodes"]]
    replay_edges = [GraphEdge.model_validate(value) for value in recipe["edges"]]
    replay = await run(replay_nodes, replay_edges, {"nano-banana": image_handler(calls)})
    assert calls == ["red", "blue", "red", "blue"]
    assert [event.variant["label"] for event in completed(replay, "image")] == ["red", "blue"]
    assert manifest_path.read_bytes() == old_manifest
    assert [path.read_bytes() for path in paths] == old_bytes


@pytest.mark.asyncio
async def test_progress_scope_is_task_local_and_serializes_beside_scalar_outputs():
    from main import _event_to_camel
    payloads = []
    async def handler(item_node, inputs, _keys):
        payloads.append(_event_to_camel(ProgressEvent(node_id=item_node.id, value=0.5)))
        return {"text": {"type": "Text", "value": inputs["text1"].value}}
    events = await run([batch(["red", "blue"]), node("sink", "combine-text")],
                       [edge("batch", "sink", target="text1")], {"combine-text": handler})
    assert [payload["variant"] for payload in payloads] == [expected_scope(0, "red"), expected_scope(1, "blue")]
    assert all(payload["runId"] == "batch-tests" for payload in payloads)
    serialized = _event_to_camel(completed(events, "sink")[-1])
    assert serialized["batchVariants"] == [expected_scope(0, "red"), expected_scope(1, "blue")]
    assert serialized["outputs"] == {"text": {"type": "Text", "value": "blue"}}
    assert ProgressEvent(node_id="ordinary", value=0).variant is None
    assert execution_variant.get() is None
