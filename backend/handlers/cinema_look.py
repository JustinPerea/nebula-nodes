"""cinema-look handler (film-look post stage).

Thin glue node over the deterministic ``cinema.look`` pillar. Resolves the
input image, assembles a look dict from the node params (preset + sliders +
optional ``.cube`` LUT), applies :func:`cinema.look.apply_look`, writes the
result under ``OUTPUT_ROOT``, and returns a ``/api/outputs/<rel>`` served URL.

Deterministic and local — no API calls. A bad/missing LUT is skipped with a
warning by the pillar; this handler never crashes on it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from PIL import Image

from cinema.look import PRESETS, apply_look
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT, get_run_dir


_OUTPUTS_URL_PREFIX = "/api/outputs/"

# Float slider params forwarded verbatim into the look dict. Mirrors
# cinema.look._FLOAT_KEYS so presets and explicit overrides resolve correctly.
_LOOK_FLOAT_KEYS = (
    "grain",
    "halation",
    "vignette",
    "contrast",
    "saturation",
    "temperature",
    "teal_orange",
)


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a port value / param to a real filesystem path, or None.

    Accepts ``/api/outputs/<rel>`` (sandboxed under OUTPUT_ROOT) and absolute
    filesystem paths. Mirrors ``handlers/style_reference.py``."""
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
    run_dir = get_run_dir()
    out_path = run_dir / f"{uuid4().hex[:12]}.png"
    img.save(out_path, format="PNG")
    rel = out_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"{_OUTPUTS_URL_PREFIX}{rel}"


def _build_look(params: dict[str, Any]) -> dict[str, Any]:
    """Assemble a cinema.look look-dict from the node params.

    ``preset`` selects a named bundle; explicit float sliders override. A
    ``lut`` param (file path / served URL) is resolved to a local path so the
    LUT loader can read it; an unresolvable LUT is passed through and the
    pillar skips it with a warning."""
    look: dict[str, Any] = {}
    preset = params.get("preset")
    is_named_preset = isinstance(preset, str) and preset in PRESETS
    if isinstance(preset, str) and preset:
        look["preset"] = preset
    # The float sliders are 'custom'-mode controls (hidden via visibleWhen for
    # named presets), but the node still carries their neutral default values and
    # the frontend forwards them. _resolve_params lets explicit floats override the
    # preset, so forwarding those defaults would clobber a selected preset's grade
    # (e.g. kodak-portra's warmth) back to zero. Only forward sliders when NOT on a
    # named preset (custom / unset); a named preset uses its own bundle.
    if not is_named_preset:
        for key in _LOOK_FLOAT_KEYS:
            if key in params and params[key] is not None and params[key] != "":
                look[key] = params[key]

    lut_ref = params.get("lut") or params.get("lutId")
    if lut_ref:
        resolved = _resolve_local_path(str(lut_ref))
        look["lutId"] = str(resolved) if resolved is not None else str(lut_ref)
    return look


async def handle_cinema_look(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Apply the film-look chain to the input image. See module docstring."""
    params = node.params or {}

    ref = _input_image_ref(node, inputs)
    if not ref:
        raise ValueError("Cinema Look needs an input image (connect the image port)")
    abs_path = _resolve_local_path(ref)
    if abs_path is None:
        raise ValueError(f"Input image not found: {ref}")

    look = _build_look(params)

    with Image.open(abs_path) as img:
        result = apply_look(img.convert("RGB"), look)

    url = _save_output_image(result)
    return {"image": {"type": "Image", "value": url}}
