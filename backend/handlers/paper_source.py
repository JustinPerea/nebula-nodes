"""Execution consumes the pinned snapshot only. It never reads/refreshes Paper."""
import re

from services.paper_routes import paper_sources


async def handle_paper_source(node, inputs, api_keys):
    source = node.params.get("_paperSource", {})
    pinned = source.get("snapshot")
    if not isinstance(pinned, dict) or not pinned:
        raise ValueError("Link and export a Paper object before running")
    snapshot_id, content_hash = pinned.get("id"), pinned.get("hash")
    if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
               for value in (snapshot_id, content_hash)):
        raise ValueError("Pinned Paper snapshot requires its exact ID and SHA-256 hash; refresh or reconnect before running")
    snapshot = paper_sources.snapshot(snapshot_id, content_hash)
    return {"image": {"type": "Image", "value": snapshot["filePath"]}}
