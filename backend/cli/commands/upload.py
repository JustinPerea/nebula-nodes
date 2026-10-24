"""`nebula upload <file> [--at x,y]`: add a local image, clip, sound or
document to Nebula (MCP: upload_file).

Nebula copies it into its output folder and puts an Image Input, Video
Input, Audio Input or Document Input holding the copy on the canvas
(upload_client.py), at `--at` when given.
The spending check measures a size-priced node's input only from that
folder (services/input_sizes.py), so this is the step before running one on
a file of your own.
"""
from __future__ import annotations

import math
import sys

from ..client import NebulaClient

_OUTPUT_PORTS = {"Image": "image", "Video": "video", "Audio": "audio", "Document": "text"}


def _spot(at: str) -> dict[str, float]:
    """`--at 820,140` as {x, y}; exits with a one-line error otherwise."""
    parts = at.split(",")
    try:
        if len(parts) != 2:
            raise ValueError
        x, y = (float(part) for part in parts)
        if not (math.isfinite(x) and math.isfinite(y)):
            raise ValueError
    except ValueError:
        print(f"error: --at takes x,y (two numbers, e.g. --at 820,140), not {at!r}", file=sys.stderr)
        sys.exit(2)
    return {"x": x, "y": y}


def run(client: NebulaClient, source: str, at: str | None = None) -> None:
    import upload_client

    extra = {"position": _spot(at)} if at is not None else {}
    try:
        result = upload_client.upload(client.api, source, headers=client._identity_headers(), **extra)
    except upload_client.UploadError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    node = result.get("nodeId")
    holder = f"{result['kind']} Input {node}" if node else "Nebula's output folder"
    print(f"Added {result['filename']} as {holder}: {result['url']}")
    if node:
        # Each input node's one output port (node_definitions.json).
        port = _OUTPUT_PORTS.get(result["kind"], "image")
        print(f"Wire it in: nebula connect {node}:{port} <node>:<port>")
