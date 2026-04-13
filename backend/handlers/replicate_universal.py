from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.output import get_run_dir, save_base64_image

REPLICATE_API_BASE = "https://api.replicate.com/v1"


async def _resolve_version(owner: str, name: str, api_key: str) -> str:
    """Fetch the latest version ID for a model."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}",
            headers={"Authorization": f"Token {api_key}"},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to fetch Replicate model {owner}/{name}: {resp.status_code} {resp.text}")
        data = resp.json()
        version_id = data.get("latest_version", {}).get("id")
        if not version_id:
            raise RuntimeError(f"No version found for {owner}/{name}")
        return str(version_id)


def _infer_output_type(output: Any) -> dict[str, Any]:
    """Infer the output port type from a Replicate prediction result.

    Replicate outputs vary wildly:
    - Single URL string: usually an image or file
    - List of URL strings: multiple images
    - Plain string: text output
    - Dict: structured output
    """
    if isinstance(output, str):
        if output.startswith(("http://", "https://")):
            # URL — likely an image or file
            lower = output.lower()
            if any(ext in lower for ext in [".png", ".jpg", ".jpeg", ".webp", ".gif"]):
                return {"image": {"type": "Image", "value": output}}
            elif any(ext in lower for ext in [".mp4", ".mov", ".webm"]):
                return {"video": {"type": "Video", "value": output}}
            elif any(ext in lower for ext in [".mp3", ".wav", ".flac"]):
                return {"audio": {"type": "Audio", "value": output}}
            else:
                return {"image": {"type": "Image", "value": output}}
        return {"text": {"type": "Text", "value": output}}

    if isinstance(output, list):
        if output and isinstance(output[0], str) and output[0].startswith(("http://", "https://")):
            # List of URLs — return first as primary output
            return {"image": {"type": "Image", "value": output[0]}}
        return {"text": {"type": "Text", "value": str(output)}}

    return {"text": {"type": "Text", "value": str(output)}}


async def handle_replicate_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("REPLICATE_API_TOKEN")
    if not api_key:
        raise ValueError("REPLICATE_API_TOKEN is required")

    model_id = node.params.get("model_id", "")
    if not model_id or "/" not in str(model_id):
        raise ValueError("Model ID is required (format: owner/name, e.g. stability-ai/sdxl)")

    owner, name = str(model_id).split("/", 1)

    # Resolve version
    version_id = node.params.get("_version_id", "")
    if not version_id:
        version_id = await _resolve_version(owner, name, api_key)

    # Build input dict from node params and connected inputs
    prediction_input: dict[str, Any] = {}

    # Map connected inputs to prediction input
    for input_key, input_val in inputs.items():
        if input_val.value is not None:
            prediction_input[input_key] = input_val.value

    # Map node params (excluding our internal keys) to prediction input
    INTERNAL_KEYS = {"model_id", "_version_id", "_schema_fetched"}
    for param_key, param_val in node.params.items():
        if param_key not in INTERNAL_KEYS and param_val is not None and param_val != "":
            prediction_input[param_key] = param_val

    submit_body: dict[str, Any] = {
        "version": version_id,
        "input": prediction_input,
    }

    config = AsyncPollConfig(
        submit_url=f"{REPLICATE_API_BASE}/predictions",
        poll_url_template=f"{REPLICATE_API_BASE}/predictions/{{task_id}}",
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
        },
        terminal_success={"succeeded"},
        terminal_failure={"failed", "canceled"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
        timeout=30.0,
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output = result.get("output")
    if output is None:
        raise RuntimeError("Replicate returned no output")

    return _infer_output_type(output)
