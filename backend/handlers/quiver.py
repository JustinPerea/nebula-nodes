"""QuiverAI Arrow handlers — generate (text+refs -> SVG) and vectorize (raster -> SVG).

Both handlers run the SSE-streaming variant of the QuiverClient so the
frontend can render progressive previews via StreamPartialSvgEvent on
each `draft` event. The `content` event carries the final SVG, which
gets written to OUTPUT_ROOT/<run>/<uuid>.svg. The graph store rewrites
the absolute path to `/api/outputs/<rel>.svg` on storage so downstream
nodes get a browser-loadable URL.
"""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from models.events import ExecutionEvent, StreamPartialSvgEvent
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT, get_run_dir
from services.quiver_client import (
    QuiverAuthError,
    QuiverClient,
    QuiverError,
    QuiverInsufficientCreditsError,
    QuiverRateLimitError,
    QuiverServerError,
)


_OUTPUTS_URL_PREFIX = "/api/outputs/"
_DATA_URI_RE = re.compile(r"^data:[^;,]+;base64,(.*)$", re.DOTALL)


def _is_external_url(value: str) -> bool:
    """External http(s) URLs that Quiver can fetch directly."""
    return value.startswith(("http://", "https://"))


def _resolve_local_path(value: str) -> Path | None:
    """Resolve a Nebula-internal value to a local filesystem path under OUTPUT_ROOT.

    Accepts the served URL form (`/api/outputs/<rel>`) and absolute
    filesystem paths that already live under OUTPUT_ROOT. Returns None
    for anything else so the caller falls back to base64 encoding from
    whatever raw path it has.
    """
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


def _to_quiver_image_arg(value: str) -> tuple[str | None, str | None]:
    """Return (image_url, image_base64) for QuiverClient.vectorize.

    - External http(s) URL -> pass-through as image_url.
    - data:...;base64,... -> strip the prefix, return base64.
    - Nebula-internal /api/outputs/... or local path -> read bytes, base64.

    Raises ValueError if the value resolves to nothing readable.
    """
    if _is_external_url(value):
        return value, None
    m = _DATA_URI_RE.match(value)
    if m:
        return None, m.group(1)
    local = _resolve_local_path(value)
    if local is None:
        raise ValueError(f"Cannot resolve image input to a fetchable form: {value!r}")
    return None, base64.b64encode(local.read_bytes()).decode("ascii")


def _ref_to_quiver_item(value: str) -> str | dict[str, str]:
    """Convert one reference image to an item for Quiver's `references` array.

    Per Quiver's OpenAPI schema, each `references` item is
    ``anyOf[{url: string}, {base64: string}, string(format: uri)]``.
    A plain string is only valid as an http(s) URL. Base64 and data-URI
    references MUST be wrapped as ``{"base64": "<raw base64, NO data: prefix>"}``.

    - External http(s) URL      → plain string (Quiver fetches directly)
    - data:...;base64,<b64>     → {"base64": "<b64>"} (prefix stripped)
    - Nebula /api/outputs/... or local path → read bytes, {"base64": "<b64>"}

    Raises ValueError if the value cannot be resolved to a fetchable form.
    """
    if _is_external_url(value):
        return value
    m = _DATA_URI_RE.match(value)
    if m:
        return {"base64": m.group(1)}
    local = _resolve_local_path(value)
    if local is None:
        raise ValueError(f"Cannot resolve reference image: {value!r}")
    b64 = base64.b64encode(local.read_bytes()).decode("ascii")
    return {"base64": b64}


def _coerce_references(value: Any) -> list[str | dict[str, str]]:
    """References input is Image+ (multiple), so it may be a single string OR a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return [_ref_to_quiver_item(str(v)) for v in value if v]
    return [_ref_to_quiver_item(str(value))]


def _make_emit(emit: Callable[[ExecutionEvent], Awaitable[None]] | None) -> Callable[[ExecutionEvent], Awaitable[None]]:
    if emit is not None:
        return emit
    async def _noop(_e: ExecutionEvent) -> None:
        return None
    return _noop


def _optional_float(params: dict[str, Any], key: str) -> float | None:
    v = params.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _optional_int(params: dict[str, Any], key: str) -> int | None:
    v = params.get(key)
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _wrap_provider_error(exc: QuiverError) -> ValueError:
    """Re-raise typed Quiver errors as ValueError with user-facing messages.

    The execution engine converts ValueError into ErrorEvent.error for the
    UI, so this keeps the failure surface clear instead of "RuntimeError:
    Quiver server error (502)".
    """
    if isinstance(exc, QuiverAuthError):
        return ValueError("QuiverAI auth failed — check QUIVER_API_KEY")
    if isinstance(exc, QuiverInsufficientCreditsError):
        return ValueError("Insufficient QuiverAI credits — top up or upgrade plan")
    if isinstance(exc, QuiverRateLimitError):
        return ValueError("QuiverAI rate limit exceeded — retry in a moment")
    if isinstance(exc, QuiverServerError):
        return ValueError(f"QuiverAI server error: {exc}")
    return ValueError(f"QuiverAI request failed: {exc}")


async def _consume_quiver_stream(
    stream,
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> str:
    """Iterate a Quiver SSE stream, emit StreamPartialSvgEvent on drafts,
    return the final SVG markup from the `content` event.

    Raises ValueError if the stream ends without a `content` event.
    """
    final_svg: str | None = None
    partial_index = 0
    async for event in stream:
        if event.type == "draft" and event.svg:
            await emit(StreamPartialSvgEvent(
                node_id=node_id,
                partial_index=partial_index,
                svg=event.svg,
                is_final=False,
            ))
            partial_index += 1
        elif event.type == "content" and event.svg:
            final_svg = event.svg
            await emit(StreamPartialSvgEvent(
                node_id=node_id,
                partial_index=partial_index,
                svg=event.svg,
                is_final=True,
            ))
    if final_svg is None:
        raise ValueError("Quiver stream ended without a final `content` event")
    return final_svg


def _write_svg_to_output(svg_markup: str) -> Path:
    """Write SVG bytes to OUTPUT_ROOT/<run>/<uuid>.svg. Returns the absolute path."""
    run_dir = get_run_dir()
    out_path = run_dir / f"{uuid4().hex[:12]}.svg"
    out_path.write_text(svg_markup, encoding="utf-8")
    return out_path


async def handle_quiver_arrow_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Text-to-SVG via POST /v1/svgs/generations (streaming).

    Inputs: prompt (Text, required), references (Image+, optional, max 16).
    Params: model, n, instructions, temperature, top_p, presence_penalty,
    max_output_tokens.
    """
    api_key = api_keys.get("QUIVER_API_KEY")
    if not api_key:
        raise ValueError("QUIVER_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required for Quiver Arrow generate")

    references_input = inputs.get("references")
    references = _coerce_references(references_input.value if references_input else None)

    params = node.params or {}
    client = QuiverClient(api_key)
    emit_fn = _make_emit(emit)

    try:
        stream = client.generate_stream(
            model=str(params.get("model", "arrow-1.1")),
            prompt=str(prompt_input.value),
            references=references or None,
            n=_optional_int(params, "n"),
            instructions=(str(params["instructions"]) if params.get("instructions") else None),
            temperature=_optional_float(params, "temperature"),
            top_p=_optional_float(params, "top_p"),
            presence_penalty=_optional_float(params, "presence_penalty"),
            max_output_tokens=_optional_int(params, "max_output_tokens"),
        )
        svg_markup = await _consume_quiver_stream(stream, node.id, emit_fn)
    except QuiverError as exc:
        raise _wrap_provider_error(exc)

    out_path = _write_svg_to_output(svg_markup)
    return {"svg": {"type": "SVG", "value": str(out_path)}}


async def handle_quiver_arrow_vectorize(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Raster-to-SVG via POST /v1/svgs/vectorizations (streaming).

    Inputs: image (Image, required, single).
    Params: model, auto_crop, target_size, temperature, top_p,
    presence_penalty, max_output_tokens.
    """
    api_key = api_keys.get("QUIVER_API_KEY")
    if not api_key:
        raise ValueError("QUIVER_API_KEY is required")

    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required for Quiver Arrow vectorize")

    image_url, image_base64 = _to_quiver_image_arg(str(image_input.value))

    params = node.params or {}
    client = QuiverClient(api_key)
    emit_fn = _make_emit(emit)

    try:
        stream = client.vectorize_stream(
            model=str(params.get("model", "arrow-1.1")),
            image_url=image_url,
            image_base64=image_base64,
            auto_crop=bool(params["auto_crop"]) if "auto_crop" in params else None,
            target_size=_optional_int(params, "target_size"),
            temperature=_optional_float(params, "temperature"),
            top_p=_optional_float(params, "top_p"),
            presence_penalty=_optional_float(params, "presence_penalty"),
            max_output_tokens=_optional_int(params, "max_output_tokens"),
        )
        svg_markup = await _consume_quiver_stream(stream, node.id, emit_fn)
    except QuiverError as exc:
        raise _wrap_provider_error(exc)

    out_path = _write_svg_to_output(svg_markup)
    return {"svg": {"type": "SVG", "value": str(out_path)}}
