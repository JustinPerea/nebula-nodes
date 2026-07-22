from __future__ import annotations

import base64

import pytest

from services.image_input import (
    is_remote_or_data_uri,
    load_local_image,
    SUPPORTED_IMAGE_SUFFIXES,
)

# A minimal valid 1x1 PNG.
_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
    "ae426082"
)


def test_is_remote_or_data_uri():
    assert is_remote_or_data_uri("http://example.com/a.png")
    assert is_remote_or_data_uri("https://example.com/a.png")
    assert is_remote_or_data_uri("data:image/png;base64,AAAA")
    assert not is_remote_or_data_uri("/abs/path/a.png")
    assert not is_remote_or_data_uri("relative/a.png")


def test_load_local_image_returns_mime_and_b64(tmp_path):
    img = tmp_path / "ref.png"
    img.write_bytes(_PNG_BYTES)

    mime_type, b64 = load_local_image(str(img))

    assert mime_type == "image/png"
    assert base64.b64decode(b64) == _PNG_BYTES


def test_load_local_image_maps_jpeg_suffixes(tmp_path):
    img = tmp_path / "ref.JPG"  # uppercase suffix must normalize
    img.write_bytes(_PNG_BYTES)

    mime_type, _ = load_local_image(str(img))
    assert mime_type == "image/jpeg"


def test_missing_path_raises_not_silent(tmp_path):
    """The bug being fixed: a provided-but-missing image path must be a visible
    signal (raise), never a silent skip that lets the node 'succeed' with no image."""
    missing = tmp_path / "does-not-exist.png"
    with pytest.raises(ValueError, match="not found"):
        load_local_image(str(missing))


def test_directory_path_raises(tmp_path):
    with pytest.raises(ValueError, match="not a file"):
        load_local_image(str(tmp_path))


def test_unsupported_type_raises(tmp_path):
    bogus = tmp_path / "notes.txt"
    bogus.write_text("not an image")
    with pytest.raises(ValueError, match="[Uu]nsupported image type"):
        load_local_image(str(bogus))


def test_no_extension_raises(tmp_path):
    noext = tmp_path / "imagefile"
    noext.write_bytes(_PNG_BYTES)
    with pytest.raises(ValueError, match="no extension"):
        load_local_image(str(noext))


def test_supported_suffixes_include_common_image_types():
    for suffix in ("png", "jpg", "jpeg", "webp", "gif"):
        assert suffix in SUPPORTED_IMAGE_SUFFIXES
