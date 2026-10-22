"""`nebula upload <file>`: add a local image or clip to Nebula (MCP: upload_file).

Nebula copies it into its output folder and puts an Image Input, Video
Input or Document Input holding the copy on the canvas (upload_client.py).
The spending check measures a size-priced node's input only from that
folder (services/input_sizes.py), so this is the step before running one on
a file of your own.
"""
from __future__ import annotations

import sys

from ..client import NebulaClient

_OUTPUT_PORTS = {"Image": "image", "Video": "video", "Document": "text"}


def run(client: NebulaClient, source: str) -> None:
    import upload_client

    try:
        result = upload_client.upload(client.api, source, headers=client._identity_headers())
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
