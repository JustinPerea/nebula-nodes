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

from models.events import ExecutionEvent, ProgressEvent, add_run_note
from models.graph import GraphNode, PortValueDict
from services.file_access import require_allowed_path
from services.moodboard_analysis import rank_representative_images
from services.moodboard_brief import BOARD_STRENGTH_ZERO_NOTE
from services.moodboard_weights import native_strengths
from services.cancellation import schedule_detached_cancel
from services.output import OUTPUT_ROOT, get_run_dir
from execution.missing_credential import MissingCredentialError
from execution.person_line import (as_job_failure, as_person_line, field_label, option_label, slow_job_line,
                                   with_api_status, with_person_line)

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
KREA_STYLE_TRAINING_MODELS_SIMPLE = {"qwen", "z-image", "k2", "k2-large"}
# Krea trains these only for a signed-in account (MCP create_style).
KREA_STYLE_TRAINING_MODELS_ACCOUNT_ONLY = {"k1", "ltx-23-22b"}

_OUTPUTS_URL_PREFIX = "/api/outputs/"
_DATA_URI_RE = re.compile(r"^data:(?P<mime>[^;,]+);base64,(?P<data>.*)$", re.DOTALL)


def _api_key(api_keys: dict[str, str]) -> str:
    key = api_keys.get("KREA_API_TOKEN") or api_keys.get("KREA_API_KEY")
    if not key:
        raise MissingCredentialError("KREA_API_TOKEN is required")
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


# GM's Krea lines (error copy round 3d). They use the connection names the
# node shows, in quotes, and the lines that run before anything is sent end
# "Nothing was sent to Krea." ({fields}: each label in quotes, joined with
# "and".)
NOTHING_SENT_TO_KREA = "Nothing was sent to Krea."
UNSET_CONNECTION_LINE = "This node's Krea connection isn't set. Choose “API token” or “Krea account”."


def _label(definition_id: str, key: str) -> str:
    return field_label(definition_id, key)


def _option_label(definition_id: str, key: str, value: str) -> str:
    """An option's label as the node shows it, less a "(Krea account)" note."""
    return option_label(definition_id, key, value) or value


def quoted_and(labels: list[str]) -> str:
    """“A”, “A” and “B”, “A”, “B” and “C”: GM's {fields}."""
    quoted = [label if label.startswith("“") else f"“{label}”" for label in labels]
    return quoted[0] if len(quoted) == 1 else f"{', '.join(quoted[:-1])} and {quoted[-1]}"


def _auth_mode(node: GraphNode) -> str:
    """Saved billing choice; nodes saved before the choice existed keep the API token."""
    mode = node.params.get("_kreaAuth", "api-token")
    if mode not in {"api-token", "mcp"}:
        raise with_person_line(ValueError("Unknown Krea connection; choose API token or Krea account"),
                               UNSET_CONNECTION_LINE)
    return mode


async def _account_reference(value: Any, description: str | None = None) -> str:
    """Keep a media reference as-is; the account path uploads local files itself."""
    if isinstance(value, dict):
        value = value.get("url") or value.get("image_url") or value.get("image") or value.get("value")
    raw = _clean_str(value)
    if not raw:
        raise as_person_line(ValueError("Krea image reference is empty"))
    return raw


UrlResolver = Callable[..., Awaitable[str]]


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
    raise with_api_status(
        RuntimeError(f"Krea {action} failed ({response.status_code}): {detail}"), response.status_code)


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
        raise as_person_line(ValueError("Krea asset upload needs an image value"))

    data_uri = _DATA_URI_RE.match(raw)
    if data_uri:
        mime = data_uri.group("mime")
        payload = base64.b64decode(data_uri.group("data"))
        filename = f"krea-upload.{_extension_for_mime(mime)}"
    else:
        path = _resolve_local_path(raw)
        if path is None:
            raise with_person_line(
                ValueError(f"Krea image reference is not a URL or local file: {raw}"),
                "A connected image isn't a link or a file Nebula can read. Connect another image.")
        mime = _mime_for_path(path)
        payload = require_allowed_path(path).read_bytes()
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
            raise as_job_failure(RuntimeError(f"Krea job {job_id} {status}: {message}"))
        if status and status not in KREA_STATUS_PENDING | KREA_STATUS_TERMINAL:
            raise RuntimeError(f"Krea job {job_id} returned unknown status: {status}")
    raise with_person_line(RuntimeError(f"Krea job {job_id} timed out after {max_polls} polls"), slow_job_line("Krea"))


def _resource_kind(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("kind") or item.get("type") or "")
    return ""


async def _collect_image_style_references(
    to_url: UrlResolver,
    node: GraphNode,
    inputs: dict[str, PortValueDict],
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []

    default_strength = _float_value(node.params.get("style_reference_strength"), 0.5, 0.0, 1.0)
    for value in _port_values(inputs.get("style_images")):
        refs.append({
            "url": await to_url(value, description="Nebula Krea style reference"),
            "strength": default_strength,
        })

    for item in _port_values(inputs.get("image_style_references")):
        if isinstance(item, dict) and _resource_kind(item) == "krea_image_style_reference":
            refs.append({
                "url": await to_url(item.get("url") or item.get("image"), description="Nebula Krea style reference"),
                "strength": _float_value(item.get("strength"), default_strength, 0.0, 1.0),
            })
        elif isinstance(item, dict) and (item.get("url") or item.get("image_url")):
            refs.append({
                "url": await to_url(item, description="Nebula Krea style reference"),
                "strength": _float_value(item.get("strength"), default_strength, 0.0, 1.0),
            })
        elif item:
            refs.append({
                "url": await to_url(item, description="Nebula Krea style reference"),
                "strength": default_strength,
            })

    if len(refs) > 10:
        raise as_person_line(ValueError(f"Krea 2 accepts at most 10 image style references; got {len(refs)}"))
    return refs


def _native_moodboard_values(inputs: dict[str, PortValueDict]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for item in _port_values(inputs.get("moodboard")):
        if isinstance(item, dict) and _resource_kind(item) == "nebula_moodboard":
            values.append(item)
    return values


# Krea 2's ``image_style_references[].strength``: 0..1 in the schema Krea's
# gateway enforces (krea-2-medium.md, krea-2-large.md), as the clamp guards.
KREA2_STRENGTH_RANGE = (0.0, 1.0)


def _board_label(moodboard: dict[str, Any]) -> str:
    name = _clean_str(moodboard.get("name"))
    return f"Board '{name}'" if name else "The board"


def _board_numbers(moodboard: dict[str, Any]) -> dict[str, int]:
    """Each image's board number by URL: the analysis's ``number`` where it has
    one (set-aside images keep their place in it), else its place in the
    bundle's images."""
    numbers: dict[str, int] = {}
    analysis = moodboard.get("analysis") if isinstance(moodboard.get("analysis"), dict) else {}
    for item in _as_list(analysis.get("images")):
        if isinstance(item, dict) and item.get("url") and isinstance(item.get("number"), int):
            numbers.setdefault(str(item["url"]), item["number"])
    for index, img in enumerate(_as_list(moodboard.get("images")), start=1):
        if isinstance(img, dict) and img.get("url"):
            numbers.setdefault(str(img["url"]), index)
    return numbers


def _strength_text(value: float) -> str:
    return f"{value:.2f}"


def _sent_strength_text(value: float) -> str:
    """A strength that was sent, for the run note: 2 decimals, or the 4 the
    request carries when 2 would read 0.00 (it went, so it isn't 0)."""
    text = _strength_text(value)
    return f"{value:.4f}" if value > 0 and text == "0.00" else text


async def _collect_native_moodboard_style_references(
    to_url: UrlResolver,
    inputs: dict[str, PortValueDict],
    *,
    remaining_slots: int,
    wired: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """A Nebula board's images as Krea 2 style references.

    Q21 b (Justin, 2026-10-20; plan section 5.7.4): the board images sent
    share out the board's strength, ``S * w / sum(w)`` over the images that
    go (after the slot cap and dedupe), at 4 decimals adding up to exactly
    ``S``. ``wired`` (the person's own references, which took their slots
    first) keep their strengths and are named in the run note. A board at
    strength 0 sends nothing (Q32 a); the engine drops it before this runs,
    text included (Q36 a, ``services/moodboard_brief.apply_to_generator``)."""
    if remaining_slots <= 0:
        return []

    # Pick first, then scale: the sum is over the images that actually go.
    picked: list[tuple[dict[str, Any], list[tuple[Any, str, float]]]] = []
    seen: set[str] = set()
    taken = 0
    for moodboard in _native_moodboard_values(inputs):
        if taken >= remaining_slots:
            break
        strength = _float_value(moodboard.get("strength"), 0.7, 0.0, 1.0)
        if strength <= 0:
            # The engine has already dropped it (Q36 a); this guards a
            # direct call.
            add_run_note(BOARD_STRENGTH_ZERO_NOTE)
            continue
        analysis = moodboard.get("analysis") if isinstance(moodboard.get("analysis"), dict) else {}
        hints = analysis.get("providerHints") if isinstance(analysis, dict) else {}
        krea_hints = hints.get("krea") if isinstance(hints, dict) and isinstance(hints.get("krea"), dict) else {}
        raw_images = krea_hints.get("representativeImages") or moodboard.get("representativeImages")
        if not raw_images:
            raw_images = rank_representative_images(moodboard.get("images", []))
        image_weights = {
            str(img.get("url")): _float_value(img.get("weight"), 1.0, 0.0, 1.0)
            for img in moodboard.get("images", [])
            if isinstance(img, dict) and img.get("url")
        }
        chosen: list[tuple[Any, str, float]] = []
        for raw in _as_list(raw_images):
            url_key = _clean_str(raw)
            if not url_key or url_key in seen:
                continue
            # A URL the bundle's images don't list counts as full weight, as
            # before; a weight-0 image never steers, whatever a stale hint says.
            weight = image_weights.get(url_key, 1.0)
            if weight <= 0:
                continue
            seen.add(url_key)
            chosen.append((raw, url_key, weight))
            taken += 1
            if taken >= remaining_slots:
                break
        if chosen:
            picked.append((moodboard, chosen))

    refs: list[dict[str, Any]] = []
    for moodboard, chosen in picked:
        strength = _float_value(moodboard.get("strength"), 0.7, 0.0, 1.0)
        scaled = native_strengths(strength, [weight for _, _, weight in chosen],
                                  normalize="sum-to-strength", range=KREA2_STRENGTH_RANGE)
        label = _board_label(moodboard)
        numbers = _board_numbers(moodboard)
        if scaled.clamped:
            add_run_note(f"{label}: a strength was outside Krea 2's 0 to 1 and was clamped.")
        sent: list[tuple[str, float]] = []
        for (raw, url_key, _), value in zip(chosen, scaled.strengths):
            number = numbers.get(url_key)
            tag = f"#{number}" if number else url_key
            if value <= 0:
                add_run_note(f"{label}: {tag} is too light to steer at this board strength, so it wasn't sent.")
                continue
            refs.append({
                "url": await to_url(raw, description="Nebula native moodboard reference"),
                "strength": value,
            })
            sent.append((tag, value))
        if len(sent) == 1:
            add_run_note(f"{label} sent 1 image, at the board's strength {_strength_text(strength)}.")
        elif sent:
            listed = ", ".join(f"{tag} {_sent_strength_text(value)}" for tag, value in sent)
            add_run_note(f"{label} sent {len(sent)} images; their strengths add up to the board's "
                         f"{_strength_text(strength)} ({listed}).")

    if refs and wired:
        board_total = sum(_float_value(m.get("strength"), 0.7, 0.0, 1.0) for m, _ in picked)
        wired_total = sum(_float_value(ref.get("strength"), 0.0, 0.0, 1.0) for ref in wired)
        count = len(wired)
        add_run_note(f"Your {count} reference{'s add' if count != 1 else ' adds'} {_strength_text(wired_total)} "
                     f"on top of the board's {_strength_text(board_total)}.")
    return refs


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
        raise as_person_line(ValueError("Krea 2 currently accepts at most one moodboard"))
    return moodboards


async def handle_krea_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise as_person_line(ValueError("Prompt input is required"))

    mode = _auth_mode(node)
    api_key = _api_key(api_keys) if mode == "api-token" else None
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
        async def api_url(value: Any, description: str | None = None) -> str:
            return await _image_value_to_url(client, api_key, value, description=description)

        to_url = api_url if mode == "api-token" else _account_reference
        body: dict[str, Any] = {
            "prompt": str(prompt_input.value),
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "creativity": creativity,
        }

        seed = node.params.get("seed")
        if seed is not None and seed != "":
            body["seed"] = _int_value(seed, 0)

        image_refs = await _collect_image_style_references(to_url, node, inputs)
        native_refs = await _collect_native_moodboard_style_references(
            to_url,
            inputs,
            remaining_slots=max(0, 10 - len(image_refs)),
            wired=image_refs,
        )
        image_refs.extend(native_refs)
        if image_refs:
            body["image_style_references"] = image_refs

        # A Nebula board's brief and Avoid list are already in the prompt: the
        # engine adds them for every generator (services/moodboard_brief.py).

        styles = _collect_styles(node, inputs)
        if styles:
            body["styles"] = styles

        moodboards = _collect_moodboards(node, inputs)
        if moodboards:
            body["moodboards"] = moodboards

        if mode == "mcp":
            # The gateway owns the account path: schema checks, uploads of
            # local references, the exact Krea 2 route, polling and cancel.
            from handlers.krea_gateway import _model, run_gateway
            result = await run_gateway(node, _model(f"krea-image-krea-krea-2-{variant}"), body, "mcp", None, emit)
            return {"image": result["image"], "job": result["job"]}

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
        raise as_person_line(ValueError("Image input is required for Krea image style reference"))
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
        raise with_person_line(
            ValueError("Krea style_id is required"),
            "Fill in the node's Style ID, then run it again.")
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
        raise with_person_line(
            ValueError("Krea moodboard_id is required"),
            "Fill in the node's Moodboard ID, then run it again.")
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
    if _auth_mode(node) == "mcp":
        return await _account_style_search(node)
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
    return _style_search_outputs(items)


def _style_search_outputs(items: Any) -> dict[str, Any]:
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
        raise as_person_line(ValueError("Krea style training requires at least one training image"))

    name = _clean_str(node.params.get("name"))
    if not name:
        raise as_person_line(ValueError("Krea style training requires a name"))

    model = _clean_str(node.params.get("model")) or "flux_dev"
    if model not in (KREA_STYLE_TRAINING_MODELS_WITH_FULL_KNOBS | KREA_STYLE_TRAINING_MODELS_SIMPLE
                     | KREA_STYLE_TRAINING_MODELS_ACCOUNT_ONLY):
        raise ValueError(f"Unknown Krea style training model: {model}")
    if _auth_mode(node) == "mcp":
        return await _account_style_train(node, name, model, image_values, emit)
    if model in KREA_STYLE_TRAINING_MODELS_ACCOUNT_ONLY:
        raise with_person_line(
            ValueError(f"Krea trains {model} styles only on a connected Krea account; nothing was sent"),
            f"Training {_option_label('krea-style-train', 'model', model)} styles needs the “Krea account” "
            f"connection. {NOTHING_SENT_TO_KREA}")

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


# ---------------------------------------------------------------------------
# Krea account (MCP) paths. Each validates every saved control before the
# first request so a choice the account path cannot honor never half-runs.
# ---------------------------------------------------------------------------

def _set(value: Any) -> bool:
    return value is not None and value != "" and value is not False


def _style_value(node: GraphNode, style_id: str) -> dict[str, Any]:
    strength = _float_value(node.params.get("generation_strength"), 1.0, -2.0, 2.0)
    return {"kind": "krea_style", "id": style_id, "strength": strength}


def _moodboard_value(moodboard_id: str, strength: Any = None) -> dict[str, Any]:
    return {"kind": "krea_moodboard", "id": moodboard_id, "strength": _float_value(strength, 0.23, 0.0, 1.0)}


def _job_result_id(job: dict[str, Any], *keys: str) -> str:
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    for source in (result, job):
        for key in keys:
            value = _clean_str(source.get(key))
            if value:
                return value
    return ""


async def _account_style_search(node: GraphNode) -> dict[str, Any]:
    from services.krea_account import account_tools
    keys = [key for key in ("user", "liked") if _set(node.params.get(key))]
    if _clean_str(node.params.get("filter")) not in {"", "all"}:
        keys.append("filter")
    if keys:
        unsupported = [{"user": "User", "liked": "Liked only", "filter": "Filter"}[key] for key in keys]
        raise with_person_line(
            ValueError(f"{', '.join(unsupported)} needs a Krea API token; the Krea account lists the styles available to you. Nothing was sent"),
            f"To use {quoted_and([_label('krea-style-search', key) for key in keys])}, switch to the “API token” "
            f"connection. The “Krea account” connection lists every style you can use. {NOTHING_SENT_TO_KREA}")
    ids = {part.strip() for part in _clean_str(node.params.get("ids")).split(",") if part.strip()}
    model = _clean_str(node.params.get("model"))
    limit = _int_value(node.params.get("limit"), 25, 1, 1000)
    cursor = _clean_str(node.params.get("cursor"))
    items: list[Any] = []
    async with account_tools() as account:
        for _page in range(50):
            payload = await account.call("list_styles", {"cursor": cursor} if cursor else {})
            page = payload.get("styles") if isinstance(payload, dict) else None
            if not isinstance(page, list):
                raise RuntimeError("Krea list_styles returned no style list")
            items.extend(item for item in page if isinstance(item, dict)
                         and (not ids or str(item.get("id")) in ids)
                         and (not model or model in (item.get("models") or [item.get("model")])))
            cursor = _clean_str(payload.get("next_cursor"))
            if len(items) >= limit or not cursor:
                break
    return _style_search_outputs(items[:limit])


async def _account_style_train(node, name, model, image_values, emit) -> dict[str, Any]:
    from services.krea_account import account_tools, run_job
    training_type = _clean_str(node.params.get("training_type")) or "Style"
    keys = [key for key in ("max_train_steps", "learning_rate", "batch_size", "share_with_workspace")
            if _set(node.params.get(key))]
    unsupported = [{"max_train_steps": "Max steps", "learning_rate": "Learning rate", "batch_size": "Batch size",
                    "share_with_workspace": "Share workspace"}[key] for key in keys]
    fields = [_label("krea-style-train", key) for key in keys]
    if training_type == "Default":
        unsupported.append("Type: Default")
        # GM: write "Type: Default" as “Type” set to Default.
        fields.append(f"“{_label('krea-style-train', 'training_type')}” set to "
                      f"{_option_label('krea-style-train', 'training_type', 'Default')}")
    if unsupported:
        raise with_person_line(
            ValueError(f"{', '.join(unsupported)} needs a Krea API token; the Krea account trains with Krea's defaults. Nothing was sent"),
            f"To use {quoted_and(fields)}, switch to the “API token” connection. The “Krea account” connection "
            f"trains with Krea's default settings. {NOTHING_SENT_TO_KREA}")
    arguments: dict[str, Any] = {"name": name, "model": model, "train_type": training_type, "images": []}
    trigger_word = _clean_str(node.params.get("trigger_word"))
    if trigger_word:
        arguments["trigger_word"] = trigger_word
    async with account_tools() as account:
        account.check("create_style", {**arguments, "images": ["https://assets.krea.ai/validated-local-input"]})
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
            arguments["images"] = [await account.upload(client, value) for value in image_values]
        job = await run_job(account, "create_style", arguments, node.id, emit, poll_interval=5.0)
    style_id = _job_result_id(job, "style_id", "id")
    if not style_id:
        raise RuntimeError("Krea style training completed but returned no style id")
    return {
        "style": {"type": "Any", "value": _style_value(node, style_id)},
        "style_id": {"type": "Text", "value": style_id},
        "job": {"type": "Any", "value": job},
    }


async def handle_krea_moodboard_search(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """List the account's moodboards (Krea's API has no moodboard endpoints)."""
    from services.krea_account import account_tools
    query = _clean_str(node.params.get("name")).lower()
    async with account_tools() as account:
        payload = await account.call("list_moodboards")
    boards = payload.get("moodboards") if isinstance(payload, dict) else None
    if not isinstance(boards, list):
        raise RuntimeError("Krea list_moodboards returned no moodboard list")
    boards = [board for board in boards if isinstance(board, dict) and board.get("id")
              and (not query or query in str(board.get("name", "")).lower())]
    first = boards[0] if boards else None
    lines = [f"{board.get('name') or '(untitled)'} — {board['id']}" + (f" [{board['kind']}]" if board.get("kind") else "")
             for board in boards]
    return {
        "moodboards": {"type": "Array", "value": boards},
        "moodboard": {"type": "Any", "value": _moodboard_value(str(first["id"]), node.params.get("strength")) if first else None},
        "moodboard_id": {"type": "Text", "value": str(first["id"]) if first else ""},
        "text": {"type": "Text", "value": "\n".join(lines)},
    }


async def handle_krea_moodboard_create(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Create and analyze a moodboard on the Krea account."""
    from services.krea_account import account_tools, run_job
    image_values = _port_values(inputs.get("images"))
    if not image_values:
        raise as_person_line(ValueError("A Krea moodboard needs at least one image"))
    arguments: dict[str, Any] = {"images": []}
    name = _clean_str(node.params.get("name"))
    if name:
        arguments["name"] = name
    async with account_tools() as account:
        account.check("create_moodboard", {**arguments, "images": ["https://assets.krea.ai/validated-local-input"]})
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=False) as client:
            arguments["images"] = [await account.upload(client, value) for value in image_values]
        job = await run_job(account, "create_moodboard", arguments, node.id, emit, poll_interval=3.0)
    moodboard_id = _job_result_id(job, "moodboard_id", "id")
    if not moodboard_id:
        raise RuntimeError("Krea moodboard analysis completed but returned no moodboard id")
    return {
        "moodboard": {"type": "Any", "value": _moodboard_value(moodboard_id, node.params.get("strength"))},
        "moodboard_id": {"type": "Text", "value": moodboard_id},
        "job": {"type": "Any", "value": job},
    }


_LIBRARY_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
KREA_LIBRARY_ACTIONS = {
    "rename-style": ("update_style", "title"),
    "delete-style": ("delete_style", None),
    "rename-moodboard": ("update_moodboard", "name"),
    "delete-moodboard": ("delete_moodboard", None),
}


async def handle_krea_library_manage(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Rename or delete one of the user's own styles or moodboards.

    A delete takes only a typed ID, never a wired one, and Confirm delete must
    repeat that exact ID. A shared or imported recipe therefore cannot delete
    anything unless it already contains the user's private IDs, and cannot
    chain a Krea Moodboards/Style Search result into a delete."""
    action = _clean_str(node.params.get("action"))
    if action not in KREA_LIBRARY_ACTIONS:
        raise ValueError(f"Unknown Krea library action: {action or '(none)'}")
    wired = inputs["id"].value if inputs.get("id") else None
    item_id = _clean_str(wired.get("id") if isinstance(wired, dict) else wired or node.params.get("item_id"))
    if not _LIBRARY_ID.fullmatch(item_id):
        raise as_person_line(ValueError("Choose a valid Krea style or moodboard ID to change"))
    tool, name_key = KREA_LIBRARY_ACTIONS[action]
    arguments: dict[str, Any] = {"id": item_id}
    if name_key:
        new_name = _clean_str(node.params.get("new_name"))
        if not new_name:
            raise as_person_line(ValueError("Enter the new name"))
        arguments[name_key] = new_name
    else:
        if wired is not None:
            raise as_person_line(ValueError("Deletes need the ID typed into the node, not wired in; nothing was deleted"))
        if _clean_str(node.params.get("confirm_delete")) != item_id:
            raise as_person_line(ValueError("Type the same ID into Confirm delete to remove this Krea item; nothing was deleted"))

    if _auth_mode(node) == "api-token":
        if action != "rename-style":
            raise with_person_line(
                ValueError("Only renaming a style works with a Krea API token; use the Krea account for moodboards and deletes. Nothing was sent"),
                "The “API token” connection can only rename styles. To make moodboards or delete styles, switch to "
                f"the “Krea account” connection. {NOTHING_SENT_TO_KREA}")
        api_key = _api_key(api_keys)
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.patch(f"{KREA_BASE_URL}/styles/{item_id}", headers=_json_headers(api_key),
                                          json={"title": arguments["title"]})
            _raise_for_krea_response(response, "style rename")
            result = response.json()
    else:
        from services.krea_account import account_tools
        async with account_tools() as account:
            result = await account.call(tool, arguments)
    summary = f"{'Renamed' if name_key else 'Deleted'} Krea {action.split('-', 1)[1]} {item_id}"
    return {
        "id": {"type": "Text", "value": item_id},
        "result": {"type": "Any", "value": result},
        "text": {"type": "Text", "value": summary},
    }
