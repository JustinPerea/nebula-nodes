from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from uuid import uuid4

from services.image_input import load_local_image
from services.output import get_run_dir, save_base64_image
from execution.missing_credential import MissingCredentialError

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


async def handle_gemini_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for Gemini chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise MissingCredentialError("GOOGLE_API_KEY is required")

    parts: list[dict[str, Any]] = [{"text": messages_text}]

    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith("data:"):
                # data URI: data:image/png;base64,<data>
                header, b64_data = img_str.split(",", 1)
                mime_type = header.split(":")[1].split(";")[0]
                parts.append({
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": b64_data,
                    }
                })
            elif img_str.startswith(("http://", "https://")):
                parts.append({
                    "file_data": {
                        "file_uri": img_str,
                    }
                })
            else:
                # Local path. load_local_image raises (rather than silently
                # skipping) if the file is missing/unreadable/unsupported, so a
                # misconfigured reference fails the node instead of producing a
                # "success" that quietly analyzed zero of the wired-up images.
                mime_type, b64_data = load_local_image(img_str)
                parts.append({
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": b64_data,
                    }
                })

    model = node.params.get("model", "gemini-3.5-flash")

    generation_config: dict[str, Any] = {}
    temperature = node.params.get("temperature")
    if temperature is not None:
        generation_config["temperature"] = float(temperature)
    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        generation_config["maxOutputTokens"] = int(max_tokens)

    # Structured output: response_format carries the MIME type (e.g. application/json).
    # The node exposed this param but the handler previously ignored it.
    response_format = node.params.get("response_format")
    if response_format and response_format != "text/plain":
        generation_config["responseMimeType"] = response_format

    request_body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
    }
    if generation_config:
        request_body["generationConfig"] = generation_config

    # Thinking control: thinkingLevel for Gemini 3, thinkingBudget for 2.5
    # Cannot use both — API returns 400
    thinking_level = node.params.get("thinkingLevel")
    thinking_budget = node.params.get("thinkingBudget")
    if thinking_level and thinking_level != "":
        request_body["generationConfig"] = request_body.get("generationConfig", {})
        request_body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": thinking_level}
    elif thinking_budget is not None and thinking_budget != "":
        request_body["generationConfig"] = request_body.get("generationConfig", {})
        request_body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": int(thinking_budget)}

    system_prompt = node.params.get("system")
    if system_prompt:
        request_body["systemInstruction"] = {"parts": [{"text": str(system_prompt)}]}

    # Use streaming endpoint with header auth (per Gemini 3 docs)
    url = f"{GEMINI_BASE_URL}/{model}:streamGenerateContent?alt=sse"

    config = StreamConfig(
        url=url,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        event_type_filter=None,  # Gemini SSE has no event type lines
        delta_path="candidates.0.content.parts.0.text",
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


# Google documents Nano Banana 2.1 only on the Interactions API
# (https://ai.google.dev/gemini-api/docs/image-generation, checked 2026-10-10),
# so it doesn't go through generateContent like the older image models.
INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
INTERACTIONS_IMAGE_MODELS = {"gemini-nano-banana-2.1"}
_INTERACTION_SIZES = {"gemini-nano-banana-2.1": {"1K", "2K", "4K"}}
_INTERACTION_ASPECTS = {
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
}


def _interaction_image_part(value: str) -> dict[str, Any]:
    # URLs go to Google as-is (like fileData.fileUri on generateContent), so the
    # backend never fetches a URL a graph hands it.
    if value.startswith(("http://", "https://")):
        return {"type": "image", "uri": value}
    if value.startswith("data:"):
        header, b64 = value.split(",", 1)
        return {"type": "image", "mime_type": header.split(":")[1].split(";")[0], "data": b64}
    mime, b64 = load_local_image(value)
    return {"type": "image", "mime_type": mime, "data": b64}


def _image_from_interaction(data: dict[str, Any]) -> tuple[str | None, str, str | None]:
    """(base64 image, mime type, text) from an Interactions response."""
    image: str | None = None
    mime = "image/png"
    texts: list[str] = []
    for step in data.get("steps", []):
        if step.get("type") != "model_output":
            continue
        for content in step.get("content", []):
            if content.get("type") == "image" and content.get("data"):
                image, mime = str(content["data"]), str(content.get("mime_type") or mime)
            elif content.get("type") == "text" and content.get("text"):
                texts.append(str(content["text"]))
    output = data.get("output_image") or {}
    if image is None and output.get("data"):
        image, mime = str(output["data"]), str(output.get("mime_type") or mime)
    return image, mime, ("\n".join(texts) or None)


async def _nano_banana_interaction(
    node: GraphNode,
    prompt: str,
    inputs: dict[str, PortValueDict],
    api_key: str,
    model: str,
) -> dict[str, Any]:
    response_format: dict[str, Any] = {"type": "image"}
    aspect = str(node.params.get("aspect_ratio") or "")
    if aspect in _INTERACTION_ASPECTS:
        response_format["aspect_ratio"] = aspect
    size = str(node.params.get("imageSize") or "")
    allowed = _INTERACTION_SIZES.get(model, set())
    if size:
        response_format["image_size"] = size if size in allowed else "1K"

    images_input = inputs.get("images")
    parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    if images_input and images_input.value:
        values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        parts.extend(_interaction_image_part(str(value)) for value in values if value)

    async with httpx.AsyncClient(timeout=180.0) as client:
        body: dict[str, Any] = {
            "model": model,
            "input": prompt if len(parts) == 1 else parts,
            "response_format": response_format,
            "store": False,
        }
        response = await client.post(
            INTERACTIONS_URL, json=body,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        )
        if response.status_code != 200:
            raise RuntimeError(f"Gemini API error {response.status_code}: {response.text}")

    image, mime, text = _image_from_interaction(response.json())
    if not image:
        raise RuntimeError("Gemini returned no image")
    ext = "png" if "png" in mime else "jpeg" if "jpeg" in mime else "webp" if "webp" in mime else "png"
    result: dict[str, Any] = {
        "image": {"type": "Image", "value": str(save_base64_image(image, get_run_dir(), extension=ext))},
    }
    if text:
        result["text"] = {"type": "Text", "value": text}
    return result


async def handle_nano_banana(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit=None,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required")

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise MissingCredentialError("GOOGLE_API_KEY is required")

    model = str(node.params.get("model", "gemini-3.1-flash-image"))

    if model in INTERACTIONS_IMAGE_MODELS:
        return await _nano_banana_interaction(node, str(prompt_input.value), inputs, api_key, model)

    contents = [{"parts": [{"text": str(prompt_input.value)}]}]

    # Add images if connected
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://")):
                contents[0]["parts"].append({"fileData": {"fileUri": img_str}})
            elif img_str.startswith("data:"):
                header, b64 = img_str.split(",", 1)
                mime = header.split(":")[1].split(";")[0]
                contents[0]["parts"].append({"inlineData": {"mimeType": mime, "data": b64}})
            else:
                # Local path. load_local_image raises (rather than silently
                # skipping) if the file is missing/unreadable/unsupported.
                mime, b64 = load_local_image(img_str)
                contents[0]["parts"].append({"inlineData": {"mimeType": mime, "data": b64}})

    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
        },
    }

    aspect = str(node.params.get("aspect_ratio") or "")
    image_size = str(node.params.get("imageSize") or "")

    common_aspects = {"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"}
    allowed_aspects = common_aspects | ({"1:4", "4:1", "1:8", "8:1"} if model == "gemini-3.1-flash-image" else set())
    if aspect and aspect not in allowed_aspects:
        aspect = "1:1"

    allowed_sizes = {
        "gemini-3.1-flash-image": {"512", "1K", "2K", "4K"},
        "gemini-3.1-flash-lite-image": {"1K"},
        "gemini-3-pro-image": {"1K", "2K", "4K"},
    }.get(model, set())
    if image_size and image_size not in allowed_sizes:
        image_size = "1K" if allowed_sizes else ""

    if aspect or image_size:
        image_config: dict[str, Any] = {}
        if aspect:
            image_config["aspectRatio"] = aspect
        if image_size:
            image_config["imageSize"] = image_size
        body["generationConfig"]["imageConfig"] = image_config

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, json=body, headers={"x-goog-api-key": api_key})
        if response.status_code != 200:
            raise RuntimeError(f"Gemini API error {response.status_code}: {response.text}")

    data = response.json()
    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])

    result: dict[str, Any] = {}

    for part in parts:
        if "inlineData" in part:
            b64_data = part["inlineData"]["data"]
            mime = part["inlineData"].get("mimeType", "image/png")
            ext = "png" if "png" in mime else "jpeg" if "jpeg" in mime else "webp" if "webp" in mime else "png"
            run_dir = get_run_dir()
            file_path = save_base64_image(b64_data, run_dir, extension=ext)
            result["image"] = {"type": "Image", "value": str(file_path)}
        elif "text" in part:
            result["text"] = {"type": "Text", "value": part["text"]}

    if not result:
        raise RuntimeError("Gemini returned no image or text content")

    return result

async def handle_lyria3(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required for Lyria 3")

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise MissingCredentialError("GOOGLE_API_KEY is required")

    model = node.params.get("model", "lyria-3-clip-preview")

    parts: list[dict[str, Any]] = [{"text": str(prompt_input.value)}]

    # Support image inputs for mood-based music generation
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith("data:"):
                header, b64_data = img_str.split(",", 1)
                mime_type = header.split(":")[1].split(";")[0]
                parts.append({"inlineData": {"mimeType": mime_type, "data": b64_data}})
            elif img_str.startswith(("http://", "https://")):
                parts.append({"fileData": {"fileUri": img_str}})
            else:
                # Local path. load_local_image raises (rather than silently
                # skipping) if the file is missing/unreadable/unsupported.
                mime, b64 = load_local_image(img_str)
                parts.append({"inlineData": {"mimeType": mime, "data": b64}})

    generation_config: dict[str, Any] = {
        "responseModalities": ["AUDIO", "TEXT"],
    }

    # WAV output for Pro model. The mimeType field uses Google's proto enum form
    # (AUDIO_WAV), not the literal mime string "audio/wav" — verified via live API
    # call 2026-05-17 (the proto enum rejected "audio/wav").
    output_format = node.params.get("outputFormat")
    if output_format == "wav" and "pro" in model:
        generation_config["responseFormat"] = {"audio": {"mimeType": "AUDIO_WAV"}}

    body: dict[str, Any] = {
        "contents": [{"parts": parts}],
        "generationConfig": generation_config,
    }

    url = f"{GEMINI_BASE_URL}/{model}:generateContent"

    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Lyria 3 API error {response.status_code}: {response.text}")

    data = response.json()
    resp_parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])

    result: dict[str, Any] = {}
    run_dir = get_run_dir()

    for part in resp_parts:
        if "inlineData" in part:
            b64_audio = part["inlineData"]["data"]
            mime = part["inlineData"].get("mimeType", "audio/mpeg")
            ext = "wav" if "wav" in mime else "mp3"
            audio_bytes = base64.b64decode(b64_audio)
            filename = f"{uuid4().hex[:12]}.{ext}"
            file_path = run_dir / filename
            file_path.write_bytes(audio_bytes)
            result["audio"] = {"type": "Audio", "value": str(file_path)}
        elif "text" in part:
            if "text" in result:
                result["text"]["value"] += "\n" + part["text"]
            else:
                result["text"] = {"type": "Text", "value": part["text"]}

    if not result:
        raise RuntimeError(f"Lyria 3 returned no audio or text content: {data}")

    return result


async def handle_gemini_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required for Gemini TTS")

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise MissingCredentialError("GOOGLE_API_KEY is required")

    model = node.params.get("model", "gemini-2.5-flash-preview-tts")
    voice_name = node.params.get("voiceName", "Kore")

    body: dict[str, Any] = {
        "contents": [{"parts": [{"text": str(text_input.value)}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": voice_name,
                    }
                }
            },
        },
    }

    url = f"{GEMINI_BASE_URL}/{model}:generateContent"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Gemini TTS API error {response.status_code}: {response.text}")

    data = response.json()
    resp_parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])

    for part in resp_parts:
        if "inlineData" in part:
            b64_audio = part["inlineData"]["data"]
            audio_bytes = base64.b64decode(b64_audio)

            # TTS returns raw PCM (24kHz, 16-bit, mono) — wrap in WAV
            import wave
            import io

            run_dir = get_run_dir()
            filename = f"{uuid4().hex[:12]}.wav"
            file_path = run_dir / filename

            with wave.open(str(file_path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes(audio_bytes)

            return {
                "audio": {
                    "type": "Audio",
                    "value": str(file_path),
                }
            }

    raise RuntimeError(f"Gemini TTS returned no audio content: {data}")


async def handle_gemini_embeddings(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    text_input = inputs.get("text")
    if not text_input or not text_input.value:
        raise ValueError("Text input is required for embeddings")

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise MissingCredentialError("GOOGLE_API_KEY is required")

    model = node.params.get("model", "gemini-embedding-001")

    body: dict[str, Any] = {
        "model": f"models/{model}",
        "content": {
            "parts": [{"text": str(text_input.value)}],
        },
    }

    task_type = node.params.get("taskType")
    if task_type:
        body["taskType"] = task_type

    output_dim = node.params.get("outputDimensionality")
    if output_dim:
        body["outputDimensionality"] = int(output_dim)

    url = f"{GEMINI_BASE_URL}/{model}:embedContent"

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Gemini Embeddings API error {response.status_code}: {response.text}")

    data = response.json()
    embedding = data.get("embedding", {})
    values = embedding.get("values", [])

    import json
    return {
        "embedding": {
            "type": "Text",
            "value": json.dumps(values),
        },
        "dimensions": {
            "type": "Text",
            "value": str(len(values)),
        },
    }
