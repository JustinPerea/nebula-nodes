from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from models import ExecuteRequest, ValidationErrorEvent
from models.events import ExecutionEvent
from execution.engine import execute_graph, validate_graph, CycleError
from execution.sync_runner import get_handler_registry
from services.settings import load_settings, save_settings, get_api_key
from services.output import OUTPUT_ROOT
from services.cache import ExecutionCache

execution_cache = ExecutionCache(ttl=3600)

app = FastAPI(title="Nebula Node Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve output files as static assets
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
app.mount("/api/outputs", StaticFiles(directory=str(OUTPUT_ROOT)), name="outputs")


# ---------- WebSocket connection manager ----------

class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, event: ExecutionEvent) -> None:
        data = _event_to_camel(event)
        message = json.dumps(data)
        disconnected: list[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()


def _event_to_camel(event: ExecutionEvent) -> dict[str, Any]:
    raw = event.model_dump()
    result: dict[str, Any] = {}
    for key, value in raw.items():
        parts = key.split("_")
        camel = parts[0] + "".join(p.capitalize() for p in parts[1:])
        if camel == "nodeId" and isinstance(value, str):
            result["nodeId"] = value
        elif camel == "nodesExecuted":
            result["nodesExecuted"] = value
        else:
            result[camel] = value
        if key == "errors" and isinstance(value, list):
            result["errors"] = [
                {
                    "nodeId": e.get("node_id", e.get("nodeId", "")),
                    "portId": e.get("port_id", e.get("portId", "")),
                    "message": e.get("message", ""),
                }
                for e in value
            ]
    return result


# ---------- WebSocket endpoint ----------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ---------- REST endpoints ----------

@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}


@app.get("/api/settings")
async def get_settings() -> dict:
    settings = load_settings()
    masked = dict(settings)
    if "apiKeys" in masked:
        masked["apiKeys"] = {
            k: ("***" + v[-4:] if len(v) > 4 else "***") if v else ""
            for k, v in masked["apiKeys"].items()
        }
    return masked


@app.put("/api/settings")
async def update_settings(body: dict[str, Any]) -> dict:
    current = load_settings()
    if "apiKeys" in body:
        current_keys = current.get("apiKeys", {})
        for k, v in body["apiKeys"].items():
            if v and not v.startswith("***"):
                current_keys[k] = v
        current["apiKeys"] = current_keys
    for key in ("routing", "outputPath", "executionMode", "batchSizeCap"):
        if key in body:
            current[key] = body[key]
    save_settings(current)
    return {"status": "saved"}


@app.post("/api/execute")
async def execute(request: ExecuteRequest) -> dict:
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    errors = validate_graph(request.nodes, request.edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors))
        return {"status": "validation_error", "errorCount": len(errors)}

    try:
        from execution.engine import topological_sort
        topological_sort(request.nodes, request.edges)
    except CycleError as exc:
        await manager.broadcast(
            ValidationErrorEvent(
                errors=[
                    {
                        "node_id": "",
                        "port_id": "",
                        "message": f"Graph contains a cycle: {exc}",
                    }
                ]
            )
        )
        return {"status": "cycle_error"}

    handler_registry = get_handler_registry()

    async def _run() -> None:
        await execute_graph(
            nodes=request.nodes,
            edges=request.edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=manager.broadcast,
            cache=execution_cache,
        )

    asyncio.create_task(_run())

    return {"status": "started"}
