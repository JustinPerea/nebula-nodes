"""`nebula context`: an agent's first call, on GET /api/agent/start.

MCP `start_here` prints the same route, so the CLI and MCP give a first turn
the same thing (services/agent_start.py). `--json` prints it as it comes.
"""
from __future__ import annotations

import json

from ..client import NebulaClient
from ..formatter import format_start


def run(client: NebulaClient, *, as_json: bool = False) -> None:
    start = client.get_start()
    if as_json:
        print(json.dumps(start, ensure_ascii=False, indent=2))
        return
    print(format_start(start))
