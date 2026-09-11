from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_selection


def run(client: NebulaClient) -> None:
    print(format_selection(client.get_selection()))
