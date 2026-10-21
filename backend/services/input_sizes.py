"""The size of a run's input file, read when the run is checked, for prices
that depend on it (model_pricing ``sizing``: SeedVR2 per megapixel, FLUX
Video Upscale per megapixel-second, FLUX Video Edit per second).

Only the file the run will send is read, and only its header: Pillow's lazy
open for an image, ffprobe for a clip (_probe_video).
Nothing is downloaded: an outside URL measures as unknown, so its node stays
unpriced (an agent proposes it). A served ``/api/outputs/...`` ref, a
loopback URL to it, a local path the run may read (file_access) and an
inline ``data:`` image are measured.

Where the input comes from (run_input_sizes): an Image Input or Video Input
in the run gives the file it holds; a node outside the run gives the output
it already has (a proposal's cached ancestor). Any other node in the same
run makes its output during the run, so its size isn't known yet, and the
node it feeds is unpriced until it is.
"""
from __future__ import annotations

import base64
import binascii
import io
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any, Iterable, Mapping

from services import model_pricing

# Image and Video Input nodes: their output is the file they hold.
INPUT_NODES = {"image-input": "Image", "video-input": "Video"}
# An inline image is decoded in memory; past this it isn't measured.
MAX_DATA_URI_CHARS = 64 * 1024 * 1024
_CACHE: OrderedDict[tuple[str, int, int, str], dict[str, Any] | None] = OrderedDict()
_CACHE_SIZE = 256


# A pricing check reads only a clip's header, and it waits for this.
SIZE_PROBE_TIMEOUT_SECONDS = 10


def _probe_video(path: Path) -> dict[str, Any] | None:
    """A local clip's first video stream as {width, height, seconds, frames},
    read from its header by ffprobe; None when it can't be read.

    Synchronous on purpose: the spending check that calls it is. Same input
    policy as every other probe (services/ffmpeg.py: local files only,
    single-file containers, no external references). It lives here, not in
    services/ffmpeg.py, so no handler reaches a process spawn through it
    (tests/test_node_readiness.py)."""
    import json
    import math
    import subprocess

    from services.child_env import scrubbed_env
    from services.ffmpeg import _media_input_args, _parse_frame_rate

    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,r_frame_rate,duration:format=duration",
        "-of", "json", "-enable_drefs", "0", "-use_absolute_path", "0",
        *_media_input_args(path),
    ]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=SIZE_PROBE_TIMEOUT_SECONDS,
                              env=scrubbed_env(), check=False)
        if done.returncode != 0:
            return None
        data = json.loads(done.stdout)
        stream = (data.get("streams") or [{}])[0]
        width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
        seconds = float(stream.get("duration") or (data.get("format") or {}).get("duration") or 0)
        fps = _parse_frame_rate(str(stream.get("avg_frame_rate") or "0/1")) or \
            _parse_frame_rate(str(stream.get("r_frame_rate") or "0/1"))
    except (OSError, ValueError, TypeError, KeyError, IndexError, subprocess.TimeoutExpired):
        return None
    frames_text = str(stream.get("nb_frames") or "")
    frames = int(frames_text) if frames_text.isdigit() and int(frames_text) > 0 else (
        math.ceil(seconds * fps) if seconds > 0 and fps > 0 else 0)
    if width <= 0 or height <= 0 or seconds <= 0 or not math.isfinite(seconds) or frames <= 0:
        return None
    return {"width": width, "height": height, "seconds": seconds, "frames": frames}


def _image_size(source: Any) -> dict[str, Any] | None:
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(source) as image:  # lazy: reads the header, not the pixels
            width, height = image.size
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None
    return {"width": int(width), "height": int(height)} if width > 0 and height > 0 else None


def _data_uri_size(ref: str) -> dict[str, Any] | None:
    head, _, body = ref.partition(",")
    if not head.startswith("data:image/") or ";base64" not in head or len(ref) > MAX_DATA_URI_CHARS:
        return None
    try:
        payload = base64.b64decode(body, validate=False)
    except (binascii.Error, ValueError):
        return None
    return _image_size(io.BytesIO(payload))


def local_path(ref: str, *, store_only: bool = False) -> Path | None:
    """The local file a ref names, or None when it isn't one Nebula may read
    (an outside URL, a path outside the allowed roots, or, with
    ``store_only``, anything outside the output store)."""
    from services.file_access import require_allowed_path
    from services.output import OUTPUT_ROOT, is_local_output_url, local_media_ref

    if not isinstance(ref, str) or not ref.strip():
        return None
    if ref.startswith(("http://", "https://")) and not is_local_output_url(ref):
        return None  # never downloaded for a price
    if ref.startswith("data:"):
        return None
    try:
        resolved = local_media_ref(ref)
        if resolved.startswith(("http://", "https://")) or not os.path.isabs(resolved):
            return None
        path = require_allowed_path(resolved)
    except (OSError, RuntimeError, ValueError):
        return None
    if store_only:
        try:
            path.relative_to(Path(OUTPUT_ROOT).resolve())
        except ValueError:
            return None
    return path if path.is_file() else None


def measure(ref: Any, kind: str, *, store_only: bool = False) -> dict[str, Any] | None:
    """{width, height} for an image, {width, height, seconds, frames} for a
    clip, read from the file's header; None when it can't be known here."""
    if not isinstance(ref, str):
        return None
    if kind == "Image" and ref.startswith("data:") and not store_only:
        return _data_uri_size(ref)
    path = local_path(ref, store_only=store_only)
    if path is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_mtime_ns, stat.st_size, kind)
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    size = _image_size(path) if kind == "Image" else _probe_video(path) if kind == "Video" else None
    _CACHE[key] = size
    while len(_CACHE) > _CACHE_SIZE:
        _CACHE.popitem(last=False)
    return size


def _port_kind(definition: Mapping[str, Any], port: str) -> str:
    for spec in definition.get("inputPorts") or []:
        if isinstance(spec, Mapping) and spec.get("id") == port:
            return "Video" if str(spec.get("dataType") or "") == "Video" else "Image"
    return "Image"


def _field(node: Any, name: str, alias: str) -> Any:
    if isinstance(node, Mapping):
        return node.get(alias, node.get(name))
    return getattr(node, name, None)


def _value(output: Any) -> Any:
    value = output.get("value") if isinstance(output, Mapping) else getattr(output, "value", None)
    if isinstance(value, list):
        return value[0] if len(value) == 1 else None
    return value


def source_ref(source: Any, source_handle: str | None, in_run: bool) -> str | None:
    """The file a wired source sends, or None when it isn't known yet."""
    definition_id = str(_field(source, "definition_id", "definitionId") or "")
    if definition_id in INPUT_NODES:
        params = _field(source, "params", "params") or {}
        ref = params.get("filePath") if isinstance(params, Mapping) else None
        return ref if isinstance(ref, str) and ref else None
    if in_run:
        return None  # made during this run
    outputs = _field(source, "outputs", "outputs") or {}
    output = outputs.get(source_handle) if isinstance(outputs, Mapping) and source_handle else None
    ref = _value(output)
    return ref if isinstance(ref, str) and ref else None


# Why a sized node's input wasn't measured (run_input_sizes ``reasons``), so
# the refusal says what is true and what to do (agent_spend.decide).
PENDING = "pending"        # made in this run, or its node hasn't run
REMOTE = "remote"          # a file on another host: never downloaded for a price
UNREADABLE = "unreadable"  # missing, not an image or clip it can open, or outside the allowed folders
WIRES = "wires"            # more than one wire into the measured port
UNWIRED = "unwired"        # nothing wired into it


def _why_not(ref: str | None) -> str:
    from services.output import is_local_output_url

    if ref is None:
        return PENDING
    if ref.startswith(("http://", "https://")) and not is_local_output_url(ref):
        return REMOTE
    return UNREADABLE


def run_input_sizes(
    items: Iterable[Mapping[str, Any]],
    edges: Iterable[tuple[str, str | None, str, str | None]],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    nodes: Mapping[str, Any] | None = None,
    *,
    reasons: dict[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    """{node id: measured input} for each run node whose price reads its
    input's size and whose input is known (see the module docstring).

    ``items`` are the run's nodes ({id, definitionId, params}); ``edges``
    are (source, source handle, target, target handle); ``nodes`` maps any
    node id to the node (a dict or a GraphNode with params and outputs), for
    sources outside the run. One wire into the measured port, or none known.
    ``reasons``, when given, gets {node id: why} for each sized node left
    unmeasured (PENDING, REMOTE, UNREADABLE, WIRES, UNWIRED): its first
    measured port's reason."""
    run = {str(item["id"]): item for item in items}
    known = {**(nodes or {}), **run}
    incoming: dict[tuple[str, str], list[tuple[str, str | None]]] = {}
    for source, source_handle, target, target_handle in edges:
        if target_handle:
            incoming.setdefault((str(target), str(target_handle)), []).append((str(source), source_handle))
    entries = pricing.get("nodes") or {}
    sizes: dict[str, dict[str, Any]] = {}
    for node_id, item in run.items():
        definition_id = str(item.get("definitionId") or "")
        ports = model_pricing.sizing_ports(entries.get(definition_id))
        definition = definitions.get(definition_id) or {}
        why: str | None = None
        for port in sorted(ports):
            wires = incoming.get((node_id, port)) or []
            if len(wires) != 1:
                why = why or (WIRES if wires else UNWIRED)
                continue
            source_id, handle = wires[0]
            source = known.get(source_id)
            if source is None:
                why = why or PENDING
                continue
            ref = source_ref(source, handle, source_id in run)
            try:
                size = measure(ref, _port_kind(definition, port)) if ref else None
            except Exception:  # noqa: BLE001 - an unreadable input leaves the node unpriced, never breaks the check
                size = None
            if size is not None:
                sizes[node_id] = size
                break
            why = why or _why_not(ref)
        if node_id not in sizes and ports and why and reasons is not None:
            reasons[node_id] = why
    return sizes
