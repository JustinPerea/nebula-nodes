# RemotionNode Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a working `RemotionNode` node type on the Nebula canvas with its own editor surface (`@remotion/player` + `@xzdarcy/react-timeline-editor`) that opens from the canvas card, loads/persists a `VideoGraphManifest`, scrubs a deterministic Remotion composition with one working asset mapper (`TextRenderer`), and bidirectionally syncs frame state between Player and Timeline.

**Architecture:** New node type `remotion-node` lives in `backend/data/node_definitions.json` alongside `video-edit`. Phase 1's `EditNode`/`<EditorView>` chain stays untouched. A new `RemotionNode.tsx` card registers under React Flow's `remotionNode` type and opens `<RemotionEditorView>` via a new `enterRemotionEditor` action on `uiStore` (parallel to Phase 1's `enterEditor`). The editor reads `node.data.params.manifest` (typed as `VideoGraphManifest` from `frontend/src/types/video.ts`), mounts `<Player>` over a Remotion composition and the `<Timeline>` editor side-by-side, and writes mutations back through a new `manifestValidator` boundary. All animation is deterministic — every property reads from `useCurrentFrame()` + `interpolate()` via a new `keyframeInterp` helper. No Framer Motion, no CSS transitions, no rAF loops driven from React state.

**Tech Stack:** React 19 + Vite + Zustand + `@xyflow/react` + Vitest (frontend). FastAPI + Python (backend; this phase only validates/echoes the manifest — Remotion Player handles preview client-side). Dependencies already installed: `@remotion/player@4.0.464`, `@xzdarcy/react-timeline-editor@1.0.0`. Remotion best-practices skill at `~/.claude/skills/remotion-best-practices/SKILL.md`.

**Source branch:** `main` (HEAD: `58de422`)

**Companion docs (read before starting):**
- Spec: `docs/superpowers/specs/2026-05-21-remotion-editor-mode-spec.md`
- Schema scaffold (already exists, do not duplicate types): `frontend/src/types/video.ts`
- Remotion best-practices: `~/.claude/skills/remotion-best-practices/SKILL.md`
- Phase 1 mirror pattern: `frontend/src/components/nodes/EditNode.tsx`, `frontend/src/store/uiStore.ts:enterEditor`, `frontend/src/App.tsx:isCanvas`

**Phase 2.1 scope split:**
- ✅ This plan (2.1.a — foundation): backend wiring, canvas card, editor lifecycle, Player + Timeline scaffold, bidirectional frame sync, manifest persistence, keyframe interpolation helper, and `TextRenderer` as the first asset mapper.
- ⏭ Plan 2.1.b (next): `SVGRenderer` / `ImageRenderer` / `VideoRenderer`, bidirectional graph mirroring (Rules A and B from spec §Phase 3), in-editor UI to add/remove TrackItems, playhead-relative duplication.
- ⏭ Phase 2.2 (separate plan): R3F isometric blocks, `IsometricBlock` component, 3D camera + projection matrices.

---

## File Structure

### Backend files (4)

| File | Responsibility | Change scope |
|------|----------------|--------------|
| `backend/data/node_definitions.json` | Add `"remotion-node"` entry with one multi-input `Any` port, one `Video` output, and a `manifest` param defaulting to an empty `VideoGraphManifest` | Small add |
| `backend/main.py` (~line 1631 in the `/api/graph/export` resolver chain) | Add a parallel `"remotionNode"` branch alongside the existing `"editNode"` branch | Tiny change |
| `backend/handlers/remotion_node.py` | NEW. Validates `params.manifest` matches `VideoGraphManifest` shape, returns it as the node's output (no server-side rendering this phase) | New file |
| `backend/execution/sync_runner.py:622` (the registry block) | Add a `_remotion_node_handler` wrapper + `registry["remotion-node"]` registration, mirroring the existing `_video_edit_handler` pattern at lines 611-622 | Small add |

### Frontend files (15)

| File | Responsibility | Change scope |
|------|----------------|--------------|
| `frontend/src/components/nodes/RemotionNode.tsx` | NEW. React Flow card mirroring `EditNode.tsx` shape — title, layer-count summary, "Open Editor" button when selected | New file |
| `frontend/src/components/Canvas.tsx:31` | Add `remotionNode: RemotionNode` to the React Flow `nodeTypes` map | Tiny change |
| `frontend/src/store/uiStore.ts` | Add `viewMode: 'remotion-editor'` variant, `remotionEditorTargetNodeId` field, `enterRemotionEditor(nodeId)` and `exitRemotionEditor()` actions. Do NOT modify Phase 1's `enterEditor`/`exitEditor` | Small additions |
| `frontend/src/App.tsx:133` | Replace `{isCanvas ? <Canvas /> : <EditorView />}` with a three-way switch that also renders `<RemotionEditorView />` when `viewMode === 'remotion-editor'`. Update each `{isCanvas && ...}` chrome guard to also hide on RemotionEditor mode | Small change |
| `frontend/src/components/video-editor/RemotionEditorView.tsx` | NEW. Top-level editor surface — title bar with breadcrumb + Close button, split layout (Player on top, Timeline on bottom). Reads/writes manifest via graphStore | New file |
| `frontend/src/components/video-editor/RemotionComposition.tsx` | NEW. The Remotion `Composition` body. Iterates `manifest.timeline`, wraps each `TrackItem` in a `<Sequence from={time.startFrame} durationInFrames={time.durationInFrames}>`, delegates render to an asset mapper by `componentType` | New file |
| `frontend/src/components/video-editor/RemotionTimeline.tsx` | NEW. Wraps `@xzdarcy/react-timeline-editor`'s `<Timeline>` — translates `manifest.timeline` ↔ xzdarcy's `editorData`, calls `onChange` upward | New file |
| `frontend/src/components/video-editor/components/TextRenderer.tsx` | NEW. Asset mapper for `componentType: 'TextNode'`. Reads `props.text`, applies `spatial` transform + `keyframes` via `keyframeInterp` | New file |
| `frontend/src/lib/video/keyframeInterp.ts` | NEW. `interpolateScalar(frames, keyframes)` and `interpolateVec3(frames, keyframes)` helpers that wrap Remotion's `interpolate()` + `spring()` and return the property value at the current frame | New file |
| `frontend/src/lib/video/manifestValidator.ts` | NEW. `validateManifest(unknown) → { ok: true, manifest } \| { ok: false, error }` runtime guard that the editor uses before reading/writing | New file |
| `frontend/src/store/graphStore.ts` | Add `updateRemotionManifest(nodeId: string, patch: Partial<VideoGraphManifest>)` action (wraps `updateNodeData` with manifest validation). No other changes. | Small add |
| `frontend/tests/video/keyframeInterp.test.ts` | NEW. Unit tests for scalar + vec3 interpolation at frame boundaries and easings | New test file |
| `frontend/tests/video/manifestValidator.test.ts` | NEW. Unit tests for valid + malformed manifests | New test file |
| `frontend/tests/video/RemotionNode.test.tsx` | NEW. Component test — renders title + summary + open button | New test file |
| `frontend/tests/video/uiStore.remotionEditor.test.ts` | NEW. Unit tests for `enterRemotionEditor` / `exitRemotionEditor` state transitions | New test file |

### Files NOT touched (Phase 1 isolation invariant)

- `frontend/src/lib/editor/virtualPlayback.ts` — Phase 1's `EditClip` type stays untouched
- `frontend/src/components/editor/*` — Phase 1 editor surface (Timeline, VideoPreview, EditorTransport, etc.) untouched
- `frontend/src/components/nodes/EditNode.tsx` — Phase 1 canvas card untouched
- `backend/handlers/video_edit*.py` (if it exists) — Phase 1 backend handler untouched
- `frontend/src/store/uiStore.ts:enterEditor` / `:exitEditor` — Phase 1 actions untouched (new actions added alongside)

### Design invariants the plan enforces

1. **Schema isolation:** `frontend/src/types/video.ts` is the only types file for Phase 2. Never import `EditClip`, `clipSpeed`, or any `frontend/src/lib/editor/*` symbol into a `frontend/src/components/video-editor/*` or `frontend/src/lib/video/*` file.
2. **Persistence path:** Manifest lives at `node.data.params.manifest` on the RemotionNode itself (not on a sibling node). Writes go through `updateRemotionManifest` (which calls the existing `updateNodeData`).
3. **Rotation units:** Always degrees at the schema layer. Convert to radians at the Three.js boundary only (Phase 2.2 concern).
4. **Animation:** Every animated visual property goes through `useCurrentFrame()` + `interpolate()` / `spring()`. No CSS transitions, no `requestAnimationFrame`, no Framer Motion.
5. **Slava restraint:** All new CSS under `body.app-slava-restraint` scope, using `--sr-*` tokens. No inline styles.

---

## Task Sequence

The 14 tasks are ordered to keep the build green at every commit. Phase A wires the backend so the canvas accepts the new node. Phase B puts the card on the canvas. Phase C opens an empty editor view. Phase D mounts Player + Timeline. Phase E persists state. Phase F adds the first asset mapper. Phase G smokes the whole flow.

Each task is one commit. Each commit must leave `npm run build` exit 0 and `npm test` pass (frontend) + `pytest` pass (backend).

---

### Phase A — Backend wiring

### Task 1: Add `remotion-node` to `node_definitions.json`

**Files:**
- Modify: `backend/data/node_definitions.json` (locate the `"video-edit"` entry near line 2334; insert the new entry directly after `"video-edit"` and before `"preview"`)
- Test: `backend/tests/test_node_definitions.py` (create if it doesn't exist)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_node_definitions.py`:

```python
import json
from pathlib import Path

NODE_DEFS_PATH = Path(__file__).parent.parent / "data" / "node_definitions.json"

def test_remotion_node_definition_exists():
    with open(NODE_DEFS_PATH) as f:
        defs = json.load(f)
    assert "remotion-node" in defs, "remotion-node entry missing"
    entry = defs["remotion-node"]
    assert entry["id"] == "remotion-node"
    assert entry["displayName"] == "Remotion Composition"
    assert entry["category"] == "utility"
    assert entry["apiProvider"] == "utility"
    assert entry["executionPattern"] == "async-poll"

def test_remotion_node_ports():
    with open(NODE_DEFS_PATH) as f:
        defs = json.load(f)
    entry = defs["remotion-node"]
    # Multi-input port for upstream TrackItem sources
    assert len(entry["inputPorts"]) == 1
    assert entry["inputPorts"][0]["id"] == "sources"
    assert entry["inputPorts"][0]["dataType"] == "Any"
    assert entry["inputPorts"][0]["required"] is False
    # Single Video output for downstream consumers
    assert len(entry["outputPorts"]) == 1
    assert entry["outputPorts"][0]["id"] == "video"
    assert entry["outputPorts"][0]["dataType"] == "Video"

def test_remotion_node_manifest_param():
    with open(NODE_DEFS_PATH) as f:
        defs = json.load(f)
    entry = defs["remotion-node"]
    # Manifest param is the serialized VideoGraphManifest, default is empty
    params = entry["params"]
    manifest_param = next((p for p in params if p["id"] == "manifest"), None)
    assert manifest_param is not None, "manifest param missing"
    assert manifest_param["type"] == "json"
    assert manifest_param["default"] == {"graph": {"nodes": [], "edges": []}, "timeline": []}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_node_definitions.py -v`
Expected: 3 FAIL with "remotion-node entry missing"

- [ ] **Step 3: Add the definition**

Edit `backend/data/node_definitions.json`. After the `"video-edit": { ... }` block (closing brace + comma), insert:

```json
  "remotion-node": {
    "id": "remotion-node",
    "displayName": "Remotion Composition",
    "category": "utility",
    "apiProvider": "utility",
    "apiEndpoint": "",
    "envKeyName": [],
    "executionPattern": "async-poll",
    "inputPorts": [
      {
        "id": "sources",
        "label": "Track Sources",
        "dataType": "Any",
        "required": false
      }
    ],
    "outputPorts": [
      {
        "id": "video",
        "label": "Rendered Video",
        "dataType": "Video",
        "required": false
      }
    ],
    "params": [
      {
        "id": "manifest",
        "label": "Manifest",
        "type": "json",
        "default": {"graph": {"nodes": [], "edges": []}, "timeline": []}
      }
    ]
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_node_definitions.py -v`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add backend/data/node_definitions.json backend/tests/test_node_definitions.py
git commit -m "feat(remotion): add remotion-node definition to node registry"
```

---

### Task 2: Add `remotionNode` branch to graph export resolver

**Files:**
- Modify: `backend/main.py:1631` (the `else "editNode" if definition_id == "video-edit"` chain in the `/api/graph/export` endpoint)
- Test: `backend/tests/test_graph_export.py` (create if it doesn't exist)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_graph_export.py`:

```python
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_remotion_node_exports_as_remotionNode_type():
    payload = {
        "nodes": [
            {
                "id": "test-remotion-1",
                "definitionId": "remotion-node",
                "params": {"manifest": {"graph": {"nodes": [], "edges": []}, "timeline": []}},
                "outputs": {},
                "position": {"x": 0, "y": 0}
            }
        ],
        "edges": []
    }
    response = client.post("/api/graph/export", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["node_type"] == "remotionNode"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_graph_export.py::test_remotion_node_exports_as_remotionNode_type -v`
Expected: FAIL — `node_type` will be `"model-node"` or default (because the resolver chain has no remotion-node branch)

- [ ] **Step 3: Add the resolver branch**

In `backend/main.py`, find the resolver chain (currently `~line 1630-1636`):

```python
        node_type = (
            "reroute-node"
            if definition_id == "reroute"
            else "editNode"
            if definition_id == "video-edit"
            else "dynamic-node"
            if is_dynamic_node
            else "model-node"
        )
```

Replace with:

```python
        node_type = (
            "reroute-node"
            if definition_id == "reroute"
            else "editNode"
            if definition_id == "video-edit"
            else "remotionNode"
            if definition_id == "remotion-node"
            else "dynamic-node"
            if is_dynamic_node
            else "model-node"
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_graph_export.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_graph_export.py
git commit -m "feat(remotion): route remotion-node to remotionNode type in graph export"
```

---

### Task 3: Create `remotion_node.py` handler stub + register in sync_runner

**Files:**
- Create: `backend/handlers/remotion_node.py`
- Modify: `backend/execution/sync_runner.py` (~line 611-622 — add `_remotion_node_handler` mirroring `_video_edit_handler`)
- Test: `backend/tests/test_remotion_node_handler.py`

Handlers in this codebase register via wrappers in `backend/execution/sync_runner.py`, not via `handlers/__init__.py` (which is empty). The pattern at line 611-622 is the template — read it once to confirm the wrapper signature, then mirror.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_remotion_node_handler.py`:

```python
import pytest
from handlers.remotion_node import handle_remotion_node

@pytest.mark.asyncio
async def test_handler_returns_manifest_on_valid_input():
    manifest = {"graph": {"nodes": [], "edges": []}, "timeline": []}
    node = {"id": "remotion-test-1", "params": {"manifest": manifest}}
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert "video" in result
    assert "manifest" in result
    assert result["manifest"] == manifest

@pytest.mark.asyncio
async def test_handler_rejects_malformed_manifest():
    node = {"id": "remotion-test-2", "params": {"manifest": {"not_a_real": "shape"}}}
    with pytest.raises(ValueError, match="manifest"):
        await handle_remotion_node(node, inputs={}, api_keys={})

@pytest.mark.asyncio
async def test_handler_uses_empty_default_when_no_manifest_param():
    node = {"id": "remotion-test-3", "params": {}}
    result = await handle_remotion_node(node, inputs={}, api_keys={})
    assert result["manifest"] == {"graph": {"nodes": [], "edges": []}, "timeline": []}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_remotion_node_handler.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'handlers.remotion_node'`

- [ ] **Step 3: Write the handler**

Create `backend/handlers/remotion_node.py`:

```python
"""Handler for the remotion-node node type.

This is a no-op handler for Phase 2.1 — Remotion preview happens client-side
via @remotion/player. The handler validates the manifest shape and echoes it
through as the node's output so downstream consumers receive a typed value.

Server-side rendering of the composition is deferred to a later phase.
"""
from typing import Any

REQUIRED_TOP_LEVEL_KEYS = {"graph", "timeline"}
REQUIRED_GRAPH_KEYS = {"nodes", "edges"}
EMPTY_MANIFEST = {"graph": {"nodes": [], "edges": []}, "timeline": []}


def _validate_manifest(manifest: Any) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    missing = REQUIRED_TOP_LEVEL_KEYS - set(manifest.keys())
    if missing:
        raise ValueError(f"manifest missing top-level keys: {missing}")
    graph = manifest.get("graph")
    if not isinstance(graph, dict):
        raise ValueError("manifest.graph must be an object")
    missing_graph = REQUIRED_GRAPH_KEYS - set(graph.keys())
    if missing_graph:
        raise ValueError(f"manifest.graph missing keys: {missing_graph}")
    if not isinstance(manifest.get("timeline"), list):
        raise ValueError("manifest.timeline must be a list")


async def handle_remotion_node(node: dict, inputs: dict, api_keys: dict, emit=None) -> dict:
    """Echo the manifest as output. No server-side rendering this phase."""
    params = node.get("params") or {}
    manifest = params.get("manifest") or EMPTY_MANIFEST
    _validate_manifest(manifest)
    return {
        "video": None,
        "manifest": manifest,
    }
```

- [ ] **Step 4: Register the handler in `sync_runner.py`**

Open `backend/execution/sync_runner.py`. Locate the block around line 611 with the existing `_video_edit_handler` wrapper:

```python
        async def _video_edit_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.video_edit import handle_video_edit
            return await handle_video_edit(node, inputs, api_keys, emit=emit)
```

Immediately after it, add:

```python
        async def _remotion_node_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            from handlers.remotion_node import handle_remotion_node
            return await handle_remotion_node(node, inputs, api_keys, emit=emit)
```

Then locate the block where the registry is populated (line ~620-625):

```python
        registry["video-edit"] = _video_edit_handler
```

Add directly below:

```python
        registry["remotion-node"] = _remotion_node_handler
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && ./.venv/bin/python -m pytest tests/test_remotion_node_handler.py -v`
Expected: 3 PASS

Run full suite to sanity-check: `cd backend && ./.venv/bin/python -m pytest tests/ -v`
Expected: full suite PASS

- [ ] **Step 6: Commit**

```bash
git add backend/handlers/remotion_node.py backend/execution/sync_runner.py backend/tests/test_remotion_node_handler.py
git commit -m "feat(remotion): handler stub + register remotion-node in sync_runner"
```

---

### Phase B — Frontend canvas representation

### Task 4: Create `RemotionNode.tsx` card

**Files:**
- Create: `frontend/src/components/nodes/RemotionNode.tsx`
- Test: `frontend/tests/video/RemotionNode.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/RemotionNode.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { RemotionNode } from '../../src/components/nodes/RemotionNode';

vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: { enterRemotionEditor: (id: string) => void }) => unknown) =>
    selector({ enterRemotionEditor: vi.fn() }),
}));

function mkProps(overrides: Partial<NodeProps> = {}): NodeProps {
  return {
    id: 'remotion-1',
    type: 'remotionNode',
    selected: false,
    data: { params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [] } } },
    ...overrides,
  } as unknown as NodeProps;
}

describe('RemotionNode card', () => {
  it('renders title and empty-state summary', () => {
    render(
      <ReactFlowProvider>
        <RemotionNode {...mkProps()} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/Remotion Composition/i)).toBeInTheDocument();
    expect(screen.getByText(/no layers yet/i)).toBeInTheDocument();
  });

  it('renders layer count when manifest has TrackItems', () => {
    const props = mkProps({
      data: {
        params: {
          manifest: {
            graph: { nodes: [], edges: [] },
            timeline: [
              { id: 't1', sourceNodeId: 's1', componentType: 'TextNode', time: { startFrame: 0, durationInFrames: 60 }, spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] }, keyframes: {}, props: {} },
            ],
          },
        },
      },
    });
    render(
      <ReactFlowProvider>
        <RemotionNode {...props} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/1 layer/i)).toBeInTheDocument();
  });

  it('shows Open Editor button when selected', () => {
    render(
      <ReactFlowProvider>
        <RemotionNode {...mkProps({ selected: true })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole('button', { name: /open editor/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- RemotionNode`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the component**

Create `frontend/src/components/nodes/RemotionNode.tsx`:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import type { VideoGraphManifest } from '../../types/video';

interface RemotionNodeData {
  params?: {
    manifest?: VideoGraphManifest;
  };
}

export function RemotionNode({ id, data, selected }: NodeProps) {
  const enterRemotionEditor = useUIStore((s) => s.enterRemotionEditor);
  const params = ((data as RemotionNodeData).params ?? {}) as RemotionNodeData['params'];
  const manifest = params?.manifest;
  const layers = manifest?.timeline ?? [];
  const layerCount = layers.length;
  const totalFrames = layers.reduce(
    (max, l) => Math.max(max, l.time.startFrame + l.time.durationInFrames),
    0,
  );

  const summary =
    layerCount === 0
      ? 'no layers yet'
      : `${layerCount} layer${layerCount === 1 ? '' : 's'} · ${totalFrames}f`;

  return (
    <div className={`remotion-node ${selected ? 'remotion-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="sources" />
      <div className="remotion-node__title">▶ Remotion Composition</div>
      <div className="remotion-node__summary">{summary}</div>
      {selected && (
        <button
          type="button"
          className="remotion-node__open"
          onClick={() => enterRemotionEditor(id)}
        >
          Open Editor
        </button>
      )}
      <Handle type="source" position={Position.Right} id="video" />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- RemotionNode`
Expected: 3 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/nodes/RemotionNode.tsx frontend/tests/video/RemotionNode.test.tsx
git commit -m "feat(remotion): RemotionNode canvas card with Open Editor button"
```

---

### Task 5: Register `remotionNode` in Canvas.tsx

**Files:**
- Modify: `frontend/src/components/Canvas.tsx` (around line 21 for the import, line 31 for `nodeTypes`)

- [ ] **Step 1: Add the import**

In `frontend/src/components/Canvas.tsx` at line 21 (right below `import { EditNode } from './nodes/EditNode';`):

```tsx
import { RemotionNode } from './nodes/RemotionNode';
```

- [ ] **Step 2: Register the node type**

In the `nodeTypes` map declaration (around line 30), add the new entry. The existing entry shape is `editNode: EditNode,`. Add directly below it:

```tsx
const nodeTypes = {
  // ... existing entries
  editNode: EditNode,
  remotionNode: RemotionNode,
  // ... rest
};
```

- [ ] **Step 3: Verify the build**

Run: `cd frontend && npm run build`
Expected: exit 0, no TypeScript errors

Run: `cd frontend && npm test`
Expected: full suite PASS

- [ ] **Step 4: Manual smoke**

Open `http://localhost:5180` in browser. Drop a Remotion Composition node from the library. Confirm the card renders with "▶ Remotion Composition" title and "no layers yet" summary. Selecting the card shows the "Open Editor" button (it will error on click — that's expected; Task 6 wires the handler).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Canvas.tsx
git commit -m "feat(remotion): register remotionNode in React Flow nodeTypes"
```

---

### Phase C — Editor lifecycle + view scaffold

### Task 6: Add `enterRemotionEditor` / `exitRemotionEditor` to uiStore

**Files:**
- Modify: `frontend/src/store/uiStore.ts` (~line 102 for the type def, ~line 165 for `enterEditor` body)
- Test: `frontend/tests/video/uiStore.remotionEditor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/uiStore.remotionEditor.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/store/uiStore';

describe('uiStore — RemotionEditor lifecycle', () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
    });
  });

  it('enterRemotionEditor sets viewMode and target node id', () => {
    useUIStore.getState().enterRemotionEditor('remotion-1');
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('remotion-editor');
    expect(state.remotionEditorTargetNodeId).toBe('remotion-1');
  });

  it('exitRemotionEditor resets to canvas viewMode', () => {
    useUIStore.getState().enterRemotionEditor('remotion-1');
    useUIStore.getState().exitRemotionEditor();
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('canvas');
    expect(state.remotionEditorTargetNodeId).toBeNull();
  });

  it('enterRemotionEditor does not affect Phase 1 editor state', () => {
    useUIStore.setState({ editorTargetNodeId: 'edit-1' });
    useUIStore.getState().enterRemotionEditor('remotion-1');
    expect(useUIStore.getState().editorTargetNodeId).toBe('edit-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- uiStore.remotionEditor`
Expected: FAIL — `enterRemotionEditor is not a function`.

- [ ] **Step 3: Add the type def**

In `frontend/src/store/uiStore.ts`, locate the `ViewMode` union (search for `viewMode:`). It currently looks like:

```ts
viewMode: 'canvas' | 'editor';
```

Change to:

```ts
viewMode: 'canvas' | 'editor' | 'remotion-editor';
remotionEditorTargetNodeId: string | null;
```

In the same interface, add to the actions section (near `enterEditor:` at line 102):

```ts
enterRemotionEditor: (remotionNodeId: string) => void;
exitRemotionEditor: () => void;
```

- [ ] **Step 4: Add the initial state and action bodies**

In the initial state block (where you find `viewMode: 'canvas',`), add:

```ts
  remotionEditorTargetNodeId: null,
```

Below the existing `exitEditor` action (around line 175-180), add:

```ts
  enterRemotionEditor: (remotionNodeId) => {
    set({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: remotionNodeId,
    });
  },

  exitRemotionEditor: () => {
    set({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
    });
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- uiStore.remotionEditor`
Expected: 3 PASS

Run full suite to confirm no Phase 1 regressions: `cd frontend && npm test`
Expected: full suite PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/uiStore.ts frontend/tests/video/uiStore.remotionEditor.test.ts
git commit -m "feat(remotion): enterRemotionEditor/exitRemotionEditor on uiStore"
```

---

### Task 7: Create `RemotionEditorView` scaffold

**Files:**
- Create: `frontend/src/components/video-editor/RemotionEditorView.tsx`
- Create: `frontend/src/styles/remotion-editor.css`

- [ ] **Step 1: Write the scaffold component**

Create `frontend/src/components/video-editor/RemotionEditorView.tsx`:

```tsx
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { createEmptyManifest, type VideoGraphManifest } from '../../types/video';
import '../../styles/remotion-editor.css';

export function RemotionEditorView() {
  const targetNodeId = useUIStore((s) => s.remotionEditorTargetNodeId);
  const exitRemotionEditor = useUIStore((s) => s.exitRemotionEditor);
  const node = useGraphStore((s) =>
    targetNodeId ? s.nodes.find((n) => n.id === targetNodeId) : null,
  );

  if (!targetNodeId || !node) {
    return (
      <div className="remotion-editor-view">
        <div className="remotion-editor-view__error">
          No RemotionNode selected.{' '}
          <button type="button" onClick={exitRemotionEditor}>
            Back to canvas
          </button>
        </div>
      </div>
    );
  }

  const manifest: VideoGraphManifest =
    (node.data as { params?: { manifest?: VideoGraphManifest } }).params?.manifest ??
    createEmptyManifest();

  return (
    <div className="remotion-editor-view">
      <header className="remotion-editor-view__header">
        <button
          type="button"
          className="remotion-editor-view__back"
          onClick={exitRemotionEditor}
        >
          ← Canvas
        </button>
        <span className="remotion-editor-view__title">
          Remotion Composition · {targetNodeId}
        </span>
        <span className="remotion-editor-view__meta">
          {manifest.timeline.length} layer{manifest.timeline.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        {/* Player mounts here in Task 8 */}
      </div>
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        {/* Timeline mounts here in Task 8 */}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the stylesheet (Slava-restraint scoped)**

Create `frontend/src/styles/remotion-editor.css`:

```css
body.app-slava-restraint .remotion-editor-view {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: 48px 1fr 320px;
  background: var(--sr-bg-base);
  color: var(--sr-text-primary);
  z-index: 50;
}

body.app-slava-restraint .remotion-editor-view__header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  border-bottom: 1px solid var(--sr-edge-strong);
  background: var(--sr-bg-chrome);
}

body.app-slava-restraint .remotion-editor-view__back {
  background: none;
  border: 1px solid var(--sr-edge-soft);
  color: var(--sr-text-primary);
  padding: 4px 10px;
  border-radius: 2px;
  cursor: pointer;
  font: inherit;
}

body.app-slava-restraint .remotion-editor-view__back:hover {
  border-color: var(--sr-accent);
}

body.app-slava-restraint .remotion-editor-view__title {
  flex: 1;
  font-weight: 500;
}

body.app-slava-restraint .remotion-editor-view__meta {
  color: var(--sr-text-muted);
  font-size: 12px;
}

body.app-slava-restraint .remotion-editor-view__player {
  background: #000;
  display: grid;
  place-items: center;
}

body.app-slava-restraint .remotion-editor-view__timeline {
  border-top: 1px solid var(--sr-edge-strong);
  background: var(--sr-bg-deep);
  overflow: auto;
}

body.app-slava-restraint .remotion-editor-view__error {
  display: grid;
  place-items: center;
  padding: 40px;
  color: var(--sr-text-muted);
}
```

- [ ] **Step 3: Verify the build**

Run: `cd frontend && npm run build`
Expected: exit 0

Run: `cd frontend && npm test`
Expected: full suite PASS (no new test added this task — wiring is the work)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/video-editor/RemotionEditorView.tsx frontend/src/styles/remotion-editor.css
git commit -m "feat(remotion): RemotionEditorView scaffold with Slava header + slots"
```

---

### Task 8: Route App to RemotionEditorView

**Files:**
- Modify: `frontend/src/App.tsx` (around line 6 for import; line 133 for the conditional)

- [ ] **Step 1: Add the import**

Near `frontend/src/App.tsx:6` (next to `import { EditorView } from './components/editor/EditorView';`):

```tsx
import { RemotionEditorView } from './components/video-editor/RemotionEditorView';
```

- [ ] **Step 2: Update the routing**

Find the current rendering (around line 130-140):

```tsx
  const isCanvas = viewMode === 'canvas';
  return (
    <ReactFlowProvider>
      <GraphHydrator />
      <ZoomManifestRecorder />
      <CanvasTabs />
      {isCanvas ? <Canvas /> : <EditorView />}
      {isCanvas && <NodeLibrary />}
      {isCanvas && <NodeInspectorPopover />}
      {isCanvas && <Settings />}
      <ChatPanel />
      {isCanvas && <PanelLaunchers />}
      {isCanvas && <Toolbar />}
      {isCanvas && <AgentLog />}
    </ReactFlowProvider>
  );
```

Replace the conditional with a three-way switch. Add a derived `isRemotion` boolean and `mainView`:

```tsx
  const isCanvas = viewMode === 'canvas';
  const isRemotion = viewMode === 'remotion-editor';

  let mainView;
  if (isCanvas) {
    mainView = <Canvas />;
  } else if (isRemotion) {
    mainView = <RemotionEditorView />;
  } else {
    mainView = <EditorView />;
  }

  return (
    <ReactFlowProvider>
      <GraphHydrator />
      <ZoomManifestRecorder />
      <CanvasTabs />
      {mainView}
      {isCanvas && <NodeLibrary />}
      {isCanvas && <NodeInspectorPopover />}
      {isCanvas && <Settings />}
      <ChatPanel />
      {isCanvas && <PanelLaunchers />}
      {isCanvas && <Toolbar />}
      {isCanvas && <AgentLog />}
    </ReactFlowProvider>
  );
```

- [ ] **Step 3: Manual smoke**

In browser: drop a Remotion Composition node, select it, click "Open Editor". The viewport should swap to the dark `RemotionEditorView` with the header showing "Remotion Composition · <id>" and "0 layers". Click "← Canvas" to return.

- [ ] **Step 4: Verify build + tests**

Run: `cd frontend && npm run build && npm test`
Expected: build exit 0, tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(remotion): route to RemotionEditorView on viewMode='remotion-editor'"
```

---

### Phase D — Mount Player + Timeline

### Task 9: Build `keyframeInterp` helper

**Files:**
- Create: `frontend/src/lib/video/keyframeInterp.ts`
- Test: `frontend/tests/video/keyframeInterp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/keyframeInterp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { interpolateScalar, interpolateVec3 } from '../../src/lib/video/keyframeInterp';
import type { KeyframeData } from '../../src/types/video';

describe('interpolateScalar', () => {
  it('returns the fallback when keyframes is empty', () => {
    expect(interpolateScalar(10, [], 0.5)).toBe(0.5);
  });

  it('returns the only keyframe value when there is exactly one', () => {
    const kfs: KeyframeData[] = [{ frame: 0, value: 42, easing: 'linear' }];
    expect(interpolateScalar(50, kfs, 0)).toBe(42);
  });

  it('clamps before the first keyframe to that keyframe value', () => {
    const kfs: KeyframeData[] = [
      { frame: 30, value: 1, easing: 'linear' },
      { frame: 60, value: 5, easing: 'linear' },
    ];
    expect(interpolateScalar(10, kfs, 0)).toBe(1);
  });

  it('clamps after the last keyframe to that keyframe value', () => {
    const kfs: KeyframeData[] = [
      { frame: 30, value: 1, easing: 'linear' },
      { frame: 60, value: 5, easing: 'linear' },
    ];
    expect(interpolateScalar(120, kfs, 0)).toBe(5);
  });

  it('linearly interpolates between two scalar keyframes', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 0, easing: 'linear' },
      { frame: 60, value: 100, easing: 'linear' },
    ];
    expect(interpolateScalar(30, kfs, 0)).toBe(50);
  });

  it('throws if a vec3 keyframe is fed to scalar interpolation', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: [1, 2, 3], easing: 'linear' },
    ];
    expect(() => interpolateScalar(10, kfs, 0)).toThrow(/scalar/);
  });
});

describe('interpolateVec3', () => {
  it('returns the fallback when keyframes is empty', () => {
    expect(interpolateVec3(10, [], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('linearly interpolates each component independently', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: [0, 0, 0], easing: 'linear' },
      { frame: 60, value: [100, 200, 300], easing: 'linear' },
    ];
    expect(interpolateVec3(30, kfs, [0, 0, 0])).toEqual([50, 100, 150]);
  });

  it('throws if a scalar keyframe is fed to vec3 interpolation', () => {
    const kfs: KeyframeData[] = [
      { frame: 0, value: 42, easing: 'linear' },
    ];
    expect(() => interpolateVec3(10, kfs, [0, 0, 0])).toThrow(/vec3/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- keyframeInterp`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/video/keyframeInterp.ts`:

```ts
import { interpolate, Easing } from 'remotion';
import type { KeyframeData } from '../../types/video';

type Vec3 = [number, number, number];

function easingFor(kind: KeyframeData['easing']) {
  if (kind === 'linear') return Easing.linear;
  if (kind === 'clamp') return Easing.linear; // clamp = no easing curve; clamping is on extrapolate
  // 'spring' easing uses a cubic-bezier approximation for the deterministic interp path;
  // a true Remotion spring() integration belongs in a later helper (Plan 2.1.b).
  return Easing.bezier(0.16, 1, 0.3, 1);
}

function assertScalar(v: KeyframeData['value']): asserts v is number {
  if (typeof v !== 'number') {
    throw new Error('keyframeInterp: expected scalar value, got vec3');
  }
}

function assertVec3(v: KeyframeData['value']): asserts v is Vec3 {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new Error('keyframeInterp: expected vec3 value, got scalar');
  }
}

export function interpolateScalar(
  frame: number,
  keyframes: KeyframeData[],
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback;
  if (keyframes.length === 1) {
    assertScalar(keyframes[0].value);
    return keyframes[0].value;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  // Validate all entries are scalar before interpolating
  sorted.forEach((k) => assertScalar(k.value));

  const frames = sorted.map((k) => k.frame);
  const values = sorted.map((k) => k.value as number);

  return interpolate(frame, frames, values, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easingFor(sorted[0].easing),
  });
}

export function interpolateVec3(
  frame: number,
  keyframes: KeyframeData[],
  fallback: Vec3,
): Vec3 {
  if (keyframes.length === 0) return fallback;
  if (keyframes.length === 1) {
    assertVec3(keyframes[0].value);
    return [...keyframes[0].value] as Vec3;
  }

  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  sorted.forEach((k) => assertVec3(k.value));

  const frames = sorted.map((k) => k.frame);
  const easing = easingFor(sorted[0].easing);

  const axis = (i: 0 | 1 | 2): number =>
    interpolate(
      frame,
      frames,
      sorted.map((k) => (k.value as Vec3)[i]),
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing },
    );

  return [axis(0), axis(1), axis(2)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- keyframeInterp`
Expected: 9 PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/video/keyframeInterp.ts frontend/tests/video/keyframeInterp.test.ts
git commit -m "feat(remotion): keyframeInterp scalar + vec3 helpers (clamp + linear + bezier)"
```

---

### Task 10: Build `manifestValidator` + graphStore action

**Files:**
- Create: `frontend/src/lib/video/manifestValidator.ts`
- Modify: `frontend/src/store/graphStore.ts` (add `updateRemotionManifest` action near existing `updateNodeData`)
- Test: `frontend/tests/video/manifestValidator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/video/manifestValidator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../src/lib/video/manifestValidator';

const VALID = {
  graph: { nodes: [], edges: [] },
  timeline: [],
};

describe('validateManifest', () => {
  it('accepts the empty canonical shape', () => {
    const r = validateManifest(VALID);
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('hello').ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
  });

  it('rejects missing graph', () => {
    expect(validateManifest({ timeline: [] }).ok).toBe(false);
  });

  it('rejects missing timeline', () => {
    expect(validateManifest({ graph: { nodes: [], edges: [] } }).ok).toBe(false);
  });

  it('rejects timeline as non-array', () => {
    expect(validateManifest({ ...VALID, timeline: 'not-an-array' }).ok).toBe(false);
  });

  it('accepts manifest with a well-shaped TrackItem', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'TextNode',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
          keyframes: {},
          props: { text: 'hello' },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects TrackItem with unknown componentType', () => {
    const r = validateManifest({
      graph: { nodes: [], edges: [] },
      timeline: [
        {
          id: 't1',
          sourceNodeId: 's1',
          componentType: 'BogusType',
          time: { startFrame: 0, durationInFrames: 60 },
          spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
          keyframes: {},
          props: {},
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- manifestValidator`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the validator**

Create `frontend/src/lib/video/manifestValidator.ts`:

```ts
import type { VideoGraphManifest, TrackItem, TrackComponentType } from '../../types/video';

const VALID_COMPONENT_TYPES: ReadonlySet<TrackComponentType> = new Set([
  'SVGInput',
  'ImageAssetNode',
  'TextNode',
  'VideoAssetNode',
  'IsometricBlock',
  'LottieNode',
]);

type ValidationResult =
  | { ok: true; manifest: VideoGraphManifest }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateTrackItem(item: unknown, index: number): string | null {
  if (!isObject(item)) return `timeline[${index}] is not an object`;
  if (typeof item.id !== 'string') return `timeline[${index}].id must be a string`;
  if (typeof item.sourceNodeId !== 'string') return `timeline[${index}].sourceNodeId must be a string`;
  if (
    typeof item.componentType !== 'string' ||
    !VALID_COMPONENT_TYPES.has(item.componentType as TrackComponentType)
  ) {
    return `timeline[${index}].componentType is not a known type`;
  }
  if (!isObject(item.time)) return `timeline[${index}].time missing`;
  if (typeof (item.time as Record<string, unknown>).startFrame !== 'number') {
    return `timeline[${index}].time.startFrame must be number`;
  }
  if (typeof (item.time as Record<string, unknown>).durationInFrames !== 'number') {
    return `timeline[${index}].time.durationInFrames must be number`;
  }
  if (!isObject(item.spatial)) return `timeline[${index}].spatial missing`;
  if (!isObject(item.keyframes)) return `timeline[${index}].keyframes must be an object`;
  if (!isObject(item.props)) return `timeline[${index}].props must be an object`;
  return null;
}

export function validateManifest(value: unknown): ValidationResult {
  if (!isObject(value)) return { ok: false, error: 'manifest must be an object' };

  const graph = value.graph;
  if (!isObject(graph)) return { ok: false, error: 'manifest.graph must be an object' };
  if (!Array.isArray(graph.nodes)) return { ok: false, error: 'manifest.graph.nodes must be array' };
  if (!Array.isArray(graph.edges)) return { ok: false, error: 'manifest.graph.edges must be array' };

  if (!Array.isArray(value.timeline)) {
    return { ok: false, error: 'manifest.timeline must be an array' };
  }

  for (let i = 0; i < value.timeline.length; i++) {
    const err = validateTrackItem(value.timeline[i], i);
    if (err) return { ok: false, error: err };
  }

  return { ok: true, manifest: value as unknown as VideoGraphManifest };
}
```

- [ ] **Step 4: Add `updateRemotionManifest` to graphStore**

In `frontend/src/store/graphStore.ts`, locate the existing `updateNodeData` action (around line 924). After its closing brace, add:

```ts
  updateRemotionManifest: (nodeId: string, patch: Partial<VideoGraphManifest>) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const currentParams = (node.data.params ?? {}) as Record<string, unknown>;
    const currentManifest = (currentParams.manifest ?? createEmptyManifest()) as VideoGraphManifest;
    const nextManifest: VideoGraphManifest = {
      graph: patch.graph ?? currentManifest.graph,
      timeline: patch.timeline ?? currentManifest.timeline,
    };
    const validation = validateManifest(nextManifest);
    if (!validation.ok) {
      console.warn('updateRemotionManifest rejected invalid patch:', validation.error);
      return;
    }
    state.updateNodeData(nodeId, {
      params: { ...currentParams, manifest: validation.manifest },
    });
  },
```

Add the imports at the top of `graphStore.ts`:

```ts
import type { VideoGraphManifest } from '../types/video';
import { createEmptyManifest } from '../types/video';
import { validateManifest } from '../lib/video/manifestValidator';
```

Add the method to the store interface (search for `updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;` and add directly below):

```ts
  updateRemotionManifest: (nodeId: string, patch: Partial<VideoGraphManifest>) => void;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm test -- manifestValidator`
Expected: 7 PASS

Run full suite to confirm no regressions: `cd frontend && npm test`
Expected: full suite PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/video/manifestValidator.ts frontend/src/store/graphStore.ts frontend/tests/video/manifestValidator.test.ts
git commit -m "feat(remotion): manifestValidator + updateRemotionManifest graphStore action"
```

---

### Task 11: Build `TextRenderer` asset mapper

**Files:**
- Create: `frontend/src/components/video-editor/components/TextRenderer.tsx`

- [ ] **Step 1: Implement the renderer**

Create `frontend/src/components/video-editor/components/TextRenderer.tsx`:

```tsx
import { useCurrentFrame, AbsoluteFill } from 'remotion';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface TextRendererProps {
  item: TrackItem;
}

export function TextRenderer({ item }: TextRendererProps) {
  const frame = useCurrentFrame();
  // Frame inside the item's sequence is what Remotion's <Sequence> already
  // remaps for us via useCurrentFrame() — so callers pass the raw frame and
  // we interpret keyframes in the item's local timeline.
  const localFrame = frame;

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  const text = (item.props.text as string) ?? 'Hello World';
  const fontSize = (item.props.fontSize as number) ?? 64;
  const color = (item.props.color as string) ?? '#ffffff';

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <div
        style={{
          opacity,
          color,
          fontSize,
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 600,
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
```

- [ ] **Step 2: Verify build (no test this task — covered by composition smoke in Task 12)**

Run: `cd frontend && npm run build`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/video-editor/components/TextRenderer.tsx
git commit -m "feat(remotion): TextRenderer asset mapper with keyframe-driven transform"
```

---

### Task 12: Build `RemotionComposition` and mount in Player

**Files:**
- Create: `frontend/src/components/video-editor/RemotionComposition.tsx`
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx` (mount `<Player>` in the player slot)

- [ ] **Step 1: Implement the composition**

Create `frontend/src/components/video-editor/RemotionComposition.tsx`:

```tsx
import { Sequence, AbsoluteFill } from 'remotion';
import type { TrackItem, VideoGraphManifest } from '../../types/video';
import { TextRenderer } from './components/TextRenderer';

interface RemotionCompositionProps {
  manifest: VideoGraphManifest;
}

function renderItem(item: TrackItem) {
  switch (item.componentType) {
    case 'TextNode':
      return <TextRenderer item={item} />;
    // SVGInput, ImageAssetNode, VideoAssetNode, IsometricBlock, LottieNode
    // are added in Plan 2.1.b. Fall through to a labeled placeholder for now
    // so the timeline still renders and the smoke test can see them.
    default:
      return (
        <AbsoluteFill
          style={{
            display: 'grid',
            placeItems: 'center',
            color: '#ff5500',
            fontFamily: 'system-ui',
          }}
        >
          [{item.componentType} — renderer not yet implemented]
        </AbsoluteFill>
      );
  }
}

export function RemotionComposition({ manifest }: RemotionCompositionProps) {
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {manifest.timeline.map((item) => (
        <Sequence
          key={item.id}
          from={item.time.startFrame}
          durationInFrames={item.time.durationInFrames}
          layout="none"
        >
          {renderItem(item)}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
```

- [ ] **Step 2: Mount the Player in RemotionEditorView**

Edit `frontend/src/components/video-editor/RemotionEditorView.tsx`:

Add imports at the top (after the existing imports):

```tsx
import { Player } from '@remotion/player';
import { useRef } from 'react';
import type { PlayerRef } from '@remotion/player';
import { RemotionComposition } from './RemotionComposition';
import { DEFAULT_FPS } from '../../types/video';
```

Replace the player slot:

```tsx
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        {/* Player mounts here in Task 8 */}
      </div>
```

With a real Player mount. Add `const playerRef = useRef<PlayerRef>(null);` inside the component before the `if (!targetNodeId)` guard. Then change the player slot to:

```tsx
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        <Player
          ref={playerRef}
          component={RemotionComposition}
          inputProps={{ manifest }}
          durationInFrames={Math.max(
            DEFAULT_FPS * 5,
            ...manifest.timeline.map(
              (i) => i.time.startFrame + i.time.durationInFrames,
            ),
            DEFAULT_FPS,
          )}
          compositionWidth={1280}
          compositionHeight={720}
          fps={DEFAULT_FPS}
          controls
          loop
          style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
        />
      </div>
```

Also pass `playerRef` down — store it in a context or hoist for Task 13's frame sync. For now, just keep the ref local; Task 13 lifts the frame state.

- [ ] **Step 3: Manual smoke**

Open the editor for a freshly-dropped RemotionNode. The Player area should now show a black frame with a Remotion control bar (play, scrub, time). Hit play — nothing renders because the timeline is empty, that's expected.

Then, in DevTools console:

```js
const store = window.__NEBULA_GRAPH__ ?? null; // skip if not exposed
// Or via the Zustand-react devtools, manually edit node.data.params.manifest.timeline
// to inject a TextNode TrackItem and confirm "Hello World" renders at frame 0.
```

(The store-exposure step is informal; if there's no convenient hook, set state via the Zustand devtool extension.)

- [ ] **Step 4: Verify build + tests**

Run: `cd frontend && npm run build && npm test`
Expected: build exit 0, tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/RemotionComposition.tsx frontend/src/components/video-editor/RemotionEditorView.tsx
git commit -m "feat(remotion): RemotionComposition + mount Player in editor view"
```

---

### Task 13: Build `RemotionTimeline` and mount in editor view

**Files:**
- Create: `frontend/src/components/video-editor/RemotionTimeline.tsx`
- Modify: `frontend/src/components/video-editor/RemotionEditorView.tsx` (mount Timeline in the timeline slot, lift `currentFrame` state, wire bidirectional sync)

- [ ] **Step 1: Implement the Timeline wrapper**

Create `frontend/src/components/video-editor/RemotionTimeline.tsx`:

```tsx
import { useMemo } from 'react';
import {
  Timeline as XzdarcyTimeline,
  type TimelineState,
  type TimelineRow,
  type TimelineAction,
  type TimelineEffect,
} from '@xzdarcy/react-timeline-editor';
import type { VideoGraphManifest, TrackItem } from '../../types/video';
import { DEFAULT_FPS } from '../../types/video';

interface RemotionTimelineProps {
  manifest: VideoGraphManifest;
  currentFrame: number;
  onScrub: (frame: number) => void;
  timelineState: React.RefObject<TimelineState>;
}

// xzdarcy's data shape: rows of actions. Map each TrackItem to one action on
// its own row (one row per track), keyed by item id.
function manifestToEditorData(manifest: VideoGraphManifest): TimelineRow[] {
  return manifest.timeline.map((item: TrackItem) => ({
    id: item.id,
    actions: [
      {
        id: item.id,
        start: item.time.startFrame / DEFAULT_FPS,
        end: (item.time.startFrame + item.time.durationInFrames) / DEFAULT_FPS,
        effectId: item.componentType,
        flexible: true,
        movable: true,
      } as TimelineAction,
    ],
  }));
}

// One effect per componentType (purely cosmetic — xzdarcy uses effects to
// color the bars). No render hook here.
const EFFECTS: Record<string, TimelineEffect> = {
  TextNode: { id: 'TextNode', name: 'Text' },
  SVGInput: { id: 'SVGInput', name: 'SVG' },
  ImageAssetNode: { id: 'ImageAssetNode', name: 'Image' },
  VideoAssetNode: { id: 'VideoAssetNode', name: 'Video' },
  IsometricBlock: { id: 'IsometricBlock', name: '3D Block' },
  LottieNode: { id: 'LottieNode', name: 'Lottie' },
};

export function RemotionTimeline({
  manifest,
  currentFrame,
  onScrub,
  timelineState,
}: RemotionTimelineProps) {
  const editorData = useMemo(() => manifestToEditorData(manifest), [manifest]);

  return (
    <XzdarcyTimeline
      ref={timelineState}
      editorData={editorData}
      effects={EFFECTS}
      autoScroll
      onChange={() => {
        // Mutation routing (drag-to-trim, drag-to-move) lands in Plan 2.1.b.
        // For Phase 2.1.a the timeline is read-only — Player drives playback.
      }}
      onCursorDragEnd={(time: number) => onScrub(Math.round(time * DEFAULT_FPS))}
      style={{ height: '100%' }}
    />
  );
}
```

- [ ] **Step 2: Lift `currentFrame` state and wire the timeline mount**

Edit `frontend/src/components/video-editor/RemotionEditorView.tsx`:

Add imports:

```tsx
import { useEffect, useState } from 'react';
import type { TimelineState } from '@xzdarcy/react-timeline-editor';
import { RemotionTimeline } from './RemotionTimeline';
```

Add state inside the component (next to `playerRef`):

```tsx
  const [currentFrame, setCurrentFrame] = useState(0);
  const timelineStateRef = useRef<TimelineState>(null);
```

Wire Player → frame state via `frameUpdate`:

Replace the `<Player ... />` mount with:

```tsx
        <Player
          ref={playerRef}
          component={RemotionComposition}
          inputProps={{ manifest }}
          durationInFrames={Math.max(
            DEFAULT_FPS * 5,
            ...manifest.timeline.map(
              (i) => i.time.startFrame + i.time.durationInFrames,
            ),
            DEFAULT_FPS,
          )}
          compositionWidth={1280}
          compositionHeight={720}
          fps={DEFAULT_FPS}
          controls
          loop
          style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
          acknowledgeRemotionLicense
        />
```

Right below the player mount, add a useEffect that polls Player's frame and updates state:

```tsx
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const handler = () => setCurrentFrame(player.getCurrentFrame());
    player.addEventListener('frameupdate', handler);
    return () => player.removeEventListener('frameupdate', handler);
  }, [playerRef.current]);
```

Replace the timeline slot:

```tsx
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        <RemotionTimeline
          manifest={manifest}
          currentFrame={currentFrame}
          onScrub={(frame) => playerRef.current?.seekTo(frame)}
          timelineState={timelineStateRef}
        />
      </div>
```

- [ ] **Step 3: Manual smoke — bidirectional sync**

Reload the editor. Drop a RemotionNode, open editor. Inject a TextNode TrackItem via DevTools (Zustand store) with `time: { startFrame: 0, durationInFrames: 60 }`.

Verify:
- The text appears in the Player at frame 0.
- Hit play in the Player — the Timeline cursor follows the playhead.
- Drag the Timeline cursor — the Player seeks to that frame.

- [ ] **Step 4: Verify build + tests**

Run: `cd frontend && npm run build && npm test`
Expected: build exit 0, tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/video-editor/RemotionTimeline.tsx frontend/src/components/video-editor/RemotionEditorView.tsx
git commit -m "feat(remotion): RemotionTimeline + bidirectional frame sync with Player"
```

---

### Phase E — Smoke + polish

### Task 14: End-to-end smoke test + Slava polish pass

**Files:**
- Create: `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`
- Modify: `frontend/src/styles/remotion-editor.css` (round 2 of styling — bar colors, header polish)

This project uses Puppeteer (NOT Playwright). The existing smoke pattern is `scripts/puppeteer-driver/smoke-test.mjs` — mirror its shape exactly. Screenshots go to `output/puppeteer-driver/remotion-foundation-smoke/`. Dev server must be running at `http://localhost:5180` and backend at `:8000` before invocation.

- [ ] **Step 1: Write the smoke driver**

Create `scripts/puppeteer-driver/remotion-foundation-smoke.mjs`:

```js
// Smoke test for the Phase 2.1.a RemotionNode foundation.
//
// Verifies: drop RemotionNode → open editor → Player + Timeline slots
// render → close → reopen, with state persisting on the node.
//
// Run with dev server (5180) + backend (8000) up:
//   node scripts/puppeteer-driver/remotion-foundation-smoke.mjs
//
// Use --headless true to skip the visible window.

import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const URL = 'http://localhost:5180';
const VIEWPORT = { width: 1920, height: 1080 };
const OUT_DIR = join(REPO_ROOT, 'output', 'puppeteer-driver', 'remotion-foundation-smoke');

const args = parseArgs(process.argv.slice(2));
const HEADLESS = args.headless === 'true' || args.headless === true;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  log('start', `out → ${OUT_DIR} (headless=${HEADLESS})`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('[smoke]') || msg.type() === 'error' || msg.type() === 'warn') {
        log('page', `[${msg.type()}] ${txt}`);
      }
    });
    page.on('pageerror', (err) => log('pageerror', err.message));

    // Step 0 — load canvas
    log('nav', URL);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chat-panel', { timeout: 10000 });
    await page.waitForFunction(() => !!window.__nebulaGraphStore, { timeout: 5000 });
    await page.evaluate(async () => {
      try { await fetch('http://localhost:8000/api/graph', { method: 'DELETE' }); }
      catch (e) { console.warn('[smoke] backend clear failed', String(e)); }
      window.__nebulaGraphStore.getState().clearGraph();
    });
    await sleep(800);
    await page.screenshot({ path: join(OUT_DIR, 'step0-canvas-clean.png') });

    // Step 1 — programmatically add a remotion-node via the store
    // (Library DnD is harder to drive headless; the store API is the
    // canonical seam.)
    log('test-1', 'addNode remotion-node');
    await page.evaluate(async () => {
      await window.__nebulaGraphStore.getState().addNode('remotion-node', { x: 400, y: 200 });
    });
    await sleep(1200);
    const nodesAfterAdd = await page.evaluate(() =>
      window.__nebulaGraphStore.getState().nodes.map((n) => ({ id: n.id, def: n.data.definitionId })),
    );
    log('test-1', `nodes after add: ${JSON.stringify(nodesAfterAdd)}`);
    await page.screenshot({ path: join(OUT_DIR, 'step1-card-on-canvas.png') });
    if (!nodesAfterAdd.find((n) => n.def === 'remotion-node')) {
      throw new Error('remotion-node not present in store after addNode');
    }

    // Step 2 — confirm card visible, select it, open editor
    await page.waitForSelector('.remotion-node', { timeout: 5000 });
    await page.click('.remotion-node');
    await sleep(200);
    await page.screenshot({ path: join(OUT_DIR, 'step2-selected.png') });
    await page.waitForSelector('.remotion-node__open', { timeout: 2000 });
    await page.click('.remotion-node__open');

    // Step 3 — editor mounts
    await page.waitForSelector('.remotion-editor-view', { timeout: 3000 });
    await page.waitForSelector('[data-testid="remotion-player-slot"]', { timeout: 2000 });
    await page.waitForSelector('[data-testid="remotion-timeline-slot"]', { timeout: 2000 });
    await page.screenshot({ path: join(OUT_DIR, 'step3-editor-open.png') });

    // Step 4 — close editor, back to canvas
    await page.click('.remotion-editor-view__back');
    await page.waitForSelector('.react-flow', { timeout: 3000 });
    await page.screenshot({ path: join(OUT_DIR, 'step4-back-to-canvas.png') });

    // Step 5 — reopen, confirm state persists
    await page.click('.remotion-node');
    await page.click('.remotion-node__open');
    await page.waitForSelector('.remotion-editor-view', { timeout: 3000 });
    await page.screenshot({ path: join(OUT_DIR, 'step5-reopened.png') });

    log('done', 'all 5 steps passed');
  } finally {
    await browser.close();
  }
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Expose `addNode` on the store if not already (window-level access)**

The smoke driver relies on `window.__nebulaGraphStore.getState().addNode('remotion-node', position)`. Confirm this method exists on the store. If `addNode` already exists for other definitions (Phase 1's smoke depends on it), no change needed. If it doesn't, add a `addNode(definitionId, position)` action to `graphStore.ts` that mirrors the React Flow drop behavior.

Run: `grep -n "addNode\b" frontend/src/store/graphStore.ts`
Expected: at least one match. If zero matches, this is a separate sub-task — add the store action before running the smoke.

- [ ] **Step 3: Run the smoke**

With dev server + backend up:

Run: `node scripts/puppeteer-driver/remotion-foundation-smoke.mjs`
Expected: 6 screenshots in `output/puppeteer-driver/remotion-foundation-smoke/` (step0 through step5). The script logs `[done] all 5 steps passed` on success. Any failure: fix the underlying bug — do NOT weaken assertions.

- [ ] **Step 4: Visual polish — refine `remotion-editor.css`**

Open the screenshots. Apply targeted CSS fixes for anything that reads as unpolished. Common Phase F findings:
- Header spacing too tight → bump `gap` to 20px
- Player aspect ratio drift → confirm `aspectRatio` set on the Player container
- Timeline row contrast too low → adjust `var(--sr-edge-soft)` border thickness
- "no layers yet" empty state needs visual treatment in the timeline slot

The exact fixes depend on what you see. Do NOT add inline styles — every change goes in `remotion-editor.css`. Keep all rules scoped under `body.app-slava-restraint`.

- [ ] **Step 5: Final lint + screenshot check**

Run: `cd frontend && npm run lint && npm test && npm run build`
Expected: lint exit 0, tests PASS, build exit 0.

Re-run the smoke:
Run: `node scripts/puppeteer-driver/remotion-foundation-smoke.mjs`
Expected: 6 screenshots produced, exits 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/puppeteer-driver/remotion-foundation-smoke.mjs frontend/src/styles/remotion-editor.css
git commit -m "test(remotion): end-to-end foundation smoke + Slava polish pass"
```

---

## Verification

After Task 14, manually verify the full flow once more in a fresh browser session:

1. Reload `localhost:5180`
2. Drop a Remotion Composition node from the library
3. Wire something into its `sources` port (any node with any output — Phase 2.1.a doesn't read the inputs, just confirms wiring works)
4. Wire its `video` output into a Preview node (downstream consumer test)
5. Select the RemotionNode → click Open Editor
6. Confirm editor mounts: header shows id, Player shows black frame, Timeline shows empty rows
7. Close editor — back on canvas, RemotionNode card still shows "0 layers · 0f"
8. Re-open editor — state preserved
9. Run the graph (Cmd+R or Run button) — the RemotionNode's handler should accept the empty manifest and return it (Phase 1's `Preview` node downstream will show "no preview available" or similar — that's fine for this phase)

If any of those steps fail, debug before declaring the plan complete. Do not paper over by relaxing the assertion.

---

## What Plan 2.1.b will pick up

For the agentic worker that takes this plan to completion: when you're done, the next plan is `2026-05-22-remotion-node-mirroring-and-mappers.md` (or similar dated for that day). It will:

- Add `SVGRenderer`, `ImageRenderer`, `VideoRenderer` (Phase 2.1's remaining asset mappers — IsometricBlock + LottieNode stay deferred to Phase 2.2)
- Implement Rule A: when a TrackItem is added in the editor, create a corresponding canvas AssetNode
- Implement Rule B: when a canvas node feeding the RemotionNode's `sources` is deleted, prune the matching TrackItem from `manifest.timeline`
- Add the in-editor UI to create/delete TrackItems (currently only DevTools can add them)
- Wire playhead-relative duplication (Cmd+D — duplicates selected item at the current playhead frame, with directional padding to avoid ghosting per spec §3)
- Add the source-data flow: when an upstream Video/Image node finishes rendering, the RemotionNode reads its output URL into the corresponding TrackItem's `props.src`
