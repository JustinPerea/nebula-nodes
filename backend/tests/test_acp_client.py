"""AcpConnection: JSON-RPC framing, ids, incoming requests, junk and EOF."""
from __future__ import annotations

import asyncio
import json

import pytest

from services.acp_client import AcpConnection, AcpConnectionClosed, AcpError


class FakeStdin:
    def __init__(self) -> None:
        self.lines: list[dict] = []
        self.event = asyncio.Event()

    def write(self, data: bytes) -> None:
        for line in data.decode().splitlines():
            self.lines.append(json.loads(line))
        self.event.set()

    async def drain(self) -> None:
        return None


class FakeProc:
    def __init__(self) -> None:
        self.stdin = FakeStdin()
        self.stdout = asyncio.StreamReader()

    def feed(self, message) -> None:
        raw = message if isinstance(message, str) else json.dumps(message)
        self.stdout.feed_data((raw + "\n").encode())


async def wait_for_line(proc: FakeProc, predicate, timeout=2.0):
    async def find():
        while True:
            for line in proc.stdin.lines:
                if predicate(line):
                    return line
            proc.stdin.event.clear()
            await proc.stdin.event.wait()
    return await asyncio.wait_for(find(), timeout)


def make(proc, *, on_request=None, notes=None, cancels=None):
    async def default_request(method, params, request_id):
        raise AcpError(-32601, "Method not found")
    return AcpConnection(proc, on_notification=lambda m, p: (notes if notes is not None else []).append((m, p)),
                         on_request=on_request or default_request,
                         on_cancel_request=(cancels.append if cancels is not None else None))


@pytest.mark.asyncio
async def test_ids_match_out_of_order_replies():
    proc = FakeProc()
    conn = make(proc)
    conn.start()
    first = asyncio.create_task(conn.request("a", {}))
    second = asyncio.create_task(conn.request("b", {}))
    await wait_for_line(proc, lambda l: l.get("method") == "b")
    ids = {l["method"]: l["id"] for l in proc.stdin.lines}
    assert all(l["jsonrpc"] == "2.0" for l in proc.stdin.lines)
    proc.feed({"jsonrpc": "2.0", "id": ids["b"], "result": {"which": "b"}})
    proc.feed({"jsonrpc": "2.0", "id": ids["a"], "error": {"code": -32000, "message": "auth"}})
    assert await second == {"which": "b"}
    with pytest.raises(AcpError) as info:
        await first
    assert info.value.code == -32000
    await conn.close()


@pytest.mark.asyncio
async def test_incoming_requests_are_answered_and_unknown_methods_get_32601():
    proc = FakeProc()

    async def on_request(method, params, request_id):
        if method == "session/request_permission":
            return {"outcome": {"outcome": "cancelled"}}
        raise AcpError(-32601, "Method not found")

    conn = make(proc, on_request=on_request)
    conn.start()
    proc.feed({"jsonrpc": "2.0", "id": "str-id", "method": "session/request_permission", "params": {}})
    proc.feed({"jsonrpc": "2.0", "id": 7, "method": "fs/read_text_file", "params": {"path": "/etc/hosts"}})
    ok = await wait_for_line(proc, lambda l: l.get("id") == "str-id")
    assert ok["result"] == {"outcome": {"outcome": "cancelled"}}
    refused = await wait_for_line(proc, lambda l: l.get("id") == 7)
    assert refused["error"]["code"] == -32601
    await conn.close()


@pytest.mark.asyncio
async def test_junk_is_dropped_and_notifications_keep_order():
    proc = FakeProc()
    notes: list = []
    conn = make(proc, notes=notes)
    conn.start()
    for junk in ["not json", "[1,2]", '"text"', "{bad"]:
        proc.feed(junk)
    for index in range(5):
        proc.feed({"jsonrpc": "2.0", "method": "session/update", "params": {"n": index}})
    pending = asyncio.create_task(conn.request("ping", {}))
    line = await wait_for_line(proc, lambda l: l.get("method") == "ping")
    proc.feed({"jsonrpc": "2.0", "id": line["id"], "result": {}})
    await pending
    assert [p["n"] for _, p in notes] == [0, 1, 2, 3, 4]
    assert conn.dropped_lines == 4
    await conn.close()


@pytest.mark.asyncio
async def test_eof_fails_pending_requests():
    proc = FakeProc()
    conn = make(proc)
    conn.start()
    pending = asyncio.create_task(conn.request("slow", {}))
    await wait_for_line(proc, lambda l: l.get("method") == "slow")
    proc.stdout.feed_eof()
    with pytest.raises(AcpConnectionClosed):
        await pending
    assert conn.closed
    with pytest.raises(AcpConnectionClosed):
        await conn.request("after", {})


@pytest.mark.asyncio
async def test_cancel_request_from_agent_answers_32800():
    proc = FakeProc()
    cancels: list = []
    started = asyncio.Event()

    async def on_request(method, params, request_id):
        started.set()
        await asyncio.Event().wait()

    conn = make(proc, on_request=on_request, cancels=cancels)
    conn.start()
    proc.feed({"jsonrpc": "2.0", "id": 3, "method": "session/request_permission", "params": {}})
    await asyncio.wait_for(started.wait(), 2)
    proc.feed({"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": 3}})
    reply = await wait_for_line(proc, lambda l: l.get("id") == 3)
    assert reply["error"]["code"] == -32800
    assert cancels == [3]
    await conn.close()
