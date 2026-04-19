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
import type { NodeData, DynamicNodeData, DynamicPortDefinition, DynamicParamDefinition, PortDataType } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import {
  executeGraph as apiExecuteGraph,
  executeNode as apiExecuteNode,
  fetchOpenRouterModels,
  fetchReplicateSchema,
  type OpenRouterModel,
} from '../lib/api';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';
import { useUIStore } from './uiStore';

// ---------------------------------------------------------------------------
// Undo/Redo types and helpers
// ---------------------------------------------------------------------------

interface UndoSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

const UNDO_CAP = 50;

/** Creates a snapshot with outputs/state stripped — only structure and params are stored. */
function createSnapshot(nodes: Node<NodeData>[], edges: Edge[]): UndoSnapshot {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      data: {
        ...n.data,
        params: { ...n.data.params },
        // Outputs deliberately excluded — they persist through undo
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

/**
 * Restores a snapshot but merges back outputs from the current live state.
 * If a node exists in both the snapshot and the live state, its outputs come
 * from the live state. If a node is being restored (was deleted), outputs are empty.
 */
function restoreWithOutputs(
  snapshot: UndoSnapshot,
  currentNodes: Node<NodeData>[],
): Node<NodeData>[] {
  const currentOutputs = new Map<
    string,
    {
      outputs: Record<string, { type: string; value: string | null }>;
      state: NodeData['state'];
      streamingText?: string;
    }
  >();
  for (const n of currentNodes) {
    if (Object.keys(n.data.outputs).length > 0) {
      currentOutputs.set(n.id, {
        outputs: n.data.outputs as Record<string, { type: string; value: string | null }>,
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
          outputs: preserved.outputs as NodeData['outputs'],
          state: preserved.state,
          streamingText: preserved.streamingText,
        },
      };
    }
    return n;
  });
}

/** Pushes current state onto the undo stack and clears the redo stack. */
function pushUndo(
  set: (partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>)) => void,
  get: () => GraphState,
): void {
  const { nodes, edges, undoStack } = get();
  const snapshot = createSnapshot(nodes, edges);
  const newStack = [...undoStack, snapshot];
  if (newStack.length > UNDO_CAP) newStack.shift();
  set({ undoStack: newStack, redoStack: [] });
}

// Debounce state for updateNodeData undo pushes
let lastUndoPush = 0;
let lastUndoNodeId = '';

/** Like pushUndo but debounces rapid param changes on the same node (500ms window). */
function maybePushUndo(
  set: (partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>)) => void,
  get: () => GraphState,
  nodeId?: string,
): void {
  const now = Date.now();
  if (nodeId && nodeId === lastUndoNodeId && now - lastUndoPush < 500) {
    return;
  }
  lastUndoPush = now;
  lastUndoNodeId = nodeId ?? '';
  pushUndo(set, get);
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isExecuting: boolean;

  // Undo/Redo
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  undo: () => void;
  redo: () => void;

  // Clipboard
  clipboard: { nodes: Node<NodeData>[]; edges: Edge[] } | null;
  copySelected: () => void;
  pasteClipboard: () => void;

  // Selection & batch ops
  selectAll: () => void;
  duplicateSelected: () => void;

  // Existing methods. addNode/addDynamicNode are async because static nodes
  // round-trip through cli_graph on the backend so Claude's `nebula graph` sees
  // them; they resolve to the short id (n1, n2, ...) on success, or a UUID on
  // backend failure (local-only fallback).
  addNode: (definitionId: string, position: { x: number; y: number }) => Promise<string | null>;
  addDynamicNode: (definitionId: string, position: { x: number; y: number }) => string | null;
  addNodeAndConnect: (
    definitionId: string,
    position: { x: number; y: number },
    connect: {
      source: string;
      sourceHandle: string;
      target: string;
      targetHandle: string;
      newNodeIs: 'source' | 'target';
    },
  ) => Promise<string | null>;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  executeGraph: () => Promise<void>;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
  executeNode: (nodeId: string) => Promise<void>;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  loadGraph: (nodes: Node<NodeData>[], edges: Edge[]) => void;
  clearGraph: () => void;
  configureOpenRouterModel: (nodeId: string, modelId: string, model: OpenRouterModel) => void;
  fetchReplicateSchemaAndConfigure: (nodeId: string, owner: string, name: string) => Promise<void>;
}

// CLI nodes use short sequential IDs like n1, n2. Frontend-only (library-dragged)
// nodes use UUIDs. This regex lets graphSync distinguish them so we can preserve
// frontend-only work when cli_graph changes.
const CLI_ID_RE = /^n\d+$/;

// Per-node timers for debounced param-sync to the backend. Keyed by node id
// so one node's typing never stalls another node's flush.
const paramPushTimers: Record<string, number> = {};
const PARAM_PUSH_DEBOUNCE_MS = 250;

wsClient.connect();
wsClient.subscribe((event) => {
  if (event.type === 'graphSync') {
    // Real-time sync: MERGE cli_graph into the canvas. Key invariant: frontend-only
    // nodes (library drags, undo'd results, etc.) must survive graphSync — only
    // cli-origin nodes are authoritative from the server. Same for edges.
    const { nodes: cliNodes, edges: cliEdges, empty } = event as {
      type: 'graphSync'; nodes: Node<NodeData>[]; edges: Edge[]; empty: boolean;
    };

    const state = useGraphStore.getState();

    if (empty) {
      // cli_graph was cleared — drop only cli-origin nodes/edges; keep frontend work.
      const remainingNodes = state.nodes.filter((n) => !CLI_ID_RE.test(n.id));
      const remainingIds = new Set(remainingNodes.map((n) => n.id));
      const remainingEdges = state.edges.filter(
        (e) => remainingIds.has(e.source) && remainingIds.has(e.target),
      );
      useGraphStore.setState({
        nodes: remainingNodes,
        edges: remainingEdges,
        isExecuting: false,
      });
      return;
    }

    const existingById = new Map(state.nodes.map((n) => [n.id, n]));
    const frontendOnlyNodes = state.nodes.filter((n) => !CLI_ID_RE.test(n.id));

    // Compute keyStatus for a node given its definition. Used for both new and
    // existing cli nodes so the "missing API key" badge shows up consistently.
    const { settingsCache } = useUIStore.getState();
    const keyStatusFor = (definitionId: string): 'missing' | undefined => {
      const def = NODE_DEFINITIONS[definitionId];
      if (!def?.envKeyName || !settingsCache.loaded) return undefined;
      const keyNames = Array.isArray(def.envKeyName) ? def.envKeyName : [def.envKeyName];
      if (keyNames.length === 0) return undefined;
      return keyNames.some((k) => Boolean(settingsCache.apiKeys[k])) ? undefined : 'missing';
    };

    const cliMerged = (cliNodes as Node<NodeData>[]).map((cliNode) => {
      const existing = existingById.get(cliNode.id);
      const keyStatus = keyStatusFor(cliNode.data.definitionId);
      if (existing) {
        // Preserve position (user may have dragged) and existing outputs when
        // the CLI side doesn't have newer ones. Spread existing.data FIRST so
        // frontend-only fields (dynamicInputPorts, dynamicParams, providerMeta,
        // modelId on universal nodes) survive the merge — cliNode.data then
        // overrides common keys like label/definitionId/params.
        const cliOutputs = cliNode.data?.outputs ?? {};
        const hasCliOutputs = Object.keys(cliOutputs).length > 0;
        return {
          ...cliNode,
          type: existing.type ?? cliNode.type,
          position: existing.position,
          data: {
            ...existing.data,
            ...cliNode.data,
            outputs: hasCliOutputs ? cliOutputs : existing.data.outputs,
            state: hasCliOutputs ? cliNode.data.state : existing.data.state,
            keyStatus,
          },
        };
      }
      // New cli node: trust the position the backend sent. It already handles
      // auto-layout for nodes without a stored position (Claude's `nebula
      // create`) and round-trips user-saved positions for imported graphs.
      return {
        ...cliNode,
        position: {
          x: cliNode.position?.x ?? 0,
          y: cliNode.position?.y ?? 100,
        },
        data: {
          ...cliNode.data,
          keyStatus,
        },
      };
    });

    const merged = [...frontendOnlyNodes, ...cliMerged];
    const mergedIds = new Set(merged.map((n) => n.id));

    // Preserve frontend-only edges whose endpoints are still present. We dedupe
    // by connection identity (source:handle -> target:handle) rather than edge
    // id because onConnect issues a UUID edge optimistically and the cli
    // version that comes back via graphSync has a different id. Using
    // connection identity means the cli edge wins silently.
    const edgeKey = (e: Edge): string =>
      `${e.source}:${e.sourceHandle ?? ''}->${e.target}:${e.targetHandle ?? ''}`;
    const cliEdgeKeys = new Set((cliEdges as Edge[]).map(edgeKey));
    const frontendOnlyEdges = state.edges.filter(
      (e) => !cliEdgeKeys.has(edgeKey(e)) && mergedIds.has(e.source) && mergedIds.has(e.target),
    );
    const mergedEdges = [...frontendOnlyEdges, ...cliEdges];

    useGraphStore.setState({
      nodes: merged,
      edges: mergedEdges,
      isExecuting: false,
    });

    // Only fire the auto-fit event when cli_graph actually added nodes we didn't
    // already have — otherwise every graphSync (including output updates) would
    // re-fit and steal the user's viewport.
    const newCliCount = cliMerged.filter((n) => !existingById.has(n.id)).length;
    if (newCliCount > 0) {
      window.dispatchEvent(
        new CustomEvent('nebula:graph-nodes-added', {
          detail: { addedCount: newCliCount, totalCount: merged.length },
        }),
      );
    }
    return;
  }
  useGraphStore.getState().handleExecutionEvent(event);
});

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: false,

  // ---------------------------------------------------------------------------
  // Undo/Redo initial state
  // ---------------------------------------------------------------------------
  undoStack: [],
  redoStack: [],
  clipboard: null,

  // ---------------------------------------------------------------------------
  // Undo/Redo actions
  // ---------------------------------------------------------------------------

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
    const { redoStack, nodes } = get();
    if (redoStack.length === 0) return;

    const nextSnapshot = redoStack[redoStack.length - 1];
    const currentSnapshot = createSnapshot(nodes, get().edges);
    const restoredNodes = restoreWithOutputs(nextSnapshot, nodes);

    set({
      nodes: restoredNodes,
      edges: nextSnapshot.edges,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, currentSnapshot],
    });
  },

  // ---------------------------------------------------------------------------
  // Clipboard: copy/paste with UUID regeneration
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Selection & batch operations
  // ---------------------------------------------------------------------------

  selectAll: () => {
    set((state) => ({
      nodes: state.nodes.map((n) => ({ ...n, selected: true })),
    }));
  },

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

  // ---------------------------------------------------------------------------
  // Node management
  // ---------------------------------------------------------------------------

  addNode: async (definitionId, position) => {
    const DYNAMIC_IDS = ['openrouter-universal', 'replicate-universal', 'fal-universal'];
    if (DYNAMIC_IDS.includes(definitionId)) {
      return get().addDynamicNode(definitionId, position);
    }
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

    // Build defaults from all param sources (shared + route-specific + legacy params)
    const defaults: Record<string, unknown> = {};
    const allParamSources = definition.sharedParams
      ? [...definition.sharedParams, ...(definition.falParams ?? []), ...(definition.directParams ?? [])]
      : definition.params;
    for (const param of allParamSources) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }

    // Push into cli_graph on the backend so `nebula graph` shows the node to
    // Claude. graphSync will bring it into the canvas with its cli short id.
    try {
      const res = await fetch('http://localhost:8000/api/graph/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params: defaults, position }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const node = (await res.json()) as { id?: string };
      return node.id ?? null;
    } catch (err) {
      console.warn('[nebula] addNode backend push failed — adding locally only:', err);
      // Fallback: frontend-only UUID node. Claude won't see it until the
      // backend comes back and /api/graph/import or equivalent is called.
      pushUndo(set, get);
      const nodeType = definitionId === 'reroute' ? 'reroute-node' : 'model-node';
      let keyStatus: 'missing' | undefined;
      const { settingsCache } = useUIStore.getState();
      if (settingsCache.loaded && definition.envKeyName) {
        const keyNames = Array.isArray(definition.envKeyName)
          ? definition.envKeyName
          : [definition.envKeyName];
        if (keyNames.length > 0 && !keyNames.some((k) => Boolean(settingsCache.apiKeys[k]))) {
          keyStatus = 'missing';
        }
      }
      const newNode: Node<NodeData> = {
        id: uuidv4(),
        type: nodeType,
        position,
        data: { label: definition.displayName, definitionId, params: defaults, state: 'idle', outputs: {}, keyStatus },
      };
      set((state) => ({ nodes: [...state.nodes, newNode] }));
      return newNode.id;
    }
  },

  addNodeAndConnect: async (definitionId, position, connect) => {
    // Like addNode but also wires the new node to an existing one atomically
    // on the backend. Used by ConnectionPopup, which otherwise races with
    // graphSync to find the new node's short id before connecting.
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

    const defaults: Record<string, unknown> = {};
    const allParamSources = definition.sharedParams
      ? [...definition.sharedParams, ...(definition.falParams ?? []), ...(definition.directParams ?? [])]
      : definition.params;
    for (const param of allParamSources) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }

    try {
      const res = await fetch('http://localhost:8000/api/graph/node-and-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params: defaults, position, connect }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const node = (await res.json()) as { id?: string };
      return node.id ?? null;
    } catch (err) {
      console.warn('[nebula] addNodeAndConnect backend push failed:', err);
      return null;
    }
  },

  addDynamicNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

    pushUndo(set, get);

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }

    const providerMap: Record<string, 'openrouter' | 'replicate' | 'fal'> = {
      'openrouter-universal': 'openrouter',
      'replicate-universal': 'replicate',
      'fal-universal': 'fal',
    };

    // Check API key status from settings cache
    let keyStatus: 'missing' | undefined;
    const { settingsCache } = useUIStore.getState();
    if (settingsCache.loaded && definition.envKeyName) {
      const keyNames = Array.isArray(definition.envKeyName)
        ? definition.envKeyName
        : [definition.envKeyName];
      if (keyNames.length > 0 && !keyNames.some((k) => Boolean(settingsCache.apiKeys[k]))) {
        keyStatus = 'missing';
      }
    }

    // Optimistic local node with dynamic fields (ports/params/provider meta).
    // We assign a UUID up front; if the backend push succeeds, we'll renumber
    // the node to the short id so Claude can reference it.
    const tempId = uuidv4();
    const buildNode = (id: string): Node<DynamicNodeData> => ({
      id,
      type: 'dynamic-node',
      position,
      data: {
        label: definition.displayName,
        definitionId,
        params: defaults,
        state: 'idle',
        outputs: {},
        keyStatus,
        isDynamic: true,
        providerType: providerMap[definitionId] ?? 'openrouter',
        dynamicInputPorts: definition.inputPorts.map((p) => ({
          id: p.id,
          label: p.label,
          dataType: p.dataType,
          required: p.required,
        })),
        dynamicOutputPorts: definition.outputPorts.map((p) => ({
          id: p.id,
          label: p.label,
          dataType: p.dataType,
          required: p.required,
        })),
        dynamicParams: [],
        providerMeta: {},
      },
    });
    set((state) => ({ nodes: [...state.nodes, buildNode(tempId) as unknown as Node<NodeData>] }));

    // Fire-and-forget push to cli_graph. When it returns, swap the UUID for
    // the short id so subsequent edits flow through the usual cli path.
    fetch('http://localhost:8000/api/graph/node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitionId, params: defaults, position }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { id?: string }) => {
        const shortId = body.id;
        if (!shortId) return;
        // Remap edges too so any connections drawn during the race window
        // keep pointing at the renamed node.
        set((state) => ({
          nodes: state.nodes.map((n) => (n.id === tempId ? { ...n, id: shortId } : n)),
          edges: state.edges.map((e) => ({
            ...e,
            source: e.source === tempId ? shortId : e.source,
            target: e.target === tempId ? shortId : e.target,
          })),
        }));
      })
      .catch((err) => {
        console.warn('[nebula] addDynamicNode backend push failed — staying frontend-only:', err);
      });

    return tempId;
  },

  onNodesChange: (changes) => {
    const removedIds = changes.filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove').map((c) => c.id);

    if (removedIds.length > 0) {
      pushUndo(set, get);
      // Push cli-origin deletions to the backend so cli_graph doesn't resurrect
      // them on the next graphSync. Frontend-only UUIDs have no backend twin.
      for (const id of removedIds) {
        if (CLI_ID_RE.test(id)) {
          fetch(`http://localhost:8000/api/graph/node/${id}`, { method: 'DELETE' }).catch((err) =>
            console.warn(`[nebula] DELETE node ${id} failed:`, err),
          );
        }
      }
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        edges: state.edges.filter((e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)),
      }));
    } else {
      set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }));
    }
  },

  onEdgesChange: (changes) => {
    const hasRemove = changes.some((c) => c.type === 'remove');
    if (hasRemove) {
      pushUndo(set, get);
      // Mirror cli-connected edge deletions to the backend. We resolve the edge
      // to its endpoints from current state BEFORE applying the change so we
      // can still find it.
      const removedIds = changes
        .filter((c): c is EdgeChange & { type: 'remove' } => c.type === 'remove')
        .map((c) => c.id);
      const currentEdges = get().edges;
      for (const id of removedIds) {
        const edge = currentEdges.find((e) => e.id === id);
        if (!edge) continue;
        if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) {
          fetch('http://localhost:8000/api/graph/edge', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: edge.source,
              sourceHandle: edge.sourceHandle ?? '',
              target: edge.target,
              targetHandle: edge.targetHandle ?? '',
            }),
          }).catch((err) => console.warn('[nebula] DELETE edge failed:', err));
        }
      }
    }
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges) }));
  },

  onConnect: (connection) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    pushUndo(set, get);

    // Resolve source port data type — static or dynamic
    let dataType: PortDataType = 'Any';
    const sourceDynamic = sourceNode.data as unknown as DynamicNodeData | undefined;
    if (sourceDynamic?.isDynamic && sourceDynamic.dynamicOutputPorts) {
      const dynPort = sourceDynamic.dynamicOutputPorts.find((p) => p.id === connection.sourceHandle);
      if (dynPort) dataType = dynPort.dataType;
    } else {
      const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
      if (sourceDef) {
        const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
        if (sourcePort) dataType = sourcePort.dataType;
      }
    }

    // Optimistic local edge so the user sees it immediately. If both endpoints
    // are cli-origin nodes, push the edge to cli_graph too — graphSync will
    // bring back the authoritative version (the id may differ) and the merge
    // logic dedupes by source/target/handle.
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

    if (CLI_ID_RE.test(connection.source) && CLI_ID_RE.test(connection.target)) {
      fetch('http://localhost:8000/api/graph/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: connection.source,
          sourceHandle: connection.sourceHandle,
          target: connection.target,
          targetHandle: connection.targetHandle,
        }),
      }).catch((err) => console.warn('[nebula] onConnect backend push failed:', err));
    }
  },

  updateNodeData: (nodeId, data) => {
    // Only push undo for param changes (not for execution state updates like outputs/state/progress)
    const isParamChange = 'params' in data;
    if (isParamChange) {
      maybePushUndo(set, get, nodeId);
    }
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      ),
    }));

    // Param changes on cli-origin nodes (n1, n2, ...) need to flow back to
    // cli_graph so Claude's `nebula graph` reflects user edits. Debounce so
    // rapid typing in a text-input doesn't hammer the backend — the final
    // value is what matters. Execution state updates (outputs/state/progress)
    // don't need to sync.
    if (isParamChange && CLI_ID_RE.test(nodeId)) {
      if (paramPushTimers[nodeId] !== undefined) {
        window.clearTimeout(paramPushTimers[nodeId]);
      }
      paramPushTimers[nodeId] = window.setTimeout(() => {
        delete paramPushTimers[nodeId];
        const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
        if (!node) return;
        fetch(`http://localhost:8000/api/graph/node/${nodeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params: node.data.params }),
        }).catch((err) => {
          console.warn(`[nebula] Param sync for ${nodeId} failed:`, err);
        });
      }, PARAM_PUSH_DEBOUNCE_MS);
    }
  },

  resetExecution: () => {
    set((state) => ({
      isExecuting: false,
      nodes: state.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          // Only reset nodes that are mid-execution — preserve completed/errored results
          state: (node.data.state === 'queued' || node.data.state === 'executing')
            ? 'idle' as const
            : node.data.state,
          progress: undefined,
        },
      })),
    }));
  },

  executeGraph: async () => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    resetExecution();
    set({ isExecuting: true });
    const graphNodes = nodes.map((n) => ({ id: n.id, definitionId: n.data.definitionId, params: n.data.params, outputs: {} }));
    const graphEdges = edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle }));
    try {
      const result = await apiExecuteGraph(graphNodes, graphEdges);
      if (result.status === 'validation_error') set({ isExecuting: false });
    } catch (err) {
      console.error('Failed to start execution:', err);
      set({ isExecuting: false });
    }
  },

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

    pushUndo(set, get);

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
    pushUndo(set, get);
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    }));
    if (CLI_ID_RE.test(nodeId)) {
      fetch(`http://localhost:8000/api/graph/node/${nodeId}`, { method: 'DELETE' }).catch((err) =>
        console.warn(`[nebula] DELETE node ${nodeId} failed:`, err),
      );
    }
  },

  loadGraph: (nodes, edges) => {
    set({ nodes, edges, isExecuting: false, undoStack: [], redoStack: [] });
  },

  clearGraph: () => {
    const { nodes, edges, undoStack } = get();
    const snapshot = createSnapshot(nodes, edges);
    const newStack = [...undoStack, snapshot];
    if (newStack.length > UNDO_CAP) newStack.shift();
    set({ nodes: [], edges: [], isExecuting: false, undoStack: newStack, redoStack: [] });
  },

  configureOpenRouterModel: (nodeId, modelId, model) => {
    pushUndo(set, get);

    const inputModalities = model.input_modalities || ['text'];
    const outputModalities = model.output_modalities || ['text'];

    const inputPorts: DynamicPortDefinition[] = [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    ];
    if (inputModalities.includes('image')) {
      inputPorts.push({ id: 'images', label: 'Images', dataType: 'Image', required: false });
    }

    const outputPorts: DynamicPortDefinition[] = [];
    if (outputModalities.includes('text')) {
      outputPorts.push({ id: 'text', label: 'Text', dataType: 'Text', required: false });
    }
    if (outputModalities.includes('image')) {
      outputPorts.push({ id: 'image', label: 'Image', dataType: 'Image', required: false });
    }

    const wantsImage = outputModalities.includes('image');

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const data = n.data as unknown as DynamicNodeData;
        return {
          ...n,
          data: {
            ...data,
            modelId,
            params: { ...data.params, model: modelId, _output_image: wantsImage },
            dynamicInputPorts: inputPorts,
            dynamicOutputPorts: outputPorts,
          } as unknown as NodeData,
        };
      }),
      // Remove edges connected to ports that no longer exist
      edges: state.edges.filter((e) => {
        if (e.source === nodeId) {
          return outputPorts.some((p) => p.id === e.sourceHandle);
        }
        if (e.target === nodeId) {
          return inputPorts.some((p) => p.id === e.targetHandle);
        }
        return true;
      }),
    }));
  },

  fetchReplicateSchemaAndConfigure: async (nodeId, owner, name) => {
    try {
      const schema = await fetchReplicateSchema(owner, name);

      const inputProps = ((schema.input_schema as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>) ?? {};
      const requiredInputs: string[] = ((schema.input_schema as Record<string, unknown>)?.required as string[]) ?? [];
      const dynamicParams: DynamicParamDefinition[] = [];
      const inputPorts: DynamicPortDefinition[] = [];

      for (const [key, prop] of Object.entries(inputProps)) {
        const p = prop as Record<string, unknown>;
        const description = (p.description as string) ?? '';
        const isUploadable = p['x-uploadable'] === true;
        const format = (p.format as string) ?? '';

        if (isUploadable || format === 'uri') {
          inputPorts.push({
            id: key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            dataType: 'Image',
            required: requiredInputs.includes(key),
          });
          continue;
        }

        let paramType: DynamicParamDefinition['type'] = 'string';
        if (p.type === 'integer') paramType = 'integer';
        else if (p.type === 'number') paramType = 'float';
        else if (p.type === 'boolean') paramType = 'boolean';
        else if (p.enum) paramType = 'enum';

        const param: DynamicParamDefinition = {
          key,
          label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          type: paramType,
          required: requiredInputs.includes(key),
          default: p.default,
          placeholder: description.slice(0, 80),
        };

        if (p.enum) {
          param.options = (p.enum as Array<string | number>).map((v) => ({ label: String(v), value: v }));
        }
        if (p.minimum !== undefined) param.min = p.minimum as number;
        if (p.maximum !== undefined) param.max = p.maximum as number;

        dynamicParams.push(param);
      }

      const outputPorts: DynamicPortDefinition[] = [];
      const outputSchema = schema.output_schema as Record<string, unknown>;

      if (outputSchema?.type === 'string' && outputSchema?.format === 'uri') {
        outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
      } else if (outputSchema?.type === 'array') {
        outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
      } else {
        outputPorts.push({ id: 'text', label: 'Output', dataType: 'Text', required: false });
      }

      const paramDefaults: Record<string, unknown> = {};
      for (const dp of dynamicParams) {
        if (dp.default !== undefined) paramDefaults[dp.key] = dp.default;
      }

      set((state) => ({
        nodes: state.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const data = n.data as unknown as DynamicNodeData;
          return {
            ...n,
            data: {
              ...data,
              params: { ...data.params, ...paramDefaults, _version_id: schema.version_id, _schema_fetched: true },
              dynamicInputPorts: inputPorts,
              dynamicOutputPorts: outputPorts,
              dynamicParams,
              providerMeta: { ...data.providerMeta, version_id: schema.version_id, description: schema.description },
            } as unknown as NodeData,
          };
        }),
      }));
    } catch (err) {
      console.error('Failed to fetch Replicate schema:', err);
    }
  },

  handleExecutionEvent: (event) => {
    switch (event.type) {
      case 'queued':
        get().updateNodeData(event.nodeId, { state: 'queued' });
        break;
      case 'executing':
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0, streamingText: undefined });
        break;
      case 'progress':
        get().updateNodeData(event.nodeId, { progress: event.value });
        break;
      case 'executed': {
        const outputs: Record<string, { type: string; value: string | null }> = {};
        for (const [key, val] of Object.entries(event.outputs)) {
          const outputVal = val as { type: string; value: string | null };
          if ((outputVal.type === 'Image' || outputVal.type === 'Video' || outputVal.type === 'Mesh' || outputVal.type === 'Audio') && outputVal.value && typeof outputVal.value === 'string') {
            // Skip rewriting for external URLs — only rewrite local filesystem paths
            if (outputVal.value.startsWith('http://') || outputVal.value.startsWith('https://')) {
              outputs[key] = outputVal;
            } else {
              const outputIdx = outputVal.value.indexOf('/output/');
              if (outputIdx !== -1) {
                const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
                outputs[key] = { type: outputVal.type, value: `/api/outputs/${relativePath}` };
              } else {
                outputs[key] = outputVal;
              }
            }
          } else {
            outputs[key] = outputVal;
          }
        }
        get().updateNodeData(event.nodeId, { state: 'complete', outputs: outputs as NodeData['outputs'], progress: undefined, streamingText: undefined });
        break;
      }
      case 'streamDelta':
        get().updateNodeData(event.nodeId, { streamingText: event.accumulated });
        break;
      case 'error':
        get().updateNodeData(event.nodeId, { state: 'error', error: event.error, progress: undefined });
        break;
      case 'validationError':
        for (const err of event.errors) {
          if (err.nodeId) get().updateNodeData(err.nodeId, { state: 'error', error: err.message });
        }
        set({ isExecuting: false });
        break;
      case 'graphComplete':
        console.log(`[execution] complete in ${event.duration}s, ${event.nodesExecuted} nodes executed`);
        set({ isExecuting: false });
        break;
    }
  },
}));
