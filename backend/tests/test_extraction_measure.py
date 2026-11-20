"""Intake and measurement: what is refused, and what code measures on the fixture images."""
from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from extraction.errors import ExtractionRefused
from extraction.intake import intake, rendering_png
from extraction.measure import measure

BACKEND = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures" / "extraction"
BASELINE = json.loads((FIXTURES / "measure_file_v6.json").read_text())


def _bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _encode(image: Image.Image, fmt: str) -> bytes:
    out = io.BytesIO()
    image.save(out, fmt)
    return out.getvalue()


# -- intake -------------------------------------------------------------------------------------


def test_video_is_refused_in_one_plain_sentence():
    mp4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
    mov = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 64
    for data in (mp4, mov):
        with pytest.raises(ExtractionRefused, match=r"^Videos aren't supported yet\. Use a still image"):
            intake(data)


@pytest.mark.parametrize("data", [
    b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
    b"this is not an image at all, just words",
    b"",
    b"\x00" * 100,
])
def test_svg_garbage_and_empty_are_refused(data):
    with pytest.raises(ExtractionRefused) as caught:
        intake(data)
    assert str(caught.value).endswith(".") and "\n" not in str(caught.value)


def test_a_truncated_image_is_refused_as_unreadable():
    with pytest.raises(ExtractionRefused, match="couldn't be read"):
        intake(_bytes("gradient_accent.png")[:40])


def test_oversize_is_refused_before_decoding():
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * (25 * 1024 * 1024)
    with pytest.raises(ExtractionRefused, match="too large"):
        intake(data)


def test_an_unknown_kind_is_refused():
    with pytest.raises(ExtractionRefused, match="kind"):
        intake(_bytes("one_pixel.png"), kind="url")  # type: ignore[arg-type]


@pytest.mark.parametrize("fmt, ext", [("JPEG", "jpg"), ("PNG", "png"), ("GIF", "gif"), ("WEBP", "webp")])
def test_stills_are_taken(fmt, ext):
    item = intake(_encode(Image.new("RGB", (8, 6), (10, 120, 200)), fmt), name="x", kind="paste")
    assert item.ext == ext and item.image.size == (8, 6) and item.kind == "paste" and item.mtime is None


def test_a_file_path_gives_its_mtime(tmp_path):
    path = tmp_path / "a.png"
    path.write_bytes(_bytes("one_pixel.png"))
    item = intake(path.read_bytes(), name="a.png", kind="file", path=str(path))
    assert item.path == str(path) and item.mtime and item.mtime.endswith("Z")


def test_rendering_png_keeps_alpha():
    item = intake(_bytes("partly_transparent.png"))
    again = Image.open(io.BytesIO(rendering_png(item.image)))
    assert again.mode == "RGBA" and again.size == (80, 60)


# -- measurement --------------------------------------------------------------------------------


def test_measured_values_on_the_accent_image():
    block, perceptual = measure(intake(_bytes("gradient_accent.png")).image)
    assert block["origin"] == "code" and block["code_version"] == "measure-2" and block["region_measures"] == {}
    palette = block["palette"]
    assert [p["index"] for p in palette] == list(range(len(palette)))
    assert [p["hex"] for p in palette if p["is_accent"]] == ["#e61e28"]
    assert set(palette[0]) == {"index", "hex", "share", "is_accent"}
    assert block["aspect"] == 1.5
    assert set(block["value_range"]) == {"low", "high"} and block["value_range"]["low"] < block["value_range"]["high"]
    # One scale: mean L* (0-100) of the palette's pixels; saturation is the moodboard's 0-255 mean on 0-100.
    assert block["units"] == {"value_range": "L* 0-100", "lightness": "L* 0-100", "saturation": "HSV saturation 0-100"}
    assert 0 < block["lightness"] <= 100 and block["lightness"] == round(block["lightness"], 1)
    assert block["saturation"] == round(BASELINE["gradient_accent.png"]["saturation"] / 255 * 100, 1)
    assert len(perceptual) == 16 and int(perceptual, 16) >= 0


def test_lightness_is_lab_l_star_of_the_visible_pixels():
    black, _ = measure(Image.new("RGB", (8, 8), (0, 0, 0)))
    white, _ = measure(Image.new("RGB", (8, 8), (255, 255, 255)))
    assert black["lightness"] == 0.0 and white["lightness"] == 100.0
    assert white["saturation"] == 0.0
    # Half black, half transparent: the transparent half is not a pixel, so the mean stays 0.
    half = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    half.paste(Image.new("RGBA", (8, 4), (0, 0, 0, 255)), (0, 0))
    assert measure(half)[0]["lightness"] == 0.0


def test_the_one_pixel_and_transparent_images():
    one, _ = measure(intake(_bytes("one_pixel.png")).image)
    assert [(p["hex"], p["share"]) for p in one["palette"]] == [("#c87828", 1.0)]
    clear, _ = measure(intake(_bytes("fully_transparent.png")).image)
    assert clear["palette"] == [] and clear["value_range"] is None
    assert clear["lightness"] is None and clear["saturation"] is None
    tall, _ = measure(intake(_bytes("tall_narrow.png")).image)
    assert tall["aspect"] == round(12 / 180, 4)


def test_measurement_is_repeatable():
    image = intake(_bytes("partly_transparent.png")).image
    assert measure(image) == measure(image)


# -- isolation ----------------------------------------------------------------------------------


def test_importing_the_library_touches_no_state(tmp_path):
    """Run in a fresh interpreter with its own home, state, settings and output folders."""
    home, state, out = tmp_path / "home", tmp_path / "state", tmp_path / "out"
    for folder in (home, state, out):
        folder.mkdir()
    code = (
        "import sys; sys.path.insert(0, %r)\n"
        "import extraction, extraction.cli, extraction.store, extraction.record\n"
        "bad = [m for m in ('main', 'fastapi', 'commons.activation', 'commons.store') if m in sys.modules]\n"
        "print(bad)\n" % str(BACKEND)
    )
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "NEBULA_STATE_DIR": str(state),
           "NEBULA_OUTPUT_ROOT": str(out), "NEBULA_SETTINGS_PATH": str(tmp_path / "settings.json")}
    result = subprocess.run([sys.executable, "-I", "-c", code], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"
    assert list(home.iterdir()) == [] and list(state.iterdir()) == [] and list(out.iterdir()) == []
    assert not (tmp_path / "settings.json").exists()
