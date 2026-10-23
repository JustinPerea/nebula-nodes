"""Read a media input that a provider handler will upload, with the same checks everywhere.

A media value in a graph can be a data: URI, an owned output (a served
``/api/outputs/...`` ref, or a loopback URL to one), a remote URL, or a local
path. Each kind gets one rule:

- owned outputs become their file under OUTPUT_ROOT (resolve_output_ref);
- remote URLs are fetched only through services.public_url.fetch_public_media
  (public https hosts, every redirect hop DNS-checked, no credentials, a byte
  cap), so a recipe can't make the backend read this machine or a private
  network;
- local paths pass require_allowed_path (the protected-store and workspace
  policy) and a size check before any byte is read, and the read itself is
  bounded in case the file grows between the check and the read.

``max_bytes`` is the maker's per-file limit where the maker documents one;
callers name the source next to the constant.
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import math
import mimetypes
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit
from execution.person_line import as_person_line, missing_file_line, with_person_line


def _megabytes(limit: int) -> str:
    return f"{limit / 1_000_000:g} MB"


def too_large(label: str, limit: int) -> ValueError:
    return as_person_line(ValueError(f"{label} is larger than {_megabytes(limit)}, the most this provider takes"))


def is_loopback_host(hostname: str) -> bool:
    host = hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def owned_output_value(value: str) -> str:
    """An owned output as its local path; any other value unchanged.

    ``/api/outputs/<rel>`` and a loopback http(s) URL to that path (with no
    query or fragment) resolve under OUTPUT_ROOT. A loopback URL to anything
    else is left as a URL, which the public fetcher then refuses."""
    from services.output import resolve_output_ref

    if value.startswith(("http://", "https://")):
        try:
            parts = urlsplit(value)
            hostname = parts.hostname or ""
        except ValueError:
            return value
        if (is_loopback_host(hostname) and parts.path.startswith("/api/outputs/")
                and not parts.query and not parts.fragment):
            return owned_output_value(parts.path)
        return value
    resolved = resolve_output_ref(value)
    if value.startswith("/api/outputs/") and resolved == value:
        raise ValueError("Not a valid output reference (it must name a file under the outputs folder)")
    return resolved


def checked_local_file(value: str | Path, *, label: str, max_bytes: int) -> Path:
    """A local file that passed the path policy and fits ``max_bytes``; nothing is read."""
    from services.file_access import require_allowed_path

    path = require_allowed_path(value)
    if not path.is_file():
        raise with_person_line(ValueError(f"{label} not found: {value}"), missing_file_line(label, value))
    if path.stat().st_size > max_bytes:
        raise too_large(label, max_bytes)
    return path


def read_local_media(value: str | Path, *, label: str, max_bytes: int) -> tuple[Path, bytes]:
    """(path, bytes) of a local file, checked by checked_local_file and read at most ``max_bytes``."""
    path = checked_local_file(value, label=label, max_bytes=max_bytes)
    with path.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise too_large(label, max_bytes)
    return path, data


def decode_data_uri(value: str, *, label: str, max_bytes: int) -> tuple[bytes, str]:
    """(bytes, mime) of a data: URI, refused before decoding when it can't fit ``max_bytes``."""
    header, separator, payload = value.partition(",")
    if not separator:
        raise ValueError(f"{label} is a malformed data URI")
    mime = header[5:].split(";", 1)[0].strip().lower()
    if ";base64" in header.lower():
        if len(payload) > 4 * math.ceil(max_bytes / 3) + 4:
            raise too_large(label, max_bytes)
        try:
            data = base64.b64decode(payload)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"{label} has invalid base64 data") from exc
    else:
        data = unquote_to_bytes(payload)
    if len(data) > max_bytes:
        raise too_large(label, max_bytes)
    return data, mime


async def load_media(value: str, *, label: str, max_bytes: int, timeout: float = 120.0) -> tuple[bytes, str]:
    """(bytes, mime) for a media value the backend itself has to read.

    The mime is "" when neither the response nor the file name gives one."""
    from services.public_url import fetch_public_media

    text = str(value).strip()
    if not text:
        raise as_person_line(ValueError(f"{label} is empty"))
    if text.startswith("data:"):
        return decode_data_uri(text, label=label, max_bytes=max_bytes)
    text = owned_output_value(text)
    if text.startswith(("http://", "https://")):
        content, content_type = await fetch_public_media(text, label=label, max_bytes=max_bytes, timeout=timeout)
        return content, content_type.split(";", 1)[0].strip().lower()
    path, data = read_local_media(text, label=label, max_bytes=max_bytes)
    return data, mimetypes.guess_type(path.name)[0] or ""
