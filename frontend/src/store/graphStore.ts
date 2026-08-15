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
import type { NodeData, DynamicNodeData, DynamicPortDefinition, DynamicParamDefinition, PortDataType, CinemaSceneSpec, CinemaShot, ModelNodeDefinition, GenerationRequest, CreateOriginTag } from '../types';
import { shotPortId } from '../constants/ports';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { buildSampleGraph } from '../constants/sampleGraph';
import { computeLayout } from '../lib/autoLayout';
import {
  clearPersistedRunHistory,
  closeRunRecord,
  freezeRunSnapshot,
  loadRunHistory,
  openRunRecord,
  persistRunHistory,
  type RunGraphSnapshot,
  type RunRecord,
  type RunReplayAction,
} from '../lib/runHistory';
import {
  executeGraph as apiExecuteGraph,
  executeNode as apiExecuteNode,
  generateCinemaShot as apiGenerateShot,
  promoteCinemaShotVariation as apiPromoteShotVariation,
  fetchReplicateSchema,
  type ExecutionValidationError,
  type OpenRouterModel,
} from '../lib/api';
import { apiFetch, backendAssetUrlSync, rewriteBackendAssetUrls } from '../lib/backend';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';
import { notifyJobComplete } from '../lib/jobNotifications';
import { useUIStore } from './uiStore';
import { clipSpeed, type EditClip } from '../lib/editor/virtualPlayback';
import type { KeyframeData, VideoGraphManifest, TrackItem } from '../types/video';
import { createEmptyManifest, DEFAULT_FPS } from '../types/video';
import { validateManifest } from '../lib/video/manifestValidator';
import { componentTypeToCanvasDefId, pruneTrackItemsForDeletedNode } from '../lib/video/mirroring';

export type TrackItemOrderAction = 'send-to-back' | 'send-backward' | 'bring-forward' | 'bring-to-front';

/** Backend contract: video-edit's ffmpeg pipeline still operates on
 * sourceIn/sourceOut/speed even though the frontend stores `duration` as
 * primary. Derive `speed` at the network boundary so the handler's snap-
 * clamp doesn't reset duration from a stale `speed=1`. Same transform that
 * `frontend/src/lib/editor/api.ts` applies for the preview-render path. */
function paramsForBackend(definitionId: string, params: Record<string, unknown>): Record<string, unknown> {
  if (definitionId !== 'video-edit') return params;
  const clips = Array.isArray(params.clips) ? (params.clips as EditClip[]) : null;
  if (!clips) return params;
  return { ...params, clips: clips.map((c) => ({ ...c, speed: clipSpeed(c) })) };
}

/** Capture the exact JSON graph sent to execution. Keeping this at the network
 * boundary means history replays include derived video-edit speed values and
 * never read mutable canvas params later. */
function captureRunSnapshot(nodes: Node<NodeData>[], edges: Edge[]): RunGraphSnapshot {
  return freezeRunSnapshot({
    nodes: nodes.map((node) => ({
      id: node.id,
      definitionId: node.data.definitionId,
      params: paramsForBackend(
        node.data.definitionId,
        node.data.params as Record<string, unknown>,
      ),
      outputs: {},
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    })),
  });
}

function persistedRunHistory(history: RunRecord[]): RunRecord[] {
  persistRunHistory(history);
  return history;
}

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

function definitionHasImageAndMaskPorts(definitionId: string): boolean {
  const def = NODE_DEFINITIONS[definitionId];
  if (!def) return false;
  const portIds = new Set(def.inputPorts.map((port) => port.id));
  return portIds.has('image') && portIds.has('mask');
}

function upstreamImageConnectionForMaskPainter(
  maskPainterId: string,
  edges: Edge[],
): Pick<Connection, 'source' | 'sourceHandle'> | null {
  const imageEdge = edges.find(
    (edge) => edge.target === maskPainterId && (edge.targetHandle ?? 'image') === 'image',
  );
  if (!imageEdge) return null;
  return {
    source: imageEdge.source,
    sourceHandle: imageEdge.sourceHandle ?? 'image',
  };
}

function nodesInExecutionScope(nodes: Node<NodeData>[], edges: Edge[], targetNodeId?: string): Node<NodeData>[] {
  if (!targetNodeId) return nodes;
  const ids = new Set<string>([targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

function markExecutionScopeQueued(
  nodes: Node<NodeData>[],
  edges: Edge[],
  targetNodeId?: string,
): Node<NodeData>[] {
  const scopeIds = new Set(nodesInExecutionScope(nodes, edges, targetNodeId).map((node) => node.id));
  return nodes.map((node) => {
    if (!scopeIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'queued' as const,
        error: undefined,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    };
  });
}

function markNodesErrored(
  nodes: Node<NodeData>[],
  nodeIds: Set<string>,
  message: string,
): Node<NodeData>[] {
  return nodes.map((node) => {
    if (!nodeIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'error' as const,
        error: message,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    };
  });
}

function markNodesWithValidationErrors(
  nodes: Node<NodeData>[],
  nodeIds: Set<string>,
  errors: ExecutionValidationError[] | undefined,
  fallback: string,
): Node<NodeData>[] {
  const messageByNode = new Map<string, string>();
  let globalMessage: string | undefined;
  for (const error of errors ?? []) {
    if (error.nodeId) {
      if (!messageByNode.has(error.nodeId)) messageByNode.set(error.nodeId, error.message);
    } else if (!globalMessage) {
      globalMessage = error.message;
    }
  }
  return nodes.map((node) => {
    if (!nodeIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'error' as const,
        error: messageByNode.get(node.id) ?? globalMessage ?? fallback,
        errorCategory: undefined,
        errorFriendly: undefined,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    };
  });
}

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
        streamingPartials: undefined,
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
      outputs: NodeData['outputs'];
      state: NodeData['state'];
      streamingText?: string;
    }
  >();
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

// Whether the current run has produced any node error / validation error. Reset
// at run start (resetExecution) and read at graphComplete so job notifications
// can report ok vs failed — the backend has no single terminal "failed" event.
let currentRunHadError = false;

// Id of the in-flight run-history record (opened by the execute* methods, closed
// at graphComplete/validationError). Null between runs / for Create concurrent gens.
let currentRunId: string | null = null;

// Error state for locally-started scoped runs. This includes the global Canvas
// run and concurrent Create generations; Cinema-shot passes suppress their
// graphComplete event, so they are intentionally not registered here.
const runErrors = new Map<string, boolean>();

/** Close the in-flight run-history record (if any) with a terminal status, then
 *  clear `currentRunId`. No-op when no run is open, so it's safe to call on every
 *  execution-exit path — and centralizing the null-guard keeps the cancel-vs-restart
 *  invariant correct (a leaked open run would otherwise be mis-marked 'cancelled'
 *  by the next run's resetExecution). */
function closeCurrentRun(
  set: (partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>)) => void,
  patch: Parameters<typeof closeRunRecord>[2],
): void {
  if (!currentRunId) return;
  const rid = currentRunId;
  currentRunId = null;
  runErrors.delete(rid);
  set((s) => ({
    runHistory: persistedRunHistory(closeRunRecord(s.runHistory, rid, patch)),
  }));
}

/** Scoped events may only own the global Canvas lifecycle when they match its
 * run id. Missing ids retain the pre-correlation behavior for older backends. */
function eventOwnsCurrentRun(runId?: string): boolean {
  return currentRunId !== null && (runId === undefined || runId === currentRunId);
}

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
  backendFreshStartPending: boolean;

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
  onConnect: (connection: Connection, options?: { skipUndo?: boolean }) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  updateRemotionManifest: (nodeId: string, patch: Partial<VideoGraphManifest>) => void;
  addTrackItemWithCanvasMirror: (
    remotionNodeId: string,
    partial: Partial<TrackItem> & Pick<TrackItem, 'componentType'>,
  ) => void;
  deleteTrackItem: (remotionNodeId: string, trackItemId: string) => void;
  duplicateTrackItemAtPlayhead: (
    remotionNodeId: string,
    trackItemId: string,
    currentFrame: number,
  ) => void;
  updateTrackItemProps: (
    remotionNodeId: string,
    trackItemId: string,
    propsPatch: Record<string, unknown>,
  ) => void;
  updateTrackItemTime: (
    remotionNodeId: string,
    trackItemId: string,
    timePatch: Partial<{ startFrame: number; durationInFrames: number }>,
  ) => void;
  updateTrackItemSpatial: (
    remotionNodeId: string,
    trackItemId: string,
    spatialPatch: Partial<TrackItem['spatial']>,
  ) => void;
  reorderTrackItem: (
    remotionNodeId: string,
    trackItemId: string,
    action: TrackItemOrderAction,
  ) => void;
  addOrUpdateKeyframe: (
    remotionNodeId: string,
    trackItemId: string,
    propName: string,
    frame: number,
    value: number | [number, number, number],
  ) => void;
  updateKeyframe: (
    remotionNodeId: string,
    trackItemId: string,
    propName: string,
    frame: number,
    patch: Partial<Pick<KeyframeData, 'frame' | 'value' | 'easing'>>,
  ) => void;
  deleteKeyframe: (
    remotionNodeId: string,
    trackItemId: string,
    propName: string,
    frame: number,
  ) => void;
  executeGraph: () => Promise<void>;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
  executeNode: (nodeId: string) => Promise<void>;
  /** Regenerate a single cinema-scene shot (does NOT touch the global
   *  isExecuting lock — the rail spinner scopes to that one shot's status).
   *  `variations` > 1 generates that many seeded candidates into shot.variations. */
  executeShot: (nodeId: string, shotId: string, seed?: number, variations?: number) => Promise<void>;
  /** Promote a variation to the canonical scene image and dynamic output port. */
  promoteShotVariation: (nodeId: string, shotId: string, index: number) => Promise<void>;
  executeCluster: (nodeIds: string[]) => Promise<void>;
  executeClusterConcurrent: (nodeIds: string[]) => Promise<void>;
  authorGenerationCluster: (request: GenerationRequest) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  deleteGeneration: (modelNodeIds: string[]) => void;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  loadGraph: (nodes: Node<NodeData>[], edges: Edge[]) => void;
  loadSampleGraph: () => void;
  autoLayout: () => void;
  runHistory: RunRecord[];
  rerunHistoryRecord: (runId: string) => Promise<void>;
  retryFailedRun: (runId: string) => Promise<void>;
  clearRunHistory: () => void;
  clearGraph: () => void;
  configureOpenRouterModel: (nodeId: string, modelId: string, model: OpenRouterModel) => void;
  fetchReplicateSchemaAndConfigure: (nodeId: string, owner: string, name: string) => Promise<void>;

  // Video-edit node helpers
  getOrCreateEditNodeDownstream: (sourceNodeId: string) => string;
  removeEmptyEditNode: (nodeId: string) => void;
  updateEditNodeClip: (
    nodeId: string,
    clipId: string,
    patch: Partial<{ start: number; duration: number; sourceIn: number; sourceOut: number; volume: number; mute: boolean }>,
  ) => void;
  cutEditNodeAtSource: (nodeId: string, sourceTime: number) => void;
  removeEditNodeClip: (nodeId: string, clipId: string) => void;

  // Cinema-scene (Soul Cinema) helpers. addShot/removeShot rewrite the node's
  // dynamic OUTPUT ports (one Image port per shot) and prune now-dead edges,
  // mirroring configureOpenRouterModel. updateScene persists an editor-authored
  // spec (without changing the shot set).
  addShot: (nodeId: string) => string | null;
  removeShot: (nodeId: string, shotId: string) => void;
  updateScene: (nodeId: string, spec: CinemaSceneSpec) => void;

  // Character node helper. Creates a `character` static node with
  // params._characterId set, plus denormalized name/thumbnail for canvas
  // rendering. Mirrors addNode's static path.
  addCharacterNode: (
    characterId: string,
    position: { x: number; y: number },
    meta?: { name?: string; thumbnail?: string },
  ) => Promise<string | null>;
  addMoodboardNode: (
    moodboardId: string,
    position: { x: number; y: number },
    meta?: { name?: string; thumbnail?: string; imageCount?: number; mode?: string },
  ) => Promise<string | null>;
}

// CLI nodes use short sequential IDs like n1, n2. Frontend-only (library-dragged)
// nodes use UUIDs. This regex lets graphSync distinguish them so we can preserve
// frontend-only work when cli_graph changes.
const CLI_ID_RE = /^n\d+$/;
const DYNAMIC_NODE_IDS = [
  'openrouter-universal',
  'nous-portal-universal',
  'replicate-universal',
  'fal-universal',
] as const;
type DynamicProviderType = DynamicNodeData['providerType'];

const DYNAMIC_PROVIDER_BY_DEFINITION: Record<string, DynamicProviderType> = {
  'openrouter-universal': 'openrouter',
  'nous-portal-universal': 'nous',
  'replicate-universal': 'replicate',
  'fal-universal': 'fal',
};

function isDynamicDefinition(definitionId: string): boolean {
  return (DYNAMIC_NODE_IDS as readonly string[]).includes(definitionId);
}

function dynamicProviderFor(definitionId: string): DynamicProviderType {
  return DYNAMIC_PROVIDER_BY_DEFINITION[definitionId] ?? 'openrouter';
}

function targetHandleAllowsMultiple(node: Node<NodeData>, handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  const dynamicData = node.data as unknown as DynamicNodeData | undefined;
  if (dynamicData?.isDynamic && dynamicData.dynamicInputPorts) {
    return Boolean(dynamicData.dynamicInputPorts.find((p) => p.id === handleId)?.multiple);
  }
  const definition = NODE_DEFINITIONS[node.data.definitionId];
  return Boolean(definition?.inputPorts.find((p) => p.id === handleId)?.multiple);
}

function toDynamicPort(p: {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
}): DynamicPortDefinition {
  return {
    id: p.id,
    label: p.label,
    dataType: p.dataType,
    required: p.required,
    multiple: p.multiple,
    maxConnections: p.maxConnections,
  };
}

// ---------- Cinema-scene (Soul Cinema) helpers ----------

/** A minimal valid scene used when a cinema-scene node has no spec yet (e.g. a
 *  freshly dragged node before the Studio editor seeds it). License guard
 *  (spec §10): the default base must be commercial-OK — never FLUX.1-dev. */
function createDefaultScene(): CinemaSceneSpec {
  return {
    version: 1,
    base: { model: 'seedream-4-5' },
    aspectRatio: '16:9',
    shots: [],
  };
}

/** Read the editor-managed scene off a node, falling back to a default. */
function sceneFromNode(node: Node<NodeData>): CinemaSceneSpec {
  const params = (node.data.params ?? {}) as Record<string, unknown>;
  const scene = params.scene as CinemaSceneSpec | undefined;
  if (scene && Array.isArray(scene.shots)) return scene;
  return createDefaultScene();
}

/** One Image OUTPUT port per shot, ids via shotPortId so handles/edges/validator
 *  agree. Mirrors configureOpenRouterModel's dynamicOutputPorts contract. */
function shotOutputPorts(scene: CinemaSceneSpec): DynamicPortDefinition[] {
  return scene.shots.map((shot, idx) => ({
    id: shotPortId(shot.id),
    label: `Shot ${idx + 1}`,
    dataType: 'Image' as PortDataType,
    required: false,
  }));
}

/** Optimistically write the scene + rebuilt dynamic output ports onto the node,
 *  and prune any source edge whose handle no longer exists. Mirrors the
 *  set(...) body of configureOpenRouterModel. */
function applySceneToNode(set: GraphSet, nodeId: string, scene: CinemaSceneSpec): void {
  const outputPorts = shotOutputPorts(scene);
  const validHandleIds = new Set(outputPorts.map((p) => p.id));

  set((state) => ({
    nodes: state.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const data = n.data as unknown as DynamicNodeData;
      return {
        ...n,
        data: {
          ...data,
          // Marking the node dynamic lets useIsValidConnection resolve the
          // per-shot ports from dynamicOutputPorts. providerType is inert here
          // because the node renders via the custom 'cinemaSceneNode' React Flow
          // type, not 'dynamic-node'.
          isDynamic: true,
          providerType: data.providerType ?? 'fal',
          params: { ...data.params, scene },
          dynamicInputPorts: data.dynamicInputPorts ?? [],
          dynamicOutputPorts: outputPorts,
          dynamicParams: data.dynamicParams ?? [],
          providerMeta: data.providerMeta ?? {},
        } as unknown as NodeData,
      };
    }),
    // Remove source edges pointing at a shot port that no longer exists.
    edges: state.edges.filter((e) => {
      if (e.source === nodeId && e.sourceHandle?.startsWith('shot_')) {
        return validHandleIds.has(e.sourceHandle);
      }
      return true;
    }),
  }));
}

/** Apply a promoted Cinema variation to both the visible scene and the local
 *  dynamic output value. The backend performs the same mutation atomically for
 *  CLI-origin nodes; this local application keeps downstream canvas state in
 *  sync immediately and supports frontend-only nodes. */
function applyShotVariationPromotion(
  set: GraphSet,
  nodeId: string,
  scene: CinemaSceneSpec,
  shotId: string,
  imageUrl: string,
): void {
  applySceneToNode(set, nodeId, scene);
  const portId = shotPortId(shotId);
  set((state) => ({
    nodes: state.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            data: {
              ...node.data,
              outputs: {
                ...node.data.outputs,
                [portId]: { type: 'Image' as const, value: imageUrl },
              },
            },
          }
        : node,
    ),
  }));
}

/** Sync the scene spec back to cli_graph so Claude's `nebula graph` reflects
 *  shot edits. CLI-origin nodes only (UUID/frontend-only nodes aren't on the
 *  backend yet); fire-and-forget like updateNodeData's param push. */
function persistSceneParam(nodeId: string, scene: CinemaSceneSpec): void {
  if (!CLI_ID_RE.test(nodeId)) return;
  const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return;
  apiFetch(`/api/graph/node/${nodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: { ...node.data.params, scene } }),
  }).catch((err) => console.warn(`[nebula] Scene sync for ${nodeId} failed:`, err));
}

// Per-node timers for debounced param-sync to the backend. Keyed by node id
// so one node's typing never stalls another node's flush.
const paramPushTimers: Record<string, number> = {};
const PARAM_PUSH_DEBOUNCE_MS = 250;

type GraphSet = (
  partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>),
) => void;
type GraphGet = () => GraphState;

function snapshotExecutionScopeIds(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): Set<string> {
  if (!targetNodeId) return new Set(snapshot.nodes.map((node) => node.id));
  const ids = new Set<string>([targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of snapshot.edges) {
      if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source);
        changed = true;
      }
    }
  }
  return ids;
}

function markSnapshotScopeQueued(
  nodes: Node<NodeData>[],
  scopeIds: Set<string>,
): Node<NodeData>[] {
  return nodes.map((node) => {
    if (!scopeIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'queued' as const,
        error: undefined,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    };
  });
}

/** Replay from persisted request data, never from the live canvas. Matching live
 * nodes still receive execution state updates, but graph topology/params are not
 * replaced as a side effect of rerunning history. */
async function executeHistoricalRun(
  source: RunRecord,
  replayAction: RunReplayAction,
  set: GraphSet,
  get: GraphGet,
): Promise<void> {
  const { isExecuting, resetExecution } = get();
  if (isExecuting || source.status === 'running') return;

  const snapshot = freezeRunSnapshot(source.snapshot);
  const targetNodeId = source.targetNodeId;
  if (targetNodeId && !snapshot.nodes.some((node) => node.id === targetNodeId)) return;

  resetExecution();
  const runId = uuidv4();
  const scopeIds = snapshotExecutionScopeIds(snapshot, targetNodeId);
  currentRunId = runId;
  runErrors.set(runId, false);
  set((state) => ({
    nodes: markSnapshotScopeQueued(state.nodes, scopeIds),
    isExecuting: true,
    runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
      id: runId,
      trigger: source.trigger,
      startedAt: Date.now(),
      snapshot,
      targetNodeId,
      sourceRunId: source.id,
      replayAction,
    })),
  }));

  try {
    const result = targetNodeId
      ? await apiExecuteNode(snapshot.nodes, snapshot.edges, targetNodeId, runId)
      : await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId);
    if (result.status === 'validation_error' && currentRunId === runId) {
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesWithValidationErrors(
          state.nodes,
          scopeIds,
          result.errors,
          'Validation failed before execution. Check the saved inputs and API keys.',
        ),
        isExecuting: false,
      }));
    }
  } catch (err) {
    console.error('Failed to replay historical run:', err);
    if (currentRunId !== runId) return;
    closeCurrentRun(set, { status: 'failed' });
    set((state) => ({
      nodes: markNodesErrored(
        state.nodes,
        scopeIds,
        err instanceof Error ? err.message : 'Failed to replay historical run.',
      ),
      isExecuting: false,
    }));
  }
}

async function ensureBackendFreshForLocalCanvas(
  localCanvasWasEmpty: boolean,
  set: GraphSet,
  get: GraphGet,
): Promise<boolean> {
  if (!localCanvasWasEmpty && !get().backendFreshStartPending) return true;

  try {
    const exportRes = await apiFetch('/api/graph/export');
    if (!exportRes.ok) throw new Error(`Export failed: ${exportRes.status}`);
    const exported = (await exportRes.json()) as { empty?: boolean };

    if (exported.empty === false) {
      const clearRes = await apiFetch('/api/graph', { method: 'DELETE' });
      if (!clearRes.ok) throw new Error(`Clear failed: ${clearRes.status}`);
    }

    set({ backendFreshStartPending: false });
    return true;
  } catch {
    set({ backendFreshStartPending: true });
    return false;
  }
}

wsClient.connect();
wsClient.subscribe((event) => {
  if (event.type === 'graphSync') {
    // Real-time sync: MERGE cli_graph into the canvas. Key invariant: frontend-only
    // nodes (library drags, undo'd results, etc.) must survive graphSync — only
    // cli-origin nodes are authoritative from the server. Same for edges.
    const { nodes: rawCliNodes, edges: cliEdges, empty } = event as {
      type: 'graphSync'; nodes: Node<NodeData>[]; edges: Edge[]; empty: boolean;
    };
    const cliNodes = rewriteBackendAssetUrls(rawCliNodes);

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
        backendFreshStartPending: false,
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
      backendFreshStartPending: false,
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

// ---------- Edit-clip invariant helpers ----------

interface EditClipLike {
  id: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  volume: number;
  mute: boolean;
}

/**
 * Re-establish the end-to-end invariant: clip[i].start = sum of prior
 * durations. Call after any mutation that changes clip durations or
 * order. Pure function; does not mutate input.
 */
function reflowClips(clips: EditClipLike[]): EditClipLike[] {
  let runningStart = 0;
  return clips.map((c) => {
    const out = { ...c, start: runningStart };
    runningStart += c.duration;
    return out;
  });
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: false,
  backendFreshStartPending: false,
  runHistory: loadRunHistory(),

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
          streamingPartials: undefined,
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
          streamingPartials: undefined,
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
    if (isDynamicDefinition(definitionId)) {
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

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    // Push into cli_graph on the backend so `nebula graph` shows the node to
    // Claude. graphSync will bring it into the canvas with its cli short id.
    try {
      const backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
      if (!backendFresh) throw new Error('Backend fresh-start guard failed');

      const res = await apiFetch('/api/graph/node', {
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
      const nodeType =
        definitionId === 'reroute'
          ? 'reroute-node'
          : definitionId === 'camera-rig'
            ? 'cameraRigNode'
            : definitionId === 'reference-set'
              ? 'referenceSetNode'
              : definitionId === 'nebula-moodboard'
                ? 'moodboardNode'
                : 'model-node';
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
      const res = await apiFetch('/api/graph/node-and-connect', {
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

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

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
        providerType: dynamicProviderFor(definitionId),
        dynamicInputPorts: definition.inputPorts.map(toDynamicPort),
        dynamicOutputPorts: definition.outputPorts.map(toDynamicPort),
        dynamicParams: [],
        providerMeta: {},
      },
    });
    set((state) => ({ nodes: [...state.nodes, buildNode(tempId) as unknown as Node<NodeData>] }));

    // Fire-and-forget push to cli_graph. When it returns, swap the UUID for
    // the short id so subsequent edits flow through the usual cli path.
    ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get)
      .then((backendFresh) => {
        if (!backendFresh) throw new Error('Backend fresh-start guard failed');
        return apiFetch('/api/graph/node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definitionId, params: defaults, position }),
        });
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
          apiFetch(`/api/graph/node/${id}`, { method: 'DELETE' }).catch((err) =>
            console.warn(`[nebula] DELETE node ${id} failed:`, err),
          );
        }
      }
      set((state) => {
        const nextNodes = applyNodeChanges(changes, state.nodes) as Node<NodeData>[];
        const nextEdges = state.edges.filter((e) => !removedIds.includes(e.source) && !removedIds.includes(e.target));

        // Rule B-1: prune TrackItems whose sourceNodeId matches a removed node.
        const updatedNodes = nextNodes.map((n) => {
          if (n.data?.definitionId !== 'remotion-node') return n;
          const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
          const manifest = currentParams.manifest as VideoGraphManifest | undefined;
          if (!manifest) return n;

          let nextManifest = manifest;
          let anyChange = false;
          for (const removedId of removedIds) {
            const result = pruneTrackItemsForDeletedNode(nextManifest, removedId);
            if (result.changed) {
              nextManifest = result.manifest;
              anyChange = true;
            }
          }
          if (!anyChange) return n;
          return {
            ...n,
            data: { ...n.data, params: { ...currentParams, manifest: nextManifest } },
          };
        });

        return { nodes: updatedNodes, edges: nextEdges };
      });
    } else {
      set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) as Node<NodeData>[] }));
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
          apiFetch('/api/graph/edge', {
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
    set((state) => {
      const nextEdges = applyEdgeChanges(changes, state.edges);

      // Rule B-2: For each removed edge whose targetHandle === 'sources' and
      // whose target is a RemotionNode, prune any TrackItem whose sourceNodeId
      // matches the edge's source node.
      const removedEdges = changes
        .filter((c): c is { id: string; type: 'remove' } => c.type === 'remove')
        .map((c) => state.edges.find((e) => e.id === c.id))
        .filter((e): e is NonNullable<typeof e> => !!e);

      const sourceIdsLosingConnection: string[] = [];
      for (const edge of removedEdges) {
        if (edge.targetHandle !== 'sources') continue;
        const targetNode = state.nodes.find((n) => n.id === edge.target);
        if (targetNode?.data?.definitionId !== 'remotion-node') continue;
        sourceIdsLosingConnection.push(edge.source);
      }

      if (sourceIdsLosingConnection.length === 0) {
        return { edges: nextEdges };
      }

      const updatedNodes = state.nodes.map((n) => {
        if (n.data?.definitionId !== 'remotion-node') return n;
        const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
        const manifest = currentParams.manifest as VideoGraphManifest | undefined;
        if (!manifest) return n;

        let nextManifest = manifest;
        let anyChange = false;
        for (const sourceId of sourceIdsLosingConnection) {
          const result = pruneTrackItemsForDeletedNode(nextManifest, sourceId);
          if (result.changed) {
            nextManifest = result.manifest;
            anyChange = true;
          }
        }
        if (!anyChange) return n;
        return {
          ...n,
          data: { ...n.data, params: { ...currentParams, manifest: nextManifest } },
        };
      });

      return { edges: nextEdges, nodes: updatedNodes };
    });
  },

  onConnect: (connection, options) => {
    if (!connection.source || !connection.target) return;
    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    if (!options?.skipUndo) {
      pushUndo(set, get);
    }

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

    const targetAllowsMultiple = targetHandleAllowsMultiple(targetNode, connection.targetHandle);
    const edgesToReplace = targetAllowsMultiple
      ? []
      : get().edges.filter(
        (edge) => edge.target === connection.target
          && (edge.targetHandle ?? '') === (connection.targetHandle ?? ''),
      );

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
    const replacedIds = new Set(edgesToReplace.map((edge) => edge.id));
    set((state) => ({ edges: [...state.edges.filter((edge) => !replacedIds.has(edge.id)), newEdge] }));

    if (CLI_ID_RE.test(connection.source) && CLI_ID_RE.test(connection.target)) {
      (async () => {
        for (const edge of edgesToReplace) {
          if (!CLI_ID_RE.test(edge.source) || !CLI_ID_RE.test(edge.target)) continue;
          await apiFetch('/api/graph/edge', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: edge.source,
              sourceHandle: edge.sourceHandle ?? '',
              target: edge.target,
              targetHandle: edge.targetHandle ?? '',
            }),
          });
        }
        await apiFetch('/api/graph/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: connection.source,
            sourceHandle: connection.sourceHandle,
            target: connection.target,
            targetHandle: connection.targetHandle,
          }),
        });
      })().catch((err) => console.warn('[nebula] onConnect backend push failed:', err));
    }

    // mask-painter only outputs a mask bitmap — inpaint nodes also need the base
    // image on a separate wire. Auto-connect upstream image → edit.image when the
    // user chains image → mask-painter → edit.
    if (
      !options?.skipUndo
      && sourceNode.data.definitionId === 'mask-painter'
      && connection.sourceHandle === 'mask'
      && connection.targetHandle === 'mask'
      && definitionHasImageAndMaskPorts(targetNode.data.definitionId)
    ) {
      const upstream = upstreamImageConnectionForMaskPainter(connection.source, get().edges);
      const alreadyWired = get().edges.some(
        (edge) => edge.target === connection.target && (edge.targetHandle ?? 'image') === 'image',
      );
      if (upstream && !alreadyWired) {
        get().onConnect(
          {
            source: upstream.source,
            sourceHandle: upstream.sourceHandle,
            target: connection.target,
            targetHandle: 'image',
          },
          { skipUndo: true },
        );
      }
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
        apiFetch(`/api/graph/node/${nodeId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params: node.data.params }),
        }).catch((err) => {
          console.warn(`[nebula] Param sync for ${nodeId} failed:`, err);
        });
      }, PARAM_PUSH_DEBOUNCE_MS);
    }
  },

  updateRemotionManifest: (nodeId, patch) => {
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

  addTrackItemWithCanvasMirror: (remotionNodeId, partial) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const defId = componentTypeToCanvasDefId(partial.componentType);
    if (!defId) {
      console.warn(
        `addTrackItemWithCanvasMirror: componentType ${partial.componentType} has no canvas mapping yet`,
      );
      return;
    }

    const newNodeId = uuidv4();
    const offsetPosition = {
      x: remotion.position.x - 280,
      y: remotion.position.y,
    };
    const newCanvasNode: Node<NodeData> = {
      id: newNodeId,
      type: 'model-node',
      position: offsetPosition,
      data: {
        definitionId: defId,
        label: defId,
        params: {},
        state: 'idle' as const,
        outputs: {},
      },
    };

    const newItem: TrackItem = {
      id: partial.id ?? uuidv4(),
      sourceNodeId: newNodeId,
      componentType: partial.componentType,
      time: partial.time ?? { startFrame: 0, durationInFrames: DEFAULT_FPS * 2 },
      spatial: partial.spatial ?? {
        x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0],
      },
      keyframes: partial.keyframes ?? {},
      props: partial.props ?? {},
    };

    // Push to undo history before mutating so Ctrl-Z reverses this action.
    // Match the pattern used by addNode / updateNodeData.
    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const currentParams = (n.data.params ?? {}) as Record<string, unknown>;
        const currentManifest =
          (currentParams.manifest as VideoGraphManifest | undefined) ??
          { graph: { nodes: [], edges: [] }, timeline: [] };
        const nextManifest: VideoGraphManifest = {
          ...currentManifest,
          timeline: [...currentManifest.timeline, newItem],
        };
        return {
          ...n,
          data: {
            ...n.data,
            params: { ...currentParams, manifest: nextManifest },
          },
        };
      });
      return { nodes: [...updatedNodes, newCanvasNode as never] };
    });
  },

  deleteTrackItem: (remotionNodeId, trackItemId) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;

    const item = manifest.timeline.find((t) => t.id === trackItemId);
    if (!item) return;

    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes
        .filter((n) => n.id !== item.sourceNodeId)
        .map((n) => {
          if (n.id !== remotionNodeId) return n;
          const params = (n.data.params ?? {}) as Record<string, unknown>;
          const currentManifest = params.manifest as VideoGraphManifest;
          const nextManifest: VideoGraphManifest = {
            ...currentManifest,
            timeline: currentManifest.timeline.filter((t) => t.id !== trackItemId),
          };
          return {
            ...n,
            data: { ...n.data, params: { ...params, manifest: nextManifest } },
          };
        });
      return { nodes: updatedNodes };
    });
  },

  duplicateTrackItemAtPlayhead: (remotionNodeId, trackItemId, currentFrame) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;

    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;

    const original = manifest.timeline.find((t) => t.id === trackItemId);
    if (!original) return;

    const sourceNode = state.nodes.find((n) => n.id === original.sourceNodeId);
    const sourceDefId =
      (sourceNode?.data.definitionId as string | undefined) ?? 'text-input';

    pushUndo(set, get);

    const newSourceId = uuidv4();
    const newSourceNode = {
      id: newSourceId,
      type: 'model-node' as const,
      position: {
        x: remotion.position.x - 280,
        y: remotion.position.y + 80,
      },
      data: {
        definitionId: sourceDefId,
        label: sourceDefId,
        params: {},
        state: 'idle' as const,
        outputs: {},
      },
    };

    const clone: TrackItem = {
      ...original,
      id: uuidv4(),
      sourceNodeId: newSourceId,
      time: {
        startFrame: currentFrame,
        durationInFrames: original.time.durationInFrames,
      },
      // Deep-clone spatial/keyframes/props so mutations to the clone don't affect the original
      spatial: JSON.parse(JSON.stringify(original.spatial)),
      keyframes: JSON.parse(JSON.stringify(original.keyframes)),
      props: JSON.parse(JSON.stringify(original.props)),
    };

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: [...m.timeline, clone],
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: [...updatedNodes, newSourceNode as never] };
    });
  },

  updateTrackItemProps: (remotionNodeId, trackItemId, propsPatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) =>
            t.id === trackItemId
              ? { ...t, props: { ...t.props, ...propsPatch } }
              : t,
          ),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  updateTrackItemTime: (remotionNodeId, trackItemId, timePatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) => {
            if (t.id !== trackItemId) return t;
            return {
              ...t,
              time: {
                startFrame:
                  timePatch.startFrame !== undefined
                    ? Math.round(timePatch.startFrame)
                    : t.time.startFrame,
                durationInFrames:
                  timePatch.durationInFrames !== undefined
                    ? Math.max(1, Math.round(timePatch.durationInFrames))
                    : t.time.durationInFrames,
              },
            };
          }),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  updateTrackItemSpatial: (remotionNodeId, trackItemId, spatialPatch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) =>
            t.id === trackItemId
              ? { ...t, spatial: { ...t.spatial, ...spatialPatch } }
              : t,
          ),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  reorderTrackItem: (remotionNodeId, trackItemId, action) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;

    const fromIndex = manifest.timeline.findIndex((t) => t.id === trackItemId);
    if (fromIndex < 0) return;

    const lastIndex = manifest.timeline.length - 1;
    const toIndex =
      action === 'send-to-back'
        ? 0
        : action === 'send-backward'
          ? Math.max(0, fromIndex - 1)
          : action === 'bring-forward'
            ? Math.min(lastIndex, fromIndex + 1)
            : lastIndex;
    if (toIndex === fromIndex) return;

    pushUndo(set, get);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextTimeline = [...m.timeline];
        const [item] = nextTimeline.splice(fromIndex, 1);
        nextTimeline.splice(toIndex, 0, item);
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: nextTimeline,
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  addOrUpdateKeyframe: (remotionNodeId, trackItemId, propName, frame, value) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    if (!manifest.timeline.some((t) => t.id === trackItemId)) return;

    const roundedFrame = Math.round(frame);
    const storedValue = Array.isArray(value) ? ([...value] as [number, number, number]) : value;
    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) => {
            if (t.id !== trackItemId) return t;
            const existingKeyframes = t.keyframes[propName] ?? [];
            const nextKeyframes = [
              ...existingKeyframes.filter((k) => k.frame !== roundedFrame),
              { frame: roundedFrame, value: storedValue, easing: 'linear' as const },
            ].sort((a, b) => a.frame - b.frame);
            return {
              ...t,
              keyframes: {
                ...t.keyframes,
                [propName]: nextKeyframes,
              },
            };
          }),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  updateKeyframe: (remotionNodeId, trackItemId, propName, frame, patch) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    const item = manifest.timeline.find((t) => t.id === trackItemId);
    const existing = item?.keyframes[propName] ?? [];
    const target = existing.find((k) => k.frame === frame);
    if (!target) return;

    const nextFrame = patch.frame !== undefined ? Math.round(patch.frame) : target.frame;
    const nextValue = patch.value !== undefined
      ? Array.isArray(patch.value)
        ? ([...patch.value] as [number, number, number])
        : patch.value
      : Array.isArray(target.value)
        ? ([...target.value] as [number, number, number])
        : target.value;
    const nextEasing = patch.easing ?? target.easing;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) => {
            if (t.id !== trackItemId) return t;
            const rest = (t.keyframes[propName] ?? []).filter((k) => k.frame !== frame);
            const nextKeyframes = [
              ...rest.filter((k) => k.frame !== nextFrame),
              { frame: nextFrame, value: nextValue, easing: nextEasing },
            ].sort((a, b) => a.frame - b.frame);
            return {
              ...t,
              keyframes: {
                ...t.keyframes,
                [propName]: nextKeyframes,
              },
            };
          }),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  deleteKeyframe: (remotionNodeId, trackItemId, propName, frame) => {
    const state = get();
    const remotion = state.nodes.find((n) => n.id === remotionNodeId);
    if (!remotion) return;
    const currentParams = (remotion.data.params ?? {}) as Record<string, unknown>;
    const manifest = currentParams.manifest as VideoGraphManifest | undefined;
    if (!manifest) return;
    const item = manifest.timeline.find((t) => t.id === trackItemId);
    const existing = item?.keyframes[propName] ?? [];
    if (!existing.some((k) => k.frame === frame)) return;

    maybePushUndo(set, get, remotionNodeId);

    set((s) => {
      const updatedNodes = s.nodes.map((n) => {
        if (n.id !== remotionNodeId) return n;
        const params = (n.data.params ?? {}) as Record<string, unknown>;
        const m = params.manifest as VideoGraphManifest;
        const nextManifest: VideoGraphManifest = {
          ...m,
          timeline: m.timeline.map((t) => {
            if (t.id !== trackItemId) return t;
            const nextForProp = (t.keyframes[propName] ?? []).filter((k) => k.frame !== frame);
            const nextKeyframes = { ...t.keyframes };
            if (nextForProp.length === 0) {
              delete nextKeyframes[propName];
            } else {
              nextKeyframes[propName] = nextForProp;
            }
            return { ...t, keyframes: nextKeyframes };
          }),
        };
        return {
          ...n,
          data: { ...n.data, params: { ...params, manifest: nextManifest } },
        };
      });
      return { nodes: updatedNodes };
    });
  },

  resetExecution: () => {
    currentRunHadError = false;
    // A still-open run at this point means the user cancelled mid-flight (at the start
    // of a fresh run the prior run has already closed, so currentRunId is null → no-op).
    closeCurrentRun(set, { status: 'cancelled' });
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
    const snapshot = captureRunSnapshot(nodes, edges);
    const runId = uuidv4();
    currentRunId = runId;
    runErrors.set(runId, false);
    set((state) => ({
      nodes: markExecutionScopeQueued(state.nodes, state.edges),
      isExecuting: true,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'graph',
        startedAt: Date.now(),
        snapshot,
      })),
    }));
    try {
      const result = await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId);
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            new Set(nodesInExecutionScope(state.nodes, state.edges).map((node) => node.id)),
            result.errors,
            'Validation failed before execution. Check required inputs and API keys.',
          ),
          isExecuting: false,
        }));
      }
    } catch (err) {
      console.error('Failed to start execution:', err);
      if (currentRunId !== runId) return;
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges).map((node) => node.id)),
          err instanceof Error ? err.message : 'Failed to start execution.',
        ),
        isExecuting: false,
      }));
    }
  },

  executeNode: async (nodeId) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    resetExecution();
    const snapshot = captureRunSnapshot(nodes, edges);
    const runId = uuidv4();
    currentRunId = runId;
    runErrors.set(runId, false);
    set((state) => ({
      nodes: markExecutionScopeQueued(state.nodes, state.edges, nodeId),
      isExecuting: true,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'node',
        startedAt: Date.now(),
        snapshot,
        targetNodeId: nodeId,
      })),
    }));
    try {
      const result = await apiExecuteNode(snapshot.nodes, snapshot.edges, nodeId, runId);
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)),
            result.errors,
            'Validation failed before execution. Check required inputs and API keys.',
          ),
          isExecuting: false,
        }));
      }
    } catch (err) {
      console.error('Failed to start node execution:', err);
      if (currentRunId !== runId) return;
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)),
          err instanceof Error ? err.message : 'Failed to start node execution.',
        ),
        isExecuting: false,
      }));
    }
  },

  executeShot: async (nodeId, shotId, seed, variations) => {
    const { nodes, edges } = get();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || node.data.definitionId !== 'cinema-scene') return;
    const scene = (node.data.params as { scene?: CinemaSceneSpec }).scene;
    if (!scene || !Array.isArray(scene.shots)) return;
    const shot = scene.shots.find((s) => s.id === shotId);
    if (!shot) return;
    // The shot's own 'running' status doubles as the in-flight guard — no global
    // isExecuting lock, so other shots (and the rest of the canvas) stay usable.
    if (shot.output?.status === 'running') return;

    // Helper to patch just this one shot's output, leaving siblings untouched.
    const patchShot = (
      src: CinemaSceneSpec,
      output: NonNullable<CinemaShot['output']>,
    ): CinemaSceneSpec => ({
      ...src,
      shots: src.shots.map((s) => (s.id === shotId ? { ...s, output } : s)),
    });

    // Optimistically mark this shot running (local only — the backend streams the
    // terminal scene back via graphSync).
    applySceneToNode(set, nodeId, patchShot(scene, { ...(shot.output ?? {}), status: 'running' }));

    const graphNodes = nodes.map((n) => ({
      id: n.id,
      definitionId: n.data.definitionId,
      params: paramsForBackend(n.data.definitionId, n.data.params as Record<string, unknown>),
      outputs: {},
    }));
    const graphEdges = edges.map((e) => ({
      id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
    }));

    // Clear the optimistic spinner to an error state when no graphSync will
    // follow (up-front validation failure or a thrown request).
    const failShot = (message: string) => {
      const cur = get().nodes.find((n) => n.id === nodeId);
      const curScene = (cur?.data.params as { scene?: CinemaSceneSpec } | undefined)?.scene;
      if (!curScene) return;
      const curShot = curScene.shots.find((s) => s.id === shotId);
      applySceneToNode(set, nodeId, patchShot(curScene, { ...(curShot?.output ?? {}), status: 'error', error: message }));
    };

    const runId = uuidv4();
    try {
      const result = await apiGenerateShot(graphNodes, graphEdges, nodeId, shotId, seed, variations, runId);
      if (result.status === 'validation_error') {
        failShot('Validation failed. Check inputs and API keys.');
      }
      // status 'started' → the generated image(s) (or per-shot error) arrive via graphSync.
    } catch (err) {
      console.error('Failed to generate shot:', err);
      failShot(err instanceof Error ? err.message : 'Failed to generate shot.');
    }
  },

  promoteShotVariation: async (nodeId, shotId, index) => {
    const initialNode = get().nodes.find((node) => node.id === nodeId);
    if (!initialNode || initialNode.data.definitionId !== 'cinema-scene') return;

    if (CLI_ID_RE.test(nodeId)) {
      try {
        await apiPromoteShotVariation(nodeId, shotId, index);
      } catch (err) {
        console.error('Failed to promote shot variation:', err);
        return;
      }
    }

    // Re-read after the await because graphSync may have delivered a newer live
    // scene while the backend promotion was in flight. Patch that scene, not the
    // stale snapshot captured before the request.
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.data.definitionId !== 'cinema-scene') return;
    const scene = (node.data.params as { scene?: CinemaSceneSpec }).scene;
    if (!scene || !Array.isArray(scene.shots)) return;
    const shot = scene.shots.find((candidate) => candidate.id === shotId);
    const variation = shot?.variations?.[index];
    if (!shot || !variation) return;

    const nextScene: CinemaSceneSpec = {
      ...scene,
      shots: scene.shots.map((candidate) =>
        candidate.id === shotId
          ? {
              ...candidate,
              selectedVariation: index,
              output: { imageUrl: variation.url, status: 'done' as const },
            }
          : candidate,
      ),
    };
    applyShotVariationPromotion(set, nodeId, nextScene, shotId, variation.url);
  },

  executeCluster: async (nodeIds) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    const idSet = new Set(nodeIds);
    const clusterNodes = nodes.filter((n) => idSet.has(n.id));
    if (clusterNodes.length === 0) return;
    const clusterEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    resetExecution();
    const snapshot = captureRunSnapshot(clusterNodes, clusterEdges);
    const runId = uuidv4();
    currentRunId = runId;
    runErrors.set(runId, false);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        idSet.has(n.id)
          ? {
              ...n,
              data: {
                ...n.data,
                state: 'queued' as const,
                error: undefined,
                progress: undefined,
                streamingText: undefined,
                streamingPartials: undefined,
                streamingSvg: undefined,
              },
            }
          : n,
      ),
      isExecuting: true,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'cluster',
        startedAt: Date.now(),
        snapshot,
      })),
    }));
    try {
      const result = await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId);
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            idSet,
            result.errors,
            'Validation failed before generation. Check required inputs and API keys.',
          ),
          isExecuting: false,
        }));
      }
    } catch (err) {
      console.error('Failed to start generation:', err);
      if (currentRunId !== runId) return;
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(state.nodes, idSet, err instanceof Error ? err.message : 'Failed to start generation.'),
        isExecuting: false,
      }));
    }
  },

  executeClusterConcurrent: async (nodeIds) => {
    const { nodes, edges } = get();
    const idSet = new Set(nodeIds);
    const clusterNodes = nodes.filter((n) => idSet.has(n.id));
    if (clusterNodes.length === 0) return;
    const clusterEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    const runId = uuidv4();
    runErrors.set(runId, false);
    // Mark ONLY the cluster nodes queued — no global resetExecution, no isExecuting touch.
    set((state) => ({
      nodes: state.nodes.map((n) =>
        idSet.has(n.id)
          ? {
              ...n,
              data: {
                ...n.data,
                state: 'queued' as const,
                error: undefined,
                progress: undefined,
                streamingText: undefined,
                streamingPartials: undefined,
                streamingSvg: undefined,
              },
            }
          : n,
      ),
    }));
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
      const result = await apiExecuteGraph(graphNodes, graphEdges, runId);
      if (result.status === 'validation_error') {
        runErrors.delete(runId);
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            idSet,
            result.errors,
            'Validation failed before generation. Check required inputs and API keys.',
          ),
        }));
      }
    } catch (err) {
      console.error('Failed to start concurrent generation:', err);
      runErrors.delete(runId);
      set((state) => ({
        nodes: markNodesErrored(state.nodes, idSet, err instanceof Error ? err.message : 'Failed to start generation.'),
      }));
    }
  },

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
    // Every authored model node must be a DISTINCT backend execution, or the
    // ExecutionCache (keyed on definitionId + params + inputs) returns the SAME
    // cached image for every variation and every re-generation of the same prompt.
    // Seed-capable models get a fresh seed (respecting an explicit one, offset per
    // variation). Models without a seed param (e.g. nano-banana) get a `_variant`
    // nonce: underscore-prefixed so the backend accepts it and handlers ignore it,
    // but it's part of the cache key so each node busts the cache and the model's
    // own non-determinism yields a different image.
    const seedBase =
      typeof request.params.seed === 'number'
        ? request.params.seed
        : Math.floor(Math.random() * 1_000_000_000);
    const modelTemps: string[] = [];
    for (let v = 0; v < count; v++) {
      const t = uuidv4();
      modelTemps.push(t);
      const params = { ...buildDefaultParams(def), ...request.params };
      if (hasSeed) {
        params.seed = seedBase + v;
      } else {
        params._variant = uuidv4();
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
      const taggedById = new Map(taggedNodes.map((n) => [n.id, n]));
      const existingIds = new Set(state.nodes.map((n) => n.id));
      const mergedNodes = state.nodes.map((n) => {
        const incoming = taggedById.get(n.id);
        return incoming?.data._createOrigin
          ? { ...n, data: { ...n.data, _createOrigin: incoming.data._createOrigin } }
          : n;
      });
      const newNodes = taggedNodes.filter((n) => !existingIds.has(n.id));
      const existingEdgeIds = new Set(state.edges.map((e) => e.id));
      return {
        nodes: [...mergedNodes, ...newNodes],
        edges: [...state.edges, ...rfEdges.filter((e) => !existingEdgeIds.has(e.id))],
      };
    });

    const modelNodeIds = modelTemps.map((t) => idMap[t]).filter(Boolean);
    const allNodeIds = [...modelTemps, ...(textTemp ? [textTemp] : []), ...imageTemps].map((t) => idMap[t]).filter(Boolean);
    return { modelNodeIds, allNodeIds };
  },

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
        streamingPartials: undefined,
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
      apiFetch(`/api/graph/node/${nodeId}`, { method: 'DELETE' }).catch((err) =>
        console.warn(`[nebula] DELETE node ${nodeId} failed:`, err),
      );
    }
  },

  // ---------------------------------------------------------------------------
  // Video-edit node helpers
  // ---------------------------------------------------------------------------

  getOrCreateEditNodeDownstream: (sourceNodeId) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      throw new Error(`Source node not found: ${sourceNodeId}`);
    }

    const existingMatches = state.nodes.filter((n) => {
      if (n.data.definitionId !== 'video-edit') return false;
      return state.edges.some(
        (e) =>
          e.source === sourceNodeId &&
          e.sourceHandle === 'video' &&
          e.target === n.id &&
          e.targetHandle === 'video_in',
      );
    });
    if (existingMatches.length > 0) {
      // Most recently created wins (id tiebreak)
      return existingMatches[existingMatches.length - 1].id;
    }

    // Read source-file metadata that the upload endpoint probed via ffprobe.
    // If absent (legacy node from before upload-time probing), seed empty so
    // the existing "run the edit node to populate" fallback still works.
    const sourceParams = ((sourceNode.data as { params?: Record<string, unknown> }).params ?? {});
    const sourceDuration = typeof sourceParams.sourceDuration === 'number' ? sourceParams.sourceDuration : 0;
    const sourceFps = typeof sourceParams.sourceFps === 'number' && sourceParams.sourceFps > 0
      ? sourceParams.sourceFps : 30;
    const sourceIsVfr = Boolean(sourceParams.sourceIsVfr);

    const initialClips: EditClipLike[] = sourceDuration > 0
      ? [{ id: 'c1', start: 0, duration: sourceDuration, sourceIn: 0, sourceOut: sourceDuration, volume: 1, mute: false }]
      : [];

    const editId = `video-edit-${Math.random().toString(36).slice(2, 8)}`;
    const editNode: Node<NodeData> = {
      id: editId,
      type: 'editNode',
      position: { x: sourceNode.position.x + 280, y: sourceNode.position.y },
      data: {
        definitionId: 'video-edit',
        label: 'Video Edit',
        state: 'idle' as const,
        inputs: {},
        outputs: {},
        params: {
          clips: initialClips,
          sourceDuration,
          sourceFps,
          sourceIsVfr,
        },
        spawnedThisSession: true,
      },
    };
    const edge: Edge = {
      id: `e-${sourceNodeId}-${editId}`,
      source: sourceNodeId,
      sourceHandle: 'video',
      target: editId,
      targetHandle: 'video_in',
    };
    set({
      nodes: [...state.nodes, editNode],
      edges: [...state.edges, edge],
    });
    return editId;
  },

  removeEmptyEditNode: (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || node.data.definitionId !== 'video-edit') return;
    if (!node.data.spawnedThisSession) return;

    const clips = (node.data.params?.clips ?? []) as Array<Record<string, unknown>>;
    const isVirgin =
      clips.length === 0 ||
      (clips.length === 1 &&
        (clips[0].sourceIn === 0 || clips[0].sourceIn === 0.0) &&
        // Speed is derived: speed = 1 means duration equals source range.
        // For a freshly seeded clip, duration === sourceOut - sourceIn.
        Math.abs((clips[0].duration as number) - ((clips[0].sourceOut as number) - (clips[0].sourceIn as number))) < 0.0001 &&
        (clips[0].volume === 1 || clips[0].volume === 1.0) &&
        clips[0].mute === false);
    if (!isVirgin) return;

    set({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.target !== nodeId && e.source !== nodeId),
    });
  },

  updateEditNodeClip: (nodeId, clipId, patch) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const oldClips = ((params.clips as EditClipLike[]) ?? []);
        const patched = oldClips.map((c) =>
          c.id === clipId ? { ...c, ...patch } : c,
        );
        const reflowed = reflowClips(patched);
        return { ...n, data: { ...n.data, params: { ...params, clips: reflowed } } };
      }),
    }));
  },

  cutEditNodeAtSource: (nodeId, sourceTime) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const clips = ((params.clips as EditClipLike[]) ?? []);
        const idx = clips.findIndex((c) => sourceTime > c.sourceIn && sourceTime < c.sourceOut);
        if (idx < 0) return n;
        const orig = clips[idx];
        // Keep speed constant across both halves: same (sourceOut - sourceIn) / duration ratio.
        const origSpeed = orig.duration > 0 ? (orig.sourceOut - orig.sourceIn) / orig.duration : 1;
        const leftSourceRange = sourceTime - orig.sourceIn;
        const rightSourceRange = orig.sourceOut - sourceTime;
        const left: EditClipLike = {
          ...orig,
          sourceOut: sourceTime,
          duration: leftSourceRange / origSpeed,
        };
        const right: EditClipLike = {
          ...orig,
          id: `${orig.id}-${Math.random().toString(36).slice(2, 6)}`,
          sourceIn: sourceTime,
          duration: rightSourceRange / origSpeed,
        };
        const next = reflowClips([...clips.slice(0, idx), left, right, ...clips.slice(idx + 1)]);
        return { ...n, data: { ...n.data, params: { ...params, clips: next } } };
      }),
    }));
  },

  removeEditNodeClip: (nodeId, clipId) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const params = { ...(n.data.params ?? {}) };
        const filtered = ((params.clips as EditClipLike[]) ?? []).filter((c) => c.id !== clipId);
        if (filtered.length === 0) return n; // Never delete the only clip
        const reflowed = reflowClips(filtered);
        return { ...n, data: { ...n.data, params: { ...params, clips: reflowed } } };
      }),
    }));
  },

  addShot: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return null;

    pushUndo(set, get);

    const scene = sceneFromNode(node);
    const newShot: CinemaShot = {
      id: uuidv4(),
      prompt: '',
      output: { status: 'idle' },
    };
    const nextScene: CinemaSceneSpec = { ...scene, shots: [...scene.shots, newShot] };
    applySceneToNode(set, nodeId, nextScene);
    persistSceneParam(nodeId, nextScene);
    return newShot.id;
  },

  removeShot: (nodeId, shotId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const scene = sceneFromNode(node);
    if (!scene.shots.some((s) => s.id === shotId)) return;

    pushUndo(set, get);

    const nextScene: CinemaSceneSpec = {
      ...scene,
      shots: scene.shots.filter((s) => s.id !== shotId),
    };

    // Edges feeding off the removed shot's output port are now dangling — drop
    // them on the backend too (CLI-origin edges only), mirroring onEdgesChange.
    const deadPortId = shotPortId(shotId);
    for (const edge of get().edges) {
      if (edge.source !== nodeId || edge.sourceHandle !== deadPortId) continue;
      if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) {
        apiFetch('/api/graph/edge', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: edge.source,
            sourceHandle: edge.sourceHandle ?? '',
            target: edge.target,
            targetHandle: edge.targetHandle ?? '',
          }),
        }).catch((err) => console.warn('[nebula] DELETE cinema shot edge failed:', err));
      }
    }

    applySceneToNode(set, nodeId, nextScene);
    persistSceneParam(nodeId, nextScene);
  },

  updateScene: (nodeId, spec) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;

    maybePushUndo(set, get, nodeId);

    // Prune edges that point at a shot port the new spec no longer has.
    const validPortIds = new Set(spec.shots.map((s) => shotPortId(s.id)));
    for (const edge of get().edges) {
      if (edge.source !== nodeId || !edge.sourceHandle?.startsWith('shot_')) continue;
      if (validPortIds.has(edge.sourceHandle)) continue;
      if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) {
        apiFetch('/api/graph/edge', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: edge.source,
            sourceHandle: edge.sourceHandle ?? '',
            target: edge.target,
            targetHandle: edge.targetHandle ?? '',
          }),
        }).catch((err) => console.warn('[nebula] DELETE cinema shot edge failed:', err));
      }
    }

    applySceneToNode(set, nodeId, spec);
    persistSceneParam(nodeId, spec);
  },

  // Character node — mirrors addNode's static path. Writes _characterId +
  // denormalized name/thumbnail so CharacterNode.tsx renders without fetching.
  // These are `_`-prefixed runtime references (which Character the node points
  // at), NOT declared model params — the prefix lets them pass the backend's
  // _validate_params on the /api/graph/node persist path (same mechanism as
  // _previewUrl) without polluting the Inspector.
  addCharacterNode: async (characterId, position, meta) => {
    const definition = NODE_DEFINITIONS['character'];
    if (!definition) return null;

    // Build param defaults from the definition, then layer in runtime refs.
    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    const params: Record<string, unknown> = {
      ...defaults,
      _characterId: characterId,
      _characterName: meta?.name ?? '',
      _characterThumbnail: meta?.thumbnail ?? '',
    };

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    try {
      const backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
      if (!backendFresh) throw new Error('Backend fresh-start guard failed');

      const res = await apiFetch('/api/graph/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId: 'character', params, position }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const node = (await res.json()) as { id?: string };
      return node.id ?? null;
    } catch (err) {
      console.warn('[nebula] addCharacterNode backend push failed — adding locally only:', err);
      pushUndo(set, get);
      const newNode: Node<NodeData> = {
        id: uuidv4(),
        type: 'characterNode',
        position,
        data: { label: definition.displayName, definitionId: 'character', params, state: 'idle', outputs: {} },
      };
      set((state) => ({ nodes: [...state.nodes, newNode] }));
      return newNode.id;
    }
  },

  // Moodboard node — mirrors Character node but points at a provider-neutral
  // saved Moodboard asset. The canvas card uses denormalized fields for instant
  // rendering; execution resolves the canonical resource from MoodboardStore.
  addMoodboardNode: async (moodboardId, position, meta) => {
    const definition = NODE_DEFINITIONS['nebula-moodboard'];
    if (!definition) return null;

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    const params: Record<string, unknown> = {
      ...defaults,
      _moodboardId: moodboardId,
      _moodboardName: meta?.name ?? '',
      _moodboardThumbnail: meta?.thumbnail ?? '',
      _moodboardImageCount: meta?.imageCount ?? 0,
      _moodboardMode: meta?.mode ?? 'look',
    };

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    try {
      const backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
      if (!backendFresh) throw new Error('Backend fresh-start guard failed');

      const res = await apiFetch('/api/graph/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId: 'nebula-moodboard', params, position }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const node = (await res.json()) as { id?: string };
      return node.id ?? null;
    } catch (err) {
      console.warn('[nebula] addMoodboardNode backend push failed — adding locally only:', err);
      pushUndo(set, get);
      const newNode: Node<NodeData> = {
        id: uuidv4(),
        type: 'moodboardNode',
        position,
        data: { label: definition.displayName, definitionId: 'nebula-moodboard', params, state: 'idle', outputs: {} },
      };
      set((state) => ({ nodes: [...state.nodes, newNode] }));
      return newNode.id;
    }
  },

  loadGraph: (nodes, edges) => {
    set({ nodes, edges, isExecuting: false, undoStack: [], redoStack: [], backendFreshStartPending: false });
  },

  loadSampleGraph: () => {
    const { nodes, edges } = buildSampleGraph();
    get().loadGraph(nodes, edges);
    // Let the canvas auto-fit to frame the seeded pipeline.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: nodes.length } })
      );
    }
  },

  autoLayout: () => {
    const { nodes, edges } = get();
    if (nodes.length === 0) return;
    pushUndo(set, get);
    // Dependency-aware layered positions (frontend-only; graphSync preserves
    // existing.position, and saves round-trip it, so this sticks like a drag).
    const pos = computeLayout(nodes, edges);
    set((state) => ({
      nodes: state.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)),
    }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: nodes.length } })
      );
    }
  },

  rerunHistoryRecord: async (runId) => {
    const source = get().runHistory.find((record) => record.id === runId);
    if (!source) return;
    await executeHistoricalRun(source, 'rerun', set, get);
  },

  retryFailedRun: async (runId) => {
    const source = get().runHistory.find((record) => record.id === runId);
    if (!source || source.status !== 'failed') return;
    await executeHistoricalRun(source, 'retry-failed', set, get);
  },

  clearRunHistory: () => {
    clearPersistedRunHistory();
    set({ runHistory: [] });
  },

  clearGraph: () => {
    const { nodes, edges, undoStack } = get();
    const snapshot = createSnapshot(nodes, edges);
    const newStack = [...undoStack, snapshot];
    if (newStack.length > UNDO_CAP) newStack.shift();
    set({ nodes: [], edges: [], isExecuting: false, undoStack: newStack, redoStack: [], backendFreshStartPending: false });
  },

  configureOpenRouterModel: (nodeId, modelId, model) => {
    pushUndo(set, get);

    const inputModalities = model.input_modalities || ['text'];
    const outputModalities = model.output_modalities || ['text'];

    const inputPorts: DynamicPortDefinition[] = [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    ];
    if (inputModalities.includes('image')) {
      inputPorts.push({ id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true });
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
          type: isDynamicDefinition(data.definitionId) ? 'dynamic-node' : n.type,
          data: {
            ...data,
            isDynamic: true,
            providerType: dynamicProviderFor(data.definitionId),
            modelId,
            params: { ...data.params, model: modelId, _output_image: wantsImage },
            dynamicInputPorts: inputPorts,
            dynamicOutputPorts: outputPorts,
            dynamicParams: data.dynamicParams ?? [],
            providerMeta: data.providerMeta ?? {},
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
        get().updateNodeData(event.nodeId, {
          state: 'queued',
          streamingText: undefined,
          streamingPartials: undefined,
        });
        break;
      case 'executing':
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0, streamingText: undefined, streamingPartials: undefined, streamingSvg: undefined });
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
                outputs[key] = { type: outputVal.type, value: backendAssetUrlSync(`/api/outputs/${relativePath}`) };
              } else {
                outputs[key] = outputVal;
              }
            }
          } else {
            outputs[key] = outputVal;
          }
        }
        get().updateNodeData(event.nodeId, { state: 'complete', outputs: outputs as NodeData['outputs'], progress: undefined, streamingText: undefined, streamingPartials: undefined, streamingSvg: undefined });
        break;
      }
      case 'streamDelta':
        get().updateNodeData(event.nodeId, { streamingText: event.accumulated });
        break;
      case 'streamPartialImage': {
        const existing = get().nodes.find((n) => n.id === event.nodeId)?.data.streamingPartials ?? [];
        const filtered = existing.filter((p) => p.index !== event.partialIndex);
        const next = [...filtered, { index: event.partialIndex, src: event.src }].sort((a, b) => a.index - b.index);
        get().updateNodeData(event.nodeId, { streamingPartials: next });
        break;
      }
      case 'streamPartialSvg': {
        // Quiver Arrow streams: keep only the latest draft so ModelNode renders
        // a single progressive preview rather than accumulating every draft.
        // The `executed` event later overwrites with the final outputs.svg.value.
        get().updateNodeData(event.nodeId, {
          streamingSvg: { index: event.partialIndex, svg: event.svg, isFinal: event.isFinal },
        });
        break;
      }
      case 'error':
        if (event.runId && runErrors.has(event.runId)) {
          runErrors.set(event.runId, true);
        }
        if (!event.runId || event.runId === currentRunId) {
          currentRunHadError = true;
        }
        get().updateNodeData(event.nodeId, {
          state: 'error',
          error: event.error,
          errorCategory: event.category,
          errorFriendly: event.friendly,
          progress: undefined,
          streamingText: undefined,
          streamingPartials: undefined,
        });
        break;
      case 'validationError': {
        const trackedScopedRun = event.runId ? runErrors.has(event.runId) : false;
        if (event.runId && trackedScopedRun) {
          runErrors.set(event.runId, true);
        }
        if (!event.runId || event.runId === currentRunId) {
          currentRunHadError = true;
        }
        for (const err of event.errors) {
          if (err.nodeId) {
            get().updateNodeData(err.nodeId, {
              state: 'error',
              error: err.message,
              errorCategory: undefined,
              errorFriendly: undefined,
            });
          }
        }
        if (!event.runId || eventOwnsCurrentRun(event.runId)) {
          set({ isExecuting: false });
          // validationError ends the run with no following graphComplete, so close + notify here.
          closeCurrentRun(set, { status: 'failed' });
          notifyJobComplete({ ok: false, durationSec: 0, nodesExecuted: 0 });
        } else if (trackedScopedRun) {
          // A locally-started concurrent Create run owns its notification and
          // bookkeeping, but never the global Canvas execution lock/history.
          runErrors.delete(event.runId);
          notifyJobComplete({ ok: false, durationSec: 0, nodesExecuted: 0 });
        }
        break;
      }
      case 'graphComplete': {
        console.log(`[execution] complete in ${event.duration}s, ${event.nodesExecuted} nodes executed`);
        const trackedScopedRun = event.runId ? runErrors.has(event.runId) : false;
        const runFailed = event.runId
          ? (runErrors.get(event.runId) ?? currentRunHadError)
          : currentRunHadError;
        if (!event.runId || eventOwnsCurrentRun(event.runId)) {
          set({ isExecuting: false });
          closeCurrentRun(set, {
            status: runFailed ? 'failed' : 'complete',
            durationSec: event.duration,
            nodesExecuted: event.nodesExecuted,
          });
          notifyJobComplete({
            ok: !runFailed,
            durationSec: event.duration,
            nodesExecuted: event.nodesExecuted,
          });
        } else if (trackedScopedRun) {
          runErrors.delete(event.runId);
          notifyJobComplete({
            ok: !runFailed,
            durationSec: event.duration,
            nodesExecuted: event.nodesExecuted,
          });
        }
        break;
      }
    }
  },
}));

// Dev-only window bridge so the Puppeteer driver in scripts/puppeteer-driver/
// can call clearGraph() between automated demo runs.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __nebulaGraphStore?: typeof useGraphStore }).__nebulaGraphStore = useGraphStore;
}
