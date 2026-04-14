from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from models import ExecuteRequest, ExecuteNodeRequest, ValidationErrorEvent
from models.events import ExecutionEvent
from execution.engine import execute_graph, validate_graph, topological_sort, get_subgraph, CycleError
from execution.sync_runner import get_handler_registry
from services.settings import load_settings, save_settings, get_api_key
from services.output import OUTPUT_ROOT
from services.cache import ExecutionCache
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router

execution_cache = ExecutionCache(ttl=3600)

app = FastAPI(title="Nebula Node Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve output files as static assets (mounted after dynamic routes — mounts are catch-all)
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

app.include_router(openrouter_router)
app.include_router(replicate_router)
app.include_router(fal_router)


@app.post("/api/upload")
async def upload_file(file: UploadFile) -> dict:
    """Upload a file (image, etc.) and return its path and URL."""
    uploads_dir = OUTPUT_ROOT / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "file").suffix or ".png"
    filename = f"{uuid4().hex[:12]}{ext}"
    file_path = uploads_dir / filename
    content = await file.read()
    file_path.write_bytes(content)
    return {
        "path": str(file_path.resolve()),
        "url": f"/api/outputs/uploads/{filename}",
    }


@app.get("/api/convert-to-glb")
async def convert_to_glb(path: str) -> Any:
    """Convert a non-GLB 3D file to GLB for preview. Caches the result."""
    import trimesh

    source_path = OUTPUT_ROOT / path
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")

    # Security: ensure path stays within OUTPUT_ROOT
    try:
        source_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path")

    # If already GLB, serve directly
    if source_path.suffix.lower() == ".glb":
        return FileResponse(str(source_path), media_type="model/gltf-binary")

    # Check for cached conversion
    preview_path = source_path.with_suffix(".preview.glb")
    if preview_path.exists():
        return FileResponse(str(preview_path), media_type="model/gltf-binary")

    # Convert to GLB using trimesh
    try:
        mesh = trimesh.load(str(source_path))
        mesh.export(str(preview_path), file_type="glb")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Conversion failed: {exc}")

    return FileResponse(str(preview_path), media_type="model/gltf-binary")


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


def _snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _event_to_camel(event: ExecutionEvent) -> dict[str, Any]:
    raw = event.model_dump()
    result: dict[str, Any] = {}
    for key, value in raw.items():
        camel = _snake_to_camel(key)
        # Also camelize the "type" value (e.g. "graph_complete" → "graphComplete")
        if key == "type" and isinstance(value, str):
            result[camel] = _snake_to_camel(value)
        elif camel == "nodeId" and isinstance(value, str):
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

    handler_registry = get_handler_registry(emit=manager.broadcast)

    async def _run() -> None:
        import traceback, sys
        print("[exec] _run started", file=sys.stderr, flush=True)
        try:
            await execute_graph(
                nodes=request.nodes,
                edges=request.edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=manager.broadcast,
                cache=execution_cache,
            )
            print("[exec] _run completed successfully", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[exec] _run FAILED: {e}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)

    asyncio.create_task(_run())

    return {"status": "started"}


@app.post("/api/execute-node")
async def execute_node(request: ExecuteNodeRequest) -> dict:
    """Execute only the subgraph feeding into a specific target node."""
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    # Compute the subgraph: target node + all its ancestors
    sub_nodes, sub_edges = get_subgraph(
        request.nodes, request.edges, request.target_node_id
    )

    if not sub_nodes:
        return {"status": "error", "message": f"Node '{request.target_node_id}' not found in graph"}

    errors = validate_graph(sub_nodes, sub_edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors))
        return {"status": "validation_error", "errorCount": len(errors)}

    try:
        topological_sort(sub_nodes, sub_edges)
    except CycleError as exc:
        await manager.broadcast(
            ValidationErrorEvent(
                errors=[
                    {
                        "node_id": "",
                        "port_id": "",
                        "message": f"Subgraph contains a cycle: {exc}",
                    }
                ]
            )
        )
        return {"status": "cycle_error"}

    handler_registry = get_handler_registry(emit=manager.broadcast)

    async def _run() -> None:
        import traceback
        try:
            await execute_graph(
                nodes=sub_nodes,
                edges=sub_edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=manager.broadcast,
                cache=execution_cache,
            )
        except Exception:
            traceback.print_exc()

    asyncio.create_task(_run())

    return {"status": "started", "nodeCount": len(sub_nodes)}


# Static mount MUST come after all dynamic routes — it is a catch-all for /api/outputs
app.mount("/api/outputs", StaticFiles(directory=str(OUTPUT_ROOT)), name="outputs")
