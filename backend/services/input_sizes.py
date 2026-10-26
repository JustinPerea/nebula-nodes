"""The size of a run's input file, read when the run is checked, for prices
that depend on it (model_pricing ``sizing``: SeedVR2 per megapixel, FLUX
Video Upscale per megapixel-second, FLUX Video Edit per second).

What may be measured (security review 2026-10-21, finding 1). The price is
measured when the run is checked, but the handler reads the file later
(other nodes may run first). So only inputs that no agent reaching Nebula
through its API can change after the check are measured:

- an inline ``data:`` image: it lives in the run's params;
- a file inside Nebula's output folder (OUTPUT_ROOT). Its path as given,
  before links are followed, must be inside the folder with no ``..`` part,
  and its resolved path must be inside too, so a link in the folder can't
  point somewhere that changes. A served ``/api/outputs/...`` ref and a
  loopback URL to one name such a file. Nothing an API-only agent runs
  creates, overwrites or renames over a file there (the audit is in
  docs/notes/2026-10-21-feat-price-from-input-size.md), and Nebula's own
  writers put a file there whole: under a dot-name first (never measured),
  or in a run folder that is only measured once its writer has finished
  (services/output.py ``is_being_written``).

Anything else is OUTSIDE (a workspace or temp file can be rewritten between
the check and the read) and stays unpriced, so an agent adds the file to
Nebula first (``upload_file``, ``nebula upload``) or proposes the run. An
outside URL is REMOTE and is never downloaded.

How a clip is measured (finding 2): as an upper bound of what a provider
that demuxes and decodes the file would process. Every video stream is
looked at; exactly one that isn't an attached picture is measured, more
than one (or none) leaves the clip unmeasured. Frames and seconds come from
that stream's demuxed packets (read, never decoded) as well as its header:
frames = max(packets, header nb_frames, ceil(seconds x avg fps)), seconds =
max(stream duration, format duration, packet span). A packet that signals a
parameter change (new extradata, a param change) leaves it unmeasured. The
packet listing is read a line at a time, keeping only a count and a span,
and past MAX_PROBE_PACKETS the clip is unmeasured, so a clip made of
millions of tiny packets can't fill the backend's memory.
Known limit: a resolution change carried inside the coded bitstream (an
in-band H.264/HEVC SPS, a VP9 resize) is visible only to a decoder, so such
a clip is measured at its header size. An image with more than one frame
or size (GIF, APNG, animated WebP, multi-page TIFF, ICO/ICNS, MPO) is left
unmeasured: which frame a provider takes isn't known.

All of it reads files and may run ffprobe for many seconds, so it runs in a
worker thread (``measure_run``, asyncio.to_thread); called on the event
loop it raises instead of blocking every other request.

Where the input comes from (run_input_sizes): an Image Input or Video Input
in the run gives the file it holds; a node outside the run gives the output
it already has (a proposal's cached ancestor). Any other node in the same
run makes its output during the run, so its size isn't known yet, and the
node it feeds is unpriced until it is.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import math
import os
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import unquote, urlsplit

from services import model_pricing

# Image and Video Input nodes: their output is the file they hold.
INPUT_NODES = {"image-input": "Image", "video-input": "Video"}
# An inline image is decoded in memory; past this it isn't measured.
MAX_DATA_URI_CHARS = 64 * 1024 * 1024
_CACHE: OrderedDict[tuple[Any, ...], dict[str, Any] | None] = OrderedDict()
_CACHE_SIZE = 256

# Each ffprobe pass (the header, then every packet of the one video stream)
# gets the time left of this. Reading every packet means reading the whole
# file from disk: a few seconds for a multi-gigabyte local clip. Past it the
# clip is unmeasured, which is the proposal path, never a guess.
SIZE_PROBE_TIMEOUT_SECONDS = 60
# Packet side data that says the stream's parameters (its size among them)
# change partway: the mov demuxer marks a switch between sample
# descriptions with new extradata.
_PARAMETER_CHANGES = frozenset({"New Extradata", "Param Change"})
# The packet pass reads ffprobe's output a line at a time and keeps only a
# count and a span, so the backend's memory doesn't grow with the clip. Past
# this many packets the clip is unmeasured (the proposal path): over nine
# hours at 60 fps, far beyond any clip a size-priced node takes, and a
# million-packet clip made tiny on purpose stops here instead of filling
# memory.
MAX_PROBE_PACKETS = 2_000_000
# A line of the default writer is "key=value" for a timestamp or a side data
# name: a few dozen characters. A longer one isn't ffprobe's packet output.
MAX_PROBE_LINE = 4096


def _off_loop() -> None:
    """Refuse to run on an event loop: measuring blocks for as long as ffprobe reads."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError("input_sizes reads files and runs ffprobe, so it runs off the event loop "
                       "(input_sizes.measure_run, or asyncio.to_thread)")


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) and number > 0 else 0.0


def _rate(value: Any) -> float:
    text = str(value or "")
    if "/" in text:
        num, _, den = text.partition("/")
        return _number(num) / _number(den) if _number(den) else 0.0
    return _number(text)


def _ffprobe(path: Path, entries: list[str], deadline: float) -> dict[str, Any] | None:
    from services.child_env import scrubbed_env
    from services.ffmpeg import _media_input_args

    left = deadline - time.monotonic()
    if left <= 0:
        return None
    cmd = ["ffprobe", "-v", "error", *entries, "-of", "json",
           "-enable_drefs", "0", "-use_absolute_path", "0", *_media_input_args(path)]
    # The header pass only: its output is one entry per stream. stderr isn't
    # kept, so a file that makes ffprobe complain can't grow a buffer.
    done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=left,
                          env=scrubbed_env(), check=False)
    if done.returncode != 0:
        return None
    data = json.loads(done.stdout)
    return data if isinstance(data, dict) else None


def _scan_packets(path: Path, index: int, deadline: float) -> tuple[int, float] | None:
    """(packet count, timestamp span in seconds) of one stream, read from
    ffprobe's packets as they come (demux only, nothing decoded); None when
    the stream signals a parameter change, has more than MAX_PROBE_PACKETS,
    prints something that isn't the default writer's packet output, or the
    deadline passes (ffprobe is killed then, even mid-read).

    Never ``capture_output``: the whole listing would sit in memory, about
    0.8 KB a packet once parsed (security review 2026-10-21)."""
    from services.child_env import scrubbed_env
    from services.ffmpeg import _media_input_args

    left = deadline - time.monotonic()
    if left <= 0:
        return None
    cmd = ["ffprobe", "-v", "error", "-select_streams", str(index),
           "-show_entries", "packet=pts_time,dts_time,duration_time:packet_side_data=side_data_type",
           "-of", "default", "-enable_drefs", "0", "-use_absolute_path", "0", *_media_input_args(path)]
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                               env=scrubbed_env(), text=True, encoding="utf-8", errors="replace")
    # A stalled ffprobe blocks the read itself, so the deadline kills it.
    timer = threading.Timer(left, process.kill)
    timer.daemon = True
    timer.start()
    count, start, end = 0, math.inf, -math.inf
    stamp: float | None = None
    duration = 0.0
    finished = False
    try:
        while True:
            line = process.stdout.readline(MAX_PROBE_LINE + 1)
            if not line:
                break
            if not line.endswith("\n") or time.monotonic() > deadline:
                return None  # overlong, cut off, or out of time
            line = line.rstrip("\n")
            if line == "[PACKET]":
                count += 1
                if count > MAX_PROBE_PACKETS:
                    return None
                stamp, duration = None, 0.0
            elif line == "[/PACKET]":
                if stamp is not None:
                    start, end = min(start, stamp), max(end, stamp + duration)
            elif line.startswith("side_data_type="):
                if line.partition("=")[2] in _PARAMETER_CHANGES:
                    return None  # its size can change partway
            elif line.startswith(("pts_time=", "dts_time=")):
                key, _, value = line.partition("=")
                try:
                    at = float(value)
                except ValueError:
                    continue  # "N/A"
                if math.isfinite(at) and (stamp is None or key == "pts_time"):
                    stamp = at  # pts when it has one, else dts
            elif line.startswith("duration_time="):
                duration = _number(line.partition("=")[2])
            elif line not in ("[SIDE_DATA]", "[/SIDE_DATA]"):
                return None  # not the packet listing this asked for
        left = deadline - time.monotonic()
        finished = left > 0 and process.wait(timeout=left) == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if process.stdout is not None:
            process.stdout.close()
    if not finished:
        return None
    return count, (end - start if end > start else 0.0)


def _probe_video(path: Path) -> dict[str, Any] | None:
    """A local clip as {width, height, seconds, frames}, an upper bound of
    what a provider demuxing and decoding it would process (the module
    docstring); None when it can't be bounded.

    Two ffprobe passes, both demux only (no -show_frames, nothing decoded):
    every stream's header, then every packet of the one video stream, read
    as it comes and capped (_scan_packets, MAX_PROBE_PACKETS). Same
    input policy as every other probe (services/ffmpeg.py: local files only,
    allow-listed single-file containers, no external references). It lives
    here, not in services/ffmpeg.py, so no handler reaches a process spawn
    through it (tests/test_node_readiness.py).

    The frame rate in the bound is avg_frame_rate (frames over duration),
    never r_frame_rate: ffmpeg's r_frame_rate is a guess at the stream's base
    rate, and on a phone's variable-rate clip it is often the container's
    timescale (600, 120), which would multiply a normal clip's frames many
    times over. avg_frame_rate matches a constant-rate clip's frame count,
    and the packet count is in the max beside it, so a low header can't
    bring the count under the frames the demuxer delivers."""
    deadline = time.monotonic() + SIZE_PROBE_TIMEOUT_SECONDS
    try:
        header = _ffprobe(path, [
            "-show_entries",
            "stream=index,codec_type,width,height,nb_frames,avg_frame_rate,r_frame_rate,duration"
            ":stream_disposition=attached_pic:format=duration",
        ], deadline)
        if header is None:
            return None
        videos = [stream for stream in header.get("streams") or []
                  if isinstance(stream, dict) and stream.get("codec_type") == "video"]
        real = [stream for stream in videos
                if not int((stream.get("disposition") or {}).get("attached_pic") or 0)]
        if len(real) != 1:
            return None  # none, or a second clip a provider might take instead
        stream = real[0]
        index = int(stream["index"])
        width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
        scanned = _scan_packets(path, index, deadline)
    except (OSError, ValueError, TypeError, KeyError, IndexError, subprocess.TimeoutExpired):
        return None
    if scanned is None:
        return None
    packet_count, span = scanned
    seconds = max(_number(stream.get("duration")), _number((header.get("format") or {}).get("duration")), span)
    nb_frames = str(stream.get("nb_frames") or "")
    fps = _rate(stream.get("avg_frame_rate"))
    frames = max(packet_count, int(nb_frames) if nb_frames.isdigit() else 0,
                 math.ceil(seconds * fps - 1e-6) if seconds > 0 and fps > 0 else 0)
    if width <= 0 or height <= 0 or seconds <= 0 or frames <= 0:
        return None
    return {"width": width, "height": height, "seconds": seconds, "frames": frames}


def _image_size(source: Any) -> dict[str, Any] | None:
    """An image's {width, height} from its header (Pillow's lazy open), or
    None when it has more than one frame or size (the module docstring)."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(source) as image:  # lazy: reads headers, not pixels
            frames = int(getattr(image, "n_frames", 1) or 1)
            sizes = image.info.get("sizes")
            if frames != 1 or (sizes and len(sizes) > 1):
                return None
            width, height = image.size
    except (OSError, ValueError, TypeError, EOFError, UnidentifiedImageError, Image.DecompressionBombError):
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


# Why a sized node's input wasn't measured (run_input_sizes ``reasons``), so
# the refusal says what is true and what to do (agent_spend.decide).
PENDING = "pending"        # made in this run, or its node hasn't run, or Nebula is still writing it
REMOTE = "remote"          # a file on another host: never downloaded for a price
OUTSIDE = "outside"        # a local file outside Nebula's output folder: it could change after the check
UNREADABLE = "unreadable"  # missing, not an image or clip it can measure, or outside the allowed folders
WIRES = "wires"            # more than one wire into the measured port
UNWIRED = "unwired"        # nothing wired into it


def _within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def _in_a_workspace(path: Path) -> bool:
    from services.agent_workspaces import workspace_deny_roots

    return any(_within(path, root.resolve()) or _within(path, Path(os.path.abspath(root)))
               for root in workspace_deny_roots(None))


def _locate(ref: str) -> tuple[Path | None, str]:
    """(the stored file a ref names, "") when it may be measured, else
    (None, why): REMOTE, OUTSIDE, PENDING or UNREADABLE (module docstring)."""
    from services.file_access import ProtectedPathError, require_allowed_path
    from services.output import OUTPUT_ROOT, is_being_written, is_local_output_url

    if not isinstance(ref, str) or not ref.strip() or ref.startswith("data:"):
        return None, UNREADABLE
    text = ref
    if ref.startswith(("http://", "https://")):
        if not is_local_output_url(ref):
            return None, REMOTE
        text = urlsplit(ref).path  # a loopback URL to /api/outputs is that file
    root = Path(OUTPUT_ROOT)
    if text.startswith("/api/outputs/"):
        try:
            rel = unquote(text[len("/api/outputs/"):], errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None, UNREADABLE
        parts = rel.split("/")
        if ".." in parts:
            return None, OUTSIDE
        if any(part in ("", ".") or "\\" in part or any(ord(ch) < 32 or ord(ch) == 127 for ch in part)
               for part in parts):
            return None, UNREADABLE
        lexical = root.joinpath(*parts)
    elif os.path.isabs(text):
        lexical = Path(text)  # pathlib drops "." parts and keeps ".."
        if ".." in lexical.parts:
            return None, OUTSIDE
    else:
        return None, UNREADABLE
    try:
        resolved = require_allowed_path(lexical)
    except (ProtectedPathError, OSError, RuntimeError, ValueError):
        return None, UNREADABLE
    if not _within(lexical, root) or not _within(resolved, root.resolve()) or _in_a_workspace(resolved):
        return (None, OUTSIDE) if resolved.is_file() else (None, UNREADABLE)
    if lexical.name.startswith(".") or resolved.name.startswith(".") or is_being_written(resolved):
        return None, PENDING  # Nebula's partial and temporary files, a run still writing
    if not resolved.is_file():
        return None, UNREADABLE
    return resolved, ""


def store_path(ref: str) -> Path | None:
    """The file in Nebula's output folder a ref names, when it may be
    measured (module docstring); None otherwise."""
    return _locate(ref)[0]


def measure(ref: Any, kind: str, *, inline: bool = True) -> dict[str, Any] | None:
    """{width, height} for an image, {width, height, seconds, frames} for a
    clip; None when it can't be known here. Only an inline image (with
    ``inline``) and a file in Nebula's output folder are read (module
    docstring). Off the event loop only."""
    _off_loop()
    if not isinstance(ref, str):
        return None
    if ref.startswith("data:"):
        return _data_uri_size(ref) if kind == "Image" and inline else None
    path = store_path(ref)
    if path is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    # A rewrite in place keeps size and can keep mtime (os.utime), but not
    # the inode change time; a replace changes the inode.
    key = (str(path), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, kind)
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


def _why_not(ref: str | None) -> str:
    if ref is None:
        return PENDING
    if ref.startswith("data:"):
        return UNREADABLE
    why = _locate(ref)[1]
    return why or UNREADABLE  # a stored file it found but couldn't measure


def needs_measuring(items: Iterable[Mapping[str, Any]], pricing: Mapping[str, Any]) -> bool:
    """Whether any of these run nodes is priced from its input's size."""
    entries = pricing.get("nodes") or {}
    return any(model_pricing.sizing_ports(entries.get(str(item.get("definitionId") or ""))) for item in items)


def run_input_sizes(
    items: Iterable[Mapping[str, Any]],
    edges: Iterable[tuple[str, str | None, str, str | None]],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    nodes: Mapping[str, Any] | None = None,
    *,
    reasons: dict[str, str] | None = None,
    connected: dict[str, tuple[str, list[tuple[str, str | None]]]] | None = None,
) -> dict[str, dict[str, Any]]:
    """{node id: measured input} for each run node whose price reads its
    input's size and whose input is known (see the module docstring).

    ``items`` are the run's nodes ({id, definitionId, params}); ``edges``
    are (source, source handle, target, target handle); ``nodes`` maps any
    node id to the node (a dict or a GraphNode with params and outputs), for
    sources outside the run. One wire into the measured port, or none known.
    ``reasons``, when given, gets {node id: why} for each sized node left
    unmeasured (PENDING, REMOTE, OUTSIDE, UNREADABLE, WIRES, UNWIRED): its
    first measured port's reason. ``connected``, when given, gets {node id:
    (port, [(source, source handle), ...])} for each node left unmeasured
    because more than one input is connected to that port (WIRES), so the
    refusal can name them. Off the event loop only (measure_run)."""
    _off_loop()
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
                if why is None and wires and connected is not None:
                    connected[node_id] = (port, list(wires))
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
        if connected is not None and (node_id in sizes or why != WIRES):
            connected.pop(node_id, None)
    return sizes


@dataclass(frozen=True)
class Measured:
    """What run_input_sizes found for one run: the measured inputs, and why
    each other sized node has none. Passed to the synchronous spending check
    (main._require_spend_approval) and the proposal estimate."""
    sizes: dict[str, dict[str, Any]] = field(default_factory=dict)
    reasons: dict[str, str] = field(default_factory=dict)
    # {node id: (port, [(source, source handle), ...])} for each WIRES node.
    connected: dict[str, tuple[str, list[tuple[str, str | None]]]] = field(default_factory=dict)


async def measure_run(
    items: list[Mapping[str, Any]],
    edges: list[tuple[str, str | None, str, str | None]],
    pricing: Mapping[str, Any],
    definitions: Mapping[str, Mapping[str, Any]],
    nodes: Mapping[str, Any] | None = None,
) -> Measured:
    """run_input_sizes in a worker thread, so a long probe never holds up
    the event loop (every other request waits on it). Nothing to do when no
    node is priced from its input."""
    if not needs_measuring(items, pricing):
        return Measured()
    reasons: dict[str, str] = {}
    connected: dict[str, tuple[str, list[tuple[str, str | None]]]] = {}
    sizes = await asyncio.to_thread(run_input_sizes, items, edges, pricing, definitions, nodes, reasons=reasons,
                                    connected=connected)
    return Measured(sizes, reasons, connected)
