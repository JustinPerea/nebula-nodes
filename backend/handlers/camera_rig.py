"""camera-rig utility node.

A pure utility/glue node: it packs its numeric slider params into a
CameraRigBundle and emits it on the ``camera_rig`` output port. Downstream
generation/edit nodes can consume the bundle to ground camera direction in
typed, inspectable values (height, pitch, focal length, subject framing…)
instead of prose buried in a prompt.

No network, no generation — this node is deterministic given its params.
Same typed-bundle pattern as handlers/character_node.py.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict

# (param key, default) for every CameraRigBundle field. The defaults mirror the
# node definition (backend/data/node_definitions.json) so an untouched node
# emits exactly the bundle the Inspector sliders show.
_FIELDS: tuple[tuple[str, float], ...] = (
    ("height", 1.7),           # camera height in meters
    ("pitch", 0.0),            # degrees, -90 (straight down) to 90 (straight up)
    ("yaw", 0.0),              # degrees, 0–360 around the subject
    ("roll", 0.0),             # degrees, -45 to 45 (Dutch angle)
    ("focalLength", 35.0),     # mm
    ("subjectDistance", 3.0),  # meters from camera to subject
    ("focusDistance", 3.0),    # meters the lens is focused at
    ("subjectScreenX", 0.5),   # normalized 0–1 subject position in frame
    ("subjectScreenY", 0.5),   # normalized 0–1 subject position in frame
)


def _parse_field(raw: Any, default: float) -> float:
    """Parse a slider param to a float, falling back to the field default.

    Mirrors character_node._parse_strength: a malformed value (None, '', or
    unparseable) is treated as unset rather than raising — a bad slider value
    should not break graph execution.
    """
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


async def handle_camera_rig(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Pack the node's numeric params into a CameraRigBundle and emit it."""
    params = node.params or {}
    bundle = {key: _parse_field(params.get(key), default) for key, default in _FIELDS}
    return {"camera_rig": {"type": "CameraRig", "value": bundle}}
