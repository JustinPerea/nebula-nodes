from __future__ import annotations

import json
import sys

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str, port: str | None = None) -> int:
    """Print a World output's Gaussian splats as numbers (an Idol object, a
    3DGS .ply): Gaussian count, bounding box, file size, spherical-harmonics
    degree, opacity, seed, provider, model and axes. What MCP view_output
    gives as `splat`, from GET /api/graph/node/{id}/splat-summary.

    Exits 0 with the JSON on stdout, 1 with the reason on stderr (the node
    has no World output with a .ply splat, or the backend can't be reached).
    """
    try:
        summary = client.get_splat_summary(node_id, port)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0
