from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


DEFAULT_NEBULA_URL = "http://127.0.0.1:8000"
_base_url = os.environ.get("NEBULA_URL", DEFAULT_NEBULA_URL).rstrip("/")

mcp = FastMCP(
    "Nebula Nodes",
    instructions=(
        "Read the active Nebula canvas selection before interpreting vague references "
        "such as 'these nodes' or 'the selected images'. Selection is ephemeral and "
        "resolved against the live graph on every call."
    ),
)


def set_nebula_url(url: str) -> None:
    global _base_url
    _base_url = url.rstrip("/")


@mcp.tool()
def get_selected_nodes() -> dict[str, Any]:
    """Return the nodes currently selected in Nebula's active canvas.

    The result includes bounded, redacted parameters, available output ports,
    and connections touching the selection. Deleted/stale IDs are never
    returned as live nodes.
    """
    try:
        response = httpx.get(f"{_base_url}/api/canvas/selection", timeout=10.0)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError(
            f"Cannot read Nebula selection from {_base_url}: {exc}"
        ) from exc
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Nebula selection endpoint returned an invalid response")
    return payload


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Nebula Nodes MCP server")
    parser.add_argument(
        "--url",
        default=_base_url,
        help=f"Nebula backend URL (default: {DEFAULT_NEBULA_URL})",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args(sys.argv[1:])
    set_nebula_url(args.url)
    mcp.run()
