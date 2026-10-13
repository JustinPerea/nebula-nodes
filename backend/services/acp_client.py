"""A small JSON-RPC 2.0 client for the Agent Client Protocol (ACP) over stdio.

ACP (agentclientprotocol.com, protocol v1) runs JSON-RPC over an agent
subprocess's stdin/stdout, one JSON object per line. Nebula is the client:
it sends ``initialize``, ``session/new``, ``session/prompt`` and so on, and
answers the agent's own requests (``session/request_permission``, and a
-32601 for every capability Nebula declined).

No SDK: this file is the whole transport. It is deliberately forgiving of a
misbehaving agent. A line that isn't JSON, or isn't an object, is counted
and dropped; an agent can't crash the host by printing junk on stdout.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL = -32603
CANCELLED = -32800
AUTH_REQUIRED = -32000

# Matches run_claude's stdout limit: one tool result can be a large line.
STREAM_LIMIT_BYTES = 64 * 1024 * 1024


class AcpError(Exception):
    """A JSON-RPC error, from the agent's answer or to send back to it."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{message} ({code})")
        self.code = code
        self.message = message
        self.data = data


class AcpConnectionClosed(Exception):
    """The agent's stdout ended (or the host closed it) before an answer came."""


NotificationHandler = Callable[[str, dict], None]
RequestHandler = Callable[[str, dict, Any], Awaitable[Any]]
CancelHandler = Callable[[Any], None]


class AcpConnection:
    """JSON-RPC over an agent process's stdin and stdout."""

    def __init__(self, proc: Any, *, on_notification: NotificationHandler,
                 on_request: RequestHandler, on_cancel_request: CancelHandler | None = None) -> None:
        self._proc = proc
        self._on_notification = on_notification
        self._on_request = on_request
        self._on_cancel_request = on_cancel_request
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._incoming: dict[Any, asyncio.Task] = {}
        self._write_lock = asyncio.Lock()
        self._reader: asyncio.Task | None = None
        self._closed = False
        self.dropped_lines = 0
        self.closed_event = asyncio.Event()

    @property
    def closed(self) -> bool:
        return self._closed

    def start(self) -> None:
        if self._reader is None:
            self._reader = asyncio.create_task(self._read_loop())

    async def _write(self, message: dict) -> None:
        if self._closed:
            raise AcpConnectionClosed("The agent connection is closed")
        line = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False, separators=(",", ":")) + "\n"
        stdin = self._proc.stdin
        async with self._write_lock:
            try:
                stdin.write(line.encode("utf-8"))
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError, AttributeError) as exc:
                raise AcpConnectionClosed("The agent stopped reading its input") from exc

    async def request(self, method: str, params: dict, *, timeout: float | None = None) -> Any:
        """Send a request and wait for its result (raises AcpError on an error answer)."""
        self._next_id += 1
        request_id = self._next_id
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({"id": request_id, "method": method, "params": params})
            if timeout is None:
                return await future
            return await asyncio.wait_for(future, timeout)
        finally:
            self._pending.pop(request_id, None)

    async def notify(self, method: str, params: dict) -> None:
        await self._write({"method": method, "params": params})

    async def _read_loop(self) -> None:
        stdout = self._proc.stdout
        try:
            while True:
                try:
                    line = await stdout.readline()
                except ValueError:
                    # Over STREAM_LIMIT_BYTES: drop it, keep reading.
                    self.dropped_lines += 1
                    continue
                if not line:
                    break
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    self.dropped_lines += 1
                    continue
                if not isinstance(message, dict):
                    self.dropped_lines += 1
                    continue
                self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - a broken pipe is EOF
            logger.debug("ACP reader stopped", exc_info=True)
        finally:
            await self.close()

    def _dispatch(self, message: dict) -> None:
        method = message.get("method")
        has_id = "id" in message and isinstance(message.get("id"), (int, str)) and not isinstance(message.get("id"), bool)
        if method is None:
            # A response to one of ours.
            if not has_id:
                self.dropped_lines += 1
                return
            future = self._pending.get(message["id"]) if isinstance(message["id"], int) else None
            if future is None or future.done():
                return
            if isinstance(message.get("error"), dict):
                error = message["error"]
                code = error.get("code") if isinstance(error.get("code"), int) else INTERNAL
                future.set_exception(AcpError(code, str(error.get("message") or "Agent error"), error.get("data")))
            else:
                future.set_result(message.get("result"))
            return
        if not isinstance(method, str):
            self.dropped_lines += 1
            return
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if not has_id:
            if method == "$/cancel_request":
                self._cancel_incoming(params.get("requestId"))
                return
            try:
                self._on_notification(method, params)
            except Exception:
                logger.debug("ACP notification handler failed", exc_info=True)
            return
        request_id = message["id"]
        task = asyncio.create_task(self._answer(method, params, request_id))
        self._incoming[request_id] = task
        task.add_done_callback(lambda _t, rid=request_id: self._incoming.pop(rid, None))

    def _cancel_incoming(self, request_id: Any) -> None:
        task = self._incoming.get(request_id)
        if task is None or task.done():
            return
        if self._on_cancel_request is not None:
            try:
                self._on_cancel_request(request_id)
            except Exception:
                logger.debug("ACP cancel handler failed", exc_info=True)
        task.cancel()

    async def _answer(self, method: str, params: dict, request_id: Any) -> None:
        try:
            result = await self._on_request(method, params, request_id)
            reply: dict = {"id": request_id, "result": result}
        except asyncio.CancelledError:
            reply = {"id": request_id, "error": {"code": CANCELLED, "message": "Request cancelled"}}
        except AcpError as exc:
            reply = {"id": request_id, "error": {"code": exc.code, "message": exc.message}}
        except Exception:
            logger.debug("ACP request handler failed", exc_info=True)
            reply = {"id": request_id, "error": {"code": INTERNAL, "message": "Internal error"}}
        try:
            await self._write(reply)
        except AcpConnectionClosed:
            pass

    async def close(self) -> None:
        """Fail every pending request with AcpConnectionClosed. Idempotent."""
        if self._closed:
            return
        self._closed = True
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(AcpConnectionClosed("The agent exited"))
        for task in list(self._incoming.values()):
            task.cancel()
        self.closed_event.set()
        reader = self._reader
        if reader is not None and reader is not asyncio.current_task() and not reader.done():
            reader.cancel()
