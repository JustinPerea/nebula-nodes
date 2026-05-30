"""cinema-color handler (Soul HEX).

Thin glue node over the deterministic ``cinema.color`` pillar. Resolves the
input image, then either:

- transfers the image's colors toward a target ``palette`` of hex swatches via
  :func:`cinema.color.transfer_to_palette`, or
- when a ``source_image`` param is given and ``palette`` is empty, extracts a
  palette from that source image (:func:`cinema.color.extract_palette`) and
  transfers toward it.

Deterministic and local — no API calls. The processed PNG is written under
``OUTPUT_ROOT`` and returned as a ``/api/outputs/<rel>`` served URL in the
``image`` output port, mirroring ``handlers/style_reference.py``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from PIL import Image

from cinema.color import extract_palette, transfer_to_palette
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT, get_run_dir


_OUTPUTS_URL_PREFIX = "/api/outputs/"


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a port value / param to a real filesystem path, or None.

    Accepts:
    - ``/api/outputs/<rel>`` — served URL for an asset under OUTPUT_ROOT
    - absolute filesystem path — used as-is if it exists

    Mirrors ``handlers/style_reference.py`` defensively: returns None for
    anything unresolvable so the caller can raise a clear error instead of
    silently following a path-traversal escape.
    """
    if not value:
        return None
    if value.startswith(_OUTPUTS_URL_PREFIX):
        rel = value[len(_OUTPUTS_URL_PREFIX):]
        candidate = (OUTPUT_ROOT / rel).resolve()
        try:
            candidate.relative_to(OUTPUT_ROOT.resolve())
        except ValueError:
            return None
        return candidate if candidate.exists() else None
    candidate = Path(value).expanduser()
    if candidate.is_absolute() and candidate.exists():
        return candidate
    return None


def _input_image_ref(node: GraphNode, inputs: dict[str, PortValueDict]) -> str | None:
    """Pull the image reference from the connected ``image`` port or filePath param."""
    image_input = inputs.get("image")
    if image_input and image_input.value:
        raw = image_input.value
        if isinstance(raw, list):
            return str(raw[0]) if raw else None
        return str(raw)
    file_path = node.params.get("filePath")
    return str(file_path) if file_path else None


def _save_output_image(img: Image.Image) -> str:
    """Write the processed image under OUTPUT_ROOT and return its served URL."""
    run_dir = get_run_dir()
    out_path = run_dir / f"{uuid4().hex[:12]}.png"
    img.save(out_path, format="PNG")
    rel = out_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"{_OUTPUTS_URL_PREFIX}{rel}"


def _coerce_swatches(value: Any) -> list[Any]:
    """Normalize the ``palette`` param into a list of swatches.

    Accepts a list (returned as-is) or a comma-separated hex string. Anything
    else / empty → empty list (no-op transfer)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    s = str(value).strip()
    if not s:
        return []
    return [part.strip() for part in s.split(",") if part.strip()]


async def handle_cinema_color(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Apply Soul HEX color transfer to the input image. See module docstring."""
    params = node.params or {}

    ref = _input_image_ref(node, inputs)
    if not ref:
        raise ValueError("Cinema Color needs an input image (connect the image port)")
    abs_path = _resolve_local_path(ref)
    if abs_path is None:
        raise ValueError(f"Input image not found: {ref}")

    swatches = _coerce_swatches(params.get("palette"))

    # When no explicit palette is given but a source image is, extract the
    # palette from that source and transfer toward it.
    if not swatches:
        source_ref = params.get("source_image")
        if source_ref:
            source_path = _resolve_local_path(str(source_ref))
            if source_path is None:
                raise ValueError(f"Source image not found: {source_ref}")
            with Image.open(source_path) as src_img:
                swatches = extract_palette(src_img.convert("RGB"))

    # An empty palette would pass the image through unchanged, which reads as
    # "the node did nothing". Surface it as actionable feedback instead of a
    # silent no-op. (The scene path uses cinema.color directly and is unaffected:
    # there an empty palette is a deliberate skip of the optional colour stage.)
    if not swatches:
        raise ValueError(
            "Cinema Color needs a target palette. Add hex swatches in the Palette "
            "field (or click 'Extract from reference'), or set a Source Image to "
            "pull a palette from. With no palette the image passes through unchanged."
        )

    try:
        strength = float(params.get("strength", 0.7))
    except (TypeError, ValueError):
        strength = 0.7

    method = str(params.get("method", "lab-transfer"))

    with Image.open(abs_path) as img:
        result = transfer_to_palette(
            img.convert("RGB"), swatches, strength=strength, method=method
        )

    url = _save_output_image(result)
    return {"image": {"type": "Image", "value": url}}
