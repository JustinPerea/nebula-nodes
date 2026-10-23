"""TypeSafe System One (Jev) client shared by every Jev node.

Jev answers typed questions (yes/no, pick one, score, where-is-it box) with
probabilities. It never writes text. One POST to ``/v1/systemone`` returns
every answer, so the Jev nodes are ``sync``.

This module owns the parts every Jev node needs and nothing node-specific:

- ``prepare_images``: load graph image values (local path, /api/outputs URL,
  data URI, public https URL) through Nebula's existing file and URL policies,
  then make each one acceptable to TypeSafe (upright, PNG or JPEG, within the
  pixel and byte limits). Each result records the transform it applied so a
  box can be mapped back to the original pixels.
- ``system_one``: build and send the request (JSON, or multipart when images
  are attached), retry 408/429/5xx, and turn every failure into a readable
  error that never contains the key.
- small helpers for neutral Choice keys, Score levels and Noul confidence.

Raw httpx, not the vendor SDK: typesafe-sdk needs pydantic>=2.12 and the
backend pins 2.11.3. Always the maker's own endpoint, never an aggregator,
and only the person's own key (BYOK). API reference: https://docs.typesafe.ai
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import math
import random
import re
import uuid
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from services.http_errors import TRANSPORT_ERRORS
from execution.person_line import as_person_line, with_person_line, with_provider_line

API_URL = "https://api.typesafe.ai/v1/systemone"
CREDENTIAL = "TYPESAFE_API_KEY"
IMAGES_HEADER = "TypeSafe-Danger-Zone-Images"
LONG_CONTEXT_HEADER = "TypeSafe-Danger-Zone-Long-Context"
REQUEST_ID_HEADER = "x-typesafe-request-id"

DEFAULT_MODEL = "jev-1.14.0"
# Pinned ids first. The aliases move to newer versions without notice, and
# thresholds tuned on one version can shift on the next.
MODELS: tuple[str, ...] = ("jev-1.14.0", "jev-1.13.0", "jev-latest", "jev-preview")
# Box questions need Jev 1.14 or later.
BOX_MODELS: tuple[str, ...] = ("jev-1.14.0", "jev-preview")
_MODEL_RE = re.compile(r"^jev-[a-z0-9][a-z0-9.\-]{0,62}$")

# TypeSafe's published image limits (docs.typesafe.ai/images). TypeSafe
# refuses an image that breaks them instead of fitting it, so prepare_images
# fits each image here first. The page (checked 2026-10-16): "Width and height
# 280 to 1568 pixels each. An image with either side under 280 pixels is
# rejected." and "Total pixels (width × height) 78,400 to 2,458,624".
MIN_SIDE = 280
MAX_SIDE = 1568
MIN_PIXELS = 78_400
MAX_PIXELS = 2_458_624
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_REQUEST_BYTES = 32 * 1024 * 1024
# Room for the JSON part and the multipart framing inside the 32 MiB body.
_REQUEST_MARGIN = 256 * 1024
MAX_CHOICE_OPTIONS = 255
MIN_SCORE_LEVELS, MAX_SCORE_LEVELS = 2, 10
DEFAULT_MAX_IMAGES = 16

# What Nebula will read before preprocessing. Above these the input is refused
# rather than decoded: a small file can still claim a huge canvas.
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_SOURCE_PIXELS = 64_000_000
# All the images of one request together, as read (before any resizing).
MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024
# A remote image has this long in total, however slowly the host sends it.
URL_FETCH_DEADLINE = 120.0
# The only formats Pillow may parse. Without a list it tries every plugin it
# has on bytes nobody vetted, and some hand the file to another program (EPS
# runs Ghostscript). "JPEG" also covers the multi-picture JPEGs cameras save.
DECODE_FORMATS = ("PNG", "JPEG", "WEBP", "GIF")

MAX_RETRIES = 2
RETRY_STATUSES = frozenset({408, 429, *range(500, 600)})
BACKOFF_INITIAL = 0.5
BACKOFF_MAX = 5.0
RETRY_AFTER_MAX = 10.0
TIMEOUT = httpx.Timeout(60.0, connect=10.0)

_JPEG_QUALITIES = (90, 80, 70, 60)


class TypeSafeError(ValueError):
    """A Jev request failed. The message is safe to show and never holds the key."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None,
                 request_id: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


# -- images --------------------------------------------------------------------


@dataclass(frozen=True)
class ImageTransform:
    """How one input image became the file TypeSafe saw.

    "Original" means the input as a browser shows it: decoded, first frame,
    EXIF orientation applied. Sent pixels = original * scale, then padding
    added at (pad_left, pad_top). ``to_original_box`` undoes both.
    """

    source_width: int  # as stored, before EXIF rotation
    source_height: int
    exif_orientation: int  # 1 = already upright
    width: int  # original (upright) size
    height: int
    scale_x: float  # content_width / width
    scale_y: float
    content_width: int
    content_height: int
    pad_left: int
    pad_top: int
    sent_width: int
    sent_height: int
    source_format: str  # what Pillow decoded, e.g. "WEBP"
    frames: int  # >1 means an animation; only the first frame was sent
    sent_format: str  # "png" | "jpg"
    quality: int | None = None  # JPEG quality when sent_format is jpg

    @property
    def transposed(self) -> bool:
        return self.exif_orientation not in (0, 1)

    @property
    def resized(self) -> bool:
        return (self.content_width, self.content_height) != (self.width, self.height)

    @property
    def padded(self) -> bool:
        return (self.sent_width, self.sent_height) != (self.content_width, self.content_height)

    def to_original_box(self, *, top: float, bottom: float, left: float, right: float) -> dict[str, Any]:
        """Map a box given as fractions of the sent image to the original image.

        Returns the Jev Box output shape without ``confidence``: fractions of
        the original (0..1, clamped, top <= bottom, left <= right), the integer
        pixel rectangle ``px`` and the original ``image`` size.
        """
        def to_x(fraction: float) -> float:
            return _clamp((_clamp(fraction) * self.sent_width - self.pad_left) / self.scale_x, 0.0, self.width)

        def to_y(fraction: float) -> float:
            return _clamp((_clamp(fraction) * self.sent_height - self.pad_top) / self.scale_y, 0.0, self.height)

        x0, x1 = sorted((to_x(left), to_x(right)))
        y0, y1 = sorted((to_y(top), to_y(bottom)))
        px_x, px_y = int(math.floor(x0)), int(math.floor(y0))
        px_r = min(self.width, int(math.ceil(x1)))
        px_b = min(self.height, int(math.ceil(y1)))
        return {
            "top": round(y0 / self.height, 4),
            "bottom": round(y1 / self.height, 4),
            "left": round(x0 / self.width, 4),
            "right": round(x1 / self.width, 4),
            "px": {"x": px_x, "y": px_y, "w": max(0, px_r - px_x), "h": max(0, px_b - px_y)},
            "image": {"w": self.width, "h": self.height},
        }

    def describe(self) -> str:
        """One short line for a report, e.g. "WEBP 4096x2048 -> JPEG 1568x784"."""
        steps = []
        if self.transposed:
            steps.append("rotated upright")
        if self.frames > 1:
            steps.append(f"first of {self.frames} frames")
        if self.padded:
            steps.append("padded")
        extra = f" ({', '.join(steps)})" if steps else ""
        return (f"{self.source_format} {self.width}x{self.height} -> "
                f"{self.sent_format.upper()} {self.sent_width}x{self.sent_height}{extra}")


@dataclass(frozen=True)
class PreparedImage:
    """One image ready to send. Put ``placeholder`` exactly once in the request."""

    source: str  # the graph value it came from, unchanged
    placeholder: str  # a fresh uuid4 for this request
    part: str  # multipart part name
    data: bytes
    format: str  # "png" | "jpg"
    transform: ImageTransform

    @property
    def mime(self) -> str:
        return "image/png" if self.format == "png" else "image/jpeg"


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


async def load_image_source(value: str, *, label: str = "Image") -> bytes:
    """Read one graph image value into bytes, using Nebula's existing policies.

    - data: URIs are decoded in memory.
    - /api/outputs/<rel> (or a localhost URL to it) maps to the file under
      OUTPUT_ROOT via services.output.local_media_ref.
    - Other http(s) URLs go through services.public_url.fetch_public_media,
      which only fetches public https hosts (no SSRF to this machine or a
      private network).
    - Anything else is a local path, checked by
      services.image_input.load_local_image (protected paths, existence,
      supported suffix).
    """
    from services.file_access import ProtectedPathError, require_allowed_path
    from services.image_input import load_local_image
    from services.output import is_local_output_url, local_media_ref
    from services.public_url import fetch_public_media

    raw = str(value or "").strip()
    if not raw:
        raise as_person_line(ValueError(f"{label} is empty"))
    if raw.startswith("data:"):
        header, _, payload = raw.partition(",")
        if ";base64" not in header or not payload:
            raise ValueError(f"{label} is a data URI without base64 image data")
        if len(payload) > MAX_SOURCE_BYTES * 4 // 3 + 4:
            raise as_person_line(ValueError(f"{label} is larger than {MAX_SOURCE_BYTES // (1024 * 1024)} MiB"))
        try:
            return base64.b64decode(payload, validate=False)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"{label} has invalid base64 data") from exc
    if raw.startswith("/api/outputs/") or is_local_output_url(raw):
        try:
            raw = local_media_ref(raw)
        except ProtectedPathError:
            raise
        except ValueError:
            raise ValueError(f"{label} reference escapes Nebula's output directory") from None
    too_big = ValueError(f"{label} is larger than {MAX_SOURCE_BYTES // (1024 * 1024)} MiB")
    if raw.startswith(("http://", "https://")):
        try:
            content, _type = await asyncio.wait_for(
                fetch_public_media(raw, label=label, max_bytes=MAX_SOURCE_BYTES, timeout=60.0),
                URL_FETCH_DEADLINE)
        except asyncio.TimeoutError:
            raise as_person_line(ValueError(f"{label} took longer than {URL_FETCH_DEADLINE:.0f} s to download")) from None
        return content
    # The allowed-path policy runs before anything about the file is looked
    # at, so a protected path can't even be sized.
    path = require_allowed_path(raw)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0  # load_local_image explains a missing file
    if size > MAX_SOURCE_BYTES:
        raise too_big
    _mime, b64 = load_local_image(str(path))
    data = base64.b64decode(b64)
    if len(data) > MAX_SOURCE_BYTES:  # the file grew after it was sized
        raise too_big
    return data


def open_image(data: bytes) -> Image.Image:
    """Image.open limited to DECODE_FORMATS (raises UnidentifiedImageError otherwise)."""
    return Image.open(io.BytesIO(data), formats=DECODE_FORMATS)


def _open_first_frame(data: bytes, label: str) -> tuple[Image.Image, str, int, int, int, int]:
    """Decode with a pixel cap. Returns (image, format, frames, w, h, orientation).

    The cap is checked from the header before decoding. It sits below
    Pillow's own MAX_IMAGE_PIXELS, so no warnings filter is needed (one would
    be process-wide, and this runs in a worker thread)."""
    try:
        image = open_image(data)
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > MAX_SOURCE_PIXELS:
            raise as_person_line(ValueError(
                f"{label} is {width}x{height}, over Nebula's {MAX_SOURCE_PIXELS // 1_000_000} megapixel "
                "input limit; downscale it first"))
        source_format = (image.format or "unknown").upper()
        frames = int(getattr(image, "n_frames", 1) or 1)
        if frames > 1:
            image.seek(0)
        orientation = 1
        try:
            orientation = int(image.getexif().get(0x0112, 1) or 1)
        except Exception:  # noqa: BLE001 - unreadable EXIF just means upright
            orientation = 1
        image.load()
    except Image.DecompressionBombError as exc:
        raise as_person_line(ValueError(f"{label} is too large to decode safely")) from exc
    except UnidentifiedImageError as exc:
        raise with_person_line(ValueError(f"{label} isn't an image Nebula can read (PNG, JPEG, WebP or GIF)"), f"{label} isn't an image Nebula can read. Use a PNG, JPEG, WebP or GIF, then run the node again.") from exc
    except OSError as exc:
        raise with_provider_line(
            ValueError(f"{label} is damaged or incomplete: {exc}"),
            f"{label} is damaged or incomplete. Connect another image.") from exc
    return image, source_format, frames, width, height, orientation


def _has_alpha(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA", "PA"):
        alpha = image.getchannel("A")
        return alpha.getextrema()[0] < 255
    return image.mode == "P" and "transparency" in image.info


def _target_size(width: int, height: int, max_side: int = MAX_SIDE) -> tuple[int, int, int, int]:
    """(content_w, content_h, sent_w, sent_h): shrink to max_side, then pad up."""
    scale = min(1.0, max_side / max(width, height))
    content_w = max(1, min(max_side, round(width * scale)))
    content_h = max(1, min(max_side, round(height * scale)))
    sent_w, sent_h = max(content_w, MIN_SIDE), max(content_h, MIN_SIDE)
    if sent_w * sent_h < MIN_PIXELS:
        grow = math.sqrt(MIN_PIXELS / (sent_w * sent_h))
        sent_w = min(MAX_SIDE, math.ceil(sent_w * grow))
        sent_h = min(MAX_SIDE, math.ceil(sent_h * grow))
        while sent_w * sent_h < MIN_PIXELS:
            if sent_w <= sent_h and sent_w < MAX_SIDE:
                sent_w += 1
            else:
                sent_h += 1
    return content_w, content_h, sent_w, sent_h


@dataclass
class _Working:
    """An image after geometry, before the final encode (kept to re-encode)."""

    source: str
    canvas: Image.Image
    alpha: bool
    prefer_png: bool
    base: dict[str, Any] = field(default_factory=dict)


def _prepare_geometry(source: str, data: bytes, label: str, max_side: int = MAX_SIDE) -> _Working:
    image, source_format, frames, src_w, src_h, orientation = _open_first_frame(data, label)
    upright = ImageOps.exif_transpose(image) or image
    if upright.mode == "P":
        upright = upright.convert("RGBA" if "transparency" in upright.info else "RGB")
    alpha = _has_alpha(upright)
    upright = upright.convert("RGBA" if alpha else "RGB")
    width, height = upright.size
    content_w, content_h, sent_w, sent_h = _target_size(width, height, max_side)
    content = upright if (content_w, content_h) == (width, height) else upright.resize(
        (content_w, content_h), Image.Resampling.LANCZOS)
    pad_left, pad_top = (sent_w - content_w) // 2, (sent_h - content_h) // 2
    if (sent_w, sent_h) != (content_w, content_h):
        # Pad, never stretch: transparent for images with alpha, black otherwise.
        canvas = Image.new(content.mode, (sent_w, sent_h), (0, 0, 0, 0) if alpha else (0, 0, 0))
        canvas.paste(content, (pad_left, pad_top))
    else:
        canvas = content
    return _Working(
        source=source, canvas=canvas, alpha=alpha, prefer_png=alpha or source_format == "PNG",
        base={
            "source_width": src_w, "source_height": src_h, "exif_orientation": orientation,
            "width": width, "height": height,
            "scale_x": content_w / width, "scale_y": content_h / height,
            "content_width": content_w, "content_height": content_h,
            "pad_left": pad_left, "pad_top": pad_top, "sent_width": sent_w, "sent_height": sent_h,
            "source_format": source_format, "frames": frames,
        },
    )


def _encode(work: _Working, fmt: str, quality: int | None = None) -> bytes:
    buffer = io.BytesIO()
    if fmt == "png":
        work.canvas.save(buffer, format="PNG", optimize=False)
    else:
        image = work.canvas
        if image.mode == "RGBA":
            # Last resort only (byte budget): JPEG has no alpha, so flatten on white.
            flat = Image.new("RGB", image.size, (255, 255, 255))
            flat.paste(image, mask=image.getchannel("A"))
            image = flat
        # Baseline (not progressive) 8-bit JPEG, the safest form TypeSafe takes.
        image.save(buffer, format="JPEG", quality=quality or _JPEG_QUALITIES[0], progressive=False)
    return buffer.getvalue()


def _ladder(work: _Working) -> list[tuple[str, int | None]]:
    """Encodings to try, largest first: PNG when the source wants it (alpha,
    or a PNG input such as a screenshot), then JPEG at falling quality."""
    return ([("png", None)] if work.prefer_png else []) + [("jpg", q) for q in _JPEG_QUALITIES]


def _prepare_all(sources: Sequence[tuple[str, bytes]], label: str, budget: int,
                 max_side: int = MAX_SIDE) -> list[PreparedImage]:
    works = [_prepare_geometry(source, data, f"{label} {index + 1}", max_side) for index, (source, data) in
             enumerate(sources)]
    ladders = [_ladder(work) for work in works]
    steps = [0] * len(works)
    encoded: list[bytes] = []
    for index, work in enumerate(works):
        # First rung under TypeSafe's per-image cap.
        while True:
            fmt, quality = ladders[index][steps[index]]
            data = _encode(work, fmt, quality)
            if len(data) <= MAX_IMAGE_BYTES:
                break
            if steps[index] + 1 >= len(ladders[index]):
                raise as_person_line(ValueError(f"{label} {index + 1} is over TypeSafe's 16 MiB per-image limit even as a "
                                 "small JPEG"))
            steps[index] += 1
        encoded.append(data)
    # Over the request budget: step the largest image that can still shrink
    # one rung down, until everything fits.
    while sum(len(data) for data in encoded) > budget:
        candidates = [i for i in range(len(works)) if steps[i] + 1 < len(ladders[i])]
        if not candidates:
            total = sum(len(data) for data in encoded) / (1024 * 1024)
            raise as_person_line(ValueError(
                f"The {len(encoded)} images come to {total:.1f} MiB even as small JPEGs, over TypeSafe's "
                "32 MiB request limit. Send fewer images or split the work across nodes."))
        index = max(candidates, key=lambda i: len(encoded[i]))
        steps[index] += 1
        fmt, quality = ladders[index][steps[index]]
        encoded[index] = _encode(works[index], fmt, quality)
    prepared = []
    for index, (work, data) in enumerate(zip(works, encoded)):
        fmt, quality = ladders[index][steps[index]]
        transform = ImageTransform(**work.base, sent_format=fmt, quality=quality)
        prepared.append(PreparedImage(
            source=work.source, placeholder=str(uuid.uuid4()), part=f"image-{index + 1}",
            data=data, format=fmt, transform=transform))
    return prepared


async def prepare_images(values: Iterable[Any], *, label: str = "Image",
                         max_images: int = DEFAULT_MAX_IMAGES, max_side: int = MAX_SIDE) -> list[PreparedImage]:
    """Load and fit graph image values for one request, in order.

    Every image gets a fresh uuid4 placeholder and a part name. The total stays
    inside TypeSafe's 32 MiB body (re-encoding as JPEG if needed); otherwise a
    ValueError says what to change. ``max_side`` shrinks the long side further
    than TypeSafe requires, for a retry after max_tokens_exceeded.
    """
    if not MIN_SIDE <= max_side <= MAX_SIDE:
        raise ValueError(f"max_side must be from {MIN_SIDE} to {MAX_SIDE}")
    items = [str(value) for value in values if value not in (None, "")]
    if len(items) > max_images:
        raise as_person_line(ValueError(f"{len(items)} images connected; this node takes at most {max_images}"))
    loaded: list[tuple[str, bytes]] = []
    total = 0
    for index, item in enumerate(items):
        data = await load_image_source(item, label=f"{label} {index + 1}")
        total += len(data)
        if total > MAX_TOTAL_SOURCE_BYTES:
            raise as_person_line(ValueError(
                f"The images come to more than {MAX_TOTAL_SOURCE_BYTES // (1024 * 1024)} MiB before resizing. "
                "Send fewer or smaller images."))
        loaded.append((item, data))
    if not loaded:
        return []
    return await asyncio.to_thread(_prepare_all, loaded, label, MAX_REQUEST_BYTES - _REQUEST_MARGIN, max_side)


# -- questions -----------------------------------------------------------------


def neutral_keys(count: int) -> list[str]:
    """Option keys that carry no meaning: a, b, ... z, aa, ab, ...

    Jev reads option names, and a loaded name ("good", "on_brief") steers the
    answer. The wording goes in the option's description instead.
    """
    if count < 0 or count > MAX_CHOICE_OPTIONS:
        raise as_person_line(ValueError(f"A Choice takes 1 to {MAX_CHOICE_OPTIONS} options"))
    keys = []
    for index in range(count):
        name, number = "", index
        while True:
            name = chr(ord("a") + number % 26) + name
            number = number // 26 - 1
            if number < 0:
                break
        keys.append(name)
    return keys


def split_lines(text: Any) -> list[str]:
    """Non-empty, trimmed lines of a "one per line" textarea param."""
    return [line.strip() for line in str(text or "").splitlines() if line.strip()]


@dataclass(frozen=True)
class ChoiceReading:
    label: str  # the winning option, in the caller's words
    index: int
    probability: float
    probabilities: dict[str, float]  # label -> probability, in option order
    confidence: float


@dataclass(frozen=True)
class ChoiceOptions:
    """A Choice whose keys are neutral and whose labels are the caller's."""

    labels: tuple[str, ...]
    keys: tuple[str, ...]

    @classmethod
    def from_labels(cls, labels: Sequence[str]) -> "ChoiceOptions":
        labels = tuple(str(label) for label in labels)
        if len(labels) < 2:
            raise as_person_line(ValueError("A Choice needs at least two options"))
        if len(set(labels)) != len(labels):
            raise as_person_line(ValueError("Choice options must be different from each other"))
        return cls(labels=labels, keys=tuple(neutral_keys(len(labels))))

    def criteria(self, descriptions: Sequence[Any] | None = None) -> dict[str, Any]:
        """{key: description}. Descriptions default to the labels themselves;
        pass placeholders (or objects holding them) to define options by image."""
        values = list(descriptions) if descriptions is not None else list(self.labels)
        if len(values) != len(self.keys):
            raise ValueError("one description per option")
        return dict(zip(self.keys, values))

    def read(self, answer: "JevAnswer") -> ChoiceReading:
        if answer.type != "choice" or answer.choice not in self.keys:
            raise TypeSafeError("TypeSafe returned a Choice answer for an option Nebula didn't send")
        probabilities = {label: _probability(answer.probabilities.get(key, 0.0))
                         for key, label in zip(self.keys, self.labels)}
        index = self.keys.index(answer.choice)
        confidence = answer.confidence if answer.confidence is not None else _choice_confidence(
            list(probabilities.values()))
        return ChoiceReading(label=self.labels[index], index=index, probability=probabilities[self.labels[index]],
                             probabilities=probabilities, confidence=_probability(confidence))


@dataclass(frozen=True)
class ScoreReading:
    score: float  # 0 .. levels-1, can land between levels
    normalized: float  # score / (levels-1), 0..1
    level: int  # the most likely level (ties go to the lower one)
    label: str
    probabilities: dict[str, float]  # level text -> probability, low to high
    confidence: float


def score_criteria(levels: Sequence[str]) -> list[str]:
    """Score levels low to high. The request field is ``criteria`` (an array),
    as the API reference and the SDK's Score type both say."""
    levels = [str(level) for level in levels]
    if not MIN_SCORE_LEVELS <= len(levels) <= MAX_SCORE_LEVELS:
        raise as_person_line(ValueError(f"A Score needs {MIN_SCORE_LEVELS} to {MAX_SCORE_LEVELS} levels"))
    if len(set(levels)) != len(levels):
        raise as_person_line(ValueError("Score levels must be different from each other"))
    return levels


def read_score(answer: "JevAnswer", levels: Sequence[str]) -> ScoreReading:
    if answer.type != "score" or answer.score is None:
        raise TypeSafeError("TypeSafe didn't return a Score answer")
    top = len(levels) - 1
    score = _clamp(answer.score, 0.0, float(top))
    probabilities = {str(label): _probability(answer.probabilities.get(str(index), 0.0))
                     for index, label in enumerate(levels)}
    values = list(probabilities.values())
    level = max(range(len(values)), key=lambda index: (values[index], -index))
    confidence = answer.confidence if answer.confidence is not None else 0.0
    return ScoreReading(score=score, normalized=score / top if top else 0.0, level=level,
                        label=str(levels[level]), probabilities=probabilities,
                        confidence=_probability(confidence))


def noul_confidence(probability: float) -> float:
    """Noul answers carry no confidence field; |2p - 1| is the distance from a
    coin flip (0 at p = 0.5, 1 at p = 0 or 1)."""
    return abs(2.0 * _probability(probability) - 1.0)


def _choice_confidence(values: list[float]) -> float:
    if not values:
        return 0.0
    count = len(values)
    return _clamp((count * max(values) - 1) / (count - 1)) if count > 1 else 1.0


def _probability(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return _clamp(number) if math.isfinite(number) else 0.0


# -- responses -----------------------------------------------------------------


@dataclass(frozen=True)
class JevAnswer:
    type: str
    noul: float | None = None
    choice: str | None = None
    score: float | None = None
    probabilities: dict[str, float] = field(default_factory=dict)
    legend: dict[str, Any] = field(default_factory=dict)
    confidence: float | None = None  # None for Noul, and for Box when TypeSafe sends none
    box: dict[str, float] | None = None  # top/bottom/left/right fractions of the SENT image


@dataclass(frozen=True)
class JevResult:
    model: str  # the versioned id that answered, e.g. jev-1.14.0
    requested_model: str
    answers: dict[str, JevAnswer]
    input_tokens: int | None
    output_tokens: int | None
    request_id: str | None = None

    def answer(self, question_id: str, kind: str) -> JevAnswer:
        found = self.answers.get(question_id)
        if found is None or found.type != kind:
            raise TypeSafeError(f"TypeSafe's response has no {kind} answer for {question_id!r}",
                                request_id=self.request_id)
        return found


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _parse_answer(raw: Any) -> JevAnswer:
    if not isinstance(raw, Mapping):
        raise ValueError("answer is not an object")
    kind = str(raw.get("type") or "")
    probabilities = {str(key): number for key, value in (raw.get("probabilities") or {}).items()
                     if (number := _finite(value)) is not None} if isinstance(raw.get("probabilities"), Mapping) else {}
    confidence = _finite(raw.get("confidence"))
    if kind == "noul":
        value = _finite(raw.get("noul"))
        if value is None:
            raise ValueError("noul answer has no number")
        return JevAnswer(type=kind, noul=_clamp(value))
    if kind == "choice":
        if not isinstance(raw.get("choice"), str):
            raise ValueError("choice answer has no option")
        return JevAnswer(type=kind, choice=raw["choice"], probabilities=probabilities, confidence=confidence)
    if kind == "score":
        value = _finite(raw.get("score"))
        if value is None:
            raise ValueError("score answer has no number")
        legend = dict(raw.get("legend") or {}) if isinstance(raw.get("legend"), Mapping) else {}
        return JevAnswer(type=kind, score=value, probabilities=probabilities, legend=legend, confidence=confidence)
    if kind == "box":
        edges = raw.get("box")
        if not isinstance(edges, Mapping):
            raise ValueError("box answer has no box")
        box = {}
        for edge in ("top", "bottom", "left", "right"):
            value = _finite(edges.get(edge))
            if value is None:
                raise ValueError(f"box answer has no {edge}")
            box[edge] = _clamp(value)
        return JevAnswer(type=kind, box=box, confidence=confidence)
    raise ValueError(f"unknown answer type {kind!r}")


def parse_response(body: Any, *, requested_model: str, request_id: str | None = None) -> JevResult:
    try:
        if not isinstance(body, Mapping) or not isinstance(body.get("answers"), Mapping):
            raise ValueError("no answers")
        answers = {str(key): _parse_answer(value) for key, value in body["answers"].items()}
    except ValueError as exc:
        raise TypeSafeError(f"TypeSafe sent an answer Nebula can't read ({exc})", request_id=request_id) from exc
    usage = body.get("usage") if isinstance(body.get("usage"), Mapping) else {}

    def tokens(name: str) -> int | None:
        value = usage.get(name)
        return int(value) if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

    model = body.get("model") if isinstance(body.get("model"), str) and body.get("model") else requested_model
    return JevResult(model=model, requested_model=requested_model, answers=answers,
                     input_tokens=tokens("input_tokens"), output_tokens=tokens("output_tokens"),
                     request_id=request_id)


# -- request -------------------------------------------------------------------


def check_model(model: Any) -> str:
    value = str(model or "").strip() or DEFAULT_MODEL
    if not _MODEL_RE.match(value):
        raise ValueError(f"Unknown Jev model {value!r}; pick one of {', '.join(MODELS)}")
    return value


def _check_placeholders(text: str, images: Sequence[PreparedImage]) -> None:
    """Each image placeholder must appear exactly once in the request content.

    TypeSafe rejects an unreferenced asset (400), and every extra use sends the
    image again (more tokens, closer to the size limits). This is a bug in the
    caller, so it fails before anything is sent.
    """
    for image in images:
        count = text.count(image.placeholder)
        if count != 1:
            raise RuntimeError(
                f"Jev request bug: image placeholder for {image.part} appears {count} times (must be once)")
    if len({image.placeholder for image in images}) != len(images):
        raise RuntimeError("Jev request bug: two images share a placeholder")


def build_request(*, model: str, state: Any, questions: Mapping[str, Mapping[str, Any]],
                  images: Sequence[PreparedImage] = (), long_context: bool = False) -> tuple[dict[str, str], dict[str, Any]]:
    """The headers (without auth) and the httpx request kwargs for one call."""
    if not questions:
        raise as_person_line(ValueError("A Jev request needs at least one question"))
    body: dict[str, Any] = {"model": check_model(model), "state": state, "questions": dict(questions)}
    content = json.dumps({"state": state, "questions": body["questions"]}, ensure_ascii=False)
    _check_placeholders(content, images)
    has_box = any(str(q.get("type")) == "box" for q in questions.values() if isinstance(q, Mapping))
    headers: dict[str, str] = {"Accept": "application/json"}
    if images or has_box:
        headers[IMAGES_HEADER] = "true"
    if long_context:
        headers[LONG_CONTEXT_HEADER] = "true"
    if images:
        body["assets"] = {image.placeholder: {"type": "image", "part": image.part, "format": image.format}
                          for image in images}
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except ValueError as exc:
        raise ValueError("Jev requests take finite numbers only") from exc
    # About 200 bytes of multipart framing per part.
    total = len(encoded) + sum(len(image.data) + 256 for image in images)
    if total > MAX_REQUEST_BYTES:
        raise as_person_line(ValueError(
            f"The request is {total / (1024 * 1024):.1f} MiB, over TypeSafe's 32 MiB limit. "
            "Shorten the context or send fewer images."))
    if not images:
        headers["Content-Type"] = "application/json"
        return headers, {"content": encoded}
    # Multipart: the JSON body first, named "request", then one file part per image.
    files: list[tuple[str, tuple[str | None, bytes, str]]] = [("request", (None, encoded, "application/json"))]
    files += [(image.part, (f"{image.part}.{image.format}", image.data, image.mime)) for image in images]
    return headers, {"files": files}


def _redact(text: str, secret: str) -> str:
    return text.replace(secret, "***") if secret else text


def _error_detail(response: httpx.Response, api_key: str) -> tuple[str, str | None]:
    """A short, key-free description of an error body, plus any error code."""
    try:
        body = response.json()
    except ValueError:
        body = None
    code: str | None = None
    parts: list[str] = []
    if isinstance(body, Mapping):
        error = body.get("error") if isinstance(body.get("error"), Mapping) else body
        detail = error.get("detail", body.get("detail"))
        if isinstance(detail, Mapping):
            # TypeSafe's own shape, seen on live 400 and 401 replies (2026-10-14):
            # {"detail": {"error_type": "api_usage_error", "message": "..."}}.
            error, detail = detail, None
        for name in ("error_type", "code", "type"):
            if isinstance(error.get(name), str):
                code = code or error[name]
        if isinstance(detail, list):
            for item in detail[:3]:
                if isinstance(item, Mapping):
                    loc = item.get("loc")
                    where = ".".join(str(p) for p in loc) if isinstance(loc, (list, tuple)) else str(loc or "")
                    parts.append(f"{where}: {item.get('msg') or item.get('message') or ''}".strip(": "))
        elif isinstance(detail, str):
            parts.append(detail)
        for name in ("message", "msg"):
            if isinstance(error.get(name), str):
                parts.append(error[name])
        for name in ("field", "param", "path"):
            if isinstance(error.get(name), str):
                parts.append(f"field {error[name]}")
    elif response.text:
        parts.append(response.text)
    text = " ".join(dict.fromkeys(part.strip() for part in parts if part and part.strip()))
    text = _redact(" ".join(text.split()), api_key)
    if "max_tokens_exceeded" in text:
        code = "max_tokens_exceeded"  # more useful than a broad error_type
    elif code:
        # The code reaches the node error too; it gets the same key scrub and a cap.
        code = _redact(code, api_key)[:80]
    return (text[:300] + "…" if len(text) > 300 else text), code


# How a 400 says the images header is missing. The live reply names the
# header and calls images experimental; "not turned on" is older wording.
_IMAGES_OFF_HINTS = (IMAGES_HEADER.lower(), "images are experimental", "not turned on")


def _error_for(response: httpx.Response, api_key: str, *, attempts: int, has_images: bool) -> TypeSafeError:
    status = response.status_code
    detail, code = _error_detail(response, api_key)
    request_id = response.headers.get(REQUEST_ID_HEADER)
    # The messages below add their own full stop after the detail.
    detail = detail.rstrip(".") if not detail.endswith("…") else detail
    said = f": {detail}" if detail else ""
    tries = f" after {attempts} tries" if attempts > 1 else ""
    lowered = f"{detail} {code or ''}".lower()
    if status == 400 and "max_tokens_exceeded" in lowered:
        message = ("TypeSafe: the request doesn't fit in the model's context (400 max_tokens_exceeded). "
                   "Send fewer or smaller images, shorten the context, or turn on Long context.")
    elif status == 400 and any(hint in lowered for hint in _IMAGES_OFF_HINTS):
        message = (f"TypeSafe refused the images (400){said}. This build sends the {IMAGES_HEADER} "
                   "header, so TypeSafe may have renamed it or changed its value; "
                   "check docs.typesafe.ai/images.")
    elif status == 400 and has_images and any(word in lowered for word in ("image", "asset", "part", "placeholder")):
        message = f"TypeSafe rejected an image (400){said}. Re-export it as PNG or JPEG and run again."
    elif status == 400:
        message = f"TypeSafe rejected the request (400 bad request){said}"
    elif status == 401:
        message = (f"TypeSafe rejected TYPESAFE_API_KEY (401 unauthorized){said}. "
                   "Check the key in Settings → TypeSafe.")
    elif status == 403:
        message = (f"TypeSafe refused this key (403 forbidden){said}. "
                   "Check the key's organization and permissions in the TypeSafe console.")
    elif status == 413:
        message = (f"TypeSafe: the request is too large (413){said}. Send fewer or smaller images "
                   "(32 MiB per request, 16 MiB per image).")
    elif status == 415:
        message = f"TypeSafe couldn't read the request encoding (415){said}"
    elif status == 422:
        message = f"TypeSafe couldn't validate the request (422){said or ': no field named'}"
    elif status == 429:
        message = (f"TypeSafe rate limit hit (429){tries}. Wait a moment and run again; "
                   "limits are set per organization in the TypeSafe console.")
    elif status == 529:
        message = f"TypeSafe is overloaded (529){tries}. Try again shortly."
    elif status == 408:
        message = f"TypeSafe timed out (408){tries}. Try again."
    elif status >= 500:
        message = f"TypeSafe server error ({status}){tries}{said}"
    else:
        message = f"TypeSafe request failed ({status}){said}"
    if request_id:
        message += f" [request {request_id}]"
    return TypeSafeError(message, status=status, code=code, request_id=request_id)


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    """Seconds before retry number ``attempt`` (1-based): Retry-After when the
    server sends one (capped), else exponential backoff with jitter."""
    if response is not None:
        raw = response.headers.get("retry-after")
        if raw:
            try:
                seconds = float(raw)
            except ValueError:
                try:
                    seconds = (parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError):
                    seconds = -1.0
            if math.isfinite(seconds) and seconds >= 0:
                return min(seconds, RETRY_AFTER_MAX)
    delay = min(BACKOFF_MAX, BACKOFF_INITIAL * (2 ** (attempt - 1)))
    return delay * (1 - 0.25 * random.random())


def _make_client() -> httpx.AsyncClient:
    """One client per call. Tests replace this to mount an httpx.MockTransport."""
    return httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False)


async def _sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def system_one(api_key: str, *, model: str, state: Any, questions: Mapping[str, Mapping[str, Any]],
                     images: Sequence[PreparedImage] = (), long_context: bool = False) -> JevResult:
    """Ask Jev ``questions`` about ``state`` and return the parsed answers.

    ``state`` and the questions must mention each image's placeholder exactly
    once. Retries 408, 429 and 5xx (529 included) and connection failures up to
    MAX_RETRIES times, honouring Retry-After up to RETRY_AFTER_MAX seconds.
    """
    if not api_key:
        from execution.missing_credential import MissingCredentialError
        raise MissingCredentialError(f"{CREDENTIAL} is required")
    api_key = api_key.strip()
    if not api_key or not all("!" <= character <= "~" for character in api_key):
        # Checked here so a pasted space, line break or curly quote reads as
        # a key problem instead of a failed connection, and the key never
        # rides into an encoding error.
        raise with_person_line(TypeSafeError(f"{CREDENTIAL} has a character a key can't have (a space, line break or "
                            "non-ASCII letter). Paste it again in Settings → TypeSafe."),
            "Your TypeSafe API key has a character a key can't have, like a space or a line break. Paste it again in Settings.")
    headers, kwargs = build_request(model=model, state=state, questions=questions, images=images,
                                    long_context=long_context)
    headers["Authorization"] = f"Bearer {api_key}"
    requested = check_model(model)
    async with _make_client() as client:
        for attempt in range(1, MAX_RETRIES + 2):
            response: httpx.Response | None = None
            try:
                response = await client.post(API_URL, headers=headers, **kwargs)
            except TRANSPORT_ERRORS as exc:  # ssl.SSLError too: see services/http_errors.py
                if attempt > MAX_RETRIES:
                    kind = "timed out" if isinstance(exc, httpx.TimeoutException) else "connection failed"
                    raise with_person_line(TypeSafeError(f"Couldn't reach TypeSafe ({kind}) after {attempt} tries. "
                                        "Check your connection and try again."),
                        "Couldn't reach TypeSafe. Check your connection and try again.") from None
                await _sleep(_retry_delay(None, attempt))
                continue
            if response.status_code in RETRY_STATUSES and attempt <= MAX_RETRIES:
                await _sleep(_retry_delay(response, attempt))
                continue
            if response.status_code >= 400:
                raise _error_for(response, api_key, attempts=attempt, has_images=bool(images))
            request_id = response.headers.get(REQUEST_ID_HEADER)
            try:
                body = response.json()
            except ValueError:
                raise TypeSafeError("TypeSafe sent a response that isn't JSON", request_id=request_id) from None
            return parse_response(body, requested_model=requested, request_id=request_id)
    raise AssertionError("unreachable")  # pragma: no cover
