from __future__ import annotations

import io
import shutil
import subprocess
import warnings

import pytest
from PIL import Image

from commons import media


def _png(size=(32, 24), color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_sniff_by_magic_bytes_not_extension():
    assert media.sniff(_png()).mime == "image/png"
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, "JPEG")
    assert media.sniff(buf.getvalue()).ext == "jpg"
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, "WEBP")
    assert media.sniff(buf.getvalue()).mime == "image/webp"
    with pytest.raises(media.MediaError, match="unsupported"):
        media.sniff(b"%PDF-1.7 not an image")
    with pytest.raises(media.MediaError):
        media.sniff(b'{"apiKeys": {"openai": "x"}}')


def test_size_caps():
    media.check_size("image", media.IMAGE_CAP)
    with pytest.raises(media.MediaError, match="25 MB"):
        media.check_size("image", media.IMAGE_CAP + 1)
    with pytest.raises(media.MediaError, match="500 MB"):
        media.check_size("video", media.VIDEO_CAP + 1)


def test_animated_gif_uses_first_frame():
    frames = [Image.new("RGB", (8, 8), c) for c in [(255, 0, 0), (0, 0, 255)]]
    buf = io.BytesIO()
    frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    img = media.load_image(buf.getvalue(), "image/gif")
    assert img.mode == "RGB"
    r, g, b = img.getpixel((0, 0))
    assert r > 200 and b < 50


def test_decompression_bomb_is_an_error(monkeypatch):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(media.MediaError, match="too many pixels"):
        media.load_image(_png(size=(20, 20)), "image/png")


def test_encode_png_limits_edge():
    img = Image.new("RGB", (3000, 1000))
    out = Image.open(io.BytesIO(media.encode_png(img, max_edge=1568)))
    assert max(out.size) == 1568


@pytest.mark.parametrize("duration,cuts,expected_len", [
    (4.0, [2.0], 2),                # two scenes -> two mid-scene frames
    (30.0, [], 3),                  # single shot -> evenly spaced
    (600.0, [float(i) for i in range(1, 100)], 12),  # capped at 12
])
def test_keyframe_times(duration, cuts, expected_len):
    times = media.keyframe_times(duration, cuts)
    assert len(times) == expected_len
    assert all(0 < t < duration for t in times)
    assert times == sorted(times)
    for cut in cuts:
        assert all(abs(t - cut) > 1e-6 for t in times)  # never at the cut


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_video_probe_cuts_and_frames(tmp_path):
    video = tmp_path / "clip.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=2:r=10",
        "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2:r=10",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
        "-pix_fmt", "yuv420p", str(video),
    ], check=True, timeout=120)
    assert media.sniff(video.read_bytes()[:64]).media == "video"
    info = media.probe_video(video)
    assert info["width"] == 64 and info["duration"] == pytest.approx(4.0, abs=0.3)
    cuts = media.scene_cuts(video)
    assert any(abs(c - 2.0) < 0.3 for c in cuts)
    times = media.keyframe_times(info["duration"], cuts)
    frame = Image.open(io.BytesIO(media.extract_frame(video, times[-1]))).convert("RGB")
    r, g, b = frame.getpixel((32, 32))
    assert b > r  # the last frame is from the blue scene


def test_decoder_only_accepts_the_sniffed_format():
    # PNG bytes presented as JPEG must not be decoded as PNG anyway.
    with pytest.raises(media.MediaError):
        media.load_image(_png(), "image/jpeg")
    with pytest.raises(media.MediaError, match="unsupported"):
        media.load_image(_png(), "image/tiff")


def test_ffmpeg_inputs_are_forced_to_mov_file_protocol(monkeypatch, tmp_path):
    seen = []

    class Done:
        returncode = 0
        stdout = b'{"streams": [{"codec_type": "video", "width": 2, "height": 2}], "format": {"duration": "1"}}'
        stderr = b""

    monkeypatch.setattr(media, "_run", lambda args: seen.append(args) or Done())
    target = tmp_path / "-rf.mp4"
    media.probe_video(target)
    media.scene_cuts(target)
    try:
        media.extract_frame(target, 0.5)
    except media.MediaError:
        pass  # stdout isn't a PNG here; only the argv matters
    for args in seen:
        i = args.index("-i")
        assert args[i + 1] == f"file:{target.resolve()}"
        guard = args[i - 6:i]
        assert guard == ["-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0"]
