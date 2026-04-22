import base64
from pathlib import Path
from services.output import save_base64_image_named


def test_save_base64_image_named_writes_to_exact_filename(tmp_path: Path) -> None:
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16  # minimal-ish
    b64 = base64.b64encode(png_bytes).decode()
    out = save_base64_image_named(b64, tmp_path, name="node123_partial_0")
    assert out == tmp_path / "node123_partial_0.png"
    assert out.read_bytes() == png_bytes


def test_save_base64_image_named_accepts_extension(tmp_path: Path) -> None:
    b64 = base64.b64encode(b"x").decode()
    out = save_base64_image_named(b64, tmp_path, name="n", extension="jpg")
    assert out == tmp_path / "n.jpg"
