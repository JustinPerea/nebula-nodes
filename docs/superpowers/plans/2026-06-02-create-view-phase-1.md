# Create View — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundational slice of the Higgsfield-style **Create** view — a full-screen surface with a bottom-floating composer (prompt + full-catalog model picker + dynamic param pills + Generate) where each Generate authors a real `text-input → model` node cluster onto the canvas, runs only that cluster via the existing engine, and shows the latest result on the stage.

**Architecture:** A new `viewMode: 'create'` full-screen view (4th studio) mounted by `App.tsx`. Generation is a **graph-builder**: a new `graphStore.authorGenerationCluster()` creates real nodes/edges locally (same shape as the existing local-add path), then `graphStore.executeCluster()` POSTs only that cluster to `/api/execute` (reusing `lib/api.executeGraph`). The WebSocket updates node outputs exactly as today; the view reads results from the authored model node. No execution-engine, handler, or node-definition changes.

**Tech Stack:** React 19, Zustand, `@xyflow/react`, Vite, Vitest (frontend tests), lucide-react icons. Styling = Slava Restraint CSS tokens (`--sr-*`), all selectors scoped under `body.app-slava-restraint`.

**Spec:** `docs/superpowers/specs/2026-06-02-higgsfield-create-view-design.md` (Phases P2/P3 — gallery/History, reference attach, variations, presets — are separate plans authored after P1 lands).

---

## File Structure

**Create (frontend):**
- `frontend/src/lib/createModels.ts` — model-catalog filtering for the picker (`CREATE_MODEL_CATEGORIES`, `FEATURED_MODEL_IDS`, `getCreateModels`, `getFeaturedModels`, `searchModels`).
- `frontend/src/lib/createParams.ts` — composer param derivation (`matchesVisibleWhen`, `deriveVisibleParams`).
- `frontend/src/components/create-studio/OutputRenderer.tsx` — render a node's outputs by type (Image/Video/Audio/Mesh/SVG/Text).
- `frontend/src/components/create-studio/ModelPicker.tsx` — search popover (Featured / All-by-category).
- `frontend/src/components/create-studio/ParamPills.tsx` — compact param controls derived from the selected model def.
- `frontend/src/components/create-studio/CreateComposer.tsx` — the floating composer bar.
- `frontend/src/components/create-studio/CreateView.tsx` — full-screen host + generate orchestration + latest-result stage.
- `frontend/src/styles/create-studio.css` — Slava-scoped styling.

**Modify (frontend):**
- `frontend/src/types/index.ts` — add `CreateOriginTag`, `GenerationRequest`; add optional `_createOrigin` to `NodeData`.
- `frontend/src/store/uiStore.ts` — add `'create'` to `viewMode`; `createSessionId` field; `enterCreateView` / `exitCreateView` actions.
- `frontend/src/store/graphStore.ts` — add `executeCluster`, `authorGenerationCluster`, and a module-level `buildDefaultParams` helper.
- `frontend/src/App.tsx` — mount `<CreateView />` when `viewMode === 'create'`.
- `frontend/src/components/panels/PanelLaunchers.tsx` — add a "Create" launcher button.

**Tests (frontend):**
- `frontend/tests/store/uiStore.test.ts` — extend (Task 2).
- `frontend/tests/store/createCluster.test.ts` — new (Tasks 3–4).
- `frontend/tests/lib/createModels.test.ts` — new (Task 5).
- `frontend/tests/lib/createParams.test.ts` — new (Task 6).

> No new `NODE_DEFINITIONS` / `node_definitions.json` entries → `scripts/check-node-contracts.mjs` is unaffected. Gates: `npx tsc --noEmit`, `npx vitest run`, `npm run build`.

---

## Task 1: Shared types

**Files:**
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Add the Create types and extend `NodeData`**

In `frontend/src/types/index.ts`, add these interfaces near the other node types (after `NodeData`, around line 274):

```typescript
export interface CreateOriginTag {
  sessionId: string;
  genId: string;
  ts: number;
  prompt: string;
}

export interface GenerationRequest {
  definitionId: string;
  prompt: string;
  params: Record<string, unknown>;
  refPaths: string[];
  quantity: number;
  sessionId: string;
  genId: string;
  layoutOrigin: { x: number; y: number };
}
```

Then add the optional tag field inside the existing `NodeData` interface (it already has an index signature, so this is documentation + type safety). Add this line after `spawnedThisSession?: boolean;`:

```typescript
  _createOrigin?: CreateOriginTag;
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/index.ts
git commit -m "feat(create): add CreateOriginTag + GenerationRequest types"
```

---

## Task 2: uiStore — `create` view mode + session + enter/exit

**Files:**
- Modify: `frontend/src/store/uiStore.ts`
- Test: `frontend/tests/store/uiStore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/store/uiStore.test.ts` (inside the existing `describe('uiStore', ...)` block):

```typescript
  it('enterCreateView sets create mode and mints a session id', () => {
    useUIStore.setState({ viewMode: 'canvas', createSessionId: null });
    useUIStore.getState().enterCreateView();
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('create');
    expect(typeof state.createSessionId).toBe('string');
    expect((state.createSessionId as string).length).toBeGreaterThan(0);
  });

  it('exitCreateView returns to canvas and clears the session id', () => {
    useUIStore.getState().enterCreateView();
    useUIStore.getState().exitCreateView();
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('canvas');
    expect(state.createSessionId).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/store/uiStore.test.ts`
Expected: FAIL — `enterCreateView is not a function` (and `createSessionId` undefined).

- [ ] **Step 3: Implement — add the import, type union, field, and actions**

In `frontend/src/store/uiStore.ts`:

1. Add the uuid import at the top (after the existing imports, lines 1–3):

```typescript
import { v4 as uuidv4 } from 'uuid';
```

2. Update the `viewMode` union (line 61) to include `'create'`:

```typescript
  viewMode: 'canvas' | 'editor' | 'remotion-editor' | 'cinema-editor' | 'character-editor' | 'moodboard-editor' | 'create';
```

3. Add the field declaration to the `UIState` interface (near `moodboardEditorId`, ~line 75):

```typescript
  // Create view — Higgsfield-style graph-builder surface. App.tsx mounts CreateView
  // when viewMode === 'create'. createSessionId tags nodes authored this session.
  createSessionId: string | null;
```

4. Add the action signatures to the `UIState` interface (near `enterMoodboardEditor`, ~line 127):

```typescript
  enterCreateView: () => void;
  exitCreateView: () => void;
```

5. Add the field default in the `create()` call (near `moodboardEditorId: null`, ~line 170):

```typescript
  createSessionId: null,
```

6. Add the action implementations in the `create()` call (near `enterMoodboardEditor`, ~line 286):

```typescript
  enterCreateView: () => {
    set({ viewMode: 'create', createSessionId: uuidv4() });
  },
  exitCreateView: () => {
    set({ viewMode: 'canvas', createSessionId: null });
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/store/uiStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/uiStore.ts frontend/tests/store/uiStore.test.ts
git commit -m "feat(create): add create viewMode + enter/exit actions to uiStore"
```

---

## Task 3: graphStore — `executeCluster`

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/store/createCluster.test.ts`

`executeCluster(nodeIds)` serializes ONLY the given nodes and the edges among them, then POSTs to `/api/execute` via the existing `apiExecuteGraph`. This is the scoped-execution primitive for a generation.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/store/createCluster.test.ts`:

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const executeGraphMock = vi.fn().mockResolvedValue({ status: 'started' });
const executeNodeMock = vi.fn().mockResolvedValue({ status: 'started' });
vi.mock('../../src/lib/api', () => ({
  executeGraph: (...args: unknown[]) => executeGraphMock(...args),
  executeNode: (...args: unknown[]) => executeNodeMock(...args),
}));

import { useGraphStore } from '../../src/store/graphStore';

function node(id: string, definitionId: string): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    data: { label: id, definitionId, params: {}, state: 'idle', outputs: {} },
  };
}

function resetStore() {
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], isExecuting: false });
}

beforeEach(() => {
  executeGraphMock.mockClear();
  resetStore();
});

describe('executeCluster', () => {
  it('posts only the cluster nodes and their internal edges', async () => {
    const t = node('t1', 'text-input');
    const m = node('m1', 'nano-banana');
    const unrelated = node('u1', 'flux-schnell');
    const clusterEdge: Edge = {
      id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge',
    };
    useGraphStore.setState({ nodes: [t, m, unrelated], edges: [clusterEdge] });

    await useGraphStore.getState().executeCluster(['t1', 'm1']);

    expect(executeGraphMock).toHaveBeenCalledTimes(1);
    const [postedNodes, postedEdges] = executeGraphMock.mock.calls[0];
    expect(postedNodes.map((n: { id: string }) => n.id).sort()).toEqual(['m1', 't1']);
    expect(postedEdges.map((e: { id: string }) => e.id)).toEqual(['e1']);
    expect(useGraphStore.getState().isExecuting).toBe(true);
  });

  it('is a no-op when already executing', async () => {
    useGraphStore.setState({ nodes: [node('m1', 'nano-banana')], isExecuting: true });
    await useGraphStore.getState().executeCluster(['m1']);
    expect(executeGraphMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: FAIL — `executeCluster is not a function`.

- [ ] **Step 3: Implement `executeCluster`**

In `frontend/src/store/graphStore.ts`, add the signature to the `GraphState` interface (next to `executeNode`, ~line 313):

```typescript
  executeCluster: (nodeIds: string[]) => Promise<void>;
```

Add the implementation immediately after the `executeNode` action (after line 1843):

```typescript
  executeCluster: async (nodeIds) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    const idSet = new Set(nodeIds);
    const clusterNodes = nodes.filter((n) => idSet.has(n.id));
    if (clusterNodes.length === 0) return;
    const clusterEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    resetExecution();
    set({ isExecuting: true });
    const graphNodes = clusterNodes.map((n) => ({
      id: n.id,
      definitionId: n.data.definitionId,
      params: paramsForBackend(n.data.definitionId, n.data.params as Record<string, unknown>),
      outputs: {},
    }));
    const graphEdges = clusterEdges.map((e) => ({
      id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
    }));
    try {
      const result = await apiExecuteGraph(graphNodes, graphEdges);
      if (result.status === 'validation_error') {
        set((state) => ({
          nodes: markNodesErrored(state.nodes, idSet, 'Validation failed before generation. Check required inputs and API keys.'),
          isExecuting: false,
        }));
      }
    } catch (err) {
      console.error('Failed to start generation:', err);
      set((state) => ({
        nodes: markNodesErrored(state.nodes, idSet, err instanceof Error ? err.message : 'Failed to start generation.'),
        isExecuting: false,
      }));
    }
  },
```

> `apiExecuteGraph`, `paramsForBackend`, `markNodesErrored`, and `resetExecution` are all already in scope in this file (used by `executeGraph`). No new imports needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: PASS (both `executeCluster` tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/store/createCluster.test.ts
git commit -m "feat(create): add executeCluster scoped-execution action"
```

---

## Task 4: graphStore — `authorGenerationCluster` + `buildDefaultParams`

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Test: `frontend/tests/store/createCluster.test.ts` (extend)

`authorGenerationCluster(request)` creates the real nodes/edges for one generation: a `text-input` (if the model has a Text input port and the prompt is non-empty), one `image-input` per ref path (if the model has an Image input port), and `quantity` model nodes wired from those inputs. Returns `{ modelNodeIds, allNodeIds }`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/store/createCluster.test.ts`:

```typescript
import type { GenerationRequest } from '../../src/types';

function baseRequest(overrides: Partial<GenerationRequest>): GenerationRequest {
  return {
    definitionId: 'nano-banana',
    prompt: 'a calico cat',
    params: { aspect_ratio: '16:9' },
    refPaths: [],
    quantity: 1,
    sessionId: 's1',
    genId: 'g1',
    layoutOrigin: { x: 0, y: 0 },
    ...overrides,
  };
}

describe('authorGenerationCluster', () => {
  it('creates a text-input + model node wired prompt->model with merged params and origin tag', () => {
    const { modelNodeIds, allNodeIds } = useGraphStore.getState().authorGenerationCluster(baseRequest({}));
    const { nodes, edges } = useGraphStore.getState();

    expect(allNodeIds).toHaveLength(2);
    expect(modelNodeIds).toHaveLength(1);

    const textNode = nodes.find((n) => n.data.definitionId === 'text-input');
    const modelNode = nodes.find((n) => n.id === modelNodeIds[0]);
    expect(textNode?.data.params.value).toBe('a calico cat');
    // default model param preserved, composer param applied
    expect(modelNode?.data.params.model).toBe('gemini-3.1-flash-image-preview');
    expect(modelNode?.data.params.aspect_ratio).toBe('16:9');
    expect((modelNode?.data._createOrigin as { sessionId: string }).sessionId).toBe('s1');

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: textNode!.id, sourceHandle: 'text', target: modelNode!.id, targetHandle: 'prompt',
    });
  });

  it('omits the text-input when the prompt is empty', () => {
    const { allNodeIds } = useGraphStore.getState().authorGenerationCluster(baseRequest({ prompt: '   ' }));
    const { nodes } = useGraphStore.getState();
    expect(allNodeIds).toHaveLength(1);
    expect(nodes.some((n) => n.data.definitionId === 'text-input')).toBe(false);
  });

  it('creates an image-input wired to the model image port for each ref path', () => {
    useGraphStore.getState().authorGenerationCluster(
      baseRequest({ refPaths: ['/api/outputs/a.png'] }),
    );
    const { nodes, edges } = useGraphStore.getState();
    const imgNode = nodes.find((n) => n.data.definitionId === 'image-input');
    expect(imgNode?.data.params.filePath).toBe('/api/outputs/a.png');
    // nano-banana's image input port id is 'images'
    expect(edges.some((e) => e.source === imgNode!.id && e.targetHandle === 'images')).toBe(true);
  });

  it('fans out quantity>1 into multiple model nodes sharing one text input', () => {
    const { modelNodeIds } = useGraphStore.getState().authorGenerationCluster(
      baseRequest({ quantity: 3 }),
    );
    const { nodes, edges } = useGraphStore.getState();
    expect(modelNodeIds).toHaveLength(3);
    expect(nodes.filter((n) => n.data.definitionId === 'text-input')).toHaveLength(1);
    expect(edges).toHaveLength(3); // one text->model edge per variation
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: FAIL — `authorGenerationCluster is not a function`.

- [ ] **Step 3: Implement the helper and action**

In `frontend/src/store/graphStore.ts`, add a module-level helper near `paramsForBackend` (top of file, after line 42):

```typescript
function buildDefaultParams(def: ModelNodeDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  for (const p of sources) {
    if (p.default !== undefined) defaults[p.key] = p.default;
  }
  return defaults;
}

function defHasParam(def: ModelNodeDefinition, key: string): boolean {
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  return sources.some((p) => p.key === key);
}
```

> `ModelNodeDefinition` is the type of `NODE_DEFINITIONS` values. If it is not already imported in this file, add it to the existing `import type { ... } from '../types';` line.

Add the signature to the `GraphState` interface (next to `executeCluster`):

```typescript
  authorGenerationCluster: (request: GenerationRequest) => { modelNodeIds: string[]; allNodeIds: string[] };
```

Add `GenerationRequest`, `CreateOriginTag` to the type imports from `'../types'`.

Add the implementation after `executeCluster`:

```typescript
  authorGenerationCluster: (request) => {
    const def = NODE_DEFINITIONS[request.definitionId];
    if (!def) return { modelNodeIds: [], allNodeIds: [] };
    pushUndo(set, get);

    const origin: CreateOriginTag = {
      sessionId: request.sessionId,
      genId: request.genId,
      ts: Date.now(),
      prompt: request.prompt,
    };
    const makeNode = (
      definitionId: string,
      params: Record<string, unknown>,
      position: { x: number; y: number },
    ): Node<NodeData> => ({
      id: uuidv4(),
      type: 'model-node',
      position,
      data: {
        label: NODE_DEFINITIONS[definitionId]?.displayName ?? definitionId,
        definitionId,
        params,
        state: 'idle',
        outputs: {},
        _createOrigin: origin,
      },
    });
    const makeEdge = (
      source: string, sourceHandle: string, target: string, targetHandle: string, dataType: string,
    ): Edge => ({
      id: uuidv4(), source, sourceHandle, target, targetHandle, type: 'typed-edge', data: { dataType },
    });

    const created: Node<NodeData>[] = [];
    const newEdges: Edge[] = [];
    const allNodeIds: string[] = [];
    const modelNodeIds: string[] = [];

    const { x: baseX, y: baseY } = request.layoutOrigin;

    const textPort = def.inputPorts.find((p) => p.dataType === 'Text');
    let textNodeId: string | null = null;
    if (textPort && request.prompt.trim()) {
      const textNode = makeNode('text-input', { value: request.prompt }, { x: baseX, y: baseY });
      textNodeId = textNode.id;
      created.push(textNode);
      allNodeIds.push(textNode.id);
    }

    const imagePort = def.inputPorts.find((p) => p.dataType === 'Image');
    const imageNodeIds: string[] = [];
    if (imagePort) {
      request.refPaths.forEach((path, i) => {
        const imgNode = makeNode('image-input', { filePath: path }, { x: baseX, y: baseY + 140 + i * 120 });
        imageNodeIds.push(imgNode.id);
        created.push(imgNode);
        allNodeIds.push(imgNode.id);
      });
    }

    const count = Math.max(1, request.quantity);
    const hasSeed = defHasParam(def, 'seed');
    for (let v = 0; v < count; v++) {
      const params = { ...buildDefaultParams(def), ...request.params };
      if (count > 1 && hasSeed) {
        const baseSeed = typeof request.params.seed === 'number' ? request.params.seed : 0;
        params.seed = baseSeed + v;
      }
      const modelNode = makeNode(def.id, params, { x: baseX + 360, y: baseY + v * 220 });
      modelNodeIds.push(modelNode.id);
      created.push(modelNode);
      allNodeIds.push(modelNode.id);
      // Source handle = the text-input node's OUTPUT port id ('text'); target handle =
      // the model's Text INPUT port id (e.g. 'prompt' for nano-banana), resolved above.
      if (textNodeId) newEdges.push(makeEdge(textNodeId, 'text', modelNode.id, textPort!.id, 'Text'));
      imageNodeIds.forEach((imgId) =>
        newEdges.push(makeEdge(imgId, 'image', modelNode.id, imagePort!.id, 'Image')),
      );
    }

    set((state) => ({ nodes: [...state.nodes, ...created], edges: [...state.edges, ...newEdges] }));
    return { modelNodeIds, allNodeIds };
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run tests/store/createCluster.test.ts`
Expected: PASS (all `executeCluster` + `authorGenerationCluster` tests).

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/store/createCluster.test.ts
git commit -m "feat(create): add authorGenerationCluster graph-builder action"
```

---

## Task 5: `lib/createModels.ts` — model catalog for the picker

**Files:**
- Create: `frontend/src/lib/createModels.ts`
- Test: `frontend/tests/lib/createModels.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/createModels.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  CREATE_MODEL_CATEGORIES, getCreateModels, getFeaturedModels, searchModels,
} from '../../src/lib/createModels';

describe('createModels', () => {
  it('returns only model-category nodes and excludes utility/universal/cinematic', () => {
    const models = getCreateModels();
    expect(models.length).toBeGreaterThan(20);
    expect(models.every((m) => CREATE_MODEL_CATEGORIES.includes(m.category))).toBe(true);
    expect(models.some((m) => m.id === 'nano-banana')).toBe(true);
    expect(models.some((m) => m.id === 'text-input')).toBe(false);
    expect(models.some((m) => m.id === 'cinema-scene')).toBe(false);
  });

  it('featured returns only ids that exist, in declared order', () => {
    const featured = getFeaturedModels();
    expect(featured.some((m) => m.id === 'nano-banana')).toBe(true);
    // every featured model is a real model node
    const allIds = new Set(getCreateModels().map((m) => m.id));
    expect(featured.every((m) => allIds.has(m.id))).toBe(true);
  });

  it('search matches display name, provider, and category (case-insensitive)', () => {
    expect(searchModels('nano').some((m) => m.id === 'nano-banana')).toBe(true);
    expect(searchModels('VIDEO').every((m) => m.category === 'video-gen')).toBe(true);
    expect(searchModels('')).toEqual(getCreateModels());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/createModels.test.ts`
Expected: FAIL — cannot find module `createModels`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/createModels.ts`:

```typescript
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeCategory } from '../types';

/** Categories the Create picker exposes (prompt/input -> generation). P1: static nodes only. */
export const CREATE_MODEL_CATEGORIES: NodeCategory[] = [
  'image-gen', 'video-gen', 'audio-gen', '3d-gen', 'text-gen',
];

/** Curated shortlist shown under "Featured". Unknown ids are silently dropped. */
export const FEATURED_MODEL_IDS: string[] = [
  'nano-banana', 'flux-1-1-ultra', 'imagen-4-generate', 'gpt-image-1-generate',
  'veo-3', 'kling-v2-1', 'sora-2', 'claude-chat', 'elevenlabs-tts', 'meshy-text-to-3d',
];

export function getCreateModels(): ModelNodeDefinition[] {
  return Object.values(NODE_DEFINITIONS).filter((d) =>
    CREATE_MODEL_CATEGORIES.includes(d.category),
  );
}

export function getFeaturedModels(): ModelNodeDefinition[] {
  return FEATURED_MODEL_IDS
    .map((id) => NODE_DEFINITIONS[id])
    .filter((d): d is ModelNodeDefinition => Boolean(d) && CREATE_MODEL_CATEGORIES.includes(d.category));
}

export function searchModels(query: string): ModelNodeDefinition[] {
  const q = query.trim().toLowerCase();
  const all = getCreateModels();
  if (!q) return all;
  return all.filter((d) =>
    d.displayName.toLowerCase().includes(q) ||
    String(d.apiProvider).toLowerCase().includes(q) ||
    d.category.toLowerCase().includes(q),
  );
}
```

> If `NodeCategory` is not exported from `../types`, use `ModelNodeDefinition['category']` as the array element type instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/lib/createModels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/createModels.ts frontend/tests/lib/createModels.test.ts
git commit -m "feat(create): add createModels catalog helpers for the picker"
```

---

## Task 6: `lib/createParams.ts` — visible-param derivation

**Files:**
- Create: `frontend/src/lib/createParams.ts`
- Test: `frontend/tests/lib/createParams.test.ts`

The composer shows a model's params as pills. This module derives which params (and which enum options) are visible given the current param values, honoring `hidden` and `visibleWhen`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/lib/createParams.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { matchesVisibleWhen, deriveVisibleParams } from '../../src/lib/createParams';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';

describe('matchesVisibleWhen', () => {
  it('is visible when undefined', () => {
    expect(matchesVisibleWhen(undefined, {})).toBe(true);
  });
  it('matches when every key value is in its allow-list', () => {
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'a' })).toBe(true);
    expect(matchesVisibleWhen({ model: ['a', 'b'] }, { model: 'c' })).toBe(false);
  });
});

describe('deriveVisibleParams', () => {
  it('drops hidden params and applies visibleWhen for nano-banana imageSize', () => {
    const def = NODE_DEFINITIONS['nano-banana'];
    // imageSize is only visible for the two flash/pro models
    const withFlash = deriveVisibleParams(def, { model: 'gemini-3.1-flash-image-preview' });
    expect(withFlash.some((p) => p.key === 'imageSize')).toBe(true);

    const withLegacy = deriveVisibleParams(def, { model: 'gemini-2.5-flash-image' });
    expect(withLegacy.some((p) => p.key === 'imageSize')).toBe(false);
    // aspect_ratio is always visible
    expect(withLegacy.some((p) => p.key === 'aspect_ratio')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/createParams.test.ts`
Expected: FAIL — cannot find module `createParams`.

- [ ] **Step 3: Implement**

Create `frontend/src/lib/createParams.ts`:

```typescript
import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';

export function matchesVisibleWhen(
  visibleWhen: Record<string, (string | number | boolean)[]> | undefined,
  params: Record<string, unknown>,
): boolean {
  if (!visibleWhen) return true;
  return Object.entries(visibleWhen).every(([key, allowed]) =>
    allowed.includes(params[key] as string | number | boolean),
  );
}

/** Params the composer should render as pills for the current values. */
export function deriveVisibleParams(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
): ParamDefinition[] {
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  return sources
    .filter((p) => !p.hidden)
    .filter((p) => matchesVisibleWhen(p.visibleWhen, params))
    .map((p) => ({
      ...p,
      options: p.options?.filter((o: ParamOption) => matchesVisibleWhen(o.visibleWhen, params)),
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run tests/lib/createParams.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/createParams.ts frontend/tests/lib/createParams.test.ts
git commit -m "feat(create): add createParams visible-param derivation"
```

---

## Task 7: `OutputRenderer.tsx`

**Files:**
- Create: `frontend/src/components/create-studio/OutputRenderer.tsx`

Renders a node's `outputs` by data type. Reused by the stage in P1 and the gallery in P2.

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/create-studio/OutputRenderer.tsx`:

```tsx
import type { PortValue, NodeState } from '../../types';

function urlOf(v: PortValue['value']): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'url' in (v as Record<string, unknown>)) {
    return (v as { url: string }).url;
  }
  return null;
}

function findByType(outputs: Record<string, PortValue>, type: PortValue['type']): PortValue | undefined {
  return Object.values(outputs).find((o) => o.type === type && o.value);
}

export function OutputRenderer({
  outputs,
  state,
}: {
  outputs: Record<string, PortValue>;
  state: NodeState;
}) {
  if (state === 'queued' || state === 'executing') {
    return (
      <div className="create-output create-output--loading" role="status" aria-live="polite">
        <span className="create-output__spinner" aria-hidden="true" />
        <span className="create-output__loading-label">Generating…</span>
      </div>
    );
  }
  if (state === 'error') {
    return <div className="create-output create-output--error">Generation failed</div>;
  }

  const video = findByType(outputs, 'Video');
  const image = findByType(outputs, 'Image') ?? findByType(outputs, 'SVG');
  const mesh = findByType(outputs, 'Mesh');
  const audio = findByType(outputs, 'Audio');
  const text = findByType(outputs, 'Text');

  if (video) return <video className="create-output__media" src={urlOf(video.value) ?? ''} controls loop playsInline />;
  if (image) return <img className="create-output__media" src={urlOf(image.value) ?? ''} alt="Generated output" />;
  if (mesh) {
    return (
      // @ts-expect-error model-viewer is a custom element (see types/model-viewer.d.ts)
      <model-viewer class="create-output__media" src={urlOf(mesh.value) ?? ''} camera-controls auto-rotate />
    );
  }
  if (audio) return <audio className="create-output__audio" src={urlOf(audio.value) ?? ''} controls />;
  if (text) return <div className="create-output__text">{String(text.value)}</div>;

  return <div className="create-output create-output--empty" aria-hidden="true" />;
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/OutputRenderer.tsx
git commit -m "feat(create): add OutputRenderer for typed node outputs"
```

---

## Task 8: `ModelPicker.tsx`

**Files:**
- Create: `frontend/src/components/create-studio/ModelPicker.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/create-studio/ModelPicker.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Search, Check } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { getCreateModels, getFeaturedModels, searchModels } from '../../lib/createModels';

interface ModelPickerProps {
  value: string | null;
  onSelect: (definitionId: string) => void;
  onClose: () => void;
}

export function ModelPicker({ value, onSelect, onClose }: ModelPickerProps) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    if (query.trim()) {
      return [{ label: 'Results', models: searchModels(query) }];
    }
    const featured = getFeaturedModels();
    const featuredIds = new Set(featured.map((m) => m.id));
    const rest = getCreateModels().filter((m) => !featuredIds.has(m.id));
    const byCategory = new Map<string, ModelNodeDefinition[]>();
    for (const m of rest) {
      const arr = byCategory.get(m.category) ?? [];
      arr.push(m);
      byCategory.set(m.category, arr);
    }
    return [
      { label: 'Featured', models: featured },
      ...Array.from(byCategory.entries()).map(([label, models]) => ({ label, models })),
    ];
  }, [query]);

  return (
    <div className="model-picker" role="dialog" aria-label="Choose a model">
      <div className="model-picker__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          autoFocus
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      </div>
      <div className="model-picker__list">
        {groups.map((group) => (
          <div key={group.label} className="model-picker__group">
            <div className="model-picker__group-label">{group.label}</div>
            {group.models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-picker__row${value === m.id ? ' model-picker__row--active' : ''}`}
                onClick={() => {
                  onSelect(m.id);
                  onClose();
                }}
              >
                <span className="model-picker__row-name">{m.displayName}</span>
                <span className="model-picker__row-meta">{m.category} · {String(m.apiProvider)}</span>
                {value === m.id && <Check size={15} strokeWidth={2} className="model-picker__row-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/ModelPicker.tsx
git commit -m "feat(create): add ModelPicker search popover"
```

---

## Task 9: `ParamPills.tsx`

**Files:**
- Create: `frontend/src/components/create-studio/ParamPills.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/create-studio/ParamPills.tsx`:

```tsx
import type { ModelNodeDefinition } from '../../types';
import { deriveVisibleParams } from '../../lib/createParams';

interface ParamPillsProps {
  def: ModelNodeDefinition;
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ParamPills({ def, params, onChange }: ParamPillsProps) {
  const visible = deriveVisibleParams(def, params).filter(
    (p) => p.type === 'enum' || p.type === 'integer' || p.type === 'float' || p.type === 'boolean',
  );

  const set = (key: string, value: unknown) => onChange({ ...params, [key]: value });

  return (
    <div className="param-pills">
      {visible.map((p) => {
        if (p.type === 'enum') {
          return (
            <label key={p.key} className="param-pill" title={p.label}>
              <span className="param-pill__label">{p.label}</span>
              <select
                className="param-pill__select"
                value={String(params[p.key] ?? p.default ?? '')}
                onChange={(e) => set(p.key, e.target.value)}
              >
                {(p.options ?? []).map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            </label>
          );
        }
        if (p.type === 'boolean') {
          const checked = Boolean(params[p.key] ?? p.default);
          return (
            <button
              key={p.key}
              type="button"
              className={`param-pill param-pill--toggle${checked ? ' param-pill--on' : ''}`}
              onClick={() => set(p.key, !checked)}
            >
              {p.label}: {checked ? 'On' : 'Off'}
            </button>
          );
        }
        // integer / float
        return (
          <label key={p.key} className="param-pill" title={p.label}>
            <span className="param-pill__label">{p.label}</span>
            <input
              className="param-pill__number"
              type="number"
              value={Number(params[p.key] ?? p.default ?? 0)}
              min={p.min}
              max={p.max}
              step={p.step ?? (p.type === 'integer' ? 1 : 0.1)}
              onChange={(e) => set(p.key, p.type === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
            />
          </label>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/ParamPills.tsx
git commit -m "feat(create): add ParamPills dynamic param controls"
```

---

## Task 10: `CreateComposer.tsx`

**Files:**
- Create: `frontend/src/components/create-studio/CreateComposer.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/create-studio/CreateComposer.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { ModelPicker } from './ModelPicker';
import { ParamPills } from './ParamPills';

interface CreateComposerProps {
  modelDef: ModelNodeDefinition | null;
  prompt: string;
  params: Record<string, unknown>;
  isExecuting: boolean;
  onPromptChange: (value: string) => void;
  onSelectModel: (definitionId: string) => void;
  onParamsChange: (next: Record<string, unknown>) => void;
  onGenerate: () => void;
}

export function CreateComposer({
  modelDef, prompt, params, isExecuting,
  onPromptChange, onSelectModel, onParamsChange, onGenerate,
}: CreateComposerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const canGenerate = Boolean(modelDef) && !isExecuting;

  return (
    <div className="create-composer">
      {pickerOpen && (
        <>
          <div className="create-composer__picker-backdrop" onClick={() => setPickerOpen(false)} />
          <ModelPicker value={modelDef?.id ?? null} onSelect={onSelectModel} onClose={() => setPickerOpen(false)} />
        </>
      )}
      <textarea
        className="create-composer__prompt"
        placeholder="Describe what you want to create…"
        value={prompt}
        rows={1}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) {
            e.preventDefault();
            onGenerate();
          }
        }}
      />
      <div className="create-composer__controls">
        <button
          type="button"
          className="create-composer__model"
          onClick={() => setPickerOpen((v) => !v)}
        >
          {modelDef?.displayName ?? 'Select model'}
          <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {modelDef && <ParamPills def={modelDef} params={params} onChange={onParamsChange} />}
        <button
          type="button"
          className="create-composer__generate"
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          <Sparkles size={16} strokeWidth={1.9} aria-hidden="true" />
          {isExecuting ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/create-studio/CreateComposer.tsx
git commit -m "feat(create): add CreateComposer floating composer bar"
```

---

## Task 11: `CreateView.tsx` — host + generate orchestration + stage

**Files:**
- Create: `frontend/src/components/create-studio/CreateView.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/create-studio/CreateView.tsx`:

```tsx
import { useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { buildDefaultParamsForUi } from '../../lib/createParams';
import { CreateComposer } from './CreateComposer';
import { OutputRenderer } from './OutputRenderer';
import '../../styles/create-studio.css';

export function CreateView() {
  const exitCreateView = useUIStore((s) => s.exitCreateView);
  const sessionId = useUIStore((s) => s.createSessionId);
  const isExecuting = useGraphStore((s) => s.isExecuting);

  const [modelId, setModelId] = useState<string | null>('nano-banana');
  const [prompt, setPrompt] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    buildDefaultParamsForUi(NODE_DEFINITIONS['nano-banana']),
  );
  const [lastModelNodeIds, setLastModelNodeIds] = useState<string[]>([]);
  const cursor = useRef({ x: 80, y: 80 });

  const modelDef = modelId ? NODE_DEFINITIONS[modelId] ?? null : null;

  const resultNode = useGraphStore((s) =>
    lastModelNodeIds[0] ? s.nodes.find((n) => n.id === lastModelNodeIds[0]) : undefined,
  );

  const handleSelectModel = (id: string) => {
    setModelId(id);
    setParams(buildDefaultParamsForUi(NODE_DEFINITIONS[id]));
  };

  const handleGenerate = async () => {
    if (!modelDef || !sessionId || isExecuting) return;
    const { authorGenerationCluster, executeCluster } = useGraphStore.getState();
    const { modelNodeIds, allNodeIds } = authorGenerationCluster({
      definitionId: modelDef.id,
      prompt,
      params,
      refPaths: [],
      quantity: 1,
      sessionId,
      genId: uuidv4(),
      layoutOrigin: { ...cursor.current },
    });
    cursor.current = { x: cursor.current.x, y: cursor.current.y + 320 };
    setLastModelNodeIds(modelNodeIds);
    await executeCluster(allNodeIds);
  };

  const heroEmpty = useMemo(() => lastModelNodeIds.length === 0, [lastModelNodeIds]);

  return (
    <div className="create-view">
      <header className="create-view__topbar">
        <button type="button" className="create-view__back" onClick={exitCreateView}>
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /> Canvas
        </button>
        <span className="create-view__title">Create</span>
      </header>

      <div className="create-view__stage">
        {heroEmpty ? (
          <div className="create-view__hero">
            <div className="create-view__hero-title">Start creating</div>
            <div className="create-view__hero-sub">Describe an idea, pick a model, and generate. Your nodes build on the canvas as you go.</div>
          </div>
        ) : (
          <div className="create-view__result">
            {resultNode && (
              <OutputRenderer outputs={resultNode.data.outputs} state={resultNode.data.state} />
            )}
          </div>
        )}
      </div>

      <CreateComposer
        modelDef={modelDef}
        prompt={prompt}
        params={params}
        isExecuting={isExecuting}
        onPromptChange={setPrompt}
        onSelectModel={handleSelectModel}
        onParamsChange={setParams}
        onGenerate={handleGenerate}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add the `buildDefaultParamsForUi` helper to `createParams.ts`**

The composer needs defaults to seed `params` state. Add to `frontend/src/lib/createParams.ts`:

```typescript
export function buildDefaultParamsForUi(def: ModelNodeDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  for (const p of sources) {
    if (p.default !== undefined) defaults[p.key] = p.default;
  }
  return defaults;
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/create-studio/CreateView.tsx frontend/src/lib/createParams.ts
git commit -m "feat(create): add CreateView host with generate orchestration"
```

---

## Task 12: `create-studio.css`

**Files:**
- Create: `frontend/src/styles/create-studio.css`

- [ ] **Step 1: Write the stylesheet (all selectors scoped under `body.app-slava-restraint`)**

Create `frontend/src/styles/create-studio.css`:

```css
body.app-slava-restraint .create-view {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  grid-template-rows: 44px 1fr;
  background: var(--sr-canvas);
  color: var(--sr-ink);
  font-family: var(--sr-ui);
}

body.app-slava-restraint .create-view__topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--sr-edge);
  background: var(--sr-glass);
}
body.app-slava-restraint .create-view__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--sr-edge);
  border-radius: 8px;
  padding: 5px 10px;
  color: var(--sr-ink);
  cursor: pointer;
}
body.app-slava-restraint .create-view__back:hover { border-color: var(--sr-edge-strong); }
body.app-slava-restraint .create-view__title { color: var(--sr-ink-meta); font-size: 13px; letter-spacing: 0.04em; }

body.app-slava-restraint .create-view__stage {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 24px 160px;
}
body.app-slava-restraint .create-view__hero { text-align: center; max-width: 460px; }
body.app-slava-restraint .create-view__hero-title { font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
body.app-slava-restraint .create-view__hero-sub { margin-top: 10px; color: var(--sr-ink-meta); font-size: 14px; line-height: 1.5; }
body.app-slava-restraint .create-view__result {
  max-width: min(80vw, 900px);
  max-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

body.app-slava-restraint .create-output__media {
  max-width: 100%;
  max-height: 70vh;
  border-radius: 12px;
  border: 1px solid var(--sr-edge);
  background: var(--sr-glass);
}
body.app-slava-restraint .create-output__text {
  max-width: 70ch;
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--sr-glass-raised);
  border: 1px solid var(--sr-edge);
  white-space: pre-wrap;
  line-height: 1.6;
}
body.app-slava-restraint .create-output--loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--sr-ink-meta);
}
body.app-slava-restraint .create-output__spinner {
  width: 28px; height: 28px;
  border-radius: 50%;
  border: 2px solid var(--sr-edge);
  border-top-color: var(--sr-accent);
  animation: create-spin 0.8s linear infinite;
}
@keyframes create-spin { to { transform: rotate(360deg); } }

/* Floating composer */
body.app-slava-restraint .create-composer {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  width: min(820px, calc(100vw - 48px));
  padding: 12px;
  border-radius: 16px;
  background: var(--sr-glass-strong);
  border: 1px solid var(--sr-edge-strong);
  backdrop-filter: blur(18px);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
}
body.app-slava-restraint .create-composer__prompt {
  width: 100%;
  resize: none;
  min-height: 28px;
  max-height: 160px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--sr-ink-bold);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.4;
  padding: 6px 6px 10px;
}
body.app-slava-restraint .create-composer__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
body.app-slava-restraint .create-composer__model {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sr-glass-raised);
  border: 1px solid var(--sr-edge);
  border-radius: 10px;
  padding: 7px 12px;
  color: var(--sr-ink);
  font-size: 13px;
  cursor: pointer;
}
body.app-slava-restraint .create-composer__generate {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--sr-accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 9px 18px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
body.app-slava-restraint .create-composer__generate:disabled { opacity: 0.45; cursor: not-allowed; }

/* Param pills */
body.app-slava-restraint .param-pills { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
body.app-slava-restraint .param-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sr-glass-raised);
  border: 1px solid var(--sr-edge);
  border-radius: 10px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--sr-ink-meta);
}
body.app-slava-restraint .param-pill__select,
body.app-slava-restraint .param-pill__number {
  background: transparent;
  border: none;
  outline: none;
  color: var(--sr-ink);
  font-family: inherit;
  font-size: 12px;
}
body.app-slava-restraint .param-pill__number { width: 56px; }
body.app-slava-restraint .param-pill--toggle { cursor: pointer; }
body.app-slava-restraint .param-pill--on { border-color: var(--sr-accent); color: var(--sr-ink-bold); }

/* Model picker */
body.app-slava-restraint .create-composer__picker-backdrop { position: fixed; inset: 0; z-index: 1; }
body.app-slava-restraint .model-picker {
  position: absolute;
  z-index: 2;
  left: 12px;
  bottom: 64px;
  width: 360px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--sr-glass-strong);
  border: 1px solid var(--sr-edge-strong);
  border-radius: 14px;
  backdrop-filter: blur(18px);
  overflow: hidden;
}
body.app-slava-restraint .model-picker__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--sr-edge);
  color: var(--sr-ink-meta);
}
body.app-slava-restraint .model-picker__search input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--sr-ink);
  font-family: inherit;
  font-size: 13px;
}
body.app-slava-restraint .model-picker__list { overflow-y: auto; padding: 6px; }
body.app-slava-restraint .model-picker__group-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sr-ink-faint);
  padding: 8px 8px 4px;
}
body.app-slava-restraint .model-picker__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 8px;
  color: var(--sr-ink);
  cursor: pointer;
}
body.app-slava-restraint .model-picker__row:hover { background: var(--sr-glass-raised); }
body.app-slava-restraint .model-picker__row--active { background: var(--sr-glass-raised); }
body.app-slava-restraint .model-picker__row-name { font-size: 13px; }
body.app-slava-restraint .model-picker__row-meta { margin-left: auto; font-size: 11px; color: var(--sr-ink-faint); }
body.app-slava-restraint .model-picker__row-check { color: var(--sr-accent); }
```

> If any `--sr-*` token referenced here is missing in `slava-restraint.css`, substitute the nearest existing token (verify in `frontend/src/styles/slava-restraint.css`). Do not invent new global tokens.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/styles/create-studio.css
git commit -m "feat(create): add Slava-scoped create-studio styles"
```

---

## Task 13: Wire into the app — `App.tsx` + `PanelLaunchers.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/panels/PanelLaunchers.tsx`

- [ ] **Step 1: Mount `CreateView` in `App.tsx`**

Add the import alongside the other studio imports (after line 10):

```typescript
import { CreateView } from './components/create-studio/CreateView';
```

Add the flag near the other `is*` flags (after `const isMoodboard = ...`, ~line 136):

```typescript
  const isCreate = viewMode === 'create';
```

Add the branch in the `mainView` if/else chain (after the moodboard branch, ~line 150):

```typescript
  } else if (isCreate) {
    mainView = <CreateView />;
```

> No change needed to the canvas-only chrome block — Create is full-screen and self-contained, like the other studios.

- [ ] **Step 2: Add the Create launcher button in `PanelLaunchers.tsx`**

Replace the contents of `frontend/src/components/panels/PanelLaunchers.tsx` with:

```tsx
import { Blocks, MessageSquare, Sparkles } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import '../../styles/panels.css';

export function PanelLaunchers() {
  const libraryVisible = useUIStore((s) => s.panels.library.visible);
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const enterCreateView = useUIStore((s) => s.enterCreateView);

  return (
    <>
      <button
        type="button"
        className="panel-launcher panel-launcher--create"
        onClick={enterCreateView}
        title="Open Create view"
        aria-label="Open Create view"
      >
        <Sparkles
          className="panel-launcher__icon"
          size={18}
          strokeWidth={1.65}
          aria-hidden="true"
          focusable="false"
        />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--nodes${libraryVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('library')}
        title="Toggle node library"
        aria-label="Toggle node library"
        aria-pressed={libraryVisible}
      >
        <Blocks className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>

      <button
        type="button"
        className={`panel-launcher panel-launcher--chat${chatVisible ? ' panel-launcher--active' : ''}`}
        onClick={() => togglePanel('chat')}
        title="Toggle chat panel"
        aria-label="Toggle chat panel"
        aria-pressed={chatVisible}
      >
        <MessageSquare className="panel-launcher__icon" size={18} strokeWidth={1.65} aria-hidden="true" focusable="false" />
      </button>
    </>
  );
}
```

- [ ] **Step 3: Type-check + full test run + build**

Run:
```bash
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc clean, all tests pass, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/panels/PanelLaunchers.tsx
git commit -m "feat(create): mount CreateView + add Create launcher button"
```

---

## Task 14: Live smoke verification

**Files:** none (manual verification, per the project's two-gate rule — open in a normal browser, NOT lspace).

- [ ] **Step 1: Start backend + frontend**

```bash
# Terminal 1 (backend)
cd backend && uvicorn main:app --reload --port 8000
# Terminal 2 (frontend)
cd frontend && npm run dev
```
Open the printed Vite URL (e.g. http://localhost:5173) in a normal browser.

- [ ] **Step 2: Verify the flow**

1. Click the **Create** launcher (sparkle icon). Expected: full-screen Create view with the empty-state hero and the bottom composer.
2. Confirm the model defaults to **Nano Banana**; click the model pill → the search popover lists Featured + categories; search "flux" filters; pick Nano Banana again.
3. Type a prompt (e.g. "a calico cat astronaut, studio lighting"), set Aspect Ratio to 16:9 via the pill, click **Generate** (or Cmd/Ctrl+Enter).
4. Expected: the stage shows the loading spinner, then the generated image. (Requires a valid `GOOGLE_API_KEY` in Settings; if missing, expect the validation error surfaced on the node — that still proves wiring.)
5. Click **← Canvas**. Expected: the canvas now contains a `Text Input → Nano Banana` cluster, and the Nano Banana node shows the same image. Select the model node and run it from the canvas → it re-runs (proves the authored graph is real and editable).

- [ ] **Step 3: Record the result**

If anything deviates (e.g. a `--sr-*` token was missing, a port id didn't resolve), note it in `implementation-notes.md` and fix before marking P1 done.

---

## Self-Review (completed during authoring)

- **Spec coverage (P1 scope):** view shell + launcher (Tasks 2, 11, 13) ✓; bottom-floating composer (Task 10) ✓; full-catalog model picker (Tasks 5, 8) ✓; dynamic param pills (Tasks 6, 9) ✓; graph-builder authoring + scoped execute (Tasks 3, 4) ✓; latest-result stage via OutputRenderer (Tasks 7, 11) ✓; Slava styling (Task 12) ✓. Deferred to P2/P3 per spec: gallery/History, reference attach (`authorGenerationCluster` already supports `refPaths`, UI deferred), quantity>1 UI (logic supported + tested), presets.
- **Placeholder scan:** none — every code step contains complete code; the two inline "fix/substitute" notes (edge source handle in Task 4, missing-token fallback in Task 12) are explicit corrections, not deferrals.
- **Type consistency:** `authorGenerationCluster` returns `{ modelNodeIds, allNodeIds }` (Task 4) and `CreateView` destructures exactly those (Task 11); `executeCluster(nodeIds)` (Task 3) is called with `allNodeIds` (Task 11); `GenerationRequest` fields (Task 1) match the call site (Task 11); `deriveVisibleParams`/`buildDefaultParamsForUi` live in `createParams.ts` and are imported where used.
- **Known seam to watch:** the text-input edge source handle must be `'text'` (the output port), target handle the model's input port id — explicitly corrected in Task 4 Step 3.
```
