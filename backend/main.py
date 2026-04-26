from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from uuid import uuid4

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
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
from services.chat_actions import publish_action
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router
from routes.nous_proxy import router as nous_router

execution_cache = ExecutionCache(ttl=3600)
node_registry = NodeRegistry()

# Persist the CLI graph to ~/.nebula/state.json on every mutation and reload
# it on boot. Survives uvicorn restart so a crash or `kill` no longer wipes
# the canvas. Per-user state dir keeps different projects on the same machine
# isolated; override with NEBULA_STATE_DIR if you need a project-scoped file.
_STATE_DIR = Path(os.environ.get("NEBULA_STATE_DIR", Path.home() / ".nebula"))
try:
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as exc:
    print(f"[main] cannot create state dir {_STATE_DIR}: {exc} — persistence disabled", flush=True)
    _STATE_PATH: Path | None = None
else:
    _STATE_PATH = _STATE_DIR / "state.json"

cli_graph = CLIGraph(persist_path=_STATE_PATH)
if _STATE_PATH is not None and _STATE_PATH.exists():
    try:
        cli_graph.load(_STATE_PATH)
        print(f"[main] restored graph from {_STATE_PATH} — {len(cli_graph.nodes)} nodes, {len(cli_graph.edges)} edges", flush=True)
    except Exception as exc:
        print(f"[main] failed to restore graph from {_STATE_PATH}: {exc} — starting fresh", flush=True)

app = FastAPI(title="Nebula Node Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    # Accept any localhost port for dev (Vite auto-bumps to 5174/5175 when 5173 is busy, etc.).
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve output files as static assets (mounted after dynamic routes — mounts are catch-all)
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

CHAT_UPLOADS_DIR = OUTPUT_ROOT / "chat-uploads"
CHAT_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


def _restore_zip_bundle(zip_bytes: bytes) -> dict[str, str]:
    """Extract a frontend-produced .nebula.zip (from Save) into a fresh
    output/<timestamp>/restored-<id>/ directory. Returns a mapping of the
    original asset path inside the zip (without the 'assets/' prefix) to
    the URL under which the restored file is served.

    A zip entry '<path>' at 'assets/<path>' is extracted to
    OUTPUT_ROOT / <timestamp> / restored-<id> / <path>. Path-traversal
    attempts ('..') are skipped silently — the caller can't escape
    OUTPUT_ROOT even with a hostile zip.
    """
    import io
    import zipfile
    from datetime import datetime, timezone
    from uuid import uuid4

    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Not a valid zip bundle: {exc}")

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    restore_dir = OUTPUT_ROOT / timestamp / f"restored-{uuid4().hex[:8]}"
    restore_dir.mkdir(parents=True, exist_ok=True)
    restore_root = restore_dir.resolve()

    url_mapping: dict[str, str] = {}
    rel_prefix = f"{timestamp}/{restore_dir.name}"

    for member in zf.namelist():
        # Only restore entries under the 'assets/' prefix the frontend uses.
        if not member.startswith("assets/") or member.endswith("/"):
            continue
        inner_path = member[len("assets/"):]
        # Reject path traversal — '..' segments or absolute-looking paths.
        if ".." in inner_path.split("/") or inner_path.startswith("/"):
            continue
        dest = (restore_dir / inner_path).resolve()
        try:
            dest.relative_to(restore_root)
        except ValueError:
            # Sneaked out of restore_dir via symlink-style trickery — skip.
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(member) as src, dest.open("wb") as out:
            out.write(src.read())
        url_mapping[inner_path] = f"/api/outputs/{rel_prefix}/{inner_path}"

    return url_mapping


_OUTPUT_DIR_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")


@app.post("/api/outputs/archive")
async def archive_outputs(older_than_days: int = 30) -> dict:
    """Move `output/YYYY-MM-DD_*` directories older than `older_than_days`
    to `output/.archive/`. Explicit-only — the backend NEVER runs this on
    its own. Nothing is deleted; archived directories can be moved back
    manually if needed.

    Only directories matching the canonical timestamp pattern are considered.
    chat-uploads, .archive, restored-* subfolders, and any ad-hoc directory
    are left untouched regardless of age."""
    import shutil
    import time

    if older_than_days < 0:
        raise HTTPException(status_code=400, detail="older_than_days must be >= 0")

    cutoff = time.time() - older_than_days * 86400
    archive_root = OUTPUT_ROOT / ".archive"
    archive_root.mkdir(parents=True, exist_ok=True)
    archived: list[str] = []

    for entry in OUTPUT_ROOT.iterdir():
        if not entry.is_dir():
            continue
        if not _OUTPUT_DIR_PATTERN.match(entry.name):
            continue  # chat-uploads, .archive, restored-*, etc. never archived
        try:
            if entry.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        dest = archive_root / entry.name
        if dest.exists():
            # Don't clobber an existing archive slot — append a uuid suffix.
            from uuid import uuid4
            dest = archive_root / f"{entry.name}-{uuid4().hex[:6]}"
        shutil.move(str(entry), str(dest))
        archived.append(entry.name)

    return {"archived": archived, "archive_dir": str(archive_root)}


@app.post("/api/outputs/restore")
async def restore_outputs(request: Request) -> dict:
    """Accept a .nebula.zip body, extract assets into a fresh output/
    subdirectory, and return the old-path → served-URL mapping. The frontend
    uses the mapping to rewrite graph JSON so loaded nodes point at the
    restored files instead of the vanished originals."""
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty request body")
    url_mapping = _restore_zip_bundle(body)
    return {"urlMapping": url_mapping}

_SUPPORTED_IMAGE_TYPES = {
    b"\x89PNG\r\n\x1a\n": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
    b"GIF87a": ("image/gif", ".gif"),
    b"GIF89a": ("image/gif", ".gif"),
}

MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


def _sniff_image_type(data: bytes) -> tuple[str, str] | None:
    """Return (mime, ext) if *data* starts with a supported image signature.

    Also handles WebP (RIFF....WEBP). Returns None for anything else so the
    caller can reject with 415.
    """
    for sig, pair in _SUPPORTED_IMAGE_TYPES.items():
        if data.startswith(sig):
            return pair
    # WebP has a variable prefix: "RIFF" then 4 size bytes then "WEBP".
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ("image/webp", ".webp")
    return None


app.include_router(openrouter_router)
app.include_router(replicate_router)
app.include_router(fal_router)
app.include_router(nous_router)


@app.post("/api/uploads")
async def upload_file_consolidated(
    file: UploadFile,
    create_node: str = Form("false"),
) -> dict:
    """Accept an image upload with strict validation and content-hash dedup.

    When `create_node` is truthy, atomically creates an image-input node in
    cli_graph and broadcasts graphSync. When absent or falsy, returns only
    the upload metadata so callers can handle node creation themselves (or
    use the URL for an existing node).

    Supersedes the deprecated /api/upload and /api/chat/uploads endpoints;
    both shapes of caller can migrate to this one.
    """
    content = await file.read()
    if len(content) > MAX_CHAT_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
    if len(content) < 12:
        raise HTTPException(status_code=415, detail="File is too small to be a valid image")

    sniffed = _sniff_image_type(content[:16])
    if sniffed is None:
        raise HTTPException(status_code=415, detail="Only image files are accepted")
    _, ext = sniffed

    digest = hashlib.sha256(content).hexdigest()
    saved_path = CHAT_UPLOADS_DIR / f"{digest}{ext}"
    if not saved_path.exists():
        # Dedup by content hash: identical bytes collapse to one file on disk.
        # Concurrent write-after-write writes the same bytes and is benign.
        saved_path.write_bytes(content)

    url = f"/api/outputs/chat-uploads/{saved_path.name}"
    filename = file.filename or f"{digest}{ext}"

    # Base response — present for every caller.
    response: dict[str, Any] = {
        "url": url,
        "filePath": str(saved_path.resolve()),
        "filename": filename,
    }

    # Opt-in node creation: parse create_node laxly so any reasonable truthy
    # string works (supports callers composing forms in different tools).
    if create_node.strip().lower() in ("true", "1", "yes"):
        positions = [n.get("position", {}) for n in cli_graph.nodes.values()]
        max_x = max((p.get("x", 0) for p in positions), default=-300)
        new_position = {"x": float(max_x) + 300.0, "y": 100.0}

        # filePath is the absolute local path (handlers open() this), _previewUrl
        # is the served URL (frontend <img> displays this). Same shape Inspector
        # and legacy Canvas file-drop always used.
        node_id = cli_graph.add_node(
            "image-input",
            {"filePath": str(saved_path.resolve()), "_previewUrl": url},
            position=new_position,
        )
        await _broadcast_graph_sync()
        response["nodeId"] = node_id
        response["thumbUrl"] = url

    return response


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
    """Chat WebSocket — one message per turn, streams agent output.

    Client sends: {
        type: "send",
        message: str,
        sessionId: str|null,
        model: str,
        agent: "claude" | "daedalus" (default "claude"),
        autonomy: "auto" | "step" (default "auto", daedalus-only)
    }
    Server sends events matching AGENT_RUNNERS' event contract.
    """
    from services.chat_session import AGENT_RUNNERS
    from services.chat_actions import register_action_handler, unregister_action_handler

    await websocket.accept()
    current_task: asyncio.Task[None] | None = None

    async def stream_response(
        message: str,
        session_id: str | None,
        model: str,
        agent: str,
        autonomy: str,
        provider: str | None,
    ) -> None:
        # Single outbound queue so every send path (agent events + canvas-
        # action events from the graph API) is serialized through one drainer
        # task — WebSocket.send_text is not safe to call from two tasks at
        # once.
        outbound: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

        def enqueue(event: dict[str, Any]) -> None:
            outbound.put_nowait(event)

        async def drain() -> None:
            while True:
                event = await outbound.get()
                if event is None:
                    return
                try:
                    await websocket.send_text(json.dumps(event))
                except Exception:
                    return

        drainer = asyncio.create_task(drain())
        # Graph mutation routes publish thinking events via chat_actions —
        # register the enqueuer so they flow through the same outbound queue
        # as the agent's own events.
        register_action_handler(enqueue)

        try:
            runner = AGENT_RUNNERS.get(agent)
            if runner is None:
                enqueue({
                    "type": "error",
                    "message": f"Unknown agent '{agent}'. Valid: {sorted(AGENT_RUNNERS.keys())}",
                })
                enqueue({"type": "done"})
                return

            try:
                agen = runner(message, session_id, model, autonomy, provider=provider)
                async for event in agen:
                    enqueue(event)
            except Exception as exc:
                enqueue({"type": "error", "message": str(exc)})
                enqueue({"type": "done"})
        finally:
            unregister_action_handler()
            # Sentinel stops the drainer; wait for it so remaining events flush.
            outbound.put_nowait(None)
            try:
                await drainer
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
            model = payload.get("model") or "claude-sonnet-4-6"
            agent = payload.get("agent") or "claude"
            autonomy = payload.get("autonomy") or "auto"
            # Optional per-turn provider override (e.g. "nous" / "openrouter").
            # When omitted, the runner falls back to its default provider.
            provider_raw = payload.get("provider")
            provider = str(provider_raw) if provider_raw else None
            if not user_message.strip():
                continue

            if current_task and not current_task.done():
                current_task.cancel()
            current_task = asyncio.create_task(
                stream_response(user_message, session_id, model, agent, autonomy, provider)
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

    handler_registry = get_handler_registry(emit=_emit_and_sync)

    async def _run() -> None:
        import traceback, sys
        print("[exec] _run started", file=sys.stderr, flush=True)
        try:
            await execute_graph(
                nodes=request.nodes,
                edges=request.edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=_emit_and_sync,
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

    handler_registry = get_handler_registry(emit=_emit_and_sync)

    async def _run() -> None:
        import traceback
        try:
            await execute_graph(
                nodes=sub_nodes,
                edges=sub_edges,
                api_keys=api_keys,
                handler_registry=handler_registry,
                emit=_emit_and_sync,
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


def _suggest_node_ids(query: str, all_ids: list[str]) -> list[str]:
    """Find candidate definition ids for a failed `nebula info` lookup.

    Prefix match first (catches family names: `gpt-image-2` → four variants);
    falls back to difflib close matches for typos. Returns [] if nothing is
    close enough — callers should skip the 'Did you mean:' block in that case
    rather than pad the 404 with noise.
    """
    prefix = sorted(nid for nid in all_ids if nid.startswith(query) and nid != query)
    if prefix:
        return prefix
    return difflib.get_close_matches(query, all_ids, n=5, cutoff=0.6)


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str) -> dict:
    node = node_registry.get(node_id)
    if node is None:
        all_nodes = node_registry.get_all()
        suggestions = _suggest_node_ids(node_id, list(all_nodes.keys()))
        if suggestions:
            lines = [f"Node '{node_id}' not found. Did you mean:"]
            for nid in suggestions:
                meta = all_nodes.get(nid, {})
                display = meta.get("displayName", "")
                category = meta.get("category", "")
                lines.append(f"  - {nid:32s} {display:24s} {category}")
            detail = "\n".join(lines)
        else:
            detail = f"Node '{node_id}' not found"
        raise HTTPException(status_code=404, detail=detail)
    return node


# ---------- CLI: Graph management ----------

async def _broadcast_graph_sync() -> None:
    """Push the current CLI graph to all connected frontends via WebSocket."""
    export = await export_graph_for_frontend()
    await manager.broadcast_raw({"type": "graphSync", **export})


def _sync_outputs_to_cli_graph(node_id: str, outputs: dict[str, Any]) -> None:
    """Mirror an ExecutedEvent's outputs into cli_graph so endpoints like
    /api/graph/node/{id}/path can resolve to real values. Shape-matches the
    pattern used by /api/graph/run so every execution path converges on the
    same stored shape."""
    if node_id not in cli_graph.nodes:
        return
    if not isinstance(outputs, dict):
        cli_graph.nodes[node_id]["outputs"] = {}
        return
    cli_graph.nodes[node_id]["outputs"] = {
        k: v if isinstance(v, dict) else {"type": "Any", "value": v}
        for k, v in outputs.items()
    }


async def _emit_and_sync(event: ExecutionEvent) -> None:
    """Wrap manager.broadcast so ExecutedEvents also mirror their outputs
    into cli_graph. Used by /api/execute and /api/execute-node so the
    frontend-driven execution paths keep cli_graph in sync with what the
    user sees in the canvas."""
    if isinstance(event, ExecutedEvent):
        _sync_outputs_to_cli_graph(event.node_id, event.outputs)
    await manager.broadcast(event)


def _validate_connect_handles(
    src_node_id: str, src_port: str, dst_node_id: str, dst_port: str
) -> None:
    """Reject a connect() when either handle doesn't exist on its node.

    Raises HTTPException(400). Exists because without this, an agent (or UI)
    can POST an edge wired to a nonexistent port id — the backend stores it,
    the graph executes fine (the receiving node just sees no input), but
    React Flow warns on *every* render, producing thousands of console
    entries that choke the main thread and freeze the chat panel.

    We check against the node's registered `outputPorts[].id` for the source
    and `inputPorts[].id` for the target. Universal/dynamic nodes are skipped
    (their ports are provider-driven and not known up front).
    """
    universal_defs = {
        "openrouter-universal",
        "replicate-universal",
        "fal-universal",
        "nous-portal-universal",
    }
    for node_id, port, direction, port_key in [
        (src_node_id, src_port, "source", "outputPorts"),
        (dst_node_id, dst_port, "target", "inputPorts"),
    ]:
        node = cli_graph.nodes.get(node_id)
        if not node:
            # Missing-node error is surfaced by cli_graph.connect itself.
            continue
        definition_id = node.get("definitionId", "")
        if definition_id in universal_defs:
            continue
        defn = node_registry.get(definition_id)
        if not defn:
            continue
        valid = [p["id"] for p in defn.get(port_key, []) if isinstance(p, dict) and "id" in p]
        if port not in valid:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid {direction} handle '{port}' on node '{node_id}' "
                    f"(definition '{definition_id}'). Valid {port_key}: "
                    f"{valid if valid else '(none)'}"
                ),
            )


def _valid_param_keys(definition_id: str) -> set[str] | None:
    """Gather the set of param keys declared by a node definition.

    Returns None for nodes whose definition isn't found or for universal/dynamic
    nodes — those accept provider-supplied params we don't know up front, so we
    skip key validation rather than produce false negatives.
    """
    defn = node_registry.get(definition_id)
    if not defn:
        return None
    if definition_id in {
        "openrouter-universal",
        "replicate-universal",
        "fal-universal",
        "nous-portal-universal",
    }:
        return None
    keys: set[str] = set()
    for source_key in ("params", "sharedParams", "falParams", "directParams"):
        for p in defn.get(source_key, []) or []:
            if isinstance(p, dict) and p.get("key"):
                keys.add(p["key"])
    return keys


def _to_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off", ""):
        return False
    raise ValueError(f"cannot interpret {v!r} as boolean")


def _to_int(v: Any) -> int:
    if isinstance(v, bool):
        raise ValueError(f"refusing to coerce bool {v!r} to integer")
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v.is_integer():
            return int(v)
        raise ValueError(f"cannot coerce non-integer float {v!r} to integer")
    return int(str(v).strip())


def _to_float(v: Any) -> float:
    if isinstance(v, bool):
        raise ValueError(f"refusing to coerce bool {v!r} to float")
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v).strip())


def _coerce_params(definition_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """Coerce param values to the types declared in the node definition.

    The CLI sends every `--param k=v` as a string, and some providers (Meshy,
    for one) reject string values where booleans or ints are expected. Normalise
    here so handlers always receive correctly-typed params regardless of the
    caller's transport.
    """
    defn = node_registry.get(definition_id)
    if not defn:
        return dict(params)
    type_map: dict[str, str] = {}
    for source_key in ("params", "sharedParams", "falParams", "directParams"):
        for p in defn.get(source_key, []) or []:
            if isinstance(p, dict) and p.get("key") and p.get("type"):
                type_map[p["key"]] = p["type"]
    result: dict[str, Any] = {}
    for k, v in params.items():
        if k.startswith("_") or v is None:
            result[k] = v
            continue
        t = type_map.get(k)
        try:
            if t == "boolean":
                result[k] = _to_bool(v)
            elif t == "integer":
                result[k] = _to_int(v)
            elif t == "float":
                result[k] = _to_float(v)
            else:
                result[k] = v
        except (ValueError, TypeError) as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid value for param '{k}' ({t}): {e}",
            )
    return result


def _validate_params(definition_id: str, params: dict[str, Any]) -> None:
    """Raise 400 if params contain keys the definition doesn't declare.

    Keys starting with `_` are treated as frontend-internal state (e.g.
    `_previewUrl`, `_output_image`) and always allowed. Unknown keys usually
    mean a typo (e.g. `aspectRatio` vs `aspect_ratio`) that would otherwise
    silently fall back to defaults — surfacing it loudly here lets Claude
    correct mid-turn instead of producing an image with wrong settings.
    """
    valid = _valid_param_keys(definition_id)
    if valid is None:
        return
    unknown = [k for k in params if not k.startswith("_") and k not in valid]
    if unknown:
        suggestions: list[str] = []
        for u in unknown:
            u_low = u.lower()
            close = [v for v in valid if v.lower() == u_low or v.lower().replace("_", "") == u_low.replace("_", "")]
            if close:
                suggestions.append(f"{u} (did you mean {', '.join(close)}?)")
            else:
                suggestions.append(u)
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown param(s) for {definition_id}: {suggestions}. "
                f"Valid keys: {sorted(valid)}"
            ),
        )


@app.post("/api/graph/node")
async def create_graph_node(body: dict[str, Any]) -> dict:
    definition_id = body.get("definitionId", "")
    params = body.get("params", {}) or {}
    position = body.get("position")
    _validate_params(definition_id, params)
    params = _coerce_params(definition_id, params)
    short_id = cli_graph.add_node(definition_id, params, position=position)
    await _broadcast_graph_sync()
    publish_action(f"Added {definition_id} ({short_id})")
    return cli_graph.nodes[short_id]


@app.post("/api/graph/connect")
async def connect_graph_nodes(body: dict[str, Any]) -> dict:
    _validate_connect_handles(
        body.get("source", ""),
        body.get("sourceHandle", ""),
        body.get("target", ""),
        body.get("targetHandle", ""),
    )
    try:
        edge = cli_graph.connect(
            body["source"], body["sourceHandle"],
            body["target"], body["targetHandle"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _broadcast_graph_sync()
    publish_action(
        f"Wired {edge['source']}:{edge['sourceHandle']} → "
        f"{edge['target']}:{edge['targetHandle']}"
    )
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
    params = body.get("params", {}) or {}
    position = body.get("position")
    _validate_params(definition_id, params)
    params = _coerce_params(definition_id, params)
    short_id = cli_graph.add_node(definition_id, params, position=position)

    connect_spec = body.get("connect") or {}
    if connect_spec:
        is_target = connect_spec.get("newNodeIs") == "target"
        src = connect_spec.get("source") if is_target else short_id
        dst = short_id if is_target else connect_spec.get("target")
        try:
            _validate_connect_handles(
                src,
                connect_spec.get("sourceHandle", ""),
                dst,
                connect_spec.get("targetHandle", ""),
            )
            cli_graph.connect(
                src,
                connect_spec.get("sourceHandle", ""),
                dst,
                connect_spec.get("targetHandle", ""),
            )
            connected = True
        except HTTPException:
            # Invalid handle — roll back the just-created node so the graph
            # doesn't end up with a dangling node the caller didn't ask for
            # standalone. Re-raise so the client sees the handle error.
            cli_graph.remove_node(short_id)
            raise
        except ValueError:
            # Connection failed (e.g. unknown node id in connect_spec) but
            # node was created — leave the node in place, let the caller
            # decide.
            connected = False
    else:
        connected = False

    await _broadcast_graph_sync()
    publish_action(f"Added {definition_id} ({short_id})")
    if connected:
        publish_action(
            f"Wired {src}:{connect_spec.get('sourceHandle', '')} → "
            f"{dst}:{connect_spec.get('targetHandle', '')}"
        )
    return cli_graph.nodes[short_id]


@app.get("/api/graph")
async def get_graph() -> dict:
    return cli_graph.get_state()


@app.put("/api/graph/node/{node_id}")
async def update_graph_node(request: Request, node_id: str, body: dict[str, Any]) -> dict:
    node = cli_graph.nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")

    # §1.5 guard (mirrors /api/graph/run): when called BY Daedalus, refuse to
    # mutate params on a node that already has outputs. Without this, Daedalus
    # could route around the run-target guard via `nebula set` + `run-all`
    # (cache-bypassed because params changed). The X-Daedalus-Caller header
    # gate keeps frontend Inspector edits and curl/tests unaffected.
    if request.headers.get("x-daedalus-caller"):
        existing_outputs = node.get("outputs")
        if isinstance(existing_outputs, dict) and len(existing_outputs) > 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Node '{node_id}' already has output. Per SKILL.md §1.5, "
                    "add a new node instead of mutating params on this one — the "
                    "canvas should keep every iteration visible as craft history. "
                    "Use `nebula create <definition_id>` to start the next cut, "
                    "wire it from the corrected upstream, then `nebula run` it."
                ),
            )

    params = body.get("params", {}) or {}
    _validate_params(node.get("definitionId", ""), params)
    params = _coerce_params(node.get("definitionId", ""), params)
    try:
        cli_graph.update_params(node_id, params)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    publish_action(f"Updated {node_id} params")
    return cli_graph.nodes[node_id]


@app.delete("/api/graph")
async def clear_graph() -> dict:
    cli_graph.clear()
    await _broadcast_graph_sync()
    publish_action("Cleared the canvas")
    return {"status": "cleared"}


@app.delete("/api/graph/node/{node_id}")
async def delete_graph_node(node_id: str) -> dict:
    """Remove a node and any edges touching it from cli_graph."""
    try:
        cli_graph.remove_node(node_id)
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    await _broadcast_graph_sync()
    publish_action(f"Removed {node_id}")
    return {"status": "deleted", "id": node_id}


@app.get("/api/graph/node/{node_id}/path")
async def get_node_image_path(node_id: str) -> dict:
    """Resolve a node's primary image file to an absolute local path.

    Only works for image-input nodes (via their `filePath`, `file`, or
    `_previewUrl` param) or model nodes with an image-typed output.
    External URLs (anything not served from OUTPUT_ROOT) are rejected.
    Used by `nebula path` so Claude can Read node images as vision content.
    """
    node = cli_graph.nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")

    url = _resolve_primary_image_url(node)
    if url is None:
        raise HTTPException(
            status_code=400,
            detail=f"No image file for node '{node_id}'",
        )

    local_path = _url_to_output_path(url)
    if local_path is None:
        raise HTTPException(
            status_code=400,
            detail=f"Image for node '{node_id}' is not local (external URL)",
        )
    return {"path": str(local_path.resolve())}


def _resolve_primary_image_url(node: dict[str, Any]) -> str | None:
    """Return the best URL to read for this node, or None if it has no image."""
    params = node.get("params") or {}
    outputs = node.get("outputs") or {}
    definition_id = node.get("definitionId", "")

    if definition_id == "image-input":
        # filePath is the canonical schema key (see node_definitions.json).
        # `file` is accepted as a fallback because some backend code paths
        # (including the existing /api/upload endpoint and Task 3's new
        # chat-uploads endpoint) set that key alongside _previewUrl.
        value = (
            params.get("filePath")
            or params.get("file")
            or params.get("_previewUrl")
        )
        return str(value) if value else None

    # Model nodes with an image output produce {"image": {"type": "Image", "value": "..."}}
    # Walk outputs looking for any entry tagged as an Image with a value, preferring
    # the conventional "image" port name.
    preferred = outputs.get("image")
    if isinstance(preferred, dict) and preferred.get("value"):
        return str(preferred["value"])
    for out in outputs.values():
        if isinstance(out, dict) and out.get("type") == "Image" and out.get("value"):
            return str(out["value"])

    # Fallback: _previewUrl is currently only populated for image-input nodes.
    preview = params.get("_previewUrl")
    return str(preview) if preview else None


def _url_to_output_path(value: str) -> Path | None:
    """Resolve a node's image reference to a local filesystem path under
    OUTPUT_ROOT. Accepts either a served URL (`/api/outputs/...`) or an
    absolute local filesystem path. External URLs (http://, https://) and
    paths outside OUTPUT_ROOT return None so callers reject with a clear
    error."""
    if not value:
        return None
    if value.startswith(("http://", "https://")):
        return None

    prefix = "/api/outputs/"
    if value.startswith(prefix):
        candidate = (OUTPUT_ROOT / value[len(prefix):]).resolve()
    else:
        # Treat as a filesystem path (absolute or relative).
        candidate = Path(value).resolve()

    try:
        candidate.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        return None
    return candidate


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
        publish_action(
            f"Unwired {body.get('source', '')}:{body.get('sourceHandle', '')} → "
            f"{body.get('target', '')}:{body.get('targetHandle', '')}"
        )
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
    publish_action(
        f"Loaded graph ({len(cli_graph.nodes)} nodes, {len(cli_graph.edges)} edges)"
    )
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
async def run_graph(request: Request, body: dict[str, Any] | None = None) -> dict:
    """Execute the CLI graph synchronously and return results.

    §1.5 guard: when called BY Daedalus (header X-Daedalus-Caller set) and
    TARGETING a specific node that already has outputs, block with 400 and
    point him at the rule. Iteration must ADD a new node — re-running the
    same node in place overwrites the craft log we want on the canvas. The
    header gate lets humans (frontend Run button, curl, tests) keep the
    rerun-in-place affordance; only the agent is disciplined here."""
    if not cli_graph.nodes:
        raise HTTPException(status_code=400, detail="Graph is empty")

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes_list, edges_list = cli_graph.to_execute_format()

    target = body.get("targetNodeId") if body else None

    if target and request.headers.get("x-daedalus-caller"):
        existing_outputs = cli_graph.nodes.get(target, {}).get("outputs")
        if isinstance(existing_outputs, dict) and len(existing_outputs) > 0:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Node '{target}' already has output. Per SKILL.md §1.5, "
                    "add a new node instead of re-running in place — the canvas "
                    "should keep every iteration visible as craft history. "
                    "Use `nebula add <family>-<variant>` to create the next cut, "
                    "wire it from the corrected upstream, then `nebula run` the "
                    "new node id."
                ),
            )

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

    publish_action(
        f"Running {target}..." if target else f"Running {len(sub_nodes)} node(s)..."
    )

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

    if errors:
        publish_action(
            f"Ran {len(results) + len(errors)} node(s) in {duration:.1f}s — "
            f"{len(errors)} errored: {', '.join(errors.keys())}"
        )
    else:
        publish_action(
            f"Ran {len(results)} node(s) cleanly in {duration:.1f}s"
        )

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
