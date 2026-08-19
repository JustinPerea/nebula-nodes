"""Tests for backend/services/ffmpeg.py."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.ffmpeg import ProbeResult, ffprobe_video, run_ffmpeg


@pytest.mark.asyncio
async def test_ffprobe_video_returns_duration_fps_vfr_flag(tmp_path: Path) -> None:
    fake_json = b'{"format":{"duration":"8.5"},"streams":[{"codec_type":"video","r_frame_rate":"30/1","avg_frame_rate":"30/1"},{"codec_type":"audio"}]}'
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    with patch("services.ffmpeg._spawn_subprocess") as mock_spawn:
        mock_spawn.return_value = AsyncMock(
            communicate=AsyncMock(return_value=(fake_json, b"")),
            returncode=0,
        )
        result = await ffprobe_video(src)

    assert isinstance(result, ProbeResult)
    assert result.duration == 8.5
    assert result.fps == 30.0
    assert result.is_vfr is False
    assert result.has_audio is True


@pytest.mark.asyncio
async def test_ffprobe_video_detects_vfr(tmp_path: Path) -> None:
    fake_json = b'{"format":{"duration":"8.0"},"streams":[{"codec_type":"video","r_frame_rate":"30/1","avg_frame_rate":"24/1"}]}'
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    with patch("services.ffmpeg._spawn_subprocess") as mock_spawn:
        mock_spawn.return_value = AsyncMock(
            communicate=AsyncMock(return_value=(fake_json, b"")),
            returncode=0,
        )
        result = await ffprobe_video(src)
    assert result.is_vfr is True
    assert result.has_audio is False


@pytest.mark.asyncio
async def test_ffprobe_video_kills_child_when_execution_is_cancelled() -> None:
    started = asyncio.Event()
    never = asyncio.Event()
    fake_proc = AsyncMock()
    fake_proc.returncode = None
    fake_proc.kill = MagicMock()
    fake_proc.wait = AsyncMock(return_value=None)

    async def communicate():
        started.set()
        await never.wait()
        return b"", b""

    fake_proc.communicate = communicate
    with patch("services.ffmpeg._spawn_subprocess", AsyncMock(return_value=fake_proc)):
        task = asyncio.create_task(ffprobe_video("/tmp/input.mp4"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    fake_proc.kill.assert_called_once()
    fake_proc.wait.assert_awaited_once()


@pytest.mark.asyncio
async def test_run_ffmpeg_invokes_progress_callback_per_block(tmp_path: Path) -> None:
    """run_ffmpeg parses key=value progress lines and calls on_progress per `progress=` line."""
    # Simulate ffmpeg emitting two progress blocks
    progress_lines = (
        b"out_time_us=500000\n"
        b"progress=continue\n"
        b"out_time_us=1000000\n"
        b"progress=end\n"
    )

    blocks: list[dict[str, str]] = []

    class _FakeStream:
        def __init__(self, data: bytes) -> None:
            self._lines = data.splitlines(keepends=True)
            self._idx = 0

        def __aiter__(self):
            return self

        async def __anext__(self) -> bytes:
            if self._idx >= len(self._lines):
                raise StopAsyncIteration
            line = self._lines[self._idx]
            self._idx += 1
            return line

    fake_proc = AsyncMock()
    fake_proc.stdout = _FakeStream(progress_lines)
    fake_proc.stderr = _FakeStream(b"")
    fake_proc.wait = AsyncMock(return_value=0)

    with patch("services.ffmpeg._spawn_subprocess", AsyncMock(return_value=fake_proc)):
        await run_ffmpeg(
            ["-i", "in.mp4", "-c:v", "libx264", "out.mp4"],
            on_progress=blocks.append,
        )

    assert len(blocks) == 2
    assert blocks[0] == {"out_time_us": "500000", "progress": "continue"}
    assert blocks[1] == {"out_time_us": "1000000", "progress": "end"}


@pytest.mark.asyncio
async def test_run_ffmpeg_raises_on_nonzero_exit(tmp_path: Path) -> None:
    """Non-zero ffmpeg exit raises RuntimeError with stderr tail."""
    class _EmptyStream:
        def __aiter__(self):
            return self

        async def __anext__(self) -> bytes:
            raise StopAsyncIteration

    class _StderrStream:
        def __init__(self) -> None:
            self._chunks = [b"Encoder error: invalid codec\n"]
            self._idx = 0

        def __aiter__(self):
            return self

        async def __anext__(self) -> bytes:
            if self._idx >= len(self._chunks):
                raise StopAsyncIteration
            v = self._chunks[self._idx]
            self._idx += 1
            return v

    fake_proc = AsyncMock()
    fake_proc.stdout = _EmptyStream()
    fake_proc.stderr = _StderrStream()
    fake_proc.wait = AsyncMock(return_value=1)

    with patch("services.ffmpeg._spawn_subprocess", AsyncMock(return_value=fake_proc)):
        with pytest.raises(RuntimeError, match="ffmpeg failed.*Encoder error"):
            await run_ffmpeg(["-i", "in.mp4", "out.mp4"])
