from __future__ import annotations

import os
import sys
from typing import Any

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str, inputs: dict[str, str], params: dict[str, Any]) -> None:
    if os.environ.get("NEBULA_DISABLE_QUICK") == "1":
        print(
            "nebula quick is disabled in this environment.\n"
            "Use graph mode instead — it syncs to the canvas:\n"
            "  nebula create <node>\n"
            "  nebula connect <source:port> <target:port>\n"
            "  nebula run-all",
            file=sys.stderr,
        )
        sys.exit(2)

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
