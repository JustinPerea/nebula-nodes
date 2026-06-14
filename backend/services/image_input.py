"""Shared loading + validation for image inputs fed to vision/multimodal nodes.

Vision chat nodes (claude-chat, gpt-4o-chat, gemini-chat, openrouter) and several
generation nodes accept image *inputs* — local file paths, http(s) URLs, or data:
URIs. The local-path branch used to be written as ``if img_path.exists(): ...``
with no ``else``: a path that didn't exist was silently dropped. The node then
"succeeded" having sent ZERO of the references the user wired up, so the run looked
like it analyzed images it never saw. (This bit a real graph whose image-input
nodes pointed at a wrong directory.)

``load_local_image`` centralizes that branch and *raises* instead of swallowing, so
a misconfigured reference surfaces as a node error rather than a silent success.
Callers handle data: URIs and http(s) URLs themselves (forwarded as-is) and only
reach here for local filesystem paths — see ``is_remote_or_data_uri``.
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# MIME types the Anthropic, OpenAI, and Gemini vision APIs accept for image input.
_IMAGE_MIME_BY_SUFFIX: dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
}

SUPPORTED_IMAGE_SUFFIXES: tuple[str, ...] = tuple(sorted(_IMAGE_MIME_BY_SUFFIX))


def is_remote_or_data_uri(value: str) -> bool:
    """True for values a vision handler forwards as-is: an http(s) URL or data: URI.

    Anything else is treated as a local filesystem path and must be loaded (and
    validated) via :func:`load_local_image`.
    """
    return value.startswith(("http://", "https://", "data:"))


def load_local_image(path_str: str) -> tuple[str, str]:
    """Load a local image file into ``(mime_type, base64_data)`` for a vision API.

    Raises :class:`ValueError` when an image input was provided but can't be turned
    into something a model can see — the file is missing, isn't a regular file, is
    an unsupported type, or can't be read. Surfacing this (instead of silently
    skipping) is the whole point: a vision node must not "succeed" while sending
    zero of the references the user connected.

    Only call this for local filesystem paths. data: URIs and http(s) URLs are
    forwarded by the caller before reaching here (see :func:`is_remote_or_data_uri`).
    """
    path = Path(path_str)

    if not path.exists():
        msg = (
            f"Image input not found: {path_str!r}. The file does not exist, so it "
            "was NOT sent to the model. Check the path — a wrong working directory "
            "is the usual cause."
        )
        logger.warning(msg)
        raise ValueError(msg)

    if not path.is_file():
        msg = (
            f"Image input is not a file: {path_str!r}. It was NOT sent to the model."
        )
        logger.warning(msg)
        raise ValueError(msg)

    suffix = path.suffix.lstrip(".").lower()
    mime_type = _IMAGE_MIME_BY_SUFFIX.get(suffix)
    if mime_type is None:
        shown = f".{suffix}" if suffix else "(no extension)"
        msg = (
            f"Unsupported image type {shown} for image input {path_str!r}. "
            f"Supported: {', '.join(SUPPORTED_IMAGE_SUFFIXES)}. "
            "It was NOT sent to the model."
        )
        logger.warning(msg)
        raise ValueError(msg)

    try:
        raw = path.read_bytes()
    except OSError as exc:
        msg = (
            f"Could not read image input {path_str!r}: {exc}. "
            "It was NOT sent to the model."
        )
        logger.warning(msg)
        raise ValueError(msg) from exc

    return mime_type, base64.b64encode(raw).decode("ascii")
