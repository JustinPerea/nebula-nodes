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
        "sourceDuration": 8.0,
        "sourceFps": 30.0,
        "sourceIsVfr": False,
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
