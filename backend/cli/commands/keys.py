from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_keys


def run(client: NebulaClient) -> None:
    settings = client.get_settings()
    nodes_data = client.get_nodes()
    print(format_keys(settings, nodes_data["nodes"]))
