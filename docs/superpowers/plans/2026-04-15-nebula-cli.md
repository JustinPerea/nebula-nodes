# Nebula CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python CLI that discovers nodes, builds graphs, and executes media generation pipelines by talking to the FastAPI backend on localhost:8000.

**Architecture:** The CLI (`backend/cli/`) is a pure HTTP client — it imports nothing from the backend. All state lives server-side. Node definitions are exported from the frontend TypeScript to a JSON file the backend reads. The backend gets new endpoints for node discovery (`/api/nodes`), graph management (`/api/graph/*`), and one-shot execution (`/api/quick`). Graph execution is synchronous from the CLI's perspective — the HTTP request blocks until the pipeline completes and returns results.

**Tech Stack:** Python 3.12, httpx (already in requirements.txt), argparse, FastAPI/Pydantic (backend)

**Spec:** `docs/superpowers/specs/2026-04-15-nebula-cli-design.md`

---

## File Map

### New Files

| File | Purpose |
|------|---------|
| `scripts/export-node-defs.ts` | One-time script: imports frontend TS definitions, writes JSON |
| `backend/data/node_definitions.json` | Generated file — 93 node definitions as JSON (gitignored, regenerated) |
| `backend/services/node_registry.py` | Loads JSON, provides query functions for node discovery |
| `backend/services/cli_graph.py` | In-memory server-side graph state with short IDs (n1, n2...) |
| `backend/cli/__init__.py` | Package marker |
| `backend/cli/__main__.py` | Entry point — argparse, command dispatch |
| `backend/cli/client.py` | httpx wrapper for backend API calls |
| `backend/cli/formatter.py` | Plain-text formatting helpers |
| `backend/cli/commands/__init__.py` | Package marker |
| `backend/cli/commands/context.py` | `nebula context` command |
| `backend/cli/commands/nodes.py` | `nebula nodes` and `nebula info` commands |
| `backend/cli/commands/keys.py` | `nebula keys` command |
| `backend/cli/commands/graph.py` | `nebula create/connect/set/graph/save/load/clear` commands |
| `backend/cli/commands/execute.py` | `nebula run/run-all/status` commands |
| `backend/cli/commands/quick.py` | `nebula quick` command |
| `backend/tests/test_node_registry.py` | Tests for node registry |
| `backend/tests/test_cli_graph.py` | Tests for server-side graph state |
| `backend/tests/test_cli_api.py` | Tests for new API endpoints |

### Modified Files

| File | Change |
|------|--------|
| `backend/main.py` | Add `/api/nodes`, `/api/graph/*`, `/api/quick` endpoints |

---

## Task 1: Export Node Definitions to JSON

**Files:**
- Create: `scripts/export-node-defs.ts`
- Create: `backend/data/node_definitions.json` (generated)

This is a one-time data extraction. The frontend's `nodeDefinitions.ts` is the source of truth for all 93 nodes. We export it to JSON so the Python backend can serve it.

- [ ] **Step 1: Create the export script**

```typescript
// scripts/export-node-defs.ts
import { NODE_DEFINITIONS } from '../frontend/src/constants/nodeDefinitions';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = `${__dirname}/../backend/data/node_definitions.json`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(NODE_DEFINITIONS, null, 2));

console.log(`Exported ${Object.keys(NODE_DEFINITIONS).length} node definitions to backend/data/node_definitions.json`);
```

- [ ] **Step 2: Create a tsconfig for the script**

The script needs to resolve the frontend's TypeScript imports. Create a minimal tsconfig:

```json
// scripts/tsconfig.json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "esModuleInterop": true,
    "strict": true,
    "paths": {}
  },
  "include": ["*.ts", "../frontend/src/**/*.ts"]
}
```

- [ ] **Step 3: Run the export**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes && npx tsx scripts/export-node-defs.ts`

Expected: `Exported 93 node definitions to backend/data/node_definitions.json`

Verify the file exists and starts with a valid JSON object.

- [ ] **Step 4: Verify the JSON structure**

Run: `python3 -c "import json; d=json.load(open('backend/data/node_definitions.json')); print(f'{len(d)} nodes'); print(list(d.keys())[:5])"`

Expected: `93 nodes` and a list of node IDs like `['gpt-image-1-generate', ...]`

- [ ] **Step 5: Commit**

```bash
git add scripts/export-node-defs.ts scripts/tsconfig.json backend/data/node_definitions.json
git commit -m "feat(cli): export node definitions from TypeScript to JSON"
```

---

## Task 2: Node Registry Service

**Files:**
- Create: `backend/services/node_registry.py`
- Create: `backend/tests/test_node_registry.py`

The node registry loads the JSON and provides query functions for discovery commands.

- [ ] **Step 1: Write the tests**

```python
# backend/tests/test_node_registry.py
import pytest
from services.node_registry import NodeRegistry


@pytest.fixture
def registry():
    return NodeRegistry()


def test_loads_all_definitions(registry):
    nodes = registry.get_all()
    assert len(nodes) > 0
    # Each node has required fields
    first = next(iter(nodes.values()))
    assert "id" in first
    assert "displayName" in first
    assert "category" in first
    assert "envKeyName" in first


def test_get_by_id(registry):
    node = registry.get("gpt-image-1-generate")
    assert node is not None
    assert node["displayName"] == "GPT Image 1"
    assert node["category"] == "image-gen"


def test_get_unknown_returns_none(registry):
    assert registry.get("nonexistent-node") is None


def test_get_by_category(registry):
    image_nodes = registry.get_by_category("image-gen")
    assert len(image_nodes) > 0
    assert all(n["category"] == "image-gen" for n in image_nodes)


def test_get_categories(registry):
    cats = registry.get_categories()
    assert "image-gen" in cats
    assert "video-gen" in cats
    assert "text-gen" in cats


def test_get_nodes_for_key(registry):
    nodes = registry.get_nodes_for_key("OPENAI_API_KEY")
    assert len(nodes) > 0
    for n in nodes:
        key = n["envKeyName"]
        if isinstance(key, list):
            assert "OPENAI_API_KEY" in key
        else:
            assert key == "OPENAI_API_KEY"


def test_get_all_key_names(registry):
    keys = registry.get_all_key_names()
    assert "OPENAI_API_KEY" in keys
    assert "GOOGLE_API_KEY" in keys
    assert isinstance(keys, set)


def test_search_by_name(registry):
    results = registry.search("imagen")
    assert any("imagen" in n["id"] for n in results)


def test_search_case_insensitive(registry):
    results = registry.search("GPT")
    assert len(results) > 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_node_registry.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'services.node_registry'`

- [ ] **Step 3: Implement the node registry**

```python
# backend/services/node_registry.py
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "node_definitions.json"


class NodeRegistry:
    """Read-only registry of node definitions loaded from the exported JSON."""

    def __init__(self, path: Path | None = None) -> None:
        p = path or _DATA_PATH
        with open(p) as f:
            self._nodes: dict[str, dict[str, Any]] = json.load(f)

    def get_all(self) -> dict[str, dict[str, Any]]:
        return self._nodes

    def get(self, node_id: str) -> dict[str, Any] | None:
        return self._nodes.get(node_id)

    def get_by_category(self, category: str) -> list[dict[str, Any]]:
        return [n for n in self._nodes.values() if n.get("category") == category]

    def get_categories(self) -> list[str]:
        cats: dict[str, None] = {}
        for n in self._nodes.values():
            cats[n["category"]] = None
        return list(cats.keys())

    def get_nodes_for_key(self, key_name: str) -> list[dict[str, Any]]:
        result = []
        for n in self._nodes.values():
            env = n.get("envKeyName", "")
            if isinstance(env, list):
                if key_name in env:
                    result.append(n)
            elif env == key_name:
                result.append(n)
        return result

    def get_all_key_names(self) -> set[str]:
        keys: set[str] = set()
        for n in self._nodes.values():
            env = n.get("envKeyName", "")
            if isinstance(env, list):
                keys.update(env)
            elif env:
                keys.add(env)
        return keys

    def search(self, query: str) -> list[dict[str, Any]]:
        q = query.lower()
        return [
            n for n in self._nodes.values()
            if q in n["id"].lower() or q in n.get("displayName", "").lower()
        ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_node_registry.py -v`

Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/node_registry.py backend/tests/test_node_registry.py
git commit -m "feat(cli): add NodeRegistry service for node definition queries"
```

---

## Task 3: Server-Side Graph State

**Files:**
- Create: `backend/services/cli_graph.py`
- Create: `backend/tests/test_cli_graph.py`

In-memory graph state that the CLI builds incrementally via API calls. Uses short sequential IDs (n1, n2...) for easy reference.

- [ ] **Step 1: Write the tests**

```python
# backend/tests/test_cli_graph.py
import pytest
from services.cli_graph import CLIGraph


@pytest.fixture
def graph():
    return CLIGraph()


def test_add_node(graph):
    nid = graph.add_node("imagen-4-generate", {"model": "imagen-4.0-generate-001"})
    assert nid == "n1"
    assert graph.nodes["n1"]["definitionId"] == "imagen-4-generate"
    assert graph.nodes["n1"]["params"]["model"] == "imagen-4.0-generate-001"


def test_sequential_ids(graph):
    n1 = graph.add_node("node-a", {})
    n2 = graph.add_node("node-b", {})
    n3 = graph.add_node("node-c", {})
    assert (n1, n2, n3) == ("n1", "n2", "n3")


def test_connect(graph):
    graph.add_node("node-a", {})
    graph.add_node("node-b", {})
    graph.connect("n1", "image", "n2", "image")
    assert len(graph.edges) == 1
    edge = graph.edges[0]
    assert edge["source"] == "n1"
    assert edge["sourceHandle"] == "image"
    assert edge["target"] == "n2"
    assert edge["targetHandle"] == "image"


def test_connect_unknown_node_raises(graph):
    graph.add_node("node-a", {})
    with pytest.raises(ValueError, match="not found"):
        graph.connect("n1", "out", "n99", "in")


def test_update_params(graph):
    graph.add_node("node-a", {"x": 1})
    graph.update_params("n1", {"x": 2, "y": 3})
    assert graph.nodes["n1"]["params"] == {"x": 2, "y": 3}


def test_update_unknown_node_raises(graph):
    with pytest.raises(ValueError, match="not found"):
        graph.update_params("n99", {"x": 1})


def test_clear(graph):
    graph.add_node("node-a", {})
    graph.add_node("node-b", {})
    graph.connect("n1", "out", "n2", "in")
    graph.clear()
    assert len(graph.nodes) == 0
    assert len(graph.edges) == 0


def test_clear_resets_counter(graph):
    graph.add_node("node-a", {})
    graph.clear()
    nid = graph.add_node("node-b", {})
    assert nid == "n1"


def test_get_state(graph):
    graph.add_node("imagen-4-generate", {"model": "v1"})
    graph.add_node("seedvr2-upscale", {"factor": 2})
    graph.connect("n1", "image", "n2", "image")
    state = graph.get_state()
    assert len(state["nodes"]) == 2
    assert len(state["edges"]) == 1


def test_to_execute_format(graph):
    graph.add_node("imagen-4-generate", {"model": "v1"})
    nodes, edges = graph.to_execute_format()
    assert len(nodes) == 1
    assert nodes[0]["id"] == "n1"
    assert nodes[0]["definitionId"] == "imagen-4-generate"
    assert nodes[0]["params"] == {"model": "v1"}
    assert nodes[0]["outputs"] == {}


def test_save_and_load(graph, tmp_path):
    graph.add_node("node-a", {"x": 1})
    graph.add_node("node-b", {"y": 2})
    graph.connect("n1", "out", "n2", "in")

    filepath = tmp_path / "test_graph.json"
    graph.save(filepath)

    new_graph = CLIGraph()
    new_graph.load(filepath)
    assert len(new_graph.nodes) == 2
    assert len(new_graph.edges) == 1
    assert new_graph.nodes["n1"]["params"] == {"x": 1}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_cli_graph.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'services.cli_graph'`

- [ ] **Step 3: Implement CLIGraph**

```python
# backend/services/cli_graph.py
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class CLIGraph:
    """In-memory graph state for CLI operations.

    Nodes use short sequential IDs (n1, n2, ...) for easy terminal reference.
    """

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, str]] = []
        self._counter: int = 0

    def add_node(self, definition_id: str, params: dict[str, Any]) -> str:
        self._counter += 1
        short_id = f"n{self._counter}"
        self.nodes[short_id] = {
            "id": short_id,
            "definitionId": definition_id,
            "params": dict(params),
            "outputs": {},
        }
        return short_id

    def connect(self, src_id: str, src_port: str, dst_id: str, dst_port: str) -> dict[str, str]:
        if src_id not in self.nodes:
            raise ValueError(f"Source node '{src_id}' not found")
        if dst_id not in self.nodes:
            raise ValueError(f"Target node '{dst_id}' not found")

        edge = {
            "id": f"e{len(self.edges) + 1}",
            "source": src_id,
            "sourceHandle": src_port,
            "target": dst_id,
            "targetHandle": dst_port,
        }
        self.edges.append(edge)
        return edge

    def update_params(self, node_id: str, params: dict[str, Any]) -> None:
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.nodes[node_id]["params"].update(params)

    def clear(self) -> None:
        self.nodes.clear()
        self.edges.clear()
        self._counter = 0

    def get_state(self) -> dict[str, Any]:
        return {
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges),
        }

    def to_execute_format(self) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Convert to the format expected by execute_graph / ExecuteRequest."""
        nodes = [
            {
                "id": n["id"],
                "definitionId": n["definitionId"],
                "params": n["params"],
                "outputs": {},
            }
            for n in self.nodes.values()
        ]
        edges = [
            {
                "id": e["id"],
                "source": e["source"],
                "sourceHandle": e["sourceHandle"],
                "target": e["target"],
                "targetHandle": e["targetHandle"],
            }
            for e in self.edges
        ]
        return nodes, edges

    def save(self, path: Path) -> None:
        data = {
            "nodes": list(self.nodes.values()),
            "edges": list(self.edges),
            "counter": self._counter,
        }
        path.write_text(json.dumps(data, indent=2))

    def load(self, path: Path) -> None:
        data = json.loads(path.read_text())
        self.nodes = {n["id"]: n for n in data["nodes"]}
        self.edges = data["edges"]
        self._counter = data.get("counter", len(self.nodes))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_cli_graph.py -v`

Expected: All 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/cli_graph.py backend/tests/test_cli_graph.py
git commit -m "feat(cli): add CLIGraph for server-side graph state management"
```

---

## Task 4: Backend API Endpoints

**Files:**
- Modify: `backend/main.py` (add new route handlers)
- Create: `backend/tests/test_cli_api.py`

Add endpoints for node discovery, graph management, and one-shot execution. These are the HTTP surface the CLI talks to.

- [ ] **Step 1: Write the tests**

```python
# backend/tests/test_cli_api.py
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    # Import inside fixture so backend modules resolve from the right cwd
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from main import app
    return TestClient(app)


@pytest.fixture(autouse=True)
def clear_graph(client):
    """Reset graph state between tests."""
    client.delete("/api/graph")
    yield
    client.delete("/api/graph")


class TestNodeEndpoints:
    def test_get_all_nodes(self, client):
        resp = client.get("/api/nodes")
        assert resp.status_code == 200
        data = resp.json()
        assert "nodes" in data
        assert len(data["nodes"]) > 0
        first = data["nodes"][0]
        assert "id" in first
        assert "displayName" in first
        assert "category" in first

    def test_get_all_nodes_has_categories(self, client):
        resp = client.get("/api/nodes")
        data = resp.json()
        assert "categories" in data
        assert len(data["categories"]) > 0

    def test_get_single_node(self, client):
        resp = client.get("/api/nodes/gpt-image-1-generate")
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "gpt-image-1-generate"
        assert "inputPorts" in data
        assert "outputPorts" in data
        assert "params" in data

    def test_get_unknown_node_404(self, client):
        resp = client.get("/api/nodes/nonexistent")
        assert resp.status_code == 404


class TestGraphEndpoints:
    def test_create_node(self, client):
        resp = client.post("/api/graph/node", json={
            "definitionId": "gpt-image-1-generate",
            "params": {"model": "gpt-image-1"},
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "n1"
        assert data["definitionId"] == "gpt-image-1-generate"

    def test_create_multiple_nodes(self, client):
        r1 = client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        r2 = client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        assert r1.json()["id"] == "n1"
        assert r2.json()["id"] == "n2"

    def test_connect_nodes(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1",
            "sourceHandle": "image",
            "target": "n2",
            "targetHandle": "image",
        })
        assert resp.status_code == 200
        assert "n1:image" in resp.json()["connection"]

    def test_connect_unknown_node_400(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        resp = client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "out",
            "target": "n99", "targetHandle": "in",
        })
        assert resp.status_code == 400

    def test_update_node_params(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {"x": 1}})
        resp = client.put("/api/graph/node/n1", json={"params": {"x": 2, "y": 3}})
        assert resp.status_code == 200
        # Verify via graph endpoint
        graph = client.get("/api/graph").json()
        n1 = next(n for n in graph["nodes"] if n["id"] == "n1")
        assert n1["params"]["x"] == 2
        assert n1["params"]["y"] == 3

    def test_update_unknown_node_404(self, client):
        resp = client.put("/api/graph/node/n99", json={"params": {"x": 1}})
        assert resp.status_code == 404

    def test_get_graph(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        client.post("/api/graph/node", json={"definitionId": "node-b", "params": {}})
        client.post("/api/graph/connect", json={
            "source": "n1", "sourceHandle": "out",
            "target": "n2", "targetHandle": "in",
        })
        resp = client.get("/api/graph")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nodes"]) == 2
        assert len(data["edges"]) == 1

    def test_clear_graph(self, client):
        client.post("/api/graph/node", json={"definitionId": "node-a", "params": {}})
        resp = client.delete("/api/graph")
        assert resp.status_code == 200
        graph = client.get("/api/graph").json()
        assert len(graph["nodes"]) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_cli_api.py -v`

Expected: FAIL — 404 on `/api/nodes` (endpoint doesn't exist yet)

- [ ] **Step 3: Implement the API endpoints**

Add the following to `backend/main.py`, after the existing imports and before the static mount:

```python
# --- Near the top of main.py, after existing imports ---
from services.node_registry import NodeRegistry
from services.cli_graph import CLIGraph

node_registry = NodeRegistry()
cli_graph = CLIGraph()

# --- After existing REST endpoints, before the static mount ---

# ---------- CLI: Node discovery ----------

@app.get("/api/nodes")
async def list_nodes() -> dict:
    """Return all node definitions grouped by category."""
    all_nodes = node_registry.get_all()
    nodes_list = list(all_nodes.values())
    categories = node_registry.get_categories()
    return {"nodes": nodes_list, "categories": categories}


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str) -> dict:
    """Return full details for a single node definition."""
    node = node_registry.get(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return node


# ---------- CLI: Graph management ----------

@app.post("/api/graph/node")
async def create_graph_node(body: dict[str, Any]) -> dict:
    """Add a node to the server-side CLI graph."""
    definition_id = body.get("definitionId", "")
    params = body.get("params", {})
    short_id = cli_graph.add_node(definition_id, params)
    return cli_graph.nodes[short_id]


@app.post("/api/graph/connect")
async def connect_graph_nodes(body: dict[str, Any]) -> dict:
    """Connect two ports in the CLI graph."""
    try:
        edge = cli_graph.connect(
            body["source"], body["sourceHandle"],
            body["target"], body["targetHandle"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"connection": f"{edge['source']}:{edge['sourceHandle']} -> {edge['target']}:{edge['targetHandle']}"}


@app.get("/api/graph")
async def get_graph() -> dict:
    """Return the current CLI graph state."""
    return cli_graph.get_state()


@app.put("/api/graph/node/{node_id}")
async def update_graph_node(node_id: str, body: dict[str, Any]) -> dict:
    """Update params on a node in the CLI graph."""
    try:
        cli_graph.update_params(node_id, body.get("params", {}))
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return cli_graph.nodes[node_id]


@app.delete("/api/graph")
async def clear_graph() -> dict:
    """Clear the server-side CLI graph."""
    cli_graph.clear()
    return {"status": "cleared"}


# ---------- CLI: Synchronous execution ----------

@app.post("/api/graph/run")
async def run_graph(body: dict[str, Any] | None = None) -> dict:
    """Execute the CLI graph synchronously. Optionally specify targetNodeId to run a subgraph."""
    if not cli_graph.nodes:
        raise HTTPException(status_code=400, detail="Graph is empty")

    settings = load_settings()
    api_keys = settings.get("apiKeys", {})
    nodes, edges = cli_graph.to_execute_format()

    target = body.get("targetNodeId") if body else None
    if target:
        from execution.engine import get_subgraph
        nodes, edges = get_subgraph(
            [GraphNode(**n) for n in nodes],
            [GraphEdge(**e) for e in edges],
            target,
        )
        if not nodes:
            raise HTTPException(status_code=404, detail=f"Node '{target}' not found in graph")
    else:
        nodes = [GraphNode(**n) for n in nodes]
        edges = [GraphEdge(**e) for e in edges]

    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    timings: dict[str, float] = {}

    import time

    async def collect_events(event: ExecutionEvent) -> None:
        if isinstance(event, ExecutedEvent):
            results[event.node_id] = event.outputs
        elif isinstance(event, ErrorEvent):
            errors[event.node_id] = event.error

    handler_registry = get_handler_registry(emit=collect_events)

    start = time.time()
    await execute_graph(
        nodes=nodes,
        edges=edges,
        api_keys=api_keys,
        handler_registry=handler_registry,
        emit=collect_events,
        cache=execution_cache,
    )
    duration = time.time() - start

    # Update CLI graph node outputs with results
    for node_id, outputs in results.items():
        if node_id in cli_graph.nodes:
            cli_graph.nodes[node_id]["outputs"] = (
                {k: v if isinstance(v, dict) else {"type": "Any", "value": v} for k, v in outputs.items()}
                if isinstance(outputs, dict) else {}
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

    # Build a single-node graph with input nodes for each provided input
    temp_nodes = []
    temp_edges = []
    node_counter = 0

    # Create input nodes for each provided input
    for port_id, value in inputs.items():
        node_counter += 1
        input_node_id = f"_quick_input_{node_counter}"
        # Determine input type from value
        if isinstance(value, str) and (value.endswith(('.png', '.jpg', '.jpeg', '.webp'))):
            input_type = "image-input"
            port_type = "Image"
        elif isinstance(value, str) and (value.endswith(('.mp4', '.mov', '.webm'))):
            input_type = "video-input"
            port_type = "Video"
        elif isinstance(value, str) and (value.endswith(('.mp3', '.wav', '.m4a'))):
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
            source_handle="value" if input_type == "text-input" else port_type.lower(),
            target="_quick_main",
            target_handle=port_id,
        ))

    # Create the main node
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
    return {
        "outputs": main_outputs,
        "duration": round(duration, 2),
    }
```

Note: You must also import `ExecutedEvent` and `ErrorEvent` at the top of main.py. The existing import line `from models.events import ExecutionEvent` should become:

```python
from models.events import ExecutionEvent, ExecutedEvent, ErrorEvent
```

And add `GraphNode, GraphEdge` to the existing import from `models`:

```python
from models import ExecuteRequest, ExecuteNodeRequest, ValidationErrorEvent, GraphNode, GraphEdge
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/test_cli_api.py -v`

Expected: All 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_cli_api.py
git commit -m "feat(cli): add /api/nodes, /api/graph/*, /api/quick backend endpoints"
```

---

## Task 5: CLI HTTP Client

**Files:**
- Create: `backend/cli/__init__.py`
- Create: `backend/cli/client.py`
- Create: `backend/cli/commands/__init__.py`

The HTTP client wraps all backend API calls. Every CLI command uses this to talk to the server.

- [ ] **Step 1: Create package markers**

```python
# backend/cli/__init__.py
# Nebula CLI package
```

```python
# backend/cli/commands/__init__.py
# CLI command modules
```

- [ ] **Step 2: Implement the client**

```python
# backend/cli/client.py
from __future__ import annotations

import sys
from typing import Any

import httpx


DEFAULT_BASE = "http://localhost:8000"


class NebulaClient:
    """HTTP client for the Nebula backend API."""

    def __init__(self, base_url: str = DEFAULT_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=300.0)

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            resp = self._client.request(method, path, **kwargs)
        except httpx.ConnectError:
            print("error: cannot connect to Nebula backend at "
                  f"{self.base_url} — is the server running?", file=sys.stderr)
            sys.exit(1)
        if resp.status_code >= 400:
            detail = ""
            try:
                detail = resp.json().get("detail", resp.text)
            except Exception:
                detail = resp.text
            print(f"error: {detail}", file=sys.stderr)
            sys.exit(1)
        return resp.json()

    # -- Discovery --

    def get_nodes(self) -> dict[str, Any]:
        return self._request("GET", "/api/nodes")

    def get_node(self, node_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/nodes/{node_id}")

    def get_settings(self) -> dict[str, Any]:
        return self._request("GET", "/api/settings")

    # -- Graph --

    def create_node(self, definition_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/graph/node", json={
            "definitionId": definition_id,
            "params": params,
        })

    def connect(self, src: str, src_port: str, dst: str, dst_port: str) -> dict[str, Any]:
        return self._request("POST", "/api/graph/connect", json={
            "source": src,
            "sourceHandle": src_port,
            "target": dst,
            "targetHandle": dst_port,
        })

    def get_graph(self) -> dict[str, Any]:
        return self._request("GET", "/api/graph")

    def update_node(self, node_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/api/graph/node/{node_id}", json={"params": params})

    def clear_graph(self) -> dict[str, Any]:
        return self._request("DELETE", "/api/graph")

    # -- Execution --

    def run_graph(self, target_node_id: str | None = None) -> dict[str, Any]:
        body = {"targetNodeId": target_node_id} if target_node_id else {}
        return self._request("POST", "/api/graph/run", json=body)

    def quick(self, definition_id: str, inputs: dict[str, str], params: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/quick", json={
            "definitionId": definition_id,
            "inputs": inputs,
            "params": params,
        })
```

- [ ] **Step 3: Commit**

```bash
git add backend/cli/__init__.py backend/cli/client.py backend/cli/commands/__init__.py
git commit -m "feat(cli): add NebulaClient HTTP wrapper"
```

---

## Task 6: CLI Formatter

**Files:**
- Create: `backend/cli/formatter.py`

Plain-text formatting helpers. No colors, no emoji — just clean text optimized for terminal and Claude context windows.

- [ ] **Step 1: Implement the formatter**

```python
# backend/cli/formatter.py
from __future__ import annotations

from typing import Any


def format_node_table(nodes: list[dict[str, Any]]) -> str:
    """Format nodes as an aligned table grouped by category."""
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        cat = n.get("category", "other")
        by_cat.setdefault(cat, []).append(n)

    # Category display names
    cat_names = {
        "image-gen": "IMAGE GENERATION",
        "video-gen": "VIDEO GENERATION",
        "text-gen": "TEXT / CHAT",
        "audio-gen": "AUDIO",
        "3d-gen": "3D GENERATION",
        "transform": "TRANSFORM",
        "analyzer": "ANALYZER",
        "utility": "UTILITY",
        "universal": "UNIVERSAL",
    }

    lines: list[str] = []
    for cat, cat_nodes in by_cat.items():
        display_cat = cat_names.get(cat, cat.upper())
        lines.append(f"{display_cat} ({len(cat_nodes)})")
        for n in sorted(cat_nodes, key=lambda x: x["id"]):
            nid = n["id"]
            name = n.get("displayName", nid)
            provider = n.get("apiProvider", "")
            lines.append(f"  {nid:<30} {name:<25} {provider}")
        lines.append("")

    return "\n".join(lines)


def format_node_detail(node: dict[str, Any]) -> str:
    """Format full detail for a single node (nebula info output)."""
    lines: list[str] = []
    name = node.get("displayName", node["id"])
    lines.append(f"{name} ({node['id']})")

    provider = node.get("apiProvider", "?")
    key = node.get("envKeyName", "?")
    if isinstance(key, list):
        key = " or ".join(key)
    pattern = node.get("executionPattern", "?")
    lines.append(f"Provider: {provider} | Key: {key} | Exec: {pattern}")
    lines.append("")

    # Inputs
    inputs = node.get("inputPorts", [])
    if inputs:
        lines.append("INPUTS:")
        for p in inputs:
            req = "required" if p.get("required") else "optional"
            lines.append(f"  {p['id']:<16}{p['dataType']:<10}{req}")
        lines.append("")

    # Outputs
    outputs = node.get("outputPorts", [])
    if outputs:
        lines.append("OUTPUTS:")
        for p in outputs:
            lines.append(f"  {p['id']:<16}{p['dataType']}")
        lines.append("")

    # Params
    params = node.get("params", [])
    if params:
        lines.append("PARAMS:")
        for p in params:
            default = p.get("default", "")
            ptype = p.get("type", "")
            detail = f"{p['key']:<20}{ptype:<10}{default}"
            # Add enum options
            opts = p.get("options", [])
            if opts:
                opt_labels = [o.get("label", o.get("value", "")) for o in opts]
                detail += f"  [{', '.join(opt_labels)}]"
            # Add range for numbers
            if p.get("min") is not None or p.get("max") is not None:
                lo = p.get("min", "")
                hi = p.get("max", "")
                detail += f"  min={lo} max={hi}"
            # Add visibleWhen condition
            vis = p.get("visibleWhen")
            if vis:
                conds = [f"{k}={v}" for k, vals in vis.items() for v in vals]
                detail += f"  (when {', '.join(conds[:3])})"
            lines.append(f"  {detail}")
        lines.append("")

    return "\n".join(lines)


def format_keys(settings: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    """Format API key status (nebula keys output)."""
    api_keys = settings.get("apiKeys", {})

    # Group nodes by key name
    key_to_nodes: dict[str, list[str]] = {}
    all_keys: set[str] = set()
    for n in nodes:
        env = n.get("envKeyName", "")
        keys_list = env if isinstance(env, list) else [env] if env else []
        for k in keys_list:
            all_keys.add(k)
            key_to_nodes.setdefault(k, []).append(n.get("displayName", n["id"]))

    configured: list[str] = []
    missing: list[str] = []

    for key_name in sorted(all_keys):
        node_names = key_to_nodes.get(key_name, [])
        count = len(node_names)
        preview = ", ".join(node_names[:3])
        if len(node_names) > 3:
            preview += ", ..."

        masked = api_keys.get(key_name, "")
        if masked:
            configured.append(f"  {key_name:<25}{masked:<10}{count} nodes ({preview})")
        else:
            missing.append(f"  {key_name:<25}{'':10}{count} nodes unavailable")

    lines: list[str] = []
    if configured:
        lines.append("CONFIGURED KEYS:")
        lines.extend(configured)
        lines.append("")
    if missing:
        lines.append("NOT CONFIGURED:")
        lines.extend(missing)
        lines.append("")

    return "\n".join(lines)


def format_graph(state: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format current graph state (nebula graph output)."""
    nodes = state.get("nodes", [])
    edges = state.get("edges", [])

    if not nodes:
        return "Graph is empty."

    lines: list[str] = []
    lines.append("NODES:")
    for n in nodes:
        nid = n["id"]
        defn = node_defs.get(n["definitionId"], {}) if node_defs else {}
        name = defn.get("displayName", n["definitionId"])
        params_str = "  ".join(f"{k}={v}" for k, v in n.get("params", {}).items())
        outputs = n.get("outputs", {})
        status = ""
        if outputs:
            first_out = next(iter(outputs.values()), {})
            val = first_out.get("value", "") if isinstance(first_out, dict) else ""
            if val:
                status = f" -> {val}"
        lines.append(f"  {nid:<6}{name:<25}{params_str}{status}")

    if edges:
        lines.append("")
        lines.append("CONNECTIONS:")
        for e in edges:
            lines.append(f"  {e['source']}:{e['sourceHandle']} -> {e['target']}:{e['targetHandle']}")

    lines.append("")
    return "\n".join(lines)


def format_context(settings: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
    """Format the compact context summary (~500 tokens for Claude)."""
    api_keys = settings.get("apiKeys", {})

    # Which keys are configured
    configured_keys = {k for k, v in api_keys.items() if v}

    # Filter nodes to those with valid keys
    available: list[dict[str, Any]] = []
    for n in nodes:
        env = n.get("envKeyName", "")
        keys_list = env if isinstance(env, list) else [env] if env else []
        if any(k in configured_keys for k in keys_list):
            available.append(n)

    # Group by category
    by_cat: dict[str, list[str]] = {}
    for n in available:
        cat = n.get("category", "other")
        by_cat.setdefault(cat, []).append(n.get("displayName", n["id"]))

    cat_names = {
        "image-gen": "Image", "video-gen": "Video", "text-gen": "Text/Chat",
        "audio-gen": "Audio", "3d-gen": "3D", "transform": "Transform",
        "analyzer": "Analyzer", "utility": "Utility", "universal": "Universal",
    }

    lines: list[str] = []
    lines.append(f"Nebula Nodes — {len(available)} nodes available ({len(nodes)} total)")
    lines.append("")
    lines.append(f"Configured keys: {', '.join(sorted(configured_keys)) or 'none'}")
    lines.append("")

    for cat, names in by_cat.items():
        display = cat_names.get(cat, cat)
        lines.append(f"{display}: {', '.join(sorted(names))}")

    lines.append("")
    lines.append("Port types: Text, Image, Video, Audio, Mesh, Array, SVG, Any")
    lines.append("Connections must match types (Any connects to anything).")

    return "\n".join(lines)


def format_run_results(results: dict[str, Any], node_defs: dict[str, dict[str, Any]] | None = None) -> str:
    """Format execution results."""
    outputs = results.get("results", {})
    errors = results.get("errors", {})
    duration = results.get("duration", 0)

    lines: list[str] = []
    for nid, node_outputs in outputs.items():
        name = nid
        if node_defs:
            # We don't have definitionId in results, just use the nid
            pass
        if isinstance(node_outputs, dict):
            for port_id, port_val in node_outputs.items():
                val = port_val.get("value", "") if isinstance(port_val, dict) else port_val
                lines.append(f"{nid}: {val}")
        else:
            lines.append(f"{nid}: done")

    for nid, err in errors.items():
        lines.append(f"{nid}: ERROR — {err}")

    lines.append(f"\nCompleted in {duration}s")
    return "\n".join(lines)
```

- [ ] **Step 2: Commit**

```bash
git add backend/cli/formatter.py
git commit -m "feat(cli): add text formatters for CLI output"
```

---

## Task 7: CLI Entry Point and Argument Parsing

**Files:**
- Create: `backend/cli/__main__.py`

The main entry point with argparse subcommands. Run with `python -m backend.cli` from the project root.

- [ ] **Step 1: Implement the entry point**

```python
# backend/cli/__main__.py
from __future__ import annotations

import argparse
import sys

from .client import NebulaClient


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nebula",
        description="Nebula Nodes CLI — build and run media generation pipelines",
    )
    parser.add_argument("--url", default="http://localhost:8000",
                        help="Backend URL (default: http://localhost:8000)")
    sub = parser.add_subparsers(dest="command")

    # -- Discovery --
    sub.add_parser("context", help="Compact summary of available nodes and keys")

    nodes_p = sub.add_parser("nodes", help="List node definitions")
    nodes_p.add_argument("--filter", dest="query", help="Filter nodes by name")
    nodes_p.add_argument("--category", help="Filter by category")

    info_p = sub.add_parser("info", help="Show full detail for a node")
    info_p.add_argument("node_id", help="Node definition ID")

    sub.add_parser("keys", help="Show configured API keys")

    # -- Graph --
    create_p = sub.add_parser("create", help="Create a node in the graph")
    create_p.add_argument("node_id", help="Node definition ID")
    create_p.add_argument("--param", nargs="*", default=[], metavar="key=value",
                          help="Set params (e.g. --param model=v1 size=1024x1024)")

    connect_p = sub.add_parser("connect", help="Connect two ports")
    connect_p.add_argument("src", help="Source (e.g. n1:image)")
    connect_p.add_argument("dst", help="Destination (e.g. n2:image)")

    set_p = sub.add_parser("set", help="Update params on a node")
    set_p.add_argument("node_ref", help="Node reference (e.g. n1)")
    set_p.add_argument("params", nargs="+", metavar="key=value",
                       help="Params to set (e.g. aspectRatio=16:9)")

    sub.add_parser("graph", help="Show current graph state")

    save_p = sub.add_parser("save", help="Save graph to file")
    save_p.add_argument("file", help="Output file path (JSON)")

    load_p = sub.add_parser("load", help="Load graph from file")
    load_p.add_argument("file", help="Input file path (JSON)")

    sub.add_parser("clear", help="Clear the current graph")

    # -- Execution --
    run_p = sub.add_parser("run", help="Execute a node and its dependencies")
    run_p.add_argument("node_ref", help="Node reference (e.g. n2)")

    sub.add_parser("run-all", help="Execute the entire graph")

    sub.add_parser("status", help="Show execution state of graph nodes")

    # -- Quick --
    quick_p = sub.add_parser("quick", help="One-shot: create, execute, output")
    quick_p.add_argument("node_id", help="Node definition ID")
    quick_p.add_argument("--input", nargs="*", default=[], metavar="key=value",
                         help="Input values (e.g. --input prompt='a cat')")
    quick_p.add_argument("--param", nargs="*", default=[], metavar="key=value",
                         help="Params (e.g. --param aspectRatio=16:9)")

    return parser


def parse_kv_list(items: list[str]) -> dict[str, str]:
    """Parse ['key=value', ...] into a dict."""
    result: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            print(f"error: invalid key=value pair: {item}", file=sys.stderr)
            sys.exit(1)
        key, _, value = item.partition("=")
        result[key] = value
    return result


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    client = NebulaClient(args.url)

    from .commands import context, nodes, keys, graph, execute, quick

    dispatch = {
        "context": lambda: context.run(client),
        "nodes": lambda: nodes.run_list(client, query=args.query, category=args.category),
        "info": lambda: nodes.run_info(client, args.node_id),
        "keys": lambda: keys.run(client),
        "create": lambda: graph.run_create(client, args.node_id, parse_kv_list(args.param)),
        "connect": lambda: graph.run_connect(client, args.src, args.dst),
        "set": lambda: graph.run_set(client, args.node_ref, parse_kv_list(args.params)),
        "graph": lambda: graph.run_show(client),
        "save": lambda: graph.run_save(client, args.file),
        "load": lambda: graph.run_load(client, args.file),
        "clear": lambda: graph.run_clear(client),
        "run": lambda: execute.run_node(client, args.node_ref),
        "run-all": lambda: execute.run_all(client),
        "status": lambda: execute.run_status(client),
        "quick": lambda: quick.run(client, args.node_id,
                                   parse_kv_list(args.input), parse_kv_list(args.param)),
    }

    handler = dispatch.get(args.command)
    if handler:
        handler()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify it parses args without errors**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes && python -m backend.cli --help`

Expected: Help text listing all subcommands.

- [ ] **Step 3: Commit**

```bash
git add backend/cli/__main__.py
git commit -m "feat(cli): add entry point with argparse command routing"
```

---

## Task 8: Discovery Commands (context, nodes, info, keys)

**Files:**
- Create: `backend/cli/commands/context.py`
- Create: `backend/cli/commands/nodes.py`
- Create: `backend/cli/commands/keys.py`

- [ ] **Step 1: Implement context command**

```python
# backend/cli/commands/context.py
from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_context


def run(client: NebulaClient) -> None:
    nodes_data = client.get_nodes()
    settings = client.get_settings()
    print(format_context(settings, nodes_data["nodes"]))
```

- [ ] **Step 2: Implement nodes and info commands**

```python
# backend/cli/commands/nodes.py
from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_node_table, format_node_detail


def run_list(client: NebulaClient, query: str | None = None, category: str | None = None) -> None:
    data = client.get_nodes()
    nodes = data["nodes"]

    if category:
        nodes = [n for n in nodes if n.get("category") == category]

    if query:
        q = query.lower()
        nodes = [
            n for n in nodes
            if q in n["id"].lower() or q in n.get("displayName", "").lower()
        ]

    if not nodes:
        print("No matching nodes found.")
        return

    print(format_node_table(nodes))


def run_info(client: NebulaClient, node_id: str) -> None:
    node = client.get_node(node_id)
    print(format_node_detail(node))
```

- [ ] **Step 3: Implement keys command**

```python
# backend/cli/commands/keys.py
from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_keys


def run(client: NebulaClient) -> None:
    settings = client.get_settings()
    nodes_data = client.get_nodes()
    print(format_keys(settings, nodes_data["nodes"]))
```

- [ ] **Step 4: Test discovery commands manually**

Start the backend first: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && uvicorn main:app --port 8000`

Then test in another terminal:

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes && python -m backend.cli context`

Expected: Compact summary of configured keys and available nodes.

Run: `python -m backend.cli nodes --filter imagen`

Expected: Filtered list showing Imagen nodes.

Run: `python -m backend.cli info gpt-image-1-generate`

Expected: Full detail with inputs, outputs, params.

Run: `python -m backend.cli keys`

Expected: List of configured and unconfigured keys.

- [ ] **Step 5: Commit**

```bash
git add backend/cli/commands/context.py backend/cli/commands/nodes.py backend/cli/commands/keys.py
git commit -m "feat(cli): add discovery commands — context, nodes, info, keys"
```

---

## Task 9: Graph Building Commands (create, connect, set, graph, save, load, clear)

**Files:**
- Create: `backend/cli/commands/graph.py`

- [ ] **Step 1: Implement all graph commands**

```python
# backend/cli/commands/graph.py
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ..client import NebulaClient
from ..formatter import format_graph


def run_create(client: NebulaClient, node_id: str, params: dict[str, Any]) -> None:
    result = client.create_node(node_id, params)
    short_id = result["id"]
    # Look up display name
    node_def = client.get_node(node_id)
    name = node_def.get("displayName", node_id) if node_def else node_id
    print(f"Created node {short_id} ({name})")


def run_connect(client: NebulaClient, src: str, dst: str) -> None:
    if ":" not in src:
        print(f"error: source must be node:port (e.g. n1:image), got '{src}'", file=sys.stderr)
        sys.exit(1)
    if ":" not in dst:
        print(f"error: destination must be node:port (e.g. n2:image), got '{dst}'", file=sys.stderr)
        sys.exit(1)

    src_node, src_port = src.split(":", 1)
    dst_node, dst_port = dst.split(":", 1)

    result = client.connect(src_node, src_port, dst_node, dst_port)
    print(f"Connected {result['connection']}")


def run_set(client: NebulaClient, node_ref: str, params: dict[str, Any]) -> None:
    client.update_node(node_ref, params)
    params_str = ", ".join(f"{k}={v}" for k, v in params.items())
    print(f"Updated {node_ref}: {params_str}")


def run_show(client: NebulaClient) -> None:
    state = client.get_graph()
    # Fetch node defs for display names
    nodes_data = client.get_nodes()
    node_defs = {n["id"]: n for n in nodes_data["nodes"]}
    print(format_graph(state, node_defs))


def run_save(client: NebulaClient, filepath: str) -> None:
    state = client.get_graph()
    path = Path(filepath)
    path.write_text(json.dumps(state, indent=2))
    node_count = len(state.get("nodes", []))
    edge_count = len(state.get("edges", []))
    print(f"Saved graph ({node_count} nodes, {edge_count} connections) to {filepath}")


def run_load(client: NebulaClient, filepath: str) -> None:
    path = Path(filepath)
    if not path.exists():
        print(f"error: file not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    data = json.loads(path.read_text())
    # Clear existing graph, then recreate
    client.clear_graph()

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    # Map old IDs to new IDs (in case IDs differ)
    id_map: dict[str, str] = {}
    for n in nodes:
        result = client.create_node(n["definitionId"], n.get("params", {}))
        id_map[n["id"]] = result["id"]

    for e in edges:
        src = id_map.get(e["source"], e["source"])
        dst = id_map.get(e["target"], e["target"])
        client.connect(src, e["sourceHandle"], dst, e["targetHandle"])

    print(f"Loaded graph ({len(nodes)} nodes, {len(edges)} connections) from {filepath}")


def run_clear(client: NebulaClient) -> None:
    client.clear_graph()
    print("Graph cleared.")
```

- [ ] **Step 2: Test graph commands manually**

With the backend running:

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes

# Create nodes
python -m backend.cli create gpt-image-1-generate --param model=gpt-image-1
# Expected: Created node n1 (GPT Image 1)

python -m backend.cli create gpt-image-1-generate --param model=gpt-image-1
# Expected: Created node n2 (GPT Image 1)

# Connect
python -m backend.cli connect n1:image n2:image
# Expected: Connected n1:image -> n2:image

# Set params
python -m backend.cli set n1 size=1024x1024
# Expected: Updated n1: size=1024x1024

# Show graph
python -m backend.cli graph
# Expected: NODES and CONNECTIONS listing

# Save
python -m backend.cli save /tmp/test-graph.json
# Expected: Saved graph (2 nodes, 1 connections) to /tmp/test-graph.json

# Clear
python -m backend.cli clear
# Expected: Graph cleared.

# Load
python -m backend.cli load /tmp/test-graph.json
# Expected: Loaded graph (2 nodes, 1 connections) from /tmp/test-graph.json

# Verify
python -m backend.cli graph
# Expected: Same graph as before
```

- [ ] **Step 3: Commit**

```bash
git add backend/cli/commands/graph.py
git commit -m "feat(cli): add graph building commands — create, connect, set, graph, save, load, clear"
```

---

## Task 10: Execution and Quick Commands (run, run-all, status, quick)

**Files:**
- Create: `backend/cli/commands/execute.py`
- Create: `backend/cli/commands/quick.py`

- [ ] **Step 1: Implement execution commands**

```python
# backend/cli/commands/execute.py
from __future__ import annotations

from ..client import NebulaClient
from ..formatter import format_run_results, format_graph


def run_node(client: NebulaClient, node_ref: str) -> None:
    result = client.run_graph(target_node_id=node_ref)
    print(format_run_results(result))


def run_all(client: NebulaClient) -> None:
    result = client.run_graph()
    print(format_run_results(result))


def run_status(client: NebulaClient) -> None:
    state = client.get_graph()
    nodes_data = client.get_nodes()
    node_defs = {n["id"]: n for n in nodes_data["nodes"]}
    print(format_graph(state, node_defs))
```

- [ ] **Step 2: Implement quick command**

```python
# backend/cli/commands/quick.py
from __future__ import annotations

import sys
from typing import Any

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str, inputs: dict[str, str], params: dict[str, Any]) -> None:
    result = client.quick(node_id, inputs, params)
    outputs = result.get("outputs", {})

    if not outputs:
        print("No outputs produced.", file=sys.stderr)
        sys.exit(1)

    # Print only the output value(s) — for piping
    for port_id, port_val in outputs.items():
        if isinstance(port_val, dict):
            val = port_val.get("value", "")
        else:
            val = port_val
        if val:
            print(val)
```

- [ ] **Step 3: Test quick mode manually** (requires a configured API key and running backend)

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes

# Quick image generation (only works if OPENAI_API_KEY is configured)
python -m backend.cli quick gpt-image-1-generate --input prompt="a cat in space" --param size=1024x1024
# Expected: output file path printed to stdout
```

- [ ] **Step 4: Commit**

```bash
git add backend/cli/commands/execute.py backend/cli/commands/quick.py
git commit -m "feat(cli): add execution commands — run, run-all, status, quick"
```

---

## Task 11: Convenience Alias and Final Verification

**Files:**
- Modify: None (manual verification)

- [ ] **Step 1: Verify the full CLI workflow end-to-end**

With the backend running, run through the complete workflow:

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes

# Discovery
python -m backend.cli context
python -m backend.cli nodes
python -m backend.cli info imagen-4-generate
python -m backend.cli keys

# Build a graph
python -m backend.cli clear
python -m backend.cli create gpt-image-1-generate --param model=gpt-image-1
python -m backend.cli graph

# Save and reload
python -m backend.cli save /tmp/nebula-test.json
python -m backend.cli clear
python -m backend.cli load /tmp/nebula-test.json
python -m backend.cli graph
```

Expected: All commands produce clean text output with no errors.

- [ ] **Step 2: Run all backend tests**

Run: `cd /Users/justinperea/Documents/Projects/nebula_nodes/backend && python -m pytest tests/ -v`

Expected: All tests pass (existing 80 + new tests for registry, graph, and API).

- [ ] **Step 3: Commit final state**

```bash
git add -A
git commit -m "feat(cli): complete Nebula CLI — discovery, graph building, execution, quick mode"
```

---

## Spec Coverage Verification

| Spec Requirement | Task |
|-----------------|------|
| `nebula context` | Task 8 |
| `nebula nodes [--filter] [--category]` | Task 8 |
| `nebula info <node-id>` | Task 8 |
| `nebula keys` | Task 8 |
| `nebula create <node-id> [--param ...]` | Task 9 |
| `nebula connect <src>:<port> <dst>:<port>` | Task 9 |
| `nebula set <node-ref> <key>=<value>` | Task 9 |
| `nebula graph` | Task 9 |
| `nebula save <file>` / `nebula load <file>` | Task 9 |
| `nebula clear` | Task 9 |
| `nebula run <node-ref>` | Task 10 |
| `nebula run-all` | Task 10 |
| `nebula status` | Task 10 |
| `nebula quick <node-id> [--input ...] [--param ...]` | Task 10 |
| `GET /api/nodes` | Task 4 |
| `POST /api/graph/node` | Task 4 |
| `POST /api/graph/connect` | Task 4 |
| `GET /api/graph` | Task 4 |
| `PUT /api/graph/node/:id` | Task 4 |
| `DELETE /api/graph` | Task 4 |
| `POST /api/quick` | Task 4 |
| Output to stdout, errors to stderr | Task 6 (client.py), all commands |
| No color codes or emoji | Task 6 (formatter.py) |
| Quick mode outputs only file path (pipeable) | Task 10 |
| Node definitions from frontend TypeScript | Task 1 |
| Server-side graph state with short IDs | Task 3 |
