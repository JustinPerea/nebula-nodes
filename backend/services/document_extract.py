"""Extract text from an uploaded document for the Document Input node.

PDF text via pypdf; plain-text formats read directly. Page-render-to-image is
intentionally out of scope (would need a heavier renderer). `classify_document`
is a pure helper for unit tests; `extract_text` does the filesystem read.
"""

from __future__ import annotations

from pathlib import Path

PDF_EXTS = {".pdf"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".rst", ".tsv"}


class UnsupportedDocumentError(ValueError):
    """The document type isn't supported for text extraction."""


def classify_document(ext: str) -> str:
    """Return 'pdf' | 'text' | 'unsupported' for a file extension. Pure."""
    e = (ext or "").lower()
    if e in PDF_EXTS:
        return "pdf"
    if e in TEXT_EXTS or e == "":
        return "text"
    return "unsupported"


def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            parts.append(text)
    return "\n\n".join(parts).strip()


def extract_text(path: Path | str) -> str:
    """Extract text from a document file. Raises UnsupportedDocumentError for
    unknown types; pypdf/IO errors propagate to the caller."""
    p = Path(path)
    kind = classify_document(p.suffix)
    if kind == "pdf":
        return _extract_pdf(p)
    if kind == "text":
        return p.read_text(encoding="utf-8", errors="replace")
    raise UnsupportedDocumentError(f"Unsupported document type: {p.suffix or '(none)'}")
