from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, poll_until_terminal, _cancel_async_poll
from execution.stream_runner import stream_execute_replicate
from services.cancellation import schedule_detached_cancel

REPLICATE_API_BASE = "https://api.replicate.com/v1"


async def _resolve_version(owner: str, name: str, api_key: str) -> str:
    """Fetch the latest version ID for a model."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}",
            headers={"Authorization": f"Bearer {api_key}"},
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
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        terminal_success={"succeeded"},
        terminal_failure={"failed", "canceled"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
        timeout=30.0,
        cancel_url_template=f"{REPLICATE_API_BASE}/predictions/{{task_id}}/cancel",
        cancel_method="POST",
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    emit_fn = emit or noop_emit

    # Submit the prediction ourselves so we can detect streaming support before
    # committing to a poll loop. Replicate returns `urls.stream` (an SSE endpoint)
    # only for models that stream token deltas (language models); image/video/audio/
    # mesh models omit it and we poll as before.
    async with httpx.AsyncClient(timeout=config.timeout) as client:
        submit_resp = await client.post(config.submit_url, headers=config.headers, json=submit_body)
        if submit_resp.status_code not in (200, 201):
            raise RuntimeError(f"Replicate submit failed ({submit_resp.status_code}): {submit_resp.text}")

        submit_data = submit_resp.json()
        task_id = submit_data.get("id")
        if not task_id:
            raise RuntimeError(f"Replicate submit returned no prediction id: {submit_data}")
        task_id = str(task_id)
        stream_url = (submit_data.get("urls") or {}).get("stream")

        if stream_url and emit is not None:
            # Streaming-capable text model: consume the SSE token stream live. The
            # frontend already renders StreamDeltaEvent -> node.data.streamingText, so
            # no frontend change is needed. On cancel, stop the prediction upstream.
            try:
                text = await stream_execute_replicate(
                    stream_url=stream_url,
                    headers={"Authorization": config.headers["Authorization"]},
                    node_id=node.id,
                    emit=emit_fn,
                )
            except asyncio.CancelledError:
                cancel_url = config.cancel_url_template.format(task_id=task_id)
                schedule_detached_cancel(
                    lambda: _cancel_async_poll(cancel_url, config.cancel_method, config.headers)
                )
                raise
            return {"text": {"type": "Text", "value": text}}

        # Non-streaming output (images/video/audio/mesh/structured) — poll to terminal.
        result = await poll_until_terminal(client, config, task_id, node.id, emit_fn)

    output = result.get("output")
    if output is None:
        raise RuntimeError("Replicate returned no output")

    return _infer_output_type(output)
