"""Tests for backend/handlers/video_edit.py."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from handlers.video_edit import handle_video_edit, render_video_edit_file
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
@pytest.mark.parametrize(
    ("output_format", "expected_codec", "expected_suffix"),
    [
        ("mp4", "libx264", ".mp4"),
        ("mov", "prores_ks", ".mov"),
        ("webm", "libvpx-vp9", ".webm"),
    ],
)
async def test_final_export_container_codecs(
    tmp_path, output_format, expected_codec, expected_suffix
) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    clips = [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False}
    ]
    captured: list[list[str]] = []

    async def fake_ffmpeg(args, on_progress=None):
        captured.append(args)
        if on_progress is not None:
            on_progress({"out_time_us": "1000000"})
        Path(args[-1]).touch()

    with patch("handlers.video_edit.run_ffmpeg", side_effect=fake_ffmpeg):
        output = await render_video_edit_file(
            src,
            clips,
            output_format=output_format,
            resolution="720p",
            quality="high",
            output_dir=tmp_path,
        )

    assert output.suffix == expected_suffix
    assert expected_codec in captured[0]
    assert "scale=1280:720" in _filter_str(captured[0])


@pytest.mark.asyncio
async def test_final_gif_export_uses_palette_and_omits_audio(tmp_path) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    clips = [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False}
    ]
    captured: list[list[str]] = []

    async def fake_ffmpeg(args, on_progress=None):
        captured.append(args)
        Path(args[-1]).touch()

    with patch("handlers.video_edit.run_ffmpeg", side_effect=fake_ffmpeg):
        output = await render_video_edit_file(
            src,
            clips,
            output_format="gif",
            output_dir=tmp_path,
        )

    args = captured[0]
    filters = _filter_str(args)
    assert output.suffix == ".gif"
    assert "palettegen" in filters
    assert "paletteuse" in filters
    assert "atrim" not in filters
    assert "[outas]" not in args


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


@pytest.mark.asyncio
async def test_clip_dropped_when_sourceIn_exceeds_new_duration(tmp_path, monkeypatch) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: tmp_path / "out")
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    (tmp_path / "out").mkdir()
    probe_result = type("PR", (), {"duration": 3.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 0.0, "sourceOut": 1.5, "speed": 1.0, "volume": 1.0, "mute": False},
            {"id": "c2", "sourceIn": 5.0, "sourceOut": 7.0, "speed": 1.0, "volume": 1.0, "mute": False},
        ],
    })
    async def fake(args, on_progress=None):
        Path(args[-1]).touch()
    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", side_effect=fake),
    ):
        await handle_video_edit(node, {"video_in": PortValueDict(type="Video", value=str(src))}, {})
    assert len(node.params["clips"]) == 1
    assert node.params["clips"][0]["id"] == "c1"


@pytest.mark.asyncio
async def test_sourceOut_clamped_to_new_duration(tmp_path, monkeypatch) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: tmp_path / "out")
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    (tmp_path / "out").mkdir()
    probe_result = type("PR", (), {"duration": 3.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 0.5, "sourceOut": 7.0, "speed": 1.0, "volume": 1.0, "mute": False},
        ],
    })
    async def fake(args, on_progress=None):
        Path(args[-1]).touch()
    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", side_effect=fake),
    ):
        await handle_video_edit(node, {"video_in": PortValueDict(type="Video", value=str(src))}, {})
    assert node.params["clips"][0]["sourceOut"] == 3.0


@pytest.mark.asyncio
async def test_aresample_chained_into_filter_complex_not_passed_as_simple_af(tmp_path, monkeypatch) -> None:
    """ffmpeg rejects -af (simple audio filter) on the same stream as a
    -filter_complex output. The audio resync must be chained into the
    complex graph and the -map must point at the relabeled scaled stream.
    Regression for the Phase F smoke failure where the chain to a downstream
    Veo I2V node errored at the render step with "aresample=async=1 was
    specified for a stream fed from a complex filtergraph"."""
    args = await _run_with_clips(tmp_path, monkeypatch, [
        {"id": "c1", "sourceIn": 0.0, "sourceOut": 2.0, "speed": 1.0, "volume": 1.0, "mute": False}
    ])
    assert "-af" not in args  # no simple audio filter alongside complex graph
    filter_complex = next(args[i + 1] for i, a in enumerate(args) if a == "-filter_complex")
    assert "aresample=async=1" in filter_complex
    assert "[outas]" in filter_complex
    # Mapping uses the resync-corrected label, not the raw concat output
    map_indices = [i for i, a in enumerate(args) if a == "-map"]
    map_targets = [args[i + 1] for i in map_indices]
    assert "[outas]" in map_targets
    assert "[outa]" not in map_targets


@pytest.mark.asyncio
async def test_empty_clips_seeds_full_span_from_probe(tmp_path: Path, monkeypatch) -> None:
    """Run on an edit node with no clips (e.g., spawned downstream of a
    generator that doesn't probe at upload time) must seed a full-span
    no-op clip and return the source video unchanged. Regression for the
    KeyError('clips') that crashed the Veo→Editor path during Phase F smoke.
    """
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: tmp_path / "out")
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    (tmp_path / "out").mkdir()
    probe_result = type("PR", (), {"duration": 6.5, "fps": 24.0, "is_vfr": False})()

    node = _node()  # params={} — no 'clips' key
    inputs = {"video_in": PortValueDict(type="Video", value=str(src))}

    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", AsyncMock()) as mock_ffmpeg,
    ):
        result = await handle_video_edit(node, inputs, {}, emit=None)

    assert result == {"video": {"type": "Video", "value": str(src)}}
    mock_ffmpeg.assert_not_called()  # _is_no_op shortcut took the pass-through
    seeded = node.params["clips"]
    assert len(seeded) == 1
    assert seeded[0]["sourceIn"] == 0.0
    assert seeded[0]["sourceOut"] == 6.5
    assert seeded[0]["duration"] == 6.5
    assert seeded[0]["speed"] == 1.0
    assert seeded[0]["volume"] == 1.0
    assert seeded[0]["mute"] is False


@pytest.mark.asyncio
async def test_times_snapped_to_frame_grid(tmp_path, monkeypatch) -> None:
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    monkeypatch.setattr("handlers.video_edit.get_run_dir", lambda: tmp_path / "out")
    monkeypatch.setattr("handlers.video_edit.OUTPUT_ROOT", tmp_path)
    (tmp_path / "out").mkdir()
    probe_result = type("PR", (), {"duration": 8.0, "fps": 30.0, "is_vfr": False})()

    node = _node({
        "clips": [
            {"id": "c1", "sourceIn": 1.05, "sourceOut": 3.07, "speed": 1.0, "volume": 1.0, "mute": False},
        ],
    })
    async def fake(args, on_progress=None):
        Path(args[-1]).touch()
    with (
        patch("handlers.video_edit.ffprobe_video", AsyncMock(return_value=probe_result)),
        patch("handlers.video_edit.run_ffmpeg", side_effect=fake),
    ):
        await handle_video_edit(node, {"video_in": PortValueDict(type="Video", value=str(src))}, {})
    assert abs(node.params["clips"][0]["sourceIn"] - (31 / 30)) < 0.001
    assert abs(node.params["clips"][0]["sourceOut"] - (92 / 30)) < 0.001
