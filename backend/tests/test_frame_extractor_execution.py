from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
from uuid import uuid4
from types import SimpleNamespace

import pytest
from PIL import Image

from execution.engine import execute_graph
from models.graph import GraphEdge, GraphNode
from services.output import OUTPUT_ROOT, portable_output_ref


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["first_frame", "middle_frame", "last_frame", "timestamp"])
async def test_frame_extractor_decodes_portable_video_reference(mode):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg is required for local media integration")
    source = OUTPUT_ROOT / f"restored clip é {uuid4().hex}.mp4"
    source.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", "color=c=red:s=64x64:r=10:d=2", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", str(source)], check=True)
    events = []
    async def emit(event):
        events.append(event)
    await execute_graph([
        GraphNode(id="source", definitionId="video-input", params={"filePath": portable_output_ref(str(source))}),
        GraphNode(id="extract", definitionId="frame-extractor", params={"mode": mode, "timestamp": 0.5}),
    ], [GraphEdge(id="edge", source="source", sourceHandle="video", target="extract", targetHandle="video")],
        {}, {}, emit, run_id="restored-frame-test")
    assert not any(event.type == "error" for event in events)
    output = next(event for event in events if event.type == "executed" and event.node_id == "extract")
    frame = Path(output.outputs["image"]["value"])
    assert frame.is_file()
    with Image.open(frame) as image:
        assert image.size == (64, 64)
        red, green, blue = image.convert("RGB").getpixel((0, 0))
        assert red > 200 and green < 20 and blue < 20


@pytest.mark.asyncio
async def test_missing_portable_video_fails_at_extractor_with_actionable_error():
    events = []
    async def emit(event):
        events.append(event)
    await execute_graph([
        GraphNode(id="source", definitionId="video-input", params={"filePath": "/api/outputs/missing.mp4"}),
        GraphNode(id="extract", definitionId="frame-extractor"),
    ], [GraphEdge(id="edge", source="source", sourceHandle="video", target="extract", targetHandle="video")],
        {}, {}, emit)
    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert errors[0].node_id == "extract"
    assert "restore or upload" in errors[0].error


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["first_frame", "middle_frame", "last_frame", "timestamp"])
async def test_frame_extractor_preserves_remote_video_inputs_without_network(monkeypatch, mode):
    """Portable path checks must not reject the existing HTTP video contract."""
    import services.ffmpeg as ffmpeg

    url = "https://example.test/input.mp4"
    commands = []
    probes = []

    async def render(args):
        commands.append(args)
        Image.new("RGB", (64, 64), "red").save(args[-1])

    async def probe(source):
        probes.append(source)
        return SimpleNamespace(duration=2.0)

    monkeypatch.setattr(ffmpeg, "run_ffmpeg", render)
    monkeypatch.setattr(ffmpeg, "ffprobe_video", probe)
    events = []

    async def emit(event):
        events.append(event)

    await execute_graph([
        GraphNode(id="source", definitionId="video-input", params={"filePath": url}),
        GraphNode(id="extract", definitionId="frame-extractor", params={"mode": mode, "timestamp": 0.5}),
    ], [GraphEdge(id="edge", source="source", sourceHandle="video", target="extract", targetHandle="video")],
        {}, {}, emit)
    assert not any(event.type == "error" for event in events)
    assert len(commands) == 1
    assert commands[0][commands[0].index("-i") + 1] == url
    assert probes == ([url] if mode in {"middle_frame", "last_frame"} else [])
    output = next(event for event in events if event.type == "executed" and event.node_id == "extract")
    assert Path(output.outputs["image"]["value"]).is_file()
