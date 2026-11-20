"""Intake: decide what the bytes are and decode them, stills only.

Types come from magic bytes through ``commons.media.sniff``, the size cap from
``check_size`` and the decoding from ``load_image``, so untrusted bytes get the
same restricted handling Commons gives them. This module never calls PIL on
the bytes itself.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from PIL import Image

from commons import media
from extraction.errors import ExtractionRefused

STILL_TYPES = "JPEG, PNG, GIF, WebP or HEIC"
KINDS = ("file", "paste", "drop")
IMAGE_CAP = media.IMAGE_CAP

Kind = Literal["file", "paste", "drop"]


@dataclass(frozen=True)
class Intake:
    """One accepted image: the original bytes, what they are and the decoded pixels."""

    data: bytes
    mime: str
    ext: str
    image: Image.Image
    name: str | None
    kind: str
    path: str | None
    mtime: str | None


def _mtime_iso(path: str) -> str | None:
    try:
        stamp = os.stat(path).st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def intake(data: bytes, *, name: str | None = None, kind: Kind = "file", path: str | None = None) -> Intake:
    """Accept still-image bytes or raise ``ExtractionRefused``.

    ``path`` is where the bytes came from, when they came from a file: it is
    kept for the record, and its modification time is read (a stat, not a
    read of the file).
    """
    if kind not in KINDS:
        raise ExtractionRefused(f"The source kind must be one of {', '.join(KINDS)}.")
    if not data:
        raise ExtractionRefused("That file is empty.")
    try:
        sniffed = media.sniff(data)
    except media.MediaError:
        raise ExtractionRefused(f"That file isn’t a {STILL_TYPES} image.") from None
    if sniffed.media != "image":
        raise ExtractionRefused(f"Videos aren’t supported yet. Use a still image ({STILL_TYPES}).")
    try:
        media.check_size("image", len(data))
        image = media.load_image(data, sniffed.mime, keep_alpha=True)
    except media.MediaError as exc:
        if exc.code == "too_large":
            raise ExtractionRefused("That image is too large (over 25 MB or too many pixels).") from None
        raise ExtractionRefused("That image couldn’t be read.") from None
    return Intake(
        data=data, mime=sniffed.mime, ext=sniffed.ext, image=image,
        name=name, kind=kind, path=path, mtime=_mtime_iso(path) if path else None,
    )


def rendering_png(image: Image.Image) -> bytes:
    """The decoded image as PNG, at its own size, for ``rendering.png``."""
    return media.encode_png(image)
