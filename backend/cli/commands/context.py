from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_context


def run(client: NebulaClient) -> None:
    nodes_data = client.get_nodes()
    settings = client.get_settings()
    print(format_context(settings, nodes_data["nodes"]))
