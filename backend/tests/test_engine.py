from __future__ import annotations

import asyncio

import pytest

from execution.engine import topological_sort, validate_graph, execute_graph, CycleError
from models.events import execution_run_id
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


@pytest.mark.asyncio
async def test_execute_graph_scopes_run_id_across_child_tasks_and_resets() -> None:
    observed: list[str | None] = []

    async def emit(_event) -> None:
        observed.append(execution_run_id.get())

    await execute_graph(
        nodes=[_node("a", "text-input")],
        edges=[],
        api_keys={},
        handler_registry={},
        emit=emit,
        run_id="run-engine-123",
    )

    assert observed
    assert set(observed) == {"run-engine-123"}
    assert execution_run_id.get() is None


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
    async def test_multiple_input_port_accumulates_wires_in_edge_order(self, tmp_path) -> None:
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

        # Real files: image-input now validates its filePath on execute, so the
        # paths must exist for this accumulation-order assertion to be reached.
        one = tmp_path / "one.png"
        two = tmp_path / "two.png"
        one.write_bytes(b"\x89PNG\r\n\x1a\n")
        two.write_bytes(b"\x89PNG\r\n\x1a\n")

        nodes = [
            GraphNode(id="a", definitionId="image-input", params={"filePath": str(one)}, outputs={}),
            GraphNode(id="b", definitionId="image-input", params={"filePath": str(two)}, outputs={}),
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
        assert captured["images"].value == [str(one), str(two)]

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


class TestImageInputValidation:
    """image-input validates its filePath on execute, so a dead reference fails at
    the source instead of flowing downstream where a vision node would silently
    analyze nothing."""

    def test_missing_file_raises(self, tmp_path) -> None:
        from execution.engine import _image_input_output

        missing = tmp_path / "gone.png"
        with pytest.raises(ValueError, match="not found"):
            _image_input_output({"filePath": str(missing)})

    def test_existing_file_passes_through(self, tmp_path) -> None:
        from execution.engine import _image_input_output

        png = tmp_path / "ref.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n")
        out = _image_input_output({"filePath": str(png)})
        assert out["image"]["value"] == str(png)

    def test_empty_path_passes_through(self) -> None:
        """An unconfigured node (empty filePath) must not raise — it just yields an empty ref."""
        from execution.engine import _image_input_output

        out = _image_input_output({"filePath": ""})
        assert out["image"]["value"] == ""

    def test_remote_url_passes_through(self) -> None:
        from execution.engine import _image_input_output

        out = _image_input_output({"filePath": "https://cdn.example.com/x.png"})
        assert out["image"]["value"] == "https://cdn.example.com/x.png"

    @pytest.mark.asyncio
    async def test_missing_image_input_emits_error_and_blocks_downstream(self, tmp_path) -> None:
        from models.events import ErrorEvent, ExecutedEvent

        events = []

        async def emit(event) -> None:
            events.append(event)

        ran = []

        async def downstream_handler(_node, _inputs, _api_keys) -> dict:
            ran.append(True)
            return {"text": {"type": "Text", "value": "ok"}}

        missing = tmp_path / "gone.png"
        nodes = [
            GraphNode(id="img", definitionId="image-input", params={"filePath": str(missing)}, outputs={}),
            GraphNode(id="chat", definitionId="claude-chat", params={}, outputs={}),
        ]
        edges = [_edge("img", "chat", "image", "images")]

        await execute_graph(nodes, edges, {}, {"claude-chat": downstream_handler}, emit)

        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert any(e.node_id == "img" and "not found" in e.error for e in error_events)
        # The downstream vision node must NOT run with a dead reference...
        assert ran == []
        # ...and must not report a successful execution.
        assert not any(isinstance(e, ExecutedEvent) and e.node_id == "chat" for e in events)
