from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, poll_until_terminal, _cancel_async_poll
from execution.stream_runner import ReplicateStreamOutputMode, stream_execute_replicate
from services.cancellation import schedule_detached_cancel

REPLICATE_API_BASE = "https://api.replicate.com/v1"


def _infer_data_uri_output(value: str) -> dict[str, Any] | None:
    """Return a typed media port for a well-formed media data URI.

    Some Replicate models return inline artifacts instead of CDN URLs.  These
    must be typed as media here so the execution engine can persist the bytes
    into the run directory before caching, emitting events, and writing the
    manifest.  Unknown/text data URIs stay on the existing Text fallback.
    """
    if not value.startswith("data:"):
        return None

    header, separator, _payload = value.partition(",")
    if not separator:
        return None
    media_type = header[5:].split(";", 1)[0].strip().lower()

    if media_type == "image/svg+xml":
        port_id, port_type = "svg", "SVG"
    elif media_type.startswith("image/"):
        port_id, port_type = "image", "Image"
    elif media_type.startswith("video/"):
        port_id, port_type = "video", "Video"
    elif media_type.startswith("audio/"):
        port_id, port_type = "audio", "Audio"
    elif media_type in {"model/gltf-binary", "model/gltf+json"}:
        port_id, port_type = "mesh", "Mesh"
    else:
        return None

    return {port_id: {"type": port_type, "value": value}}


def _classify_stream_output_prefix(value: str) -> ReplicateStreamOutputMode:
    """Keep possible media data URIs private until their header is conclusive.

    Replicate may split ``data:image/...;base64,`` across multiple ``output`` SSE
    events. Returning ``pending`` for every viable prefix prevents those early
    fragments from being emitted as text. Once the comma completes a recognized
    media data-URI header, ``buffer`` keeps the entire artifact out of stream
    telemetry. Everything else is ordinary text and can stream immediately.
    """
    if not value:
        return "pending"

    if "data:".startswith(value):
        return "pending"
    if not value.startswith("data:"):
        return "text"

    comma_index = value.find(",")
    if comma_index < 0:
        return "pending"

    # The media type lives entirely before the comma. Avoid passing a potentially
    # large base64 payload through the type probe.
    header = value[: comma_index + 1]
    return "buffer" if _infer_data_uri_output(header) is not None else "text"


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
        data_uri_output = _infer_data_uri_output(output)
        if data_uri_output is not None:
            return data_uri_output
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
        if output and isinstance(output[0], str):
            data_uri_output = _infer_data_uri_output(output[0])
            if data_uri_output is not None:
                return data_uri_output
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
    # committing to a poll loop. Replicate may return `urls.stream` for either text
    # token streams or complete inline media artifacts.
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
            # Consume text deltas live, but classify a possible media data URI before
            # emitting anything. This keeps base64 artifacts out of text telemetry while
            # preserving normal text streaming. On cancel, stop the prediction upstream.
            try:
                text = await stream_execute_replicate(
                    stream_url=stream_url,
                    headers={"Authorization": config.headers["Authorization"]},
                    node_id=node.id,
                    emit=emit_fn,
                    classify_output_prefix=_classify_stream_output_prefix,
                )
            except asyncio.CancelledError:
                cancel_url = config.cancel_url_template.format(task_id=task_id)
                schedule_detached_cancel(
                    lambda: _cancel_async_poll(cancel_url, config.cancel_method, config.headers)
                )
                raise
            # Replicate can expose ``urls.stream`` for non-text models too.
            # Flux Schnell, for example, may stream a complete image data URI.
            # Preserve text-model behavior while routing streamed media through
            # the same type inference used by polled predictions so the engine
            # can materialize it into the run directory.
            return _infer_output_type(text)

        # Non-streaming output (images/video/audio/mesh/structured) — poll to terminal.
        result = await poll_until_terminal(client, config, task_id, node.id, emit_fn)

    output = result.get("output")
    if output is None:
        raise RuntimeError("Replicate returned no output")

    return _infer_output_type(output)
