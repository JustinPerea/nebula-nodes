"""Ideogram direct API handlers (api.ideogram.ai).

Direct-route half of the dual-route Ideogram nodes (FAL is the fallback route;
see sync_runner's ideogram routers). All endpoints are SYNCHRONOUS
multipart/form-data POSTs authenticated with an ``Api-Key`` header, and they
return ephemeral image URLs (``ideogram.ai/api/images/ephemeral/...?exp=...``)
that MUST be downloaded immediately — we save them into the run dir before
returning.

Endpoints (verified against developer.ideogram.ai OpenAPI, 2026-06-10):
  - POST /v1/ideogram-v4/generate     (text_prompt, resolution, rendering_speed)
  - POST /v1/ideogram-v4/remix        (image, text_prompt, image_weight, resolution)
  - POST /v1/ideogram-v3/generate     (character_reference_images → Character node path)
  - POST /v1/ideogram-v3/inpaint      (image + mask: BLACK regions = edit)
  - POST /v1/ideogram-v3/reframe      (image + required resolution)
  - POST /v1/ideogram-v3/replace-background
  - POST /upscale                     (image_request JSON blob + image_file)

Direct-vs-FAL param dialects (why directParams/falParams differ in the registry):
  - rendering_speed: direct = TURBO/DEFAULT/QUALITY (FLASH 400s, "coming soon");
    FAL = TURBO/BALANCED/QUALITY.
  - magic prompt: direct = magic_prompt enum AUTO/ON/OFF; FAL = expand_prompt bool.
  - sizing: direct v4 = resolution (2K pixel enum); direct v3 = resolution /
    aspect_ratio; FAL = image_size preset names.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir, save_base64_image

IDEOGRAM_API_BASE = "https://api.ideogram.ai"

_MIME_BY_SUFFIX = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}


def _require_key(api_keys: dict[str, str]) -> str:
    api_key = api_keys.get("IDEOGRAM_API_KEY")
    if not api_key:
        raise ValueError("IDEOGRAM_API_KEY is required")
    return api_key


async def _load_binary(value: str) -> tuple[bytes, str]:
    """Resolve an image reference (data URI / URL / local path) to (bytes, mime)."""
    if value.startswith("data:"):
        header, _, b64_data = value.partition(",")
        mime = header.split(":", 1)[1].split(";", 1)[0] if ":" in header else "image/png"
        return base64.b64decode(b64_data), mime
    if value.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(value, follow_redirects=True)
            resp.raise_for_status()
        mime = resp.headers.get("content-type", "image/png").split(";", 1)[0]
        return resp.content, mime
    path = Path(value)
    if not path.exists():
        raise ValueError(f"Image file not found: {value}")
    mime = _MIME_BY_SUFFIX.get(path.suffix.lstrip(".").lower(), "image/png")
    return path.read_bytes(), mime


async def _file_part(field: str, value: str) -> tuple[str, tuple[str, bytes, str]]:
    """Build one httpx multipart file entry for an image reference."""
    content, mime = await _load_binary(str(value))
    ext = "jpg" if mime == "image/jpeg" else mime.split("/", 1)[-1]
    return (field, (f"{field}.{ext}", content, mime))


async def _multi_file_parts(
    field: str, port: PortValueDict | None
) -> list[tuple[str, tuple[str, bytes, str]]]:
    """Build repeated multipart entries for a multi-image port (or [] when unset)."""
    if not port or not port.value:
        return []
    raw = port.value if isinstance(port.value, list) else [port.value]
    return [await _file_part(field, str(v)) for v in raw if v]


async def _post_multipart(
    path: str,
    api_key: str,
    fields: dict[str, Any],
    files: list[tuple[str, tuple[str, bytes, str]]],
) -> dict[str, Any]:
    """POST a multipart request and return the parsed JSON response.

    Ideogram rejects ``application/x-www-form-urlencoded`` (httpx's default when
    only ``data=`` is passed). Encode scalar fields as multipart text parts so
    text-only endpoints like v4 generate still hit ``multipart/form-data``.
    """
    multipart: list[tuple[str, Any]] = [
        (key, (None, str(value)))
        for key, value in fields.items()
        if value is not None and value != ""
    ]
    multipart.extend(files)
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            f"{IDEOGRAM_API_BASE}{path}",
            headers={"Api-Key": api_key},
            files=multipart or None,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Ideogram API error {resp.status_code}: {resp.text}")
    return resp.json()


async def _save_first_image(result: dict[str, Any]) -> dict[str, Any]:
    """Download the first ephemeral result URL into the run dir and emit the port."""
    entries = result.get("data") or []
    if not entries:
        raise RuntimeError(f"Ideogram returned no images: {list(result.keys())}")
    url = entries[0].get("url")
    if not url:
        raise RuntimeError(f"Ideogram result missing url: {entries[0]}")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
    mime = resp.headers.get("content-type", "image/png").split(";", 1)[0]
    extension = "jpeg" if mime == "image/jpeg" else mime.split("/", 1)[-1] or "png"
    if extension not in ("png", "jpeg", "webp"):
        extension = "png"
    b64_data = base64.b64encode(resp.content).decode("ascii")
    file_path = save_base64_image(b64_data, get_run_dir(), extension=extension)
    return {"image": {"type": "Image", "value": str(file_path)}}


def _required_text(inputs: dict[str, PortValueDict], port: str, label: str) -> str:
    value = inputs.get(port)
    if not value or not value.value:
        raise ValueError(f"{label} input is required")
    return str(value.value)


def _required_image_ref(inputs: dict[str, PortValueDict], port: str, label: str) -> str:
    value = inputs.get(port)
    if not value or not value.value:
        raise ValueError(f"{label} input is required")
    return str(value.value)


def _field(node: GraphNode, fields: dict[str, Any], *keys: str) -> None:
    """Copy set params into the multipart field dict (skipping unset/empty)."""
    for key in keys:
        value = node.params.get(key)
        if value is not None and value != "":
            fields[key] = value


async def handle_ideogram_v4_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"text_prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(node, fields, "resolution", "rendering_speed", "magic_prompt", "num_images", "seed")
    result = await _post_multipart("/v1/ideogram-v4/generate", api_key, fields, [])
    return await _save_first_image(result)


async def handle_ideogram_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """v3 inpaint. Mask convention: BLACK regions are edited (inverse of FLUX Fill)."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(node, fields, "rendering_speed", "magic_prompt", "num_images", "seed")
    files = [
        await _file_part("image", _required_image_ref(inputs, "image", "Base Image")),
        await _file_part("mask", _required_image_ref(inputs, "mask", "Mask")),
    ]
    files += await _multi_file_parts("style_reference_images", inputs.get("images"))
    result = await _post_multipart("/v1/ideogram-v3/inpaint", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_remix(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Direct remix rides the V4 model (mirrors v3 semantics; image_weight = resemblance)."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"text_prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(node, fields, "image_weight", "resolution", "rendering_speed")
    files = [await _file_part("image", _required_image_ref(inputs, "image", "Source Image"))]
    result = await _post_multipart("/v1/ideogram-v4/remix", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_reframe(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = _require_key(api_keys)
    resolution = node.params.get("resolution")
    if not resolution:
        raise ValueError("resolution is required for Ideogram Reframe (direct route)")
    fields: dict[str, Any] = {"resolution": resolution}
    _field(node, fields, "rendering_speed", "num_images", "seed")
    files = [await _file_part("image", _required_image_ref(inputs, "image", "Source Image"))]
    files += await _multi_file_parts("style_reference_images", inputs.get("images"))
    result = await _post_multipart("/v1/ideogram-v3/reframe", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_replace_background(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"prompt": _required_text(inputs, "prompt", "New Background")}
    _field(node, fields, "magic_prompt", "rendering_speed", "num_images", "seed")
    files = [await _file_part("image", _required_image_ref(inputs, "image", "Subject Image"))]
    files += await _multi_file_parts("style_reference_images", inputs.get("images"))
    result = await _post_multipart("/v1/ideogram-v3/replace-background", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_character(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Consistent character via v3 generate + character_reference_images.

    Expects `inputs` to already be Character-bundle-expanded (the sync_runner
    router calls expand_character_inputs for BOTH routes); reads the
    reference_images port as the final character-reference list.
    """
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(
        node, fields,
        "aspect_ratio", "style_type", "magic_prompt", "negative_prompt",
        "rendering_speed", "num_images", "seed", "custom_model_uri",
    )
    files = await _multi_file_parts("character_reference_images", inputs.get("reference_images"))
    if not files:
        raise ValueError("Character Refs input is required (connect images or a Character node)")
    files += await _multi_file_parts("style_reference_images", inputs.get("images"))
    result = await _post_multipart("/v1/ideogram-v3/generate", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_upscale(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Legacy /upscale endpoint: an image_request JSON blob + the image binary."""
    api_key = _require_key(api_keys)
    request_blob: dict[str, Any] = {}
    for key, blob_key in (
        ("resemblance", "resemblance"),
        ("detail", "detail"),
        ("magic_prompt", "magic_prompt_option"),
        ("seed", "seed"),
    ):
        value = node.params.get(key)
        if value is not None and value != "":
            request_blob[blob_key] = value
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        request_blob["prompt"] = str(prompt_input.value)
    files = [
        ("image_file", (await _file_part("image_file", _required_image_ref(inputs, "image", "Image")))[1]),
    ]
    fields = {"image_request": json.dumps(request_blob)}
    result = await _post_multipart("/upscale", api_key, fields, files)
    return await _save_first_image(result)


# ---------------------------------------------------------------------------
# Character-bundle expansion (shared by BOTH routes via the sync_runner router)
# ---------------------------------------------------------------------------

# Ideogram caps character references by total size (10MB), not a published
# count; 10 is a generous guardrail that still catches runaway wiring.
IDEOGRAM_CHARACTER_MAX_REFS = 10


def expand_character_inputs(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
) -> dict[str, PortValueDict]:
    """Fold an attached CharacterBundle into the ideogram-character inputs.

    Uses cinema.identity.expand_character (the single identity-correctness
    implementation: trait string VERBATIM first, stored views first, per-use
    overrides appended) and rewrites the `prompt` + `reference_images` ports so
    both the direct handler and the FAL payload builder see plain ports.
    The bundle seed is applied to node.params only when the user left seed unset.
    """
    character_input = inputs.get("character")
    bundle = character_input.value if character_input and character_input.value else None
    if not bundle:
        return inputs

    from cinema.identity import expand_character

    prompt_input = inputs.get("prompt")
    base_prompt = str(prompt_input.value) if prompt_input and prompt_input.value else ""

    refs_input = inputs.get("reference_images")
    port_refs: list[str] = []
    if refs_input and refs_input.value:
        raw = refs_input.value if isinstance(refs_input.value, list) else [refs_input.value]
        port_refs = [str(v) for v in raw if v]

    expanded = expand_character(
        bundle, base_prompt, port_refs, model_max_refs=IDEOGRAM_CHARACTER_MAX_REFS
    )

    new_inputs = dict(inputs)
    new_inputs["prompt"] = PortValueDict(type="Text", value=expanded["prompt"])
    new_inputs["reference_images"] = PortValueDict(type="Image", value=expanded["image_urls"])

    if expanded.get("seed") is not None and not node.params.get("seed"):
        node.params["seed"] = expanded["seed"]

    return new_inputs


# ---------------------------------------------------------------------------
# Direct-only capabilities (no FAL equivalents): describe, magic prompt,
# transparent generation, remove background, layerize text, prompt-based edit,
# and custom model training. All verified against developer.ideogram.ai
# openapi.json on 2026-06-10.
# ---------------------------------------------------------------------------


async def _post_json(path: str, api_key: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST an application/json request (magic-prompt, datasets, train-model)."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{IDEOGRAM_API_BASE}{path}",
            headers={"Api-Key": api_key, "Content-Type": "application/json"},
            json=body,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Ideogram API error {resp.status_code}: {resp.text}")
    return resp.json()


def _json_prompt_outputs(json_prompt: dict[str, Any]) -> dict[str, Any]:
    """Split a V4JsonPrompt into a readable description + the raw JSON contract."""
    high_level = str(json_prompt.get("high_level_description") or "").strip()
    style = str(json_prompt.get("style_description") or "").strip()
    description = ". ".join(part for part in (high_level, style) if part)
    return {
        "description": {"type": "Text", "value": description},
        "json_prompt": {"type": "Text", "value": json.dumps(json_prompt, ensure_ascii=False)},
    }


async def handle_ideogram_describe(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """v4 describe: image -> V4JsonPrompt (caption + style + composition)."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {}
    include_bbox = node.params.get("include_bbox")
    if include_bbox is not None and include_bbox != "":
        fields["include_bbox"] = "true" if include_bbox else "false"
    files = [
        ("image_file", (await _file_part("image_file", _required_image_ref(inputs, "image", "Image")))[1]),
    ]
    result = await _post_multipart("/v1/ideogram-v4/describe", api_key, fields, files)
    json_prompt = result.get("json_prompt") or {}
    if not json_prompt:
        raise RuntimeError(f"Ideogram describe returned no json_prompt: {list(result.keys())}")
    return _json_prompt_outputs(json_prompt)


async def handle_ideogram_magic_prompt(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """v4 magic prompt: text -> expanded V4JsonPrompt (the structured 4.0 contract)."""
    api_key = _require_key(api_keys)
    body: dict[str, Any] = {"text_prompt": _required_text(inputs, "prompt", "Prompt")}
    aspect_ratio = node.params.get("aspect_ratio")
    if aspect_ratio:
        body["aspect_ratio"] = aspect_ratio
    result = await _post_json("/v1/ideogram-v4/magic-prompt", api_key, body)
    json_prompt = result.get("json_prompt") or {}
    if not json_prompt:
        raise RuntimeError(f"Ideogram magic-prompt returned no json_prompt: {list(result.keys())}")
    return _json_prompt_outputs(json_prompt)


async def handle_ideogram_transparent(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """v3 generate-transparent: prompt -> PNG with a transparent background."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(
        node, fields,
        "aspect_ratio", "upscale_factor", "rendering_speed", "magic_prompt",
        "negative_prompt", "num_images", "seed",
    )
    result = await _post_multipart("/v1/ideogram-v3/generate-transparent", api_key, fields, [])
    return await _save_first_image(result)


async def handle_ideogram_remove_background(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = _require_key(api_keys)
    files = [await _file_part("image", _required_image_ref(inputs, "image", "Image"))]
    result = await _post_multipart("/v1/remove-background", api_key, {}, files)
    return await _save_first_image(result)


async def handle_ideogram_layerize(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Layerize Text: strips rendered text from an image and returns the clean
    base plate (the editable text layers live in Ideogram's own editor)."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {}
    _field(node, fields, "seed")
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        fields["prompt"] = str(prompt_input.value)
    files = [await _file_part("image", _required_image_ref(inputs, "image", "Image"))]
    result = await _post_multipart("/v1/ideogram-v3/layerize-text", api_key, fields, files)
    base_url = result.get("base_image_url")
    if not base_url:
        raise RuntimeError(f"Ideogram layerize returned no base_image_url: {list(result.keys())}")
    return await _save_first_image({"data": [{"url": base_url}]})


async def handle_ideogram_edit_prompt(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """/v1/edit: maskless, prompt-driven editing of one or more images."""
    api_key = _require_key(api_keys)
    fields: dict[str, Any] = {"prompt": _required_text(inputs, "prompt", "Prompt")}
    _field(node, fields, "magic_prompt", "aspect_ratio", "num_images", "seed")
    transparent = node.params.get("transparent_background")
    if transparent is not None and transparent != "":
        fields["transparent_background"] = "true" if transparent else "false"
    files = await _multi_file_parts("images", inputs.get("images"))
    single = inputs.get("image")
    if single and single.value:
        files = [await _file_part("images", str(single.value))] + files
    if not files:
        raise ValueError("Image input is required (connect Image or Images)")
    result = await _post_multipart("/v1/edit", api_key, fields, files)
    return await _save_first_image(result)


async def handle_ideogram_train_model(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Custom model training: create dataset -> upload assets -> train -> poll.

    Emits progress while polling GET /models/{model_id} until the model reaches
    COMPLETED (or fails on ERRORED/ARCHIVED). Outputs the model id and the
    custom_model_uri consumable by ideogram-character's Custom Model URI param.
    """
    import asyncio

    from models.events import ProgressEvent

    api_key = _require_key(api_keys)
    model_name = str(node.params.get("model_name") or "").strip()
    if not model_name:
        raise ValueError("model_name is required for Ideogram model training")

    images_input = inputs.get("images")
    if not images_input or not images_input.value:
        raise ValueError("Training images are required")
    raw = images_input.value if isinstance(images_input.value, list) else [images_input.value]
    refs = [str(v) for v in raw if v]
    if not refs:
        raise ValueError("Training images are required")

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    # 1. Create the dataset.
    dataset = await _post_json("/datasets", api_key, {"name": model_name})
    dataset_id = dataset.get("dataset_id")
    if not dataset_id:
        raise RuntimeError(f"Ideogram dataset creation failed: {dataset}")

    # 2. Upload the training assets (repeated `files` parts).
    files = [await _file_part("files", ref) for ref in refs]
    upload = await _post_multipart(f"/datasets/{dataset_id}/upload_assets", api_key, {}, files)
    if upload.get("success_count", 0) == 0:
        raise RuntimeError(f"Ideogram asset upload failed: {upload}")

    # 3. Start training.
    train = await _post_json(
        "/v1/ideogram-v3/train-model", api_key,
        {"dataset_id": dataset_id, "model_name": model_name},
    )
    model_id = train.get("model_id")
    if not model_id:
        raise RuntimeError(f"Ideogram training start failed: {train}")

    # 4. Poll until COMPLETED (statuses: CREATING/DRAFT/TRAINING/COMPLETED/ERRORED/ARCHIVED).
    max_polls = 360
    poll_interval = 30.0
    async with httpx.AsyncClient(timeout=60.0) as client:
        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)
            resp = await client.get(
                f"{IDEOGRAM_API_BASE}/models/{model_id}", headers={"Api-Key": api_key}
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Ideogram model poll failed ({resp.status_code}): {resp.text}")
            model = (resp.json() or {}).get("model") or {}
            status = model.get("status", "")
            await _emit(ProgressEvent(node_id=node.id, value=min(poll_num / max_polls, 0.99)))
            if status == "COMPLETED" and model.get("is_available_for_generation"):
                return {
                    "model_id": {"type": "Text", "value": str(model_id)},
                    "custom_model_uri": {"type": "Text", "value": str(model.get("custom_model_uri") or "")},
                }
            if status in ("ERRORED", "ARCHIVED"):
                raise RuntimeError(f"Ideogram training failed: status={status}")

    raise RuntimeError(f"Ideogram training timed out after {max_polls} polls")
