from __future__ import annotations

import asyncio
import base64
import mimetypes
import re
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4
from urllib.parse import urlparse

import httpx

from models.events import ExecutionEvent, ProgressEvent
from models.graph import GraphNode, PortValueDict
from services.cancellation import schedule_detached_cancel
from services.output import OUTPUT_ROOT, get_run_dir

KREA_BASE_URL = "https://api.krea.ai"
KREA_STATUS_PENDING = {
    "backlogged",
    "queued",
    "scheduled",
    "processing",
    "sampling",
    "intermediate-complete",
}
KREA_STATUS_TERMINAL = {"completed", "failed", "cancelled"}
KREA_VARIANTS = {"medium", "large"}
KREA_ASPECT_RATIOS = {"1:1", "4:3", "3:2", "16:9", "2.35:1", "4:5", "2:3", "9:16"}
KREA_CREATIVITY = {"raw", "low", "medium", "high"}
KREA_STYLE_TRAINING_MODELS_WITH_FULL_KNOBS = {"flux_dev", "flux_schnell", "wan", "wan22"}
KREA_STYLE_TRAINING_MODELS_SIMPLE = {"qwen", "z-image"}

_OUTPUTS_URL_PREFIX = "/api/outputs/"
_DATA_URI_RE = re.compile(r"^data:(?P<mime>[^;,]+);base64,(?P<data>.*)$", re.DOTALL)


def _api_key(api_keys: dict[str, str]) -> str:
    key = api_keys.get("KREA_API_TOKEN") or api_keys.get("KREA_API_KEY")
    if not key:
        raise ValueError("KREA_API_TOKEN is required")
    return key


def _auth_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def _json_headers(api_key: str) -> dict[str, str]:
    return {**_auth_headers(api_key), "Content-Type": "application/json", "Accept": "application/json"}


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _port_values(port: PortValueDict | None) -> list[Any]:
    if not port or port.value is None:
        return []
    return _as_list(port.value)


def _clean_str(value: Any) -> str:
    return str(value or "").strip()


def _float_value(value: Any, default: float, min_value: float, max_value: float) -> float:
    if value is None or value == "":
        parsed = default
    else:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
    return max(min_value, min(max_value, parsed))


def _int_value(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    if value is None or value == "":
        parsed = default
    else:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
    if min_value is not None:
        parsed = max(min_value, parsed)
    if max_value is not None:
        parsed = min(max_value, parsed)
    return parsed


def _resolve_local_path(value: str) -> Path | None:
    if not value or value.startswith(("http://", "https://", "data:")):
        return None
    if value.startswith(_OUTPUTS_URL_PREFIX):
        rel = value[len(_OUTPUTS_URL_PREFIX):]
        candidate = (OUTPUT_ROOT / rel).resolve()
        try:
            candidate.relative_to(OUTPUT_ROOT.resolve())
        except ValueError:
            return None
        return candidate if candidate.exists() else None
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = (OUTPUT_ROOT / candidate).resolve()
        try:
            candidate.relative_to(OUTPUT_ROOT.resolve())
        except ValueError:
            return None
    return candidate if candidate.exists() else None


def _mime_for_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _extension_for_mime(mime: str) -> str:
    if "jpeg" in mime or "jpg" in mime:
        return "jpg"
    if "webp" in mime:
        return "webp"
    if "gif" in mime:
        return "gif"
    if "png" in mime:
        return "png"
    return "bin"


def _extension_for_url_or_type(url: str, content_type: str | None) -> str:
    if content_type:
        ext = _extension_for_mime(content_type.split(";")[0].strip())
        if ext != "bin":
            return ext
    suffix = Path(urlparse(url).path).suffix.lstrip(".").lower()
    if suffix in {"png", "jpg", "jpeg", "webp", "gif"}:
        return "jpg" if suffix == "jpeg" else suffix
    return "png"


def _raise_for_krea_response(response: httpx.Response, action: str) -> None:
    if 200 <= response.status_code < 300:
        return
    detail = ""
    try:
        payload = response.json()
        detail = str(payload.get("error") or payload.get("message") or payload)
    except Exception:
        detail = response.text
    if response.status_code == 402:
        detail = detail or "Krea API balance is depleted"
    raise RuntimeError(f"Krea {action} failed ({response.status_code}): {detail}")


async def _upload_asset(
    client: httpx.AsyncClient,
    api_key: str,
    image_value: Any,
    *,
    description: str | None = None,
) -> str:
    if isinstance(image_value, dict):
        image_value = image_value.get("url") or image_value.get("image_url") or image_value.get("value")
    raw = _clean_str(image_value)
    if not raw:
        raise ValueError("Krea asset upload needs an image value")

    data_uri = _DATA_URI_RE.match(raw)
    if data_uri:
        mime = data_uri.group("mime")
        payload = base64.b64decode(data_uri.group("data"))
        filename = f"krea-upload.{_extension_for_mime(mime)}"
    else:
        path = _resolve_local_path(raw)
        if path is None:
            raise ValueError(f"Krea image reference is not a URL or local file: {raw}")
        mime = _mime_for_path(path)
        payload = path.read_bytes()
        filename = path.name

    files = {"file": (filename, payload, mime)}
    form_data = {"description": description} if description else None
    response = await client.post(
        f"{KREA_BASE_URL}/assets",
        headers=_auth_headers(api_key),
        files=files,
        data=form_data,
    )
    _raise_for_krea_response(response, "asset upload")
    asset = response.json()
    image_url = asset.get("image_url")
    if not image_url:
        raise RuntimeError(f"Krea asset upload returned no image_url: {asset}")
    return str(image_url)


async def _image_value_to_url(
    client: httpx.AsyncClient,
    api_key: str,
    image_value: Any,
    *,
    description: str | None = None,
) -> str:
    if isinstance(image_value, dict):
        direct_url = image_value.get("url") or image_value.get("image_url")
        if isinstance(direct_url, str) and direct_url.startswith(("http://", "https://")):
            return direct_url
        image_value = direct_url or image_value.get("image") or image_value.get("value") or image_value
    raw = _clean_str(image_value)
    if raw.startswith(("http://", "https://")):
        return raw
    return await _upload_asset(client, api_key, image_value, description=description)


async def _download_image(client: httpx.AsyncClient, url: str) -> Path:
    response = await client.get(url, timeout=120.0)
    response.raise_for_status()
    run_dir = get_run_dir()
    content_type = response.headers.get("Content-Type")
    ext = _extension_for_url_or_type(url, content_type)
    file_path = run_dir / f"{uuid4().hex[:12]}.{ext}"
    file_path.write_bytes(response.content)
    return file_path


def _result_urls(job: dict[str, Any]) -> list[str]:
    result = job.get("result")
    if not isinstance(result, dict):
        return []
    urls = result.get("urls")
    if not isinstance(urls, list):
        return []
    return [str(url) for url in urls if url]


async def _cancel_krea_job(job_id: str, api_key: str) -> None:
    """Best-effort: DELETE the job so a running Krea job stops on their side instead of
    running to completion. Swallow all errors — fire-and-forget on a detached task with
    its own fresh client (the poller's client is being torn down by the cancellation)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.delete(f"{KREA_BASE_URL}/jobs/{job_id}", headers=_auth_headers(api_key))
    except Exception:
        pass


async def _poll_krea_job(
    client: httpx.AsyncClient,
    api_key: str,
    job_id: str,
    *,
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
    max_polls: int = 300,
    poll_interval: float = 2.0,
) -> dict[str, Any]:
    async def noop_emit(_event: ExecutionEvent) -> None:
        return None

    _emit = emit or noop_emit
    for poll_num in range(1, max_polls + 1):
        try:
            await asyncio.sleep(poll_interval)
            response = await client.get(
                f"{KREA_BASE_URL}/jobs/{job_id}",
                headers=_auth_headers(api_key),
            )
        except asyncio.CancelledError:
            # User/engine cancelled — stop the Krea job upstream, then re-raise.
            schedule_detached_cancel(lambda: _cancel_krea_job(job_id, api_key))
            raise
        _raise_for_krea_response(response, "job poll")
        job = response.json()
        status = str(job.get("status", "")).lower()
        await _emit(ProgressEvent(node_id=node_id, value=min(poll_num / max_polls, 0.99)))
        if status == "completed":
            return job
        if status in {"failed", "cancelled"}:
            message = job.get("error") or job.get("message") or status
            raise RuntimeError(f"Krea job {job_id} {status}: {message}")
        if status and status not in KREA_STATUS_PENDING | KREA_STATUS_TERMINAL:
            raise RuntimeError(f"Krea job {job_id} returned unknown status: {status}")
    raise RuntimeError(f"Krea job {job_id} timed out after {max_polls} polls")


def _resource_kind(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("kind") or item.get("type") or "")
    return ""


async def _collect_image_style_references(
    client: httpx.AsyncClient,
    api_key: str,
    node: GraphNode,
    inputs: dict[str, PortValueDict],
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []

    default_strength = _float_value(node.params.get("style_reference_strength"), 0.5, 0.0, 1.0)
    for value in _port_values(inputs.get("style_images")):
        refs.append({
            "url": await _image_value_to_url(client, api_key, value, description="Nebula Krea style reference"),
            "strength": default_strength,
        })

    for item in _port_values(inputs.get("image_style_references")):
        if isinstance(item, dict) and _resource_kind(item) == "krea_image_style_reference":
            refs.append({
                "url": await _image_value_to_url(
                    client,
                    api_key,
                    item.get("url") or item.get("image"),
                    description="Nebula Krea style reference",
                ),
                "strength": _float_value(item.get("strength"), default_strength, 0.0, 1.0),
            })
        elif isinstance(item, dict) and (item.get("url") or item.get("image_url")):
            refs.append({
                "url": await _image_value_to_url(client, api_key, item, description="Nebula Krea style reference"),
                "strength": _float_value(item.get("strength"), default_strength, 0.0, 1.0),
            })
        elif item:
            refs.append({
                "url": await _image_value_to_url(client, api_key, item, description="Nebula Krea style reference"),
                "strength": default_strength,
            })

    if len(refs) > 10:
        raise ValueError(f"Krea 2 accepts at most 10 image style references; got {len(refs)}")
    return refs


def _native_moodboard_values(inputs: dict[str, PortValueDict]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for item in _port_values(inputs.get("moodboard")):
        if isinstance(item, dict) and _resource_kind(item) == "nebula_moodboard":
            values.append(item)
    return values


async def _collect_native_moodboard_style_references(
    client: httpx.AsyncClient,
    api_key: str,
    inputs: dict[str, PortValueDict],
    *,
    remaining_slots: int,
) -> list[dict[str, Any]]:
    if remaining_slots <= 0:
        return []

    refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for moodboard in _native_moodboard_values(inputs):
        strength = _float_value(moodboard.get("strength"), 0.7, 0.0, 1.0)
        analysis = moodboard.get("analysis") if isinstance(moodboard.get("analysis"), dict) else {}
        hints = analysis.get("providerHints") if isinstance(analysis, dict) else {}
        krea_hints = hints.get("krea") if isinstance(hints, dict) and isinstance(hints.get("krea"), dict) else {}
        raw_images = krea_hints.get("representativeImages") or moodboard.get("representativeImages")
        if not raw_images:
            raw_images = [
                img.get("url")
                for img in moodboard.get("images", [])
                if isinstance(img, dict) and not bool(img.get("excluded")) and img.get("url")
            ]
        image_weights = {
            str(img.get("url")): _float_value(img.get("weight"), 1.0, 0.0, 1.0)
            for img in moodboard.get("images", [])
            if isinstance(img, dict) and img.get("url")
        }
        for raw in _as_list(raw_images):
            url_key = _clean_str(raw)
            if not url_key or url_key in seen:
                continue
            seen.add(url_key)
            refs.append({
                "url": await _image_value_to_url(
                    client,
                    api_key,
                    raw,
                    description="Nebula native moodboard reference",
                ),
                "strength": _float_value(strength * image_weights.get(url_key, 1.0), strength, 0.0, 1.0),
            })
            if len(refs) >= remaining_slots:
                return refs
    return refs


def _native_moodboard_prompt_suffix(inputs: dict[str, PortValueDict]) -> str:
    briefs: list[str] = []
    for moodboard in _native_moodboard_values(inputs):
        analysis = moodboard.get("analysis") if isinstance(moodboard.get("analysis"), dict) else {}
        hints = analysis.get("providerHints") if isinstance(analysis, dict) else {}
        krea_hints = hints.get("krea") if isinstance(hints, dict) and isinstance(hints.get("krea"), dict) else {}
        brief = _clean_str(
            krea_hints.get("styleBrief")
            or moodboard.get("styleBrief")
            or (analysis.get("styleBrief") if isinstance(analysis, dict) else "")
        )
        if brief:
            briefs.append(brief)
    return "\n\n".join(briefs)


def _collect_styles(node: GraphNode, inputs: dict[str, PortValueDict]) -> list[dict[str, Any]]:
    styles: list[dict[str, Any]] = []
    default_strength = _float_value(node.params.get("style_strength"), 1.0, -2.0, 2.0)
    for item in _port_values(inputs.get("styles")):
        if isinstance(item, dict):
            style_id = _clean_str(item.get("id") or item.get("style_id"))
            strength = _float_value(item.get("strength"), default_strength, -2.0, 2.0)
        else:
            style_id = _clean_str(item)
            strength = default_strength
        if style_id:
            styles.append({"id": style_id, "strength": strength})

    manual_id = _clean_str(node.params.get("style_id"))
    if manual_id:
        styles.append({"id": manual_id, "strength": default_strength})
    return styles


def _collect_moodboards(node: GraphNode, inputs: dict[str, PortValueDict]) -> list[dict[str, Any]]:
    moodboards: list[dict[str, Any]] = []
    default_strength = _float_value(node.params.get("moodboard_strength"), 0.23, 0.0, 1.0)
    for item in _port_values(inputs.get("moodboard")):
        if isinstance(item, dict):
            moodboard_id = _clean_str(item.get("id") or item.get("moodboard_id"))
            strength = _float_value(item.get("strength"), default_strength, 0.0, 1.0)
        else:
            moodboard_id = _clean_str(item)
            strength = default_strength
        if moodboard_id:
            moodboards.append({"id": moodboard_id, "strength": strength})

    manual_id = _clean_str(node.params.get("moodboard_id"))
    if manual_id:
        moodboards.append({"id": manual_id, "strength": default_strength})
    if len(moodboards) > 1:
        raise ValueError("Krea 2 currently accepts at most one moodboard")
    return moodboards


async def handle_krea_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required")

    api_key = _api_key(api_keys)
    variant = str(node.params.get("variant", "medium")).lower()
    if variant not in KREA_VARIANTS:
        raise ValueError(f"Unknown Krea 2 variant: {variant}")

    aspect_ratio = str(node.params.get("aspect_ratio", "1:1"))
    if aspect_ratio not in KREA_ASPECT_RATIOS:
        raise ValueError(f"Invalid Krea aspect_ratio: {aspect_ratio}")

    resolution = str(node.params.get("resolution", "1K"))
    if resolution != "1K":
        raise ValueError("Krea 2 currently supports only resolution=1K")

    creativity = str(node.params.get("creativity", "medium"))
    if creativity not in KREA_CREATIVITY:
        raise ValueError(f"Invalid Krea creativity: {creativity}")

    async with httpx.AsyncClient(timeout=120.0) as client:
        body: dict[str, Any] = {
            "prompt": str(prompt_input.value),
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "creativity": creativity,
        }

        seed = node.params.get("seed")
        if seed is not None and seed != "":
            body["seed"] = _int_value(seed, 0)

        image_refs = await _collect_image_style_references(client, api_key, node, inputs)
        native_refs = await _collect_native_moodboard_style_references(
            client,
            api_key,
            inputs,
            remaining_slots=max(0, 10 - len(image_refs)),
        )
        image_refs.extend(native_refs)
        if image_refs:
            body["image_style_references"] = image_refs

        native_prompt_suffix = _native_moodboard_prompt_suffix(inputs)
        if native_prompt_suffix:
            body["prompt"] = f"{body['prompt']}\n\nNebula moodboard direction: {native_prompt_suffix}"

        styles = _collect_styles(node, inputs)
        if styles:
            body["styles"] = styles

        moodboards = _collect_moodboards(node, inputs)
        if moodboards:
            body["moodboards"] = moodboards

        response = await client.post(
            f"{KREA_BASE_URL}/generate/image/krea/krea-2/{variant}",
            headers=_json_headers(api_key),
            json=body,
        )
        _raise_for_krea_response(response, "generate submit")
        submitted = response.json()
        job_id = submitted.get("job_id")
        if not job_id:
            raise RuntimeError(f"Krea generate returned no job_id: {submitted}")

        job = submitted if str(submitted.get("status", "")).lower() == "completed" else await _poll_krea_job(
            client,
            api_key,
            str(job_id),
            node_id=node.id,
            emit=emit,
        )
        urls = _result_urls(job)
        if not urls:
            raise RuntimeError(f"Krea generate completed but returned no image URLs: {job}")
        file_path = await _download_image(client, urls[0])
        return {
            "image": {"type": "Image", "value": str(file_path)},
            "job": {"type": "Any", "value": job},
        }


async def handle_krea_image_style_reference(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    image = inputs.get("image")
    if not image or not image.value:
        raise ValueError("Image input is required for Krea image style reference")
    strength = _float_value(node.params.get("strength"), 0.5, 0.0, 1.0)
    return {
        "image_style_reference": {
            "type": "Any",
            "value": {
                "kind": "krea_image_style_reference",
                "image": image.value,
                "strength": strength,
            },
        }
    }


async def handle_krea_style(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    style_id = _clean_str(node.params.get("style_id"))
    if not style_id:
        raise ValueError("Krea style_id is required")
    strength = _float_value(node.params.get("strength"), 1.0, -2.0, 2.0)
    return {
        "style": {
            "type": "Any",
            "value": {"kind": "krea_style", "id": style_id, "strength": strength},
        },
        "style_id": {"type": "Text", "value": style_id},
    }


async def handle_krea_moodboard(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    moodboard_id = _clean_str(node.params.get("moodboard_id"))
    if not moodboard_id:
        raise ValueError("Krea moodboard_id is required")
    strength = _float_value(node.params.get("strength"), 0.23, 0.0, 1.0)
    return {
        "moodboard": {
            "type": "Any",
            "value": {"kind": "krea_moodboard", "id": moodboard_id, "strength": strength},
        },
        "moodboard_id": {"type": "Text", "value": moodboard_id},
    }


async def handle_krea_style_search(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = _api_key(api_keys)
    params: dict[str, Any] = {}
    for key in ("cursor", "ids", "user", "model", "filter"):
        value = _clean_str(node.params.get(key))
        if value:
            params[key] = value
    limit = node.params.get("limit")
    if limit is not None and limit != "":
        params["limit"] = _int_value(limit, 25, 1, 1000)
    liked = node.params.get("liked")
    if liked is not None and liked != "":
        params["liked"] = bool(liked)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(
            f"{KREA_BASE_URL}/styles",
            headers=_auth_headers(api_key),
            params=params,
        )
        _raise_for_krea_response(response, "style search")
        payload = response.json()

    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        items = []
    lines = []
    for item in items[:10]:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or "(untitled)"
        style_id = item.get("id") or ""
        models = ", ".join(item.get("models") or [])
        lines.append(f"{title} — {style_id}" + (f" [{models}]" if models else ""))

    return {
        "styles": {"type": "Array", "value": items},
        "text": {"type": "Text", "value": "\n".join(lines)},
    }


async def handle_krea_style_train(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    image_values = _port_values(inputs.get("images"))
    if not image_values:
        raise ValueError("Krea style training requires at least one training image")

    name = _clean_str(node.params.get("name"))
    if not name:
        raise ValueError("Krea style training requires a name")

    model = _clean_str(node.params.get("model")) or "flux_dev"
    if model not in KREA_STYLE_TRAINING_MODELS_WITH_FULL_KNOBS | KREA_STYLE_TRAINING_MODELS_SIMPLE:
        raise ValueError(f"Unknown Krea style training model: {model}")

    api_key = _api_key(api_keys)
    async with httpx.AsyncClient(timeout=120.0) as client:
        urls = [
            await _image_value_to_url(client, api_key, value, description=f"Krea style training: {name}")
            for value in image_values
        ]

        training_type = _clean_str(node.params.get("training_type")) or "Style"
        if model in KREA_STYLE_TRAINING_MODELS_SIMPLE and training_type == "Default":
            training_type = "Style"

        body: dict[str, Any] = {
            "model": model,
            "type": training_type,
            "name": name,
            "urls": urls,
        }
        trigger_word = _clean_str(node.params.get("trigger_word"))
        if trigger_word:
            body["trigger_word"] = trigger_word
        max_train_steps = node.params.get("max_train_steps")
        if max_train_steps is not None and max_train_steps != "":
            body["max_train_steps"] = _int_value(max_train_steps, 1000, 1, 2000)

        if model in KREA_STYLE_TRAINING_MODELS_WITH_FULL_KNOBS:
            learning_rate = node.params.get("learning_rate")
            if learning_rate is not None and learning_rate != "":
                body["learning_rate"] = float(learning_rate)
            batch_size = node.params.get("batch_size")
            if batch_size is not None and batch_size != "":
                body["batch_size"] = _int_value(batch_size, 1, 1)

        response = await client.post(
            f"{KREA_BASE_URL}/styles/train",
            headers=_json_headers(api_key),
            json=body,
        )
        _raise_for_krea_response(response, "style train submit")
        submitted = response.json()
        job_id = submitted.get("job_id")
        if not job_id:
            raise RuntimeError(f"Krea style training returned no job_id: {submitted}")

        job = await _poll_krea_job(client, api_key, str(job_id), node_id=node.id, emit=emit, poll_interval=5.0)
        result = job.get("result") if isinstance(job.get("result"), dict) else {}
        style_id = _clean_str(result.get("style_id") if isinstance(result, dict) else "")
        if not style_id:
            raise RuntimeError(f"Krea style training completed but returned no style_id: {job}")

        if node.params.get("share_with_workspace"):
            share_resp = await client.post(
                f"{KREA_BASE_URL}/styles/{style_id}/share/workspace",
                headers=_auth_headers(api_key),
            )
            _raise_for_krea_response(share_resp, "style workspace share")

    strength = _float_value(node.params.get("generation_strength"), 1.0, -2.0, 2.0)
    style_value = {"kind": "krea_style", "id": style_id, "strength": strength}
    return {
        "style": {"type": "Any", "value": style_value},
        "style_id": {"type": "Text", "value": style_id},
        "job": {"type": "Any", "value": job},
    }
