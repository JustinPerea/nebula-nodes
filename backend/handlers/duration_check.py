"""video-duration-check analyzer node.

Local analyzer (no external API): probes the incoming video with ffprobe and
compares the landed duration against the requested duration. The requested
duration comes from the `requested_duration` input port (Text) when connected,
otherwise from the `requested_duration` float param.

Outputs:
  - ``text`` — JSON report with ``requested_duration``, ``landed_duration``,
    ``match`` (boolean), and ``delta_seconds`` (landed − requested; positive
    means the video ran long).
  - ``match`` — ``"true"`` / ``"false"`` string for downstream branching.

Match tolerance is 0.5s: generation providers quantize duration to their own
grid, so a 7s request landing at 7.4s is fine — but landing at 15.06s (the
friction-doc case this node exists to catch) is reported as a mismatch.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.ffmpeg import ffprobe_video
from services.output import resolve_output_ref

MATCH_TOLERANCE_SECONDS = 0.5


def _resolve_video_source(value: str) -> str:
    """Resolve a Video port value to something ffprobe can read.

    - ``/api/outputs/<rel>`` served URLs map back to their on-disk path under
      OUTPUT_ROOT (via the shared resolve_output_ref helper).
    - Raw http(s) URLs are **rejected** — passing them to ffprobe would make
      the server fetch arbitrary URLs, an SSRF vector (e.g. a user pointing at
      ``http://169.254.169.254/latest/meta-data/``).
    - Anything else is treated as a filesystem path and must exist.
    """
    resolved = resolve_output_ref(value)
    if resolved.startswith(("http://", "https://")):
        raise ValueError(
            "Remote URLs are not supported for video probing. "
            "Use a local file or /api/outputs/ reference."
        )
    path = Path(resolved).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Source video not found: {value}")
    return str(path)


def _parse_param_duration(raw: Any) -> float | None:
    """Parse the requested_duration param; '' / unset / unparseable → None.

    Mirrors character_node._parse_strength: a malformed optional param is
    treated as unset rather than raising, so the node falls through to the
    "required" error with a clear message.
    """
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


async def handle_duration_check(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Probe the video and compare landed vs requested duration."""
    video_input = inputs.get("video")
    if video_input is None or not video_input.value:
        raise ValueError("video port is required for video-duration-check")
    source = _resolve_video_source(str(video_input.value))

    # Input port wins over the param when connected with a non-empty value.
    requested: float | None
    req_input = inputs.get("requested_duration")
    if req_input is not None and req_input.value not in (None, ""):
        try:
            requested = float(req_input.value)
        except (TypeError, ValueError):
            raise ValueError(
                f"requested_duration must be a number, got: {req_input.value!r}"
            ) from None
    else:
        requested = _parse_param_duration(node.params.get("requested_duration"))

    if requested is None:
        raise ValueError(
            "requested_duration is required: connect the input port or set the param"
        )

    probe = await ffprobe_video(source)

    # The match decision uses the raw, unrounded delta: rounding the landed
    # duration first could pull a value just past the tolerance boundary back
    # inside it (e.g. 5.5004s rounds to 5.5s and would falsely match a 5.0s
    # request). Rounding is for the human-readable report only.
    match = abs(probe.duration - requested) <= MATCH_TOLERANCE_SECONDS

    landed = round(probe.duration, 3)
    delta = round(probe.duration - requested, 3)

    report = json.dumps(
        {
            "requested_duration": requested,
            "landed_duration": landed,
            "match": match,
            "delta_seconds": delta,
        }
    )
    return {
        "text": {"type": "Text", "value": report},
        "match": {"type": "Text", "value": "true" if match else "false"},
    }
