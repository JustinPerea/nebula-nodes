"""The picture on a project's card (Projects screen).

Order of choice:

1. The image the person pinned, while it is still one of the project's images.
2. The newest image a node made (not an input reference).
3. When the project has only input references (Image Input, Style
   Reference), up to four of them, shown as a 2x2 mosaic.
4. Nothing: the card keeps its drawn placeholder.

"Newest" goes by the output file's time on disk when Nebula can find the file,
and by canvas order otherwise (later nodes count as newer). Run history isn't
used: runs started from the CLI or MCP never reach the canvas's history.

main.py installs the two lookups (`configure`), so this module stays free of
the backend's output-root rules and its tests need no backend.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

# Nodes that hold a picture the person brought in rather than one Nebula made.
REFERENCE_NODES = frozenset({"image-input", "style-reference"})
MAX_MOSAIC = 4
MAX_URL_CHARS = 8192
# The cover picker lists at most this many images, newest first.
MAX_CHOICES = 60
_OUTPUTS = "/api/outputs/"

UrlFor = Callable[[str], "str | None"]
TimeFor = Callable[[str], "float | None"]

_url_for: UrlFor | None = None
_time_for: TimeFor | None = None


def configure(*, url_for: UrlFor | None, time_for: TimeFor | None) -> None:
    """url_for: a local file path to its /api/outputs URL (or None).
    time_for: an /api/outputs URL to its file's modified time (or None)."""
    global _url_for, _time_for
    _url_for, _time_for = url_for, time_for


def portable_url(value: Any) -> str | None:
    """An image URL a card can show on any port: /api/outputs/... is kept
    relative (a saved http://127.0.0.1:8000/api/outputs/... becomes relative
    too), other http(s) URLs are kept, everything else is refused."""
    if not isinstance(value, str) or not value or len(value) > MAX_URL_CHARS:
        return None
    if value.startswith(_OUTPUTS):
        return value
    if value.startswith(("http://", "https://")):
        index = value.find(_OUTPUTS)
        host = value[: index] if index >= 0 else ""
        # Only this machine's backend: its port changes between launches.
        if index >= 0 and any(local in host for local in ("://127.0.0.1", "://localhost", "://[::1]")):
            return value[index:]
        return value
    if _url_for is not None and value.startswith("/"):
        try:
            return _url_for(value)
        except Exception:  # noqa: BLE001 - a cover is decoration
            return None
    return None


def _image_values(port: Any) -> list[str]:
    if not isinstance(port, dict) or port.get("type") != "Image":
        return []
    value = port.get("value")
    values = value if isinstance(value, list) else [value]
    return [url for url in (portable_url(item) for item in values) if url]


def _reference_urls(data: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for port in (data.get("outputs") or {}).values():
        urls.extend(_image_values(port))
    params = data.get("params") or {}
    for key in ("_previewUrl", "file", "filePath"):
        url = portable_url(params.get(key))
        if url:
            urls.append(url)
    return urls[:1]  # one picture per reference node


def project_images(snapshot: dict[str, Any]) -> tuple[list[str], list[str]]:
    """(made, references): every distinct image URL in the project.

    `made` is newest first; `references` is in canvas order.
    """
    references: list[str] = []
    made: list[tuple[float, int, str]] = []
    order = 0
    for node in snapshot.get("nodes") or []:
        data = node.get("data") if isinstance(node, dict) else None
        if not isinstance(data, dict):
            continue
        if data.get("definitionId") in REFERENCE_NODES:
            for url in _reference_urls(data):
                if url not in references:
                    references.append(url)
            continue
        for port in (data.get("outputs") or {}).values():
            for url in _image_values(port):
                order += 1
                made.append((_time(url), order, url))
    seen: set[str] = set(references)  # a reroute passing a reference along didn't make it
    newest: list[str] = []
    for _, _, url in sorted(made, key=lambda item: (item[0], item[1]), reverse=True):
        if url not in seen:
            seen.add(url)
            newest.append(url)
    return newest, references


def _time(url: str) -> float:
    if _time_for is None or not url.startswith(_OUTPUTS):
        return -1.0
    try:
        found = _time_for(url)
    except Exception:  # noqa: BLE001 - a cover is decoration
        return -1.0
    return float(found) if isinstance(found, (int, float)) else -1.0


def cover(snapshot: dict[str, Any], pinned: str | None = None) -> dict[str, Any] | None:
    """{"source": "pinned"|"output"|"references", "images": [...]}, or None."""
    made, references = project_images(snapshot)
    if pinned and (pinned in made or pinned in references):
        return {"source": "pinned", "images": [pinned]}
    if made:
        return {"source": "output", "images": [made[0]]}
    if references:
        return {"source": "references", "images": references[:MAX_MOSAIC]}
    return None


def choices(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    """What the person can pin: made images newest first, then references."""
    made, references = project_images(snapshot)
    listed = [{"url": url, "kind": "output"} for url in made]
    listed += [{"url": url, "kind": "reference"} for url in references]
    return listed[:MAX_CHOICES]


def is_choice(snapshot: dict[str, Any], url: str) -> bool:
    made, references = project_images(snapshot)
    return url in made or url in references


def first_image(found: dict[str, Any] | None) -> str | None:
    images: Iterable[str] = (found or {}).get("images") or []
    return next(iter(images), None)
