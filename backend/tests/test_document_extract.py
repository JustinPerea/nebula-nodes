from __future__ import annotations

import io
from pathlib import Path

import pytest

from services.document_extract import (
    classify_document,
    extract_text,
    UnsupportedDocumentError,
)


def _make_pdf(text: str = "Hello PDF") -> bytes:
    """Build a minimal valid single-page PDF whose content stream draws `text`."""
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>stream\nBT /F1 24 Tf 20 100 Td (%s) Tj ET\nendstream" % (len(text) + 26, text.encode()),
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj" % i + body + b"endobj\n")
    xref_pos = out.tell()
    out.write(b"xref\n0 %d\n" % (len(objs) + 1))
    out.write(b"0000000000 65535 f \n")
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer<</Root 1 0 R/Size %d>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref_pos))
    return out.getvalue()


class TestClassify:
    @pytest.mark.parametrize("ext,kind", [
        (".pdf", "pdf"), (".PDF", "pdf"),
        (".txt", "text"), (".md", "text"), (".markdown", "text"),
        (".csv", "text"), (".json", "text"), ("", "text"),
        (".png", "unsupported"), (".mp4", "unsupported"), (".exe", "unsupported"),
    ])
    def test_classify(self, ext: str, kind: str) -> None:
        assert classify_document(ext) == kind


class TestExtract:
    def test_pdf(self, tmp_path: Path) -> None:
        src = tmp_path / "doc.pdf"
        src.write_bytes(_make_pdf("Hello PDF"))
        assert "Hello PDF" in extract_text(src)

    def test_txt(self, tmp_path: Path) -> None:
        src = tmp_path / "notes.txt"
        src.write_text("plain text content", encoding="utf-8")
        assert extract_text(src) == "plain text content"

    def test_markdown(self, tmp_path: Path) -> None:
        src = tmp_path / "readme.md"
        src.write_text("# Title\n\nbody", encoding="utf-8")
        assert "# Title" in extract_text(src)

    def test_unsupported_raises(self, tmp_path: Path) -> None:
        src = tmp_path / "image.png"
        src.write_bytes(b"\x89PNG\r\n")
        with pytest.raises(UnsupportedDocumentError):
            extract_text(src)
