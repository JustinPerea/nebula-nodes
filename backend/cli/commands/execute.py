from __future__ import annotations

import sys
from typing import Any

from ..client import NebulaClient
from ..formatter import format_run_results, format_graph

# Long enough for most image runs, short enough to finish inside an agent's
# shell-tool time limit (often 120 s). Video keeps running past it.
DEFAULT_WAIT = 100.0
MAX_RESULT_WAIT = 300.0

EXIT_RUNNING = 2
EXIT_CANCELLED = 3


def _report(result: dict[str, Any]) -> int:
    status = result.get("status")
    run_id = result.get("runId", "")
    if status == "running":
        print(
            f"Still running after {result.get('elapsed', 0)}s (run {run_id}). It keeps going, and its "
            "outputs land on the canvas.\n"
            f"  Wait for it:  nebula result {run_id} --wait 100\n"
            f"  Stop it:      nebula cancel {run_id}"
        )
        return EXIT_RUNNING
    if status == "failed":
        print(f"error: run {run_id} failed: {result.get('error', 'unknown error')}", file=sys.stderr)
        return 1
    if status == "cancelled":
        made = format_run_results({**result, "duration": None})
        print(f"Run {run_id} was stopped." + (f" Finished before the stop:\n{made}" if result.get("nodesExecuted") else ""))
        return EXIT_CANCELLED
    print(format_run_results(result))
    return 0


def run_node(client: NebulaClient, node_ref: str, wait: float = DEFAULT_WAIT) -> int:
    return _report(client.run_graph(target_node_id=node_ref, wait=wait))


def run_all(client: NebulaClient, wait: float = DEFAULT_WAIT) -> int:
    return _report(client.run_graph(wait=wait))


def run_result(client: NebulaClient, run_id: str, wait: float = 0) -> int:
    return _report(client.get_run(run_id, wait=max(0.0, min(wait, MAX_RESULT_WAIT))))


def run_cancel(client: NebulaClient, run_id: str) -> int:
    result = client.cancel_run(run_id)
    status = result.get("status")
    if status in ("cancelled", "cancelling"):
        print(f"Stopping run {run_id}. `nebula result {run_id}` shows what finished first.")
    elif status in ("completed", "failed"):
        print(f"Run {run_id} had already ended ({status}).")
    else:
        print(f"Run {run_id}: {status}")
    return 0


def run_status(client: NebulaClient) -> None:
    state = client.get_graph()
    nodes_data = client.get_nodes()
    node_defs = {n["id"]: n for n in nodes_data["nodes"]}
    print(format_graph(state, node_defs))
