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
