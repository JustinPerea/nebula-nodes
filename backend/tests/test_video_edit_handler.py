"""Tests for backend/handlers/video_edit.py."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from handlers.video_edit import handle_video_edit
from models.graph import GraphNode, PortValueDict


def _node(params: dict | None = None) -> GraphNode:
    return GraphNode(id="n1", definitionId="video-edit", params=params or {})


@pytest.mark.asyncio
async def test_no_op_fast_path_returns_upstream_unchanged(tmp_path: Path) -> None:
    """Virgin Edit node returns upstream Video PortValueDict unchanged.

    No ffmpeg invocation. No file copy. Matches reroute / style-reference
    passthrough precedent.
    """
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    probe_result = type("PR", (), {"duration": 8.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 0.0, "sourceOut": 8.0, "speed": 1.0, "volume": 1.0, "mute": False}
        ],
    })
    inputs = {"video_in": PortValueDict(type="Video", value=str(src))}

    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", AsyncMock()) as mock_ffmpeg,
    ):
        result = await handle_video_edit(node, inputs, {}, emit=None)

    assert result == {"video": {"type": "Video", "value": str(src)}}
    mock_ffmpeg.assert_not_called()

    # Handler writes probe metadata into node.params even on no-op
    assert node.params["sourceDuration"] == 8.0
    assert node.params["sourceFps"] == 30.0
    assert node.params["sourceIsVfr"] is False


@pytest.mark.asyncio
async def test_single_clip_trim_renders_to_output_dir(tmp_path: Path, monkeypatch) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    out_dir = tmp_path / "output" / "run-1"
    out_dir.mkdir(parents=True)
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: out_dir)
    # Also patch OUTPUT_ROOT so _resolve_local_path's sandboxing accepts tmp_path
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)

    probe_result = type("PR", (), {"duration": 8.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 1.0, "sourceOut": 3.0, "speed": 1.0, "volume": 1.0, "mute": False}
        ],
    })

    captured: list[list[str]] = []
    async def fake_ffmpeg(args, on_progress=None):
        captured.append(args)
        Path(args[-1]).touch()

    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", side_effect=fake_ffmpeg),
    ):
        result = await handle_video_edit(node, {"video_in": PortValueDict(type="Video", value=str(src))}, {})

    assert result["video"]["type"] == "Video"
    assert result["video"]["value"].endswith(".mp4")
    args = captured[0]
    filter_complex = next(args[i + 1] for i, a in enumerate(args) if a == "-filter_complex")
    assert "trim=start=1.0:end=3.0" in filter_complex
    assert "atrim=start=1.0:end=3.0" in filter_complex
