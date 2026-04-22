from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir

OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits"
DEFAULT_PARTIAL_IMAGES = 2


def build_generate_body(node: GraphNode, prompt_text: str) -> dict[str, Any]:
    params = node.params or {}
    body: dict[str, Any] = {
        "model": "gpt-image-2",
        "prompt": prompt_text,
        "stream": True,
        "partial_images": int(params.get("partial_images", DEFAULT_PARTIAL_IMAGES)),
    }
    for key in ("size", "quality", "moderation"):
        value = params.get(key)
        if value and value != "auto":
            body[key] = value
    n_value = params.get("n")
    if n_value and int(n_value) > 1:
        body["n"] = int(n_value)
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


async def handle_gpt_image_2_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
    run_dir: Path | None = None,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")
    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    body = build_generate_body(node, prompt_text=str(prompt_input.value))
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
        if "organization_must_be_verified" in msg or "must be verified" in msg.lower():
            raise RuntimeError(
                "Your OpenAI org isn't verified for gpt-image-2. "
                "Visit https://platform.openai.com/settings/organization/general to verify."
            ) from exc
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
) -> dict[str, Any]:
    image_input = inputs.get("image")
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
            f"gpt-image-2 edit accepts up to {MAX_EDIT_IMAGES} input images; got {len(image_paths)}"
        )
    if len(image_paths) == 0:
        raise ValueError("Image input is required but was not provided")

    body = build_generate_body(node, prompt_text=str(prompt_input.value))
    # Edits POST is multipart, not JSON — build separately.
    effective_run_dir = run_dir or get_run_dir()

    # Build multipart form.
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in image_paths:
        p = Path(path)
        files.append(("image[]", (p.name, p.read_bytes(), "image/png")))
    mask_input = inputs.get("mask")
    if mask_input and mask_input.value:
        mp = Path(str(mask_input.value))
        files.append(("mask", (mp.name, mp.read_bytes(), "image/png")))

    form: dict[str, str] = {}
    for key in ("model", "prompt", "size", "quality", "moderation", "output_format"):
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
    final_path: Path | None = None
    current_event_type: str | None = None

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
                if "organization_must_be_verified" in error_body or "must be verified" in error_body.lower():
                    raise RuntimeError(
                        "Your OpenAI org isn't verified for gpt-image-2. "
                        "Visit https://platform.openai.com/settings/organization/general to verify."
                    )
                raise RuntimeError(f"Image edit failed ({response.status_code}): {error_body}")
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    current_event_type = None
                    continue
                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
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
                if current_event_type == "image_generation.partial_image":
                    idx = int(data.get("partial_image_index", 0))
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        path = save_base64_image_named(
                            b64, effective_run_dir, name=f"{node.id}_partial_{idx}"
                        )
                        await _emit(StreamPartialImageEvent(
                            node_id=node.id, partial_index=idx, src=str(path), is_final=False,
                        ))
                elif current_event_type == "image_generation.completed":
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        final_path = save_base64_image_named(b64, effective_run_dir, name=f"{node.id}_final")

    if final_path is None:
        raise RuntimeError("Image edit stream ended without a final image event")
    return {"image": {"type": "Image", "value": str(final_path)}}
