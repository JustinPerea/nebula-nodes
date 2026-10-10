from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Awaitable, Callable

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.file_access import require_allowed_path
from services.output import get_run_dir

OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits"
DEFAULT_PARTIAL_IMAGES = 0  # Node def no longer exposes this; small/fast jobs never emit partials anyway.

# GPT Image 2.5 (2026-09-08): Flare is the fast default, Sunburst the most
# precise. Both add xhigh/max quality and transparent backgrounds.
GPT_IMAGE_25_MODELS = ("gpt-image-2.5-flare", "gpt-image-2.5-sunburst")
GPT_IMAGE_25_QUALITIES = {"auto", "low", "medium", "high", "xhigh", "max"}


def _guess_mime(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed and guessed.startswith("image/"):
        return guessed
    return "image/png"


def _is_org_verification_error(body: str) -> bool:
    return "organization_must_be_verified" in body or "must be verified" in body.lower()


def _raise_org_verification_error(model: str = "gpt-image-2") -> None:
    raise RuntimeError(
        f"Your OpenAI org isn't verified for {model}. "
        "Visit https://platform.openai.com/settings/organization/general to verify."
    )


def build_generate_body(node: GraphNode, prompt_text: str, model: str = "gpt-image-2") -> dict[str, Any]:
    params = node.params or {}
    body: dict[str, Any] = {
        "model": model,
        "prompt": prompt_text,
        "stream": True,
        "partial_images": int(params.get("partial_images", DEFAULT_PARTIAL_IMAGES)),
    }
    for key in ("size", "quality", "moderation"):
        value = params.get(key)
        if value and value != "auto":
            body[key] = value
    # OpenAI rejects n>1 when stream=true. We always stream, so we never forward n.
    # If a legacy saved graph has n in params, it's silently dropped.
    fmt = params.get("output_format", "png")
    if fmt and fmt != "png":
        body["output_format"] = fmt
        comp = params.get("output_compression")
        if comp is not None:
            body["output_compression"] = int(comp)
    # Defensive: gpt-image-2 does NOT support these, never forward.
    body.pop("background", None)
    body.pop("input_fidelity", None)
    return body


def gpt_image_25_model(node: GraphNode) -> str:
    model = (node.params or {}).get("model") or GPT_IMAGE_25_MODELS[0]
    if model not in GPT_IMAGE_25_MODELS:
        raise ValueError(f"GPT Image 2.5 model must be Flare or Sunburst, not {model}")
    return model


def build_25_body(node: GraphNode, prompt_text: str) -> dict[str, Any]:
    """GPT Image 2 body plus the 2.5 additions; refuses what OpenAI would reject before any request."""
    params = node.params or {}
    model = gpt_image_25_model(node)
    quality = params.get("quality") or "auto"
    if quality not in GPT_IMAGE_25_QUALITIES:
        raise ValueError(f"GPT Image 2.5 quality must be one of {', '.join(sorted(GPT_IMAGE_25_QUALITIES))}")
    body = build_generate_body(node, prompt_text, model=model)
    background = params.get("background") or "auto"
    if background not in {"auto", "opaque", "transparent"}:
        raise ValueError("Background must be auto, opaque or transparent")
    if background == "transparent" and body.get("output_format", "png") not in {"png", "webp"}:
        raise ValueError("A transparent background needs PNG or WebP output, not JPEG")
    if background != "auto":
        body["background"] = background
    return body


async def handle_gpt_image_2_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
    run_dir: Path | None = None,
    *,
    build_body: Callable[[GraphNode, str], dict[str, Any]] = build_generate_body,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")
    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    body = build_body(node, str(prompt_input.value))
    config = StreamConfig(
        url=OPENAI_GENERATIONS_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        timeout=180.0,
    )
    effective_run_dir = run_dir or get_run_dir()

    async def _noop(_e: ExecutionEvent) -> None:
        return None

    try:
        final_path = await stream_execute_image(
            config=config,
            request_body=body,
            node_id=node.id,
            emit=emit or _noop,
            run_dir=effective_run_dir,
            provider="openai",
        )
    except RuntimeError as exc:
        msg = str(exc)
        if _is_org_verification_error(msg):
            _raise_org_verification_error(body["model"])
        raise

    return {"image": {"type": "Image", "value": final_path}}


MAX_EDIT_IMAGES = 10


def _normalize_image_input(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str) and value:
        return [value]
    return []


async def handle_gpt_image_2_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
    run_dir: Path | None = None,
    *,
    build_body: Callable[[GraphNode, str], dict[str, Any]] = build_generate_body,
) -> dict[str, Any]:
    image_input = inputs.get("images")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required but was not provided")
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")
    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    image_paths = _normalize_image_input(image_input.value)
    if len(image_paths) > MAX_EDIT_IMAGES:
        raise ValueError(
            f"GPT Image edit accepts up to {MAX_EDIT_IMAGES} input images; got {len(image_paths)}"
        )
    if len(image_paths) == 0:
        raise ValueError("Image input is required but was not provided")

    body = build_body(node, str(prompt_input.value))
    # Edits POST is multipart, not JSON — build separately.
    effective_run_dir = run_dir or get_run_dir()

    # Build multipart form.
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in image_paths:
        p = Path(path)
        files.append(("image[]", (p.name, require_allowed_path(p).read_bytes(), _guess_mime(p))))
    mask_input = inputs.get("mask")
    if mask_input and mask_input.value:
        mp = Path(str(mask_input.value))
        files.append(("mask", (mp.name, require_allowed_path(mp).read_bytes(), "image/png")))

    form: dict[str, str] = {}
    for key in ("model", "prompt", "size", "quality", "moderation", "output_format", "background"):
        if key in body:
            form[key] = str(body[key])
    if "output_compression" in body:
        form["output_compression"] = str(body["output_compression"])
    if "n" in body:
        form["n"] = str(body["n"])
    form["stream"] = "true"
    form["partial_images"] = str(body["partial_images"])

    # Use httpx directly for multipart + SSE streaming.
    import httpx
    import json

    from models.events import StreamPartialImageEvent
    from services.output import save_base64_image_named

    async def _noop(_e: ExecutionEvent) -> None:
        return None

    _emit = emit or _noop
    import logging
    logger = logging.getLogger(__name__)
    final_path: Path | None = None
    current_event_type: str | None = None
    seen_event_types: list[str] = []
    seen_data_snippets: list[str] = []  # short snippets of unrecognized data for diagnostics

    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, read=None)) as client:
        async with client.stream(
            "POST", OPENAI_EDITS_URL,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "text/event-stream"},
            data=form, files=files,
        ) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                if _is_org_verification_error(error_body):
                    _raise_org_verification_error(body["model"])
                raise RuntimeError(f"Image edit failed ({response.status_code}): {error_body}")
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    current_event_type = None
                    continue
                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
                    seen_event_types.append(current_event_type)
                    continue
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                except (ValueError, TypeError):
                    continue
                # OpenAI uses image_edit.* for edit endpoint, image_generation.* for generate.
                # Accept both so this parser works for either.
                PARTIAL_EVENTS = {"image_generation.partial_image", "image_edit.partial_image"}
                COMPLETED_EVENTS = {"image_generation.completed", "image_edit.completed"}
                if current_event_type in PARTIAL_EVENTS:
                    idx = int(data.get("partial_image_index", 0))
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        path = save_base64_image_named(
                            b64, effective_run_dir, name=f"{node.id}_partial_{idx}"
                        )
                        await _emit(StreamPartialImageEvent(
                            node_id=node.id, partial_index=idx, src=str(path), is_final=False,
                        ))
                elif current_event_type in COMPLETED_EVENTS:
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        final_path = save_base64_image_named(b64, effective_run_dir, name=f"{node.id}_final")
                else:
                    # Unrecognized event — capture for diagnostic error message
                    keys = list(data.keys())[:5] if isinstance(data, dict) else []
                    seen_data_snippets.append(f"event={current_event_type} keys={keys}")
                    logger.warning(
                        "gpt-image-2-edit: unrecognized SSE event type=%r keys=%s",
                        current_event_type, keys,
                    )

    if final_path is None:
        # Include diagnostic info so the user sees what OpenAI actually sent
        diag = f"seen event types: {seen_event_types[:10]}"
        if seen_data_snippets:
            diag += f"; unrecognized: {seen_data_snippets[:5]}"
        raise RuntimeError(f"Image edit stream ended without a final image event. {diag}")
    return {"image": {"type": "Image", "value": str(final_path)}}


async def handle_gpt_image_25_generate(node, inputs, api_keys, emit, run_dir=None):
    return await handle_gpt_image_2_generate(node, inputs, api_keys, emit, run_dir, build_body=build_25_body)


async def handle_gpt_image_25_edit(node, inputs, api_keys, emit, run_dir=None):
    return await handle_gpt_image_2_edit(node, inputs, api_keys, emit, run_dir, build_body=build_25_body)
