# Milestone 4A: Settings, UX & Save/Load — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the biggest UX gaps — a Settings panel for API key management (no more hand-editing settings.json), right-click context menu with per-node execution, Save/Load of graph files as `.nebula` JSON, an inline text-input textarea in the node body, and Ctrl+Enter keyboard shortcut for Run. After this milestone the app feels like a real tool, not a prototype.

**Architecture:** The Settings panel is a floating draggable panel (same system as NodeLibrary/Inspector) that reads from `GET /api/settings` on open and writes via `PUT /api/settings` on save. The backend's existing masking logic (`***` + last 4 chars) is preserved — the PUT endpoint already merges only non-masked values, so no backend changes are needed. Save/Load uses the File System Access API (`showSaveFilePicker`/`showOpenFilePicker`) for native OS file dialogs, serializing the React Flow graph state to a versioned `.nebula` JSON format. Per-node execution adds a single new backend endpoint (`POST /api/execute-node`) that computes the ancestor subgraph via reverse edge traversal and runs only those nodes. The context menu is a positioned overlay rendered in Canvas, dismissed on outside click or Escape.

**Tech Stack:** Python 3.12+, FastAPI, Pydantic v2, Vite dev proxy, React 19, @xyflow/react, Zustand, TypeScript

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md` (Section 4.6 for context menus)
- Milestone 3 plan: `docs/superpowers/plans/2026-04-13-milestone-3-output-and-patterns.md`

---

## File Structure (new and modified files)

```
nebula_nodes/
├── backend/
│   ├── main.py                                # MODIFY: add POST /api/execute-node endpoint
│   ├── execution/
│   │   └── engine.py                          # MODIFY: add get_subgraph() function
│   └── models/
│       └── graph.py                           # MODIFY: add ExecuteNodeRequest model
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                            # MODIFY: render Settings panel + ContextMenu
│   │   ├── lib/
│   │   │   ├── api.ts                         # MODIFY: add executeNode() function
│   │   │   └── graphFile.ts                   # NEW: serialize/deserialize/save/load .nebula files
│   │   ├── store/
│   │   │   ├── graphStore.ts                  # MODIFY: add loadGraph, clearGraph, executeNode, duplicateNode
│   │   │   └── uiStore.ts                     # MODIFY: add settings panel state + context menu state
│   │   ├── components/
│   │   │   ├── Canvas.tsx                     # MODIFY: context menu handler, keyboard shortcuts
│   │   │   ├── ContextMenu.tsx                # NEW: right-click context menu component
│   │   │   ├── nodes/
│   │   │   │   └── ModelNode.tsx              # MODIFY: inline textarea for text-input nodes
│   │   │   └── panels/
│   │   │       ├── Toolbar.tsx                # MODIFY: wire Settings button, add Save/Load
│   │   │       └── Settings.tsx               # NEW: floating Settings panel
│   │   └── styles/
│   │       ├── panels.css                     # MODIFY: settings + context menu styles
│   │       └── nodes.css                      # MODIFY: inline textarea styles
```

---

## Task 1: Settings Panel (Frontend Only — Backend Already Done)

**Files:**
- Create: `frontend/src/components/panels/Settings.tsx`
- Modify: `frontend/src/store/uiStore.ts`
- Modify: `frontend/src/components/panels/Toolbar.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/panels.css`

### Estimated time: 25 minutes

- [ ] **Step 1: Add settings panel state to uiStore**

In `frontend/src/store/uiStore.ts`, add `settings` to the panels record and update all types/implementations:

```typescript
import { create } from 'zustand';

interface PanelState {
  visible: boolean;
  position: { x: number; y: number };
}

interface UIState {
  selectedNodeId: string | null;
  panels: {
    library: PanelState;
    inspector: PanelState;
    settings: PanelState;
  };
  librarySearch: string;

  selectNode: (nodeId: string | null) => void;
  togglePanel: (panel: 'library' | 'inspector' | 'settings') => void;
  setPanelPosition: (panel: 'library' | 'inspector' | 'settings', position: { x: number; y: number }) => void;
  setLibrarySearch: (search: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedNodeId: null,
  panels: {
    library: { visible: true, position: { x: 16, y: 16 } },
    inspector: { visible: false, position: { x: -280, y: 16 } },
    settings: { visible: false, position: { x: -340, y: 60 } },
  },
  librarySearch: '',

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: nodeId !== null },
      },
    })),

  togglePanel: (panel) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], visible: !state.panels[panel].visible },
      },
    })),

  setPanelPosition: (panel, position) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], position },
      },
    })),

  setLibrarySearch: (search) => set({ librarySearch: search }),
}));
```

- [ ] **Step 2: Create Settings.tsx**

Create `frontend/src/components/panels/Settings.tsx`:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { getSettings, updateSettings } from '../../lib/api';
import '../../styles/panels.css';

interface ApiKeyField {
  key: string;
  label: string;
  placeholder: string;
}

const API_KEY_FIELDS: ApiKeyField[] = [
  { key: 'OPENAI_API_KEY', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'FAL_KEY', label: 'fal.ai', placeholder: 'fal_...' },
  { key: 'BFL_API_KEY', label: 'Black Forest Labs', placeholder: 'bfl-...' },
  { key: 'RUNWAY_API_KEY', label: 'Runway', placeholder: 'key_...' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', placeholder: 'el_...' },
];

interface RoutingOption {
  provider: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

const ROUTING_OPTIONS: RoutingOption[] = [
  {
    provider: 'flux',
    label: 'FLUX Routing',
    options: [
      { value: 'fal', label: 'fal.ai (default)' },
      { value: 'bfl', label: 'BFL Direct' },
    ],
  },
];

export function Settings() {
  const visible = useUIStore((s) => s.panels.settings.visible);
  const position = useUIStore((s) => s.panels.settings.position);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [outputPath, setOutputPath] = useState('');
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loading, setLoading] = useState(false);

  // Load settings when panel opens
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    getSettings()
      .then((data) => {
        const settings = data as {
          apiKeys?: Record<string, string>;
          routing?: Record<string, string>;
          outputPath?: string;
        };
        setApiKeys(settings.apiKeys ?? {});
        setRouting(settings.routing ?? {});
        setOutputPath(settings.outputPath ?? '');
        setRevealedKeys(new Set());
        setSaveStatus('idle');
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
      })
      .finally(() => setLoading(false));
  }, [visible]);

  // Dragging logic (same pattern as Inspector)
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('settings', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  const handleSave = useCallback(async () => {
    setSaveStatus('saving');
    try {
      await updateSettings({ apiKeys, routing, outputPath: outputPath || null });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [apiKeys, routing, outputPath]);

  const toggleReveal = useCallback((key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  if (!visible) return null;

  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;

  return (
    <div className="panel" style={{ left: resolvedX, top: position.y, width: 320 }}>
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panelX: resolvedX,
            panelY: position.y,
          };
        }}
      >
        <span className="panel__title">Settings</span>
        <button className="panel__close" onClick={() => togglePanel('settings')}>
          &times;
        </button>
      </div>

      <div className="panel__body">
        {loading ? (
          <div style={{ color: '#666', textAlign: 'center', padding: 16 }}>Loading...</div>
        ) : (
          <>
            {/* API Keys Section */}
            <div className="settings__section-label">API Keys</div>
            {API_KEY_FIELDS.map((field) => (
              <div key={field.key} className="settings__key-row">
                <div className="inspector__label">{field.label}</div>
                <div className="settings__key-input-wrapper">
                  <input
                    className="inspector__field settings__key-input"
                    type={revealedKeys.has(field.key) ? 'text' : 'password'}
                    value={apiKeys[field.key] ?? ''}
                    onChange={(e) =>
                      setApiKeys((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="settings__reveal-button"
                    onClick={() => toggleReveal(field.key)}
                    title={revealedKeys.has(field.key) ? 'Hide' : 'Show'}
                    type="button"
                  >
                    {revealedKeys.has(field.key) ? '\u{1F441}' : '\u25CF'}
                  </button>
                </div>
              </div>
            ))}

            {/* Routing Section */}
            {ROUTING_OPTIONS.length > 0 && (
              <>
                <div className="settings__section-label" style={{ marginTop: 16 }}>
                  Routing
                </div>
                {ROUTING_OPTIONS.map((opt) => (
                  <div key={opt.provider} className="inspector__section">
                    <div className="inspector__label">{opt.label}</div>
                    <select
                      className="inspector__field"
                      value={routing[opt.provider] ?? opt.options[0]?.value ?? ''}
                      onChange={(e) =>
                        setRouting((prev) => ({ ...prev, [opt.provider]: e.target.value }))
                      }
                    >
                      {opt.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </>
            )}

            {/* Output Path Section */}
            <div className="settings__section-label" style={{ marginTop: 16 }}>
              Output
            </div>
            <div className="inspector__section">
              <div className="inspector__label">Output Path</div>
              <input
                className="inspector__field"
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="Default: ./output"
              />
            </div>

            {/* Save Button */}
            <button
              className="settings__save-button"
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
            >
              {saveStatus === 'saving'
                ? 'Saving...'
                : saveStatus === 'saved'
                  ? 'Saved'
                  : saveStatus === 'error'
                    ? 'Error — Retry'
                    : 'Save Settings'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add settings CSS to panels.css**

Append to `frontend/src/styles/panels.css`:

```css
/* ---------- Settings panel ---------- */

.settings__section-label {
  font-size: 10px;
  text-transform: uppercase;
  color: #888;
  font-weight: 600;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  padding-top: 4px;
  border-top: 1px solid #2a2a2a;
}

.settings__section-label:first-child {
  border-top: none;
  padding-top: 0;
}

.settings__key-row {
  margin-bottom: 10px;
}

.settings__key-input-wrapper {
  display: flex;
  gap: 4px;
  align-items: center;
}

.settings__key-input {
  flex: 1;
  font-family: monospace;
  font-size: 11px;
  letter-spacing: 0.5px;
}

.settings__reveal-button {
  background: #252525;
  border: 1px solid #333;
  border-radius: 4px;
  color: #666;
  cursor: pointer;
  padding: 5px 7px;
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.1s;
}

.settings__reveal-button:hover {
  color: #ccc;
}

.settings__save-button {
  width: 100%;
  margin-top: 16px;
  padding: 8px 0;
  background: #252525;
  border: 1px solid #444;
  border-radius: 6px;
  color: #ccc;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.settings__save-button:hover {
  background: #333;
  border-color: #555;
}

.settings__save-button:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 4: Wire the Settings button in Toolbar**

In `frontend/src/components/panels/Toolbar.tsx`, replace the settings button alert with the panel toggle:

Replace:
```typescript
<button className="toolbar__button" onClick={() => alert('Settings not yet implemented \u2014 coming in Milestone 4')} title="Settings">{'\u2699'}</button>
```

With:
```typescript
<button className="toolbar__button" onClick={() => togglePanel('settings')} title="Settings">{'\u2699'}</button>
```

- [ ] **Step 5: Render Settings in App.tsx**

In `frontend/src/App.tsx`, import and render the Settings panel:

```typescript
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Inspector } from './components/panels/Inspector';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
import './App.css';

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
      <NodeLibrary />
      <Inspector />
      <Settings />
      <Toolbar />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 6: Manual verification**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit
```

Start dev server, click the gear icon in toolbar, verify:
1. Settings panel opens as a draggable floating panel
2. API key fields load with masked values from backend
3. Typing a new key and clicking Save sends PUT to `/api/settings`
4. Reveal toggle switches between password/text input type
5. Panel dismisses on close button click

- [ ] **Step 7: Commit**

```
feat(frontend): add floating Settings panel for API key management and routing
```

---

## Task 2: Context Menu with Per-Node Run

**Files:**
- Create: `frontend/src/components/ContextMenu.tsx`
- Modify: `frontend/src/components/Canvas.tsx`
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/store/uiStore.ts`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/styles/panels.css`
- Modify: `backend/main.py`
- Modify: `backend/execution/engine.py`
- Modify: `backend/models/graph.py`

### Estimated time: 35 minutes

- [ ] **Step 1: Add get_subgraph to engine.py**

In `backend/execution/engine.py`, add this function after the `topological_sort` function (before `validate_graph`):

```python
def get_subgraph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    target_node_id: str,
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Return the subgraph of all ancestors of target_node_id (inclusive).

    Traverses edges in reverse (target -> source) to find every node that
    feeds into the target. Returns filtered lists of nodes and edges that
    belong to this subgraph.
    """
    # Build reverse adjacency: node_id -> set of upstream node_ids
    reverse_adj: dict[str, set[str]] = {n.id: set() for n in nodes}
    for edge in edges:
        if edge.target in reverse_adj:
            reverse_adj[edge.target].add(edge.source)

    # BFS from target node to find all ancestors
    needed: set[str] = set()
    queue = [target_node_id]
    while queue:
        nid = queue.pop()
        if nid in needed:
            continue
        needed.add(nid)
        for upstream in reverse_adj.get(nid, set()):
            if upstream not in needed:
                queue.append(upstream)

    node_map = {n.id: n for n in nodes}
    sub_nodes = [node_map[nid] for nid in needed if nid in node_map]
    sub_edges = [e for e in edges if e.source in needed and e.target in needed]
    return sub_nodes, sub_edges
```

- [ ] **Step 2: Add ExecuteNodeRequest to models/graph.py**

In `backend/models/graph.py`, add the new request model after `ExecuteRequest`:

```python
class ExecuteNodeRequest(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    target_node_id: str = Field(alias="targetNodeId")

    model_config = {"populate_by_name": True}
```

- [ ] **Step 3: Add POST /api/execute-node endpoint to main.py**

In `backend/main.py`, add the import for `get_subgraph` at the top:

Update the import line:
```python
from execution.engine import execute_graph, validate_graph, topological_sort, get_subgraph, CycleError
```

Add the import for `ExecuteNodeRequest`:
```python
from models import ExecuteRequest, ExecuteNodeRequest, ValidationErrorEvent
```

Wait — `ExecuteNodeRequest` needs to be exported from `models/__init__.py` too. Update `backend/models/__init__.py` to include:
```python
from .graph import GraphNode, GraphEdge, ExecuteRequest, ExecuteNodeRequest, PortValueDict
```

And add `"ExecuteNodeRequest"` to `__all__`.

Then add the endpoint after the existing `execute` endpoint in `main.py`:

```python
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
        await execute_graph(
            nodes=sub_nodes,
            edges=sub_edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=manager.broadcast,
            cache=execution_cache,
        )

    asyncio.create_task(_run())

    return {"status": "started", "nodeCount": len(sub_nodes)}
```

- [ ] **Step 4: Add executeNode to frontend api.ts**

In `frontend/src/lib/api.ts`, add:

```typescript
export async function executeNode(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle: string | null | undefined; target: string; targetHandle: string | null | undefined }>,
  targetNodeId: string,
): Promise<{ status: string; nodeCount?: number; errorCount?: number }> {
  const response = await fetch(`${API_BASE}/execute-node`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, targetNodeId }),
  });
  if (!response.ok) throw new Error(`Execute node failed: ${response.status} ${response.statusText}`);
  return response.json();
}
```

- [ ] **Step 5: Add executeNode and duplicateNode actions to graphStore**

In `frontend/src/store/graphStore.ts`, add these imports at the top:

```typescript
import { executeNode as apiExecuteNode } from '../lib/api';
```

Add to the `GraphState` interface:

```typescript
  executeNode: (nodeId: string) => Promise<void>;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  loadGraph: (nodes: Node<NodeData>[], edges: Edge[]) => void;
  clearGraph: () => void;
```

Add these implementations inside the `create` call:

```typescript
  executeNode: async (nodeId) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    resetExecution();
    set({ isExecuting: true });
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
      const result = await apiExecuteNode(graphNodes, graphEdges, nodeId);
      if (result.status === 'validation_error') set({ isExecuting: false });
    } catch (err) {
      console.error('Failed to start node execution:', err);
      set({ isExecuting: false });
    }
  },

  duplicateNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: node.type,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      data: {
        ...node.data,
        state: 'idle' as const,
        outputs: {},
        error: undefined,
        progress: undefined,
        streamingText: undefined,
      },
    };
    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  deleteNode: (nodeId) => {
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    }));
  },

  loadGraph: (nodes, edges) => {
    set({ nodes, edges, isExecuting: false });
  },

  clearGraph: () => {
    set({ nodes: [], edges: [], isExecuting: false });
  },
```

- [ ] **Step 6: Add context menu state to uiStore**

In `frontend/src/store/uiStore.ts`, add context menu state to the interface and implementation:

Add to the `UIState` interface:

```typescript
  contextMenu: {
    visible: boolean;
    position: { x: number; y: number };
    nodeId: string | null;
  };
  showContextMenu: (position: { x: number; y: number }, nodeId: string | null) => void;
  hideContextMenu: () => void;
```

Add initial state:

```typescript
  contextMenu: {
    visible: false,
    position: { x: 0, y: 0 },
    nodeId: null,
  },
```

Add actions:

```typescript
  showContextMenu: (position, nodeId) =>
    set({
      contextMenu: { visible: true, position, nodeId },
    }),

  hideContextMenu: () =>
    set({
      contextMenu: { visible: false, position: { x: 0, y: 0 }, nodeId: null },
    }),
```

- [ ] **Step 7: Create ContextMenu.tsx**

Create `frontend/src/components/ContextMenu.tsx`:

```typescript
import { useEffect, useRef } from 'react';
import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import '../styles/panels.css';

interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

export function ContextMenu() {
  const { visible, position, nodeId } = useUIStore((s) => s.contextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const executeNode = useGraphStore((s) => s.executeNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideContextMenu();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        hideContextMenu();
      }
    }

    // Use setTimeout to avoid the same click that opened the menu from closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, hideContextMenu]);

  if (!visible || !nodeId) return null;

  const items: MenuItem[] = [
    {
      label: 'Run This Node',
      disabled: isExecuting,
      action: () => {
        executeNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      action: () => {
        duplicateNode(nodeId);
        hideContextMenu();
      },
    },
    {
      label: 'Delete',
      shortcut: 'Del',
      danger: true,
      action: () => {
        deleteNode(nodeId);
        hideContextMenu();
      },
    },
  ];

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu__item ${item.danger ? 'context-menu__item--danger' : ''}`}
          onClick={item.action}
          disabled={item.disabled}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Add context menu CSS to panels.css**

Append to `frontend/src/styles/panels.css`:

```css
/* ---------- Context menu ---------- */

.context-menu {
  position: fixed;
  z-index: 20;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  min-width: 180px;
  padding: 4px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
}

.context-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: 4px;
  color: #ccc;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  transition: background 0.1s;
}

.context-menu__item:hover {
  background: #252525;
}

.context-menu__item:disabled {
  opacity: 0.4;
  cursor: default;
}

.context-menu__item--danger:hover {
  background: rgba(244, 67, 54, 0.15);
  color: #F44336;
}

.context-menu__shortcut {
  color: #555;
  font-size: 11px;
  margin-left: 16px;
}
```

- [ ] **Step 9: Wire context menu into Canvas.tsx**

In `frontend/src/components/Canvas.tsx`, add the context menu handler and render the component:

```typescript
import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useIsValidConnection } from '../hooks/useIsValidConnection';
import { ModelNode } from './nodes/ModelNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './ContextMenu';
import '../styles/canvas.css';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
};

const edgeTypes: EdgeTypes = {
  'typed-edge': TypedEdge,
};

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isValidConnection = useIsValidConnection();
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const definitionId = event.dataTransfer.getData('application/nebula-node');
      if (!definitionId) return;

      const reactFlowBounds = (event.target as HTMLElement)
        .closest('.react-flow')
        ?.getBoundingClientRect();
      if (!reactFlowBounds) return;

      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      };

      useGraphStore.getState().addNode(definitionId, position);
    },
    []
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: { id: string }) => {
      event.preventDefault();
      showContextMenu({ x: event.clientX, y: event.clientY }, node.id);
    },
    [showContextMenu]
  );

  const onPaneClick = useCallback(() => {
    hideContextMenu();
  }, [hideContextMenu]);

  // Keyboard shortcuts: Ctrl+Enter to run, Ctrl+S to save, Ctrl+O to load
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      // Ctrl+Enter — Run graph
      if (isCtrlOrCmd && event.key === 'Enter' && !isExecuting) {
        event.preventDefault();
        executeGraph();
        return;
      }

      // Ctrl+S — Save graph
      if (isCtrlOrCmd && event.key === 's') {
        event.preventDefault();
        // Dispatched as custom event — picked up by the save handler registered in Task 3
        window.dispatchEvent(new CustomEvent('nebula:save'));
        return;
      }

      // Ctrl+O — Load graph
      if (isCtrlOrCmd && event.key === 'o') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('nebula:load'));
        return;
      }
    },
    [executeGraph, isExecuting]
  );

  return (
    <div className="canvas-wrapper" onKeyDown={onKeyDown} tabIndex={0}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        fitView
        minZoom={0.1}
        maxZoom={4}
        defaultEdgeOptions={{ type: 'typed-edge' }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        selectionOnDrag
        panOnScroll={false}
        selectionMode={1}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={32}
          size={1}
          color="rgba(255, 255, 255, 0.04)"
        />
      </ReactFlow>
      <ContextMenu />
    </div>
  );
}
```

- [ ] **Step 10: Render ContextMenu in App.tsx**

The `ContextMenu` is already rendered inside `Canvas` (Step 9), so no App.tsx change needed for this. But update `App.tsx` to keep it clean (it was updated in Task 1 Step 5 for Settings).

- [ ] **Step 11: Verify backend compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from models.graph import ExecuteNodeRequest
req = ExecuteNodeRequest(nodes=[], edges=[], targetNodeId='abc')
print(req.target_node_id)
# Expected: abc
"
```

- [ ] **Step 12: Verify frontend compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit
```

- [ ] **Step 13: Manual verification**

1. Right-click a node on canvas — context menu appears at cursor position
2. Click "Run This Node" — only the subgraph upstream of that node executes
3. Click "Duplicate" — a copy appears offset 20px
4. Click "Delete" — node and its edges are removed
5. Click elsewhere or press Escape — context menu dismisses
6. Ctrl+Enter runs the full graph

- [ ] **Step 14: Commit**

```
feat: add context menu with per-node run, duplicate, delete + Ctrl+Enter shortcut
```

---

## Task 3: Save/Load Graph as .nebula JSON

**Files:**
- Create: `frontend/src/lib/graphFile.ts`
- Modify: `frontend/src/store/graphStore.ts` (already updated in Task 2 Step 5 — `loadGraph` and `clearGraph` are added there)
- Modify: `frontend/src/components/panels/Toolbar.tsx`
- Modify: `frontend/src/components/Canvas.tsx` (already wired in Task 2 Step 9 — Ctrl+S/O dispatch custom events)

### Estimated time: 20 minutes

- [ ] **Step 1: Create graphFile.ts**

Create `frontend/src/lib/graphFile.ts`:

```typescript
import type { Node, Edge, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/**
 * .nebula file format — versioned JSON for graph persistence.
 *
 * Design decisions:
 * - Outputs and execution state are stripped on save (don't persist generated images)
 * - Node state is reset to 'idle' on save
 * - Version field allows future format migrations
 * - Viewport is optional (defaults to fit-all on load)
 */

export interface NebulaFile {
  version: 1;
  name: string;
  createdAt: string;
  nodes: NebulaNode[];
  edges: NebulaEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

interface NebulaNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    definitionId: string;
    params: Record<string, unknown>;
  };
}

interface NebulaEdge {
  id: string;
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Serialize current graph state to .nebula format.
 * Strips outputs, errors, progress, streaming state — only persists structure + params.
 */
export function serializeGraph(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
  name?: string,
): NebulaFile {
  return {
    version: 1,
    name: name ?? 'Untitled Graph',
    createdAt: new Date().toISOString(),
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? 'model-node',
      position: { x: n.position.x, y: n.position.y },
      data: {
        label: n.data.label,
        definitionId: n.data.definitionId,
        params: { ...n.data.params },
      },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      type: e.type ?? 'typed-edge',
      data: e.data ? { ...e.data } : undefined,
    })),
    viewport: viewport
      ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
      : undefined,
  };
}

/**
 * Deserialize a .nebula file back into React Flow nodes and edges.
 * Validates that node definitions exist. Unknown nodes get a warning but are still loaded.
 * State is always reset to 'idle', outputs are empty.
 */
export function deserializeGraph(
  file: NebulaFile,
): { nodes: Node<NodeData>[]; edges: Edge[]; viewport?: Viewport; warnings: string[] } {
  const warnings: string[] = [];

  const nodes: Node<NodeData>[] = file.nodes.map((n) => {
    const definition = NODE_DEFINITIONS[n.data.definitionId];
    if (!definition) {
      warnings.push(`Unknown node definition: "${n.data.definitionId}" (node ${n.id})`);
    }
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        label: n.data.label,
        definitionId: n.data.definitionId,
        params: n.data.params,
        state: 'idle' as const,
        outputs: {},
      },
    };
  });

  const edges: Edge[] = file.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    type: e.type,
    data: e.data,
  }));

  const viewport = file.viewport
    ? { x: file.viewport.x, y: file.viewport.y, zoom: file.viewport.zoom }
    : undefined;

  return { nodes, edges, viewport, warnings };
}

/**
 * Save graph to a file using the File System Access API.
 * Falls back to download-link approach if the API is not available.
 */
export async function saveToFile(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
): Promise<void> {
  const file = serializeGraph(nodes, edges, viewport);
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  // Try File System Access API first (Chrome/Edge)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (opts: {
          suggestedName: string;
          types: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
        }) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula`,
        types: [
          {
            description: 'Nebula Node Graph',
            accept: { 'application/json': ['.nebula'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User cancelled the picker — this is expected, not an error
      if ((err as DOMException).name === 'AbortError') return;
      console.warn('File System Access API failed, falling back to download:', err);
    }
  }

  // Fallback: download via <a> tag
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Load graph from a file using the File System Access API.
 * Falls back to <input type="file"> if the API is not available.
 * Returns the deserialized result, or null if the user cancelled.
 */
export async function loadFromFile(): Promise<{
  nodes: Node<NodeData>[];
  edges: Edge[];
  viewport?: Viewport;
  warnings: string[];
} | null> {
  let text: string;

  // Try File System Access API first
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (opts: {
          types: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
          multiple: boolean;
        }) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [
          {
            description: 'Nebula Node Graph',
            accept: { 'application/json': ['.nebula', '.json'] },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      text = await file.text();
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      console.warn('File System Access API failed, falling back to input:', err);
      text = await loadViaInput();
      if (!text) return null;
    }
  } else {
    text = await loadViaInput();
    if (!text) return null;
  }

  try {
    const parsed = JSON.parse(text) as NebulaFile;

    // Basic validation
    if (parsed.version !== 1) {
      throw new Error(`Unsupported .nebula file version: ${parsed.version}`);
    }
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('Invalid .nebula file: missing nodes or edges arrays');
    }

    return deserializeGraph(parsed);
  } catch (err) {
    console.error('Failed to parse .nebula file:', err);
    alert(`Failed to load graph: ${(err as Error).message}`);
    return null;
  }
}

/** Fallback file picker using a hidden <input> element. */
function loadViaInput(): Promise<string> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nebula,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve('');
        return;
      }
      const text = await file.text();
      resolve(text);
    };
    // If the user cancels, onchange never fires — resolve empty after timeout
    input.oncancel = () => resolve('');
    input.click();
  });
}
```

- [ ] **Step 2: Add Save/Load buttons to Toolbar**

In `frontend/src/components/panels/Toolbar.tsx`, import the graph file utilities and wire up save/load:

```typescript
import { useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { saveToFile, loadFromFile } from '../../lib/graphFile';
import type { NodeData } from '../../types';
import type { Node } from '@xyflow/react';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView, getViewport } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const resetExecution = useGraphStore((s) => s.resetExecution);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const handleSave = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState();
    const viewport = getViewport();
    await saveToFile(nodes as Node<NodeData>[], edges, viewport);
  }, [getViewport]);

  const handleLoad = useCallback(async () => {
    const result = await loadFromFile();
    if (!result) return; // User cancelled

    if (result.warnings.length > 0) {
      console.warn('[nebula] Load warnings:', result.warnings);
    }

    useGraphStore.getState().loadGraph(
      result.nodes as Node<NodeData>[],
      result.edges,
    );

    // Fit to loaded graph after a tick
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
  }, [fitView]);

  // Listen for custom events from keyboard shortcuts (Ctrl+S, Ctrl+O)
  useEffect(() => {
    function onSave() {
      handleSave();
    }
    function onLoad() {
      handleLoad();
    }
    window.addEventListener('nebula:save', onSave);
    window.addEventListener('nebula:load', onLoad);
    return () => {
      window.removeEventListener('nebula:save', onSave);
      window.removeEventListener('nebula:load', onLoad);
    };
  }, [handleSave, handleLoad]);

  return (
    <div className="toolbar">
      {isExecuting ? (
        <button
          className="toolbar__button"
          onClick={() => resetExecution()}
          title="Cancel execution"
        >
          &#x25A0; Stop
        </button>
      ) : (
        <button
          className="toolbar__button"
          onClick={() => executeGraph()}
          disabled={nodeCount === 0}
          title="Run graph (Ctrl+Enter)"
        >
          {'\u25B6 Run'}
        </button>
      )}
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={handleSave} title="Save graph (Ctrl+S)">Save</button>
      <button className="toolbar__button" onClick={handleLoad} title="Load graph (Ctrl+O)">Load</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="Fit to screen">Fit</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('library')} title="Toggle node library">Nodes</button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('settings')} title="Settings">{'\u2699'}</button>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit
```

- [ ] **Step 4: Manual verification**

1. Add several nodes and edges to the canvas
2. Click "Save" in toolbar — OS file picker appears, default extension is `.nebula`
3. Save the file, verify JSON contents have version: 1, nodes with params, no outputs
4. Click "Load" — OS file picker appears, select the saved file
5. Graph loads correctly — all nodes, edges, positions, params restored
6. Node states are 'idle', no outputs shown
7. Ctrl+S triggers save, Ctrl+O triggers load
8. Try loading a malformed JSON file — error alert appears, graph unchanged

- [ ] **Step 5: Commit**

```
feat(frontend): add Save/Load for .nebula graph files with File System Access API
```

---

## Task 4: Ctrl+Enter Keyboard Shortcut for Run

This is already implemented as part of Task 2, Step 9 in the Canvas.tsx keyboard handler.

The `onKeyDown` handler in Canvas includes:

```typescript
if (isCtrlOrCmd && event.key === 'Enter' && !isExecuting) {
  event.preventDefault();
  executeGraph();
  return;
}
```

The `tabIndex={0}` on the `.canvas-wrapper` div ensures the container can receive keyboard focus. The Toolbar already shows the `(Ctrl+Enter)` hint in the Run button title.

- [ ] **Step 1: Verify the shortcut works**

1. Click anywhere on the canvas to focus it
2. Press Ctrl+Enter (or Cmd+Enter on Mac)
3. Graph execution starts — same as clicking Run button
4. While executing, Ctrl+Enter does nothing (isExecuting guard)

No separate commit needed — this shipped with Task 2.

---

## Task 5: Text Input Inline Editing

**Files:**
- Modify: `frontend/src/components/nodes/ModelNode.tsx`
- Modify: `frontend/src/styles/nodes.css`

### Estimated time: 12 minutes

- [ ] **Step 1: Add inline textarea to ModelNode for text-input nodes**

In `frontend/src/components/nodes/ModelNode.tsx`, add inline textarea rendering for text-input nodes. The key behavior: the textarea appears directly in the node body (below the header, above the output port) and edits the `value` param in real time.

Replace the full component with:

```typescript
import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/nodes.css';

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const selectNode = useUIStore((s) => s.selectNode);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Stop propagation to prevent ReactFlow from intercepting the event
      e.stopPropagation();
      updateNodeData(id, {
        params: { ...nodeData.params, value: e.target.value },
      });
    },
    [id, nodeData.params, updateNodeData]
  );

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);

  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;
  const isTextInput = nodeData.definitionId === 'text-input';

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#x26A0;</span>}
      </div>

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle type="target" position={Position.Left} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Inline textarea for text-input nodes */}
      {isTextInput && (
        <div className="model-node__inline-textarea">
          <textarea
            className="model-node__textarea nodrag nowheel"
            value={String(nodeData.params.value ?? '')}
            onChange={handleTextChange}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Enter text or prompt..."
            rows={4}
            spellCheck={false}
          />
        </div>
      )}

      {nodeData.state === 'executing' && nodeData.progress !== undefined && (
        <div className="model-node__progress">
          <div className="model-node__progress-bar" style={{ width: `${Math.round(nodeData.progress * 100)}%` }} />
        </div>
      )}

      {nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string' && (
        <div className="model-node__preview">
          <img src={imageOutput.value} alt="Generated output" className="model-node__preview-image" loading="lazy" />
        </div>
      )}

      {displayText && !isTextInput && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'complete' && videoOutput && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Video ready</div>
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && Object.keys(nodeData.outputs).length > 0 && (
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
              <Handle type="source" position={Position.Right} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
```

Key implementation details:
- The `nodrag` and `nowheel` CSS classes are React Flow conventions — they tell React Flow not to intercept drag/scroll events on this element, so the textarea can be interacted with normally.
- `onMouseDown` and `onKeyDown` call `stopPropagation()` to prevent React Flow from consuming those events (which would move the node or trigger shortcuts).
- The textarea only renders for `text-input` nodes — all other nodes are unaffected.
- The text output preview (`displayText`) is hidden for text-input nodes to avoid showing the same text twice.

- [ ] **Step 2: Add inline textarea CSS to nodes.css**

Append to `frontend/src/styles/nodes.css`:

```css
/* ---------- Inline textarea (text-input nodes) ---------- */

.model-node__inline-textarea {
  padding: 6px 8px;
  border-top: 1px solid #2a2a2a;
}

.model-node__textarea {
  width: 100%;
  min-height: 72px;
  max-height: 200px;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 8px;
  color: #ccc;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: #333 transparent;
}

.model-node__textarea:focus {
  border-color: #555;
}

.model-node__textarea::placeholder {
  color: #444;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit
```

- [ ] **Step 4: Manual verification**

1. Drop a "Text Input" node onto the canvas
2. The textarea appears directly in the node body
3. Click into the textarea — cursor appears, can type freely
4. Typing does NOT drag the node (nodrag class working)
5. Scrolling inside the textarea does NOT zoom the canvas (nowheel class working)
6. Text is persisted in `params.value` — visible in Inspector too
7. Connect the text-input to a Claude node's Messages port, run — the text flows through

- [ ] **Step 5: Commit**

```
feat(frontend): add inline textarea to text-input nodes for direct editing in canvas
```

---

## Task 6: Integration Verification

### Estimated time: 10 minutes

- [ ] **Step 1: Run backend tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/ -v
```

Expected: All existing tests pass. The new `get_subgraph` function and `ExecuteNodeRequest` model don't break anything.

- [ ] **Step 2: Run frontend type check**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Full integration test checklist**

Run both servers:
```bash
# Terminal 1
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run dev
```

Test each feature:

| # | Test | Expected |
|---|------|----------|
| 1 | Click gear icon in toolbar | Settings panel opens as draggable floating panel |
| 2 | API key fields show masked values | Values from settings.json appear as `***xxxx` |
| 3 | Paste a new key, click Save | Settings saved, key persists on panel reopen |
| 4 | Close and reopen settings panel | Previously saved values load correctly |
| 5 | Right-click a node | Context menu appears at cursor |
| 6 | Click "Run This Node" | Only upstream subgraph executes |
| 7 | Click "Duplicate" | Copy appears at offset position |
| 8 | Click "Delete" | Node and edges removed |
| 9 | Click empty canvas or press Esc | Context menu dismisses |
| 10 | Press Ctrl+Enter with nodes on canvas | Full graph executes |
| 11 | Click "Save" in toolbar | File picker opens, saves .nebula file |
| 12 | Click "Load" in toolbar | File picker opens, loads graph from .nebula |
| 13 | Press Ctrl+S | Triggers save (same as toolbar Save) |
| 14 | Press Ctrl+O | Triggers load (same as toolbar Load) |
| 15 | Drop text-input node | Inline textarea appears in node body |
| 16 | Type in inline textarea | Text appears, node doesn't drag |
| 17 | Connect text-input to Claude, Ctrl+Enter | Text flows through, Claude responds |

- [ ] **Step 4: Final commit**

```
chore: milestone 4a integration verification — all features working
```

---

## Summary of Changes

| Area | Files Modified | Files Created |
|------|---------------|---------------|
| Backend | `main.py`, `execution/engine.py`, `models/graph.py`, `models/__init__.py` | — |
| Frontend Store | `store/graphStore.ts`, `store/uiStore.ts` | — |
| Frontend Components | `Canvas.tsx`, `ModelNode.tsx`, `Toolbar.tsx`, `App.tsx` | `ContextMenu.tsx`, `Settings.tsx` |
| Frontend Lib | `api.ts` | `graphFile.ts` |
| Styles | `panels.css`, `nodes.css` | — |

**Total estimated time: ~1.5 hours**

**What this does NOT include** (deferred to later milestones):
- Combine-text node — separate utility node definition + handler (Milestone 4B)
- Recent files list — requires localStorage persistence layer (Milestone 4B)
- Bypass node feature in context menu — requires passthrough logic in engine (Milestone 4B)
- Canvas right-click context menu (add node at click position) — nice-to-have, not critical path
- Auto-run toggle in settings — requires execution mode change in engine (Milestone 5)
