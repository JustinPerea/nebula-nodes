"""reference-set utility node.

A pure utility/glue node: it packs the images connected to its seven
role-labeled input ports (style, identity, composition, pose, lighting,
subject, background) into a ReferenceSetBundle and emits it on the
``reference_set`` output port. Each item pairs an image URL with the semantic
role of the port it arrived on and that role's weight param (default 1.0,
clamped to 0..1). Items are sorted by weight descending (stable for ties, so
equal weights keep port declaration order) so downstream handlers can read
precedence directly.

No network, no generation — this node is deterministic given its inputs and
params. Same typed-bundle pattern as handlers/camera_rig.py.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict

# The 7 semantic reference roles in declaration order. Must mirror
# frontend/src/lib/referenceRoles.ts (REFERENCE_ROLE_IDS) and the input ports
# / weight params in backend/data/node_definitions.json.
ROLE_PORTS: tuple[str, ...] = (
    "style",
    "identity",
    "composition",
    "pose",
    "lighting",
    "subject",
    "background",
)

WEIGHT_DEFAULT = 1.0
WEIGHT_MIN = 0.0
WEIGHT_MAX = 1.0


def _port_value(port: Any) -> Any:
    """Read a port's value whether it arrives as a PortValueDict or plain dict."""
    if port is None:
        return None
    if isinstance(port, dict):
        return port.get("value")
    return getattr(port, "value", None)


def _parse_weight(raw: Any) -> float:
    """Parse a weight param to a float clamped to [0, 1].

    Missing/empty/unparseable values fall back to 1.0 — a malformed slider
    value should not break graph execution (mirrors camera_rig._parse_field).
    """
    if raw is None or raw == "":
        return WEIGHT_DEFAULT
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return WEIGHT_DEFAULT
    return max(WEIGHT_MIN, min(WEIGHT_MAX, value))


async def handle_reference_set(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Pack connected images into a ReferenceSetBundle sorted by weight desc."""
    params = node.params or {}
    items: list[dict[str, Any]] = []
    for role in ROLE_PORTS:
        value = _port_value(inputs.get(role))
        if not value:
            continue
        weight = _parse_weight(params.get(f"{role}_weight"))
        # A multi-connection port arrives as a list of URLs; a single
        # connection is a scalar string. Both produce one item per URL.
        urls = value if isinstance(value, list) else [value]
        for url in urls:
            if not url:
                continue
            items.append({"url": url, "role": role, "weight": weight})
    # Python's sort is stable: weight ties keep port declaration order.
    items.sort(key=lambda item: item["weight"], reverse=True)
    return {"reference_set": {"type": "ReferenceSet", "value": {"items": items}}}
