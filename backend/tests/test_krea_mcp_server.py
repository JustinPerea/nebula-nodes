"""MCP protocol + backend proxy fixtures; no Krea credentials or paid calls."""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anyio
import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from krea_mcp_server import KreaDiscoveryBridge, create_server


SCHEMA = {
    "type": "object", "required": ["model_id"], "additionalProperties": False,
    "properties": {"model_id": {"type": "string", "enum": ["image/example"]}},
}
TOOL = {"name": "get_model_schema", "description": "Actual discovered fixture", "inputSchema": SCHEMA}
RESULT = {
    "content": [{"type": "text", "text": "schema fixture"}],
    "structuredContent": {"schema": {"type": "object"}}, "isError": False,
    "_meta": {"fixture": True},
}


@pytest.mark.asyncio
async def test_discovery_retains_exact_schema_and_blocks_all_write_tools():
    seen = []

    def respond(request):
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"tools": [TOOL, {"name": "generate", "inputSchema": {"type": "object"}}]})
        assert json.loads(request.content) == {"name": "get_model_schema", "arguments": {"model_id": "image/example"}}
        return httpx.Response(200, json=RESULT)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        bridge = KreaDiscoveryBridge("http://127.0.0.1:8033", client)
        tools = await bridge.list_tools()
        assert [tool.name for tool in tools] == ["get_model_schema"]
        assert tools[0].inputSchema == SCHEMA
        result = await bridge.call_tool("get_model_schema", {"model_id": "image/example"})
        assert result.model_dump(by_alias=True, exclude_none=True) == RESULT
        for forbidden in ("generate", "cancel_job", "get_upload_url", "upload_asset", "execute_node_app", "get_job"):
            assert (await bridge.call_tool(forbidden, {})).isError
    assert [(request.method, request.url.path) for request in seen] == [
        ("GET", "/api/krea/tools"), ("POST", "/api/krea/tools/call"),
    ]
    assert all("authorization" not in request.headers for request in seen)


@pytest.mark.asyncio
async def test_disconnected_discovery_is_empty_and_call_error_does_not_leak_response():
    async with httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(401, json={"detail": "sensitive fixture"})
    )) as client:
        bridge = KreaDiscoveryBridge("http://127.0.0.1:8033", client)
        assert await bridge.list_tools() == []
        result = await bridge.call_tool("list_models", {})
        assert result.isError
        assert "401" in result.content[0].text
        assert "sensitive fixture" not in result.model_dump_json()


@pytest.mark.asyncio
async def test_real_mcp_handshake_list_call_and_schema_validation_over_memory_transport():
    posts = []

    def respond(request):
        if request.method == "GET":
            return httpx.Response(200, json={"tools": [TOOL]})
        posts.append(json.loads(request.content))
        return httpx.Response(200, json=RESULT)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        server = create_server(KreaDiscoveryBridge("http://127.0.0.1:8033", client))
        to_server, server_read = anyio.create_memory_object_stream(0)
        server_write, from_server = anyio.create_memory_object_stream(0)
        async with anyio.create_task_group() as group:
            group.start_soon(server.run, server_read, server_write, server.create_initialization_options())
            async with ClientSession(from_server, to_server) as session:
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "Nebula Krea discovery"
                tools = await session.list_tools()
                assert tools.tools[0].inputSchema == SCHEMA
                result = await session.call_tool("get_model_schema", {"model_id": "image/example"})
                assert result.structuredContent == RESULT["structuredContent"]
                invalid = await session.call_tool("get_model_schema", {"model_id": "wrong-model"})
                assert invalid.isError
                blocked = await session.call_tool("generate", {})
                assert blocked.isError
            group.cancel_scope.cancel()
    assert posts == [{"name": "get_model_schema", "arguments": {"model_id": "image/example"}}]


@pytest.mark.asyncio
async def test_stdio_bridge_process_connects_to_only_local_discovery_routes():
    requests = []

    class BackendFixture(BaseHTTPRequestHandler):
        def respond(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            requests.append(("GET", self.path))
            assert self.path == "/api/krea/tools"
            self.respond({"tools": [TOOL]})

        def do_POST(self):
            requests.append(("POST", self.path))
            assert self.path == "/api/krea/tools/call"
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body == {"name": "get_model_schema", "arguments": {"model_id": "image/example"}}
            self.respond(RESULT)

        def log_message(self, *_args):
            pass

    backend = ThreadingHTTPServer(("127.0.0.1", 0), BackendFixture)
    thread = threading.Thread(target=backend.serve_forever, daemon=True)
    thread.start()
    bridge_path = Path(__file__).resolve().parents[1] / "krea_mcp_server.py"
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(bridge_path), "--url", f"http://127.0.0.1:{backend.server_port}"],
    )
    try:
        with anyio.fail_after(10):
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    assert (await session.list_tools()).tools[0].inputSchema == SCHEMA
                    assert (await session.call_tool("generate", {})).isError
                    result = await session.call_tool("get_model_schema", {"model_id": "image/example"})
                    assert result.structuredContent == RESULT["structuredContent"]
    finally:
        backend.shutdown()
        backend.server_close()
        thread.join(timeout=2)
    assert {path for _method, path in requests} == {"/api/krea/tools", "/api/krea/tools/call"}
    assert sum(method == "POST" for method, _path in requests) == 1


@pytest.mark.asyncio
async def test_bridge_offers_krea_read_only_discovery_and_nothing_that_writes_or_spends():
    from services.krea_agent_mcp import KREA_MCP_PRIMER, KREA_READONLY_TOOLS
    live = json.loads((Path(__file__).with_name("fixtures") / "krea_mcp_tools.json").read_text())
    names = ["list_styles", "list_moodboards", "get_prompting_guide", "create_style", "delete_moodboard",
             "update_style", "execute_node_app", "send_agent_message", "call_desktop_tool", "write_files_upload",
             "create_api_token", "show_plans", "start_free_trial", "list_files", "list_file_tags", "read_files"]
    offered = [{"name": name, "inputSchema": {"type": "object"}} for name in names]

    def respond(request):
        return httpx.Response(200, json={"tools": offered + live})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        tools = {tool.name for tool in await KreaDiscoveryBridge("http://127.0.0.1:8033", client).list_tools()}
    assert tools == {"list_models", "get_model_schema", "list_styles", "list_moodboards", "get_prompting_guide",
                     "get_node_apps", "get_node_app_versions", "list_node_types"}
    assert tools == set(KREA_READONLY_TOOLS)
    for name in KREA_READONLY_TOOLS:
        assert name.startswith(("list_", "get_")), name
        assert name in KREA_MCP_PRIMER
