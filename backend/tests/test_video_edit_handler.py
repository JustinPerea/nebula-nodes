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


@pytest.mark.asyncio
async def test_mixed_mute_generates_silent_audio_for_muted_clips(tmp_path: Path, monkeypatch) -> None:
    """When clips have mixed mute state, muted clips get anullsrc silence so concat stream count matches."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: tmp_path / "out")
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    (tmp_path / "out").mkdir()

    probe_result = type("PR", (), {"duration": 8.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False},
            {"id": "c2", "sourceIn": 2.0, "sourceOut": 5.0, "speed": 1.0, "volume": 1.0, "mute": True},
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
        await handle_video_edit(node, {"video_in": PortValueDict(type="Video", value=str(src))}, {})

    args = captured[0]
    filter_complex = next(args[i + 1] for i, a in enumerate(args) if a == "-filter_complex")
    # Muted clip gets a silence track sized to output duration (3.0s at speed 1.0)
    assert "anullsrc=cl=stereo:r=44100:d=3.0[a1]" in filter_complex
    # Both [a0] and [a1] interleaved into the concat
    assert "[v0][a0][v1][a1]concat=n=2:v=1:a=1" in filter_complex


async def _run_with_clips(tmp_path, monkeypatch, clips):
    """Helper: run handler with given clips, return the captured ffmpeg args."""
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    out_dir = tmp_path / "output" / "run-1"
    out_dir.mkdir(parents=True)
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: out_dir)
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    probe_result = type("PR", (), {"duration": 8.0, "fps": 30.0, "is_vfr": False})()

    captured: list[list[str]] = []
    async def fake_ffmpeg(args, on_progress=None):
        captured.append(args)
        Path(args[-1]).touch()
    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", side_effect=fake_ffmpeg),
    ):
        await handle_video_edit(
            _node({"clips": clips}),
            {"video_in": PortValueDict(type="Video", value=str(src))},
            {},
        )
    return captured[0] if captured else []


def _filter_str(args: list[str]) -> str:
    return next(args[i + 1] for i, a in enumerate(args) if a == "-filter_complex")


@pytest.mark.asyncio
async def test_speed_change_injects_setpts_and_atempo(tmp_path, monkeypatch) -> None:
    args = await _run_with_clips(tmp_path, monkeypatch, [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 4.0, "speed": 0.5, "volume": 1.0, "mute": False}
    ])
    f = _filter_str(args)
    assert "setpts=PTS/0.5" in f
    assert "atempo=0.5" in f


@pytest.mark.asyncio
async def test_multi_clip_concat_emits_correct_stream_count(tmp_path, monkeypatch) -> None:
    args = await _run_with_clips(tmp_path, monkeypatch, [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False},
        {"id": "c2", "sourceIn": 2.0, "sourceOut": 5.0, "speed": 1.0, "volume": 1.0, "mute": False},
    ])
    f = _filter_str(args)
    assert "[v0]" in f and "[v1]" in f
    assert "concat=n=2:v=1:a=1" in f


@pytest.mark.asyncio
async def test_all_muted_omits_audio_chain(tmp_path, monkeypatch) -> None:
    args = await _run_with_clips(tmp_path, monkeypatch, [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 0.5, "mute": True}
    ])
    f = _filter_str(args)
    assert "atrim" not in f
    assert "anullsrc" not in f
    assert "concat=n=1:v=1:a=0" in f


@pytest.mark.asyncio
async def test_volume_injects_volume_filter(tmp_path, monkeypatch) -> None:
    args = await _run_with_clips(tmp_path, monkeypatch, [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 0.4, "mute": False}
    ])
    assert "volume=0.4" in _filter_str(args)
