"""F-31: media byte validation for output file writes.

Validates that services.output checks the actual bytes of every file it writes
(magic bytes for images/GLB meshes, ffprobe for video containers) and corrects
mismatched extensions by renaming in place — while failing safely (no
misclassification, no fabricated success) for unknown bytes or probe errors.

Fixtures use real magic-byte headers, a real ffmpeg-generated mp4, and a real
audio-only mp4 for the no-video-stream rejection path.
"""
from __future__ import annotations

import base64
import logging
import shutil
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import services.output as output_mod
from services.ffmpeg import ProbeResult
from services.output import (
    _validate_and_correct_extension,
    save_base64_image,
    save_base64_image_named,
    save_mesh_from_url,
    save_video_from_url,
)

# --- Real magic-byte fixtures ------------------------------------------------

JPEG_BYTES = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xd9"
)
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00" * 32
WEBP_BYTES = b"RIFF" + (20).to_bytes(4, "little") + b"WEBPVP8 " + b"\x00" * 8
GIF_BYTES = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"
GLB_BYTES = b"glTF" + (2).to_bytes(4, "little") + (12).to_bytes(4, "little")
GARBAGE_BYTES = b"\x00\x11\x22\x33definitely-not-a-known-media-format"

_FFMPEG = shutil.which("ffmpeg")


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def _make_tiny_video(path: Path) -> Path:
    """Render a real (tiny) mp4 with one video stream using ffmpeg."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "color=red:size=16x16:duration=0.2:rate=5",
            "-pix_fmt", "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def _make_audio_only_mp4(path: Path) -> Path:
    """Render a real mp4 containing only an audio stream (no video stream)."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
            "-c:a", "aac",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def _mock_http_download(payload: bytes):
    """Patch httpx.AsyncClient so save_*_from_url downloads *payload*."""
    mock_client = AsyncMock()
    mock_response = MagicMock()
    mock_response.content = payload
    mock_response.raise_for_status = MagicMock()
    mock_client.get = AsyncMock(return_value=mock_response)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return patch("httpx.AsyncClient", return_value=mock_client)


def _warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.WARNING]


# ---------------------------------------------------------------------------
# VAL-F31-001: correct media content is accepted without rename or warning
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,ext",
    [
        (JPEG_BYTES, "jpg"),
        (JPEG_BYTES, "jpeg"),  # equivalent spelling
        (JPEG_BYTES, "JPG"),   # case variation
        (PNG_BYTES, "png"),
        (PNG_BYTES, "PNG"),    # case variation
        (WEBP_BYTES, "webp"),
        (GIF_BYTES, "gif"),
        (GLB_BYTES, "glb"),
    ],
)
async def test_matching_content_left_unchanged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, data: bytes, ext: str
) -> None:
    target = _write(tmp_path / f"out.{ext}", data)
    with caplog.at_level(logging.WARNING, logger="services.output"):
        result = await _validate_and_correct_extension(target)
    assert result == target
    assert target.exists()
    assert target.read_bytes() == data
    assert _warnings(caplog) == []


@pytest.mark.asyncio
async def test_image_content_does_not_invoke_ffprobe(tmp_path: Path) -> None:
    """ffprobe is only for video extensions — images validate via magic bytes."""
    target = _write(tmp_path / "out.png", PNG_BYTES)
    with patch.object(
        output_mod, "ffprobe_video", new=AsyncMock()
    ) as mock_probe:
        result = await _validate_and_correct_extension(target)
    assert result == target
    mock_probe.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")
async def test_real_video_file_accepted(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    target = _make_tiny_video(tmp_path / "clip.mp4")
    original = target.read_bytes()
    with caplog.at_level(logging.WARNING, logger="services.output"):
        result = await _validate_and_correct_extension(target)
    assert result == target
    assert target.read_bytes() == original
    assert _warnings(caplog) == []


@pytest.mark.asyncio
async def test_video_extension_accepted_when_probe_finds_stream(
    tmp_path: Path,
) -> None:
    target = _write(tmp_path / "clip.webm", GARBAGE_BYTES)
    probe_ok = ProbeResult(duration=1.0, fps=30.0, is_vfr=False)
    with patch.object(
        output_mod, "ffprobe_video", new=AsyncMock(return_value=probe_ok)
    ) as mock_probe:
        result = await _validate_and_correct_extension(target)
    assert result == target
    mock_probe.assert_awaited_once_with(target)


# ---------------------------------------------------------------------------
# VAL-F31-002: mismatched extensions are corrected via rename
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,wrong_ext,right_ext",
    [
        (JPEG_BYTES, "png", "jpg"),
        (PNG_BYTES, "jpg", "png"),
        (WEBP_BYTES, "png", "webp"),
        (GIF_BYTES, "jpg", "gif"),
    ],
)
async def test_mismatched_extension_is_renamed(
    tmp_path: Path, data: bytes, wrong_ext: str, right_ext: str
) -> None:
    target = _write(tmp_path / f"asset.{wrong_ext}", data)
    result = await _validate_and_correct_extension(target)
    assert result == tmp_path / f"asset.{right_ext}"
    assert not target.exists(), "old path must not exist after rename"
    assert result.exists()
    assert result.read_bytes() == data, "rename must preserve bytes exactly"


@pytest.mark.asyncio
async def test_rename_stays_in_same_directory(tmp_path: Path) -> None:
    sub = tmp_path / "nested"
    sub.mkdir()
    target = _write(sub / "deep.png", JPEG_BYTES)
    result = await _validate_and_correct_extension(target)
    assert result.parent == sub, "rename must not traverse directories"
    assert result.name == "deep.jpg"


@pytest.mark.asyncio
async def test_warning_logged_on_mismatch(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    target = _write(tmp_path / "asset.png", JPEG_BYTES)
    with caplog.at_level(logging.WARNING, logger="services.output"):
        result = await _validate_and_correct_extension(target)
    warnings = _warnings(caplog)
    assert warnings, "a warning must be logged on extension mismatch"
    message = warnings[0].getMessage()
    assert "asset.png" in message
    assert "asset.jpg" in message
    assert result.suffix == ".jpg"


def test_save_base64_image_corrects_mismatch(tmp_path: Path) -> None:
    """End-to-end through the sync write path: JPEG bytes saved as .png."""
    b64 = base64.b64encode(JPEG_BYTES).decode()
    result = save_base64_image(b64, tmp_path, extension="png")
    assert result.suffix == ".jpg"
    assert result.exists()
    assert result.read_bytes() == JPEG_BYTES
    assert not (tmp_path / f"{result.stem}.png").exists()


def test_save_base64_image_named_corrects_mismatch(tmp_path: Path) -> None:
    b64 = base64.b64encode(PNG_BYTES).decode()
    result = save_base64_image_named(b64, tmp_path, name="node1_final", extension="jpg")
    assert result == tmp_path / "node1_final.png"
    assert result.read_bytes() == PNG_BYTES


def test_save_base64_image_invokes_validation(tmp_path: Path) -> None:
    with patch.object(
        output_mod, "_validate_magic_bytes", side_effect=lambda p: p
    ) as spy:
        b64 = base64.b64encode(PNG_BYTES).decode()
        result = save_base64_image(b64, tmp_path, extension="png")
    spy.assert_called_once()
    assert spy.call_args.args[0] == result


# ---------------------------------------------------------------------------
# VAL-F31-003: unknown bytes and probe failures handled safely
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_bytes_are_not_misclassified(tmp_path: Path) -> None:
    target = _write(tmp_path / "mystery.png", GARBAGE_BYTES)
    result = await _validate_and_correct_extension(target)
    assert result == target, "unknown content must not be renamed"
    assert target.read_bytes() == GARBAGE_BYTES
    # No new files may appear — nothing fabricated.
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.asyncio
async def test_video_probe_failure_is_rejected(tmp_path: Path) -> None:
    target = _write(tmp_path / "broken.mp4", GARBAGE_BYTES)
    with patch.object(
        output_mod,
        "ffprobe_video",
        new=AsyncMock(side_effect=RuntimeError("ffprobe failed: boom")),
    ):
        with pytest.raises(RuntimeError):
            await _validate_and_correct_extension(target)
    # Safe failure: no rename, no deletion, no fabricated success.
    assert target.exists()
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.asyncio
async def test_video_without_video_stream_is_rejected(tmp_path: Path) -> None:
    target = _write(tmp_path / "silent.mp4", GARBAGE_BYTES)
    with patch.object(
        output_mod,
        "ffprobe_video",
        new=AsyncMock(side_effect=RuntimeError("No video stream in source")),
    ):
        with pytest.raises(RuntimeError, match="[Vv]ideo"):
            await _validate_and_correct_extension(target)


@pytest.mark.asyncio
@pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")
async def test_real_ffprobe_rejects_garbage_video(tmp_path: Path) -> None:
    """Integration: real ffprobe on undecodable bytes must reject (no mock)."""
    target = _write(tmp_path / "garbage.mp4", GARBAGE_BYTES)
    with pytest.raises(RuntimeError):
        await _validate_and_correct_extension(target)
    assert target.exists()


@pytest.mark.asyncio
@pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")
async def test_real_audio_only_mp4_is_rejected(tmp_path: Path) -> None:
    """Integration: a container with no video stream is not a valid video."""
    target = _make_audio_only_mp4(tmp_path / "audio_only.mp4")
    with pytest.raises(RuntimeError):
        await _validate_and_correct_extension(target)


# ---------------------------------------------------------------------------
# All output-writing paths invoke validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_save_video_from_url_invokes_validation(tmp_path: Path) -> None:
    spy = AsyncMock(side_effect=lambda p: p)
    with _mock_http_download(GARBAGE_BYTES), patch.object(
        output_mod, "_validate_and_correct_extension", spy
    ):
        result = await save_video_from_url("https://example.com/v.mp4", tmp_path)
    spy.assert_awaited_once()
    assert spy.call_args.args[0] == result
    assert result.suffix == ".mp4"


@pytest.mark.asyncio
async def test_save_mesh_from_url_invokes_validation(tmp_path: Path) -> None:
    spy = AsyncMock(side_effect=lambda p: p)
    with _mock_http_download(GLB_BYTES), patch.object(
        output_mod, "_validate_and_correct_extension", spy
    ):
        result = await save_mesh_from_url("https://example.com/m.glb", tmp_path)
    spy.assert_awaited_once()
    assert spy.call_args.args[0] == result


@pytest.mark.asyncio
@pytest.mark.skipif(_FFMPEG is None, reason="ffmpeg not installed")
async def test_save_video_from_url_accepts_real_video(tmp_path: Path) -> None:
    """End-to-end: downloaded video bytes pass real ffprobe validation."""
    real_video = _make_tiny_video(tmp_path / "source.mp4").read_bytes()
    with _mock_http_download(real_video):
        result = await save_video_from_url("https://example.com/v.mp4", tmp_path)
    assert result.suffix == ".mp4"
    assert result.read_bytes() == real_video


@pytest.mark.asyncio
async def test_save_video_from_url_rejects_undecodable_download(
    tmp_path: Path,
) -> None:
    """End-to-end: a .mp4 download that fails probing raises instead of
    being served as a valid output."""
    with _mock_http_download(GARBAGE_BYTES), patch.object(
        output_mod,
        "ffprobe_video",
        new=AsyncMock(side_effect=RuntimeError("ffprobe failed: no streams")),
    ):
        with pytest.raises(RuntimeError):
            await save_video_from_url("https://example.com/v.mp4", tmp_path)


@pytest.mark.asyncio
async def test_save_mesh_from_url_accepts_glb(tmp_path: Path) -> None:
    with _mock_http_download(GLB_BYTES):
        result = await save_mesh_from_url("https://example.com/m.glb", tmp_path)
    assert result.suffix == ".glb"
    assert result.read_bytes() == GLB_BYTES
