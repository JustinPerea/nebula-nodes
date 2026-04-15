from __future__ import annotations

import sys
from typing import Any

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str, inputs: dict[str, str], params: dict[str, Any]) -> None:
    result = client.quick(node_id, inputs, params)
    outputs = result.get("outputs", {})

    if not outputs:
        print("No outputs produced.", file=sys.stderr)
        sys.exit(1)

    # Print only the output value(s) — for piping
    for port_id, port_val in outputs.items():
        if isinstance(port_val, dict):
            val = port_val.get("value", "")
        else:
            val = port_val
        if val:
            print(val)
