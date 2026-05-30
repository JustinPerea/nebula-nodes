"""cinema-scene handler — multi-shot Soul Cinema orchestrator (async-poll).

Self-contained handler that, per shot, runs the Soul Cinema stack:

1. **Base / identity** — call the chosen base *edit* model (reference-edit:
   character refs condition identity) with ``{prompt + shot.prompt,
   image_urls = character.refImageUrls + shot.refImageUrls, aspectRatio}``.
   The base model is dispatched by REUSING the existing handler registry — we
   synthesize a ``GraphNode`` for the base model and invoke its registered
   closure exactly as ``execute_graph`` would. No new network channel.
2. **Color** — :func:`cinema.color.transfer_to_palette` with the shared palette
   (or the shot's ``overrides.palette``).
3. **Look** — :func:`cinema.look.apply_look` with the shared look (or the
   shot's ``overrides.look``).

The finished shot is written under ``OUTPUT_ROOT`` and mapped to that shot's
**dynamic output port** (port id derived from ``shot.id``). Per-shot isolation:
a shot that raises is recorded as ``status: 'error'`` and the scene continues;
the scene completes partially. Per-shot caching keys on a stable input hash so
re-running regenerates only changed shots.

License guard: the default base must be a commercial-OK model
(``seedream-4-5`` / ``nano-banana``); FLUX.1-dev is never used as the default.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

import httpx
from PIL import Image

from cinema.color import transfer_to_palette
from cinema.look import apply_look
from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT, get_run_dir


_OUTPUTS_URL_PREFIX = "/api/outputs/"

# Commercial-OK default bases (reference-edit capable). FLUX.1-dev is a
# non-commercial license and must never be the default base.
_COMMERCIAL_OK_DEFAULT_BASES = {"seedream-4-5", "nano-banana", "flux-kontext"}
_NONCOMMERCIAL_BASES = {"flux-1-dev", "flux.1-dev", "flux-dev"}
_DEFAULT_BASE_MODEL = "seedream-4-5"


def _output_port_id(shot_id: str) -> str:
    """Derive the dynamic output port id for a shot. Mirrors the frontend
    shotPortId() convention (constants/ports.ts) so the per-shot dynamic
    output ports, edges, and the executed-output keys all line up."""
    return f"shot_{shot_id}"


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a served URL / absolute path to a real filesystem path, or None.

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


async def _load_image(value: str) -> Image.Image:
    """Load a base-model output value into a PIL image.

    The base handler may return a local path, a ``/api/outputs/<rel>`` served
    URL, or a remote ``http(s)`` URL (FAL). Resolve local refs against
    OUTPUT_ROOT; download remote URLs."""
    if value.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.get(value)
            resp.raise_for_status()
        import io

        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    local = _resolve_local_path(value)
    if local is None:
        raise ValueError(f"Base model output could not be resolved to an image: {value!r}")
    with Image.open(local) as img:
        return img.convert("RGB")


def _save_output_image(img: Image.Image) -> str:
    run_dir = get_run_dir()
    out_path = run_dir / f"{uuid4().hex[:12]}.png"
    img.save(out_path, format="PNG")
    rel = out_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    return f"{_OUTPUTS_URL_PREFIX}{rel}"


def _guard_base_model(base: dict[str, Any]) -> str:
    """Return a commercial-OK base model id, substituting the default if the
    requested one is non-commercial (FLUX.1-dev) or missing."""
    model = str(base.get("model") or "").strip()
    if not model or model.lower() in _NONCOMMERCIAL_BASES:
        return _DEFAULT_BASE_MODEL
    return model


def _shot_hash(
    base_model: str,
    prompt: str,
    image_urls: list[str],
    aspect_ratio: str,
    palette: dict[str, Any] | None,
    look: dict[str, Any] | None,
    extra_params: dict[str, Any],
) -> str:
    """Stable hash of everything that determines a shot's output."""
    payload = {
        "base_model": base_model,
        "prompt": prompt,
        "image_urls": image_urls,
        "aspect_ratio": aspect_ratio,
        "palette": palette or {},
        "look": look or {},
        "params": extra_params,
    }
    blob = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _merge_palette(scene_palette: dict[str, Any] | None, override: dict[str, Any] | None) -> dict[str, Any] | None:
    """Shared palette with a shot's partial override applied on top."""
    if not scene_palette and not override:
        return None
    merged: dict[str, Any] = dict(scene_palette or {})
    if override:
        merged.update({k: v for k, v in override.items() if v is not None})
    return merged or None


def _merge_look(scene_look: dict[str, Any] | None, override: dict[str, Any] | None) -> dict[str, Any] | None:
    if not scene_look and not override:
        return None
    merged: dict[str, Any] = dict(scene_look or {})
    if override:
        merged.update({k: v for k, v in override.items() if v is not None})
    return merged or None


def _build_base_node(
    base_model: str,
    prompt: str,
    image_urls: list[str],
    aspect_ratio: str,
    extra_params: dict[str, Any],
    node_id: str,
) -> tuple[GraphNode, dict[str, PortValueDict]]:
    """Synthesize a GraphNode + resolved-inputs dict for the base edit model.

    We feed the prompt through the ``prompt`` input port and the reference
    images through BOTH ``image`` (single, e.g. flux-kontext) and ``images``
    (multiple, e.g. nano-banana) ports so whichever port the base handler reads
    is populated — the universal/base handlers ignore ports they don't map."""
    params: dict[str, Any] = {"aspectRatio": aspect_ratio, **extra_params}
    base_node = GraphNode(id=f"{node_id}__base", definitionId=base_model, params=params)

    inputs: dict[str, PortValueDict] = {
        "prompt": PortValueDict(type="Text", value=prompt),
    }
    if image_urls:
        inputs["image"] = PortValueDict(type="Image", value=image_urls[0])
        inputs["images"] = PortValueDict(type="Image", value=list(image_urls))
    return base_node, inputs


def _extract_image_url(base_outputs: dict[str, Any]) -> str:
    """Pull the image value from a base handler's output dict."""
    image_port = base_outputs.get("image")
    if isinstance(image_port, dict) and image_port.get("value"):
        return str(image_port["value"])
    # Some handlers may key differently; fall back to the first Image-typed port.
    for port in base_outputs.values():
        if isinstance(port, dict) and port.get("type") == "Image" and port.get("value"):
            return str(port["value"])
    raise ValueError("Base model produced no image output")


async def handle_cinema_scene(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Orchestrate base -> color -> look per shot. See module docstring."""
    params = node.params or {}
    scene = params.get("scene") or {}
    if not isinstance(scene, dict):
        raise ValueError("cinema-scene needs a scene spec on params.scene")

    base = scene.get("base") or {}
    base_model = _guard_base_model(base)
    base_extra_params: dict[str, Any] = dict(base.get("params") or {})

    character = scene.get("character") or {}
    character_refs: list[str] = list(character.get("refImageUrls") or [])

    # character_refs may also arrive on the connected input port (multiple).
    char_port = inputs.get("character_refs")
    if char_port and char_port.value:
        raw = char_port.value
        if isinstance(raw, list):
            character_refs = [str(v) for v in raw if v] + character_refs
        else:
            character_refs = [str(raw)] + character_refs

    scene_palette = scene.get("palette") or None
    scene_look = scene.get("look") or None
    aspect_ratio = str(scene.get("aspectRatio") or "16:9")
    base_prompt = str(scene.get("prompt") or "")

    shots = scene.get("shots") or []
    if not isinstance(shots, list):
        raise ValueError("cinema-scene scene.shots must be a list")

    # Lazily import the registry to dispatch the base model the same way
    # execute_graph does. Pass emit so streaming/poll progress flows through.
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=emit)
    base_handler = registry.get(base_model)

    outputs: dict[str, Any] = {}
    total = max(1, len(shots))

    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        shot_id = str(shot.get("id") or f"shot{index}")
        port_id = _output_port_id(shot_id)

        try:
            if base_handler is None:
                raise ValueError(
                    f"No handler registered for base model '{base_model}'"
                )

            shot_prompt = str(shot.get("prompt") or "")
            full_prompt = (f"{base_prompt} {shot_prompt}".strip()
                           if base_prompt else shot_prompt)

            shot_refs: list[str] = list(shot.get("refImageUrls") or [])
            image_urls = character_refs + shot_refs

            overrides = shot.get("overrides") or {}
            palette = _merge_palette(scene_palette, overrides.get("palette"))
            look = _merge_look(scene_look, overrides.get("look"))

            # 1. Base / identity — reuse the registered base handler.
            base_node, base_inputs = _build_base_node(
                base_model, full_prompt, image_urls, aspect_ratio,
                base_extra_params, node.id,
            )
            base_outputs = await base_handler(base_node, base_inputs, api_keys)
            base_image_value = _extract_image_url(base_outputs)
            img = await _load_image(base_image_value)

            # 2. Color (Soul HEX) — only when a palette with swatches is set.
            if palette and palette.get("swatches"):
                img = transfer_to_palette(
                    img,
                    palette.get("swatches") or [],
                    strength=float(palette.get("strength", 0.7) or 0.0),
                    method=str(palette.get("method", "lab-transfer")),
                )

            # 3. Look (film-look post).
            if look:
                img = apply_look(img, look)

            url = _save_output_image(img)
            shot_hash = _shot_hash(
                base_model, full_prompt, image_urls, aspect_ratio,
                palette, look, base_extra_params,
            )
            shot["output"] = {"imageUrl": url, "status": "done", "hash": shot_hash}
            outputs[port_id] = {"type": "Image", "value": url}

        except Exception as exc:  # per-shot isolation — never abort the scene
            shot["output"] = {"status": "error", "error": str(exc)}
            outputs[port_id] = {"type": "Image", "value": None}

        if emit is not None:
            await emit(ProgressEvent(node_id=node.id, value=min((index + 1) / total, 1.0)))

    # Persist the updated shot statuses/outputs back onto the node spec so the
    # editor and canvas preview reflect per-shot results.
    scene["shots"] = shots
    node.params["scene"] = scene

    return outputs
