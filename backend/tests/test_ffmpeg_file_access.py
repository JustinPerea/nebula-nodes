"""Real decoder regression: accepted local files cannot act as playlists."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from services.ffmpeg import ffprobe_video, run_ffmpeg

pytestmark = pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="ffmpeg and ffprobe are required for decoder boundary regression",
)


@pytest.fixture
def local_hls_fixture(tmp_path, monkeypatch):
    protected = tmp_path / "commons"
    protected.mkdir()
    public = tmp_path / "public"
    public.mkdir()
    monkeypatch.setenv("NEBULA_COMMONS_ROOT", str(protected))
    segment = protected / "private.ts"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=25:d=2",
        "-c:v", "libx264", "-f", "mpegts", str(segment),
    ], check=True, capture_output=True)
    # The same bytes are exercised under both playlist and normal video names.
    content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\n../commons/private.ts\n#EXT-X-ENDLIST\n"
    playlist = public / "allowed.m3u8"
    playlist.write_text(content)
    return playlist, content


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["m3u8", "mp4"])
async def test_ffprobe_rejects_local_playlist_even_with_video_extension(local_hls_fixture, extension):
    original, content = local_hls_fixture
    source = original.with_suffix("." + extension)
    source.write_text(content)
    with pytest.raises(RuntimeError, match="not on.*whitelist" if extension == "m3u8" else "ffprobe failed"):
        await ffprobe_video(source)


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["m3u8", "mp4"])
async def test_ffmpeg_rejects_local_playlist_before_extracting_protected_frame(local_hls_fixture, extension):
    original, content = local_hls_fixture
    source = original.with_suffix("." + extension)
    source.write_text(content)
    output = source.parent / "leaked.png"
    with pytest.raises(RuntimeError, match="not on.*whitelist" if extension == "m3u8" else "ffmpeg failed"):
        await run_ffmpeg(["-i", str(source), "-frames:v", "1", str(output)])
    assert not output.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("extension,codec", [("mp4", "libx264"), ("webm", "libvpx"), ("avi", "mpeg4")])
async def test_single_file_video_still_probes_and_renders(tmp_path, extension, codec):
    source = tmp_path / ("ordinary." + extension)
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=10:d=1",
        "-c:v", codec, str(source),
    ], check=True, capture_output=True)
    probe = await ffprobe_video(source)
    assert probe.duration == pytest.approx(1.0, abs=0.01)
    output = tmp_path / "frame.png"
    await run_ffmpeg(["-i", str(source), "-frames:v", "1", str(output)])
    assert output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("option", ["-enable_drefs", "-use_absolute_path", "-protocol_whitelist", "-format_whitelist"])
async def test_callers_cannot_override_decoder_boundary(option):
    with pytest.raises(ValueError, match="decoder policy"):
        await run_ffmpeg([option, "1", "-i", "ordinary.mp4", "out.mp4"])


async def _execute_frame_graph(source: Path, params: dict) -> list:
    from execution.engine import execute_graph
    from models.graph import GraphNode, GraphEdge

    events = []
    async def emit(event):
        events.append(event)
    await execute_graph(
        nodes=[
            GraphNode(id="source", definitionId="video-input", params={"filePath": str(source)}),
            GraphNode(id="frame", definitionId="frame-extractor", params=params),
        ],
        edges=[GraphEdge(id="video", source="source", sourceHandle="video", target="frame", targetHandle="video")],
        api_keys={}, handler_registry={}, emit=emit,
    )
    return events


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["first_frame", "last_frame"])
async def test_frame_extractor_uses_guarded_decoder(local_hls_fixture, mode):
    source, _ = local_hls_fixture
    events = await _execute_frame_graph(source, {"mode": mode})
    errors = [event for event in events if event.type == "error" and event.node_id == "frame"]
    assert len(errors) == 1
    assert "whitelist" in errors[0].error
    assert not [event for event in events if event.type == "executed" and event.node_id == "frame"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,expected", [
    ("first_frame", "00:00:00.000"),
    ("middle_frame", "00:00:04.000"),
    ("last_frame", "00:00:07.900"),
    ("timestamp", "00:00:02.500"),
])
async def test_frame_extractor_preserves_timestamps(tmp_path, monkeypatch, mode, expected):
    from unittest.mock import AsyncMock
    from services.ffmpeg import ProbeResult
    source = tmp_path / "normal.mp4"
    source.write_bytes(b"fake video fixture")
    monkeypatch.setattr("services.ffmpeg.ffprobe_video", AsyncMock(return_value=ProbeResult(8, 30, False)))
    renderer = AsyncMock()
    monkeypatch.setattr("services.ffmpeg.run_ffmpeg", renderer)
    events = await _execute_frame_graph(source, {"mode": mode, "timestamp": 2.5})
    renderer.assert_awaited_once()
    args = renderer.call_args.args[0]
    assert args[args.index("-ss") + 1] == expected
    assert args[args.index("-i") + 1] == str(source)
    assert not [event for event in events if event.type == "error"]
