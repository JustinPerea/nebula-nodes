"""Nous Portal handler.

Mirrors the OpenRouter handler but pulls auth from the active Hermes profile (then `~/.hermes/auth.json`)
instead of an env-supplied API key. The credential loader pins persisted
destinations to the production Nous inference origin; an explicit secure
`NOUS_INFERENCE_BASE_URL` process override supports staging/tests.

The Nous Portal API is OpenAI-compatible: `/v1/chat/completions`, SSE
streaming with `choices[0].delta.content`, and standard multimodal
`image_url` content blocks. So we can reuse `stream_execute` directly.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.file_access import require_allowed_path
from services.nous_auth import (NousCredentialExpiredError, NousCredentialInvalidError,
                                 NousNotAuthenticatedError, load_nous_credential)
from execution.person_line import as_person_line, with_person_line


def _image_to_content_block(value: Any) -> dict[str, Any] | None:
    """Convert an image input value into a `{"type": "image_url", "image_url": {...}}` block.

    Accepts http(s) URLs, data URIs, and local filesystem paths (which we
    base64-encode before passing). Returns None on anything we can't handle.
    """
    s = str(value)
    if s.startswith(("http://", "https://", "data:")):
        return {"type": "image_url", "image_url": {"url": s}}
    p = Path(s)
    if p.exists() and p.is_file():
        b64 = base64.b64encode(require_allowed_path(p).read_bytes()).decode("ascii")
        suffix = p.suffix.lstrip(".").lower()
        mime = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "gif": "image/gif",
        }.get(suffix, "image/png")
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
    return None


_SIGN_IN = "Run `hermes model` in a terminal, choose Nous Portal, then run the node again."


def _sign_in_line(exc: NousNotAuthenticatedError) -> str | None:
    """The card's line for a Nous Portal run with no usable sign-in."""
    if str(exc).startswith("NOUS_INFERENCE_BASE_URL"):
        return None
    if isinstance(exc, NousCredentialExpiredError):
        return f"Your Nous Portal sign-in has expired. {_SIGN_IN}"
    if isinstance(exc, NousCredentialInvalidError):
        return f"Nous Portal's saved sign-in can't be used. {_SIGN_IN}"
    return f"Nous Portal isn't signed in. {_SIGN_IN}"


async def handle_nous_portal_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],  # unused — auth lives in the Hermes login files
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    try:
        cred = load_nous_credential()
    except NousNotAuthenticatedError as exc:
        # The text names Hermes' files and the last path checked, for agents.
        # The card says how to sign in (a developer's NOUS_INFERENCE_BASE_URL
        # override keeps the general line).
        line = _sign_in_line(exc)
        error = RuntimeError(str(exc))
        raise (with_person_line(error, line) if line else error) from exc

    model = node.params.get("model", "")
    if not model:
        raise as_person_line(ValueError("No model selected — choose one from the Inspector panel"))

    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise as_person_line(ValueError("Messages input is required"))

    text_part = str(messages_input.value)
    content: list[dict[str, Any]] = [{"type": "text", "text": text_part}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for v in values:
            block = _image_to_content_block(v)
            if block is not None:
                content.append(block)

    request_body: dict[str, Any] = {
        "model": str(model),
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    config = StreamConfig(
        url=f"{cred.base_url.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {cred.access_token}",
            "Content-Type": "application/json",
            "X-Title": "Nebula Nodes",
        },
        event_type_filter=None,
        delta_path="choices.0.delta.content",
        timeout=60.0,
        extra_stop_events=set(),
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(
        config=config,
        request_body=request_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    return {"text": {"type": "Text", "value": full_text}}
