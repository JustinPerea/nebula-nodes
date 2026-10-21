"""`nebula providers`: whether each provider's key works, and whether the
Krea account is connected (MCP provider_status).

Nebula checks keys only with free, read-only calls (never a generation) and
keeps the results for 5 minutes; `--refresh` checks again now. A probe's
detail never quotes a key (services/settings._probe_error_detail), and the
Krea sign-in link stays with the person: the CLI says one is waiting.
`--json` prints what provider_status returns.
"""
from __future__ import annotations

import json

import project_client

from ..client import NebulaClient
from ..formatter import format_providers


def run(client: NebulaClient, *, refresh: bool = False, as_json: bool = False) -> None:
    status = client.shared(project_client.provider_status, refresh=refresh)
    if as_json:
        print(json.dumps(status, indent=2, ensure_ascii=False))
        return
    print(format_providers(status))
