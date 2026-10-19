"""Thumbnails for the zoomed-out canvas: GET /api/outputs/<rel>?thumb=1 (gap 19)."""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import main as main_module  # noqa: E402
from services import output as output_mod  # noqa: E402
from services import output_thumbnail  # noqa: E402


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    root = tmp_path / "out"
    root.mkdir()
    cache = tmp_path / "thumbnails"
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", root)
    monkeypatch.setattr(main_module, "OUTPUT_ROOT", root)
    monkeypatch.setattr(main_module, "DEFAULT_OUTPUT_ROOT", root)
    monkeypatch.setattr(main_module, "_THUMBNAIL_DIR", cache)
    return TestClient(main_module.app), root, cache


def _png(path: Path, size=(2048, 1024), mode="RGB", colour=(200, 90, 40)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fill = (*colour, 128) if mode == "RGBA" else colour
    Image.new(mode, size, fill).save(path, "PNG")
    return path


def _opened(content: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(content))
    image.load()
    return image


def test_an_image_comes_back_small_and_is_made_once(outputs, monkeypatch):
    client, root, cache = outputs
    _png(root / "run-1" / "hero.png")
    made = []
    real = output_thumbnail._encode
    monkeypatch.setattr(output_thumbnail, "_encode", lambda image: made.append(1) or real(image))

    first = client.get("/api/outputs/run-1/hero.png?thumb=1")
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/jpeg"
    assert first.headers["x-content-type-options"] == "nosniff"
    small = _opened(first.content)
    assert max(small.size) == output_thumbnail.EDGE
    assert small.size == (512, 256)

    again = client.get("/api/outputs/run-1/hero.png?thumb=1")
    assert again.status_code == 200
    assert again.content == first.content
    assert len(made) == 1
    assert len(list(cache.glob("*.jpg"))) == 1


def test_without_thumb_the_file_itself_is_served(outputs):
    client, root, cache = outputs
    source = _png(root / "run-1" / "hero.png")
    response = client.get("/api/outputs/run-1/hero.png")
    assert response.status_code == 200
    assert response.content == source.read_bytes()
    assert not cache.exists()


def test_transparency_is_kept_as_png(outputs):
    client, root, _ = outputs
    _png(root / "run-1" / "mark.png", size=(800, 800), mode="RGBA")
    response = client.get("/api/outputs/run-1/mark.png?thumb=1")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    small = _opened(response.content)
    assert small.mode == "RGBA"
    assert small.getchannel("A").getextrema()[0] < 255


def test_a_small_image_is_not_enlarged(outputs):
    client, root, _ = outputs
    _png(root / "run-1" / "icon.png", size=(120, 80))
    response = client.get("/api/outputs/run-1/icon.png?thumb=1")
    assert _opened(response.content).size == (120, 80)


def test_a_changed_file_gets_a_new_thumbnail(outputs):
    client, root, _ = outputs
    source = _png(root / "run-1" / "hero.png", colour=(200, 90, 40))
    first = _opened(client.get("/api/outputs/run-1/hero.png?thumb=1").content)
    _png(source, colour=(20, 60, 220))
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
    second = _opened(client.get("/api/outputs/run-1/hero.png?thumb=1").content)
    assert first.getpixel((10, 10))[2] < 100
    assert second.getpixel((10, 10))[2] > 150


def test_other_files_and_unreadable_images_have_no_thumbnail(outputs):
    client, root, _ = outputs
    notes = root / "run-1" / "notes.txt"
    notes.parent.mkdir(parents=True)
    notes.write_text("hello")
    broken = root / "run-1" / "broken.png"
    broken.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    assert client.get("/api/outputs/run-1/notes.txt?thumb=1").status_code == 415
    assert client.get("/api/outputs/run-1/broken.png?thumb=1").status_code == 415
    # The files themselves still serve.
    assert client.get("/api/outputs/run-1/notes.txt").status_code == 200


def test_thumb_keeps_the_outputs_containment(outputs, tmp_path):
    client, _, cache = outputs
    _png(tmp_path / "secret.png")
    assert client.get("/api/outputs/..%2Fsecret.png?thumb=1").status_code == 404
    assert client.get("/api/outputs/missing/ghost.png?thumb=1").status_code == 404
    assert not cache.exists()


def test_a_video_gives_a_still(outputs, monkeypatch):
    client, root, _ = outputs
    clip = root / "run-2" / "clip.mp4"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(b"not decoded in this test")
    asked = []

    async def fake_extract(path, points, work_dir):
        asked.append((path, list(points)))
        return [_png(work_dir / "frame-00.png", size=(1920, 1080))]

    import services.qc_common as qc_common
    monkeypatch.setattr(qc_common, "extract_frames", fake_extract)
    response = client.get("/api/outputs/run-2/clip.mp4?thumb=1")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/jpeg"
    assert _opened(response.content).size == (512, 288)
    assert asked == [(clip.resolve(), [0.1])]


def test_a_video_without_a_still_is_refused_not_crashed(outputs, monkeypatch):
    client, root, _ = outputs
    clip = root / "run-2" / "clip.mov"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(b"x")

    async def no_ffmpeg(path, points, work_dir):
        raise RuntimeError("ffmpeg not found")

    import services.qc_common as qc_common
    monkeypatch.setattr(qc_common, "extract_frames", no_ffmpeg)
    response = client.get("/api/outputs/run-2/clip.mov?thumb=1")
    assert response.status_code == 415
    assert "still" in response.json()["detail"]


def test_the_cache_keeps_the_most_recently_used(outputs, monkeypatch):
    client, root, cache = outputs
    monkeypatch.setattr(output_thumbnail, "CACHE_LIMIT", 5)
    for index in range(5):
        _png(root / "run-3" / f"img{index}.png", size=(64, 64))
        assert client.get(f"/api/outputs/run-3/img{index}.png?thumb=1").status_code == 200
    # Age them, then use img0 again so it counts as recent.
    for offset, entry in enumerate(sorted(cache.iterdir())):
        os.utime(entry, (1_000_000 + offset, 1_000_000 + offset))
    client.get("/api/outputs/run-3/img0.png?thumb=1")
    _png(root / "run-3" / "img5.png", size=(64, 64))
    client.get("/api/outputs/run-3/img5.png?thumb=1")
    kept = list(cache.iterdir())
    assert len(kept) <= 5
    key0 = output_thumbnail._key((root / "run-3" / "img0.png"))
    key5 = output_thumbnail._key((root / "run-3" / "img5.png"))
    names = {entry.stem for entry in kept}
    assert key0 in names and key5 in names
