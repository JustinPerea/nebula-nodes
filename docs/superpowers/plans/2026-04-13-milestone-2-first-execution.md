# Milestone 2: First Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a Python FastAPI backend to the existing React frontend so that a user can drop a Text Input node + GPT Image 1 node on the canvas, connect them, click Run, and see the generated image appear — with live node state indicators driven by WebSocket events.

**Architecture:** A FastAPI backend receives the graph via `POST /api/execute`, validates it, topologically sorts nodes, and executes them sequentially through a sync runner. Each state change emits a WebSocket event that the frontend consumes to update node visual states in real time. The OpenAI Image handler calls `POST https://api.openai.com/v1/images/generations`, receives base64-encoded PNG data, saves it to a local output directory, and serves the file back through a `/api/outputs/` static file mount so the frontend can display it as an `<img>` tag.

**Tech Stack:** Python 3.12+, FastAPI, uvicorn, httpx, Pydantic v2, graphlib (stdlib), Vite dev proxy, Zustand, TypeScript

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md`
- Edge cases: `docs/perplexity-research/nebula-edge-cases.md`

---

## File Structure (new and modified files)

```
nebula_nodes/
├── backend/
│   ├── main.py                         # FastAPI app, REST + WebSocket endpoints
│   ├── models/
│   │   ├── __init__.py
│   │   ├── graph.py                    # Pydantic: GraphNode, GraphEdge, ExecuteRequest
│   │   └── events.py                   # Pydantic: ExecutionEvent variants
│   ├── execution/
│   │   ├── __init__.py
│   │   ├── engine.py                   # Topological sort, validation, orchestration
│   │   └── sync_runner.py              # Sync API call handler
│   ├── handlers/
│   │   ├── __init__.py
│   │   └── openai_image.py             # GPT Image 1 generate handler
│   ├── services/
│   │   ├── __init__.py
│   │   ├── settings.py                 # Load/save settings.json
│   │   └── output.py                   # Output directory management + base64 decode/save
│   ├── requirements.txt
│   └── tests/
│       ├── __init__.py
│       ├── test_engine.py              # Topological sort + validation tests
│       └── test_openai_handler.py      # Handler unit tests (mocked HTTP)
│
├── frontend/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── wsClient.ts             # NEW: WebSocket client singleton
│   │   │   └── api.ts                  # NEW: REST API client (executeGraph, settings)
│   │   ├── store/
│   │   │   └── graphStore.ts           # MODIFY: add executeGraph(), resetExecution(), WS event handlers
│   │   └── components/
│   │       ├── nodes/
│   │       │   └── ModelNode.tsx        # MODIFY: render image preview from output file path
│   │       └── panels/
│   │           └── Toolbar.tsx          # MODIFY: wire Run button to executeGraph()
│   └── vite.config.ts                  # MODIFY: add proxy to backend
```

---

## Task 1: Backend Scaffolding

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/main.py`
- Remove: `backend/.gitkeep`

### Estimated time: 3 minutes

- [ ] **Step 1: Create requirements.txt**

Create `backend/requirements.txt`:

```txt
fastapi==0.115.12
uvicorn[standard]==0.34.2
httpx==0.28.1
pydantic==2.11.3
python-dotenv==1.1.0
```

- [ ] **Step 2: Create main.py with health endpoint**

Create `backend/main.py`:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Nebula Node Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}
```

- [ ] **Step 3: Remove .gitkeep**

```bash
rm /Users/justinperea/Documents/Projects/nebula_nodes/backend/.gitkeep
```

- [ ] **Step 4: Create venv and install deps**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- [ ] **Step 5: Verify uvicorn starts and health endpoint responds**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
uvicorn main:app --port 8000 &
sleep 2
curl -s http://localhost:8000/api/health
# Expected: {"status":"ok","version":"0.1.0"}
kill %1
```

- [ ] **Step 6: Commit**

```
feat(backend): scaffold FastAPI app with health endpoint
```

---

## Task 2: Pydantic Models

**Files:**
- Create: `backend/models/__init__.py`
- Create: `backend/models/graph.py`
- Create: `backend/models/events.py`

### Estimated time: 4 minutes

- [ ] **Step 1: Create models/__init__.py**

Create `backend/models/__init__.py`:

```python
from .graph import GraphNode, GraphEdge, ExecuteRequest, PortValueDict
from .events import (
    ExecutionEvent,
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    ValidationErrorDetail,
    GraphCompleteEvent,
)

__all__ = [
    "GraphNode",
    "GraphEdge",
    "ExecuteRequest",
    "PortValueDict",
    "ExecutionEvent",
    "QueuedEvent",
    "ExecutingEvent",
    "ProgressEvent",
    "ExecutedEvent",
    "ErrorEvent",
    "ValidationErrorEvent",
    "ValidationErrorDetail",
    "GraphCompleteEvent",
]
```

- [ ] **Step 2: Create models/graph.py**

Create `backend/models/graph.py`:

```python
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PortValueDict(BaseModel):
    type: str
    value: str | list[str] | dict[str, str] | None = None


class GraphNode(BaseModel):
    id: str
    definition_id: str = Field(alias="definitionId")
    params: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, PortValueDict] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class GraphEdge(BaseModel):
    id: str
    source: str
    source_handle: str | None = Field(None, alias="sourceHandle")
    target: str
    target_handle: str | None = Field(None, alias="targetHandle")

    model_config = {"populate_by_name": True}


class ExecuteRequest(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
```

- [ ] **Step 3: Create models/events.py**

Create `backend/models/events.py`:

```python
from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel


class QueuedEvent(BaseModel):
    type: Literal["queued"] = "queued"
    node_id: str


class ExecutingEvent(BaseModel):
    type: Literal["executing"] = "executing"
    node_id: str


class ProgressEvent(BaseModel):
    type: Literal["progress"] = "progress"
    node_id: str
    value: float


class ExecutedEvent(BaseModel):
    type: Literal["executed"] = "executed"
    node_id: str
    outputs: dict[str, Any]


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    node_id: str
    error: str
    retryable: bool = False


class ValidationErrorDetail(BaseModel):
    node_id: str
    port_id: str
    message: str


class ValidationErrorEvent(BaseModel):
    type: Literal["validation_error"] = "validation_error"
    errors: list[ValidationErrorDetail]


class GraphCompleteEvent(BaseModel):
    type: Literal["graph_complete"] = "graph_complete"
    duration: float
    nodes_executed: int


ExecutionEvent = Union[
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    GraphCompleteEvent,
]
```

- [ ] **Step 4: Verify models import cleanly**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "from models import GraphNode, ExecuteRequest, QueuedEvent, ExecutedEvent; print('Models OK')"
```

- [ ] **Step 5: Commit**

```
feat(backend): add Pydantic models for graph and execution events
```

---

## Task 3: Settings Service

**Files:**
- Create: `backend/services/__init__.py`
- Create: `backend/services/settings.py`

### Estimated time: 3 minutes

- [ ] **Step 1: Create services/__init__.py**

Create `backend/services/__init__.py`:

```python
```

(Empty file — just makes it a package.)

- [ ] **Step 2: Create services/settings.py**

Create `backend/services/settings.py`:

```python
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SETTINGS_PATH = Path(__file__).resolve().parent.parent.parent / "settings.json"

DEFAULT_SETTINGS: dict[str, Any] = {
    "apiKeys": {},
    "routing": {},
    "outputPath": None,
    "executionMode": "manual",
    "batchSizeCap": 25,
}


def load_settings() -> dict[str, Any]:
    """Load settings.json from project root. Returns defaults if file missing."""
    if SETTINGS_PATH.exists():
        with open(SETTINGS_PATH, "r") as f:
            return json.load(f)
    return dict(DEFAULT_SETTINGS)


def save_settings(settings: dict[str, Any]) -> None:
    """Write settings to settings.json at project root."""
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def get_api_key(provider_key_name: str | list[str]) -> str | None:
    """Get an API key by its env key name. Tries each name in order for lists."""
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    if isinstance(provider_key_name, str):
        names = [provider_key_name]
    else:
        names = provider_key_name

    for name in names:
        key = api_keys.get(name)
        if key:
            return key
    return None
```

- [ ] **Step 3: Verify settings service works**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from services.settings import load_settings, save_settings, get_api_key, SETTINGS_PATH
print(f'Settings path: {SETTINGS_PATH}')
s = load_settings()
print(f'Loaded: {s}')
s['apiKeys']['OPENAI_API_KEY'] = 'sk-test-123'
save_settings(s)
key = get_api_key('OPENAI_API_KEY')
print(f'Got key: {key}')
import os; os.remove(SETTINGS_PATH)
print('Cleanup done')
"
```

- [ ] **Step 4: Commit**

```
feat(backend): add settings service for API key management
```

---

## Task 4: Output Service

**Files:**
- Create: `backend/services/output.py`

### Estimated time: 3 minutes

- [ ] **Step 1: Create services/output.py**

Create `backend/services/output.py`:

```python
from __future__ import annotations

import base64
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

OUTPUT_ROOT = Path(__file__).resolve().parent.parent.parent / "output"


def get_run_dir() -> Path:
    """Create and return a timestamped output directory for the current run."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    run_dir = OUTPUT_ROOT / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def save_base64_image(b64_data: str, run_dir: Path, extension: str = "png") -> Path:
    """Decode a base64 image string and save to the run directory.

    Returns the absolute path to the saved file.
    """
    image_bytes = base64.b64decode(b64_data)
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    file_path.write_bytes(image_bytes)
    return file_path
```

- [ ] **Step 2: Verify output service works**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
import base64
from services.output import get_run_dir, save_base64_image

run_dir = get_run_dir()
print(f'Run dir: {run_dir}')
assert run_dir.exists()

# Tiny 1x1 red PNG
red_pixel_b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
path = save_base64_image(red_pixel_b64, run_dir)
print(f'Saved: {path} ({path.stat().st_size} bytes)')
assert path.exists()
assert path.stat().st_size > 0

# Cleanup
import shutil; shutil.rmtree(run_dir.parent)
print('Cleanup done')
"
```

- [ ] **Step 3: Commit**

```
feat(backend): add output service for base64 image decoding and file storage
```

---

## Task 5: Execution Engine with Tests

**Files:**
- Create: `backend/execution/__init__.py`
- Create: `backend/execution/engine.py`
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/test_engine.py`

### Estimated time: 5 minutes

- [ ] **Step 1: Install pytest**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
pip install pytest pytest-asyncio
```

- [ ] **Step 2: Create execution/__init__.py**

Create `backend/execution/__init__.py`:

```python
```

- [ ] **Step 3: Create tests/__init__.py**

Create `backend/tests/__init__.py`:

```python
```

- [ ] **Step 4: Write tests first (TDD)**

Create `backend/tests/test_engine.py`:

```python
from __future__ import annotations

import pytest

from execution.engine import topological_sort, validate_graph, CycleError
from models.graph import GraphNode, GraphEdge


def _node(nid: str, def_id: str = "gpt-image-1-generate") -> GraphNode:
    return GraphNode(id=nid, definitionId=def_id, params={}, outputs={})


def _edge(src: str, tgt: str, src_handle: str = "image", tgt_handle: str = "prompt") -> GraphEdge:
    return GraphEdge(
        id=f"{src}->{tgt}",
        source=src,
        sourceHandle=src_handle,
        target=tgt,
        targetHandle=tgt_handle,
    )


class TestTopologicalSort:
    def test_single_node(self) -> None:
        nodes = [_node("a")]
        order = topological_sort(nodes, [])
        assert order == ["a"]

    def test_linear_chain(self) -> None:
        """a -> b -> c should execute in order a, b, c."""
        nodes = [_node("a", "text-input"), _node("b"), _node("c", "preview")]
        edges = [_edge("a", "b", "text", "prompt"), _edge("b", "c", "image", "input")]
        order = topological_sort(nodes, edges)
        assert order == ["a", "b", "c"]

    def test_diamond_graph(self) -> None:
        """
        a -> b -> d
        a -> c -> d
        a must come first, d must come last.
        """
        nodes = [_node("a", "text-input"), _node("b"), _node("c"), _node("d", "preview")]
        edges = [
            _edge("a", "b", "text", "prompt"),
            _edge("a", "c", "text", "prompt"),
            _edge("b", "d", "image", "input"),
            _edge("c", "d", "image", "input"),
        ]
        order = topological_sort(nodes, edges)
        assert order[0] == "a"
        assert order[-1] == "d"
        assert set(order) == {"a", "b", "c", "d"}

    def test_disconnected_subgraphs(self) -> None:
        """Two independent nodes should both appear."""
        nodes = [_node("a"), _node("b")]
        order = topological_sort(nodes, [])
        assert set(order) == {"a", "b"}

    def test_cycle_raises(self) -> None:
        nodes = [_node("a"), _node("b")]
        edges = [_edge("a", "b"), _edge("b", "a")]
        with pytest.raises(CycleError):
            topological_sort(nodes, edges)


class TestValidateGraph:
    def test_valid_graph_passes(self) -> None:
        nodes = [
            _node("a", "text-input"),
            _node("b", "gpt-image-1-generate"),
        ]
        edges = [_edge("a", "b", "text", "prompt")]
        api_keys = {"OPENAI_API_KEY": "sk-test"}
        errors = validate_graph(nodes, edges, api_keys)
        assert errors == []

    def test_missing_required_port(self) -> None:
        """gpt-image-1-generate has required 'prompt' input. Unconnected should error."""
        nodes = [_node("b", "gpt-image-1-generate")]
        errors = validate_graph(nodes, [], {})
        port_errors = [e for e in errors if e.port_id == "prompt"]
        assert len(port_errors) == 1
        assert "required" in port_errors[0].message.lower()

    def test_missing_api_key(self) -> None:
        """gpt-image-1-generate needs OPENAI_API_KEY."""
        nodes = [
            _node("a", "text-input"),
            _node("b", "gpt-image-1-generate"),
        ]
        edges = [_edge("a", "b", "text", "prompt")]
        errors = validate_graph(nodes, edges, {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 1

    def test_utility_node_no_key_needed(self) -> None:
        """text-input has empty envKeyName — should not require any key."""
        nodes = [_node("a", "text-input")]
        errors = validate_graph(nodes, [], {})
        key_errors = [e for e in errors if "api key" in e.message.lower()]
        assert len(key_errors) == 0
```

- [ ] **Step 5: Verify tests fail (no implementation yet)**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_engine.py -v 2>&1 | head -30
# Expected: ImportError or ModuleNotFoundError for execution.engine
```

- [ ] **Step 6: Implement execution/engine.py**

Create `backend/execution/engine.py`:

```python
from __future__ import annotations

import asyncio
import time
from graphlib import TopologicalSorter, CycleError as _GraphlibCycleError
from typing import Any, Callable, Awaitable

from models.graph import GraphNode, GraphEdge, PortValueDict
from models.events import (
    ExecutionEvent,
    QueuedEvent,
    ExecutingEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorDetail,
    GraphCompleteEvent,
)

# Re-export-friendly alias
CycleError = _GraphlibCycleError

# Node definitions mirrored from frontend constants.
# Only the fields we need for validation. In a future milestone this will be
# loaded from a shared definitions file.
NODE_DEFS: dict[str, dict[str, Any]] = {
    "gpt-image-1-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "claude-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "ANTHROPIC_API_KEY",
    },
    "runway-gen4-turbo": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": False},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "RUNWAY_API_KEY",
    },
    "elevenlabs-tts": {
        "inputPorts": [{"id": "text", "required": True}],
        "outputPorts": [{"id": "audio"}],
        "envKeyName": "ELEVENLABS_API_KEY",
    },
    "flux-1-1-ultra": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "image", "required": False},
        ],
        "outputPorts": [{"id": "image"}],
        "envKeyName": ["FAL_KEY", "BFL_API_KEY"],
    },
    "text-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "image-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "image"}],
        "envKeyName": [],
    },
    "preview": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [],
        "envKeyName": [],
    },
}


def topological_sort(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[str]:
    """Return node IDs in topological execution order.

    Raises CycleError if the graph contains a cycle.
    """
    graph: dict[str, set[str]] = {node.id: set() for node in nodes}
    for edge in edges:
        if edge.target in graph:
            graph[edge.target].add(edge.source)

    sorter = TopologicalSorter(graph)
    try:
        return list(sorter.static_order())
    except _GraphlibCycleError as exc:
        raise CycleError(str(exc)) from exc


def validate_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
) -> list[ValidationErrorDetail]:
    """Validate the graph before execution.

    Checks:
    1. All required input ports are connected.
    2. All required API keys are present.

    Returns a list of validation errors (empty = valid).
    """
    errors: list[ValidationErrorDetail] = []

    # Build set of connected target ports: (target_node_id, target_handle)
    connected_ports: set[tuple[str, str]] = set()
    for edge in edges:
        if edge.target_handle:
            connected_ports.add((edge.target, edge.target_handle))

    for node in nodes:
        node_def = NODE_DEFS.get(node.definition_id)
        if not node_def:
            continue

        # Check required input ports
        for port in node_def["inputPorts"]:
            if port.get("required", False):
                if (node.id, port["id"]) not in connected_ports:
                    errors.append(
                        ValidationErrorDetail(
                            node_id=node.id,
                            port_id=port["id"],
                            message=f"Required input port '{port['id']}' is not connected",
                        )
                    )

        # Check API keys
        env_key = node_def.get("envKeyName", [])
        if isinstance(env_key, str) and env_key:
            key_names = [env_key]
        elif isinstance(env_key, list):
            key_names = env_key
        else:
            key_names = []

        if key_names and not any(api_keys.get(k) for k in key_names):
            key_display = " or ".join(key_names)
            errors.append(
                ValidationErrorDetail(
                    node_id=node.id,
                    port_id="",
                    message=f"Missing API key: {key_display}",
                )
            )

    return errors


# Type alias for a node handler function:
# (node, resolved_inputs, api_keys) -> outputs dict
NodeHandler = Callable[
    [GraphNode, dict[str, PortValueDict], dict[str, str]],
    Awaitable[dict[str, Any]],
]


async def execute_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
    handler_registry: dict[str, NodeHandler],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> None:
    """Execute the graph in topological order.

    For each node:
    1. Emit queued
    2. Resolve inputs from upstream outputs
    3. Emit executing
    4. Call the handler
    5. Emit executed (or error)
    After all nodes: emit graph_complete.
    """
    start_time = time.monotonic()
    nodes_executed = 0

    # Index nodes by ID
    node_map: dict[str, GraphNode] = {n.id: n for n in nodes}

    # Track outputs per node
    outputs_cache: dict[str, dict[str, PortValueDict]] = {}

    # Get execution order
    order = topological_sort(nodes, edges)

    # Mark all as queued
    for nid in order:
        await emit(QueuedEvent(node_id=nid))

    for nid in order:
        node = node_map[nid]
        await emit(ExecutingEvent(node_id=nid))

        # Resolve inputs from upstream edges
        resolved_inputs: dict[str, PortValueDict] = {}
        for edge in edges:
            if edge.target == nid and edge.source_handle and edge.target_handle:
                upstream_outputs = outputs_cache.get(edge.source, {})
                if edge.source_handle in upstream_outputs:
                    resolved_inputs[edge.target_handle] = upstream_outputs[edge.source_handle]

        try:
            handler = handler_registry.get(node.definition_id)
            if handler is None:
                # Utility nodes with no handler pass through
                # text-input: output the 'value' param as text
                if node.definition_id == "text-input":
                    text_value = node.params.get("value", "")
                    node_outputs = {
                        "text": {"type": "Text", "value": str(text_value)}
                    }
                elif node.definition_id == "image-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {
                        "image": {"type": "Image", "value": str(file_path)}
                    }
                elif node.definition_id == "preview":
                    # Pass through input as-is
                    node_outputs = {}
                    if "input" in resolved_inputs:
                        node_outputs["input"] = {
                            "type": resolved_inputs["input"].type,
                            "value": resolved_inputs["input"].value,
                        }
                else:
                    raise RuntimeError(f"No handler registered for '{node.definition_id}'")
            else:
                node_outputs = await handler(node, resolved_inputs, api_keys)

            # Cache outputs as PortValueDict for downstream resolution
            outputs_cache[nid] = {
                k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                for k, v in node_outputs.items()
            }

            await emit(ExecutedEvent(node_id=nid, outputs=node_outputs))
            nodes_executed += 1

        except Exception as exc:
            await emit(
                ErrorEvent(
                    node_id=nid,
                    error=str(exc),
                    retryable=False,
                )
            )
            # Stop execution on error — downstream nodes depend on this output
            break

    duration = time.monotonic() - start_time
    await emit(GraphCompleteEvent(duration=round(duration, 3), nodes_executed=nodes_executed))
```

- [ ] **Step 7: Verify all tests pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_engine.py -v
# Expected: 9 passed
```

- [ ] **Step 8: Commit**

```
feat(backend): add execution engine with topological sort, validation, and orchestration
```

---

## Task 6: OpenAI Image Handler with Tests

**Files:**
- Create: `backend/handlers/__init__.py`
- Create: `backend/handlers/openai_image.py`
- Create: `backend/tests/test_openai_handler.py`

### Estimated time: 5 minutes

- [ ] **Step 1: Write tests first (TDD)**

Create `backend/tests/test_openai_handler.py`:

```python
from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.openai_image import handle_openai_image_generate
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT

# Tiny 1x1 red PNG as base64
RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="test-node-1",
        definitionId="gpt-image-1-generate",
        params=params or {"model": "gpt-image-1", "size": "1024x1024", "quality": "auto", "n": 1},
    )


def _mock_response(b64_data: str) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "created": 1234567890,
        "data": [{"b64_json": b64_data}],
    }
    return resp


@pytest.fixture(autouse=True)
def cleanup_output():
    yield
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)


@pytest.mark.asyncio
async def test_generates_image_and_saves_file() -> None:
    mock_resp = _mock_response(RED_PIXEL_B64)

    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.return_value = mock_resp
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="a red pixel")}
        api_keys = {"OPENAI_API_KEY": "sk-test-key"}

        result = await handle_openai_image_generate(node, inputs, api_keys)

    assert "image" in result
    assert result["image"]["type"] == "Image"
    file_path = Path(result["image"]["value"])
    assert file_path.suffix == ".png"

    # Verify the API was called with correct params
    call_kwargs = mock_client_instance.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["model"] == "gpt-image-1"
    assert body["prompt"] == "a red pixel"
    assert body["response_format"] == "b64_json"


@pytest.mark.asyncio
async def test_missing_prompt_raises() -> None:
    node = _make_node()
    inputs: dict[str, PortValueDict] = {}
    api_keys = {"OPENAI_API_KEY": "sk-test-key"}

    with pytest.raises(ValueError, match="[Pp]rompt"):
        await handle_openai_image_generate(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_api_error_propagates() -> None:
    with patch("handlers.openai_image.httpx.AsyncClient") as MockClient:
        mock_client_instance = AsyncMock()
        mock_client_instance.post.side_effect = RuntimeError("API connection failed")
        mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
        mock_client_instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client_instance

        node = _make_node()
        inputs = {"prompt": PortValueDict(type="Text", value="test")}
        api_keys = {"OPENAI_API_KEY": "sk-test-key"}

        with pytest.raises(RuntimeError, match="API connection failed"):
            await handle_openai_image_generate(node, inputs, api_keys)
```

- [ ] **Step 2: Verify tests fail (no implementation yet)**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_openai_handler.py -v 2>&1 | head -20
# Expected: ImportError for handlers.openai_image
```

- [ ] **Step 3: Create handlers/__init__.py**

Create `backend/handlers/__init__.py`:

```python
```

- [ ] **Step 4: Implement openai_image.py**

Create `backend/handlers/openai_image.py`:

```python
from __future__ import annotations

from typing import Any

import httpx

from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir, save_base64_image

OPENAI_API_URL = "https://api.openai.com/v1/images/generations"


async def handle_openai_image_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """Execute a gpt-image-1 image generation call.

    Sends the request to OpenAI, receives b64_json, decodes and saves
    the PNG to the output directory.

    Returns: {"image": {"type": "Image", "value": "<absolute file path>"}}
    """
    # Extract prompt from resolved inputs
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")

    prompt_text = str(prompt_input.value)

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    # Build request body from node params
    body: dict[str, Any] = {
        "model": node.params.get("model", "gpt-image-1"),
        "prompt": prompt_text,
        "response_format": "b64_json",
    }

    size = node.params.get("size")
    if size and size != "auto":
        body["size"] = size

    quality = node.params.get("quality")
    if quality and quality != "auto":
        body["quality"] = quality

    n = node.params.get("n", 1)
    if n and int(n) > 1:
        body["n"] = int(n)

    # Call OpenAI API
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            OPENAI_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
        response.raise_for_status()

    data = response.json()
    b64_data = data["data"][0]["b64_json"]

    # Save to output directory
    run_dir = get_run_dir()
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {
        "image": {
            "type": "Image",
            "value": str(file_path),
        }
    }
```

- [ ] **Step 5: Verify all handler tests pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_openai_handler.py -v
# Expected: 3 passed
```

- [ ] **Step 6: Commit**

```
feat(backend): add OpenAI image generation handler with base64 decode and save
```

---

## Task 7: Sync Runner

**Files:**
- Create: `backend/execution/sync_runner.py`

### Estimated time: 2 minutes

- [ ] **Step 1: Create sync_runner.py**

Create `backend/execution/sync_runner.py`:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from handlers.openai_image import handle_openai_image_generate

# Registry of sync handlers by definition ID.
# Each handler: (node, resolved_inputs, api_keys) -> outputs dict
SYNC_HANDLERS: dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
] = {
    "gpt-image-1-generate": handle_openai_image_generate,
}


def get_handler_registry() -> dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
]:
    """Return the full handler registry for the execution engine."""
    return dict(SYNC_HANDLERS)
```

- [ ] **Step 2: Verify import works**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "from execution.sync_runner import get_handler_registry; print(f'Handlers: {list(get_handler_registry().keys())}')"
# Expected: Handlers: ['gpt-image-1-generate']
```

- [ ] **Step 3: Commit**

```
feat(backend): add sync runner with handler registry
```

---

## Task 8: WebSocket + REST Endpoints

**Files:**
- Modify: `backend/main.py`

### Estimated time: 5 minutes

- [ ] **Step 1: Replace main.py with full endpoints**

Replace the entire contents of `backend/main.py` with:

```python
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
        """Serialize event and broadcast to all connected clients."""
        # Convert to camelCase for frontend consumption
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
    """Convert a Pydantic event model to a camelCase dict for the frontend."""
    raw = event.model_dump()
    result: dict[str, Any] = {}
    for key, value in raw.items():
        # Convert snake_case to camelCase
        parts = key.split("_")
        camel = parts[0] + "".join(p.capitalize() for p in parts[1:])
        if camel == "nodeId" and isinstance(value, str):
            result["nodeId"] = value
        elif camel == "nodesExecuted":
            result["nodesExecuted"] = value
        else:
            result[camel] = value
        # Also transform nested ValidationErrorDetail objects
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
            # Keep connection alive — client can send pings
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
    # Mask API key values for security — only return whether they exist
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
    # Merge: only update keys that are present in the request
    if "apiKeys" in body:
        current_keys = current.get("apiKeys", {})
        for k, v in body["apiKeys"].items():
            # Skip masked values (don't overwrite with "***...")
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
    """Trigger graph execution. Events are broadcast over WebSocket."""
    settings = load_settings()
    api_keys = settings.get("apiKeys", {})

    # Validate
    errors = validate_graph(request.nodes, request.edges, api_keys)
    if errors:
        await manager.broadcast(ValidationErrorEvent(errors=errors))
        return {"status": "validation_error", "errorCount": len(errors)}

    # Check for cycles
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

    # Execute in background so the REST response returns immediately
    handler_registry = get_handler_registry()

    async def _run() -> None:
        await execute_graph(
            nodes=request.nodes,
            edges=request.edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=manager.broadcast,
        )

    asyncio.create_task(_run())

    return {"status": "started"}
```

- [ ] **Step 2: Verify server starts with all endpoints**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
uvicorn main:app --port 8000 &
sleep 2
curl -s http://localhost:8000/api/health
# Expected: {"status":"ok","version":"0.1.0"}
curl -s http://localhost:8000/api/settings
# Expected: {"apiKeys":{},"routing":{},"outputPath":null,"executionMode":"manual","batchSizeCap":25}
kill %1
```

- [ ] **Step 3: Run all backend tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/ -v
# Expected: 12 passed (9 engine + 3 handler)
```

- [ ] **Step 4: Commit**

```
feat(backend): add WebSocket event bus and REST endpoints for graph execution
```

---

## Task 9: Frontend WebSocket Client

**Files:**
- Create: `frontend/src/lib/wsClient.ts`

### Estimated time: 3 minutes

- [ ] **Step 1: Create wsClient.ts**

Create `frontend/src/lib/wsClient.ts`:

```typescript
export type ExecutionEvent =
  | { type: 'queued'; nodeId: string }
  | { type: 'executing'; nodeId: string }
  | { type: 'progress'; nodeId: string; value: number }
  | { type: 'executed'; nodeId: string; outputs: Record<string, { type: string; value: string | null }> }
  | { type: 'error'; nodeId: string; error: string; retryable: boolean }
  | { type: 'validationError'; errors: Array<{ nodeId: string; portId: string; message: string }> }
  | { type: 'graphComplete'; duration: number; nodesExecuted: number };

type EventHandler = (event: ExecutionEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Set<EventHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[ws] connected');
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as ExecutionEvent;
        for (const handler of this.handlers) {
          handler(parsed);
        }
      } catch (err) {
        console.error('[ws] failed to parse message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[ws] disconnected, reconnecting in 3s...');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[ws] error:', err);
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

// Singleton — uses Vite proxy, so relative path works
export const wsClient = new WebSocketClient('ws://localhost:8000/ws');
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit src/lib/wsClient.ts 2>&1 || echo "Check errors above"
```

- [ ] **Step 3: Commit**

```
feat(frontend): add WebSocket client for execution events
```

---

## Task 10: Frontend API Client + Execution Wiring

**Files:**
- Create: `frontend/src/lib/api.ts`
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/panels/Toolbar.tsx`
- Modify: `frontend/src/components/nodes/ModelNode.tsx`
- Modify: `frontend/vite.config.ts`

### Estimated time: 5 minutes

- [ ] **Step 1: Create api.ts**

Create `frontend/src/lib/api.ts`:

```typescript
const API_BASE = '/api';

export async function executeGraph(
  nodes: Array<{
    id: string;
    definitionId: string;
    params: Record<string, unknown>;
    outputs: Record<string, unknown>;
  }>,
  edges: Array<{
    id: string;
    source: string;
    sourceHandle: string | null | undefined;
    target: string;
    targetHandle: string | null | undefined;
  }>,
): Promise<{ status: string; errorCount?: number }> {
  const response = await fetch(`${API_BASE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges }),
  });
  if (!response.ok) {
    throw new Error(`Execute failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}/settings`);
  if (!response.ok) {
    throw new Error(`Get settings failed: ${response.status}`);
  }
  return response.json();
}

export async function updateSettings(
  settings: Record<string, unknown>,
): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(`Update settings failed: ${response.status}`);
  }
  return response.json();
}
```

- [ ] **Step 2: Add Vite proxy to backend**

Replace the entire contents of `frontend/vite.config.ts` with:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 3: Update graphStore.ts with execution actions**

Replace the entire contents of `frontend/src/store/graphStore.ts` with:

```typescript
import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { executeGraph as apiExecuteGraph } from '../lib/api';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isExecuting: boolean;

  addNode: (definitionId: string, position: { x: number; y: number }) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  executeGraph: () => Promise<void>;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
}

// Connect WebSocket on module load
wsClient.connect();
wsClient.subscribe((event) => {
  useGraphStore.getState().handleExecutionEvent(event);
});

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: false,

  addNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return;

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) {
        defaults[param.key] = param.default;
      }
    }

    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: 'model-node',
      position,
      data: {
        label: definition.displayName,
        definitionId,
        params: defaults,
        state: 'idle',
        outputs: {},
      },
    };

    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes
      .filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove')
      .map((c) => c.id);

    if (removedIds.length > 0) {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        edges: state.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)
        ),
      }));
    } else {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
      }));
    }
  },

  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
  },

  onConnect: (connection) => {
    if (!connection.source || !connection.target) return;

    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
    const targetDef = NODE_DEFINITIONS[targetNode.data.definitionId];
    if (!sourceDef || !targetDef) return;

    const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
    const dataType = sourcePort?.dataType ?? 'Any';

    const newEdge: Edge = {
      id: uuidv4(),
      source: connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.target,
      targetHandle: connection.targetHandle,
      type: 'typed-edge',
      data: { dataType },
    };

    set((state) => ({ edges: [...state.edges, newEdge] }));
  },

  updateNodeData: (nodeId, data) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      ),
    }));
  },

  resetExecution: () => {
    set((state) => ({
      isExecuting: false,
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, state: 'idle' as const, error: undefined, progress: undefined },
      })),
    }));
  },

  executeGraph: async () => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;

    // Reset all nodes to idle before starting
    resetExecution();
    set({ isExecuting: true });

    // Build the payload — extract data from ReactFlow node format
    const graphNodes = nodes.map((n) => ({
      id: n.id,
      definitionId: n.data.definitionId,
      params: n.data.params,
      outputs: {},
    }));

    const graphEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    }));

    try {
      const result = await apiExecuteGraph(graphNodes, graphEdges);
      if (result.status === 'validation_error') {
        // Validation errors will arrive via WebSocket
        set({ isExecuting: false });
      }
      // If started, execution events will arrive via WebSocket
    } catch (err) {
      console.error('Failed to start execution:', err);
      set({ isExecuting: false });
    }
  },

  handleExecutionEvent: (event) => {
    switch (event.type) {
      case 'queued':
        get().updateNodeData(event.nodeId, { state: 'queued' });
        break;

      case 'executing':
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0 });
        break;

      case 'progress':
        get().updateNodeData(event.nodeId, { progress: event.value });
        break;

      case 'executed': {
        // Convert outputs: replace absolute file paths with API-served URLs
        const outputs: Record<string, { type: string; value: string | null }> = {};
        for (const [key, val] of Object.entries(event.outputs)) {
          const outputVal = val as { type: string; value: string | null };
          if (outputVal.type === 'Image' && outputVal.value && typeof outputVal.value === 'string') {
            // Convert absolute path to URL served by backend
            // Path like /Users/.../output/2026-04-13_12-00-00/abc123.png
            // -> /api/outputs/2026-04-13_12-00-00/abc123.png
            const outputIdx = outputVal.value.indexOf('/output/');
            if (outputIdx !== -1) {
              const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
              outputs[key] = {
                type: outputVal.type,
                value: `/api/outputs/${relativePath}`,
              };
            } else {
              outputs[key] = outputVal;
            }
          } else {
            outputs[key] = outputVal;
          }
        }
        get().updateNodeData(event.nodeId, {
          state: 'complete',
          outputs,
          progress: undefined,
        });
        break;
      }

      case 'error':
        get().updateNodeData(event.nodeId, {
          state: 'error',
          error: event.error,
          progress: undefined,
        });
        break;

      case 'validationError':
        // Mark each node that has a validation error
        for (const err of event.errors) {
          if (err.nodeId) {
            get().updateNodeData(err.nodeId, {
              state: 'error',
              error: err.message,
            });
          }
        }
        set({ isExecuting: false });
        break;

      case 'graphComplete':
        console.log(
          `[execution] complete in ${event.duration}s, ${event.nodesExecuted} nodes executed`
        );
        set({ isExecuting: false });
        break;
    }
  },
}));
```

- [ ] **Step 4: Wire Toolbar Run button to executeGraph**

Replace the entire contents of `frontend/src/components/panels/Toolbar.tsx` with:

```typescript
import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  return (
    <div className="toolbar">
      <button
        className="toolbar__button"
        onClick={() => {
          executeGraph();
        }}
        disabled={isExecuting || nodeCount === 0}
        title="Run graph (Ctrl+Enter)"
      >
        {isExecuting ? '... Running' : '\u25B6 Run'}
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => fitView({ padding: 0.2, duration: 300 })}
        title="Fit to screen"
      >
        Fit
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => togglePanel('library')}
        title="Toggle node library"
      >
        Nodes
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => {
          alert('Settings not yet implemented \u2014 coming in Milestone 4');
        }}
        title="Settings"
      >
        \u2699
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Update ModelNode to render image preview**

Replace the entire contents of `frontend/src/components/nodes/ModelNode.tsx` with:

```typescript
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import '../../styles/nodes.css';

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const selectNode = useUIStore((s) => s.selectNode);

  if (!definition) {
    return <div className="model-node model-node--error">Unknown node type</div>;
  }

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;

  // Check if we have an image output to preview
  const imageOutput = Object.values(nodeData.outputs).find(
    (o) => o.type === 'Image' && o.value
  );

  return (
    <div
      className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`}
      onClick={() => selectNode(id)}
    >
      <div className="model-node__header">
        <span
          className="model-node__category-dot"
          style={{ backgroundColor: categoryColor }}
        />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && (
          <span className="model-node__badge model-node__badge--warning" title="API Key Missing">
            ⚠
          </span>
        )}
      </div>

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType] }}
              />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {nodeData.state === 'executing' && nodeData.progress !== undefined && (
        <div className="model-node__progress">
          <div
            className="model-node__progress-bar"
            style={{ width: `${Math.round(nodeData.progress * 100)}%` }}
          />
        </div>
      )}

      {nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string' && (
        <div className="model-node__preview">
          <img
            src={imageOutput.value}
            alt="Generated output"
            className="model-node__preview-image"
            loading="lazy"
          />
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && Object.keys(nodeData.outputs).length > 0 && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Output ready</div>
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {definition.outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {definition.outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType] }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
```

- [ ] **Step 6: Add CSS for image preview and progress bar**

Add to the end of `frontend/src/styles/nodes.css`:

```css

.model-node__preview-image {
  width: 100%;
  border-radius: 4px;
  display: block;
}

.model-node__progress {
  padding: 4px 10px;
  border-top: 1px solid #2a2a2a;
}

.model-node__progress-bar {
  height: 2px;
  background: #2196F3;
  border-radius: 1px;
  transition: width 0.3s ease;
}
```

- [ ] **Step 7: Verify frontend compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc -b --noEmit 2>&1
# Expected: no errors
```

- [ ] **Step 8: Commit**

```
feat(frontend): wire execution flow — API client, WebSocket events, Run button, image preview
```

---

## Task 11: Integration Test

**Files:** None (manual verification steps)

### Estimated time: 5 minutes

- [ ] **Step 1: Create a settings.json with your OpenAI key**

Create `settings.json` at the project root (this file is gitignored):

```bash
cat > /Users/justinperea/Documents/Projects/nebula_nodes/settings.json << 'HEREDOC'
{
  "apiKeys": {
    "OPENAI_API_KEY": "YOUR_REAL_KEY_HERE"
  },
  "routing": {},
  "outputPath": null,
  "executionMode": "manual",
  "batchSizeCap": 25
}
HEREDOC
```

Replace `YOUR_REAL_KEY_HERE` with a real OpenAI API key.

- [ ] **Step 2: Start the backend**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
uvicorn main:app --port 8000 --reload
```

Leave this running in a terminal tab.

- [ ] **Step 3: Start the frontend**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run dev
```

Leave this running in another terminal tab. Open `http://localhost:5173` in a browser.

- [ ] **Step 4: Manual test — add nodes and execute**

1. Open the Node Library panel (click "Nodes" in toolbar)
2. Drag a "Text Input" node onto the canvas
3. Select the Text Input node and enter a prompt in the inspector (e.g., "a cat wearing a top hat, oil painting style")
4. Drag a "GPT Image 1" node onto the canvas
5. Connect the Text Input "Text" output port to GPT Image 1 "Prompt" input port
6. Click the "Run" button in the toolbar
7. Observe:
   - Both nodes should show "queued" state (grey left border)
   - Text Input should quickly transition through "executing" to "complete" (green left border)
   - GPT Image 1 should show "executing" (blue shimmer left border)
   - After ~10-30 seconds, GPT Image 1 should show "complete" with an image preview thumbnail
8. Check the `output/` directory for the saved PNG file

- [ ] **Step 5: Manual test — validation errors**

1. Add a standalone GPT Image 1 node (no connections)
2. Click "Run"
3. Observe: the GPT Image 1 node should show error state (red left border) with "required input port" error message

- [ ] **Step 6: Manual test — missing API key**

1. Edit `settings.json` and remove the `OPENAI_API_KEY` value (set to `""`)
2. Add Text Input + GPT Image 1 nodes, connect them
3. Click "Run"
4. Observe: GPT Image 1 should show error state with "Missing API key" message

- [ ] **Step 7: Run all backend tests one final time**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/ -v
# Expected: 12 passed
```

- [ ] **Step 8: Verify frontend type-checks**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc -b --noEmit
# Expected: no errors
```

- [ ] **Step 9: Commit integration milestone**

```
milestone(m2): first execution — text input to GPT Image 1 with live WebSocket state
```

---

## Summary

| Task | Files | Tests | Estimated Time |
|------|-------|-------|---------------|
| 1. Backend scaffolding | 2 new | 1 manual curl | 3 min |
| 2. Pydantic models | 3 new | 1 import check | 4 min |
| 3. Settings service | 2 new | 1 manual script | 3 min |
| 4. Output service | 1 new | 1 manual script | 3 min |
| 5. Execution engine | 3 new | 9 pytest tests | 5 min |
| 6. OpenAI handler | 3 new | 3 pytest tests | 5 min |
| 7. Sync runner | 1 new | 1 import check | 2 min |
| 8. WebSocket + REST | 1 modified | 12 tests (full suite) | 5 min |
| 9. Frontend WS client | 1 new | tsc check | 3 min |
| 10. Frontend wiring | 5 modified/new | tsc check | 5 min |
| 11. Integration test | 0 | manual E2E | 5 min |
| **Total** | **22 files** | **12 automated + 6 manual** | **~43 min** |
