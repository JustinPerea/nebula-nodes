"""`nebula keys`: which provider keys are set (MCP get_settings).

The CLI is an agent surface and never holds the person token, so GET
/api/settings answers it with a bare `***` for a set key (Justin, Q55 a:
"Only the app (your person token) gets the endings. Everything else learns
which providers are set, and nothing more"). It goes through
project_client.get_settings, which turns every key into true or false
whatever the route sent, so no part of a key is ever printed. `--json`
prints what get_settings returns. `nebula providers` says whether they work.
"""
from __future__ import annotations

import json

import project_client

from ..client import NebulaClient
from ..formatter import format_keys


def run(client: NebulaClient, *, as_json: bool = False) -> None:
    settings = client.shared(project_client.get_settings)
    if as_json:
        print(json.dumps(settings, indent=2, ensure_ascii=False))
        return
    nodes_data = client.get_nodes()
    print(format_keys(settings, nodes_data["nodes"]))
