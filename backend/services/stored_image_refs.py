"""The images a saved Style or Character may point at: Nebula's own files.

The app loads a Style's ``refImages`` and ``thumbnail`` and a Character's
``referenceViews`` (and its ``thumbnail``, the first view) as images. An
outside link there would make the person's app fetch it, telling that host
their address and when they looked, and would put a picture they never chose
on screen. So a write to either takes only:

- an output or an upload: ``/api/outputs/<path>`` (POST /api/uploads returns
  one as ``url``), a loopback URL to that route
  (``http://127.0.0.1:<port>/api/outputs/<path>``), or the file's absolute
  path inside the output folder (/api/uploads' ``filePath``, which Create's
  "Save current" sends);
- a shipped Style thumbnail: ``/api/presets/thumbnails/<slug>``.

The file must exist and pass the protected-file policy every graph value
goes through (``services.file_access``). Local output references are read
with the same helper the spatial ports use (``portable_output_ref``), so
encoded traversal, queries and paths outside the output folder are refused
here as they are there.

A value the asset already holds (``before``) isn't checked again: a Style or
Character saved before this check keeps loading, and the person can still
edit it without first removing a link they may never have seen.

A Style's ``params`` can carry an image too (``_previewUrl``, or a ``file``
param of its node); there only outside links are refused, since a local path
in a param is the canvas's to check when it runs (``validate_file_references``).

A moodboard's images follow the same rule (Q98, Justin 2026-10-21: "the same
check, and the same placeholder for old boards"), without the shipped Style
thumbnails: ``board_image_problem`` is what services/moodboard_store.py runs
on every image a board write stores, with ``BOARD_ALLOWED`` as the answer;
``check_board_analysis`` refuses an outside link in a board's ``analysis``;
``outside_image_ids`` names an old board's outside images on read. A url the
board already holds isn't checked again.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from typing import Any
from urllib.parse import urlsplit

from services.file_access import ProtectedPathError, require_allowed_path
from services.output import is_local_output_url, portable_output_ref, resolve_output_ref

ALLOWED = (
    "Images on a Style or a Character must be Nebula's own files: an output or an upload as "
    "/api/outputs/<path> (POST /api/uploads returns one as `url`; that file's path inside Nebula's "
    "output folder works too), or a shipped Style thumbnail /api/presets/thumbnails/<name>. "
    "Outside links (http, https, data:) aren't accepted: upload the image first and use the url it returns."
)

# A moodboard's images (Q98, Justin 2026-10-21: "the same check"): the same
# rule and answer, without the shipped Style thumbnails.
BOARD_ALLOWED = (
    "Images on a moodboard must be Nebula's own files: an output or an upload as /api/outputs/<path> "
    "(POST /api/uploads returns one as `url`; that file's path inside Nebula's output folder works too). "
    "Outside links (http, https, data:) aren't accepted: upload the image first and use the url it returns "
    "(moodboard_create, moodboard_add and `nebula moodboard new`/`add` download a link and upload it for you)."
)

_SHIPPED_PREFIX = "/api/presets/thumbnails/"


class StoredImageError(ValueError):
    """A Style, Character or moodboard write names an image that isn't Nebula's own file."""


def _as_a_browser_reads_it(value: str) -> str:
    """``value`` as a browser parses it: tabs and newlines dropped, a
    backslash read as a slash (so ``/\\host`` is protocol-relative and
    ``http://host\\@127.0.0.1/`` goes to ``host``)."""
    return re.sub(r"[\t\n\r]", "", value.strip()).replace("\\", "/")


def is_outside_link(value: str) -> bool:
    """A string the app would fetch from somewhere other than this backend:
    an http(s) URL that isn't a loopback /api/outputs one (with any number of
    slashes after the scheme, which browsers accept), a protocol-relative
    URL, or a data:/blob: URI. Read the way a browser reads it, so Python's
    URL parser and the browser can't disagree about the host."""
    text = _as_a_browser_reads_it(value)
    lowered = text.lower()
    if lowered.startswith(("data:", "blob:", "//")):
        return True
    if lowered.startswith(("http:", "https:")):
        return not (lowered.startswith(("http://", "https://")) and is_local_output_url(text))
    try:
        return bool(urlsplit(text).netloc)
    except ValueError:
        return False


def problem(value: Any, *, shipped_thumbnail: Callable[[str], bool]) -> str | None:
    """Why ``value`` can't be a stored image, or None when it is one of Nebula's files."""
    if not isinstance(value, str) or not value.strip():
        return "is empty"
    text = value.strip()
    if text.startswith(_SHIPPED_PREFIX):
        return None if shipped_thumbnail(text) else "isn't a shipped Style thumbnail"
    if is_outside_link(text):
        return "is an image link from outside Nebula"
    if text.lower().startswith(("http://", "https://")):  # loopback /api/outputs URL
        parts = urlsplit(text)
        if parts.query or parts.fragment:
            return "isn't one of Nebula's own files"
        text = parts.path
    try:
        canonical = portable_output_ref(text, require_file=True)
        require_allowed_path(resolve_output_ref(canonical))
    except ProtectedPathError:
        return "is a protected file"
    except (ValueError, OSError):
        return "isn't one of Nebula's own files"
    return None


def _shown(value: Any) -> str:
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _held(before: Mapping[str, Any] | None, *keys: str) -> set[str]:
    held: set[str] = set()
    for key in keys:
        current = (before or {}).get(key)
        if isinstance(current, str):
            held.add(current)
        elif isinstance(current, list):
            held.update(item for item in current if isinstance(item, str))
    return held


def check(fields: Mapping[str, Any], *, image_fields: Iterable[str], before: Mapping[str, Any] | None = None,
          shipped_thumbnail: Callable[[str], bool], allow_blank: Iterable[str] = ("thumbnail",),
          param_keys: Iterable[str] = ()) -> None:
    """Raise StoredImageError (its text names the field and what is allowed)
    for the first image in ``fields`` that isn't one of Nebula's files.

    ``image_fields``: the fields that hold one image or a list of them.
    ``before``: the asset as stored (None for a new one); a value it already
    holds in any image field is not checked again. ``allow_blank``: fields
    where "" means no image. ``param_keys``: keys of ``fields["params"]``
    that hold an image, where only an outside link is refused."""
    image_fields = tuple(image_fields)
    held = _held(before, *image_fields)
    blank_ok = set(allow_blank)
    for field in image_fields:
        if field not in fields or fields[field] is None:
            continue
        value = fields[field]
        items = list(enumerate(value)) if isinstance(value, list) else [(None, value)]
        for index, item in items:
            if isinstance(item, str) and item in held:
                continue
            if index is None and field in blank_ok and item == "":
                continue
            reason = problem(item, shipped_thumbnail=shipped_thumbnail)
            if reason:
                where = field if index is None else f"{field}[{index}]"
                raise StoredImageError(f"{where} {reason} ({_shown(item)!r}). {ALLOWED}")
    params = fields.get("params")
    if not isinstance(params, Mapping):
        return
    held_params = (before or {}).get("params") if isinstance((before or {}).get("params"), Mapping) else {}
    for key in param_keys:
        value = params.get(key)
        if isinstance(value, str) and value and value != held_params.get(key) and is_outside_link(value):
            raise StoredImageError(f"params.{key} is an image link from outside Nebula ({_shown(value)!r}). {ALLOWED}")


# -- moodboards ----------------------------------------------------------------

def board_image_problem(value: Any, where: str) -> str | None:
    """The refusal for one image a board write would store (``where`` names
    it: ``images[1].url``), in #133's shape, or None for one of Nebula's
    files. A board takes no shipped Style thumbnail."""
    reason = problem(value, shipped_thumbnail=lambda _value: False)
    return f"{where} {reason} ({_shown(value)!r}). {BOARD_ALLOWED}" if reason else None


def analysis_links(analysis: Any) -> list[tuple[str, str]]:
    """Every image a board's ``analysis`` names, as (where, value): its
    images' urls, ``representativeImages`` and each provider hint's. These
    reach generators (a Krea style reference) and so are checked on a write
    too, for outside links only: an analysis names the board's own images."""
    found: list[tuple[str, str]] = []
    if not isinstance(analysis, Mapping):
        return found
    images = analysis.get("images")
    for index, item in enumerate(images if isinstance(images, list) else []):
        if isinstance(item, Mapping) and isinstance(item.get("url"), str):
            found.append((f"analysis.images[{index}].url", item["url"]))

    def urls(where: str, value: Any) -> None:
        if isinstance(value, list):
            found.extend((f"{where}[{i}]", item) for i, item in enumerate(value) if isinstance(item, str))

    urls("analysis.representativeImages", analysis.get("representativeImages"))
    hints = analysis.get("providerHints")
    if isinstance(hints, Mapping):
        for name, hint in hints.items():
            if isinstance(hint, Mapping):
                urls(f"analysis.providerHints.{name}.representativeImages", hint.get("representativeImages"))
    return found


def check_board_analysis(analysis: Any, held: Iterable[str] = ()) -> None:
    """StoredImageError for the first outside link an analysis names that the
    board doesn't already hold (``held``: the urls on the board as stored and
    in its saved analysis)."""
    kept = set(held)
    for where, value in analysis_links(analysis):
        if value not in kept and is_outside_link(value):
            raise StoredImageError(f"{where} is an image link from outside Nebula ({_shown(value)!r}). {BOARD_ALLOWED}")


def board_held_urls(board: Mapping[str, Any] | None) -> set[str]:
    """The image urls a board as stored holds, on it or in its saved analysis:
    not checked again, so a board saved before the check keeps saving."""
    held: set[str] = set()
    if not isinstance(board, Mapping):
        return held
    for image in board.get("images") or []:
        if isinstance(image, Mapping) and isinstance(image.get("url"), str):
            held.add(image["url"])
            held.add(image["url"].strip())
    held.update(value for _where, value in analysis_links(board.get("analysis")))
    return held


def outside_image_ids(board: Mapping[str, Any]) -> list[str]:
    """The ids of a board's images that are links to another site: nothing
    in Nebula loads them (the app shows #133's placeholder)."""
    return [str(image.get("id")) for image in board.get("images") or []
            if isinstance(image, Mapping) and isinstance(image.get("url"), str) and is_outside_link(image["url"])]
