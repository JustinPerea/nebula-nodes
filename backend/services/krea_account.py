"""Shared plumbing for Krea nodes that run on the connected Krea account.

Every call here happens only from an explicit graph run. Tool arguments are
validated against the schema Krea's MCP server advertises before anything is
sent, and accepted jobs are cancelled if Nebula stops waiting for them.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx
from jsonschema import Draft202012Validator

from models.graph import GraphNode
from services.cancellation import schedule_detached_cancel
from services.krea_mcp_generation import KreaTools, _cancel, _job, poll_job, tool_value, upload_asset

ACCOUNT_ONLY_MESSAGE = "This Krea feature is only available on a connected Krea account"


def account_param(definition: dict | None) -> dict | None:
    if not definition or definition.get("apiProvider") != "krea":
        return None
    return next((param for param in definition.get("params", []) if param.get("key") == "_kreaAuth"), None)


def is_account_only(definition: dict | None) -> bool:
    param = account_param(definition)
    return bool(param) and [option.get("value") for option in param.get("options", [])] == ["mcp"]


def uses_account(node: GraphNode, definition: dict | None) -> bool:
    """A saved node uses the Krea account only if it offers that choice and
    chose it; old nodes without the param keep API-token billing."""
    if not account_param(definition):
        return False
    return is_account_only(definition) or node.params.get("_kreaAuth", "api-token") == "mcp"


class AccountTools:
    """Exact-argument access to the live Krea MCP tool list."""

    def __init__(self, tools: KreaTools, revision: str | None):
        self.tools = tools
        self.revision = revision

    def has(self, name: str) -> bool:
        return name in self.tools.tools

    def check(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = self.tools.tools.get(name)
        if tool is None:
            raise RuntimeError(f"Your Krea connection does not offer {name}; nothing was sent")
        try:
            Draft202012Validator(tool.inputSchema).validate(arguments)
        except Exception as exc:
            raise RuntimeError(f"Krea {name} inputs do not match its current schema; nothing was sent") from exc
        return arguments

    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        arguments = self.check(name, arguments or {})
        return tool_value(await self.tools.session.call_tool(name, arguments))

    async def upload(self, client: httpx.AsyncClient, value: Any) -> str:
        """Return a URL Krea can read: remote URLs pass through, local media is uploaded."""
        from handlers.krea_gateway import _asset_data
        if isinstance(value, dict):
            value = value.get("url") or value.get("image_url") or value.get("value")
        if not isinstance(value, str) or not value.strip():
            raise ValueError("Krea needs a media URL or a local file")
        asset = _asset_data(value.strip())
        return value.strip() if asset is None else await upload_asset(self.tools, client, asset)


@asynccontextmanager
async def account_tools() -> AsyncIterator[AccountTools]:
    from services.krea_connector import connection_revision, get_connector
    revision = connection_revision()
    async with get_connector().session(expected_revision=revision) as session:
        tools = KreaTools(session, await get_connector().list_tools(session))
        yield AccountTools(tools, revision)


async def run_job(account: AccountTools, tool: str, arguments: dict[str, Any], node_id: str, emit, *,
                  max_polls: int = 300, poll_interval: float = 2.0) -> dict[str, Any]:
    """Submit one job-returning tool call and poll it; cancel if we stop early."""
    from handlers.krea_gateway import _JOB_ID
    job = _job(await account.call(tool, arguments))
    job_id = str(job.get("job_id") or job.get("id") or "")
    if not _JOB_ID.fullmatch(job_id):
        raise RuntimeError(f"Krea {tool} returned no valid job id; it was not retried")
    settled = False

    def done():
        nonlocal settled
        settled = True

    try:
        return await poll_job(account.tools, job, node_id, emit, max_polls=max_polls,
                              poll_interval=poll_interval, on_completed=done)
    finally:
        if not settled:
            revision = account.revision
            schedule_detached_cancel(lambda: _cancel(job_id, revision))
