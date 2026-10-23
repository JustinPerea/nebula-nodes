from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, poll_until_terminal, _cancel_async_poll
from execution.stream_runner import ReplicateStreamOutputMode, stream_execute_replicate
from services.cancellation import schedule_detached_cancel
from execution.missing_credential import MissingCredentialError
from services import universal_ports
from services.media_types import MEDIA_PORT_IDS, media_of_value
from execution.person_line import as_person_line, with_person_line

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
            raise as_person_line(RuntimeError(f"No version found for {owner}/{name}"))
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


def _first_value(output: Any) -> Any:
    """The value a run passes on: the output, or a list's first item (a list
    of files returns its first, as _infer_output_type always did)."""
    return output[0] if isinstance(output, list) and output else output


def _fill_declared_port(node: GraphNode, output: Any, task_id: str | None) -> dict[str, Any]:
    """Put a run's output under the port its node declares.

    A node configured for its model (services/universal_ports.py) declares one
    output, typed before the run from the model's metadata, and the engine
    passes outputs between nodes by that handle, so the run fills it:

    - a Text port takes output that names no media type as text (plain text,
      or a URL with no telling extension);
    - a file port takes the returned file when the file's type agrees (or
      can't be told, e.g. a URL with no telling extension);
    - a port typed as a guess (`typeUnconfirmed`: the model's data said
      nothing) takes the file's word for it: a file of another type goes out
      under that type's own port (`video`, `audio`, ...), so a paid result is
      kept and shown, though a wire on the guessed port gets nothing;
    - anything else (a file of another type on a confirmed port, a media
      file on a Text port, text on a file port) fails the run naming both, so
      nothing is passed on silently under a type the next node can't take.

    A node never configured keeps naming its output by the returned file, as
    it always has, and so does a node whose kept ports were written before
    file outputs were typed (#132's stamp: every file `image`): there a
    contradicting file goes out under its own handle as before, and sending
    the model again types the port (universal_ports.untyped_output_stamp)."""
    declared = universal_ports.declared_output(node.definition_id, node.params)
    inferred = _infer_output_type(output)
    if declared is None:
        return inferred
    port_id, port_type = str(declared["id"]), str(declared["dataType"])
    value = _first_value(output)
    is_file = isinstance(value, str) and value.startswith(("http://", "https://", "data:"))
    returned = media_of_value(value) if is_file else None
    if port_type == "Text":
        # Plain text, or a URL that names no media type, is text; a file whose
        # type can be told (a data: URI's MIME type, a URL's extension) is not.
        if returned is None:
            text = output if isinstance(output, str) else next(iter(inferred.values()))["value"]
            return {port_id: {"type": "Text", "value": text}}
    elif is_file and (returned is None or returned == port_type):
        return {port_id: {"type": port_type, "value": value}}
    if universal_ports.untyped_output_stamp(node.definition_id, node.params):
        return inferred
    if declared.get("typeUnconfirmed") and returned:
        # The port was a guess (no hint, no example run); the file says what it is.
        return {MEDIA_PORT_IDS[returned]: {"type": returned, "value": value}}
    model = str(node.params.get("model_id") or "this model")
    what = (f"{'an' if returned[0] in 'AEIOU' else 'a'} {returned} file" if returned else "text (Text), not a file")
    if declared.get("typeUnconfirmed"):
        why = (f"Replicate's data for the model doesn't say what it returns, so Nebula typed that port "
               f"{port_type}, unconfirmed, before the run")
    else:
        why = ("typed from the model's data before the run; if the model changed, pick it again (or set its "
               "model_id again) to re-read its ports")
    where = f" The result is still on Replicate (prediction {task_id})." if task_id else ""
    # The text names the model, the port and the prediction for agents; the
    # card says it in words and names the field to set again.
    got = f"{'an' if returned[0] in 'AEIOU' else 'a'} {returned.lower()} file" if returned else "text"
    line = (f"The model returned {got}, but this node's output is set to {port_type.lower()}, so nothing was "
            "passed on. Pick the model again in the node's Model ID field to re-read its outputs, then run the "
            "node again.")
    raise with_person_line(RuntimeError(
        f"{model} returned {what}, but this node's output `{port_id}` is {port_type} ({why}), so nothing was "
        f"passed on.{where}"), line)


async def handle_replicate_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("REPLICATE_API_TOKEN")
    if not api_key:
        raise MissingCredentialError("REPLICATE_API_TOKEN is required")

    model_id = node.params.get("model_id", "")
    if not model_id or "/" not in str(model_id):
        raise as_person_line(ValueError("Model ID is required (format: owner/name, e.g. stability-ai/sdxl)"))

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
    # `_model_ports` is the canvas's record of the model's ports (services/universal_ports.py).
    INTERNAL_KEYS = {"model_id", "_version_id", "_schema_fetched", "_model_ports"}
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
            return _fill_declared_port(node, text, task_id)

        # Non-streaming output (images/video/audio/mesh/structured) — poll to terminal.
        result = await poll_until_terminal(client, config, task_id, node.id, emit_fn)

    output = result.get("output")
    if output is None:
        raise RuntimeError("Replicate returned no output")

    return _fill_declared_port(node, output, task_id)
