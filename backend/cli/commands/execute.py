from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_run_results, format_graph


def run_node(client: NebulaClient, node_ref: str) -> None:
    result = client.run_graph(target_node_id=node_ref)
    print(format_run_results(result))


def run_all(client: NebulaClient) -> None:
    result = client.run_graph()
    print(format_run_results(result))


def run_status(client: NebulaClient) -> None:
    state = client.get_graph()
    nodes_data = client.get_nodes()
    node_defs = {n["id"]: n for n in nodes_data["nodes"]}
    print(format_graph(state, node_defs))
