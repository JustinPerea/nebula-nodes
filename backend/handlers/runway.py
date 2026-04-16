from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.output import get_run_dir, save_video_from_url, save_base64_image, image_to_data_uri

import base64
import httpx

RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1"
RUNWAY_HEADERS_BASE = {
    "Content-Type": "application/json",
    "X-Runway-Version": "2024-11-06",
}

# Models that support text-to-video (no image required)
TEXT_TO_VIDEO_MODELS = {"gen4.5", "veo3.1", "veo3.1_fast", "veo3"}


def _runway_headers(api_key: str) -> dict[str, str]:
    return {**RUNWAY_HEADERS_BASE, "Authorization": f"Bearer {api_key}"}


def _runway_poll_config(api_key: str, submit_url: str) -> AsyncPollConfig:
    return AsyncPollConfig(
        submit_url=submit_url,
        poll_url_template=f"{RUNWAY_API_BASE}/tasks/{{task_id}}",
        headers=_runway_headers(api_key),
        terminal_success={"SUCCEEDED"},
        terminal_failure={"FAILED"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
    )


async def _resolve_image(image_value: str) -> str:
    """Convert a local file path to a data URI if needed."""
    if image_value.startswith(("http://", "https://", "data:")):
        return image_value
    image_path = Path(image_value)
    if not image_path.exists():
        raise ValueError(f"Image file not found: {image_value}")
    return image_to_data_uri(image_path)


async def handle_runway_video(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    model = node.params.get("model", "gen4.5")
    duration = int(node.params.get("duration", 5))
    ratio = node.params.get("ratio", "1280:720")

    prompt_input = inputs.get("prompt")
    prompt_text = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    image_input = inputs.get("image")
    has_image = image_input and image_input.value

    # Decide endpoint based on whether an image is provided
    if has_image:
        image_value = await _resolve_image(str(image_input.value))
        submit_body: dict[str, Any] = {
            "model": model,
            "promptImage": image_value,
            "duration": duration,
            "ratio": ratio,
        }
        if prompt_text:
            submit_body["promptText"] = prompt_text[:1000]
        endpoint = f"{RUNWAY_API_BASE}/image_to_video"
    else:
        if not prompt_text:
            raise ValueError("Either an image or a text prompt is required")
        if model not in TEXT_TO_VIDEO_MODELS:
            raise ValueError(f"Model '{model}' requires an image input. Use gen4.5, veo3.1, veo3.1_fast, or veo3 for text-only.")
        TEXT_ONLY_RATIOS = {"1280:720", "720:1280"}
        if ratio not in TEXT_ONLY_RATIOS:
            raise ValueError(f"Text-only mode only supports 1280:720 and 720:1280 ratios. Got '{ratio}'. Connect an image to use other ratios.")
        submit_body = {
            "model": model,
            "promptText": prompt_text[:1000],
            "duration": duration,
            "ratio": ratio,
        }
        endpoint = f"{RUNWAY_API_BASE}/text_to_video"

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, endpoint)

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def handle_runway_aleph(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    video_input = inputs.get("video")
    if not video_input or not video_input.value:
        raise ValueError("Video input is required for Aleph")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Text prompt is required for Aleph")

    video_value = str(video_input.value)
    # Convert local video files to data URIs
    if not video_value.startswith(("http://", "https://", "data:")):
        video_path = Path(video_value)
        if not video_path.exists():
            raise ValueError(f"Video file not found: {video_value}")
        b64 = base64.b64encode(video_path.read_bytes()).decode("ascii")
        video_value = f"data:video/mp4;base64,{b64}"

    submit_body: dict[str, Any] = {
        "model": "gen4_aleph",
        "videoUri": video_value,
        "promptText": str(prompt_input.value)[:1000],
    }

    # Optional reference image
    ref_image_input = inputs.get("reference")
    if ref_image_input and ref_image_input.value:
        ref_uri = await _resolve_image(str(ref_image_input.value))
        submit_body["references"] = [{"type": "image", "uri": ref_uri}]

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/video_to_video")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Aleph returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def handle_runway_image(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Text prompt is required for Runway Image")

    model = node.params.get("model", "gen4_image")
    ratio = node.params.get("ratio", "1360:768")

    submit_body: dict[str, Any] = {
        "model": model,
        "promptText": str(prompt_input.value)[:1000],
        "ratio": ratio,
    }

    # Optional reference images (1-3)
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        ref_images = []
        for img in image_values[:3]:
            uri = await _resolve_image(str(img))
            ref_images.append({"uri": uri})
        if ref_images:
            submit_body["referenceImages"] = ref_images

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/text_to_image")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Image returned no output URLs")

    image_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    # Download image
    run_dir = get_run_dir()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(image_url, follow_redirects=True)
        resp.raise_for_status()
    b64_data = base64.b64encode(resp.content).decode("ascii")
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {"image": {"type": "Image", "value": str(file_path)}}


async def handle_runway_act_two(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    # Character: image or video
    char_image_input = inputs.get("character_image")
    char_video_input = inputs.get("character_video")

    if char_image_input and char_image_input.value:
        char_uri = await _resolve_image(str(char_image_input.value))
        character = {"type": "image", "uri": char_uri}
    elif char_video_input and char_video_input.value:
        v = str(char_video_input.value)
        if not v.startswith(("http://", "https://", "data:")):
            p = Path(v)
            if not p.exists():
                raise ValueError(f"Video file not found: {v}")
            v = f"data:video/mp4;base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"
        character = {"type": "video", "uri": v}
    else:
        raise ValueError("Character image or video is required")

    # Reference performance video
    ref_input = inputs.get("reference")
    if not ref_input or not ref_input.value:
        raise ValueError("Reference performance video is required")

    ref_value = str(ref_input.value)
    if not ref_value.startswith(("http://", "https://", "data:")):
        p = Path(ref_value)
        if not p.exists():
            raise ValueError(f"Reference video not found: {ref_value}")
        ref_value = f"data:video/mp4;base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"

    submit_body: dict[str, Any] = {
        "model": "act_two",
        "character": character,
        "reference": {"type": "video", "uri": ref_value},
    }

    ratio = node.params.get("ratio")
    if ratio:
        submit_body["ratio"] = ratio

    body_control = node.params.get("bodyControl")
    if body_control is not None:
        submit_body["bodyControl"] = bool(body_control)

    expression = node.params.get("expressionIntensity")
    if expression is not None and expression != "":
        submit_body["expressionIntensity"] = int(expression)

    seed = node.params.get("seed")
    if seed is not None and seed != "":
        submit_body["seed"] = int(seed)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/character_performance")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Act-Two returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {"video": {"type": "Video", "value": str(video_path)}}


async def _save_audio_from_url(url: str) -> str:
    """Download audio from URL and save locally."""
    from uuid import uuid4
    run_dir = get_run_dir()
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
    filename = f"{uuid4().hex[:12]}.mp3"
    file_path = run_dir / filename
    file_path.write_bytes(resp.content)
    return str(file_path)


async def handle_runway_tts(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    prompt_input = inputs.get("text")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Text input is required")

    voice_id = node.params.get("voiceId", "Maya")

    submit_body: dict[str, Any] = {
        "model": "eleven_multilingual_v2",
        "promptText": str(prompt_input.value)[:1000],
        "voice": {
            "type": "runway-preset",
            "presetId": voice_id,
        },
    }

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/text_to_speech")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway TTS returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_runway_speech_to_speech(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    audio_input = inputs.get("audio")
    video_input = inputs.get("video")

    if audio_input and audio_input.value:
        media_value = str(audio_input.value)
        if not media_value.startswith(("http://", "https://", "data:")):
            p = Path(media_value)
            if not p.exists():
                raise ValueError(f"Audio file not found: {media_value}")
            media_value = f"data:audio/mpeg;base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"
        media = {"type": "audio", "uri": media_value}
    elif video_input and video_input.value:
        media_value = str(video_input.value)
        if not media_value.startswith(("http://", "https://", "data:")):
            p = Path(media_value)
            if not p.exists():
                raise ValueError(f"Video file not found: {media_value}")
            media_value = f"data:video/mp4;base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"
        media = {"type": "video", "uri": media_value}
    else:
        raise ValueError("Audio or video input is required")

    voice_id = node.params.get("voiceId", "Maya")

    submit_body: dict[str, Any] = {
        "model": "eleven_multilingual_sts_v2",
        "media": media,
        "voice": {
            "type": "runway-preset",
            "presetId": voice_id,
        },
    }

    remove_noise = node.params.get("removeBackgroundNoise")
    if remove_noise is not None:
        submit_body["removeBackgroundNoise"] = bool(remove_noise)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/speech_to_speech")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway STS returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}


async def handle_runway_voice_dubbing(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    audio_input = inputs.get("audio")
    if not audio_input or not audio_input.value:
        raise ValueError("Audio input is required for voice dubbing")

    audio_value = str(audio_input.value)
    if not audio_value.startswith(("http://", "https://", "data:")):
        p = Path(audio_value)
        if not p.exists():
            raise ValueError(f"Audio file not found: {audio_value}")
        audio_value = f"data:audio/mpeg;base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"

    target_lang = node.params.get("targetLang", "es")

    submit_body: dict[str, Any] = {
        "model": "eleven_voice_dubbing",
        "audioUri": audio_value,
        "targetLang": target_lang,
    }

    disable_cloning = node.params.get("disableVoiceCloning")
    if disable_cloning is not None:
        submit_body["disableVoiceCloning"] = bool(disable_cloning)

    drop_bg = node.params.get("dropBackgroundAudio")
    if drop_bg is not None:
        submit_body["dropBackgroundAudio"] = bool(drop_bg)

    num_speakers = node.params.get("numSpeakers")
    if num_speakers is not None and num_speakers != "":
        submit_body["numSpeakers"] = int(num_speakers)

    config = _runway_poll_config(api_key, f"{RUNWAY_API_BASE}/voice_dubbing")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway Voice Dubbing returned no output URLs")

    audio_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)
    file_path = await _save_audio_from_url(audio_url)

    return {"audio": {"type": "Audio", "value": file_path}}
