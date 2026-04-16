from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from uuid import uuid4

from services.output import get_run_dir, save_base64_image

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
IMAGEN_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"


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
        raise ValueError("GOOGLE_API_KEY is required")

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
                img_path = Path(img_str)
                if img_path.exists():
                    b64_data = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
                    parts.append({
                        "inline_data": {
                            "mime_type": mime_map.get(suffix, "image/png"),
                            "data": b64_data,
                        }
                    })

    model = node.params.get("model", "gemini-2.5-flash")

    generation_config: dict[str, Any] = {}
    temperature = node.params.get("temperature")
    if temperature is not None:
        generation_config["temperature"] = float(temperature)
    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        generation_config["maxOutputTokens"] = int(max_tokens)

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
        raise ValueError("GOOGLE_API_KEY is required")

    model = node.params.get("model", "gemini-3.1-flash-image-preview")

    contents = [{"parts": [{"text": str(prompt_input.value)}]}]

    # Add images if connected
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://")):
                contents[0]["parts"].append({"fileData": {"fileUri": img_str}})
            else:
                import base64 as _base64
                img_path = Path(img_str)
                if img_path.exists():
                    b64 = _base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix, "image/png")
                    contents[0]["parts"].append({"inlineData": {"mimeType": mime, "data": b64}})

    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
        },
    }

    aspect = node.params.get("aspect_ratio")
    image_size = node.params.get("imageSize")
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


async def handle_imagen4(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required for Imagen 4")

    prompt_text = str(prompt_input.value)

    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY is required")

    model = node.params.get("model", "imagen-4.0-generate-001")

    request_body: dict[str, Any] = {
        "instances": [{"prompt": prompt_text}],
        "parameters": {},
    }

    n = node.params.get("numberOfImages", 1)
    if n:
        request_body["parameters"]["sampleCount"] = int(n)

    aspect_ratio = node.params.get("aspectRatio")
    if aspect_ratio:
        request_body["parameters"]["aspectRatio"] = str(aspect_ratio)

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        request_body["parameters"]["seed"] = int(seed)

    enhance_prompt = node.params.get("enhancePrompt")
    if enhance_prompt:
        request_body["parameters"]["enhancePrompt"] = True

    person_gen = node.params.get("personGeneration")
    if person_gen:
        request_body["parameters"]["personGeneration"] = str(person_gen)

    image_size = node.params.get("imageSize")
    if image_size:
        request_body["parameters"]["imageSize"] = str(image_size)

    url = f"{IMAGEN_BASE_URL}/{model}:predict"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=request_body,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Imagen 4 API error {response.status_code}: {response.text}")

    data = response.json()

    # Response: {"predictions": [{"bytesBase64Encoded": "...", "mimeType": "image/png"}]}
    predictions = data.get("predictions", [])
    if not predictions:
        raise RuntimeError(f"Imagen 4 returned no predictions: {data}")

    first = predictions[0]
    b64_data = first.get("bytesBase64Encoded", "")
    mime_type = first.get("mimeType", "image/png")
    extension = "png" if "png" in mime_type else "jpg"

    run_dir = get_run_dir()
    file_path = save_base64_image(b64_data, run_dir, extension=extension)

    return {
        "image": {
            "type": "Image",
            "value": str(file_path),
        }
    }


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
        raise ValueError("GOOGLE_API_KEY is required")

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
                img_path = Path(img_str)
                if img_path.exists():
                    b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix, "image/png")
                    parts.append({"inlineData": {"mimeType": mime, "data": b64}})

    generation_config: dict[str, Any] = {
        "responseModalities": ["AUDIO", "TEXT"],
    }

    # WAV output for Pro model
    output_format = node.params.get("outputFormat")
    if output_format == "wav" and "pro" in model:
        generation_config["responseMimeType"] = "audio/wav"

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
        raise ValueError("GOOGLE_API_KEY is required")

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
        raise ValueError("GOOGLE_API_KEY is required")

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
        body["output_dimensionality"] = int(output_dim)

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
