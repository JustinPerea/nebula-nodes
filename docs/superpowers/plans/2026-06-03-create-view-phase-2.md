# Create View — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mature the Create view from "type a prompt → one result" into a real creation surface: results gallery/History with per-card actions, reference-image attach, quantity>1 variations, all output types rendered, and **backend-authored persistence** so authored clusters survive a reload.

**Architecture:** P1 authored node clusters client-side (uuid ids, never persisted). P2 flips `authorGenerationCluster` to **backend-first**: it POSTs the cluster to a new additive route `POST /api/graph/cluster`, which adds the nodes/edges to `cli_graph` (assigning `n`-ids, persisting to `~/.nebula/state.json`, normalizing `image-input` paths) and returns them in React Flow format. The client applies the returned nodes directly (no graphSync race) and tags them `_createOrigin`. Execution (`executeCluster`) and the WS output pipeline are unchanged. A small engine-side resolver lets `image-input` accept `/api/outputs/...` URLs so generated outputs can be reused as references.

**Tech Stack:** FastAPI + pytest (backend), React 19 + Zustand + Vitest (frontend), `@xyflow/react`. Slava Restraint CSS tokens.

**Spec:** `docs/superpowers/specs/2026-06-02-higgsfield-create-view-design.md` (§6.2 quantity, §6.3 gallery, §6.4 references, plus §4.3 persistence — this plan supersedes the P1 "client-only" caveat).

**Builds on (P1, now on main):** `frontend/src/components/create-studio/*`, `graphStore.authorGenerationCluster`/`executeCluster`, `lib/createModels.ts`, `lib/createParams.ts`, `uiStore.createSessionId`/`enterCreateView`/`exitCreateView`.

---

## Key contracts (verified, with file:line)

- **Upload:** `POST /api/uploads` (multipart field `file`, optional `create_node`) → `{ url: "/api/outputs/chat-uploads/<hash>.ext", filePath: "<absolute local path>", filename }` (`backend/main.py:513`). Inspector pattern: upload without `create_node`, use `data.filePath` as the param value (`Inspector.tsx:754`). **Use the absolute `filePath` for image-input refs.**
- **cli_graph:** `add_node(definition_id, params, position=None, outputs=None) -> "n{N}"` persists on every call via `_maybe_persist()` (`cli_graph.py:42`, `:28`). `connect(src,srcPort,dst,dstPort)` likewise (`:73`). Edges get ids `e{N}`.
- **Import (template for the new route):** `POST /api/graph/import` clears + re-adds, remapping ids, calling `_normalize_image_input_params` for image-input, then `await _broadcast_graph_sync()` (`backend/main.py:1577-1622`). The new route mirrors this but **additively** (no `clear()`).
- **Export converter:** `GET /api/graph/export` converts cli_graph → React Flow nodes/edges (`backend/main.py:1637+`). The new route reuses this converter on the new id subset to return RF-format nodes.
- **image-input execution:** engine passes `params.filePath` verbatim as the Image output (`engine.py:492-494`); FAL's `_to_fal_url` treats any non-`http(s)`/`data:` value as a local disk path (`handlers/fal_universal.py:17-35`) — so a `/api/outputs/...` URL **breaks** unless resolved to an absolute path first.
- **Output rendering (ModelNode):** media (`Image`/`Video`/`Mesh`/`Audio`/`SVG`) render only when `state === 'complete'`; `value` is always a URL string; `Text` uses `streamingText ?? textOutput.value`; SVG streams via `streamingSvg` (`ModelNode.tsx:143-148, 156-167, 446, 496, 520`).
- **Concurrency:** backend runs up to 4 nodes in parallel; `handleExecutionEvent` updates per `event.nodeId`; `isExecuting` blocks a 2nd run until `graphComplete` (`engine.py:402,700`; `graphStore.ts:2530,2603`). Quantity>1 works as-is.
- **Stores/library (P3 reference, not P2):** `moodboard_store.py`, `/api/moodboards`, `MoodboardLibrary.tsx`, `lib/api.ts` moodboard client.

---

## File Structure

**Backend — create:**
- (none new; route + helper added to existing files)

**Backend — modify:**
- `backend/main.py` — add `POST /api/graph/cluster`; reuse the export converter + `_normalize_image_input_params`.
- `backend/services/output.py` — add `resolve_output_ref(value) -> str` (maps `/api/outputs/<rel>` → absolute `OUTPUT_ROOT/<rel>`, passes through other values).
- `backend/execution/engine.py` — image-input branch resolves `/api/outputs/...` via `resolve_output_ref`.
- `backend/tests/test_graph_cluster.py` *(new)* — route tests.
- `backend/tests/test_output_ref.py` *(new)* — resolver tests.

**Frontend — create:**
- `frontend/src/lib/createUploads.ts` — `uploadReference(file) -> {filePath, url}`.
- `frontend/src/lib/createGallery.ts` — `GenerationRecord` type + `galleryItemsFromSession(records, nodes)` selector.
- `frontend/src/components/create-studio/ResultsGallery.tsx` — grid/list of generations, History/All-outputs tabs.
- `frontend/src/components/create-studio/ResultCard.tsx` — one result tile + hover actions.
- `frontend/src/components/create-studio/ReferenceTray.tsx` — attached reference chips above the composer.
- `frontend/src/styles/create-gallery.css` — gallery + card + tray styles (Slava-scoped).

**Frontend — modify:**
- `frontend/src/store/graphStore.ts` — rewrite `authorGenerationCluster` (async, backend-first); add `deleteGeneration(modelNodeIds)`; add `applyClusterNodes` helper.
- `frontend/src/store/uiStore.ts` — nothing required (session id already exists).
- `frontend/src/components/create-studio/CreateView.tsx` — session `generations` state, refs state, quantity state; render `ResultsGallery` + `ReferenceTray`; wire 4 card actions; persist-safe exit.
- `frontend/src/components/create-studio/CreateComposer.tsx` — add `(+)` attach button, quantity stepper pill.
- `frontend/src/components/create-studio/OutputRenderer.tsx` — align with ModelNode (complete-gate, streamingSvg).
- `frontend/src/types/index.ts` — `GenerationRecord` (if not in createGallery.ts).
- Tests: `frontend/tests/store/createCluster.test.ts` (update for async/backend-first + deleteGeneration), `frontend/tests/lib/createGallery.test.ts` *(new)*, `frontend/tests/lib/createUploads.test.ts` *(new)*.

> No `NODE_DEFINITIONS`/`node_definitions.json` changes → contract tests unaffected. Gates: backend `pytest`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run lint` (eslint + css-scope; the pre-existing CrabMark inline-style failure is tracked separately — run `npx eslint` + `npm run check:slava-css-scope` to verify new code).

---

## Phase A — Backend-authored persistence + image-input robustness

### Task A1: `resolve_output_ref` helper

**Files:**
- Modify: `backend/services/output.py`
- Test: `backend/tests/test_output_ref.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_output_ref.py`:

```python
from pathlib import Path
from backend.services.output import resolve_output_ref, OUTPUT_ROOT


def test_passes_through_absolute_paths():
    assert resolve_output_ref("/tmp/x.png") == "/tmp/x.png"

def test_passes_through_http_and_data_urls():
    assert resolve_output_ref("https://x/y.png") == "https://x/y.png"
    assert resolve_output_ref("data:image/png;base64,AAAA") == "data:image/png;base64,AAAA"

def test_resolves_api_outputs_url_to_absolute():
    got = resolve_output_ref("/api/outputs/run1/abc.png")
    assert got == str((OUTPUT_ROOT / "run1" / "abc.png").resolve())

def test_blocks_path_traversal():
    # ../ escapes must not resolve outside OUTPUT_ROOT
    got = resolve_output_ref("/api/outputs/../../etc/passwd")
    assert got == "/api/outputs/../../etc/passwd"  # refused → returned unchanged
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_output_ref.py -q`
Expected: FAIL (ImportError: cannot import name 'resolve_output_ref').

- [ ] **Step 3: Implement**

In `backend/services/output.py`, add:

```python
def resolve_output_ref(value: str) -> str:
    """Map a served '/api/outputs/<rel>' URL back to its absolute on-disk path.

    Local paths, http(s) URLs, and data: URIs pass through unchanged. Refuses
    (returns unchanged) any path that escapes OUTPUT_ROOT.
    """
    if not isinstance(value, str) or not value.startswith("/api/outputs/"):
        return value
    rel = value[len("/api/outputs/"):]
    candidate = (OUTPUT_ROOT / rel).resolve()
    try:
        candidate.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        return value  # traversal attempt — refuse
    return str(candidate)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_output_ref.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/services/output.py backend/tests/test_output_ref.py
git commit -m "feat(create): add resolve_output_ref for /api/outputs->absolute"
```

### Task A2: engine resolves image-input `/api/outputs/...` refs

**Files:**
- Modify: `backend/execution/engine.py` (the `image-input` branch, ~line 492)
- Test: `backend/tests/test_graph_cluster.py` (shared file; this case added here)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_graph_cluster.py` with this first test:

```python
import importlib
from backend.execution import engine


def test_image_input_resolves_api_outputs_url(tmp_path, monkeypatch):
    # An image-input whose filePath is a served /api/outputs URL must resolve to
    # the absolute on-disk path in the node's Image output.
    from backend.services import output as output_mod
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    importlib.reload(engine)  # pick up patched OUTPUT_ROOT if engine imported a ref
    f = tmp_path / "run1" / "img.png"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"\x89PNG\r\n\x1a\n")
    out = engine._image_input_output({"filePath": "/api/outputs/run1/img.png"})
    assert out["image"]["value"] == str(f.resolve())
    importlib.reload(engine)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_graph_cluster.py::test_image_input_resolves_api_outputs_url -q`
Expected: FAIL (`engine` has no attribute `_image_input_output`).

- [ ] **Step 3: Implement**

In `backend/execution/engine.py`, extract the image-input output construction into a helper and route the value through `resolve_output_ref`. Add near the top imports:

```python
from backend.services.output import resolve_output_ref
```

Add the helper (module level):

```python
def _image_input_output(params: dict) -> dict:
    file_path = resolve_output_ref(str(params.get("filePath", "")))
    return {"image": {"type": "Image", "value": file_path}}
```

Then replace the existing image-input branch body (around line 492-494) so it calls the helper:

```python
elif node.definition_id == "image-input":
    node_outputs = _image_input_output(node.params)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_graph_cluster.py::test_image_input_resolves_api_outputs_url -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/execution/engine.py backend/tests/test_graph_cluster.py
git commit -m "feat(create): resolve /api/outputs refs in image-input execution"
```

### Task A3: `POST /api/graph/cluster` route

**Files:**
- Modify: `backend/main.py` (add route near `/api/graph/import`, ~line 1623)
- Test: `backend/tests/test_graph_cluster.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_graph_cluster.py`:

```python
from fastapi.testclient import TestClient
from backend.main import app, cli_graph


def test_cluster_route_adds_nodes_additively_and_returns_idmap():
    cli_graph.clear()
    cli_graph.add_node("text-input", {"value": "preexisting"})  # n1 stays
    client = TestClient(app)
    body = {
        "nodes": [
            {"tempId": "t-text", "definitionId": "text-input", "params": {"value": "a cat"}},
            {"tempId": "t-model", "definitionId": "nano-banana", "params": {"aspect_ratio": "16:9"}},
        ],
        "edges": [
            {"source": "t-text", "sourceHandle": "text", "target": "t-model", "targetHandle": "prompt"},
        ],
    }
    resp = client.post("/api/graph/cluster", json=body)
    assert resp.status_code == 200
    data = resp.json()
    # preexisting node still present (additive, no clear)
    assert any(n["data"]["definitionId"] == "text-input" and n["data"]["params"].get("value") == "preexisting"
               for n in_iter_all_nodes()) if False else True
    assert set(data["idMap"].keys()) == {"t-text", "t-model"}
    new_ids = set(data["idMap"].values())
    assert len(new_ids) == 2 and "n1" not in new_ids  # n1 was preexisting
    # returned nodes are React Flow shape with data.definitionId
    returned_defs = {n["id"]: n["data"]["definitionId"] for n in data["nodes"]}
    assert returned_defs[data["idMap"]["t-model"]] == "nano-banana"
    # an edge connects the two new nodes
    assert any(e["source"] == data["idMap"]["t-text"] and e["target"] == data["idMap"]["t-model"]
               for e in data["edges"])
    # cli_graph still holds the preexisting node + the 2 new ones
    assert len(cli_graph.nodes) == 3


def test_cluster_route_normalizes_image_input(tmp_path, monkeypatch):
    cli_graph.clear()
    client = TestClient(app)
    body = {
        "nodes": [{"tempId": "t-img", "definitionId": "image-input",
                   "params": {"filePath": "/api/outputs/run1/x.png"}}],
        "edges": [],
    }
    resp = client.post("/api/graph/cluster", json=body)
    assert resp.status_code == 200
    new_id = resp.json()["idMap"]["t-img"]
    # _normalize_image_input_params ran (filePath rewritten away from the URL form)
    assert cli_graph.nodes[new_id]["params"]["filePath"] != "/api/outputs/run1/x.png"
```

(Delete the `in_iter_all_nodes` placeholder line — it is intentionally short-circuited to `True`; the meaningful additive assertion is `len(cli_graph.nodes) == 3` at the end.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_graph_cluster.py -q`
Expected: FAIL (404 — route not defined).

- [ ] **Step 3: Implement the route**

In `backend/main.py`, after the `import_graph` route (~line 1623), add:

```python
@app.post("/api/graph/cluster")
async def add_graph_cluster(body: dict[str, Any]) -> dict:
    """Additively add a node cluster (e.g. authored from the Create view) to the
    CLI graph and persist it. Mirrors /api/graph/import but does NOT clear the
    existing graph. Incoming nodes carry a client 'tempId'; this maps each to a
    fresh 'n{N}' id and returns the created nodes/edges in React Flow format so
    the client can apply them without waiting for the graphSync broadcast.

    Body: {nodes: [{tempId, definitionId, params, position?}], edges: [{source, sourceHandle, target, targetHandle}]}
    where edge source/target reference tempIds.
    """
    id_map: dict[str, str] = {}
    for n in body.get("nodes", []):
        definition_id = n.get("definitionId")
        if not definition_id:
            continue
        params = n.get("params", {}) or {}
        _validate_params(definition_id, params)
        params = _coerce_params(definition_id, params)
        if definition_id == "image-input":
            params = _normalize_image_input_params(params)
        new_id = cli_graph.add_node(definition_id, params, position=n.get("position"))
        temp_id = n.get("tempId")
        if temp_id:
            id_map[temp_id] = new_id
    created_edge_ids: list[str] = []
    for e in body.get("edges", []):
        src = id_map.get(e.get("source"))
        dst = id_map.get(e.get("target"))
        if not src or not dst:
            continue
        try:
            edge = cli_graph.connect(src, e.get("sourceHandle", ""), dst, e.get("targetHandle", ""))
            created_edge_ids.append(edge["id"])
        except ValueError:
            continue
    await _broadcast_graph_sync()
    publish_action(f"Created cluster ({len(id_map)} nodes)")

    # Return the new subset in React Flow shape (reuse the export converter).
    full = await export_graph_for_frontend()
    new_ids = set(id_map.values())
    rf_nodes = [n for n in full.get("nodes", []) if n["id"] in new_ids]
    rf_edges = [e for e in full.get("edges", []) if e["id"] in created_edge_ids]
    return {"idMap": id_map, "nodes": rf_nodes, "edges": rf_edges}
```

> `_validate_params`, `_coerce_params`, `_normalize_image_input_params`, `export_graph_for_frontend`, `_broadcast_graph_sync`, `publish_action`, and `cli_graph` are all already defined in `main.py`. Call `export_graph_for_frontend()` (the async route function) directly — it returns the dict, not a Response.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_graph_cluster.py -q`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_graph_cluster.py
git commit -m "feat(create): add additive POST /api/graph/cluster route"
```

### Task A4: rewrite `authorGenerationCluster` to backend-first (async)

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/create-studio/CreateView.tsx` (call site already `await`s)
- Test: `frontend/tests/store/createCluster.test.ts` (rewrite the authorGenerationCluster cases)

- [ ] **Step 1: Rewrite the failing tests**

Replace the `describe('authorGenerationCluster', ...)` block in `frontend/tests/store/createCluster.test.ts` with backend-first versions. Add this fetch mock for the cluster route at the top of the new block (the file already mocks `../../src/lib/api`; here we mock `apiFetch` via the global `fetchMock` used elsewhere — match the existing pattern in this file):

```typescript
import type { GenerationRequest } from '../../src/types';

function baseRequest(overrides: Partial<GenerationRequest>): GenerationRequest {
  return {
    definitionId: 'nano-banana', prompt: 'a calico cat', params: { aspect_ratio: '16:9' },
    refPaths: [], quantity: 1, sessionId: 's1', genId: 'g1', layoutOrigin: { x: 0, y: 0 },
    ...overrides,
  };
}

// The cluster route returns RF nodes for the new ids. Mock it to echo a deterministic mapping.
function mockClusterResponse(body: { nodes: { tempId: string; definitionId: string; params: Record<string, unknown> }[]; edges: { source: string; target: string; sourceHandle: string; targetHandle: string }[] }) {
  const idMap: Record<string, string> = {};
  const nodes = body.nodes.map((n, i) => {
    const id = `n${i + 1}`;
    idMap[n.tempId] = id;
    return { id, type: 'model-node', position: { x: i * 100, y: 0 },
      data: { label: n.definitionId, definitionId: n.definitionId, params: n.params, state: 'idle', outputs: {} } };
  });
  const edges = body.edges.map((e, i) => ({ id: `e${i + 1}`, source: idMap[e.source], target: idMap[e.target],
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, type: 'typed-edge', data: { dataType: 'Text' } }));
  return { idMap, nodes, edges };
}

describe('authorGenerationCluster (backend-first)', () => {
  beforeEach(() => {
    resetStore();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => ({
      ok: true, status: 200,
      json: async () => mockClusterResponse(JSON.parse(init!.body as string)),
    }));
  });

  it('POSTs text-input + model to /api/graph/cluster and applies returned nodes with _createOrigin', async () => {
    const { modelNodeIds, allNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({}));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/graph/cluster'), expect.anything());
    const { nodes, edges } = useGraphStore.getState();
    expect(allNodeIds).toHaveLength(2);
    expect(modelNodeIds).toHaveLength(1);
    const modelNode = nodes.find((n) => n.id === modelNodeIds[0]);
    expect(modelNode?.data.definitionId).toBe('nano-banana');
    expect(modelNode?.data.params.aspect_ratio).toBe('16:9');
    expect((modelNode?.data._createOrigin as { sessionId: string }).sessionId).toBe('s1');
    const textNode = nodes.find((n) => n.data.definitionId === 'text-input');
    expect(textNode?.data._createOrigin).toBeUndefined(); // only model nodes tagged
    expect(edges).toHaveLength(1);
  });

  it('omits text-input when prompt is empty', async () => {
    const { allNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({ prompt: '  ' }));
    expect(allNodeIds).toHaveLength(1);
    expect(useGraphStore.getState().nodes.some((n) => n.data.definitionId === 'text-input')).toBe(false);
  });

  it('adds an image-input per refPath and quantity>1 model nodes sharing one text-input', async () => {
    const { modelNodeIds } = await useGraphStore.getState().authorGenerationCluster(
      baseRequest({ refPaths: ['/abs/a.png'], quantity: 3 }),
    );
    const { nodes } = useGraphStore.getState();
    expect(modelNodeIds).toHaveLength(3);
    expect(nodes.filter((n) => n.data.definitionId === 'text-input')).toHaveLength(1);
    expect(nodes.filter((n) => n.data.definitionId === 'image-input')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: FAIL (current `authorGenerationCluster` is sync/client-side, returns synchronously, makes no fetch).

- [ ] **Step 3: Rewrite the action**

In `frontend/src/store/graphStore.ts`, change the `GraphState` signature:

```typescript
  authorGenerationCluster: (request: GenerationRequest) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
```

Replace the `authorGenerationCluster` implementation with a backend-first version that builds a tempId spec, POSTs it, and applies the returned RF nodes/edges. Keep `buildDefaultParams`/`defHasParam` helpers (already module-level):

```typescript
  authorGenerationCluster: async (request) => {
    const def = NODE_DEFINITIONS[request.definitionId];
    if (!def) return { modelNodeIds: [], allNodeIds: [] };

    const specNodes: { tempId: string; definitionId: string; params: Record<string, unknown>; position: { x: number; y: number } }[] = [];
    const specEdges: { source: string; sourceHandle: string; target: string; targetHandle: string }[] = [];
    const { x: baseX, y: baseY } = request.layoutOrigin;

    const textPort = def.inputPorts.find((p) => p.dataType === 'Text');
    let textTemp: string | null = null;
    if (textPort && request.prompt.trim()) {
      textTemp = uuidv4();
      specNodes.push({ tempId: textTemp, definitionId: 'text-input', params: { value: request.prompt }, position: { x: baseX, y: baseY } });
    }
    const imagePort = def.inputPorts.find((p) => p.dataType === 'Image');
    const imageTemps: string[] = [];
    if (imagePort) {
      request.refPaths.forEach((path, i) => {
        const t = uuidv4();
        imageTemps.push(t);
        specNodes.push({ tempId: t, definitionId: 'image-input', params: { filePath: path }, position: { x: baseX, y: baseY + 140 + i * 120 } });
      });
    }
    const count = Math.max(1, request.quantity);
    const hasSeed = defHasParam(def, 'seed');
    const modelTemps: string[] = [];
    for (let v = 0; v < count; v++) {
      const t = uuidv4();
      modelTemps.push(t);
      const params = { ...buildDefaultParams(def), ...request.params };
      if (count > 1 && hasSeed) {
        const baseSeed = typeof request.params.seed === 'number' ? request.params.seed : 0;
        params.seed = baseSeed + v;
      }
      specNodes.push({ tempId: t, definitionId: def.id, params, position: { x: baseX + 360, y: baseY + v * 220 } });
      if (textTemp) specEdges.push({ source: textTemp, sourceHandle: 'text', target: t, targetHandle: textPort!.id });
      imageTemps.forEach((it) => specEdges.push({ source: it, sourceHandle: 'image', target: t, targetHandle: imagePort!.id }));
    }

    let idMap: Record<string, string> = {};
    let rfNodes: Node<NodeData>[] = [];
    let rfEdges: Edge[] = [];
    try {
      const res = await apiFetch('/api/graph/cluster', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes: specNodes, edges: specEdges }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { idMap: Record<string, string>; nodes: Node<NodeData>[]; edges: Edge[] };
      idMap = data.idMap; rfNodes = data.nodes ?? []; rfEdges = data.edges ?? [];
    } catch (err) {
      console.error('[nebula] authorGenerationCluster persist failed:', err);
      return { modelNodeIds: [], allNodeIds: [] };
    }

    const origin: CreateOriginTag = { sessionId: request.sessionId, genId: request.genId, ts: Date.now(), prompt: request.prompt };
    const modelIds = new Set(modelTemps.map((t) => idMap[t]).filter(Boolean));
    const taggedNodes = rfNodes.map((n) =>
      modelIds.has(n.id) ? { ...n, data: { ...n.data, _createOrigin: origin } } : n,
    );

    pushUndo(set, get);
    set((state) => {
      const existing = new Set(state.nodes.map((n) => n.id));
      const existingEdges = new Set(state.edges.map((e) => e.id));
      return {
        nodes: [...state.nodes, ...taggedNodes.filter((n) => !existing.has(n.id))],
        edges: [...state.edges, ...rfEdges.filter((e) => !existingEdges.has(e.id))],
      };
    });

    const modelNodeIds = modelTemps.map((t) => idMap[t]).filter(Boolean);
    const allNodeIds = [...modelTemps, ...(textTemp ? [textTemp] : []), ...imageTemps].map((t) => idMap[t]).filter(Boolean);
    return { modelNodeIds, allNodeIds };
  },
```

> `apiFetch` is imported in graphStore (used by `addNode`). `Node`/`Edge` from `@xyflow/react`, `uuidv4`, `pushUndo`, `NODE_DEFINITIONS`, `CreateOriginTag`, `GenerationRequest` already in scope from P1. The `set((state) => ...)` dedupes by id so a later idempotent graphSync merge won't double-add.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts && npx tsc --noEmit`
Expected: PASS + clean tsc.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/store/createCluster.test.ts
git commit -m "feat(create): backend-author clusters via /api/graph/cluster (persist)"
```

### Task A5: verify persistence end-to-end (no code; checkpoint)

- [ ] Confirm the `executeCluster` test in `createCluster.test.ts` still passes unchanged (it operates on whatever nodes are in the store; backend-first authoring still leaves the cluster in the store). Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts` → PASS. If `CreateView.handleGenerate` referenced a sync return, ensure it `await`s `authorGenerationCluster` (it already did in P1). Commit only if a fix was needed:

```bash
git add frontend/src/components/create-studio/CreateView.tsx
git commit -m "fix(create): await backend-first authorGenerationCluster"
```

---

## Phase B — Reference-image attach

### Task B1: `uploadReference` client

**Files:**
- Create: `frontend/src/lib/createUploads.ts`
- Test: `frontend/tests/lib/createUploads.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/createUploads.test.ts`:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
  backendAssetUrlSync: (u: string) => u,
}));
import { uploadReference } from '../../src/lib/createUploads';

beforeEach(() => fetchMock.mockReset());

describe('uploadReference', () => {
  it('POSTs the file and returns absolute filePath + preview url', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ filePath: '/abs/x.png', url: '/api/outputs/chat-uploads/x.png', filename: 'x.png' }) });
    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
    const result = await uploadReference(file);
    expect(result).toEqual({ filePath: '/abs/x.png', previewUrl: '/api/outputs/chat-uploads/x.png' });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/uploads');
    expect((init as { method: string }).method).toBe('POST');
    expect((init as { body: FormData }).body).toBeInstanceOf(FormData);
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 415 });
    await expect(uploadReference(new File([], 'x.txt'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/createUploads.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `frontend/src/lib/createUploads.ts`:

```typescript
import { apiFetch, backendAssetUrlSync } from './backend';

export interface UploadedReference {
  filePath: string;   // absolute on-disk path — safe to feed image-input
  previewUrl: string; // served /api/outputs URL for display
}

export async function uploadReference(file: File): Promise<UploadedReference> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/uploads', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = (await res.json()) as { filePath: string; url: string };
  return { filePath: data.filePath, previewUrl: backendAssetUrlSync(data.url) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run tests/lib/createUploads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/createUploads.ts frontend/tests/lib/createUploads.test.ts
git commit -m "feat(create): add uploadReference client for reference images"
```

### Task B2: ReferenceTray + composer attach + drop

**Files:**
- Create: `frontend/src/components/create-studio/ReferenceTray.tsx`
- Modify: `frontend/src/components/create-studio/CreateComposer.tsx`
- Modify: `frontend/src/components/create-studio/CreateView.tsx`
- Modify: `frontend/src/styles/create-gallery.css` (created in Phase D; if doing B before D, create it here with just the tray rules)

- [ ] **Step 1: Implement `ReferenceTray`**

Create `frontend/src/components/create-studio/ReferenceTray.tsx`:

```tsx
import { X } from 'lucide-react';

export interface AttachedRef {
  filePath: string;
  previewUrl: string;
}

export function ReferenceTray({ refs, onRemove }: { refs: AttachedRef[]; onRemove: (filePath: string) => void }) {
  if (refs.length === 0) return null;
  return (
    <div className="reference-tray">
      {refs.map((r) => (
        <div key={r.filePath} className="reference-tray__chip">
          <img src={r.previewUrl} alt="reference" className="reference-tray__thumb" />
          <button type="button" className="reference-tray__remove" onClick={() => onRemove(r.filePath)} aria-label="Remove reference">
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add the `(+)` attach button to `CreateComposer`**

In `frontend/src/components/create-studio/CreateComposer.tsx`, add to the props type: `onAttach: (files: FileList) => void;` and render a `(+)` button + hidden file input as the first control in `create-composer__controls`. Add the import `import { Plus } from 'lucide-react';` and a ref:

```tsx
  const fileInputRef = useRef<HTMLInputElement>(null);
```

Insert at the start of the `.create-composer__controls` div (before the model button):

```tsx
        <button type="button" className="create-composer__attach" onClick={() => fileInputRef.current?.click()} title="Attach reference image" aria-label="Attach reference image">
          <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { if (e.target.files?.length) onAttach(e.target.files); e.target.value = ''; }} />
```

(Add `useRef` to the React import if not present.)

- [ ] **Step 3: Wire refs in `CreateView`**

In `frontend/src/components/create-studio/CreateView.tsx`:
- Add state: `const [refs, setRefs] = useState<AttachedRef[]>([]);` (import `AttachedRef` + `ReferenceTray`, and `uploadReference`).
- Add handler:

```tsx
  const handleAttach = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const up = await uploadReference(file);
        setRefs((prev) => prev.some((r) => r.filePath === up.filePath) ? prev : [...prev, up]);
      } catch (err) { console.error('reference upload failed', err); }
    }
  };
```

- Pass `refPaths: refs.map((r) => r.filePath)` into the `authorGenerationCluster` call in `handleGenerate` (replace the P1 `refPaths: []`).
- Render `<ReferenceTray refs={refs} onRemove={(fp) => setRefs((p) => p.filter((r) => r.filePath !== fp))} />` directly above the `<CreateComposer ... onAttach={handleAttach} />`.
- Add a drop handler on the stage container: `onDragOver={(e) => e.preventDefault()}` and `onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) handleAttach(e.dataTransfer.files); }}`.

- [ ] **Step 4: Type-check + build**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/create-studio/ReferenceTray.tsx frontend/src/components/create-studio/CreateComposer.tsx frontend/src/components/create-studio/CreateView.tsx frontend/src/styles/create-gallery.css
git commit -m "feat(create): reference-image attach (button + drop + tray)"
```

---

## Phase C — Quantity>1 variations

### Task C1: quantity stepper

**Files:**
- Modify: `frontend/src/components/create-studio/CreateComposer.tsx`
- Modify: `frontend/src/components/create-studio/CreateView.tsx`

- [ ] **Step 1: Add a quantity prop + stepper to the composer**

In `CreateComposer.tsx`, add props `quantity: number;` and `onQuantityChange: (n: number) => void;`. Render a stepper pill before the Generate button:

```tsx
        <div className="create-composer__qty" role="group" aria-label="Number of variations">
          <button type="button" onClick={() => onQuantityChange(Math.max(1, quantity - 1))} aria-label="Fewer" disabled={quantity <= 1}>−</button>
          <span>{quantity}</span>
          <button type="button" onClick={() => onQuantityChange(Math.min(4, quantity + 1))} aria-label="More" disabled={quantity >= 4}>+</button>
        </div>
```

- [ ] **Step 2: Wire in `CreateView`**

Add `const [quantity, setQuantity] = useState(1);`, pass `quantity={quantity} onQuantityChange={setQuantity}` to the composer, and use `quantity` (not the literal `1`) in the `authorGenerationCluster` call.

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/create-studio/CreateComposer.tsx frontend/src/components/create-studio/CreateView.tsx
git commit -m "feat(create): quantity stepper (1-4) for variations"
```

---

## Phase D — Results gallery / History

### Task D1: gallery selector + `GenerationRecord`

**Files:**
- Create: `frontend/src/lib/createGallery.ts`
- Test: `frontend/tests/lib/createGallery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/createGallery.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { galleryItemsFromSession, type GenerationRecord } from '../../src/lib/createGallery';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

function node(id: string, state: NodeData['state'], outputs: NodeData['outputs'] = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: id, definitionId: 'nano-banana', params: {}, state, outputs } };
}

describe('galleryItemsFromSession', () => {
  it('expands each generation into one item per model node, newest first, with live node data', () => {
    const records: GenerationRecord[] = [
      { genId: 'g1', prompt: 'cat', ts: 1, modelNodeIds: ['n2'] },
      { genId: 'g2', prompt: 'dog', ts: 2, modelNodeIds: ['n4', 'n5'] },
    ];
    const nodes = [node('n2', 'complete', { image: { type: 'Image', value: '/api/outputs/a.png' } }), node('n4', 'executing'), node('n5', 'complete')];
    const items = galleryItemsFromSession(records, nodes);
    // newest generation (g2) first; its two variations precede g1
    expect(items.map((i) => i.nodeId)).toEqual(['n4', 'n5', 'n2']);
    expect(items[2].prompt).toBe('cat');
    expect(items[2].node?.data.state).toBe('complete');
    expect(items[0].node?.data.state).toBe('executing');
  });

  it('drops model node ids that no longer exist (deleted)', () => {
    const records: GenerationRecord[] = [{ genId: 'g1', prompt: 'x', ts: 1, modelNodeIds: ['n2', 'gone'] }];
    const items = galleryItemsFromSession(records, [node('n2', 'complete')]);
    expect(items.map((i) => i.nodeId)).toEqual(['n2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/createGallery.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `frontend/src/lib/createGallery.ts`:

```typescript
import type { Node } from '@xyflow/react';
import type { NodeData } from '../types';

export interface GenerationRecord {
  genId: string;
  prompt: string;
  ts: number;
  modelNodeIds: string[];
}

export interface GalleryItem {
  genId: string;
  prompt: string;
  ts: number;
  nodeId: string;
  node: Node<NodeData> | undefined;
}

/** Flatten session generations (newest first) into one item per live model node. */
export function galleryItemsFromSession(records: GenerationRecord[], nodes: Node<NodeData>[]): GalleryItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const items: GalleryItem[] = [];
  for (const rec of [...records].sort((a, b) => b.ts - a.ts)) {
    for (const nodeId of rec.modelNodeIds) {
      if (!byId.has(nodeId)) continue;
      items.push({ genId: rec.genId, prompt: rec.prompt, ts: rec.ts, nodeId, node: byId.get(nodeId) });
    }
  }
  return items;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run tests/lib/createGallery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/createGallery.ts frontend/tests/lib/createGallery.test.ts
git commit -m "feat(create): gallery selector (session generations -> items)"
```

### Task D2: `deleteGeneration` store action

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/store/createCluster.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `createCluster.test.ts`:

```typescript
describe('deleteGeneration', () => {
  it('removes the given model nodes and their now-orphaned input nodes + touching edges', () => {
    resetStore();
    useGraphStore.setState({
      nodes: [
        node('t1', 'text-input'), node('m1', 'nano-banana'), node('m2', 'nano-banana'),
        node('keep', 'flux-schnell'),
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge' },
        { id: 'e2', source: 't1', sourceHandle: 'text', target: 'm2', targetHandle: 'prompt', type: 'typed-edge' },
      ],
    });
    // delete only m1 → t1 still feeds m2, so t1 stays
    useGraphStore.getState().deleteGeneration(['m1']);
    let ids = useGraphStore.getState().nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['keep', 'm2', 't1']);
    // delete m2 → t1 now orphaned → removed too
    useGraphStore.getState().deleteGeneration(['m2']);
    ids = useGraphStore.getState().nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['keep']);
    expect(useGraphStore.getState().edges).toHaveLength(0);
  });
});
```

(The `node()` helper already exists at the top of this test file from Task A4 / the P1 executeCluster tests; reuse it.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: FAIL (`deleteGeneration is not a function`).

- [ ] **Step 3: Implement**

Add to the `GraphState` interface: `deleteGeneration: (modelNodeIds: string[]) => void;` and implement (place after `authorGenerationCluster`):

```typescript
  deleteGeneration: (modelNodeIds) => {
    const { nodes, edges } = get();
    const toRemove = new Set(modelNodeIds);
    // Input nodes feeding ONLY removed model nodes become orphans → also remove.
    const inputIds = new Set(
      edges.filter((e) => toRemove.has(e.target)).map((e) => e.source),
    );
    for (const inputId of inputIds) {
      const stillUsed = edges.some((e) => e.source === inputId && !toRemove.has(e.target));
      const inputNode = nodes.find((n) => n.id === inputId);
      const isCreateInput = inputNode?.data.definitionId === 'text-input' || inputNode?.data.definitionId === 'image-input';
      if (!stillUsed && isCreateInput) toRemove.add(inputId);
    }
    pushUndo(set, get);
    set((state) => ({
      nodes: state.nodes.filter((n) => !toRemove.has(n.id)),
      edges: state.edges.filter((e) => !toRemove.has(e.source) && !toRemove.has(e.target)),
    }));
    // Best-effort backend removal so persistence reflects the deletion.
    for (const id of toRemove) {
      void apiFetch(`/api/graph/node/${id}`, { method: 'DELETE' }).catch(() => {});
    }
  },
```

> Verify the backend delete route path: search `backend/main.py` for the node-delete route (likely `DELETE /api/graph/node/{id}`). If the path differs, match it. The client removal is authoritative for the canvas; the backend call keeps `state.json` in sync.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/store/createCluster.test.ts
git commit -m "feat(create): deleteGeneration removes cluster + orphaned inputs"
```

### Task D3: `ResultCard` + `ResultsGallery` components

**Files:**
- Create: `frontend/src/components/create-studio/ResultCard.tsx`
- Create: `frontend/src/components/create-studio/ResultsGallery.tsx`
- Modify: `frontend/src/styles/create-gallery.css`

- [ ] **Step 1: Implement `ResultCard`**

Create `frontend/src/components/create-studio/ResultCard.tsx`:

```tsx
import { Download, SquareArrowOutUpRight, ImagePlus, Trash2 } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { NodeData, PortValue } from '../../types';
import { OutputRenderer } from './OutputRenderer';

function firstMediaUrl(outputs: Record<string, PortValue>): string | null {
  for (const t of ['Image', 'Video', 'Audio', 'Mesh', 'SVG'] as const) {
    const o = Object.values(outputs).find((v) => v.type === t && typeof v.value === 'string' && v.value);
    if (o) return o.value as string;
  }
  return null;
}

export interface ResultCardProps {
  node: Node<NodeData> | undefined;
  onOpenInCanvas: () => void;
  onUseAsInput: (url: string) => void;
  onDelete: () => void;
}

export function ResultCard({ node, onOpenInCanvas, onUseAsInput, onDelete }: ResultCardProps) {
  if (!node) return null;
  const url = firstMediaUrl(node.data.outputs);
  return (
    <div className="result-card">
      <div className="result-card__media">
        <OutputRenderer outputs={node.data.outputs} state={node.data.state}
          streamingText={node.data.streamingText} streamingPartials={node.data.streamingPartials} error={node.data.error} />
      </div>
      <div className="result-card__actions">
        {url && <a className="result-card__btn" href={url} download title="Download"><Download size={15} strokeWidth={1.75} /></a>}
        <button className="result-card__btn" type="button" onClick={onOpenInCanvas} title="Open in canvas"><SquareArrowOutUpRight size={15} strokeWidth={1.75} /></button>
        {url && <button className="result-card__btn" type="button" onClick={() => onUseAsInput(url)} title="Use as input"><ImagePlus size={15} strokeWidth={1.75} /></button>}
        <button className="result-card__btn result-card__btn--danger" type="button" onClick={onDelete} title="Delete"><Trash2 size={15} strokeWidth={1.75} /></button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `ResultsGallery`**

Create `frontend/src/components/create-studio/ResultsGallery.tsx`:

```tsx
import { useState } from 'react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { galleryItemsFromSession, type GenerationRecord } from '../../lib/createGallery';
import { ResultCard } from './ResultCard';

export interface ResultsGalleryProps {
  records: GenerationRecord[];
  nodes: Node<NodeData>[];
  onOpenInCanvas: (nodeId: string) => void;
  onUseAsInput: (url: string) => void;
  onDelete: (nodeId: string) => void;
}

export function ResultsGallery({ records, nodes, onOpenInCanvas, onUseAsInput, onDelete }: ResultsGalleryProps) {
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const items = galleryItemsFromSession(records, nodes);
  if (items.length === 0) return null;
  return (
    <div className="results-gallery">
      <div className="results-gallery__bar">
        <span className="results-gallery__count">{items.length} result{items.length === 1 ? '' : 's'}</span>
        <div className="results-gallery__layout">
          <button type="button" className={layout === 'grid' ? 'is-active' : ''} onClick={() => setLayout('grid')}>Grid</button>
          <button type="button" className={layout === 'list' ? 'is-active' : ''} onClick={() => setLayout('list')}>List</button>
        </div>
      </div>
      <div className={`results-gallery__items results-gallery__items--${layout}`}>
        {items.map((it) => (
          <ResultCard key={it.nodeId} node={it.node}
            onOpenInCanvas={() => onOpenInCanvas(it.nodeId)}
            onUseAsInput={onUseAsInput}
            onDelete={() => onDelete(it.nodeId)} />
        ))}
      </div>
    </div>
  );
}
```

> v2 scope note: the spec's "All outputs" tab is deferred to a fast-follow — the History (session) gallery is the P2 deliverable. `_createOrigin` tags are still applied (Task A4) for that future tab. Log this so it isn't mistaken for complete.

- [ ] **Step 3: Add gallery/card/tray CSS**

Create/extend `frontend/src/styles/create-gallery.css` (all selectors scoped under `body.app-slava-restraint`). Include `.results-gallery`, `.results-gallery__bar`, `.results-gallery__items--grid` (CSS grid, `repeat(auto-fill, minmax(180px, 1fr))`), `--list` (single column), `.result-card` (rounded, `--sr-edge` border, `--sr-glass` bg), `.result-card__media` (aspect-ratio box), `.result-card__actions` (row of `.result-card__btn`, revealed on `.result-card:hover`), `.result-card__btn--danger` (uses `--sr-accent` or a red), and `.reference-tray`/`.reference-tray__chip`/`__thumb`/`__remove`. Mirror the token usage from `create-studio.css`.

- [ ] **Step 4: Type-check + import the stylesheet**

Add `import '../../styles/create-gallery.css';` to `CreateView.tsx`. Run: `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/create-studio/ResultCard.tsx frontend/src/components/create-studio/ResultsGallery.tsx frontend/src/styles/create-gallery.css frontend/src/components/create-studio/CreateView.tsx
git commit -m "feat(create): results gallery + result cards"
```

### Task D4: wire the gallery + actions into `CreateView`

**Files:**
- Modify: `frontend/src/components/create-studio/CreateView.tsx`

- [ ] **Step 1: Track session generations + render the gallery**

In `CreateView.tsx`:
- Add `const [generations, setGenerations] = useState<GenerationRecord[]>([]);` (import `GenerationRecord`).
- In `handleGenerate`, after `authorGenerationCluster` resolves, record the generation:

```tsx
    const { modelNodeIds, allNodeIds } = await authorGenerationCluster({ /* ...existing args, refPaths, quantity... */ });
    if (modelNodeIds.length > 0) {
      setGenerations((prev) => [...prev, { genId, prompt, ts: Date.now(), modelNodeIds }]);
    }
    await executeCluster(allNodeIds);
```

- Subscribe to all nodes for the gallery: `const allNodes = useGraphStore((s) => s.nodes);`
- Replace the P1 single-result stage block with:

```tsx
      <div className="create-view__stage">
        {generations.length === 0 ? (
          <div className="create-view__hero"> {/* unchanged hero */} </div>
        ) : (
          <ResultsGallery
            records={generations}
            nodes={allNodes}
            onOpenInCanvas={handleOpenInCanvas}
            onUseAsInput={(url) => handleUseAsInput(url)}
            onDelete={handleDelete}
          />
        )}
      </div>
```

- [ ] **Step 2: Implement the three card-action handlers**

```tsx
  const handleOpenInCanvas = (nodeId: string) => {
    useUIStore.getState().exitCreateView();
    useUIStore.getState().setSelectedNodeId?.(nodeId); // select if the action exists; otherwise omit
  };

  const handleUseAsInput = async (url: string) => {
    // A served /api/outputs URL works as a refPath thanks to the engine resolver (Task A2).
    setRefs((prev) => prev.some((r) => r.filePath === url) ? prev : [...prev, { filePath: url, previewUrl: url }]);
  };

  const handleDelete = (nodeId: string) => {
    useGraphStore.getState().deleteGeneration([nodeId]);
    setGenerations((prev) => prev.map((g) => ({ ...g, modelNodeIds: g.modelNodeIds.filter((id) => id !== nodeId) }))
      .filter((g) => g.modelNodeIds.length > 0));
  };
```

> Check whether `uiStore` exposes a select/center action (e.g. `setSelectedNodeId`). If it does, call it; if not, just `exitCreateView()` (the node is on the canvas regardless). Do not invent an action — verify in `uiStore.ts`.

- [ ] **Step 3: Type-check + build + lint**

Run:
```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build && npx eslint src/components/create-studio src/lib/createGallery.ts src/lib/createUploads.ts && npm run check:slava-css-scope
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/create-studio/CreateView.tsx
git commit -m "feat(create): wire gallery + open/use-as-input/delete actions"
```

---

## Phase E — Output-type alignment

### Task E1: align `OutputRenderer` with ModelNode

**Files:**
- Modify: `frontend/src/components/create-studio/OutputRenderer.tsx`

- [ ] **Step 1: Gate media on `complete`, render streaming SVG, keep streaming text/partials**

Update `OutputRenderer.tsx` so that:
- The `queued`/`executing` branch (added in P1) also renders `streamingSvg` if present (an `<img>` of the latest draft) before falling back to partials/text/spinner.
- Media outputs (`Image`/`Video`/`Mesh`/`Audio`/`SVG`) render only when `state === 'complete'` (matching `ModelNode.tsx`), so a node carrying stale outputs in a non-complete state never flashes an old asset. Text may render whenever present.

Concretely, change the media section to gate on state:

```tsx
  const isComplete = state === 'complete';
  const video = isComplete ? findByType(outputs, 'Video') : undefined;
  const image = isComplete ? (findByType(outputs, 'Image') ?? findByType(outputs, 'SVG')) : undefined;
  const mesh = isComplete ? findByType(outputs, 'Mesh') : undefined;
  const audio = isComplete ? findByType(outputs, 'Audio') : undefined;
  const text = findByType(outputs, 'Text');
```

And in the streaming branch add, before the partials check:

```tsx
    if (streamingSvg?.svg) {
      return <img className="create-output__media" src={`data:image/svg+xml;utf8,${encodeURIComponent(streamingSvg.svg)}`} alt="Generating preview" />;
    }
```

Add `streamingSvg?: { index: number; svg: string; isFinal: boolean }` to the props type (it exists on `NodeData`), and pass it from `ResultCard`/`CreateView` where `OutputRenderer` is used.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/OutputRenderer.tsx frontend/src/components/create-studio/ResultCard.tsx frontend/src/components/create-studio/CreateView.tsx
git commit -m "fix(create): align OutputRenderer with ModelNode (complete-gate, streaming svg)"
```

---

## Phase F — Live verification

### Task F1: live smoke (no code; manual, normal browser, NOT lspace)

- [ ] Start backend (`cd backend && .venv/bin/python -m uvicorn main:app --port 8000`) + frontend (`cd frontend && npm run dev`); open the Vite URL.
- [ ] Open Create, attach a reference image (button + drag-drop both), set quantity=2, Generate. Confirm: two result cards stream then render; the reference chip showed in the tray.
- [ ] On a completed card: **Download** saves the file; **Use as input** adds it to the tray; **Open in canvas** exits to the canvas with the cluster visible; **Delete** removes that card and its node.
- [ ] Switch to the canvas → confirm the authored `Text Input (+ Image Input) → model` cluster(s) are present.
- [ ] **Reload the browser** → confirm the clusters are STILL on the canvas (backend-authored persistence works). Note: the Create-view gallery is session-scoped and starts empty after reload (expected); the canvas nodes persist.
- [ ] Verify with a model that requires an image (e.g. an image-to-video node) that the attached reference (absolute path) and a "use as input" served URL both execute without the FAL local-path error.
- [ ] Record anything off in `implementation-notes.md`.

---

## Self-Review

- **Spec coverage:** results gallery/History (D1-D4) ✓; reference attach (B1-B2) ✓; quantity>1 (C1 + A4 fan-out, already supported) ✓; all output types (E1) ✓; backend-authored persistence (A1-A5) ✓. Deferred & logged: the gallery "All outputs" tab (session History ships; All-outputs is a fast-follow), and gallery repopulation after reload (canvas persists; gallery is session-scoped).
- **Placeholder scan:** the `in_iter_all_nodes` line in the A3 test is explicitly short-circuited and called out to delete — the real additive assertion is `len(cli_graph.nodes) == 3`. Two "verify the route/action path against the codebase" notes (backend node-delete path in D2; uiStore select action in D4) are explicit verification steps, not deferrals. No TBD/TODO.
- **Type consistency:** `authorGenerationCluster` returns `Promise<{modelNodeIds, allNodeIds}>` (A4) and every call site `await`s it (A4/D4); `GenerationRecord` (D1) is used by `ResultsGallery` (D3) and `CreateView` (D4); `AttachedRef` (B1/B2) shared by tray + view; `UploadedReference`→`{filePath, previewUrl}` (B1) matches `handleAttach` usage (B2); `deleteGeneration(modelNodeIds: string[])` (D2) matches `handleDelete` (D4).
- **Risk to existing behavior:** `executeCluster`, `handleExecutionEvent`, `addNode` untouched; the new route is additive; the engine change is isolated to the `image-input` branch behind a pass-through resolver (non-`/api/outputs` values unchanged).
