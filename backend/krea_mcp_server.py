"""Read-only Krea MCP stdio bridge to the credential-owning Nebula backend."""
from __future__ import annotations

import argparse
from typing import Any

import anyio
import httpx
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from services.krea_agent_mcp import KREA_MCP_PRIMER, KREA_READONLY_TOOLS, loopback_backend_url, resolve_nebula_url


ALLOWED_TOOLS = KREA_READONLY_TOOLS


class KreaDiscoveryBridge:
    def __init__(self, url: str, client: httpx.AsyncClient):
        self.url = loopback_backend_url(url)
        self.client = client

    async def list_tools(self) -> list[types.Tool]:
        response = await self.client.get(f"{self.url}/api/krea/tools")
        # Disconnected Krea, or an older backend, should not break the agent turn.
        if response.status_code in {401, 403, 404, 409, 503}:
            return []
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("tools"), list):
            raise ValueError("Nebula returned an invalid Krea discovery tool list")
        return [
            types.Tool.model_validate(tool)
            for tool in payload["tools"]
            if isinstance(tool, dict) and tool.get("name") in ALLOWED_TOOLS
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        if name not in ALLOWED_TOOLS:
            return self._error("Only read-only Krea discovery tools are available")
        try:
            response = await self.client.post(
                f"{self.url}/api/krea/tools/call",
                json={"name": name, "arguments": arguments},
            )
            response.raise_for_status()
            return types.CallToolResult.model_validate(response.json())
        except httpx.HTTPStatusError as exc:
            return self._error(f"Krea discovery unavailable (Nebula HTTP {exc.response.status_code})")
        except (httpx.RequestError, ValueError):
            return self._error("Krea discovery unavailable; check the Krea connection in Nebula")

    @staticmethod
    def _error(message: str) -> types.CallToolResult:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=message)], isError=True
        )


def create_server(bridge: KreaDiscoveryBridge) -> Server:
    server = Server("Nebula Krea discovery", instructions=KREA_MCP_PRIMER)

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return await bridge.list_tools()

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        return await bridge.call_tool(name, arguments)

    return server


async def run_server(url: str) -> None:
    async with httpx.AsyncClient(timeout=20.0, trust_env=False, follow_redirects=False) as client:
        server = create_server(KreaDiscoveryBridge(url, client))
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=resolve_nebula_url(), help="Loopback Nebula backend origin")
    args = parser.parse_args()
    anyio.run(run_server, loopback_backend_url(args.url))


if __name__ == "__main__":
    main()
