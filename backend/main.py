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

from models import ExecuteRequest, ExecuteNodeRequest, ValidationErrorEvent, GraphNode, GraphEdge
from models.events import ExecutionEvent, ExecutedEvent, ErrorEvent
from execution.engine import execute_graph, validate_graph, topological_sort, get_subgraph, CycleError
from execution.sync_runner import get_handler_registry
from services.settings import load_settings, save_settings, get_api_key
from services.node_registry import NodeRegistry
from services.cli_graph import CLIGraph
from services.output import OUTPUT_ROOT
from services.cache import ExecutionCache
from services.chat_session import run_claude
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router

execution_cache = ExecutionCache(ttl=3600)
node_registry = NodeRegistry()
cli_graph = CLIGraph()

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
        await self.broadcast_raw(data)

    async def broadcast_raw(self, data: dict[str, Any]) -> None:
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


# ---------- Chat WebSocket (/ws/chat) ----------

@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket) -> None:
    """Chat WebSocket — one message per turn, streams claude -p output.

    Client sends: {type: "send", message: str, sessionId: str|null, model: str}
    Server sends: session | text | tool_use | tool_result | result | error | done
    """
    await websocket.accept()
    current_task: asyncio.Task[None] | None = None

    async def stream_response(message: str, session_id: str | None, model: str) -> None:
        try:
            async for event in run_claude(message, session_id, model):
                await websocket.send_text(json.dumps(event))
        except Exception as exc:
            try:
                await websocket.send_text(json.dumps({"type": "error", "message": str(exc)}))
                await websocket.send_text(json.dumps({"type": "done"}))
            except Exception:
                pass

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue

            msg_type = payload.get("type")
            if msg_type == "cancel":
                if current_task and not current_task.done():
                    current_task.cancel()
                continue
            if msg_type != "send":
                continue

            user_message = payload.get("message", "")
            session_id = payload.get("sessionId") or None
            model = payload.get("model") or "sonnet"
            if not user_message.strip():
                continue

            if current_task and not current_task.done():
                current_task.cancel()
            current_task = asyncio.create_task(
                stream_response(user_message, session_id, model)
            )
    except WebSocketDisconnect:
        if current_task and not current_task.done():
            current_task.cancel()


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
    for key in ("routing", "outputPath", "executionMode", "batchSizeCap", "favorites"):
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


# ---------- CLI: Node discovery ----------

@app.get("/api/nodes")
async def list_nodes() -> dict:
    all_nodes = node_registry.get_all()
    nodes_list = list(all_nodes.values())
    categories = node_registry.get_categories()
    return {"nodes": nodes_list, "categories": categories}


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str) -> dict:
    node = node_registry.get(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return node


# ---------- CLI: Graph management ----------

async def _broadcast_graph_sync() -> None:
    """Push the current CLI graph to all connected frontends via WebSocket."""
    export = await export_graph_for_frontend()
    await manager.broadcast_raw({"type": "graphSync", **export})


@app.post("/api/graph/node")
async def create_graph_node(body: dict[str, Any]) -> dict:
    definition_id = body.get("definitionId", "")
    params = body.get("params", {})
    position = body.get("position")
    short_id = cli_graph.add_node(definition_id, params, position=position)
    await _broadcast_graph_sync()
    return cli_graph.nodes[short_id]


@app.post("/api/graph/connect")
async def connect_graph_nodes(body: dict[str, Any]) -> dict:
    try:
        edge = cli_graph.connect(
            body["source"], body["sourceHandle"],
            body["target"], body["targetHandle"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _broadcast_graph_sync()
    return {"connection": f"{edge['source']}:{edge['sourceHandle']} -> {edge['target']}:{edge['targetHandle']}"}


@app.post("/api/graph/node-and-connect")
async def create_node_and_connect(body: dict[str, Any]) -> dict:
    """Create a node and wire it to an existing node in a single atomic call.

    The ConnectionPopup flow needs both — otherwise the caller races against
    graphSync to find the freshly-created node's short ID before connecting.
    Body: {definitionId, params, position?, connect: {source, sourceHandle,
    target, targetHandle, newNodeIs: 'source' | 'target'}}. The `newNodeIs`
    field tells us which port on the `connect` spec should be filled in with
    the new node's id (the other side is the existing node).
    """
    definition_id = body.get("definitionId", "")
    params = body.get("params", {})
    position = body.get("position")
    short_id = cli_graph.add_node(definition_id, params, position=position)

    connect_spec = body.get("connect") or {}
    if connect_spec:
        is_target = connect_spec.get("newNodeIs") == "target"
        src = connect_spec.get("source") if is_target else short_id
        dst = short_id if is_target else connect_spec.get("target")
        try:
            cli_graph.connect(
                src,
                connect_spec.get("sourceHandle", ""),
                dst,
                connect_spec.get("targetHandle", ""),
            )
        except ValueError:
            # Connection failed but node was created — let the caller decide.
            pass

    await _broadcast_graph_sync()
    return cli_graph.nodes[short_id]


@app.get("/api/graph")
async def get_graph() -> dict:
    return cli_graph.get_state()


@app.put("/api/graph/node/{node_id}")
async def update_graph_node(node_id: str, body: dict[str, Any]) -> dict:
    try:
        cli_graph.update_params(node_id, body.get("params", {}))
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    return cli_graph.nodes[node_id]


@app.delete("/api/graph")
async def clear_graph() -> dict:
    cli_graph.clear()
    await _broadcast_graph_sync()
    return {"status": "cleared"}


@app.delete("/api/graph/node/{node_id}")
async def delete_graph_node(node_id: str) -> dict:
    """Remove a node and any edges touching it from cli_graph."""
    try:
        cli_graph.remove_node(node_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    return {"status": "deleted", "id": node_id}


@app.delete("/api/graph/edge")
async def delete_graph_edge(body: dict[str, Any]) -> dict:
    """Remove the edge matching source/sourceHandle/target/targetHandle."""
    removed = cli_graph.remove_edge(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    if removed:
        await _broadcast_graph_sync()
    return {"status": "deleted" if removed else "not_found"}


@app.post("/api/graph/import")
async def import_graph(body: dict[str, Any]) -> dict:
    """Atomically replace cli_graph from a file-loaded graph.

    Body: {nodes: [{id, definitionId, params, outputs?, position?}], edges: [...]}
    Remaps incoming node IDs (typically UUIDs from the .nebula file) to fresh
    short IDs so the rest of the system treats the loaded graph like any other
    CLI-created graph — including Claude's `nebula graph` view.
    """
    cli_graph.clear()
    id_map: dict[str, str] = {}
    for n in body.get("nodes", []):
        if "definitionId" not in n:
            continue
        new_id = cli_graph.add_node(
            n["definitionId"],
            n.get("params", {}) or {},
            position=n.get("position"),
            outputs=n.get("outputs"),
        )
        old_id = n.get("id")
        if old_id:
            id_map[old_id] = new_id
    for e in body.get("edges", []):
        src = id_map.get(e.get("source"))
        dst = id_map.get(e.get("target"))
        if not src or not dst:
            continue
        try:
            cli_graph.connect(src, e.get("sourceHandle", ""), dst, e.get("targetHandle", ""))
        except ValueError:
            # Skip malformed edges rather than failing the whole import
            continue
    await _broadcast_graph_sync()
    return {
        "status": "imported",
        "idMap": id_map,
        "nodeCount": len(cli_graph.nodes),
        "edgeCount": len(cli_graph.edges),
    }


def _rewrite_output_paths(outputs: dict[str, Any]) -> dict[str, Any]:
    """Convert local file paths in outputs to /api/outputs/ URLs for the frontend."""
    rewritten: dict[str, Any] = {}
    for port_id, port_val in outputs.items():
        if isinstance(port_val, dict) and isinstance(port_val.get("value"), str):
            val = port_val["value"]
            # Convert absolute paths under OUTPUT_ROOT to relative URLs
            try:
                rel = Path(val).relative_to(OUTPUT_ROOT)
                rewritten[port_id] = {**port_val, "value": f"/api/outputs/{rel}"}
            except (ValueError, TypeError):
                rewritten[port_id] = port_val
        else:
            rewritten[port_id] = port_val
    return rewritten


@app.get("/api/graph/export")
async def export_graph_for_frontend() -> dict:
    """Export CLI graph in React Flow format for the frontend canvas."""
    state = cli_graph.get_state()
    if not state["nodes"]:
        return {"nodes": [], "edges": [], "empty": True}

    all_defs = node_registry.get_all()
    rf_nodes = []
    y_offset = 100

    # Pre-compute positions. Nodes with a stored position (imported from a
    # saved file) keep it. Nodes without one (created through `nebula create`)
    # get placed to the right of any positioned node so Claude's new additions
    # don't pile on top of existing work.
    stored_positions: dict[str, dict[str, float]] = {}
    max_x: float = -300.0
    for n in state["nodes"]:
        pos = n.get("position")
        if isinstance(pos, dict) and "x" in pos and "y" in pos:
            stored_positions[n["id"]] = {"x": float(pos["x"]), "y": float(pos["y"])}
            if pos["x"] > max_x:
                max_x = float(pos["x"])
    computed_positions: dict[str, dict[str, float]] = {}
    for n in state["nodes"]:
        if n["id"] in stored_positions:
            computed_positions[n["id"]] = stored_positions[n["id"]]
        else:
            max_x += 300.0
            computed_positions[n["id"]] = {"x": max_x, "y": float(y_offset)}

    for i, n in enumerate(state["nodes"]):
        defn = all_defs.get(n["definitionId"], {})
        node_type = "reroute-node" if n["definitionId"] == "reroute" else "model-node"
        outputs = _rewrite_output_paths(n.get("outputs", {}))
        node_state = "complete" if outputs else "idle"

        # For image-input nodes: derive _previewUrl from filePath if the file is
        # under OUTPUT_ROOT and no preview URL was stored. This makes CLI-created
        # image-input nodes render a real preview instead of the broken fallback.
        params = dict(n.get("params", {}))
        if n["definitionId"] == "image-input" and not params.get("_previewUrl"):
            fp = params.get("filePath")
            if isinstance(fp, str) and fp:
                try:
                    rel = Path(fp).resolve().relative_to(OUTPUT_ROOT.resolve())
                    params["_previewUrl"] = f"/api/outputs/{rel}"
                except ValueError:
                    pass

        rf_nodes.append({
            "id": n["id"],
            "type": node_type,
            "position": computed_positions[n["id"]],
            "data": {
                "label": defn.get("displayName", n["definitionId"]),
                "definitionId": n["definitionId"],
                "params": params,
                "state": node_state,
                "outputs": outputs,
            },
        })

    rf_edges = []
    for e in state["edges"]:
        # Determine data type for edge styling
        src_node = cli_graph.nodes.get(e["source"], {})
        src_def = all_defs.get(src_node.get("definitionId", ""), {})
        data_type = "Any"
        for port in src_def.get("outputPorts", []):
            if port["id"] == e["sourceHandle"]:
                data_type = port["dataType"]
                break

        rf_edges.append({
            "id": e["id"],
            "source": e["source"],
            "sourceHandle": e["sourceHandle"],
            "target": e["target"],
            "targetHandle": e["targetHandle"],
            "type": "typed-edge",
            "data": {"dataType": data_type},
        })

    return {"nodes": rf_nodes, "edges": rf_edges, "empty": False}


# ---------- CLI: Synchronous execution ----------

@app.post("/api/graph/run")
async def run_graph(body: dict[str, Any] | None = None) -> dict:
    """Execute the CLI graph synchronously and return results."""
    if not cli_graph.nodes:
        raise HTTPException(status_code=400, detail="Graph is empty")

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes_list, edges_list = cli_graph.to_execute_format()

    target = body.get("targetNodeId") if body else None
    if target:
        sub_nodes, sub_edges = get_subgraph(
            [GraphNode.model_validate(n) for n in nodes_list],
            [GraphEdge.model_validate(e) for e in edges_list],
            target,
        )
        if not sub_nodes:
            raise HTTPException(status_code=404, detail=f"Node '{target}' not found in graph")
    else:
        sub_nodes = [GraphNode.model_validate(n) for n in nodes_list]
        sub_edges = [GraphEdge.model_validate(e) for e in edges_list]

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}

    import time

    async def collect_events(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error

    handler_registry = get_handler_registry(emit=collect_events)

    start = time.time()
    await execute_graph(
        nodes=sub_nodes,
        edges=sub_edges,
        api_keys=api_keys,
        handler_registry=handler_registry,
        emit=collect_events,
        cache=execution_cache,
    )
    duration = time.time() - start

    # Update CLI graph node outputs
    for node_id, outputs in results.items():
        if node_id in cli_graph.nodes:
            cli_graph.nodes[node_id]["outputs"] = (
                {k: v if isinstance(v, dict) else {"type": "Any", "value": v} for k, v in outputs.items()}
                if isinstance(outputs, dict) else {}
            )

    # Sync outputs to frontend canvas
    await _broadcast_graph_sync()

    return {
        "results": results,
        "errors": errors,
        "duration": round(duration, 2),
        "nodesExecuted": len(results) + len(errors),
    }


@app.post("/api/quick")
async def quick_execute(body: dict[str, Any]) -> dict:
    """One-shot: create a temp node, execute, return output."""
    definition_id = body.get("definitionId", "")
    inputs = body.get("inputs", {})
    params = body.get("params", {})

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    temp_nodes = []
    temp_edges = []
    node_counter = 0

    for port_id, value in inputs.items():
        node_counter += 1
        input_node_id = f"_quick_input_{node_counter}"
        if isinstance(value, str) and value.endswith(('.png', '.jpg', '.jpeg', '.webp')):
            input_type = "image-input"
            port_type = "Image"
        elif isinstance(value, str) and value.endswith(('.mp4', '.mov', '.webm')):
            input_type = "video-input"
            port_type = "Video"
        elif isinstance(value, str) and value.endswith(('.mp3', '.wav', '.m4a')):
            input_type = "audio-input"
            port_type = "Audio"
        else:
            input_type = "text-input"
            port_type = "Text"

        temp_nodes.append(GraphNode(
            id=input_node_id,
            definition_id=input_type,
            params={"value": value},
            outputs={},
        ))
        temp_edges.append(GraphEdge(
            id=f"_quick_edge_{node_counter}",
            source=input_node_id,
            source_handle="text" if input_type == "text-input" else port_type.lower(),
            target="_quick_main",
            target_handle=port_id,
        ))

    temp_nodes.append(GraphNode(
        id="_quick_main",
        definition_id=definition_id,
        params=params,
        outputs={},
    ))

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}

    async def collect_events(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error

    handler_registry = get_handler_registry(emit=collect_events)

    import time
    start = time.time()
    await execute_graph(
        nodes=temp_nodes,
        edges=temp_edges,
        api_keys=api_keys,
        handler_registry=handler_registry,
        emit=collect_events,
        cache=execution_cache,
    )
    duration = time.time() - start

    if "_quick_main" in errors:
        raise HTTPException(status_code=500, detail=errors["_quick_main"])

    main_outputs = results.get("_quick_main", {})
    return {"outputs": main_outputs, "duration": round(duration, 2)}


# Static mount MUST come after all dynamic routes — it is a catch-all for /api/outputs
app.mount("/api/outputs", StaticFiles(directory=str(OUTPUT_ROOT)), name="outputs")
