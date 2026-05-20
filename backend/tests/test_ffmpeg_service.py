"""Tests for backend/services/ffmpeg.py."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from services.ffmpeg import ProbeResult, ffprobe_video, run_ffmpeg


@pytest.mark.asyncio
async def test_ffprobe_video_returns_duration_fps_vfr_flag(tmp_path: Path) -> None:
    fake_json = b'{"format":{"duration":"8.5"},"streams":[{"codec_type":"video","r_frame_rate":"30/1","avg_frame_rate":"30/1"}]}'
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


@pytest.mark.asyncio
async def test_ffprobe_video_detects_vfr(tmp_path: Path) -> None:
    fake_json = b'{"format":{"duration":"8.0"},"streams":[{"codec_type":"video","r_frame_rate":"30000/1001","avg_frame_rate":"29897/1000"}]}'
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    with patch("services.ffmpeg._spawn_subprocess") as mock_spawn:
        mock_spawn.return_value = AsyncMock(
            communicate=AsyncMock(return_value=(fake_json, b"")),
            returncode=0,
        )
        result = await ffprobe_video(src)
    assert result.is_vfr is True
