from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from services.image_transcode import (
    normalize_image_format,
    transcode_image_file,
    UnsupportedFormatError,
)


class TestNormalize:
    @pytest.mark.parametrize(
        "fmt,expected",
        [
            ("png", ("PNG", "image/png", "png")),
            ("PNG", ("PNG", "image/png", "png")),
            (".jpg", ("JPEG", "image/jpeg", "jpg")),
            ("jpeg", ("JPEG", "image/jpeg", "jpg")),
            ("webp", ("WEBP", "image/webp", "webp")),
        ],
    )
    def test_known(self, fmt: str, expected: tuple) -> None:
        assert normalize_image_format(fmt) == expected

    def test_unknown_raises(self) -> None:
        for bad in ("gif", "", "tiff", "exe"):
            with pytest.raises(UnsupportedFormatError):
                normalize_image_format(bad)


class TestTranscode:
    def _rgba_png(self, tmp_path: Path) -> Path:
        src = tmp_path / "src.png"
        Image.new("RGBA", (8, 6), (255, 0, 0, 128)).save(src, format="PNG")
        return src

    def test_png_to_jpeg_flattens_alpha(self, tmp_path: Path) -> None:
        src = self._rgba_png(tmp_path)
        data, mime, filename = transcode_image_file(src, "jpg")
        assert mime == "image/jpeg"
        assert filename == "src.jpg"
        out = Image.open(io.BytesIO(data))
        assert out.format == "JPEG"
        assert out.mode == "RGB"  # alpha flattened
        assert out.size == (8, 6)

    def test_png_to_webp(self, tmp_path: Path) -> None:
        src = self._rgba_png(tmp_path)
        data, mime, filename = transcode_image_file(src, "webp")
        assert mime == "image/webp"
        assert filename == "src.webp"
        assert Image.open(io.BytesIO(data)).format == "WEBP"

    def test_png_to_png(self, tmp_path: Path) -> None:
        src = self._rgba_png(tmp_path)
        data, _, filename = transcode_image_file(src, "png")
        assert filename == "src.png"
        assert Image.open(io.BytesIO(data)).format == "PNG"

    def test_unsupported_format_raises(self, tmp_path: Path) -> None:
        with pytest.raises(UnsupportedFormatError):
            transcode_image_file(self._rgba_png(tmp_path), "gif")
