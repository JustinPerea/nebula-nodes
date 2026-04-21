from __future__ import annotations

import sys

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str) -> None:
    """Print the absolute local filesystem path of a node's primary image.

    Exits 0 on success (path printed to stdout), exits 1 on error (message
    printed to stderr). Used by the chat primer to let Claude Read canvas
    images.
    """
    try:
        result = client.get_node_image_path(node_id)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    print(result["path"])
