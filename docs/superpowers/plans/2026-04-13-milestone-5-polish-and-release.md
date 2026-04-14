# Milestone 5: Polish & Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final polish, feature parity, and open-source release preparation. Adds keyboard shortcuts (select all, duplicate, undo/redo), copy/paste with UUID regeneration, API key warning badges at node drop time, three utility nodes (combine-text, router, reroute), six new model node definitions with backend handlers, a README.md for open source release, and a FORjustin.md project learning file.

**Architecture:** Builds on existing React + Vite frontend with @xyflow/react v12 canvas, Zustand state management, FastAPI + WebSocket backend. New features are additive -- no structural changes to the existing graph execution engine, WebSocket event system, or handler registration pattern.

**Tech Stack:** React 19, Vite, TypeScript, @xyflow/react v12, Zustand, uuid, Python 3.12+, FastAPI, httpx

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md`
- Model API spec: `docs/perplexity-research/AI Node Editor — Complete Model & API Parameter Spec v2.md`
- Edge cases: `docs/perplexity-research/nebula-edge-cases.md`

---

## File Map

New files are marked with `+`. Modified files are marked with `*`.

```
nebula_nodes/
├── frontend/
│   ├── src/
│   │   ├── store/
│   │   │   ├── graphStore.ts              * (undo/redo stack, copy/paste, select all, batch duplicate)
│   │   │   └── uiStore.ts                * (settingsCache for API key check)
│   │   ├── components/
│   │   │   ├── Canvas.tsx                 * (keyboard shortcuts, new node type registration)
│   │   │   └── nodes/
│   │   │       └── RerouteNode.tsx        + (minimal dot passthrough node)
│   │   ├── constants/
│   │   │   └── nodeDefinitions.ts         * (6 new model defs + 3 utility defs)
│   │   ├── lib/
│   │   │   └── api.ts                     * (add fetchSettings for key check on load)
│   │   ├── styles/
│   │   │   └── nodes.css                  * (reroute node styles)
│   │   └── types/
│   │       └── index.ts                   * (add 'google' to APIProvider if missing, already present)
│   ├── tests/
│   │   ├── store/
│   │   │   └── graphStore.test.ts         * (tests for undo/redo, copy/paste, batch duplicate)
│   │   └── hooks/
│   │       └── keyboard.test.ts           + (keyboard shortcut integration tests)
├── backend/
│   ├── execution/
│   │   └── engine.py                      * (NODE_DEFS for new nodes)
│   ├── execution/
│   │   └── sync_runner.py                 * (register new handlers)
│   ├── handlers/
│   │   ├── openai_chat.py                 + (GPT-4o streaming chat)
│   │   └── google_gemini.py               + (Gemini streaming chat + image gen)
│   ├── tests/
│   │   ├── test_openai_chat_handler.py    + (GPT-4o handler tests)
│   │   └── test_google_gemini_handler.py  + (Gemini handler tests)
├── README.md                              +
└── FORjustin.md                           +
```

---

## Task 1: Undo/Redo Stack in graphStore

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Create: `frontend/tests/store/graphStore.test.ts` (add undo/redo test cases)

**Design decisions:**
- Per the edge cases doc (Section 4.1): undo/redo only affects **graph structure and params** -- generated outputs are NEVER removed by undo.
- The undo stack stores snapshots of `{ nodes, edges }` where node outputs are stripped from the snapshot (but remain in the live state).
- Cap at 50 entries to avoid unbounded memory growth.
- An undo operation pops the undo stack, pushes the current state onto the redo stack, and restores the previous snapshot -- but merges back any existing outputs from the live nodes.
- Any new graph mutation (node add, delete, move, connect, param change) that isn't itself an undo/redo clears the redo stack and pushes the previous state onto the undo stack.

- [ ] **Step 1: Add undo/redo state and types to GraphState interface**

In `frontend/src/store/graphStore.ts`, add to the `GraphState` interface:

```typescript
interface UndoSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

interface GraphState {
  // ... existing fields ...
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  clipboard: { nodes: Node<NodeData>[]; edges: Edge[] } | null;

  undo: () => void;
  redo: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  selectAll: () => void;
  duplicateSelected: () => void;
  // ... existing methods ...
}
```

- [ ] **Step 2: Implement the snapshot helper**

Add a helper inside the store file (not exported) that creates a snapshot with outputs stripped. This is what goes on the undo stack -- structure and params only, no generated content.

```typescript
function createSnapshot(nodes: Node<NodeData>[], edges: Edge[]): UndoSnapshot {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        state: n.data.state,       // preserve state for awareness
        outputs: n.data.outputs,    // preserve outputs -- they are NOT undone
        error: n.data.error,
        progress: n.data.progress,
        streamingText: n.data.streamingText,
      },
    })),
    edges: edges.map((e) => ({ ...e })),
  };
}
```

Wait -- re-reading the spec more carefully: "Undo/redo only affect graph structure and params. Generated outputs are never removed from the canvas by undo."

This means the snapshot stores structure + params. On restore, we restore nodes and edges from the snapshot but merge back the outputs from the CURRENT live state. If a node exists in both snapshot and live state, its outputs come from the live state. If a node exists only in the snapshot (i.e., was deleted and now restored by undo), its outputs are empty.

Corrected snapshot helper:

```typescript
function createSnapshot(nodes: Node<NodeData>[], edges: Edge[]): UndoSnapshot {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      data: {
        ...n.data,
        params: { ...n.data.params },
        // Outputs deliberately excluded from snapshot -- they persist through undo
        outputs: {},
        state: 'idle' as const,
        error: undefined,
        progress: undefined,
        streamingText: undefined,
      },
    })),
    edges: edges.map((e) => ({ ...e })),
  };
}

function restoreWithOutputs(
  snapshot: UndoSnapshot,
  currentNodes: Node<NodeData>[],
): Node<NodeData>[] {
  const currentOutputs = new Map<string, {
    outputs: Record<string, { type: string; value: string | null }>;
    state: NodeData['state'];
    streamingText?: string;
  }>();
  for (const n of currentNodes) {
    if (Object.keys(n.data.outputs).length > 0) {
      currentOutputs.set(n.id, {
        outputs: n.data.outputs,
        state: n.data.state,
        streamingText: n.data.streamingText,
      });
    }
  }

  return snapshot.nodes.map((n) => {
    const preserved = currentOutputs.get(n.id);
    if (preserved) {
      return {
        ...n,
        data: {
          ...n.data,
          outputs: preserved.outputs,
          state: preserved.state,
          streamingText: preserved.streamingText,
        },
      };
    }
    return n;
  });
}
```

- [ ] **Step 3: Add the pushUndo helper**

This is called by every mutating action before it applies the change. It captures the current state and pushes it onto the undo stack.

```typescript
// Inside the store, not exported
const UNDO_CAP = 50;

function pushUndo(set: Function, get: Function): void {
  const { nodes, edges, undoStack } = get();
  const snapshot = createSnapshot(nodes, edges);
  const newStack = [...undoStack, snapshot];
  if (newStack.length > UNDO_CAP) newStack.shift();
  set({ undoStack: newStack, redoStack: [] }); // Clear redo on new mutation
}
```

- [ ] **Step 4: Implement undo and redo**

```typescript
undo: () => {
  const { undoStack, nodes, edges } = get();
  if (undoStack.length === 0) return;

  const previousSnapshot = undoStack[undoStack.length - 1];
  const currentSnapshot = createSnapshot(nodes, edges);

  const restoredNodes = restoreWithOutputs(previousSnapshot, nodes);

  set({
    nodes: restoredNodes,
    edges: previousSnapshot.edges,
    undoStack: undoStack.slice(0, -1),
    redoStack: [...get().redoStack, currentSnapshot],
  });
},

redo: () => {
  const { redoStack, nodes, edges } = get();
  if (redoStack.length === 0) return;

  const nextSnapshot = redoStack[redoStack.length - 1];
  const currentSnapshot = createSnapshot(nodes, edges);

  const restoredNodes = restoreWithOutputs(nextSnapshot, nodes);

  set({
    nodes: restoredNodes,
    edges: nextSnapshot.edges,
    redoStack: redoStack.slice(0, -1),
    undoStack: [...get().undoStack, currentSnapshot],
  });
},
```

- [ ] **Step 5: Wire pushUndo into existing mutations**

Add `pushUndo(set, get)` as the first line of each mutating method:

| Method | Add pushUndo? | Notes |
|--------|--------------|-------|
| `addNode` | Yes | Before `set(...)` call |
| `addDynamicNode` | Yes | Before `set(...)` call |
| `onNodesChange` | Conditional | Only for `remove` and `position` changes (not `select` changes). Filter: `changes.some(c => c.type === 'remove' || c.type === 'position')` |
| `onEdgesChange` | Conditional | Only for `remove` changes |
| `onConnect` | Yes | Before `set(...)` call |
| `updateNodeData` | Yes | Before `set(...)` call |
| `duplicateNode` | Yes | Before `set(...)` call |
| `deleteNode` | Yes | Before `set(...)` call |
| `loadGraph` | No | Loading resets everything -- clear both stacks |
| `clearGraph` | Yes | Push before clearing |
| `configureOpenRouterModel` | Yes | Before `set(...)` call |
| `executeGraph` | No | Execution is not undoable |
| `handleExecutionEvent` | No | Outputs are not undoable |

**Important debounce for position changes:** Node dragging fires many rapid `position` changes. To avoid 100 undo entries per drag, only push undo on the FIRST position change in a drag sequence. Track this with a `_isDragging` flag set `true` on the first position change, and reset on `mouseup` (or after 300ms of no position changes). Simplest approach: use a debounced flag.

Actually, React Flow fires a `dimensions` change type on initial render and `position` on every pixel of drag. The cleanest approach for MVP: only push undo for `remove` type changes in `onNodesChange`, and for explicit user actions (add, delete, connect, param change). Position changes during drag are too granular. Users can undo the delete/add/connect but not individual pixel movements -- this is standard behavior in node editors.

Revised approach -- only push undo for these high-level mutations:
- `addNode` / `addDynamicNode`
- `onConnect`
- `updateNodeData` (but debounce -- see below)
- `duplicateNode`
- `deleteNode`
- `clearGraph`
- `configureOpenRouterModel`
- `fetchReplicateSchemaAndConfigure` (before the async call)

For `updateNodeData`, debounce the undo push: if the last undo push was less than 500ms ago for the same node, skip it. This prevents typing in a textarea from creating 50 undo entries.

```typescript
let lastUndoPush = 0;
let lastUndoNodeId = '';

function maybePushUndo(set: Function, get: Function, nodeId?: string): void {
  const now = Date.now();
  if (nodeId && nodeId === lastUndoNodeId && now - lastUndoPush < 500) {
    return; // Debounce rapid param changes on the same node
  }
  lastUndoPush = now;
  lastUndoNodeId = nodeId ?? '';
  pushUndo(set, get);
}
```

Use `maybePushUndo(set, get, nodeId)` in `updateNodeData`. Use `pushUndo(set, get)` everywhere else.

- [ ] **Step 6: Initialize undo/redo state**

In the store's initial state:

```typescript
undoStack: [],
redoStack: [],
clipboard: null,
```

In `loadGraph` and `clearGraph`, reset both stacks:

```typescript
loadGraph: (nodes, edges) => {
  set({ nodes, edges, isExecuting: false, undoStack: [], redoStack: [] });
},

clearGraph: () => {
  pushUndo(set, get);
  set({ nodes: [], edges: [], isExecuting: false, undoStack: get().undoStack, redoStack: [] });
},
```

Wait, that's wrong -- we push undo first, then clear. The push captures the pre-clear state. Let me fix:

```typescript
clearGraph: () => {
  const { nodes, edges, undoStack } = get();
  const snapshot = createSnapshot(nodes, edges);
  const newStack = [...undoStack, snapshot];
  if (newStack.length > UNDO_CAP) newStack.shift();
  set({ nodes: [], edges: [], isExecuting: false, undoStack: newStack, redoStack: [] });
},
```

- [ ] **Step 7: Write tests for undo/redo**

Add to `frontend/tests/store/graphStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';

function resetStore() {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    undoStack: [],
    redoStack: [],
    clipboard: null,
    isExecuting: false,
  });
}

describe('undo/redo', () => {
  beforeEach(resetStore);

  it('undo restores previous state after addNode', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    expect(useGraphStore.getState().nodes).toHaveLength(1);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('redo restores the undone state', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);

    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('undo preserves node outputs', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;

    // Simulate execution producing an output
    store.updateNodeData(nodeId, {
      state: 'complete',
      outputs: { text: { type: 'Text', value: 'hello world' } },
    });

    // Change a param (pushes undo)
    store.updateNodeData(nodeId, { params: { value: 'new text' } });

    // Undo should restore the param but keep the output
    useGraphStore.getState().undo();
    const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
    expect(node?.data.outputs.text?.value).toBe('hello world');
  });

  it('new mutation clears redo stack', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().redoStack).toHaveLength(1);

    useGraphStore.getState().addNode('text-input', { x: 200, y: 200 });
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
  });

  it('caps undo stack at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      useGraphStore.getState().addNode('text-input', { x: i * 10, y: 0 });
    }
    expect(useGraphStore.getState().undoStack.length).toBeLessThanOrEqual(50);
  });
});
```

---

## Task 2: Keyboard Shortcuts (Select All, Duplicate Selected, Undo/Redo)

**Files:**
- Modify: `frontend/src/components/Canvas.tsx`
- Modify: `frontend/src/store/graphStore.ts` (selectAll, duplicateSelected)

- [ ] **Step 1: Add selectAll to graphStore**

```typescript
selectAll: () => {
  set((state) => ({
    nodes: state.nodes.map((n) => ({ ...n, selected: true })),
  }));
},
```

- [ ] **Step 2: Add duplicateSelected to graphStore**

Duplicates all currently selected nodes and their internal edges (edges where both source and target are in the selection). Uses UUID regeneration and 20px offset -- same pattern as the existing `duplicateNode` but for multiple nodes.

```typescript
duplicateSelected: () => {
  const { nodes, edges } = get();
  const selected = nodes.filter((n) => n.selected);
  if (selected.length === 0) return;

  pushUndo(set, get);

  const idMap = new Map<string, string>();
  const newNodes = selected.map((node) => {
    const newId = uuidv4();
    idMap.set(node.id, newId);
    return {
      ...node,
      id: newId,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      selected: true,
      data: {
        ...node.data,
        state: 'idle' as const,
        outputs: {},
        error: undefined,
        progress: undefined,
        streamingText: undefined,
      },
    };
  });

  const selectedIds = new Set(selected.map((n) => n.id));
  const internalEdges = edges.filter(
    (e) => selectedIds.has(e.source) && selectedIds.has(e.target)
  );
  const newEdges = internalEdges.map((e) => ({
    ...e,
    id: uuidv4(),
    source: idMap.get(e.source)!,
    target: idMap.get(e.target)!,
  }));

  set((state) => ({
    nodes: [
      ...state.nodes.map((n) => ({ ...n, selected: false })),
      ...newNodes,
    ],
    edges: [...state.edges, ...newEdges],
  }));
},
```

- [ ] **Step 3: Extend onKeyDown in Canvas.tsx**

Add the new shortcuts to the existing `onKeyDown` handler. The full handler becomes:

```typescript
const onKeyDown = useCallback(
  (event: React.KeyboardEvent) => {
    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    // Don't capture shortcuts if user is typing in an input/textarea
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Ctrl+Enter -- Run graph
    if (isCtrlOrCmd && event.key === 'Enter' && !isExecuting) {
      event.preventDefault();
      executeGraph();
      return;
    }

    // Ctrl+S -- Save graph
    if (isCtrlOrCmd && event.key === 's') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('nebula:save'));
      return;
    }

    // Ctrl+O -- Load graph
    if (isCtrlOrCmd && event.key === 'o') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('nebula:load'));
      return;
    }

    // Ctrl+A -- Select all nodes
    if (isCtrlOrCmd && event.key === 'a') {
      event.preventDefault();
      useGraphStore.getState().selectAll();
      return;
    }

    // Ctrl+D -- Duplicate selected nodes
    if (isCtrlOrCmd && event.key === 'd') {
      event.preventDefault();
      useGraphStore.getState().duplicateSelected();
      return;
    }

    // Ctrl+Z -- Undo
    if (isCtrlOrCmd && !event.shiftKey && event.key === 'z') {
      event.preventDefault();
      useGraphStore.getState().undo();
      return;
    }

    // Ctrl+Shift+Z -- Redo
    if (isCtrlOrCmd && event.shiftKey && event.key === 'z') {
      event.preventDefault();
      useGraphStore.getState().redo();
      return;
    }

    // Ctrl+C -- Copy selected
    if (isCtrlOrCmd && event.key === 'c') {
      event.preventDefault();
      useGraphStore.getState().copySelected();
      return;
    }

    // Ctrl+V -- Paste
    if (isCtrlOrCmd && event.key === 'v') {
      event.preventDefault();
      useGraphStore.getState().pasteClipboard();
      return;
    }
  },
  [executeGraph, isExecuting]
);
```

**Important:** The `tag` guard at the top prevents shortcuts from firing when the user is typing in the text-input node's inline textarea, the inspector's input fields, or the library search box. Without this guard, pressing Ctrl+A while typing a prompt would select all nodes instead of selecting all text.

- [ ] **Step 4: Update the deleteKeyCode prop for React Flow**

The `deleteKeyCode` prop is already set to `['Backspace', 'Delete']` in Canvas.tsx. React Flow handles deletion of selected nodes/edges automatically via this prop. No change needed.

Verify: the existing Canvas.tsx has `deleteKeyCode={['Backspace', 'Delete']}` -- confirmed.

---

## Task 3: Copy/Paste with UUID Regeneration

**Files:**
- Modify: `frontend/src/store/graphStore.ts`

This implements the exact pattern from edge cases doc Section 4.2.

- [ ] **Step 1: Implement copySelected**

Copies all selected nodes and the edges between them to an internal clipboard (stored in graphStore, NOT the system clipboard -- system clipboard can't handle structured node data).

```typescript
copySelected: () => {
  const { nodes, edges } = get();
  const selected = nodes.filter((n) => n.selected);
  if (selected.length === 0) return;

  const selectedIds = new Set(selected.map((n) => n.id));
  const internalEdges = edges.filter(
    (e) => selectedIds.has(e.source) && selectedIds.has(e.target)
  );

  set({ clipboard: { nodes: selected, edges: internalEdges } });
},
```

- [ ] **Step 2: Implement pasteClipboard**

Pastes from the internal clipboard with new UUIDs, offset positions, cleared outputs, and remapped edge source/target IDs.

```typescript
pasteClipboard: () => {
  const { clipboard } = get();
  if (!clipboard || clipboard.nodes.length === 0) return;

  pushUndo(set, get);

  const idMap = new Map<string, string>();
  const newNodes = clipboard.nodes.map((node) => {
    const newId = uuidv4();
    idMap.set(node.id, newId);
    return {
      ...node,
      id: newId,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      selected: true,
      data: {
        ...node.data,
        state: 'idle' as const,
        outputs: {},
        error: undefined,
        progress: undefined,
        streamingText: undefined,
      },
    };
  });

  const newEdges = clipboard.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      ...e,
      id: uuidv4(),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }));

  set((state) => ({
    nodes: [
      ...state.nodes.map((n) => ({ ...n, selected: false })),
      ...newNodes,
    ],
    edges: [...state.edges, ...newEdges],
  }));
},
```

- [ ] **Step 3: Write tests for copy/paste**

```typescript
describe('copy/paste', () => {
  beforeEach(resetStore);

  it('paste creates nodes with new IDs', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    const originalId = useGraphStore.getState().nodes[0].id;

    // Select and copy
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(originalId);
  });

  it('paste offsets position by 20px', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 200 });
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.position.x).toBe(120);
    expect(pasted.position.y).toBe(220);
  });

  it('paste clears outputs and resets state to idle', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;
    store.updateNodeData(nodeId, {
      state: 'complete',
      outputs: { text: { type: 'Text', value: 'hello' } },
    });

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.data.state).toBe('idle');
    expect(Object.keys(pasted.data.outputs)).toHaveLength(0);
  });

  it('paste remaps internal edges to new IDs', () => {
    const store = useGraphStore.getState();
    store.addNode('text-input', { x: 100, y: 100 });
    store.addNode('claude-chat', { x: 300, y: 100 });
    const nodes = useGraphStore.getState().nodes;

    // Manually create an edge between them
    const edge = {
      id: 'test-edge',
      source: nodes[0].id,
      sourceHandle: 'text',
      target: nodes[1].id,
      targetHandle: 'messages',
      type: 'typed-edge',
    };
    useGraphStore.setState({ edges: [edge] });

    // Select all
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });

    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const allEdges = useGraphStore.getState().edges;
    expect(allEdges).toHaveLength(2);

    const pastedEdge = allEdges[1];
    expect(pastedEdge.id).not.toBe('test-edge');
    expect(pastedEdge.source).not.toBe(nodes[0].id);
    expect(pastedEdge.target).not.toBe(nodes[1].id);
  });
});
```

---

## Task 4: API Key Warning Badge at Node Drop Time

**Files:**
- Modify: `frontend/src/store/uiStore.ts` (add settingsCache)
- Modify: `frontend/src/store/graphStore.ts` (check key on addNode/addDynamicNode)
- Modify: `frontend/src/App.tsx` (fetch settings on mount)
- Modify: `frontend/src/lib/api.ts` (expose raw settings for key check)

**Design:** When a node is dropped on the canvas, immediately check if its required API key exists in the cached settings. If missing, set `keyStatus: 'missing'` in the node's data. ModelNode.tsx and DynamicNode.tsx already render a warning badge when `keyStatus === 'missing'` (confirmed in the existing code -- both components check `nodeData.keyStatus === 'missing'`).

- [ ] **Step 1: Add settings cache to uiStore**

```typescript
// In uiStore.ts, add to UIState interface:
settingsCache: {
  apiKeys: Record<string, string>;
  loaded: boolean;
};
setSettingsCache: (apiKeys: Record<string, string>) => void;

// Initial state:
settingsCache: { apiKeys: {}, loaded: false },

// Implementation:
setSettingsCache: (apiKeys) =>
  set({ settingsCache: { apiKeys, loaded: true } }),
```

- [ ] **Step 2: Add a raw settings endpoint to api.ts**

The existing `getSettings` endpoint returns masked keys (last 4 chars). For checking key existence, we only need to know if the key is non-empty. The masked response is sufficient -- a masked key like `***abcd` is truthy.

Actually, looking at the backend code more carefully:

```python
masked["apiKeys"] = {
    k: ("***" + v[-4:] if len(v) > 4 else "***") if v else ""
    for k, v in masked["apiKeys"].items()
}
```

Empty keys return `""` (falsy), present keys return `"***abcd"` (truthy). We can use the existing `getSettings` endpoint.

Add a helper in `api.ts`:

```typescript
export async function fetchApiKeyStatus(): Promise<Record<string, boolean>> {
  const settings = await getSettings();
  const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
  const status: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(apiKeys)) {
    status[key] = Boolean(value && value.length > 0);
  }
  return status;
}
```

- [ ] **Step 3: Fetch settings on app mount**

In `frontend/src/App.tsx`, add a `useEffect` that fetches settings once on mount:

```typescript
import { useEffect } from 'react';
import { getSettings } from './lib/api';
import { useUIStore } from './store/uiStore';

function App() {
  useEffect(() => {
    getSettings()
      .then((settings) => {
        const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
        useUIStore.getState().setSettingsCache(apiKeys);
      })
      .catch((err) => console.warn('Failed to load settings for key check:', err));
  }, []);

  // ... rest of App
}
```

- [ ] **Step 4: Check key status on node add**

In `graphStore.ts`, modify `addNode` to check the settings cache after creating the node:

```typescript
addNode: (definitionId, position) => {
  // ... existing code to create newNode ...

  // Check API key status
  const { settingsCache } = useUIStore.getState();
  if (settingsCache.loaded && definition.envKeyName) {
    const keyNames = Array.isArray(definition.envKeyName)
      ? definition.envKeyName
      : [definition.envKeyName];
    const hasKey = keyNames.length === 0 || keyNames.some((k) => Boolean(settingsCache.apiKeys[k]));
    if (!hasKey) {
      newNode.data.keyStatus = 'missing';
    }
  }

  set((state) => ({ nodes: [...state.nodes, newNode] }));
},
```

Apply the same check in `addDynamicNode`.

- [ ] **Step 5: Re-check keys when settings are saved**

Listen for a custom event `nebula:settings-saved` that the Settings panel fires after a successful save. On receipt, re-fetch settings and update all nodes' `keyStatus`.

In `App.tsx`:

```typescript
useEffect(() => {
  function handleSettingsSaved() {
    getSettings()
      .then((settings) => {
        const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
        useUIStore.getState().setSettingsCache(apiKeys);

        // Re-check all nodes
        const { nodes } = useGraphStore.getState();
        const updatedNodes = nodes.map((node) => {
          const def = NODE_DEFINITIONS[node.data.definitionId];
          if (!def) return node;
          const keyNames = Array.isArray(def.envKeyName)
            ? def.envKeyName
            : [def.envKeyName];
          const hasKey = keyNames.length === 0 || keyNames.some((k) => Boolean(apiKeys[k]));
          return {
            ...node,
            data: {
              ...node.data,
              keyStatus: hasKey ? undefined : ('missing' as const),
            },
          };
        });
        useGraphStore.setState({ nodes: updatedNodes });
      })
      .catch(console.warn);
  }

  window.addEventListener('nebula:settings-saved', handleSettingsSaved);
  return () => window.removeEventListener('nebula:settings-saved', handleSettingsSaved);
}, []);
```

In the Settings panel save handler (wherever `updateSettings` is called), dispatch this event after success:

```typescript
window.dispatchEvent(new CustomEvent('nebula:settings-saved'));
```

---

## Task 5: Utility Nodes -- combine-text, router, reroute

**Files:**
- Modify: `frontend/src/constants/nodeDefinitions.ts` (3 new node definitions)
- Create: `frontend/src/components/nodes/RerouteNode.tsx` (minimal dot component)
- Modify: `frontend/src/components/Canvas.tsx` (register reroute-node type)
- Modify: `frontend/src/styles/nodes.css` (reroute styles)
- Modify: `backend/execution/engine.py` (NODE_DEFS + inline execution for utility nodes)

### 5a: combine-text node

- [ ] **Step 1: Add combine-text to nodeDefinitions.ts**

```typescript
'combine-text': {
  id: 'combine-text',
  displayName: 'Combine Text',
  category: 'utility',
  apiProvider: 'openai', // Placeholder -- no API call
  apiEndpoint: '',
  envKeyName: [],
  executionPattern: 'sync',
  inputPorts: [
    { id: 'text1', label: 'Text 1', dataType: 'Text', required: true },
    { id: 'text2', label: 'Text 2', dataType: 'Text', required: false },
    { id: 'text3', label: 'Text 3', dataType: 'Text', required: false },
  ],
  outputPorts: [
    { id: 'text', label: 'Text', dataType: 'Text', required: false },
  ],
  params: [
    {
      key: 'separator',
      label: 'Separator',
      type: 'string',
      required: false,
      default: '\\n',
      placeholder: 'e.g. \\n or " | " or ", "',
    },
    {
      key: 'template',
      label: 'Template',
      type: 'textarea',
      required: false,
      default: '',
      placeholder: 'Optional: use {text1}, {text2}, {text3} placeholders',
    },
  ],
},
```

- [ ] **Step 2: Add combine-text to backend NODE_DEFS**

In `backend/execution/engine.py`:

```python
"combine-text": {
    "inputPorts": [
        {"id": "text1", "required": True},
        {"id": "text2", "required": False},
        {"id": "text3", "required": False},
    ],
    "outputPorts": [{"id": "text"}],
    "envKeyName": [],
},
```

- [ ] **Step 3: Add combine-text execution logic in engine.py**

In the `execute_graph` function, add a branch alongside the existing `text-input`, `image-input`, `preview` cases:

```python
elif node.definition_id == "combine-text":
    texts = []
    for port_id in ("text1", "text2", "text3"):
        if port_id in resolved_inputs and resolved_inputs[port_id].value:
            texts.append(str(resolved_inputs[port_id].value))

    template = node.params.get("template", "")
    if template:
        # Template mode: replace {text1}, {text2}, {text3}
        result = str(template)
        for i, port_id in enumerate(("text1", "text2", "text3")):
            val = ""
            if port_id in resolved_inputs and resolved_inputs[port_id].value:
                val = str(resolved_inputs[port_id].value)
            result = result.replace(f"{{{port_id}}}", val)
        node_outputs = {"text": {"type": "Text", "value": result}}
    else:
        # Separator mode: join non-empty texts
        separator = node.params.get("separator", "\n")
        separator = str(separator).replace("\\n", "\n").replace("\\t", "\t")
        node_outputs = {"text": {"type": "Text", "value": separator.join(texts)}}
```

### 5b: router node

- [ ] **Step 4: Add router to nodeDefinitions.ts**

```typescript
'router': {
  id: 'router',
  displayName: 'Router',
  category: 'utility',
  apiProvider: 'openai',
  apiEndpoint: '',
  envKeyName: [],
  executionPattern: 'sync',
  inputPorts: [
    { id: 'input', label: 'Input', dataType: 'Any', required: true },
  ],
  outputPorts: [
    { id: 'out1', label: 'Out 1', dataType: 'Any', required: false },
    { id: 'out2', label: 'Out 2', dataType: 'Any', required: false },
    { id: 'out3', label: 'Out 3', dataType: 'Any', required: false },
  ],
  params: [],
},
```

- [ ] **Step 5: Add router to backend NODE_DEFS and execution**

```python
"router": {
    "inputPorts": [{"id": "input", "required": True}],
    "outputPorts": [{"id": "out1"}, {"id": "out2"}, {"id": "out3"}],
    "envKeyName": [],
},
```

Execution logic:

```python
elif node.definition_id == "router":
    input_val = resolved_inputs.get("input")
    if input_val and input_val.value is not None:
        port_val = {"type": input_val.type, "value": input_val.value}
        node_outputs = {
            "out1": port_val,
            "out2": port_val,
            "out3": port_val,
        }
    else:
        node_outputs = {}
```

### 5c: reroute node

The reroute node renders as a minimal dot on the canvas, not a full node card. It acts as an invisible passthrough for cleaner edge routing.

- [ ] **Step 6: Add reroute to nodeDefinitions.ts**

```typescript
'reroute': {
  id: 'reroute',
  displayName: 'Reroute',
  category: 'utility',
  apiProvider: 'openai',
  apiEndpoint: '',
  envKeyName: [],
  executionPattern: 'sync',
  inputPorts: [
    { id: 'input', label: '', dataType: 'Any', required: true },
  ],
  outputPorts: [
    { id: 'output', label: '', dataType: 'Any', required: false },
  ],
  params: [],
},
```

- [ ] **Step 7: Create RerouteNode.tsx**

Create `frontend/src/components/nodes/RerouteNode.tsx`:

```typescript
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import '../../styles/nodes.css';

function RerouteNodeComponent({ id }: NodeProps) {
  return (
    <div className="reroute-node">
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        className="reroute-node__handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        className="reroute-node__handle"
      />
    </div>
  );
}

export const RerouteNode = memo(RerouteNodeComponent);
```

- [ ] **Step 8: Add reroute styles to nodes.css**

```css
/* ---------- Reroute node (minimal dot) ---------- */

.reroute-node {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #444;
  border: 2px solid #666;
  position: relative;
  cursor: crosshair;
}

.reroute-node:hover {
  background: #555;
  border-color: #888;
}

.reroute-node__handle {
  width: 8px !important;
  height: 8px !important;
  background: transparent !important;
  border: none !important;
  min-width: 8px !important;
  min-height: 8px !important;
}
```

- [ ] **Step 9: Register reroute-node type in Canvas.tsx**

```typescript
import { RerouteNode } from './nodes/RerouteNode';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
  'dynamic-node': DynamicNode,
  'reroute-node': RerouteNode,
};
```

- [ ] **Step 10: Route reroute nodes to the reroute-node type in addNode**

In `graphStore.ts`'s `addNode` method, add a check for reroute nodes to use the `reroute-node` type:

```typescript
addNode: (definitionId, position) => {
  // ... existing DYNAMIC_IDS check ...

  const definition = NODE_DEFINITIONS[definitionId];
  if (!definition) return;

  // Determine node type
  let nodeType = 'model-node';
  if (definitionId === 'reroute') {
    nodeType = 'reroute-node';
  }

  // ... rest of addNode logic, but use nodeType instead of 'model-node' ...
  const newNode: Node<NodeData> = {
    id: uuidv4(),
    type: nodeType,
    position,
    data: { /* ... */ },
  };
```

- [ ] **Step 11: Add reroute to backend NODE_DEFS and execution**

```python
"reroute": {
    "inputPorts": [{"id": "input", "required": True}],
    "outputPorts": [{"id": "output"}],
    "envKeyName": [],
},
```

Execution logic:

```python
elif node.definition_id == "reroute":
    input_val = resolved_inputs.get("input")
    if input_val and input_val.value is not None:
        node_outputs = {"output": {"type": input_val.type, "value": input_val.value}}
    else:
        node_outputs = {}
```

---

## Task 6: New Model Node Definitions + Handlers

**Files:**
- Modify: `frontend/src/constants/nodeDefinitions.ts` (6 new model defs)
- Modify: `backend/execution/engine.py` (NODE_DEFS for new nodes)
- Modify: `backend/execution/sync_runner.py` (register new handlers)
- Create: `backend/handlers/openai_chat.py` (GPT-4o streaming)
- Create: `backend/handlers/google_gemini.py` (Gemini streaming + image gen)
- Create: `backend/tests/test_openai_chat_handler.py`
- Create: `backend/tests/test_google_gemini_handler.py`

### Strategy for each new node:

| Node | Handler | Rationale |
|------|---------|-----------|
| GPT-4o Chat | New `openai_chat.py` | Distinct from OpenAI image -- uses `/v1/chat/completions` with streaming |
| DALL-E 3 | Existing `openai_image.py` | Same `/v1/images/generations` endpoint, already handles `dall-e` model prefix |
| Gemini | New `google_gemini.py` | Distinct provider with different auth + request format |
| Imagen 4 | New section in `google_gemini.py` | Same Google API key + similar endpoint structure |
| Kling v2.1 | Pre-configured FAL node | Routes to `fal-universal` handler with preset endpoint |
| Sora 2 | Pre-configured FAL node | Routes to `fal-universal` handler with preset endpoint |

### 6a: DALL-E 3

- [ ] **Step 1: Add DALL-E 3 to nodeDefinitions.ts**

```typescript
'dall-e-3-generate': {
  id: 'dall-e-3-generate',
  displayName: 'DALL-E 3',
  category: 'image-gen',
  apiProvider: 'openai',
  apiEndpoint: '/v1/images/generations',
  envKeyName: 'OPENAI_API_KEY',
  executionPattern: 'sync',
  inputPorts: [
    { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
  ],
  outputPorts: [
    { id: 'image', label: 'Image', dataType: 'Image', required: false },
  ],
  params: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      required: true,
      default: 'dall-e-3',
      options: [
        { label: 'DALL-E 3', value: 'dall-e-3' },
      ],
    },
    {
      key: 'size',
      label: 'Size',
      type: 'enum',
      required: false,
      default: '1024x1024',
      options: [
        { label: '1024x1024', value: '1024x1024' },
        { label: '1024x1792', value: '1024x1792' },
        { label: '1792x1024', value: '1792x1024' },
      ],
    },
    {
      key: 'quality',
      label: 'Quality',
      type: 'enum',
      required: false,
      default: 'standard',
      options: [
        { label: 'Standard', value: 'standard' },
        { label: 'HD', value: 'hd' },
      ],
    },
    {
      key: 'style',
      label: 'Style',
      type: 'enum',
      required: false,
      default: 'vivid',
      options: [
        { label: 'Vivid', value: 'vivid' },
        { label: 'Natural', value: 'natural' },
      ],
    },
  ],
},
```

- [ ] **Step 2: Add DALL-E 3 to backend NODE_DEFS**

```python
"dall-e-3-generate": {
    "inputPorts": [{"id": "prompt", "required": True}],
    "outputPorts": [{"id": "image"}],
    "envKeyName": "OPENAI_API_KEY",
},
```

- [ ] **Step 3: Register DALL-E 3 handler**

The existing `openai_image.py` handler already handles DALL-E models correctly (the `model.startswith("dall-e")` branch adds `response_format: "b64_json"`). Register it in `sync_runner.py`:

```python
SYNC_HANDLERS: dict[...] = {
    "gpt-image-1-generate": handle_openai_image_generate,
    "dall-e-3-generate": handle_openai_image_generate,  # Same handler, different default params
}
```

The handler reads `model` from `node.params` which will be `dall-e-3`, so the existing branching logic works.

### 6b: GPT-4o Chat

- [ ] **Step 4: Add GPT-4o Chat to nodeDefinitions.ts**

```typescript
'gpt-4o-chat': {
  id: 'gpt-4o-chat',
  displayName: 'GPT-4o',
  category: 'text-gen',
  apiProvider: 'openai',
  apiEndpoint: '/v1/chat/completions',
  envKeyName: 'OPENAI_API_KEY',
  executionPattern: 'stream',
  inputPorts: [
    { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
  ],
  outputPorts: [
    { id: 'text', label: 'Text', dataType: 'Text', required: false },
  ],
  params: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      required: true,
      default: 'gpt-4o',
      options: [
        { label: 'GPT-4o', value: 'gpt-4o' },
        { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
        { label: 'GPT-4.1', value: 'gpt-4.1' },
      ],
    },
    {
      key: 'max_tokens',
      label: 'Max Tokens',
      type: 'integer',
      required: false,
      default: 4096,
      min: 1,
      max: 128000,
    },
    {
      key: 'temperature',
      label: 'Temperature',
      type: 'float',
      required: false,
      default: 1.0,
      min: 0,
      max: 2,
      step: 0.1,
    },
  ],
},
```

- [ ] **Step 5: Create backend/handlers/openai_chat.py**

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable
from pathlib import Path
import base64

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


async def handle_openai_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for GPT-4o chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    # Handle image inputs for vision
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = (
            images_input.value
            if isinstance(images_input.value, list)
            else [images_input.value]
        )
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://")):
                content.append(
                    {"type": "image_url", "image_url": {"url": img_str}}
                )
            elif img_str.startswith("data:"):
                content.append(
                    {"type": "image_url", "image_url": {"url": img_str}}
                )
            else:
                img_path = Path(img_str)
                if img_path.exists():
                    b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {
                        "png": "image/png",
                        "jpg": "image/jpeg",
                        "jpeg": "image/jpeg",
                        "webp": "image/webp",
                    }
                    data_uri = f"data:{mime_map.get(suffix, 'image/png')};base64,{b64}"
                    content.append(
                        {"type": "image_url", "image_url": {"url": data_uri}}
                    )

    messages = [{"role": "user", "content": content}]

    model = node.params.get("model", "gpt-4o")
    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    config = StreamConfig(
        url=OPENAI_CHAT_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        event_type_filter=None,  # OpenAI uses standard SSE without event types
        delta_path="choices.0.delta.content",
        timeout=30.0,
        extra_stop_events=set(),
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(
        config=config,
        request_body=request_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    return {"text": {"type": "Text", "value": full_text}}
```

- [ ] **Step 6: Add GPT-4o to backend NODE_DEFS and sync_runner**

In `engine.py`:

```python
"gpt-4o-chat": {
    "inputPorts": [
        {"id": "messages", "required": True},
        {"id": "images", "required": False},
    ],
    "outputPorts": [{"id": "text"}],
    "envKeyName": "OPENAI_API_KEY",
},
```

In `sync_runner.py` `get_handler_registry`, add:

```python
from handlers.openai_chat import handle_openai_chat

async def _openai_chat_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    return await handle_openai_chat(node, inputs, api_keys, emit=emit)

registry["gpt-4o-chat"] = _openai_chat_handler
```

### 6c: Gemini

- [ ] **Step 7: Add Gemini to nodeDefinitions.ts**

```typescript
'gemini-chat': {
  id: 'gemini-chat',
  displayName: 'Gemini',
  category: 'text-gen',
  apiProvider: 'google',
  apiEndpoint: '/v1beta/models/{model}:generateContent',
  envKeyName: 'GOOGLE_API_KEY',
  executionPattern: 'stream',
  inputPorts: [
    { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
  ],
  outputPorts: [
    { id: 'text', label: 'Text', dataType: 'Text', required: false },
  ],
  params: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      required: true,
      default: 'gemini-2.5-flash',
      options: [
        { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
        { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
        { label: 'Gemini 3 Pro Preview', value: 'gemini-3-pro-preview' },
        { label: 'Gemini 3 Flash Preview', value: 'gemini-3-flash-preview' },
      ],
    },
    {
      key: 'maxOutputTokens',
      label: 'Max Tokens',
      type: 'integer',
      required: false,
      default: 8192,
      min: 1,
      max: 65535,
    },
    {
      key: 'temperature',
      label: 'Temperature',
      type: 'float',
      required: false,
      default: 1.0,
      min: 0,
      max: 2,
      step: 0.1,
    },
  ],
},
```

- [ ] **Step 8: Create backend/handlers/google_gemini.py**

Gemini uses a REST API with streaming via `streamGenerateContent?alt=sse`. The response is SSE with JSON chunks containing `candidates[0].content.parts[0].text`.

```python
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, StreamDeltaEvent
from services.output import get_run_dir, save_base64_image

GEMINI_API_BASE = "https://generativelanguage.googleapis.com"


async def handle_gemini_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY is required")

    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for Gemini")

    messages_text = str(messages_input.value)

    # Build parts array
    parts: list[dict[str, Any]] = [{"text": messages_text}]

    # Handle image inputs
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = (
            images_input.value
            if isinstance(images_input.value, list)
            else [images_input.value]
        )
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith("data:"):
                # Extract base64 from data URI
                header, b64_data = img_str.split(",", 1)
                mime = header.split(":")[1].split(";")[0]
                parts.append(
                    {
                        "inline_data": {
                            "mime_type": mime,
                            "data": b64_data,
                        }
                    }
                )
            elif img_str.startswith(("http://", "https://")):
                parts.append(
                    {"file_data": {"file_uri": img_str, "mime_type": "image/png"}}
                )
            else:
                img_path = Path(img_str)
                if img_path.exists():
                    b64_data = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {
                        "png": "image/png",
                        "jpg": "image/jpeg",
                        "jpeg": "image/jpeg",
                        "webp": "image/webp",
                    }
                    parts.append(
                        {
                            "inline_data": {
                                "mime_type": mime_map.get(suffix, "image/png"),
                                "data": b64_data,
                            }
                        }
                    )

    model = node.params.get("model", "gemini-2.5-flash")
    url = f"{GEMINI_API_BASE}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"

    request_body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {},
    }

    max_tokens = node.params.get("maxOutputTokens")
    if max_tokens:
        request_body["generationConfig"]["maxOutputTokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["generationConfig"]["temperature"] = float(temperature)

    # Remove empty generationConfig
    if not request_body["generationConfig"]:
        del request_body["generationConfig"]

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    # Stream the response
    accumulated = ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as client:
        async with client.stream(
            "POST",
            url,
            headers={"Content-Type": "application/json"},
            json=request_body,
        ) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(
                    f"Gemini API error ({response.status_code}): {error_body}"
                )

            async for line in response.aiter_lines():
                line = line.strip()
                if not line or line.startswith("event:"):
                    continue
                if line.startswith("data:"):
                    data_str = line[len("data:") :].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                    except (ValueError, TypeError):
                        continue

                    # Extract text from candidates[0].content.parts[0].text
                    candidates = data.get("candidates", [])
                    if candidates:
                        content_parts = (
                            candidates[0].get("content", {}).get("parts", [])
                        )
                        for part in content_parts:
                            text = part.get("text")
                            if text:
                                accumulated += text
                                await _emit(
                                    StreamDeltaEvent(
                                        node_id=node.id,
                                        delta=text,
                                        accumulated=accumulated,
                                    )
                                )

    return {"text": {"type": "Text", "value": accumulated}}


async def handle_imagen4_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    """Handle Imagen 4 image generation via Google's API.

    Imagen 4 uses the generateImages endpoint (NOT generateContent).
    Endpoint: POST /v1beta/models/{model}:generateImages
    """
    api_key = api_keys.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY is required")

    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required for Imagen 4")

    prompt_text = str(prompt_input.value)
    model = node.params.get("model", "imagen-4.0-generate-001")

    url = f"{GEMINI_API_BASE}/v1beta/models/{model}:generateImages?key={api_key}"

    request_body: dict[str, Any] = {
        "prompt": prompt_text,
        "config": {},
    }

    aspect_ratio = node.params.get("aspectRatio")
    if aspect_ratio:
        request_body["config"]["aspectRatio"] = str(aspect_ratio)

    num_images = node.params.get("numberOfImages")
    if num_images:
        request_body["config"]["numberOfImages"] = int(num_images)

    output_mime = node.params.get("outputMimeType")
    if output_mime:
        request_body["config"]["outputOptions"] = {"mimeType": output_mime}

    if not request_body["config"]:
        del request_body["config"]

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            url,
            headers={"Content-Type": "application/json"},
            json=request_body,
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Imagen 4 API error ({resp.status_code}): {resp.text}"
            )

    data = resp.json()

    # Imagen 4 returns: {"generatedImages": [{"image": {"imageBytes": "<base64>"}}]}
    generated = data.get("generatedImages", [])
    if not generated:
        raise RuntimeError("Imagen 4 returned no images")

    b64_data = generated[0].get("image", {}).get("imageBytes", "")
    if not b64_data:
        raise RuntimeError("Imagen 4 returned empty image data")

    run_dir = get_run_dir()
    file_path = save_base64_image(b64_data, run_dir, extension="png")

    return {"image": {"type": "Image", "value": str(file_path)}}
```

- [ ] **Step 9: Add Gemini + Imagen 4 to backend NODE_DEFS**

```python
"gemini-chat": {
    "inputPorts": [
        {"id": "messages", "required": True},
        {"id": "images", "required": False},
    ],
    "outputPorts": [{"id": "text"}],
    "envKeyName": "GOOGLE_API_KEY",
},
"imagen-4-generate": {
    "inputPorts": [{"id": "prompt", "required": True}],
    "outputPorts": [{"id": "image"}],
    "envKeyName": "GOOGLE_API_KEY",
},
```

- [ ] **Step 10: Register Gemini + Imagen 4 handlers in sync_runner.py**

```python
from handlers.google_gemini import handle_gemini_chat, handle_imagen4_generate

# In get_handler_registry, inside the `if emit is not None:` block:
async def _gemini_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    return await handle_gemini_chat(node, inputs, api_keys, emit=emit)

registry["gemini-chat"] = _gemini_handler

# Imagen 4 is sync (no emit needed), add to SYNC_HANDLERS:
SYNC_HANDLERS["imagen-4-generate"] = handle_imagen4_generate
```

### 6d: Imagen 4

- [ ] **Step 11: Add Imagen 4 to nodeDefinitions.ts**

```typescript
'imagen-4-generate': {
  id: 'imagen-4-generate',
  displayName: 'Imagen 4',
  category: 'image-gen',
  apiProvider: 'google',
  apiEndpoint: '/v1beta/models/{model}:generateImages',
  envKeyName: 'GOOGLE_API_KEY',
  executionPattern: 'sync',
  inputPorts: [
    { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
  ],
  outputPorts: [
    { id: 'image', label: 'Image', dataType: 'Image', required: false },
  ],
  params: [
    {
      key: 'model',
      label: 'Model',
      type: 'enum',
      required: true,
      default: 'imagen-4.0-generate-001',
      options: [
        { label: 'Imagen 4', value: 'imagen-4.0-generate-001' },
        { label: 'Imagen 4 Ultra', value: 'imagen-4.0-ultra-generate-001' },
        { label: 'Imagen 4 Fast', value: 'imagen-4.0-fast-generate-001' },
      ],
    },
    {
      key: 'aspectRatio',
      label: 'Aspect Ratio',
      type: 'enum',
      required: false,
      default: '1:1',
      options: [
        { label: '1:1', value: '1:1' },
        { label: '3:4', value: '3:4' },
        { label: '4:3', value: '4:3' },
        { label: '9:16', value: '9:16' },
        { label: '16:9', value: '16:9' },
      ],
    },
    {
      key: 'numberOfImages',
      label: 'Count',
      type: 'integer',
      required: false,
      default: 1,
      min: 1,
      max: 4,
    },
  ],
},
```

### 6e: Kling v2.1 (pre-configured FAL node)

Kling v2.1 is accessible via FAL. Instead of writing a new handler, we create a static node definition that the engine routes to the existing `fal-universal` handler. The `endpoint_id` param is pre-set and hidden from the user.

- [ ] **Step 12: Add Kling v2.1 to nodeDefinitions.ts**

```typescript
'kling-v2-1': {
  id: 'kling-v2-1',
  displayName: 'Kling v2.1',
  category: 'video-gen',
  apiProvider: 'fal',
  apiEndpoint: 'fal-ai/kling-video/v2.1/pro/image-to-video',
  envKeyName: 'FAL_KEY',
  executionPattern: 'async-poll',
  inputPorts: [
    { id: 'image', label: 'Image', dataType: 'Image', required: true },
    { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
  ],
  outputPorts: [
    { id: 'video', label: 'Video', dataType: 'Video', required: false },
  ],
  params: [
    {
      key: 'endpoint_id',
      label: 'Endpoint',
      type: 'string',
      required: true,
      default: 'fal-ai/kling-video/v2.1/pro/image-to-video',
    },
    {
      key: 'duration',
      label: 'Duration',
      type: 'enum',
      required: false,
      default: '5',
      options: [
        { label: '5 seconds', value: '5' },
        { label: '10 seconds', value: '10' },
      ],
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect Ratio',
      type: 'enum',
      required: false,
      default: '16:9',
      options: [
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '1:1', value: '1:1' },
      ],
    },
  ],
},
```

- [ ] **Step 13: Add Kling v2.1 to backend NODE_DEFS and handler routing**

In `engine.py`:

```python
"kling-v2-1": {
    "inputPorts": [
        {"id": "image", "required": True},
        {"id": "prompt", "required": True},
    ],
    "outputPorts": [{"id": "video"}],
    "envKeyName": "FAL_KEY",
},
```

In `sync_runner.py`, route Kling to the FAL handler:

```python
registry["kling-v2-1"] = _fal_handler
```

The `fal-universal` handler reads `endpoint_id` from `node.params`, which is pre-set to `fal-ai/kling-video/v2.1/pro/image-to-video`. It maps `prompt` and `image` inputs to the FAL request body. The existing handler handles everything.

**Important:** The FAL handler maps `image` input to `image_url` in the request body. The Kling `image` input port matches this pattern. Verify by reading the handler code -- confirmed: `image_input = inputs.get("image")` maps to `fal_input["image_url"]`.

### 6f: Sora 2 (pre-configured FAL node)

- [ ] **Step 14: Add Sora 2 to nodeDefinitions.ts**

```typescript
'sora-2': {
  id: 'sora-2',
  displayName: 'Sora 2',
  category: 'video-gen',
  apiProvider: 'fal',
  apiEndpoint: 'fal-ai/sora-2/text-to-video',
  envKeyName: 'FAL_KEY',
  executionPattern: 'async-poll',
  inputPorts: [
    { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
  ],
  outputPorts: [
    { id: 'video', label: 'Video', dataType: 'Video', required: false },
  ],
  params: [
    {
      key: 'endpoint_id',
      label: 'Endpoint',
      type: 'string',
      required: true,
      default: 'fal-ai/sora-2/text-to-video',
    },
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'enum',
      required: false,
      default: '1080p',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' },
      ],
    },
    {
      key: 'aspect_ratio',
      label: 'Aspect Ratio',
      type: 'enum',
      required: false,
      default: '16:9',
      options: [
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
      ],
    },
    {
      key: 'duration',
      label: 'Duration (sec)',
      type: 'enum',
      required: false,
      default: '8',
      options: [
        { label: '4s', value: '4' },
        { label: '8s', value: '8' },
        { label: '12s', value: '12' },
        { label: '16s', value: '16' },
        { label: '20s', value: '20' },
      ],
    },
  ],
},
```

- [ ] **Step 15: Add Sora 2 to backend NODE_DEFS and handler routing**

In `engine.py`:

```python
"sora-2": {
    "inputPorts": [{"id": "prompt", "required": True}],
    "outputPorts": [{"id": "video"}],
    "envKeyName": "FAL_KEY",
},
```

In `sync_runner.py`:

```python
registry["sora-2"] = _fal_handler
```

- [ ] **Step 16: Write handler tests**

Create `backend/tests/test_openai_chat_handler.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from models.graph import GraphNode, PortValueDict
from handlers.openai_chat import handle_openai_chat


@pytest.fixture
def text_node():
    return GraphNode(
        id="node-1",
        definitionId="gpt-4o-chat",
        params={"model": "gpt-4o", "max_tokens": 100, "temperature": 0.7},
    )


@pytest.fixture
def api_keys():
    return {"OPENAI_API_KEY": "sk-test-key-12345"}


@pytest.mark.asyncio
async def test_missing_api_key(text_node):
    with pytest.raises(ValueError, match="OPENAI_API_KEY is required"):
        await handle_openai_chat(
            text_node,
            {"messages": PortValueDict(type="Text", value="Hello")},
            {},
        )


@pytest.mark.asyncio
async def test_missing_messages(text_node, api_keys):
    with pytest.raises(ValueError, match="Messages input is required"):
        await handle_openai_chat(text_node, {}, api_keys)


@pytest.mark.asyncio
async def test_missing_messages_value(text_node, api_keys):
    with pytest.raises(ValueError, match="Messages input is required"):
        await handle_openai_chat(
            text_node,
            {"messages": PortValueDict(type="Text", value=None)},
            api_keys,
        )
```

Create `backend/tests/test_google_gemini_handler.py`:

```python
import pytest

from models.graph import GraphNode, PortValueDict
from handlers.google_gemini import handle_gemini_chat, handle_imagen4_generate


@pytest.fixture
def gemini_node():
    return GraphNode(
        id="node-1",
        definitionId="gemini-chat",
        params={"model": "gemini-2.5-flash", "maxOutputTokens": 100},
    )


@pytest.fixture
def imagen_node():
    return GraphNode(
        id="node-2",
        definitionId="imagen-4-generate",
        params={"model": "imagen-4.0-generate-001"},
    )


@pytest.fixture
def api_keys():
    return {"GOOGLE_API_KEY": "test-google-key-12345"}


@pytest.mark.asyncio
async def test_gemini_missing_api_key(gemini_node):
    with pytest.raises(ValueError, match="GOOGLE_API_KEY is required"):
        await handle_gemini_chat(
            gemini_node,
            {"messages": PortValueDict(type="Text", value="Hello")},
            {},
        )


@pytest.mark.asyncio
async def test_gemini_missing_messages(gemini_node, api_keys):
    with pytest.raises(ValueError, match="Messages input is required"):
        await handle_gemini_chat(gemini_node, {}, api_keys)


@pytest.mark.asyncio
async def test_imagen_missing_api_key(imagen_node):
    with pytest.raises(ValueError, match="GOOGLE_API_KEY is required"):
        await handle_imagen4_generate(
            imagen_node,
            {"prompt": PortValueDict(type="Text", value="A cat")},
            {},
        )


@pytest.mark.asyncio
async def test_imagen_missing_prompt(imagen_node, api_keys):
    with pytest.raises(ValueError, match="Prompt input is required"):
        await handle_imagen4_generate(imagen_node, {}, api_keys)
```

---

## Task 7: README.md

**Files:**
- Create: `README.md` (project root)

- [ ] **Step 1: Write README.md**

Create `README.md` at the project root:

````markdown
# Nebula Node

A local, open-source AI node editor. Wire together AI models on a visual canvas -- image generation, video generation, text/chat, audio, and more. Bring your own API keys.

![Nebula Node](docs/screenshot.png)

## Features

- **Visual node editor** -- drag, drop, and connect AI model nodes on an infinite canvas
- **50+ AI models** -- OpenAI (GPT-4o, GPT Image 1, DALL-E 3, Sora 2), Anthropic (Claude), Google (Gemini, Imagen 4), Runway (Gen-4 Turbo), Kling v2.1, ElevenLabs TTS, FLUX 1.1 Ultra, and more via OpenRouter, Replicate, and FAL universal nodes
- **Typed port system** -- color-coded ports (Text, Image, Video, Audio, Any) with automatic type validation and cycle detection
- **Live streaming** -- see Claude and GPT-4o responses stream into nodes in real-time
- **Execution engine** -- topological sort, async-poll for video generation, progress tracking, and execution caching
- **Utility nodes** -- Text Input, Image Input, Preview, Combine Text, Router, Reroute
- **Keyboard shortcuts** -- Ctrl+Z/Ctrl+Shift+Z undo/redo, Ctrl+C/V copy/paste with UUID regeneration, Ctrl+A select all, Ctrl+D duplicate, Ctrl+Enter run
- **Save/Load** -- `.nebula` JSON files preserve graph structure and params
- **Settings panel** -- manage API keys, routing preferences
- **Runs locally** -- your keys never leave your machine

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.12+

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/nebula-node.git
cd nebula-node
```

### 2. Set up the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Set up the frontend

```bash
cd frontend
npm install
```

### 4. Add your API keys

Copy the example settings file and add your keys:

```bash
cp settings.json.example settings.json
```

Edit `settings.json` and add your API keys under `apiKeys`. You only need keys for the models you want to use:

```json
{
  "apiKeys": {
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "GOOGLE_API_KEY": "AIza...",
    "FAL_KEY": "...",
    "RUNWAY_API_KEY": "...",
    "ELEVENLABS_API_KEY": "...",
    "OPENROUTER_API_KEY": "sk-or-...",
    "REPLICATE_API_TOKEN": "r8_..."
  }
}
```

### 5. Run

In two terminal windows:

```bash
# Terminal 1: Backend
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000

# Terminal 2: Frontend
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## How to Use

1. **Add nodes** -- open the node library (click "Nodes" in the toolbar or press N) and drag a node onto the canvas
2. **Connect nodes** -- drag from an output port (right side) to a compatible input port (left side). Ports are color-coded by type.
3. **Configure** -- click a node to open the Inspector panel and adjust parameters
4. **Run** -- press Ctrl+Enter or click the Run button. Execution flows left-to-right through connected nodes.
5. **View results** -- outputs appear as inline previews on each node. Images, text, and video render directly on the canvas.

## Supported Models

| Provider | Models | Type |
|----------|--------|------|
| OpenAI | GPT Image 1/1.5/Mini, DALL-E 3, GPT-4o/4o-mini/4.1 | Image Gen, Text Gen |
| Anthropic | Claude Opus 4, Sonnet 4.6, Haiku 3.5 | Text Gen |
| Google | Gemini 2.5/3 Pro/Flash, Imagen 4/Ultra/Fast | Text Gen, Image Gen |
| Runway | Gen-4 Turbo, Gen-4, Gen-4 Aleph | Video Gen |
| Kling | v2.1 Pro (via FAL) | Video Gen |
| Sora | Sora 2 (via FAL) | Video Gen |
| ElevenLabs | Multilingual v2, Flash v2.5, v3 | Audio Gen |
| Black Forest Labs | FLUX 1.1 Ultra | Image Gen |
| OpenRouter | 200+ models (auto-configured) | Universal |
| Replicate | Any public model (schema auto-fetch) | Universal |
| FAL | Any FAL endpoint | Universal |

## Architecture

```
Frontend (React + Vite)          Backend (FastAPI)
========================         ===================
Canvas.tsx                       main.py
  - @xyflow/react v12              - REST: /api/execute, /api/settings
  - Custom node components         - WebSocket: /ws (execution events)
                                    |
graphStore.ts (Zustand)          execution/engine.py
  - nodes, edges, undo stack       - Topological sort
  - add/delete/duplicate            - Validation
  - copy/paste                      - Orchestration
                                    |
wsClient.ts                      handlers/
  - WebSocket connection             - openai_image.py (sync)
  - Event dispatching                - openai_chat.py (stream)
                                     - anthropic_chat.py (stream)
                                     - google_gemini.py (stream + sync)
                                     - runway.py (async-poll)
                                     - fal_universal.py (async-poll)
                                     - openrouter.py (stream)
                                     - replicate_universal.py (async-poll)
```

Three execution patterns:
- **sync** -- single request/response (GPT Image 1, DALL-E 3, Imagen 4, FLUX, ElevenLabs)
- **stream** -- SSE streaming with live delta events (Claude, GPT-4o, Gemini, OpenRouter)
- **async-poll** -- submit job, poll for completion (Runway, Kling, Sora 2, Replicate, FAL)

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `cd frontend && npm test` / `cd backend && pytest`
5. Submit a PR

## License

MIT
````

---

## Task 8: FORjustin.md

**Files:**
- Create: `FORjustin.md` (project root)

- [ ] **Step 1: Write FORjustin.md**

This is a living document. The initial version captures the architecture, decisions, bugs, and lessons from the build. It will be updated at the end of this milestone and future sessions.

Create `FORjustin.md` at the project root. Content should cover:

1. **What Nebula Node is** -- one paragraph explaining the vision
2. **Architecture overview** -- how the frontend and backend connect, the three execution patterns, and why
3. **The graph execution pipeline** -- topological sort, validation, handler dispatch, WebSocket events
4. **State management** -- graphStore vs uiStore, why Zustand, how undo/redo works
5. **The node type system** -- static (ModelNode) vs dynamic (DynamicNode) vs reroute (RerouteNode), why three types
6. **API handler patterns** -- sync runner, stream runner, async-poll runner, and how the registry works
7. **Bugs we hit and how we fixed them** -- these are the most valuable entries:
   - `response_format` crash: GPT Image 1 does NOT accept `response_format: "b64_json"` (it's the default). Only DALL-E models need it. The handler checks `model.startswith("dall-e")` before adding it.
   - Runway endpoint URL: The production URL is `api.dev.runwayml.com` (not `api.runwayml.com`). The `.dev` is not a staging environment -- it's the actual production API.
   - `settings.json` comma: Trailing commas in JSON cause silent parse failures. The backend's `save_settings` uses `json.dump` which never writes trailing commas, but manual edits can break it.
   - OpenRouter image generation: Images come from `choices[0].message.images[]`, NOT from the standard OpenAI `data[].b64_json` location. Requires a separate code path.
   - Gemini API key in URL: Unlike other providers that use `Authorization` headers, Gemini passes the API key as a `?key=` query parameter.
8. **Key design decisions and why**:
   - Manual execution by default (prevents accidental API spend)
   - Outputs persist through undo (you never lose generated content)
   - UUID regeneration on paste (prevents graph corruption)
   - Pre-configured FAL nodes for Kling/Sora (avoids writing new handlers when the universal handler already works)
   - File-based persistence over SQLite (simpler for MVP, no migrations, human-readable)
9. **Best practices demonstrated**:
   - Separation of execution patterns into reusable runners (sync, stream, async-poll)
   - Generic `AsyncPollConfig` and `StreamConfig` that parameterize the polling/streaming behavior per-provider
   - WebSocket for real-time events instead of polling
   - Zustand's `get()` pattern for accessing current state inside actions without stale closures
10. **What comes next** -- SQLite execution cache, more model nodes, auto-run mode, batch execution

This file should be written engagingly, not as boring documentation. Use clear section headers and explain the "why" behind decisions, not just the "what."

---

## Execution Order

Tasks can be parallelized as follows:

```
Wave 1 (no dependencies):
  Task 1 (undo/redo) + Task 5 (utility nodes) + Task 6 (model definitions)
  These modify different files and can be built in parallel.

Wave 2 (depends on Wave 1):
  Task 2 (keyboard shortcuts) -- depends on Task 1 (undo/redo methods exist)
  Task 3 (copy/paste) -- depends on Task 1 (clipboard in graphStore)
  Task 4 (API key badge) -- independent but easier after Task 6 adds new node defs

Wave 3 (depends on all code being complete):
  Task 7 (README) -- needs final model list and feature set
  Task 8 (FORjustin.md) -- needs the full build to be done
```

**Estimated effort:** Tasks 1-6 are implementation work (~4-6 hours total). Tasks 7-8 are documentation (~1 hour).

---

## Verification Checklist

After all tasks are complete, verify:

- [ ] Ctrl+Z undoes the last action (add, delete, connect, param change)
- [ ] Ctrl+Shift+Z redoes the undone action
- [ ] Undo after a node has been executed does NOT remove the output preview
- [ ] Ctrl+A selects all nodes on canvas
- [ ] Ctrl+D duplicates all selected nodes with new IDs and 20px offset
- [ ] Ctrl+C copies selected nodes; Ctrl+V pastes with new UUIDs
- [ ] Pasted nodes have cleared outputs and idle state
- [ ] Pasted edges point to the new (remapped) node IDs
- [ ] Dropping a node with a missing API key shows the warning badge
- [ ] Adding the missing key in Settings and saving removes the badge
- [ ] combine-text node joins inputs with separator or fills a template
- [ ] router node passes input to all three outputs
- [ ] reroute node renders as a small dot and passes data through
- [ ] DALL-E 3 node generates images via the existing OpenAI handler
- [ ] GPT-4o node streams text responses
- [ ] Gemini node streams text responses
- [ ] Imagen 4 node generates images
- [ ] Kling v2.1 node submits to FAL and returns video
- [ ] Sora 2 node submits to FAL and returns video
- [ ] All new backend handlers have passing tests for error cases
- [ ] README.md is accurate and contains no API keys
- [ ] FORjustin.md explains the architecture engagingly
