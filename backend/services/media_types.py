"""Which media type a file is, from its extension or its MIME type.

One table for the run directory (services/output.py picks a saved file's
extension from it) and for typing a Replicate model's file output before its
run (services/universal_ports.py) and checking what the run returned against
that (handlers/replicate_universal.py). Imports nothing from the backend, so
the MCP server can use it too.
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath
from urllib.parse import urlsplit

MEDIA_EXTENSIONS: dict[str, set[str]] = {
    "Image": {"png", "jpg", "jpeg", "webp", "gif"},
    "Video": {"mp4", "webm", "mov", "m4v", "mkv", "avi"},
    "Audio": {"mp3", "wav", "flac", "ogg", "m4a", "aac", "pcm"},
    "Mesh": {"glb", "gltf", "obj", "fbx", "stl", "usdz", "3mf"},
    "SVG": {"svg"},
}
# The port a file of each type comes out on, as the run names it.
MEDIA_PORT_IDS: dict[str, str] = {"Image": "image", "Video": "video", "Audio": "audio", "Mesh": "mesh", "SVG": "svg"}
_MESH_MIME = {"model/gltf-binary", "model/gltf+json", "model/obj", "model/stl", "model/vnd.usdz+zip", "model/3mf"}
# A MIME type written out ("video/mp4"), or a dotted extension (".mp4"), in free text.
_MIME_IN_TEXT = re.compile(r"\b((?:image|video|audio|model)/[a-z0-9][a-z0-9.+-]*)", re.IGNORECASE)
_EXTENSION_IN_TEXT = re.compile(r"\.([a-z0-9]{2,5})\b", re.IGNORECASE)


def media_of_mime(mime: str) -> str | None:
    """The media type of a MIME type, or None for anything that isn't a file
    Nebula keeps as media (text/plain, application/json, ...)."""
    kind = mime.split(";", 1)[0].strip().lower()
    if kind == "image/svg+xml":
        return "SVG"
    if kind in _MESH_MIME:
        return "Mesh"
    for prefix, media in (("image/", "Image"), ("video/", "Video"), ("audio/", "Audio")):
        if kind.startswith(prefix) and len(kind) > len(prefix):
            return media
    return None


def media_of_extension(extension: str) -> str | None:
    suffix = extension.lstrip(".").lower()
    return next((media for media, extensions in MEDIA_EXTENSIONS.items() if suffix in extensions), None)


def media_of_value(value: object) -> str | None:
    """The media type a returned value names: a data: URI by its MIME type, an
    http(s) URL by its path's extension (not its query). None when it says
    nothing (plain text, a URL with no telling extension)."""
    if not isinstance(value, str):
        return None
    if value.startswith("data:"):
        return media_of_mime(value.partition(",")[0][5:])
    if value.startswith(("http://", "https://")):
        try:
            path = urlsplit(value).path
        except ValueError:
            return None
        return media_of_extension(PurePosixPath(path).suffix) if PurePosixPath(path).suffix else None
    return None


def media_named_in_text(text: object) -> str | None:
    """A media type a description states outright, as a MIME type or a file
    extension ("an MP4 (video/mp4)", "returns a .wav"). Words alone ("a
    video of ...") say nothing: Nebula doesn't guess from them."""
    if not isinstance(text, str) or not text:
        return None
    for match in _MIME_IN_TEXT.finditer(text):
        found = media_of_mime(match.group(1))
        if found:
            return found
    for match in _EXTENSION_IN_TEXT.finditer(text):
        found = media_of_extension(match.group(1))
        if found:
            return found
    return None
