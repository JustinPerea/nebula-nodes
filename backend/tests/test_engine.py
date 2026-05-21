from __future__ import annotations

import asyncio

import pytest

from execution.engine import topological_sort, validate_graph, execute_graph, CycleError
from models.graph import GraphNode, GraphEdge, PortValueDict


def _node(nid: str, def_id: str = "gpt-image-1-generate") -> GraphNode:
    return GraphNode(id=nid, definitionId=def_id, params={}, outputs={})


def _edge(src: str, tgt: str, src_handle: str = "image", tgt_handle: str = "prompt") -> GraphEdge:
    return GraphEdge(
        id=f"{src}->{tgt}",
        source=src,
        sourceHandle=src_handle,
        target=tgt,
        targetHandle=tgt_handle,
    )


class TestTopologicalSort:
    def test_single_node(self) -> None:
        nodes = [_node("a")]
        order = topological_sort(nodes, [])
        assert order == ["a"]

    def test_linear_chain(self) -> None:
        nodes = [_node("a", "text-input"), _node("b"), _node("c", "preview")]
        edges = [_edge("a", "b", "text", "prompt"), _edge("b", "c", "image", "input")]
        order = topological_sort(nodes, edges)
        assert order == ["a", "b", "c"]

    def test_diamond_graph(self) -> None:
        nodes = [_node("a", "text-input"), _node("b"), _node("c"), _node("d", "preview")]
        edges = [
            _edge("a", "b", "text", "prompt"),
            _edge("a", "c", "text", "prompt"),
            _edge("b", "d", "image", "input"),
            _edge("c", "d", "image", "input"),
        ]
        order = topological_sort(nodes, edges)
        assert order[0] == "a"
        assert order[-1] == "d"
        assert set(order) == {"a", "b", "c", "d"}

    def test_disconnected_subgraphs(self) -> None:
        nodes = [_node("a"), _node("b")]
        order = topological_sort(nodes, [])
        assert set(order) == {"a", "b"}

    def test_cycle_raises(self) -> None:
        nodes = [_node("a"), _node("b")]
        edges = [_edge("a", "b"), _edge("b", "a")]
        with pytest.raises(CycleError):
            topological_sort(nodes, edges)


class TestValidateGraph:
    def test_valid_graph_passes(self) -> None:
        nodes = [_node("a", "text-input"), _node("b", "gpt-image-1-generate")]
        edges = [_edge("a", "b", "text", "prompt")]
        api_keys = {"OPENAI_API_KEY": "sk-test"}
        errors = validate_graph(nodes, edges, api_keys)
        assert errors == []

    def test_missing_required_port(self) -> None:
        nodes = [_node("b", "gpt-image-1-generate")]
        errors = validate_graph(nodes, [], {})
        port_errors = [e for e in errors if e.port_id == "prompt"]
        assert len(port_errors) == 1
        assert "required" in port_errors[0].message.lower()

    def test_missing_api_key(self) -> None:
        nodes = [_node("a", "text-input"), _node("b", "gpt-image-1-generate")]
        edges = [_edge("a", "b", "text", "prompt")]
        errors = validate_graph(nodes, edges, {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 1

    def test_utility_node_no_key_needed(self) -> None:
        nodes = [_node("a", "text-input")]
        errors = validate_graph(nodes, [], {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 0


class TestDynamicNodeValidation:
    def test_universal_registry_node_validates_base_required_ports(self) -> None:
        nodes = [_node("a", "openrouter-universal")]
        errors = validate_graph(nodes, [], {"OPENROUTER_API_KEY": "or-test"})
        port_errors = [e for e in errors if e.port_id == "messages"]
        assert len(port_errors) == 1

    def test_dynamic_node_missing_key(self) -> None:
        """Dynamic nodes should still validate API keys."""
        nodes = [_node("a", "openrouter-universal")]
        errors = validate_graph(nodes, [], {})
        key_errors = [e for e in errors if "OPENROUTER_API_KEY" in e.message]
        assert len(key_errors) == 1

    def test_unknown_dynamic_node_passes(self) -> None:
        """Truly unknown nodes should be silently skipped."""
        nodes = [_node("a", "some-future-node-type")]
        errors = validate_graph(nodes, [], {})
        assert len(errors) == 0

    def test_registry_node_missing_required_ports(self) -> None:
        nodes = [_node("a", "seedance-2-i2v")]
        errors = validate_graph(nodes, [], {"FAL_KEY": "fal-test"})
        assert {e.port_id for e in errors} == {"image", "prompt"}

    def test_registry_node_missing_api_key(self) -> None:
        nodes = [_node("a", "text-input"), _node("b", "gpt-image-2-generate")]
        edges = [_edge("a", "b", "text", "prompt")]
        errors = validate_graph(nodes, edges, {})
        key_errors = [e for e in errors if "OPENAI_API_KEY" in e.message]
        assert len(key_errors) == 1


class TestExecuteGraphInputResolution:
    @pytest.mark.asyncio
    async def test_multiple_input_port_accumulates_wires_in_edge_order(self) -> None:
        captured: dict[str, PortValueDict] = {}

        async def capture_handler(
            _node: GraphNode,
            inputs: dict[str, PortValueDict],
            _api_keys: dict[str, str],
        ) -> dict:
            captured.update(inputs)
            return {"text": {"type": "Text", "value": "ok"}}

        async def emit(_event) -> None:
            pass

        nodes = [
            GraphNode(id="a", definitionId="image-input", params={"filePath": "/tmp/one.png"}, outputs={}),
            GraphNode(id="b", definitionId="image-input", params={"filePath": "/tmp/two.png"}, outputs={}),
            GraphNode(id="c", definitionId="claude-chat", params={}, outputs={}),
        ]
        edges = [
            _edge("a", "c", "image", "images"),
            _edge("b", "c", "image", "images"),
        ]

        await execute_graph(
            nodes,
            edges,
            {},
            {"claude-chat": capture_handler},
            emit,
        )

        assert captured["images"].type == "Image"
        assert captured["images"].value == ["/tmp/one.png", "/tmp/two.png"]

    @pytest.mark.asyncio
    async def test_single_input_port_keeps_existing_last_writer_behavior(self) -> None:
        captured: dict[str, PortValueDict] = {}

        async def capture_handler(
            _node: GraphNode,
            inputs: dict[str, PortValueDict],
            _api_keys: dict[str, str],
        ) -> dict:
            captured.update(inputs)
            return {"input": {"type": "Text", "value": "ok"}}

        async def emit(_event) -> None:
            pass

        nodes = [
            GraphNode(id="a", definitionId="text-input", params={"value": "one"}, outputs={}),
            GraphNode(id="b", definitionId="text-input", params={"value": "two"}, outputs={}),
            GraphNode(id="c", definitionId="preview", params={}, outputs={}),
        ]
        edges = [
            _edge("a", "c", "text", "input"),
            _edge("b", "c", "text", "input"),
        ]

        await execute_graph(
            nodes,
            edges,
            {},
            {"preview": capture_handler},
            emit,
        )

        assert captured["input"].type == "Text"
        assert captured["input"].value == "two"

    @pytest.mark.asyncio
    async def test_router_fanout_runs_ready_branches_in_parallel(self) -> None:
        active = 0
        max_active = 0
        emitted: list[tuple[str, str]] = []

        async def slow_image_handler(
            node: GraphNode,
            _inputs: dict[str, PortValueDict],
            _api_keys: dict[str, str],
        ) -> dict:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await asyncio.sleep(0.02)
            active -= 1
            return {"image": {"type": "Image", "value": f"/tmp/{node.id}.png"}}

        async def emit(event) -> None:
            node_id = getattr(event, "node_id", "")
            emitted.append((event.type, node_id))

        nodes = [
            GraphNode(id="source", definitionId="text-input", params={"value": "A cat playing drums"}, outputs={}),
            GraphNode(id="router", definitionId="router", params={}, outputs={}),
            GraphNode(id="image-a", definitionId="gpt-image-1-generate", params={}, outputs={}),
            GraphNode(id="image-b", definitionId="gpt-image-1-generate", params={}, outputs={}),
            GraphNode(id="image-c", definitionId="gpt-image-1-generate", params={}, outputs={}),
        ]
        edges = [
            _edge("source", "router", "text", "input"),
            _edge("router", "image-a", "out1", "prompt"),
            _edge("router", "image-b", "out2", "prompt"),
            _edge("router", "image-c", "out3", "prompt"),
        ]

        await execute_graph(
            nodes,
            edges,
            {},
            {"gpt-image-1-generate": slow_image_handler},
            emit,
            max_parallel_nodes=4,
        )

        branch_ids = {"image-a", "image-b", "image-c"}
        branch_executing = [
            index for index, event in enumerate(emitted)
            if event[0] == "executing" and event[1] in branch_ids
        ]
        branch_executed = [
            index for index, event in enumerate(emitted)
            if event[0] == "executed" and event[1] in branch_ids
        ]

        assert max_active == 3
        assert len(branch_executing) == 3
        assert len(branch_executed) == 3
        assert max(branch_executing) < min(branch_executed)


class TestVideoOutputProbe:
    """Engine post-processes Video outputs with ffprobe so any node that
    produces a video (Veo, Kling, Sora, Seedance, Wan, etc.) writes
    sourceDuration/sourceFps/sourceIsVfr to its own params. This lets the
    frontend's getOrCreateEditNodeDownstream open the editor with a
    pre-populated clip instead of forcing the user to Run the edit node
    first. Symmetric to the upload-time probe."""

    @pytest.mark.asyncio
    async def test_probes_local_video_output_and_writes_params(self, tmp_path, monkeypatch):
        from unittest.mock import AsyncMock, patch
        from execution.engine import _maybe_probe_video_output

        vid = tmp_path / "x.mp4"
        vid.write_bytes(b"fake")
        node = GraphNode(id="n1", definitionId="veo-3", params={})
        outputs = {"video": {"type": "Video", "value": str(vid)}}
        probe = type("PR", (), {"duration": 8.0, "fps": 24.0, "is_vfr": False})()

        with patch("services.ffmpeg.ffprobe_video", AsyncMock(return_value=probe)):
            await _maybe_probe_video_output(node, outputs)

        assert node.params["sourceDuration"] == 8.0
        assert node.params["sourceFps"] == 24.0
        assert node.params["sourceIsVfr"] is False

    @pytest.mark.asyncio
    async def test_skips_when_sourceDuration_already_set(self, tmp_path, monkeypatch):
        from unittest.mock import AsyncMock, patch
        from execution.engine import _maybe_probe_video_output

        vid = tmp_path / "x.mp4"
        vid.write_bytes(b"fake")
        node = GraphNode(id="n1", definitionId="veo-3", params={"sourceDuration": 5.0})
        outputs = {"video": {"type": "Video", "value": str(vid)}}

        ffprobe_mock = AsyncMock()
        with patch("services.ffmpeg.ffprobe_video", ffprobe_mock):
            await _maybe_probe_video_output(node, outputs)

        ffprobe_mock.assert_not_called()
        assert node.params["sourceDuration"] == 5.0  # untouched

    @pytest.mark.asyncio
    async def test_skips_remote_urls(self, tmp_path, monkeypatch):
        from unittest.mock import AsyncMock, patch
        from execution.engine import _maybe_probe_video_output

        node = GraphNode(id="n1", definitionId="veo-3", params={})
        outputs = {"video": {"type": "Video", "value": "https://cdn.example.com/x.mp4"}}

        ffprobe_mock = AsyncMock()
        with patch("services.ffmpeg.ffprobe_video", ffprobe_mock):
            await _maybe_probe_video_output(node, outputs)

        ffprobe_mock.assert_not_called()
        assert "sourceDuration" not in node.params

    @pytest.mark.asyncio
    async def test_silent_on_ffprobe_failure(self, tmp_path, monkeypatch):
        from unittest.mock import AsyncMock, patch
        from execution.engine import _maybe_probe_video_output

        vid = tmp_path / "x.mp4"
        vid.write_bytes(b"fake")
        node = GraphNode(id="n1", definitionId="veo-3", params={})
        outputs = {"video": {"type": "Video", "value": str(vid)}}

        with patch("services.ffmpeg.ffprobe_video", AsyncMock(side_effect=RuntimeError("ffprobe boom"))):
            await _maybe_probe_video_output(node, outputs)  # must not raise

        assert "sourceDuration" not in node.params
