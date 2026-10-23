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
import type { NodeData, DynamicNodeData, DynamicPortDefinition, DynamicParamDefinition, PortDataType, PortValue, CinemaSceneSpec, CinemaShot, ModelNodeDefinition, GenerationRequest, CreateOriginTag, NodeState } from '../types';
import { shotPortId } from '../constants/ports';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { buildSampleGraph } from '../constants/sampleGraph';
import { computeLayout, type LayoutNode } from '../lib/autoLayout';
import { useArrangeStore } from './arrangeStore';
import {
  clearPersistedRunHistory,
  clearRunReconnectingNote,
  closeRunRecord,
  freezeRunSnapshot,
  applyProviderRecoveriesToHistory,
  applyProviderRecoveryToLiveParams,
  isProviderStartAmbiguity,
  loadRunHistory,
  openRunRecord,
  persistRunHistory,
  paperInputsForSnapshot,
  paperInputOutOfDateReasons,
  paperRecipeRevision,
  paperRunOutOfDateReasons,
  currentRunSnapshot,
  runBehaviourVersion,
  recordRunOutput,
  recordRunBatchOutputs,
  recordRunSkip,
  sanitizeVariantScopes,
  snapshotWithLatestPaperSources,
  providerRecoveryWarningText,
  isWorldLabsRecoveryReplayBlocked,
  runIncludesFreshPaidWorldLabsStart,
  runIncludesWorldLabs,
  type ProviderRecoveryCheckpoint,
  type ProviderStartAmbiguity,
  type ProviderStartKind,
  type RunGraphSnapshot,
  type RunRecord,
  type RunReplayAction,
  type ActiveRun,
  type CreateRunOrigin,
} from '../lib/runHistory';
import { GRAPH_PARAMS_VERSION, runReplayNotes } from '../lib/savedParamsUpgrades';
import { backendParamsVersion } from '../lib/paramsOutdated';
import type { PaperSourceRecord } from '../lib/paperSource';
import {
  executeGraph as apiExecuteGraph,
  executeNode as apiExecuteNode,
  cancelExecution as apiCancelExecution,
  acknowledgeProviderStartAmbiguity as apiAcknowledgeProviderStartAmbiguity,
  deleteProviderRecovery as apiDeleteProviderRecovery,
  FORGET_RECOVERY_HEADING,
  generateCinemaShot as apiGenerateShot,
  promoteCinemaShotVariation as apiPromoteShotVariation,
  getExecutionStatus as apiGetExecutionStatus,
  ExecutionStartRejectedError,
  type ExecutionValidationError,
  type ExecutionStatusResult,
  type OpenRouterModel,
} from '../lib/api';
import {
  apiFetch,
  getCachedBackendBaseUrl,
  rewriteBackendAssetUrls,
  rewriteExecutionAssetUrls,
} from '../lib/backend';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';
import { WORLD_LABS_STATUS_UNCERTAIN_WARNING, waitingOnWorldLabs } from '../lib/worldLabsWaiting';
import { FailureNotice, REFUSED_FALLBACK_COPY, copyForStatus, failureCopy, failureMessage, readDetail, requestError, warnFailure } from '../lib/errorCopy';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../lib/canvasNotice';
import { cleanRemovals, deletedNoticeText, mergeRemovals, notRestoredText, pinsOnAnotherModel, restoredNoticeText, supersededBy, type RemovalRecord } from '../lib/deleteNotice';
import { NOTHING_RAN_LINE, OTHER_NODE_LINE, SHOT_NOT_STARTED_LINE, validationReadings, writtenReading, type ValidationReading } from '../lib/validationCopy';
import {
  RUNTIME_FIELDS, applySlice, diffCanvas, edgeKey, editArrivedText, foldArrange, foreignSource, isForeignEdit, isOwnEcho,
  restoreRequest, undoNoticeText, type EditOrigin, type ForeignEdit, type RestoreBody,
} from '../lib/canvasUndo';
import { TAB_ID } from '../lib/tabId';
import { notifyJobComplete } from '../lib/jobNotifications';
import { useUIStore } from './uiStore';
import { usePricingStore } from './pricingStore';
import { useInputSizeStore } from './inputSizeStore';
import { useStoredAssetsStore } from './storedAssetsStore';
import { runCostConfirmMessage, shouldConfirmRunCost, summarizeRunScope, type RunScope } from '../lib/runScope';
import { useCreateDraftStore } from './createDraftStore';
import { getCinemaUploadIssue, useCinemaUploadStore } from './cinemaUploadStore';
import { cinemaMotionSource, cinemaMotionTarget, useCinemaMotionStore } from './cinemaMotionStore';
import { nodeKeyStatus, withNewKreaMode } from '../lib/kreaConnection';
import { allParamDefinitions } from '../lib/directRoute';
import { clipSpeed, type EditClip } from '../lib/editor/virtualPlayback';
import type { KeyframeData, VideoGraphManifest, TrackItem } from '../types/video';
import { createEmptyManifest, DEFAULT_FPS } from '../types/video';
import { validateManifest } from '../lib/video/manifestValidator';
import { componentTypeToCanvasDefId, pruneTrackItemsForDeletedNode } from '../lib/video/mirroring';
import { isPortCompatible } from '../lib/portCompatibility';
import { getProjectContext } from '../lib/projectContext';
import { boundingRect, findOpenGroupOffset, UNMEASURED_NODE_SIZE, type NodeRect } from '../lib/nodePlacement';
import { withParamDefaults } from '../lib/paramDefaults';
import { replaceChanged, shareUnchanged } from '../lib/structuralShare';

export type TrackItemOrderAction = 'send-to-back' | 'send-backward' | 'bring-forward' | 'bring-to-front';

function normalizedExecutionOutputs(raw: Record<string, PortValue>): Record<string, PortValue> {
  const outputs: Record<string, PortValue> = {};
  for (const [key, output] of Object.entries(raw)) {
    if (output.type === 'World') {
      outputs[key] = rewriteExecutionAssetUrls(output);
    } else if (['Image', 'Video', 'Mesh', 'Audio', 'SVG'].includes(output.type) && output.value) {
      outputs[key] = { ...output, value: rewriteExecutionAssetUrls(output.value) };
    } else {
      outputs[key] = output;
    }
  }
  return outputs;
}

/** Backend contract: video-edit's ffmpeg pipeline still operates on
 * sourceIn/sourceOut/speed even though the frontend stores `duration` as
 * primary. Derive `speed` at the network boundary so the handler's snap-
 * clamp doesn't reset duration from a stale `speed=1`. Same transform that
 * `frontend/src/lib/editor/api.ts` applies for the preview-render path. */
function paramsForBackend(definitionId: string, params: Record<string, unknown>): Record<string, unknown> {
  if (definitionId === 'paper-source') {
    const source = params._paperSource as PaperSourceRecord | undefined;
    // The run pins this one snapshot; source history stays on the canvas and
    // in the backend journal rather than being copied into every request.
    return source ? { ...params, _paperSource: { ...source, snapshots: source.snapshot ? [source.snapshot] : [] } } : params;
  }
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

/** Gate state from the previous run, cleared when a node is queued or starts again. */
const CLEAR_GATE_STATE = { skipReason: undefined, skipGateNodeId: undefined, withheldPorts: undefined } as const;

/** The executed event's withheld ports, kept only when it is a port -> reason map. */
function withheldPorts(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function persistedRunHistory(history: RunRecord[]): RunRecord[] {
  persistRunHistory(history);
  return history;
}

function clearBatchPreview(runId?: string): Partial<NodeData> {
  return { batchOutputs: undefined, batchVariants: undefined, batchRunId: runId };
}

function sameExecutionOutputs(left: NodeData['outputs'], right: NodeData['outputs']): boolean {
  const stable = (outputs: NodeData['outputs']) => JSON.stringify(normalizedExecutionOutputs(outputs),
    (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return stable(left) === stable(right);
}

function recordIncludesNode(record: RunRecord, nodeId: string): boolean {
  if (!record.targetNodeId) return record.snapshot.nodes.some((node) => node.id === nodeId);
  const ids = new Set([record.targetNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of record.snapshot.edges) {
      if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source);
        changed = true;
      }
    }
  }
  return ids.has(nodeId);
}

/** Restore a gallery only from the latest run that actually owned this node.
 * Matching the current scalar result prevents history from rewinding a newer
 * backend output. The saved recipe, rather than editable source text, labels it. */
function restoreBatchPreview(node: Node<NodeData>, history: RunRecord[]): Node<NodeData> {
  if (node.data.batchRunId !== undefined || node.data.state === 'queued'
    || node.data.state === 'executing' || scopeOverlaps([node.id])) return node;
  const record = history.find((candidate) => recordIncludesNode(candidate, node.id)
    && candidate.snapshot.nodes.some((saved) => saved.id === node.id
      && saved.definitionId === node.data.definitionId));
  const snapshots = record?.batchOutputs?.[node.id];
  if (!record || !snapshots) return node;
  const outputs = snapshots.map(normalizedExecutionOutputs);
  if (outputs.length && !sameExecutionOutputs(outputs[outputs.length - 1], node.data.outputs)) return node;
  if (!outputs.length && Object.keys(node.data.outputs).length) return node;
  return { ...node, data: { ...node.data, batchRunId: record.id, batchOutputs: outputs,
    batchVariants: sanitizeVariantScopes(record.batchVariants?.[node.id], outputs.length) } };
}

/** Every route's defaults (lib/directRoute.ts allParamDefinitions): a
 * route-table node starts on `_provider: 'auto'` and keeps each route's
 * values, so a switch keeps them too. Every way of adding a node starts
 * here, so the router sends what the estimate and the switcher describe.
 * Values are copies, so editing a node never edits the definition. */
function buildDefaultParams(def: ModelNodeDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const p of allParamDefinitions(def)) {
    if (p.default !== undefined) defaults[p.key] = structuredClone(p.default);
  }
  return defaults;
}

function defHasParam(def: ModelNodeDefinition, key: string): boolean {
  return allParamDefinitions(def).some((p) => p.key === key);
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

function pendingCinemaUploadIssue(nodes: Node<NodeData>[], selected?: { nodeId: string; shotId: string }): string | null {
  for (const node of nodes) {
    if (node.data.definitionId !== 'cinema-scene') continue;
    const issue = getCinemaUploadIssue(node.id, selected?.nodeId === node.id ? selected.shotId : undefined,
      selected?.nodeId !== node.id);
    if (issue) return issue;
  }
  return null;
}

// A canvas notice, not a window.alert (round 3f, GM: "A native alert stops
// the whole canvas over something that needs no answer.").
function warnPendingCinemaUpload(issue: string): void {
  useGraphStore.getState().notify(issue);
}

function clearReplacedCanvasFocus(): void {
  const ui = useUIStore.getState();
  ui.clearCanvasViewport();
  ui.clearCinemaSelectedShots();
  const request = ui.canvasFocusRequest;
  if (!request) return;
  ui.clearCanvasNodeFocus(request.requestId);
  if (ui.selectedNodeId === request.nodeId) ui.selectNode(null);
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
        // A line Nebula wrote (a refused start): no older run's reading beside it.
        errorCategory: undefined,
        errorFriendly: undefined,
        errorPerson: undefined,
        errorProviderText: undefined,
        errorProvider: undefined,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    };
  });
}

/** The pre-run check's refusal on every node in the run (error copy round
 * 3e, lib/validationCopy.ts): a named node reads its checks' lines (the
 * agents' text stays in `error`); a node with nothing wrong of its own reads
 * that another node needs a fix; an answer that names no node, a written
 * line. Never "Validation failed before execution". */
function markNodesWithValidationErrors(
  nodes: Node<NodeData>[],
  nodeIds: Set<string>,
  errors: ExecutionValidationError[] | undefined,
): Node<NodeData>[] {
  const { byNode, global } = validationReadings(errors);
  const fallback = writtenReading(byNode.size ? OTHER_NODE_LINE : NOTHING_RAN_LINE);
  return nodes.map((node) => {
    if (!nodeIds.has(node.id)) return node;
    const reading = byNode.get(node.id) ?? global ?? fallback;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'error' as const,
        error: reading.error,
        errorCategory: reading.errorCategory,
        errorFriendly: undefined,
        errorPerson: reading.errorPerson,
        errorProviderText: undefined,
        errorProvider: undefined,
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

/**
 * The undo stack holds two kinds of step (see lib/canvasUndo.ts):
 *
 * - `UndoSnapshot`: the whole canvas before one of the person's own edits in
 *   this tab. Undo puts the whole canvas back.
 * - `ForeignEdit`: one graph change that reached this tab as a graphSync from
 *   somewhere else (an agent, another window, an outside app), as the nodes
 *   and wires it touched, before and after. Undo puts back only those.
 *
 * Both sit on one last-in-first-out stack, so a snapshot is restored only
 * after every later step, foreign ones included, has been undone. That is
 * what keeps a whole-canvas snapshot right while agents edit too. Every undo
 * and redo then sends what changed to POST /api/graph/restore, so the
 * backend graph (and with it agents, other tabs and the saved project)
 * matches the canvas again (sendRestore).
 */
interface UndoSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
  /** What the deletes this step undoes removed (lib/deleteNotice.ts): the
   * delete's answers, or the redo's restore that deleted again. Undoing the
   * step names them, so the pins and proposals come back with the nodes. */
  removals?: RemovalRecord[];
}

type UndoEntry = UndoSnapshot | ForeignEdit;

/**
 * A node has one live removal, its latest delete's: only that one's undo can
 * put its pins back and reopen its proposals. When a delete answers with new
 * records (a redo, an undo of an agent's undo, this tab's delete, another
 * tab's or an agent's edit), every stacked step that names the removal a new
 * record supersedes takes it, not just the step that deleted again, or an
 * older step that brings the node back would name a spent removal (review,
 * 2026-10-23). Only by that removal's id (`replaces`, which the backend sets
 * when a restore brought this very node back by undoing it): node ids are
 * not unique over time, so a record for another node under the same id
 * renews nothing (second review). The backend still re-checks every id.
 * Steps are kept by identity, so this renews them in place.
 */
function renewStackedRemovals(stacks: { undoStack: UndoEntry[]; redoStack: UndoEntry[] }, fresh: RemovalRecord[]): void {
  const byReplaced = supersededBy(fresh);
  if (byReplaced.size === 0) return;
  for (const step of [...stacks.undoStack, ...stacks.redoStack]) {
    if (!step.removals?.some((record) => byReplaced.has(record.id))) continue;
    step.removals = step.removals.map((record) => byReplaced.get(record.id) ?? record);
  }
}

const UNDO_CAP = 50;

/** What the canvas says after an undo or redo of someone else's edit. */
export interface UndoNotice {
  id: number;
  text: string;
  agentColor?: string;
  /** The button the notice offers: Undo when an agent's edit just landed, Redo after it was undone. */
  offer: 'undo' | 'redo' | null;
  /** The step the button acts on; it acts only while that step is next in
   * line. A person's own step for "Deleted the node." and "Restored the node." */
  entry?: UndoEntry;
  /** 'error': a failure that used to be a window.alert (round 3f, GM: "Every
   * error alert becomes a canvas notice"), announced as role="alert". */
  tone?: 'error' | 'info';
}

let undoNoticeSeq = 0;

function settledState(state: NodeData['state']): NodeData['state'] {
  return state === 'executing' || state === 'queued' ? 'idle' : state;
}

/** A copy of the canvas for the undo stack: structure, params and the results
 * nodes had, so undoing a deletion brings a node back with its outputs. A
 * node that is still on the canvas when the snapshot is restored keeps its
 * live results instead (restoreWithOutputs). */
function createSnapshot(nodes: Node<NodeData>[], edges: Edge[]): UndoSnapshot {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      dragging: false,
      data: {
        ...n.data,
        params: { ...n.data.params },
        state: settledState(n.data.state),
        progress: undefined,
        runStartedAt: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
        streamingSvg: undefined,
      },
    })),
    edges: edges.map((e) => ({ ...e })),
  };
}

/**
 * Restores a snapshot but keeps live results. A node that is on the canvas
 * now keeps its live outputs and run state; a node the snapshot brings back
 * (it was deleted) comes back with the results it had.
 */
function restoreWithOutputs(
  snapshot: UndoSnapshot,
  currentNodes: Node<NodeData>[],
): Node<NodeData>[] {
  const live = new Map(currentNodes.map((node) => [node.id, node]));
  return snapshot.nodes.map((n) => {
    const current = live.get(n.id);
    if (!current) return n;
    const runtime = Object.fromEntries(RUNTIME_FIELDS.map((field) => [field, current.data[field]]));
    return { ...n, data: { ...n.data, ...runtime } as NodeData };
  });
}

/** Makes the next param edit start a new undo step instead of joining the last one. */
function breakUndoDebounce(): void {
  lastUndoPush = 0;
  lastUndoNodeId = '';
}

/** Pushes current state onto the undo stack and clears the redo stack. */
function pushUndo(
  set: (partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>)) => void,
  get: () => GraphState,
): UndoSnapshot {
  const { nodes, edges, undoStack } = get();
  const snapshot = createSnapshot(nodes, edges);
  const newStack = [...undoStack, snapshot];
  if (newStack.length > UNDO_CAP) newStack.shift();
  set({ undoStack: newStack, redoStack: [] });
  return snapshot;
}

// Debounce state for updateNodeData undo pushes
let lastUndoPush = 0;
let lastUndoNodeId = '';

// Canvas and saved replay keep an exclusive owner. Create and Cinema use the
// same scoped registry without taking this exclusive slot.
let currentRunId: string | null = null;

// Errors are correlated per owner so parallel jobs retain independent verdicts.
const runErrors = new Map<string, boolean>();
const activeRunOwners = new Map<string, ActiveRun>();
const runShareableInputs = new Map<string, Set<string>>();
const STATIC_INPUT_IDS = new Set(['text-input', 'image-input', 'document-input', 'video-input', 'audio-input']);
const createLaunchOwners = new Set<string>();
const cancelledCreateLaunches = new Set<string>();
// Terminal correlation survives history clearing and prevents delayed events
// from overwriting the next owner of the same node.
const terminalRunIds = new Set<string>();
// A terminal recovery can arrive after leaving its project. Its accepted job
// stays in that project's journal/history instead of touching reused node IDs.
const retiredProjectRunIds = new Set<string>();
const settledCinemaRuns = new Map<string, 'complete' | 'failed' | 'cancelled'>();
const cancelledRunIds = new Set<string>();
// Nodes another tab's run, or an agent's (run_nodes), put in queued or
// executing, by run. This tab doesn't own those runs, so nothing else settles
// a node the run never reached (a failed dependency, a Stop): its end does.
const foreignRunNodes = new Map<string, Set<string>>();
/** States a run's own events set, which a graphSync over unchanged outputs keeps. */
const RUN_HELD_STATES: ReadonlySet<NodeState | undefined> = new Set<NodeState | undefined>(['error', 'skipped', 'queued', 'executing']);
const pendingStartRunIds = new Set<string>();
/** Runs whose start a backend refused (ExecutionStartRejectedError): they
 * never ran, so their records are not work a stale tab must keep. */
const refusedStartRunIds = new Set<string>();

/** Every run start's catch goes through here first. */
function settleFailedStart(runId: string, err: unknown): void {
  pendingStartRunIds.delete(runId);
  if (!(err instanceof ExecutionStartRejectedError)) return;
  refusedStartRunIds.add(runId);
  if (refusedStartRunIds.size > 1000) refusedStartRunIds.delete(refusedStartRunIds.values().next().value!);
}

/** Run records that never ran: refused starts and, with `includePending`,
 * starts still waiting for an answer. projectStore leaves them out of a
 * params-version stop's unsaved work: a backend at another params version
 * refuses every start from this bundle (backend/main.py _params_outdated), so
 * a pending one is refused too, but the refusal and the stop can arrive in
 * either order. */
export function runsThatNeverStarted(includePending: boolean): Set<string> {
  return new Set([...refusedStartRunIds, ...(includePending ? pendingStartRunIds : [])]);
}
const cancellationRequestedRunIds = new Set<string>();
const statusReconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ownershipState(): Pick<GraphState, 'activeRuns' | 'isExecuting' | 'isCancelling'> {
  const activeRuns = [...activeRunOwners.values()].map((run) => ({ ...run, nodeIds: [...run.nodeIds] }));
  return { activeRuns, isExecuting: activeRuns.length > 0 || createLaunchOwners.size > 0,
    isCancelling: activeRuns.some((run) => run.status === 'cancelling') || cancelledCreateLaunches.size > 0 };
}

function registerRun(runId: string, snapshot: RunGraphSnapshot, targetNodeId?: string, shotId?: string): void {
  if (targetNodeId && shotId) settledCinemaRuns.delete(`${targetNodeId}\u0000${shotId}`);
  activeRunOwners.set(runId, { id: runId, kind: shotId ? 'cinema-shot' : 'graph',
    nodeIds: [...snapshotExecutionScopeIds(snapshot, targetNodeId)],
    nodeId: targetNodeId, shotId, status: 'starting' });
  runErrors.set(runId, false);
  runShareableInputs.set(runId, new Set(snapshot.nodes.filter((node) => STATIC_INPUT_IDS.has(node.definitionId)).map((node) => node.id)));
}

function ownsRun(runId: string): boolean { return activeRunOwners.has(runId); }

function updateRunPhase(runId: string, status: ActiveRun['status'], set: GraphSet): void {
  const owner = activeRunOwners.get(runId);
  if (!owner) return;
  activeRunOwners.set(runId, { ...owner, status });
  set(ownershipState());
}

function clearConfirmedRunAdvisory(runId: string, set: GraphSet): void {
  if (!ownsRun(runId)) return;
  set((state) => {
    const history = clearRunReconnectingNote(state.runHistory, runId);
    return history === state.runHistory ? {} : { runHistory: persistedRunHistory(history) };
  });
}

function scopeOverlaps(nodeIds: Iterable<string>, shot?: { nodeId: string; shotId: string; shareableInputs: Set<string> }): boolean {
  const ids = new Set(nodeIds);
  return [...activeRunOwners.values()].some((owner) => {
    if (shot && owner.kind === 'cinema-shot' && owner.nodeId === shot.nodeId) {
      return owner.shotId === shot.shotId || owner.nodeIds.some((id) => id !== shot.nodeId && ids.has(id)
        && !(shot.shareableInputs.has(id) && runShareableInputs.get(owner.id)?.has(id)));
    }
    return owner.nodeIds.some((id) => ids.has(id));
  });
}

function closeTrackedRun(set: GraphSet, runId: string, patch: Parameters<typeof closeRunRecord>[2]): void {
  const owner = activeRunOwners.get(runId);
  if (!owner) return;
  if (owner.nodeId && owner.shotId && patch.status !== 'running') {
    settledCinemaRuns.set(`${owner.nodeId}\u0000${owner.shotId}`, patch.status);
    if (settledCinemaRuns.size > 1000) settledCinemaRuns.delete(settledCinemaRuns.keys().next().value!);
  }
  activeRunOwners.delete(runId);
  terminalRunIds.add(runId);
  if (terminalRunIds.size > 1000) terminalRunIds.delete(terminalRunIds.values().next().value!);
  if (currentRunId === runId) currentRunId = null;
  pendingStartRunIds.delete(runId);
  cancellationRequestedRunIds.delete(runId);
  const timer = statusReconciliationTimers.get(runId);
  if (timer !== undefined) clearTimeout(timer);
  statusReconciliationTimers.delete(runId);
  runErrors.delete(runId);
  runShareableInputs.delete(runId);
  set((state) => ({ ...ownershipState(), runHistory: persistedRunHistory(closeRunRecord(state.runHistory, runId, patch)) }));
}

function noteForeignRunNode(runId: string, nodeId: string): void {
  const ids = foreignRunNodes.get(runId) ?? new Set<string>();
  ids.add(nodeId);
  foreignRunNodes.set(runId, ids);
  if (foreignRunNodes.size > 200) foreignRunNodes.delete(foreignRunNodes.keys().next().value!);
}

/** A run this tab doesn't own ended: its nodes still waiting go back to idle. */
function settleForeignRun(runId: string, set: GraphSet): void {
  const ids = foreignRunNodes.get(runId);
  if (!ids) return;
  foreignRunNodes.delete(runId);
  set((state) => ({
    nodes: state.nodes.map((node) => {
      const pending = node.data.state === 'queued' || node.data.state === 'executing';
      if (!ids.has(node.id) || !pending || scopeOverlaps([node.id])) return node;
      return { ...node, data: { ...node.data, state: 'idle' as const, progress: undefined,
        streamingText: undefined, streamingPartials: undefined, streamingSvg: undefined } };
    }),
  }));
}

function rememberCancelledRun(runId: string): void {
  cancelledRunIds.add(runId);
  if (cancelledRunIds.size > 100) {
    const oldest = cancelledRunIds.values().next().value as string | undefined;
    if (oldest) cancelledRunIds.delete(oldest);
  }
}

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
  closeTrackedRun(set, currentRunId, patch);
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
  isCancelling: boolean;
  /** Import owns graph replacement without creating an execution/history record. */
  isImportingGraph: boolean;
  reserveGraphImport: () => boolean;
  releaseGraphImport: (options?: { discardSuspended?: boolean }) => void;
  providerRecoveryWarning: string | null;
  providerRecoveries: ProviderRecoveryCheckpoint[];
  uncertainWorldLabsRunId: string | null;
  providerStartAmbiguities: ProviderStartAmbiguity[];
  backendFreshStartPending: boolean;

  // Undo/Redo
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  undo: () => void;
  redo: () => void;
  /** Starts an undo step for an edit this tab sends and the backend makes
   * (an upload that adds a node, accepting a proposal): the canvas before it.
   * Pass the step to cancelUndoStep if the request fails. */
  beginUndoStep: () => object;
  cancelUndoStep: (step: object) => void;
  /** The notice for someone else's edit: it landed, or was undone or redone. */
  undoNotice: UndoNotice | null;
  dismissUndoNotice: () => void;
  /** Show a written line as the canvas notice, non-blocking and dismissable,
   * where a native alert used to stop the canvas (round 3f). 'error' by
   * default; 'info' for a note such as an import's warnings. */
  notify: (text: string, tone?: 'error' | 'info') => void;

  // Clipboard
  clipboard: CanvasClipboard | null;
  copySelected: () => void;
  /** Paste what Cmd+C copied. Same load: +20 px from the copies, as before.
   *  From another load (another project, or this one reopened): centred in
   *  `view` (the visible canvas in flow coordinates, which Canvas passes),
   *  then moved to the nearest spot clear of the nodes already here, in view
   *  if one is, keeping its own layout. Returns the new nodes' ids. */
  pasteClipboard: (target?: { view?: NodeRect }) => string[];

  // Selection & batch ops
  selectAll: () => void;
  duplicateSelected: () => void;
  deleteSelected: () => void;
  autoLayoutSelected: () => void;

  // Existing methods. addNode/addDynamicNode are async because static nodes
  // round-trip through cli_graph on the backend so Claude's `nebula graph` sees
  // them; they resolve to the short id (n1, n2, ...) on success, or a UUID only
  // when the backend is unreachable (local-only fallback). A backend rejection
  // resolves to null and leaves the canvas unchanged.
  addNode: (definitionId: string, position: { x: number; y: number }) => Promise<string | null>;
  addLocalCinemaMotionNode: (nodeId: string, shotId: string) => string | null;
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
  /** Give a node a custom name. Blank, or the model's own name, restores the default. */
  renameNode: (nodeId: string, label: string) => void;
  applyPaperSource: (nodeId: string, source: PaperSourceRecord) => void;
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
  cancelExecution: () => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  activeRuns: ActiveRun[];
  createLaunchingIds: string[];
  createCancelledLaunchIds: string[];
  reserveCreateGeneration: (genId: string) => boolean;
  releaseCreateGeneration: (genId: string) => void;
  cancelCreateGeneration: (genId: string) => void;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
  hydrateProviderRecoveries: (checkpoints: ProviderRecoveryCheckpoint[]) => void;
  deleteProviderRecovery: (runId: string, nodeId: string) => Promise<void>;
  /** The Delete key's guard (Canvas onBeforeDelete): false, with the canvas
   * notice saying why, when one of `nodeIds` holds World Labs state, so React
   * Flow removes neither the nodes nor their wires (round 3b). */
  allowCanvasDelete: (nodeIds: string[]) => boolean;
  hydrateProviderStartAmbiguities: (ambiguities: ProviderStartAmbiguity[]) => void;
  hydrateExecutionStatuses: (statuses: ExecutionStatusResult[]) => void;
  acknowledgeProviderStartAmbiguity: (
    kind: ProviderStartKind,
    nodeId: string,
  ) => Promise<void>;
  acknowledgeUncertainWorldLabsRun: () => void;
  reconcilePersistedWorldLabsRun: () => Promise<void>;
  dismissProviderRecoveryWarning: () => void;
  /** `approvalId`: the run a proposal's Accept approved (see AcceptedProposal). */
  executeNode: (nodeId: string, options?: { approvalId?: string }) => Promise<void>;
  /** Regenerate one tracked Cinema shot. Distinct shots may run concurrently.
   * `variations` > 1 generates seeded candidates into shot.variations. */
  executeShot: (nodeId: string, shotId: string, seed?: number, variations?: number) => Promise<void>;
  isShotAdmissionBlocked: (nodeId: string, shotId: string) => boolean;
  /** Promote a variation to the canonical scene image and dynamic output port. */
  promoteShotVariation: (nodeId: string, shotId: string, index: number) => Promise<void>;
  executeCluster: (nodeIds: string[], options?: { approvalId?: string }) => Promise<void>;
  executeClusterConcurrent: (nodeIds: string[], createOrigin?: CreateRunOrigin) => Promise<void>;
  authorGenerationCluster: (request: GenerationRequest) => Promise<{ modelNodeIds: string[]; allNodeIds: string[] }>;
  /** Merge what the backend committed for an accepted agent proposal (new nodes, wires, param changes). */
  adoptAcceptedProposal: (result: {
    nodes: Node<NodeData>[];
    edges: Edge[];
    updatedNodes: Node<NodeData>[];
  }, options?: { undoStep?: object; synced?: ReadonlySet<string> }) => void;
  deleteGeneration: (modelNodeIds: string[]) => void;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  loadGraph: (
    nodes: Node<NodeData>[],
    edges: Edge[],
    options?: { allowDuringExecution?: boolean; preserveCinemaUploads?: boolean },
  ) => void;
  /** A project replacement never cancels a paid run or drops unresolved authoring. */
  canSwitchProject: () => boolean;
  loadProjectGraph: (nodes: Node<NodeData>[], edges: Edge[], history: RunRecord[],
    options?: { bootstrap?: boolean }) => boolean;
  loadSampleGraph: () => void;
  autoLayout: () => void;
  runHistory: RunRecord[];
  rerunHistoryRecord: (runId: string) => Promise<void>;
  rerunHistoryWithLatestPaperSource: (runId: string) => Promise<void>;
  retryFailedRun: (runId: string) => Promise<void>;
  clearRunHistory: () => void;
  /** `undoStep`: the step beginUndoStep made before the backend clear, so the
   * clear stays one step even when the clear's graphSync landed first. */
  clearGraph: (options?: { undoStep?: object }) => void;
  /** The OpenRouter / Nous Portal picker: the backend configures the node for
   * the model (its ports, params) and drops wires the model has no port for. */
  configureOpenRouterModel: (nodeId: string, modelId: string, model?: OpenRouterModel) => Promise<void>;
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
  updateScene: (nodeId: string, spec: CinemaSceneSpec | ((current: CinemaSceneSpec) => CinemaSceneSpec | null)) => void;

  // Character and Moodboard node helpers. Create the static node with its
  // asset id in the public `character` / `moodboard` param; `meta` (what the
  // panel already shows) fills the card until its own fetch lands.
  // Mirror addNode's static path.
  addCharacterNode: (
    characterId: string,
    position: { x: number; y: number },
    meta?: { name?: string; thumbnail?: string },
  ) => Promise<string | null>;
  addMoodboardNode: (
    moodboardId: string,
    position: { x: number; y: number },
    meta?: { name?: string; thumbnail?: string; imageCount?: number; setAsideCount?: number; mode?: string },
  ) => Promise<string | null>;
}

// CLI nodes use short sequential IDs like n1, n2. Frontend-only (library-dragged)
// nodes use UUIDs. This regex lets graphSync distinguish them so we can preserve
// frontend-only work when cli_graph changes.
const CLI_ID_RE = /^n\d+$/;
const MAX_NODE_LABEL_LENGTH = 80;
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

const UNIVERSAL_MODEL_PARAM: Record<string, string> = {
  'openrouter-universal': 'model', 'nous-portal-universal': 'model', 'replicate-universal': 'model_id',
};
/** The canvas-owned params the backend sets with a model (universal_ports.DERIVED_PARAMS). */
const UNIVERSAL_DERIVED_PARAMS = ['_model_ports', '_output_image', '_version_id', '_schema_fetched'];
/** Nodes whose model request is in flight: their param pushes wait for it. */
const universalModelRequests = new Set<string>();

/** The backend keeps a universal node's ports (`_model_ports`) but not its
 * Inspector controls (a Replicate schema's params) or provider notes: a sync
 * keeps this canvas's while the node's model is the same. */
function keptUniversalFields(existing: Node<NodeData>, incoming: Node<NodeData>): Partial<DynamicNodeData> {
  const key = UNIVERSAL_MODEL_PARAM[existing.data.definitionId];
  const before = existing.data as Partial<DynamicNodeData>;
  if (!key || incoming.data.definitionId !== existing.data.definitionId
    || existing.data.params[key] !== incoming.data.params[key]) return {};
  return { dynamicParams: before.dynamicParams ?? [], providerMeta: before.providerMeta ?? {} };
}

/** A re-typed universal node's saved outputs on the ports it now has: one on
 * a port it no longer declares fails every project save (the backend's
 * _validate_imported_outputs; it drops them too, _drop_outputs_off_ports). */
function outputsOnPorts(outputs: NodeData['outputs'] | undefined, ports: ReadonlyArray<{ id: string }>): NodeData['outputs'] {
  return Object.fromEntries(Object.entries(outputs ?? {}).filter(([id]) => ports.some((p) => p.id === id)));
}

/** The canvas's outputs a sync without outputs keeps: all of them, unless
 * the backend re-typed the node (its `_model_ports` changed). */
function keptOutputs(existing: Node<NodeData>, incoming: Node<NodeData>): NodeData['outputs'] {
  const after = incoming.data.params._model_ports as { outputs?: { id: string }[] } | undefined;
  if (!UNIVERSAL_MODEL_PARAM[incoming.data.definitionId] || !after
    || JSON.stringify(existing.data.params._model_ports) === JSON.stringify(after)) return existing.data.outputs;
  return outputsOnPorts(existing.data.outputs, after.outputs ?? []);
}

/** Whether a wire's ends on universal nodes are ports those nodes have. */
function universalPortsHold(edge: Edge, nodesById: Map<string, Node<NodeData>>): boolean {
  const source = nodesById.get(edge.source)?.data as Partial<DynamicNodeData> | undefined;
  const target = nodesById.get(edge.target)?.data as Partial<DynamicNodeData> | undefined;
  if (source?.definitionId && UNIVERSAL_MODEL_PARAM[source.definitionId] && source.dynamicOutputPorts
    && source.dynamicOutputPorts.length > 0 && !source.dynamicOutputPorts.some((p) => p.id === edge.sourceHandle)) return false;
  if (target?.definitionId && UNIVERSAL_MODEL_PARAM[target.definitionId] && target.dynamicInputPorts
    && target.dynamicInputPorts.length > 0 && !target.dynamicInputPorts.some((p) => p.id === edge.targetHandle)) return false;
  return true;
}

/** What the backend answers for a universal node's model (POST
 * /api/graph/node/{id}/model, or /api/universal/ports for a node the backend
 * doesn't have yet). */
interface UniversalModelResult {
  params: Record<string, unknown>;
  dynamicInputPorts: DynamicPortDefinition[];
  dynamicOutputPorts: DynamicPortDefinition[];
  dynamicParams: DynamicParamDefinition[];
  providerMeta: Record<string, unknown>;
}

async function backendDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch { /* not JSON */ }
  return `HTTP ${response.status}`;
}

/** The node's params and ports for `model`, from the backend; null when the
 * node is gone. Throws with the backend's reason (a missing key, say). */
async function requestUniversalModel(nodeId: string, model: string): Promise<UniversalModelResult | null> {
  const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  if (CLI_ID_RE.test(nodeId)) {
    // The backend configures the params it holds: send an edit still waiting
    // on the debounce first, and hold the node's param pushes until the answer
    // (one sent meanwhile would carry the old model and its ports back).
    await flushNodeParams(nodeId);
    universalModelRequests.add(nodeId);
    try {
      const response = await graphMutationFetch(`/api/graph/node/${nodeId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) throw new Error(await backendDetail(response));
      return await response.json() as UniversalModelResult;
    } finally {
      universalModelRequests.delete(nodeId);
    }
  }
  // A node only this tab has (its backend create failed): the same rules,
  // applied to its params here.
  const response = await apiFetch('/api/universal/ports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definitionId: node.data.definitionId, model, params: node.data.params }),
  });
  if (!response.ok) throw new Error(await backendDetail(response));
  const body = await response.json() as {
    nodeParams: Record<string, unknown>; inputs: DynamicPortDefinition[]; outputs: DynamicPortDefinition[];
    params?: DynamicParamDefinition[]; providerMeta?: Record<string, unknown>;
  };
  return {
    params: body.nodeParams,
    dynamicInputPorts: body.inputs,
    dynamicOutputPorts: body.outputs,
    dynamicParams: body.params ?? [],
    providerMeta: body.providerMeta ?? {},
  };
}

/** The params the backend configured for the model, with the edits the
 * person made while it was read kept as typed (the model and the params it
 * sets are the answer's); the held push then sends them with the new model. */
function withEditsSinceRequest(nodeId: string, definitionId: string, configured: Record<string, unknown>,
  local: Record<string, unknown>): Record<string, unknown> {
  const entry = unsavedParamEdits.get(nodeId);
  if (!entry) return configured;
  const owned = new Set([UNIVERSAL_MODEL_PARAM[definitionId], ...UNIVERSAL_DERIVED_PARAMS]);
  const params = { ...configured };
  for (const key of entry.keys) {
    if (owned.has(key)) continue;
    if (key in local) params[key] = local[key];
    else delete params[key];
  }
  return params;
}

/** Whether a wire keeps its ends on the node's new ports (a wire leaving the
 * node is checked at its source end), as universal_ports.edge_fits says. */
function edgeFitsPorts(nodeId: string, edge: Edge, ports: Pick<UniversalModelResult, 'dynamicInputPorts' | 'dynamicOutputPorts'>): boolean {
  if (edge.source === nodeId) return ports.dynamicOutputPorts.some((p) => p.id === edge.sourceHandle);
  if (edge.target === nodeId) return ports.dynamicInputPorts.some((p) => p.id === edge.targetHandle);
  return true;
}

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

/** A shot's output without its status or the last failure's fields (error
 *  copy round 3c-2): a new run, or a failure Nebula wrote itself, must not
 *  show an earlier failure's person line or Details. */
function withoutShotError(output: CinemaShot['output']): Omit<NonNullable<CinemaShot['output']>, 'status'> {
  const rest: Partial<NonNullable<CinemaShot['output']>> = { ...(output ?? {}) };
  for (const key of ['status', 'error', 'errorCategory', 'errorFriendly', 'errorPerson', 'errorProviderText', 'errorProvider', 'errorRaw'] as const) delete rest[key];
  return rest;
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
          // The base model decides which key the scene needs.
          keyStatus: nodeKeyStatus(NODE_DEFINITIONS[data.definitionId], { ...data.params, scene },
            useUIStore.getState().settingsCache),
          // Deleted shot results have no live port. Historical runs retain their
          // original snapshot and outputs independently of the current scene.
          outputs: Object.fromEntries(Object.entries(data.outputs ?? {}).filter(
            ([portId]) => !portId.startsWith('shot_') || validHandleIds.has(portId),
          )),
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

// Per-node timers for debounced param-sync to the backend. Keyed by node id
// so one node's typing never stalls another node's flush.
const paramPushTimers: Record<string, number> = {};
const PARAM_PUSH_DEBOUNCE_MS = 250;

/**
 * Params the person changed on a backend node that the backend may not have
 * yet: typed but not sent (the debounce above), or sent and not answered.
 * A graphSync that lands meanwhile (an agent's edit, a run's result) keeps
 * these keys as the canvas has them, so it can't wipe what the person is
 * typing; the rest of the node follows the backend. Cleared once no write
 * for the node is waiting or in flight.
 */
const unsavedParamEdits = new Map<string, { keys: Set<string>; inFlight: number }>();

function noteParamEdit(nodeId: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key]);
  if (keys.length === 0) return;
  const entry = unsavedParamEdits.get(nodeId) ?? { keys: new Set<string>(), inFlight: 0 };
  for (const key of keys) entry.keys.add(key);
  unsavedParamEdits.set(nodeId, entry);
}

function settleParamEdit(nodeId: string, entry: { keys: Set<string>; inFlight: number }): void {
  if (unsavedParamEdits.get(nodeId) !== entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (entry.inFlight === 0 && paramPushTimers[nodeId] === undefined) unsavedParamEdits.delete(nodeId);
}

/** The backend's params for a node, with the keys the person hasn't saved yet kept as the canvas has them. */
function withUnsavedParams(nodeId: string, incoming: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
  const entry = unsavedParamEdits.get(nodeId);
  if (!entry) return incoming;
  const params = { ...incoming };
  for (const key of entry.keys) {
    if (key in local) params[key] = local[key];
    else delete params[key];
  }
  return params;
}
let pendingGraphMutationCount = 0;

async function trackGraphMutation<T>(operation: () => Promise<T>): Promise<T> {
  pendingGraphMutationCount += 1;
  try { return await operation(); }
  finally { pendingGraphMutationCount -= 1; }
}

function withGraphMutationLifetime<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  return (...args: Args): Promise<Result> => trackGraphMutation(() => operation(...args));
}

/** Even fire-and-forget layout/edge/param writes hold project navigation until
 * their backend request settles. Admission happens before invoking fetch. */
function graphMutationFetch(path: string, init?: RequestInit): Promise<Response> {
  return trackGraphMutation(() => apiFetch(path, init));
}

/** Send a node's params to the backend after the debounce; a node whose
 * model request is in flight waits for its answer (requestUniversalModel). */
function scheduleParamPush(nodeId: string): void {
  paramPushTimers[nodeId] = window.setTimeout(() => {
    delete paramPushTimers[nodeId];
    if (universalModelRequests.has(nodeId)) {
      scheduleParamPush(nodeId);
      return;
    }
    void pushNodeParams(nodeId);
  }, PARAM_PUSH_DEBOUNCE_MS);
}

function pushNodeParams(nodeId: string): Promise<void> {
  const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) {
    unsavedParamEdits.delete(nodeId);
    return Promise.resolve();
  }
  const edits = unsavedParamEdits.get(nodeId);
  if (edits) edits.inFlight += 1;
  return graphMutationFetch(`/api/graph/node/${nodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: node.data.params }),
  }).then(() => undefined).catch((err) => {
    console.warn(`[nebula] Param sync for ${nodeId} failed:`, err);
  }).finally(() => { if (edits) settleParamEdit(nodeId, edits); });
}

/** Send a node's debounced params now, if any are waiting. */
async function flushNodeParams(nodeId: string): Promise<void> {
  if (paramPushTimers[nodeId] === undefined) return;
  window.clearTimeout(paramPushTimers[nodeId]);
  delete paramPushTimers[nodeId];
  await pushNodeParams(nodeId);
}

function clearAllParamPushTimers(): void {
  for (const id of Object.keys(paramPushTimers)) {
    window.clearTimeout(paramPushTimers[id]);
    delete paramPushTimers[id];
  }
  unsavedParamEdits.clear();
}

interface CinemaScenePersistence {
  authoredScene: CinemaSceneSpec;
  pending: boolean;
  acknowledged: boolean;
  inFlight: AbortController | null;
  sentScenes: CinemaSceneSpec[];
  settleTimer: ReturnType<typeof setTimeout> | null;
}
const cinemaScenePersistence = new Map<string, CinemaScenePersistence>();
let suspendedCinemaScenes: Map<string, CinemaSceneSpec> | null = null;

function canonicalCinemaValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function cinemaAuthoringKey(scene: CinemaSceneSpec): string {
  // Asset references can be relative locally and absolute in graphSync.
  const normalized = rewriteBackendAssetUrls(scene);
  return canonicalCinemaValue({ ...normalized, shots: normalized.shots.map((shot) => {
    const authored = { ...shot };
    delete authored.output;
    delete authored.variations;
    delete authored.selectedVariation;
    return authored;
  }) });
}

function cinemaShotRuntimeKey(shot: CinemaShot): string {
  return canonicalCinemaValue({
    output: shot.output, variations: shot.variations, selectedVariation: shot.selectedVariation,
  });
}

/** Invalidate only this lifetime's queued writes. Abort is a client fence;
 * it cannot undo a mutation the backend has already committed. */
export function clearCinemaScenePersistence(nodeId?: string): void {
  if (nodeId === undefined) suspendedCinemaScenes = null;
  else suspendedCinemaScenes?.delete(nodeId);
  const ids = nodeId === undefined ? [...cinemaScenePersistence.keys()] : [nodeId];
  for (const id of ids) {
    const entry = cinemaScenePersistence.get(id);
    cinemaScenePersistence.delete(id);
    if (paramPushTimers[id] !== undefined) {
      window.clearTimeout(paramPushTimers[id]);
      delete paramPushTimers[id];
    }
    if (entry?.settleTimer) clearTimeout(entry.settleTimer);
    entry?.inFlight?.abort();
  }
}

/** An import can fail before replacing the graph. Keep the authored intent
 * while revoking its old requests and allowing authoritative import echoes. */
function suspendCinemaScenePersistence(): void {
  if (suspendedCinemaScenes !== null) return;
  const suspended = new Map<string, CinemaSceneSpec>();
  for (const nodeId of cinemaScenePersistence.keys()) {
    const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
    const scene = node?.data.params.scene as CinemaSceneSpec | undefined;
    if (node?.data.definitionId === 'cinema-scene' && scene?.shots) {
      suspended.set(nodeId, JSON.parse(JSON.stringify(scene)) as CinemaSceneSpec);
    }
  }
  clearCinemaScenePersistence();
  suspendedCinemaScenes = suspended;
}

function resumeCinemaScenePersistence(): void {
  const suspended = suspendedCinemaScenes;
  suspendedCinemaScenes = null;
  if (!suspended || useGraphStore.getState().backendFreshStartPending) return;
  for (const [nodeId, authored] of suspended) {
    const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
    const current = node?.data.params.scene as CinemaSceneSpec | undefined;
    if (node?.data.definitionId !== 'cinema-scene' || !current?.shots) continue;
    const currentShots = new Map(current.shots.map((shot) => [shot.id, shot]));
    const restored = { ...authored, shots: authored.shots.map((shot) => {
      const latest = currentShots.get(shot.id);
      return latest ? { ...shot, output: latest.output ?? shot.output,
        variations: latest.variations ?? shot.variations,
        selectedVariation: latest.selectedVariation ?? shot.selectedVariation } : shot;
    }) };
    applySceneToNode(useGraphStore.setState, nodeId, restored);
    persistSceneParam(nodeId, restored);
  }
}

function maybeSettleCinemaPersistence(nodeId: string, entry: CinemaScenePersistence): void {
  if (cinemaScenePersistence.get(nodeId) !== entry || entry.inFlight || entry.pending) return;
  if (entry.acknowledged) {
    clearCinemaScenePersistence(nodeId);
    return;
  }
  // A disconnected socket may never deliver the write's echo. Do not hide
  // unrelated external edits indefinitely after HTTP confirms the save.
  entry.settleTimer = setTimeout(() => {
    if (cinemaScenePersistence.get(nodeId) === entry && !entry.inFlight && !entry.pending) {
      clearCinemaScenePersistence(nodeId);
    }
  }, 5000);
}

async function flushCinemaScenePersistence(nodeId: string, entry: CinemaScenePersistence): Promise<void> {
  if (cinemaScenePersistence.get(nodeId) !== entry || entry.inFlight || !entry.pending
    || paramPushTimers[nodeId] !== undefined) return;
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  const scene = node?.data.params.scene as CinemaSceneSpec | undefined;
  if (node?.data.definitionId !== 'cinema-scene' || !scene?.shots) {
    clearCinemaScenePersistence(nodeId);
    return;
  }
  // Re-read live runtime media at dispatch, after earlier echoes/results.
  const sentScene = JSON.parse(JSON.stringify(scene)) as CinemaSceneSpec;
  entry.sentScenes.push(sentScene);
  if (entry.sentScenes.length > 32) entry.sentScenes.shift();
  entry.pending = false;
  const controller = new AbortController();
  entry.inFlight = controller;
  let failed = false;
  try {
    const response = await graphMutationFetch(`/api/graph/node/${nodeId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ params: { ...node.data.params, scene: sentScene } }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    failed = true;
    if (cinemaScenePersistence.get(nodeId) === entry && !controller.signal.aborted) {
      console.warn(`[nebula] Scene sync for ${nodeId} failed; edit again to retry:`, error);
    }
  } finally {
    if (cinemaScenePersistence.get(nodeId) === entry) {
      entry.inFlight = null;
      if (entry.pending) void flushCinemaScenePersistence(nodeId, entry);
      else if (failed) clearCinemaScenePersistence(nodeId);
      else maybeSettleCinemaPersistence(nodeId, entry);
    }
  }
}

/** Serialize whole-scene PUTs and coalesce edits while one is in flight.
 * Register the authoring overlay before any debounce can expose an old echo. */
function persistSceneParam(nodeId: string, scene: CinemaSceneSpec, debounceMs = 0): void {
  if (!CLI_ID_RE.test(nodeId)) return;
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  if (node?.data.definitionId !== 'cinema-scene') return;
  if (suspendedCinemaScenes !== null) {
    suspendedCinemaScenes.set(nodeId, JSON.parse(JSON.stringify(scene)) as CinemaSceneSpec);
    return;
  }
  let entry = cinemaScenePersistence.get(nodeId);
  if (!entry) {
    entry = { authoredScene: scene, pending: false, acknowledged: false,
      inFlight: null, sentScenes: [], settleTimer: null };
    cinemaScenePersistence.set(nodeId, entry);
  }
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = null;
  entry.authoredScene = JSON.parse(JSON.stringify(scene)) as CinemaSceneSpec;
  entry.acknowledged = false;
  entry.pending = true;
  if (paramPushTimers[nodeId] !== undefined) {
    window.clearTimeout(paramPushTimers[nodeId]);
    delete paramPushTimers[nodeId];
  }
  if (debounceMs > 0) {
    const owner = entry;
    paramPushTimers[nodeId] = window.setTimeout(() => {
      delete paramPushTimers[nodeId];
      void flushCinemaScenePersistence(nodeId, owner);
    }, debounceMs);
  } else void flushCinemaScenePersistence(nodeId, entry);
}

function mergePendingCinemaScene(nodeId: string, local: CinemaSceneSpec, incoming: CinemaSceneSpec): CinemaSceneSpec {
  const entry = cinemaScenePersistence.get(nodeId);
  if (!entry) return incoming;
  const incomingKey = cinemaAuthoringKey(incoming);
  if (incomingKey === cinemaAuthoringKey(entry.authoredScene)) {
    entry.acknowledged = true;
    maybeSettleCinemaPersistence(nodeId, entry);
  }
  const incomingShots = new Map(incoming.shots.map((shot) => [shot.id, shot]));
  return { ...local, shots: local.shots.map((shot) => {
    const received = incomingShots.get(shot.id);
    if (!received) return shot;
    const runtimeKey = cinemaShotRuntimeKey(received);
    const knownWriteEcho = entry.sentScenes.some((sent) => {
      const sentShot = sent.shots.find((candidate) => candidate.id === shot.id);
      return sentShot && cinemaAuthoringKey(sent) === incomingKey
        && cinemaShotRuntimeKey(sentShot) === runtimeKey;
    });
    if ((knownWriteEcho && cinemaShotRuntimeKey(shot) !== runtimeKey)
      || (shot.output?.status === 'running' && received.output?.status === 'idle')) return shot;
    return { ...shot, output: received.output ?? shot.output,
      variations: received.variations ?? shot.variations,
      selectedVariation: received.selectedVariation ?? shot.selectedVariation };
  }) };
}

/** A node for computeLayout, with the size the canvas measured if it has rendered. */
function layoutNode(node: Node<NodeData>): LayoutNode {
  return { id: node.id, width: node.measured?.width ?? node.width, height: node.measured?.height ?? node.height };
}

// Layout writes this tab has sent and not heard back from, per node. A graphSync
// that moved one of these nodes is the echo of an earlier write (or loses to the
// one in flight), so the canvas keeps the position it has.
const layoutWritesInFlight = new Map<string, number>();

// Wire writes this tab has sent (a connect, a delete, an undo's restore), by
// connection; `want`: whether the wire should be there. A wire between two
// backend nodes is the backend's: a graphSync without it takes it off the
// canvas, one with it draws it. Only while this tab's own write is out (and,
// after its answer, until a sync agrees or one more sync has come) does a
// sync that disagrees leave the wire as this tab has it.
type WireWrite = { want: boolean; sending: number; agreed?: boolean; grace?: boolean };
const wireWrites = new Map<string, WireWrite>();

/** Send one wire write (after `after`); a refusal puts the canvas back and says why. */
function sendWire(edge: Edge, want: boolean, set: GraphSet, after?: Promise<unknown>): Promise<unknown> {
  const done = holdWire(edge, want);
  const send = () => graphMutationFetch(want ? '/api/graph/connect' : '/api/graph/edge', {
    method: want ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: edge.source, sourceHandle: edge.sourceHandle ?? '',
      target: edge.target, targetHandle: edge.targetHandle ?? '' }),
  });
  // Sent at once unless it waits for `after`, as these requests always were.
  return (after ? after.then(send) : send()).then(async (response) => {
    done(response.ok);
    if (response.ok) return;
    const heading = `Couldn't ${want ? 'connect' : 'remove'} that wire.`;
    const text = `${heading} ${await backendRejectionReason(response, heading)}`;
    set((state) => ({
      edges: want ? state.edges.filter((e) => e.id !== edge.id)
        : state.edges.some((e) => edgeKey(e) === edgeKey(edge)) ? state.edges : [...state.edges, edge],
      undoNotice: { id: ++undoNoticeSeq, text, offer: null },
    }));
  }, (err) => {
    done(false);
    console.warn('[nebula] Wire sync failed:', err);
  });
}

/** Hold a wire write; call the result with whether the backend took it. */
function holdWire(edge: Edge | { source: string; sourceHandle: string; target: string; targetHandle: string },
  want: boolean): (took: boolean) => void {
  const key = edgeKey(edge);
  const write = wireWrites.get(key) ?? { want, sending: 0 };
  Object.assign(write, { want, sending: write.sending + 1, agreed: false, grace: false });
  wireWrites.set(key, write);
  return (took) => {
    write.sending -= 1;
    if (wireWrites.get(key) === write && !write.sending && (!took || write.agreed)) wireWrites.delete(key);
  };
}

/** What this sync must leave as this tab has it: connection -> want. */
function heldWires(cliEdges: Edge[]): Map<string, boolean> {
  const keys = new Set(cliEdges.map(edgeKey));
  const held = new Map<string, boolean>();
  for (const [key, write] of wireWrites) {
    // Once a sync agreed the backend has taken it: a later one that differs is newer.
    write.agreed ||= keys.has(key) === write.want;
    if (!write.sending && (write.agreed || write.grace)) wireWrites.delete(key);
    else if (!write.agreed) held.set(key, write.want);
    if (!write.sending) write.grace = true;
  }
  return held;
}

// Requests whose answer adds what they made (node-and-connect, Create's
// cluster, a proposal accept): the node ids and wires syncs carried while
// each was out. What a sync already carried is the syncs' to keep or remove,
// so the answer adds only what none has shown yet.
const syncWatchers = new Set<Set<string>>();
export function watchGraphSyncs(): { seen: ReadonlySet<string>; stop: () => void } {
  const seen = new Set<string>();
  syncWatchers.add(seen);
  return { seen, stop: () => syncWatchers.delete(seen) };
}

function persistNodePositions(positions: Record<string, { x: number; y: number }>): void {
  const persisted = Object.fromEntries(
    Object.entries(positions).filter(([nodeId]) => CLI_ID_RE.test(nodeId)),
  );
  const nodeIds = Object.keys(persisted);
  if (nodeIds.length === 0) return;
  for (const nodeId of nodeIds) layoutWritesInFlight.set(nodeId, (layoutWritesInFlight.get(nodeId) ?? 0) + 1);

  graphMutationFetch('/api/graph/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions: persisted }),
  }).catch((err) => {
    console.warn('[nebula] Layout sync failed:', err);
  }).finally(() => {
    for (const nodeId of nodeIds) {
      const left = (layoutWritesInFlight.get(nodeId) ?? 1) - 1;
      if (left > 0) layoutWritesInFlight.set(nodeId, left);
      else layoutWritesInFlight.delete(nodeId);
    }
  });
}

/**
 * Finish an agent's arrange request (lib/arrangeEdit.ts) with the positions
 * this canvas measured. The backend applies only the first write per id;
 * a tab that lost gets 'already-arranged' and changes nothing. Positions
 * reach every tab, this one included, through the graphSync `moved` list,
 * so this tab doesn't apply them first: two tabs can't end up disagreeing.
 * That sync is no undo step of its own: it joins the agent's step
 * (foldFinishedArrange).
 */
export async function completeArrange(
  arrangeId: string,
  positions: Record<string, { x: number; y: number }>,
): Promise<'arranged' | 'already-arranged' | 'refused'> {
  const persisted = Object.fromEntries(Object.entries(positions).filter(([nodeId]) => CLI_ID_RE.test(nodeId)));
  if (Object.keys(persisted).length === 0) return 'refused';
  const response = await graphMutationFetch('/api/graph/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions: persisted, arrangeId }),
  });
  if (!response.ok) return 'refused';
  const body = await response.json().catch(() => ({})) as { status?: string };
  return body.status === 'already-arranged' ? 'already-arranged' : 'arranged';
}

type GraphSet = (
  partial: Partial<GraphState> | ((state: GraphState) => Partial<GraphState>),
) => void;
type GraphGet = () => GraphState;

function applyCanvasNodeChanges(
  changes: NodeChange[],
  set: GraphSet,
  get: GraphGet,
  undoStep?: UndoEntry,
): void {
  const removedIds = changes
    .filter((change): change is NodeChange & { type: 'remove' } => change.type === 'remove')
    .map((change) => change.id);
  const settledPositions: Record<string, { x: number; y: number }> = {};
  for (const change of changes) {
    if (change.type === 'position' && change.position && change.dragging === false) {
      settledPositions[change.id] = change.position;
    }
  }

  if (removedIds.length === 0) {
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as Node<NodeData>[],
    }));
    persistNodePositions(settledPositions);
    return;
  }

  // A backend deletion took its step before sending (its graphSync can land first).
  const stack = get().undoStack;
  if (!undoStep || stack[stack.length - 1] !== undoStep) pushUndo(set, get);
  set((state) => {
    const nextNodes = applyNodeChanges(changes, state.nodes) as Node<NodeData>[];
    const nextEdges = state.edges.filter(
      (edge) => !removedIds.includes(edge.source) && !removedIds.includes(edge.target),
    );

    // Rule B-1: prune TrackItems whose sourceNodeId matches a removed node.
    const updatedNodes = nextNodes.map((node) => {
      if (node.data?.definitionId !== 'remotion-node') return node;
      const currentParams = (node.data.params ?? {}) as Record<string, unknown>;
      const manifest = currentParams.manifest as VideoGraphManifest | undefined;
      if (!manifest) return node;

      let nextManifest = manifest;
      let anyChange = false;
      for (const removedId of removedIds) {
        const result = pruneTrackItemsForDeletedNode(nextManifest, removedId);
        if (result.changed) {
          nextManifest = result.manifest;
          anyChange = true;
        }
      }
      if (!anyChange) return node;
      return {
        ...node,
        data: { ...node.data, params: { ...currentParams, manifest: nextManifest } },
      };
    });

    return { nodes: updatedNodes, edges: nextEdges };
  });
  persistNodePositions(settledPositions);
}

/** Resolves when the backend confirmed the delete, or answered that the node
 * is already gone (404: another window or an agent removed it; the person
 * wanted it gone, as restore treats an already-gone node); else rejects
 * with the reason the person reads (GM's line for the status, or the
 * backend's written reason). */
async function deleteCLIOriginNode(nodeId: string): Promise<RemovalRecord | null> {
  const response = await graphMutationFetch(`/api/graph/node/${nodeId}`, { method: 'DELETE' });
  if (response.status === 404) return null;
  if (!response.ok) throw await requestError("Couldn't delete the node.", response);
  // What the delete removed (the pins it detached, the proposals it closed),
  // kept in the undo step so undo puts them back.
  const body = await response.json().catch(() => ({})) as { removal?: unknown };
  return cleanRemovals([body.removal])[0] ?? null;
}

/** GM's notice after a delete: "Deleted the node." / "Deleted {n} nodes.",
 * with Undo for the step that holds it (round 3f's confirm is gone). */
function deletedNotice(count: number, step: UndoEntry): Partial<GraphState> {
  return { undoNotice: { id: ++undoNoticeSeq, text: deletedNoticeText(count), offer: 'undo', entry: step } };
}

/** The nodes stay on the canvas (their delete wasn't confirmed). GM's
 * pattern: "Couldn't delete the node." then the reason, each reason once. */
function deletionHeading(count: number): string {
  return count === 1 ? "Couldn't delete the node." : `Couldn't delete ${count} nodes.`;
}

function reportNodeDeletionFailure(reasons: string[], count: number): void {
  const heading = deletionHeading(count);
  const message = `${heading} ${[...new Set(reasons)].join(' ')}`;
  console.warn(`[nebula] ${message}`);
  useGraphStore.getState().notify(message);
}


function trackedRunHasFreshPaidWorldLabs(runId: string, get: GraphGet): boolean {
  const record = get().runHistory.find((candidate) => candidate.id === runId);
  return Boolean(record && (record.startedFreshPaidWorldLabs === true
    || (record.startedFreshPaidWorldLabs === undefined
      && runIncludesFreshPaidWorldLabsStart(record.snapshot, record.targetNodeId))));
}

function settleTrackedExecutionStatus(
  status: 'cancelled' | 'completed' | 'failed',
  runId: string,
  set: GraphSet,
  get: GraphGet,
  extra: Partial<Pick<RunRecord, 'statusNote' | 'durationSec' | 'nodesExecuted'>> = {},
): void {
  const owner = activeRunOwners.get(runId);
  if (!owner) return;
  if (status === 'cancelled') rememberCancelledRun(runId);
  const failed = status === 'failed' || runErrors.get(runId) === true;
  closeTrackedRun(set, runId, {
    status: status === 'completed' ? (failed ? 'failed' : 'complete') : status,
    ...extra,
  });
  set((state) => ({
    ...ownershipState(),
    uncertainWorldLabsRunId: state.uncertainWorldLabsRunId === runId ? null : state.uncertainWorldLabsRunId,
    nodes: state.nodes.map((node) => {
      if (!owner.nodeIds.includes(node.id) || scopeOverlaps([node.id])) return node;
      const pending = node.data.state === 'queued' || node.data.state === 'executing';
      return { ...node, data: { ...node.data,
        // A zero-item iterator or failed dependency can skip an invocation,
        // leaving prequeued descendants without an executed event.
        state: pending ? 'idle' as const : node.data.state,
        progress: undefined,
        ...(pending ? { streamingText: undefined, streamingPartials: undefined, streamingSvg: undefined } : {}),
      } };
    }),
  }));
  if (owner.kind === 'cinema-shot' && owner.nodeId && owner.shotId) {
    const node = get().nodes.find((candidate) => candidate.id === owner.nodeId);
    const scene = node?.data.params.scene as CinemaSceneSpec | undefined;
    if (scene?.shots) applySceneToNode(set, owner.nodeId, { ...scene, shots: scene.shots.map((shot) =>
      shot.id === owner.shotId && shot.output?.status === 'running'
        ? { ...shot, output: { ...shot.output, status: status === 'cancelled' ? 'idle' : failed ? 'error' : shot.output.imageUrl ? 'done' : 'idle',
          error: failed ? (shot.output.error ?? 'Shot generation failed.') : undefined } }
        : shot) });
  }
  if (get().providerRecoveryWarning === WORLD_LABS_STATUS_UNCERTAIN_WARNING) {
    set({ providerRecoveryWarning: null });
  }
}

async function requestTrackedCancellation(
  runId: string,
  set: GraphSet,
  get: GraphGet,
): Promise<void> {
  if (!ownsRun(runId)) return;
  cancellationRequestedRunIds.add(runId);
  updateRunPhase(runId, 'cancelling', set);
  try {
    const result = await apiCancelExecution(runId);
    if (!ownsRun(runId)) return;
    if (result.status === 'cancelling') {
      // A paid provider POST may still be settling so its recovery ID can be
      // captured. Keep retrying authoritative status until a terminal event.
      updateRunPhase(runId, 'cancelling', set);
      clearConfirmedRunAdvisory(runId, set);
      scheduleWorldLabsStatusReconciliation(runId, set, get);
      return;
    }
    settleTrackedExecutionStatus(result.status, runId, set, get);
  } catch (error) {
    console.error('Failed to cancel execution:', error);
    if (!ownsRun(runId)) return;
    // The client-owned run ID may not be registered yet when Stop races the
    // start request. Preserve the cancellation intent and retry via status
    // reconciliation instead of silently allowing that later start to run.
    updateRunPhase(runId, 'cancelling', set);
    scheduleWorldLabsStatusReconciliation(runId, set, get);
  }
}

async function honorCancellationAfterStart(
  runId: string,
  startStatus: string,
  set: GraphSet,
  get: GraphGet,
): Promise<boolean> {
  if (!cancellationRequestedRunIds.has(runId) || !ownsRun(runId)) return false;
  if (startStatus !== 'started') {
    // The request was definitively rejected before execution, but Stop remains
    // the user's terminal intent for the locally opened history record.
    settleTrackedExecutionStatus('cancelled', runId, set, get);
    return true;
  }
  if (startStatus === 'started') {
    await requestTrackedCancellation(runId, set, get);
    return true;
  }
  return false;
}

async function reconcileWorldLabsExecutionStatus(
  runId: string,
  set: GraphSet,
  get: GraphGet,
): Promise<'active' | 'terminal' | 'unknown' | 'stale'> {
  let result;
  try {
    result = await apiGetExecutionStatus(runId);
  } catch {
    if (!ownsRun(runId)) return 'stale';
    const paidStart = trackedRunHasFreshPaidWorldLabs(runId, get);
    updateRunPhase(runId, cancellationRequestedRunIds.has(runId) ? 'cancelling' : 'uncertain', set);
    set((state) => ({
      ...ownershipState(),
      uncertainWorldLabsRunId: paidStart ? runId : null,
      providerRecoveryWarning: paidStart
        ? WORLD_LABS_STATUS_UNCERTAIN_WARNING
        : state.providerRecoveryWarning,
    }));
    if (cancellationRequestedRunIds.has(runId) || !paidStart) {
      scheduleWorldLabsStatusReconciliation(runId, set, get);
    }
    return 'unknown';
  }
  if (!ownsRun(runId)) return 'stale';
  if (result.status === 'running' || result.status === 'cancelling') {
    clearConfirmedRunAdvisory(runId, set);
    if (cancellationRequestedRunIds.has(runId)) {
      updateRunPhase(runId, 'cancelling', set);
      void requestTrackedCancellation(runId, set, get);
      return 'active';
    }
    updateRunPhase(runId, result.status === 'cancelling' ? 'cancelling' : 'running', set);
    set({ uncertainWorldLabsRunId: null });
    scheduleWorldLabsStatusReconciliation(runId, set, get);
    return 'active';
  }
  settleTrackedExecutionStatus(result.status, runId, set, get);
  return 'terminal';
}

function scheduleWorldLabsStatusReconciliation(
  runId: string,
  set: GraphSet,
  get: GraphGet,
): void {
  if (!ownsRun(runId) || statusReconciliationTimers.has(runId)) return;
  const timer = setTimeout(() => {
    statusReconciliationTimers.delete(runId);
    void reconcileWorldLabsExecutionStatus(runId, set, get);
  }, 2_000);
  statusReconciliationTimers.set(runId, timer);
}

function normalizedProviderStartAmbiguities(
  values: readonly ProviderStartAmbiguity[],
): ProviderStartAmbiguity[] {
  const byNode = new Map<string, ProviderStartAmbiguity>();
  for (const value of values) {
    if (!isProviderStartAmbiguity(value)) continue;
    byNode.set(`${value.kind}\u0000${value.nodeId}`, { ...value });
  }
  // Safety records are never capacity-evicted in the browser. A stale
  // over-lock is recoverable; silently dropping an authoritative hold is not.
  return [...byNode.values()];
}

function normalizedProviderRecoveries(
  values: readonly ProviderRecoveryCheckpoint[],
): ProviderRecoveryCheckpoint[] {
  const byRunNode = new Map<string, ProviderRecoveryCheckpoint>();
  for (const value of values) {
    const resume = typeof value?.resumeOperationId === 'string'
      && value.resumeOperationId.trim().length > 0;
    const world = typeof value?.existingWorldId === 'string'
      && value.existingWorldId.trim().length > 0;
    if (!value || typeof value.runId !== 'string' || !value.runId
      || typeof value.nodeId !== 'string' || !value.nodeId
      || resume === world) continue;
    byRunNode.set(`${value.runId}\u0000${value.nodeId}`, { ...value });
  }
  return [...byRunNode.values()];
}

function mergeProviderRecoverySnapshot(
  current: readonly ProviderRecoveryCheckpoint[],
  snapshot: readonly ProviderRecoveryCheckpoint[],
): ProviderRecoveryCheckpoint[] {
  const merged = normalizedProviderRecoveries(current);
  for (const incoming of normalizedProviderRecoveries(snapshot)) {
    const index = merged.findIndex((checkpoint) => (
      checkpoint.runId === incoming.runId && checkpoint.nodeId === incoming.nodeId
    ));
    if (index < 0) {
      merged.push(incoming);
      continue;
    }
    const existing = merged[index];
    // A snapshot may advance operation -> world or confirm that a volatile
    // in-tab record became durable. It may never rewind/replace a newer live ID.
    if ((!existing.existingWorldId && incoming.existingWorldId)
      || (existing.durable === false && incoming.durable !== false
        && existing.resumeOperationId === incoming.resumeOperationId
        && existing.existingWorldId === incoming.existingWorldId)) {
      merged[index] = incoming;
    }
  }
  return merged;
}

function mergeProviderStartAmbiguitySnapshot(
  current: readonly ProviderStartAmbiguity[],
  snapshot: readonly ProviderStartAmbiguity[],
): ProviderStartAmbiguity[] {
  const merged = normalizedProviderStartAmbiguities(current);
  const keys = new Set(merged.map((value) => `${value.kind}\u0000${value.nodeId}`));
  for (const incoming of normalizedProviderStartAmbiguities(snapshot)) {
    const key = `${incoming.kind}\u0000${incoming.nodeId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(incoming);
  }
  return merged;
}

function historyWithoutProviderRecovery(
  history: RunRecord[],
  runId: string,
  nodeId: string,
  expected: ProviderRecoveryCheckpoint,
): RunRecord[] {
  const expectedKey = expected.resumeOperationId
    ? 'resume_operation_id'
    : 'existing_world_id';
  const expectedId = expected.resumeOperationId ?? expected.existingWorldId;
  return history.map((record) => {
    if (record.id !== runId) return record;
    let changed = false;
    const snapshot = freezeRunSnapshot({
      ...record.snapshot,
      nodes: record.snapshot.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const params = { ...node.params };
        if (!expectedId || params[expectedKey] !== expectedId) return node;
        changed = true;
        delete params.resume_operation_id;
        delete params.existing_world_id;
        return { ...node, params };
      }),
    });
    return changed
      ? {
          ...record,
          snapshot,
          statusNote: 'Recovery safeguard cleared after an explicit Marble check.',
        }
      : record;
  });
}

function blockedProviderStart(
  snapshot: RunGraphSnapshot,
  ambiguities: readonly ProviderStartAmbiguity[],
  targetNodeId?: string,
): ProviderStartAmbiguity | null {
  const scopeIds = snapshotExecutionScopeIds(snapshot, targetNodeId);
  const paidKinds = new Set(snapshot.nodes
    .filter((node) => scopeIds.has(node.id))
    .filter((node) => runIncludesFreshPaidWorldLabsStart({ nodes: [node], edges: [] }))
    .map((node) => node.definitionId));
  // A replacement/duplicated canvas node can represent the same request with
  // a new ID. Until Marble is checked, fail closed for the entire paid kind.
  return ambiguities.find((ambiguity) => paidKinds.has(ambiguity.kind)) ?? null;
}

function warnBlockedProviderStart(ambiguity: ProviderStartAmbiguity): void {
  console.warn(
    `[nebula] Paid World Labs start blocked for ${ambiguity.nodeId}: ${ambiguity.message}`,
  );
}

function nodeHasProviderSafety(state: GraphState, nodeId: string): boolean {
  return state.providerRecoveries.some((checkpoint) => checkpoint.nodeId === nodeId)
    || state.providerStartAmbiguities.some((ambiguity) => ambiguity.nodeId === nodeId);
}

/**
 * The person asked to delete `ids` and the canvas keeps them, because one
 * holds World Labs state (error copy round 3b: a refusal that says nothing
 * is the worst kind). True when it refused: it says why once, in the
 * canvas's short notice ("Couldn't delete the node." and the backend's
 * per-state line, lib/worldLabsWaiting), and sends nothing. An agent's delete
 * goes through the backend, which refuses it with its own text.
 */
function refuseHeldNodeDelete(state: GraphState, ids: string[], set: GraphSet): boolean {
  const held = ids.filter((nodeId) => nodeHasProviderSafety(state, nodeId));
  if (held.length === 0) return false;
  // The backend's order: an unconfirmed start before a recovery record.
  const unlock = held.some((nodeId) => state.providerStartAmbiguities.some((ambiguity) => ambiguity.nodeId === nodeId));
  set({ undoNotice: { id: ++undoNoticeSeq, text: `${deletionHeading(ids.length)} ${waitingOnWorldLabs(ids.length, unlock)}`, offer: null } });
  return true;
}

/**
 * What Cmd+C copied. It survives opening another project, so nodes copy from
 * one project to another (a Moodboard node keeps pointing at its board).
 *
 * `source` names the canvas the nodes came from: its project and which load
 * of it (`load` counts project loads). `params` holds each node's
 * provider-safe params worked out at copy time against that canvas's own
 * recovery checkpoints and start ambiguities, or null when cloning it wasn't
 * safe then. Those lists are keyed by node id and node ids restart per
 * project, so after a switch the open canvas's lists say nothing about these
 * nodes (or, worse, name a different node with the same id).
 */
export interface CanvasClipboard {
  nodes: Node<NodeData>[];
  edges: Edge[];
  source: { projectId: string | null; load: number };
  params: Record<string, Record<string, unknown> | null>;
}

/** Bumped by every project load: a clipboard from an earlier load is foreign. */
let canvasLoad = 0;

function sameCanvas(source: CanvasClipboard['source']): boolean {
  return source.load === canvasLoad && source.projectId === (getProjectContext()?.id ?? null);
}

/** The params to paste for each clipboard node, or null if any isn't safe to clone. */
function clipboardPasteParams(
  state: GraphState,
  clipboard: CanvasClipboard,
): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  const here = sameCanvas(clipboard.source);
  for (const node of clipboard.nodes) {
    if (here) {
      // On the canvas it came from: check against what this canvas knows now
      // (a checkpoint or an ambiguity may have arrived since the copy), as a
      // duplicate does. Unchanged from before the clipboard outlived a switch.
      const params = providerSafeCloneParams(state, node);
      if (!params) return null;
      result.set(node.id, params);
      continue;
    }
    // From another canvas (or an earlier load of this one): what was unsafe
    // when copied stays unsafe; else the copy-time params, and the node-local
    // check that a blank paid World Labs start never becomes a new one.
    const copied = clipboard.params[node.id];
    if (!copied) return null;
    if (runIncludesFreshPaidWorldLabsStart({
      nodes: [{ id: node.id, definitionId: node.data.definitionId, params: copied, outputs: {} }], edges: [],
    })) return null;
    result.set(node.id, { ...copied });
  }
  return result;
}

/** A node's box in flow coordinates, with the size the canvas measured if it has rendered. */
function nodeRect(node: Node<NodeData>): NodeRect {
  return {
    x: node.position.x, y: node.position.y,
    width: node.measured?.width ?? node.width ?? UNMEASURED_NODE_SIZE.width,
    height: node.measured?.height ?? node.height ?? UNMEASURED_NODE_SIZE.height,
  };
}

/** How far to move the clipboard's nodes on paste. The copies' own
 * coordinates mean nothing on another canvas, so a paste from another load
 * goes to the middle of the view (or, with no view given, where it was) and
 * then clear of what's there. On the canvas it came from it stays +20 px. */
function pasteOffset(
  state: GraphState,
  clipboard: CanvasClipboard,
  view: NodeRect | undefined,
): { x: number; y: number } {
  if (sameCanvas(clipboard.source)) return { x: 20, y: 20 };
  const group = clipboard.nodes.map(nodeRect);
  const box = view ?? boundingRect(group);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return findOpenGroupOffset(group, state.nodes.map(nodeRect), center, view);
}

/** Clone the provider state attached to the source node, not a stale object
 * captured before the paid-start recovery event arrived. Returning null is a
 * fail-closed signal for an ambiguous source that has no safe ID to copy. */
function providerSafeCloneParams(
  state: GraphState,
  node: Node<NodeData>,
): Record<string, unknown> | null {
  if (state.providerStartAmbiguities.some((ambiguity) => ambiguity.nodeId === node.id)) {
    return null;
  }
  const checkpoint = [...state.providerRecoveries]
    .reverse()
    .find((candidate) => candidate.nodeId === node.id);
  if (!checkpoint) {
    const snapshot = {
      nodes: [{
        id: node.id,
        definitionId: node.data.definitionId,
        params: node.data.params,
        outputs: {},
      }],
      edges: [],
    };
    // A disconnected/stale tab can still hold blank pre-run params after a
    // different tab persisted the accepted provider ID. Never turn that stale
    // object into a new paid node ID. Users can add a new Environment/Export
    // node explicitly when they really intend a separate paid start.
    if (runIncludesFreshPaidWorldLabsStart(snapshot)) return null;
    return { ...node.data.params };
  }
  return applyProviderRecoveryToLiveParams(
    node.data.definitionId,
    node.data.params,
    checkpoint,
  );
}

const WORLD_LABS_UNSAFE_CLONE_MESSAGE =
  'Nebula did not duplicate this fresh paid World Labs node. Add a new node from the Nodes rail when you intentionally want a separate paid operation.';

function warnUnsafeProviderClone(): void {
  console.warn(`[nebula] ${WORLD_LABS_UNSAFE_CLONE_MESSAGE}`);
  useGraphStore.getState().notify(WORLD_LABS_UNSAFE_CLONE_MESSAGE);
}

function sameProviderRecoveryIdentity(
  left: ProviderRecoveryCheckpoint,
  right: ProviderRecoveryCheckpoint,
): boolean {
  return left.runId === right.runId
    && left.nodeId === right.nodeId
    && left.resumeOperationId === right.resumeOperationId
    && left.existingWorldId === right.existingWorldId;
}

/** The fields React Flow and this canvas keep on a node, which a graphSync's
 * copy of the node doesn't carry. */
function canvasOwnFields(node: Node<NodeData>): Partial<Node<NodeData>> {
  const own: Partial<Node<NodeData>> = {};
  if (node.measured) own.measured = node.measured;
  // `false` too: React Flow leaves `selected: false` / `dragging: false` on a
  // node once a selection or drag ends, and dropping them made the node
  // differ from the canvas's copy, so the next sync re-rendered its card.
  if (typeof node.selected === 'boolean') own.selected = node.selected;
  if (typeof node.dragging === 'boolean') own.dragging = node.dragging;
  return own;
}

/** The nodes with none selected; a node that wasn't stays the same object,
 * so only the cards losing the selection re-render. */
function deselectedNodes(nodes: Node<NodeData>[]): Node<NodeData>[] {
  return replaceChanged(nodes, (node) => (node.selected ? { ...node, selected: false } : node));
}

function nodesWithProviderRecoveries(
  nodes: Node<NodeData>[],
  checkpoints: readonly ProviderRecoveryCheckpoint[],
): Node<NodeData>[] {
  const latestByNode = new Map<string, ProviderRecoveryCheckpoint>();
  for (const checkpoint of checkpoints) latestByNode.set(checkpoint.nodeId, checkpoint);
  let changed = false;
  const next = nodes.map((node) => {
    const checkpoint = latestByNode.get(node.id);
    if (!checkpoint) return node;
    const params = applyProviderRecoveryToLiveParams(
      node.data.definitionId,
      node.data.params,
      checkpoint,
    );
    if (!params || params === node.data.params) return node;
    changed = true;
    return { ...node, data: { ...node.data, params } };
  });
  return changed ? next : nodes;
}

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
  if (isExecuting || get().isImportingGraph || source.status === 'running') return;
  if (isWorldLabsRecoveryReplayBlocked(source)) {
    console.warn(
      '[nebula] Saved replay blocked: a failed/cancelled World Labs snapshot may omit a paid operation recovery ID. Use the live node after checking Marble.',
    );
    return;
  }

  // Every replay runs the recipe as it would run now: values saved before a
  // params upgrade are upgraded here, once for every replay action. The
  // source record stays as it was sent, and the new record holds what this
  // replay sends, stamped current.
  const snapshot = freezeRunSnapshot(currentRunSnapshot(source));
  const targetNodeId = source.targetNodeId;
  if (targetNodeId && !snapshot.nodes.some((node) => node.id === targetNodeId)) return;
  const heldStart = blockedProviderStart(
    snapshot,
    get().providerStartAmbiguities,
    targetNodeId,
  );
  if (heldStart) {
    warnBlockedProviderStart(heldStart);
    return;
  }

  resetExecution();
  const runId = uuidv4();
  const scopeIds = snapshotExecutionScopeIds(snapshot, targetNodeId);
  currentRunId = runId;
  registerRun(runId, snapshot, targetNodeId, source.cinemaShot?.shotId);
  set((state) => ({
    nodes: markSnapshotScopeQueued(state.nodes, scopeIds),
    activeRuns: ownershipState().activeRuns,
    isExecuting: true,
    isCancelling: false,
    runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
      id: runId,
      trigger: source.trigger,
      startedAt: Date.now(),
      snapshot,
      targetNodeId,
      sourceRunId: source.id,
      replayAction,
      createOrigin: source.createOrigin,
      cinemaShot: source.cinemaShot,
      startedFreshPaidWorldLabs: runIncludesFreshPaidWorldLabsStart(snapshot, targetNodeId),
    })),
  }));

  pendingStartRunIds.add(runId);
  try {
    const result = source.cinemaShot
      ? await apiGenerateShot(snapshot.nodes, snapshot.edges.map((edge) => ({ ...edge,
        sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })), source.cinemaShot.nodeId,
        source.cinemaShot.shotId, source.cinemaShot.seed, source.cinemaShot.variations, runId)
      : targetNodeId
      ? await apiExecuteNode(snapshot.nodes, snapshot.edges, targetNodeId, runId, true)
      : await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId, true);
    pendingStartRunIds.delete(runId);
    if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
    if (result.status === 'started' && ownsRun(runId)) {
      updateRunPhase(runId, 'running', set);
      if (source.cinemaShot) scheduleWorldLabsStatusReconciliation(runId, set, get);
    }
    if (result.status !== 'started' && result.status !== 'validation_error') {
      throw new ExecutionStartRejectedError(
        notStartedMessage("Couldn't start the run.", result.status),
        400,
      );
    }
    if (result.status === 'validation_error' && currentRunId === runId) {
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesWithValidationErrors(
          state.nodes,
          scopeIds,
          'errors' in result ? result.errors as ExecutionValidationError[] : undefined,
        ),
        ...ownershipState(),
      }));
    }
  } catch (err) {
    settleFailedStart(runId, err);
    console.error('Failed to replay historical run:', err);
    if (currentRunId !== runId) return;
    if (!(err instanceof ExecutionStartRejectedError)) {
      await reconcileWorldLabsExecutionStatus(runId, set, get);
      return;
    }
    closeCurrentRun(set, { status: 'failed' });
    set((state) => ({
      nodes: markNodesErrored(
        state.nodes,
        scopeIds,
        failureMessage(err, "Couldn't start the run."),
      ),
      ...ownershipState(),
    }));
  }
}

async function ensureBackendFreshForLocalCanvas(
  localCanvasWasEmpty: boolean,
  set: GraphSet,
  get: GraphGet,
): Promise<boolean> {
  if (!localCanvasWasEmpty && !get().backendFreshStartPending) return true;

  const backendWasDiscovered = getCachedBackendBaseUrl() !== null;
  let exportRes: Response;
  try {
    exportRes = await apiFetch('/api/graph/export');
  } catch {
    set({ backendFreshStartPending: true });
    if (!backendWasDiscovered && getCachedBackendBaseUrl() === null) return false;
    // Written lines under reportNodeCreationFailure's "Couldn't add {node}."
    // (error copy round 3e).
    throw new FailureNotice('', "Nebula lost contact with its backend, so the node wasn't added. Reconnect, then add it again.");
  }

  if (!exportRes.ok) {
    throw new FailureNotice('', await backendRejectionReason(exportRes, "Couldn't check the canvas."));
  }

  let exported: { empty?: boolean };
  try {
    exported = (await exportRes.json()) as { empty?: boolean };
  } catch {
    throw new FailureNotice('', "Nebula couldn't read the backend's answer, so the node wasn't added. Reload, then add it again.");
  }

  if (exported.empty === false) {
    let clearRes: Response;
    try {
      // force: the backend refuses a clear of a project with nodes without it.
      clearRes = await graphMutationFetch('/api/graph?force=true', { method: 'DELETE' });
    } catch {
      set({ backendFreshStartPending: true });
      throw new FailureNotice('', "Nebula lost the answer to clearing the canvas, so the node wasn't added. "
        + 'The canvas may be clear already. Reload before you add it again.');
    }
    if (!clearRes.ok) {
      throw new FailureNotice('', await backendRejectionReason(clearRes, "Couldn't clear the canvas."));
    }
  }

  set({ backendFreshStartPending: false });
  return true;
}

/** A start the backend answered with a status other than started (not an
 * HTTP status: the run's own, e.g. "busy"). GM: the status stays in the
 * console; the person reads the heading and GM's line. */
function notStartedMessage(heading: string, status: string | undefined): string {
  console.warn(`[nebula] ${heading} start status: ${status || 'unknown'}`);
  return `${heading} ${REFUSED_FALLBACK_COPY}`;
}

/** The reason line for a refused canvas request (error-copy round 2, GM):
 * the backend's written reason, or GM's line for the status; the status
 * itself goes to the console under `heading`, once per call site. */
async function backendRejectionReason(response: Response, heading: string): Promise<string> {
  const detail = await readDetail(response);
  warnFailure(heading, response.status, detail);
  return copyForStatus(response.status, detail);
}

type NodeCreationAttempt = {
  definitionId: string;
  displayName: string;
  position: { x: number; y: number };
  knownCliNodeIds: Set<string>;
  phase: 'sending' | 'uncertain';
  observedNodeId?: string;
};

let pendingNodeCreationAttempt: NodeCreationAttempt | null = null;
type ConnectedNodeCreationAttempt = NodeCreationAttempt & {
  params: Record<string, unknown>;
  originId: string;
  originDefinitionId: string;
  connect: {
    source: string; sourceHandle: string; target: string; targetHandle: string;
    newNodeIs: 'source' | 'target';
  };
};
let pendingConnectedNodeCreationAttempt: ConnectedNodeCreationAttempt | null = null;
let canvasReplacementRevision = 0;

function nodeMatchesCreationAttempt(
  node: Node<NodeData>,
  attempt: NodeCreationAttempt,
): boolean {
  return CLI_ID_RE.test(node.id)
    && !attempt.knownCliNodeIds.has(node.id)
    && node.data?.definitionId === attempt.definitionId
    && Math.abs((node.position?.x ?? Number.NaN) - attempt.position.x) < 0.001
    && Math.abs((node.position?.y ?? Number.NaN) - attempt.position.y) < 0.001;
}

function observePendingNodeCreation(nodes: Node<NodeData>[]): string | null {
  const attempt = pendingNodeCreationAttempt;
  if (!attempt) return null;
  const matches = nodes.filter((node) => nodeMatchesCreationAttempt(node, attempt));
  if (matches.length !== 1) return null;
  attempt.observedNodeId = matches[0].id;
  return matches[0].id;
}

function observePendingConnectedNodeCreation(nodes: Node<NodeData>[], edges: Edge[]): void {
  const attempt = pendingConnectedNodeCreationAttempt;
  if (!attempt) return;
  const origin = nodes.find((node) => node.id === attempt.originId
    && node.data.definitionId === attempt.originDefinitionId);
  const matches = origin ? nodes.filter((node) => nodeMatchesCreationAttempt(node, attempt)
    && Object.entries(attempt.params).every(([key, value]) => JSON.stringify(node.data.params[key]) === JSON.stringify(value))
    && edges.some((edge) => typeof edge.id === 'string' && edge.id && edge.type === 'typed-edge'
      && edge.source === (attempt.connect.newNodeIs === 'source' ? node.id : attempt.originId)
      && edge.target === (attempt.connect.newNodeIs === 'target' ? node.id : attempt.originId)
      && edge.sourceHandle === attempt.connect.sourceHandle && edge.targetHandle === attempt.connect.targetHandle)) : [];
  attempt.observedNodeId = matches.length === 1 ? matches[0].id : undefined;
  // An unrelated sync or a standalone node cannot resolve a potentially
  // committed pair. A sending request remains locked until its HTTP settles.
  if (attempt.phase === 'uncertain' && attempt.observedNodeId) pendingConnectedNodeCreationAttempt = null;
}

function reportNodeCreationFailure(displayName: string, reason: string): null {
  const message = `Couldn't add ${displayName}. ${reason}`;
  console.warn(`[nebula] ${message}`);
  useGraphStore.getState().notify(message);
  return null;
}

async function reconcilePendingNodeCreation(
  set: GraphSet,
  get: GraphGet,
): Promise<string | null> {
  const attempt = pendingNodeCreationAttempt;
  if (!attempt) return null;

  let response: Response;
  try {
    response = await apiFetch('/api/graph/export');
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let snapshot: { nodes?: unknown };
  try {
    snapshot = (await response.json()) as { nodes?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(snapshot.nodes)) return null;

  const cliNodes = rewriteBackendAssetUrls(snapshot.nodes as Node<NodeData>[]);
  const matchedId = observePendingNodeCreation(cliNodes);
  if (!matchedId) return null;
  const matchedNode = cliNodes.find((node) => node.id === matchedId);
  if (!matchedNode) return null;

  const { settingsCache } = useUIStore.getState();
  const definition = NODE_DEFINITIONS[matchedNode.data.definitionId];
  const keyStatus = nodeKeyStatus(definition, matchedNode.data.params, settingsCache);
  const reconciledNode: Node<NodeData> = {
    ...matchedNode,
    position: {
      x: matchedNode.position?.x ?? attempt.position.x,
      y: matchedNode.position?.y ?? attempt.position.y,
    },
    data: { ...matchedNode.data, keyStatus },
  };

  let added = false;
  set((state) => {
    if (state.nodes.some((node) => node.id === matchedId)) {
      return { backendFreshStartPending: false };
    }
    added = true;
    return {
      nodes: nodesWithProviderRecoveries(
        [...state.nodes, reconciledNode],
        state.providerRecoveries,
      ),
      backendFreshStartPending: false,
    };
  });
  if (pendingNodeCreationAttempt === attempt) pendingNodeCreationAttempt = null;

  if (added && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', {
      detail: { addedCount: 1, totalCount: get().nodes.length },
    }));
  }
  return matchedId;
}

/**
 * The undo step for a graphSync, as store fields, or nothing. A sync becomes
 * one step when a graph edit caused it (`edit`) and this tab didn't send that
 * edit: an agent's, another window's, an outside app's. That includes an
 * import into the open project (`nebula graph load`, a file loaded in another
 * window): the backend marks it an edit, and undoing it puts the whole canvas
 * back, frontend-only nodes too. Not steps: run results and status (no
 * `edit`), this tab's own echoes (they already have their step), and a whole
 * new graph on project open or switch. A replacement that isn't a step
 * empties both stacks: their steps describe a graph that is gone, and undoing
 * one would now write that graph into this one.
 */
function foreignEditStep(
  state: GraphState,
  nextNodes: Node<NodeData>[],
  nextEdges: Edge[],
  origin: EditOrigin | undefined,
  graphReplaced: boolean,
  moved: string[],
): Partial<GraphState> {
  if (origin && isOwnEcho(origin, TAB_ID)) return {};
  if (!origin) return graphReplaced ? { undoStack: [], redoStack: [] } : {};
  // Its deletes are now the live removals of those nodes, for every step here.
  if (!graphReplaced) renewStackedRemovals(state, cleanRemovals(origin.removals));
  // A replacement puts every node where the new graph has it.
  const movedIds = graphReplaced
    ? new Set([...state.nodes, ...nextNodes].map((node) => node.id))
    : new Set(moved);
  const change = diffCanvas(state.nodes, state.edges, nextNodes, nextEdges, movedIds);
  if (!change) return {};
  const source = foreignSource(origin);
  const entry: ForeignEdit = {
    kind: 'foreign',
    agentName: source === 'agent' ? origin.actor?.name ?? 'An agent' : null,
    ...(origin.actor?.color ? { agentColor: origin.actor.color } : {}),
    source,
    ...(origin.id ? { editId: origin.id } : {}),
    ...(origin.undoes ? { undoes: origin.undoes } : {}),
    // What its deletes removed, so undoing it here puts those back too.
    ...(cleanRemovals(origin.removals).length > 0 ? { removals: cleanRemovals(origin.removals) } : {}),
    at: Date.now(),
    ...change,
  };
  // The person's next keystroke starts its own step, so undoing this edit
  // never takes their later typing with it.
  breakUndoDebounce();
  const text = editArrivedText(entry);
  return {
    undoStack: [...state.undoStack, entry].slice(-UNDO_CAP),
    redoStack: [],
    ...(text ? { undoNotice: { id: ++undoNoticeSeq, text, agentColor: entry.agentColor, offer: 'undo' as const, entry } } : {}),
  };
}

/**
 * A graphSync that finishes an agent's arrange carries `arranged` ({id,
 * nodeIds}) and no `edit`: the person's canvas measured and wrote it
 * (completeArrange), and the backend sends the marker only for that write.
 * It is not a step of its own in any tab, the one that arranged included.
 * Its positions go into the agent's step that added those nodes, and into
 * later steps that still hold the old ones (foldArrange), so Undo then Redo
 * puts the nodes where the arrange did, here and on the backend.
 */
function foldFinishedArrange(state: GraphState, arranged: unknown, incoming: Node<NodeData>[]): void {
  const nodeIds = arranged && typeof arranged === 'object' ? (arranged as { nodeIds?: unknown }).nodeIds : null;
  if (!Array.isArray(nodeIds)) return;
  const byId = new Map(incoming.map((node) => [node.id, node]));
  const positions: Record<string, { x: number; y: number }> = {};
  for (const id of nodeIds) {
    const node = typeof id === 'string' ? byId.get(id) : undefined;
    if (node?.position) positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  if (Object.keys(positions).length === 0) return;
  const shown = Object.fromEntries(state.nodes.map((node) => [node.id, node.position]));
  foldArrange([...state.undoStack, ...[...state.redoStack].reverse()], positions, shown);
}

/** Recompute the missing-key badge on nodes whose params an undo or redo changed. */
function withFreshKeyStatus(nodes: Node<NodeData>[], before: Node<NodeData>[]): Node<NodeData>[] {
  const previous = new Map(before.map((node) => [node.id, node.data.params]));
  const { settingsCache } = useUIStore.getState();
  return nodes.map((node) => previous.get(node.id) === node.data.params ? node : {
    ...node, data: { ...node.data,
      keyStatus: nodeKeyStatus(NODE_DEFINITIONS[node.data.definitionId], node.data.params, settingsCache) },
  });
}

/**
 * One undo or redo. The step leaves its stack and its inverse goes on the
 * other one: a snapshot's inverse is a snapshot of the canvas now; a foreign
 * edit is its own inverse (undo puts back its `before`, redo its `after`).
 * Then the backend is told (sendRestore), and an agent's edit says so.
 */
function stepHistory(action: 'undo' | 'redo', set: GraphSet, get: GraphGet): void {
  const state = get();
  if (state.isExecuting || state.providerRecoveries.length > 0 || state.providerStartAmbiguities.length > 0) return;
  const from = action === 'undo' ? state.undoStack : state.redoStack;
  const entry = from[from.length - 1];
  if (!entry) return;
  const { nodes, edges } = state;
  let next: { nodes: Node<NodeData>[]; edges: Edge[] };
  let inverse: UndoEntry;
  if (isForeignEdit(entry)) {
    next = action === 'undo'
      ? applySlice(nodes, edges, entry.before, entry.after)
      : applySlice(nodes, edges, entry.after, entry.before);
    inverse = entry;
  } else {
    next = { nodes: restoreWithOutputs(entry, nodes), edges: entry.edges.map((edge) => ({ ...edge })) };
    inverse = createSnapshot(nodes, edges);
  }
  const nextNodes = withFreshKeyStatus(next.nodes, nodes);
  breakUndoDebounce();
  // The person's own step that brings nodes back says "Restored the node.",
  // one that deletes them again "Deleted the node." (GM, 2026-10-23). The
  // restored line waits for the backend's answer when it has backend nodes,
  // since it counts the proposals that couldn't be reopened.
  const before = new Set(nodes.map((node) => node.id));
  const after = new Set(nextNodes.map((node) => node.id));
  const back = nextNodes.filter((node) => !before.has(node.id));
  const gone = nodes.filter((node) => !after.has(node.id)).length;
  const ownLine: OwnStepLine | null = isForeignEdit(entry) ? null
    : back.length > 0 ? { kind: 'restored', count: back.length }
      : gone > 0 ? { kind: 'deleted', count: gone } : null;
  const waitsForBackend = back.some((node) => CLI_ID_RE.test(node.id));
  const noticeId = ++undoNoticeSeq;
  set({
    nodes: nextNodes,
    edges: next.edges,
    ...(action === 'undo'
      ? { undoStack: from.slice(0, -1), redoStack: [...state.redoStack, inverse] }
      : { redoStack: from.slice(0, -1), undoStack: [...state.undoStack, inverse] }),
    ...(isForeignEdit(entry) ? { undoNotice: {
      id: noticeId, text: undoNoticeText(action, entry), agentColor: entry.agentColor,
      offer: action === 'undo' ? 'redo' as const : 'undo' as const, entry,
    } } : ownLine && !(ownLine.kind === 'restored' && waitsForBackend)
      ? { undoNotice: ownStepNotice(noticeId, ownLine, NOTHING_MISSED, action, inverse) } : {}),
  });
  void sendRestore(action, nodes, edges, nextNodes, next.edges, entry, inverse, set,
    { noticeId, ownLine: ownLine?.kind === 'restored' && waitsForBackend ? ownLine : null });
}

/** What a person's own undo or redo says: the nodes it brought back or deleted again. */
interface OwnStepLine { kind: 'restored' | 'deleted'; count: number }

/** What a restore's answer says couldn't go back: proposals that didn't
 * reopen, and pins whose node came back as another model. */
interface Missed { notReopened: number; notReattached: number }
const NOTHING_MISSED: Missed = { notReopened: 0, notReattached: 0 };

function ownStepNotice(id: number, line: OwnStepLine, missed: Missed, action: 'undo' | 'redo',
  inverse: UndoEntry): UndoNotice {
  return {
    id,
    text: line.kind === 'restored' ? restoredNoticeText(line.count, missed.notReopened, missed.notReattached)
      : deletedNoticeText(line.count),
    // The button acts on the step this one just put on the other stack.
    offer: action === 'undo' ? 'redo' : 'undo',
    entry: inverse,
  };
}

/** The removal records a step's restore names: those of the nodes it brings
 * back, as the model each record was made for (second review). */
function removalsFor(entry: UndoEntry, body: RestoreBody): RemovalRecord[] {
  const back = new Map(body.nodes.filter((node) => node.outputs !== undefined)
    .map((node) => [node.id, node.definitionId]));
  return (entry.removals ?? []).filter((record) => back.has(record.nodeId)
    && (!record.definitionId || record.definitionId === back.get(record.nodeId)));
}

// Undo and redo reach the backend one at a time, in the order the person
// pressed them.
let restoreQueue: Promise<void> = Promise.resolve();

/**
 * Make the backend graph match the canvas after an undo or redo: one POST
 * /api/graph/restore with the backend nodes and wires that changed (frontend-
 * only nodes never leave the canvas). The echo is this tab's own, so it is
 * not a new step; other tabs and agents see the change. If the backend
 * refuses (the node became something else, it is running), the step is put
 * back as it was, when nothing has been stacked on it since.
 */
function sendRestore(
  action: 'undo' | 'redo',
  prevNodes: Node<NodeData>[],
  prevEdges: Edge[],
  nextNodes: Node<NodeData>[],
  nextEdges: Edge[],
  entry: UndoEntry,
  inverse: UndoEntry,
  set: GraphSet,
  notice: { noticeId: number; ownLine: OwnStepLine | null },
): Promise<void> {
  const body = restoreRequest(action, prevNodes, prevEdges, nextNodes, nextEdges);
  if (!body) return restoreQueue;
  if (isForeignEdit(entry) && entry.editId) body.edit = entry.editId;
  // The wires it puts back or takes off stay so until it lands (heldWires).
  const holds = [...body.wire.map((w) => holdWire(w, true)), ...body.unwire.map((w) => holdWire(w, false))];
  // Shown once the backend answers, unless another notice came since.
  const answerNotice = (missed: Missed) => set((state) => {
    if (notice.ownLine) {
      if (undoNoticeSeq !== notice.noticeId) return {};
      return { undoNotice: ownStepNotice(notice.noticeId, notice.ownLine, missed, action, inverse) };
    }
    const shown = state.undoNotice;
    const text = notRestoredText(missed.notReattached, missed.notReopened);
    if (!text || !shown || shown.id !== notice.noticeId) return {};
    return { undoNotice: { ...shown, text: `${shown.text}. ${text}` } };
  });
  const task = restoreQueue.then(async () => {
    const replacementRevision = canvasReplacementRevision;
    // Read now, not when the step was taken: the answer to the delete (or to
    // the redo before this undo) may have landed since.
    const removals = removalsFor(entry, body);
    if (removals.length > 0) body.removals = removals;
    let response: Response | null = null;
    try {
      response = await graphMutationFetch('/api/graph/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // No answer: it may have landed. The next graphSync shows which.
      console.warn(`[nebula] ${action} didn't reach the backend:`, err);
    }
    for (const done of holds) done(Boolean(response?.ok));
    if (!response) {
      answerNotice(NOTHING_MISSED);
      return;
    }
    if (response.ok) {
      const answer = await response.json().catch(() => ({})) as {
        removals?: unknown; notReopened?: unknown; pinsLeft?: unknown;
      };
      // This restore deleted nodes (a redo of a delete): the step that
      // brings them back names these records.
      const fresh = cleanRemovals(answer.removals);
      if (fresh.length > 0) {
        inverse.removals = mergeRemovals(inverse.removals, fresh);
        // And every other step naming the removals these supersede (an older
        // one that brings the nodes back), unless another graph is open now.
        if (replacementRevision === canvasReplacementRevision) {
          set((state) => {
            renewStackedRemovals(state, fresh);
            return {};
          });
        }
      }
      answerNotice({
        notReopened: Array.isArray(answer.notReopened) ? answer.notReopened.length : 0,
        notReattached: pinsOnAnotherModel(answer.pinsLeft),
      });
      return;
    }
    const reason = await backendRejectionReason(response, `Couldn't ${action} that.`);
    console.warn(`[nebula] ${action} refused: ${reason}`);
    set((state) => {
      const stack = action === 'undo' ? state.redoStack : state.undoStack;
      if (stack[stack.length - 1] !== inverse) return {};
      // Put the canvas and both stacks back as they were before this step.
      const undone = isForeignEdit(entry)
        ? (action === 'undo'
          ? applySlice(state.nodes, state.edges, entry.after, entry.before)
          : applySlice(state.nodes, state.edges, entry.before, entry.after))
        : { nodes: restoreWithOutputs(inverse as UndoSnapshot, state.nodes), edges: prevEdges };
      return {
        nodes: withFreshKeyStatus(undone.nodes, state.nodes),
        edges: undone.edges,
        ...(action === 'undo'
          ? { redoStack: state.redoStack.slice(0, -1), undoStack: [...state.undoStack, entry] }
          : { undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, entry] }),
        undoNotice: { id: ++undoNoticeSeq, text: `Couldn't ${action} that. ${reason}`, offer: null,
          ...(isForeignEdit(entry) ? { agentColor: entry.agentColor, entry } : {}) },
      };
    });
  });
  restoreQueue = task.catch(() => {});
  return task;
}

wsClient.connect();
wsClient.subscribe((event) => {
  const revision = (event as ExecutionEvent & { workspaceRevision?: string }).workspaceRevision;
  const context = getProjectContext();
  if (revision !== undefined && revision !== context?.revision) return;
  if (event.type === 'graphSync') {
    // A backend at another params version holds values this bundle's rules
    // don't describe; projectStore reloads the tab instead (paramsOutdated.ts).
    // A sync without a version is from a backend older than the gate (0).
    if (backendParamsVersion((event as ExecutionEvent & { paramsVersion?: unknown }).paramsVersion)
      !== GRAPH_PARAMS_VERSION) return;
    useCinemaMotionStore.getState().observeGraphSync();
    // Real-time sync: MERGE cli_graph into the canvas. Key invariant: frontend-only
    // nodes (library drags, undo'd results, etc.) must survive graphSync — only
    // cli-origin nodes are authoritative from the server. Same for edges.
    const {
      nodes: rawCliNodes,
      edges: cliEdges,
      empty,
      graphReplaced = false,
      moved = [],
      arrange = [],
      arranged,
      providerRecoveries = [],
      providerStartAmbiguities = [],
      executionStatuses,
      edit: origin,
    } = event as {
      type: 'graphSync';
      nodes: Node<NodeData>[];
      edges: Edge[];
      empty: boolean;
      graphReplaced?: boolean;
      moved?: string[];
      arrange?: unknown;
      /** Set when this sync finishes an agent's arrange: {id, nodeIds}. Not an edit. */
      arranged?: unknown;
      /** Set when a graph edit caused this sync: who made it, and which tab sent it. */
      edit?: EditOrigin;
      providerRecoveries?: ProviderRecoveryCheckpoint[];
      providerStartAmbiguities?: ProviderStartAmbiguity[];
      executionStatuses?: ExecutionStatusResult[];
    };
    if (graphReplaced) {
      canvasReplacementRevision += 1;
      pendingConnectedNodeCreationAttempt = null;
      wireWrites.clear();
      unsavedParamEdits.clear();
      // The committed import can arrive before, or instead of, its HTTP ack.
      // Revoke old same-ID uploads/writes and suspended drafts before merging.
      clearCinemaScenePersistence();
      useCinemaUploadStore.getState().clear();
      useCinemaMotionStore.getState().clear();
      clearReplacedCanvasFocus();
    }
    useGraphStore.getState().hydrateProviderRecoveries(providerRecoveries);
    useGraphStore.getState().hydrateProviderStartAmbiguities(providerStartAmbiguities);
    if (executionStatuses !== undefined) {
      useGraphStore.getState().hydrateExecutionStatuses(executionStatuses);
    }
    const cliNodes = rewriteBackendAssetUrls(rawCliNodes).map((raw) => {
      const node = raw as Node<NodeData>;
      if (node.data.definitionId !== 'cinema-scene') return node;
      const scene = node.data.params.scene as CinemaSceneSpec | undefined;
      if (!scene?.shots) return node;
      // The backend final graph snapshot can arrive after executionStatus and
      // still contain its optimistic spinner. Terminal ownership wins over that
      // spinner; completed media and a newly launched owner remain untouched.
      return { ...node, data: { ...node.data, params: { ...node.data.params, scene: {
        ...scene, shots: scene.shots.map((shot) => {
          const status = settledCinemaRuns.get(`${node.id}\u0000${shot.id}`);
          const active = [...activeRunOwners.values()].some((owner) => owner.nodeId === node.id && owner.shotId === shot.id);
          if (!status || active || shot.output?.status !== 'running') return shot;
          return { ...shot, output: { ...shot.output, status: status === 'failed' ? 'error' as const : 'idle' as const,
            error: status === 'failed' ? 'Shot generation failed.' : undefined } };
        }),
      } } } };
    });
    const observedPendingNodeId = observePendingNodeCreation(cliNodes as Node<NodeData>[]);
    observePendingConnectedNodeCreation(cliNodes as Node<NodeData>[], cliEdges as Edge[]);

    const state = useGraphStore.getState();
    const held = heldWires(cliEdges ?? []);
    for (const seen of syncWatchers) {
      for (const node of cliNodes) seen.add(node.id);
      for (const edge of cliEdges ?? []) seen.add(edgeKey(edge));
    }

    if (empty) {
      // cli_graph was cleared — drop only cli-origin nodes/edges; keep frontend work.
      const remainingNodes = graphReplaced ? [] : state.nodes.filter((n) => !CLI_ID_RE.test(n.id));
      const remainingIds = new Set(remainingNodes.map((n) => n.id));
      const remainingEdges = state.edges.filter(
        (e) => remainingIds.has(e.source) && remainingIds.has(e.target),
      );
      useGraphStore.setState({
        nodes: remainingNodes,
        edges: remainingEdges,
        backendFreshStartPending: false,
        ...foreignEditStep(state, remainingNodes, remainingEdges, origin, graphReplaced, moved),
      });
      useCinemaUploadStore.getState().reconcileTargets(remainingNodes);
      useArrangeStore.getState().setPending([]);
      return;
    }

    const existingById = new Map((graphReplaced ? [] : state.nodes).map((n) => [n.id, n]));
    const frontendOnlyNodes = graphReplaced ? [] : state.nodes.filter((n) => !CLI_ID_RE.test(n.id));
    // Nodes the backend put somewhere new (an agent's move, or another tab's
    // drag). The rest keep the position this canvas has, as do nodes being
    // dragged here and nodes this tab's own layout write hasn't settled.
    const takesBackendPosition = (node: Node<NodeData>, existing: Node<NodeData>) =>
      moved.includes(node.id) && !existing.dragging && !layoutWritesInFlight.has(node.id) && Boolean(node.position);

    // Compute keyStatus for a node given its definition. Used for both new and
    // existing cli nodes so the "missing API key" badge shows up consistently.
    const { settingsCache } = useUIStore.getState();
    const keyStatusFor = (definitionId: string, params: Record<string, unknown>): 'missing' | undefined =>
      nodeKeyStatus(NODE_DEFINITIONS[definitionId], params, settingsCache);

    const cliMerged = (cliNodes as Node<NodeData>[]).map((incoming) => {
      const existing = existingById.get(incoming.id);
      // Keys the person typed and the backend doesn't have yet stay as typed.
      const cliNode = existing && unsavedParamEdits.has(incoming.id)
        ? { ...incoming, data: { ...incoming.data,
          params: withUnsavedParams(incoming.id, incoming.data.params, existing.data.params) } }
        : incoming;
      const keyStatus = keyStatusFor(cliNode.data.definitionId, cliNode.data.params);
      if (existing) {
        // Preserve position (unless the backend moved the node; see
        // takesBackendPosition) and existing outputs when the CLI side doesn't
        // have newer ones. Spread existing.data FIRST so
        // frontend-only fields (dynamicInputPorts, dynamicParams, providerMeta,
        // modelId on universal nodes) survive the merge — cliNode.data then
        // overrides common keys like label/definitionId/params.
        const cliOutputs = cliNode.data?.outputs ?? {};
        const hasCliOutputs = Object.keys(cliOutputs).length > 0;
        const changedOutput = hasCliOutputs && !sameExecutionOutputs(cliOutputs, existing.data.outputs);
        const isPaperSource = cliNode.data.definitionId === 'paper-source';
        const previousSource = existing.data.params._paperSource as PaperSourceRecord | undefined;
        const incomingSource = cliNode.data.params._paperSource as PaperSourceRecord | undefined;
        const paperSource = isPaperSource && previousSource
          && (!incomingSource || (previousSource.id === incomingSource.id
            && previousSource.sequence >= incomingSource.sequence))
          ? previousSource : incomingSource;
        const localScene = existing.data.params.scene as CinemaSceneSpec | undefined;
        const incomingScene = cliNode.data.params.scene as CinemaSceneSpec | undefined;
        const cinemaScene = cliNode.data.definitionId === 'cinema-scene'
          && cinemaScenePersistence.has(cliNode.id) && localScene?.shots && incomingScene?.shots
          ? mergePendingCinemaScene(cliNode.id, localScene, incomingScene) : null;
        const cinemaOutputs = cinemaScene ? Object.fromEntries(
          Object.entries(hasCliOutputs ? cliOutputs : existing.data.outputs).filter(([port]) =>
            !port.startsWith('shot_') || cinemaScene.shots.some((shot) => shotPortId(shot.id) === port)),
        ) : null;
        if (cinemaScene && cinemaOutputs) {
          for (const shot of cinemaScene.shots) {
            if (shot.output?.imageUrl) cinemaOutputs[shotPortId(shot.id)] = {
              type: 'Image', value: shot.output.imageUrl,
            };
          }
        }
        return {
          ...cliNode,
          // What React Flow keeps on the node (its measured size, whether it
          // is selected or being dragged) isn't the backend's: keep this
          // canvas's. Dropping `measured` had React Flow measure every node
          // again after each sync (a second update of every card), and
          // dropping `selected` cleared the person's selection whenever an
          // agent or a run synced the graph.
          ...canvasOwnFields(existing),
          type: isPaperSource ? 'paperSourceNode' : cliNode.data.definitionId === 'batch'
            ? 'batchNode' : existing.type ?? cliNode.type,
          position: takesBackendPosition(cliNode, existing) ? cliNode.position : existing.position,
          data: {
            ...existing.data,
            ...cliNode.data,
            ...keptUniversalFields(existing, cliNode),
            outputs: hasCliOutputs ? cliOutputs : keptOutputs(existing, cliNode),
            // The sync says "complete" for any node with outputs. Over the
            // same outputs it must not hide what a run's events said since:
            // a failure (an agent's run ends with a sync), a skip, or a run
            // still going. New outputs do replace it.
            // The backend's "error" is the node's last run failing
            // (services/node_errors.py): a tab that missed that run's events
            // shows it, unless it has started the node again since.
            state: cliNode.data.state === 'error'
              ? (existing.data.state === 'queued' || existing.data.state === 'executing' ? existing.data.state : 'error')
              : !hasCliOutputs ? existing.data.state
                : changedOutput || !RUN_HELD_STATES.has(existing.data.state) ? cliNode.data.state
                  : existing.data.state,
            // That error comes whole: an older run's friendly line or
            // category must not sit beside a newer message.
            ...(cliNode.data.state === 'error' ? {
              errorFriendly: cliNode.data.errorFriendly, errorCategory: cliNode.data.errorCategory,
              errorPerson: cliNode.data.errorPerson, errorProviderText: cliNode.data.errorProviderText,
              errorProvider: cliNode.data.errorProvider,
            } : {}),
            keyStatus,
            ...(changedOutput ? clearBatchPreview() : {}),
            ...(isPaperSource && paperSource ? {
              params: { ...cliNode.data.params, _paperSource: paperSource },
              outputs: paperSource.snapshot
                ? { image: { type: 'Image' as const, value: paperSource.snapshot.filePath } }
                : existing.data.outputs,
              // The backend's 'error' (a run that couldn't read the pinned
              // snapshot) stands, as worked out above; the snapshot decides
              // the state only when there is none (error copy round 3e).
              ...(cliNode.data.state === 'error' ? {}
                : { state: paperSource.snapshot ? 'complete' as const : 'idle' as const }),
            } : {}),
            ...(cinemaScene ? {
              params: { ...cliNode.data.params, scene: cinemaScene },
              dynamicOutputPorts: shotOutputPorts(cinemaScene),
              outputs: cinemaOutputs!,
            } : {}),
          },
        };
      }
      // New cli node: trust the position the backend sent. It already handles
      // auto-layout for nodes without a stored position (Claude's `nebula
      // create`) and round-trips user-saved positions for imported graphs.
      return {
        ...cliNode,
        type: cliNode.data.definitionId === 'paper-source' ? 'paperSourceNode'
          : cliNode.data.definitionId === 'batch' ? 'batchNode' : cliNode.type,
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

    // A node the sync didn't change stays the same object (and the array
    // the same array when nothing changed), so React Flow re-renders only
    // the cards that changed (tests/canvasRenderScope.test.tsx).
    const merged = shareUnchanged(graphReplaced ? [] : state.nodes, nodesWithProviderRecoveries(
      [...frontendOnlyNodes, ...cliMerged],
      useGraphStore.getState().providerRecoveries,
    ));
    const mergedIds = new Set(merged.map((n) => n.id));

    // A wire between two backend nodes is the backend's: one this sync lacks
    // is gone (an agent's unwire or undo, a re-typed node's pruning), unless
    // it is this tab's own connect on its way (heldWires). Wires on nodes only
    // this tab has stay while both ends do. Matched by connection, not id:
    // onConnect's optimistic wire has a UUID, the backend's copy an e-id.
    const cliEdgeKeys = new Set((cliEdges as Edge[]).map(edgeKey));
    const mergedById = new Map(merged.map((n) => [n.id, n]));
    const frontendOnlyEdges = graphReplaced ? [] : state.edges.filter(
      (e) => !cliEdgeKeys.has(edgeKey(e)) && mergedIds.has(e.source) && mergedIds.has(e.target)
        && (!CLI_ID_RE.test(e.source) || !CLI_ID_RE.test(e.target) || held.get(edgeKey(e)) === true)
        // A universal node whose model changed (the picker's route, which drops
        // these wires itself) no longer has the port: the wire can't stay.
        && universalPortsHold(e, mergedById),
    );
    // Edges are matched by id and connection: the backend can hand two
    // edges the same id (cli_graph.connect numbers by count after a removal).
    const edgeIdentity = (edge: Edge) => `${edge.id}\u0000${edgeKey(edge)}`;
    const existingEdges = new Map((graphReplaced ? [] : state.edges).map((edge) => [edgeIdentity(edge), edge]));
    const mergedEdges = shareUnchanged(graphReplaced ? [] : state.edges, [
      ...frontendOnlyEdges,
      // A selected wire stays selected (React Flow keeps `selected` on the
      // edge, `false` once deselected, which is kept too so the wire is unchanged).
      ...(cliEdges as Edge[]).filter((edge) => held.get(edgeKey(edge)) !== false).map((edge) => {
        const selected = existingEdges.get(edgeIdentity(edge))?.selected;
        return typeof selected === 'boolean' ? { ...edge, selected } : edge;
      }),
    ], edgeIdentity);

    if (!origin && !graphReplaced) foldFinishedArrange(state, arranged, cliNodes as Node<NodeData>[]);
    useGraphStore.setState({
      nodes: merged,
      edges: mergedEdges,
      backendFreshStartPending: false,
      ...foreignEditStep(state, merged, mergedEdges, origin, graphReplaced, moved),
    });
    useCinemaUploadStore.getState().reconcileTargets(merged);
    // After the merge, so the nodes an arrange names are already on the canvas.
    useArrangeStore.getState().setPending(arrange);
    if (
      observedPendingNodeId
      && pendingNodeCreationAttempt?.phase === 'uncertain'
      && pendingNodeCreationAttempt.observedNodeId === observedPendingNodeId
    ) {
      pendingNodeCreationAttempt = null;
    }

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

const initialRunHistory = loadRunHistory();
for (const record of initialRunHistory) {
  if (record.status !== 'running') continue;
  registerRun(record.id, record.snapshot, record.targetNodeId, record.cinemaShot?.shotId);
  activeRunOwners.get(record.id)!.status = 'uncertain';
}
currentRunId = initialRunHistory.find((record) => record.status === 'running' && !record.createOrigin && !record.cinemaShot)?.id ?? null;

/** Asks before a run whose list-price estimate reaches the user's threshold
 * (Settings > Interface). Every run path goes through the execute actions,
 * so the check lives here rather than on each button. Unpriced runs pass. */
function confirmRunCost(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope): boolean {
  const pricing = usePricingStore.getState().table;
  if (!pricing || typeof window === 'undefined') return true;
  const { runCostConfirmUsd, settingsCache } = useUIStore.getState();
  const summary = summarizeRunScope(nodes, edges, scope,
    { pricing, apiKeys: settingsCache.apiKeys, sizes: useInputSizeStore.getState().sizes });
  if (!shouldConfirmRunCost(summary, runCostConfirmUsd)) return true;
  return window.confirm(runCostConfirmMessage(summary));
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: activeRunOwners.size > 0,
  isCancelling: false,
  isImportingGraph: false,
  activeRuns: ownershipState().activeRuns,
  createLaunchingIds: [],
  createCancelledLaunchIds: [],
  providerRecoveryWarning: null,
  providerRecoveries: [],
  uncertainWorldLabsRunId: null,
  providerStartAmbiguities: [],
  backendFreshStartPending: false,
  runHistory: initialRunHistory,

  // ---------------------------------------------------------------------------
  // Undo/Redo initial state
  // ---------------------------------------------------------------------------
  undoStack: [],
  redoStack: [],
  clipboard: null,

  // ---------------------------------------------------------------------------
  // Undo/Redo actions
  // ---------------------------------------------------------------------------

  undo: () => stepHistory('undo', set, get),

  redo: () => stepHistory('redo', set, get),

  beginUndoStep: () => {
    breakUndoDebounce();
    return pushUndo(set, get);
  },

  cancelUndoStep: (step) => {
    // Only while nothing was stacked on top of it: a later step depends on it.
    set((state) => state.undoStack[state.undoStack.length - 1] === step
      ? { undoStack: state.undoStack.slice(0, -1) } : {});
  },

  undoNotice: null,
  dismissUndoNotice: () => set({ undoNotice: null }),
  notify: (text, tone = 'error') => set({ undoNotice: { id: ++undoNoticeSeq, text, offer: null, tone } }),

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

    const state = get();
    const params: CanvasClipboard['params'] = {};
    for (const node of selected) params[node.id] = providerSafeCloneParams(state, node);
    set({ clipboard: {
      nodes: selected, edges: internalEdges, params,
      source: { projectId: getProjectContext()?.id ?? null, load: canvasLoad },
    } });
  },

  pasteClipboard: (target) => {
    const state = get();
    const { clipboard, isExecuting } = state;
    if (isExecuting) return [];
    if (!clipboard || clipboard.nodes.length === 0) return [];

    const safeParams = clipboardPasteParams(state, clipboard);
    if (!safeParams) {
      warnUnsafeProviderClone();
      return [];
    }

    const offset = pasteOffset(state, clipboard, target?.view);
    pushUndo(set, get);

    const idMap = new Map<string, string>();
    const newNodes = clipboard.nodes.map((node) => {
      const newId = uuidv4();
      idMap.set(node.id, newId);
      return {
        ...node,
        id: newId,
        position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
        selected: true,
        data: {
          ...node.data,
          params: safeParams.get(node.id)!,
          state: 'idle' as const,
          outputs: {},
          batchOutputs: undefined,
          batchVariants: undefined,
          batchRunId: undefined,
          runNotes: undefined,
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
        ...deselectedNodes(state.nodes),
        ...newNodes,
      ],
      edges: [...state.edges, ...newEdges],
    }));
    return newNodes.map((node) => node.id);
  },

  // ---------------------------------------------------------------------------
  // Selection & batch operations
  // ---------------------------------------------------------------------------

  selectAll: () => {
    set((state) => ({
      // Only the nodes not yet selected change (and their cards re-render).
      nodes: replaceChanged(state.nodes, (n) => (n.selected ? n : { ...n, selected: true })),
    }));
  },

  duplicateSelected: () => {
    const state = get();
    const { nodes, edges, isExecuting } = state;
    if (isExecuting) return;
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;

    const safeParams = new Map<string, Record<string, unknown>>();
    for (const node of selected) {
      const params = providerSafeCloneParams(state, node);
      if (!params) {
        warnUnsafeProviderClone();
        return;
      }
      safeParams.set(node.id, params);
    }

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
          params: safeParams.get(node.id)!,
          state: 'idle' as const,
          outputs: {},
          batchOutputs: undefined,
          batchVariants: undefined,
          batchRunId: undefined,
          runNotes: undefined,
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
        ...deselectedNodes(state.nodes),
        ...newNodes,
      ],
      edges: [...state.edges, ...newEdges],
    }));
  },

  deleteSelected: () => {
    const state = get();
    if (state.isExecuting) return;
    const selectedIds = state.nodes.filter((node) => node.selected).map((node) => node.id);
    if (selectedIds.length === 0) return;
    if (refuseHeldNodeDelete(state, selectedIds, set)) return;
    // Route through the normal React Flow removal path so one undo snapshot,
    // backend mirroring, edge cleanup, and Remotion source pruning stay atomic.
    get().onNodesChange(selectedIds.map((id) => ({ id, type: 'remove' as const })));
  },

  autoLayoutSelected: () => {
    const { nodes, edges } = get();
    const selected = nodes.filter((node) => node.selected);
    if (selected.length < 2) return;
    const selectedIds = new Set(selected.map((node) => node.id));
    const internalEdges = edges.filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
    );
    const positions = computeLayout(selected.map(layoutNode), internalEdges);
    const currentMinX = Math.min(...selected.map((node) => node.position.x));
    const currentMinY = Math.min(...selected.map((node) => node.position.y));
    const layoutValues = Object.values(positions);
    const layoutMinX = Math.min(...layoutValues.map((position) => position.x));
    const layoutMinY = Math.min(...layoutValues.map((position) => position.y));
    const translated = Object.fromEntries(
      Object.entries(positions).map(([nodeId, position]) => [
        nodeId,
        {
          x: position.x - layoutMinX + currentMinX,
          y: position.y - layoutMinY + currentMinY,
        },
      ]),
    );
    pushUndo(set, get);
    set((state) => ({
      nodes: state.nodes.map((node) =>
        translated[node.id] ? { ...node, position: translated[node.id] } : node,
      ),
    }));
    persistNodePositions(translated);
  },

  // ---------------------------------------------------------------------------
  // Node management
  // ---------------------------------------------------------------------------

  addNode: async (definitionId, position) => {
    if (get().isImportingGraph) return null;
    if (isDynamicDefinition(definitionId)) {
      return get().addDynamicNode(definitionId, position);
    }
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

    if (pendingNodeCreationAttempt) {
      const previousAttempt = pendingNodeCreationAttempt;
      if (previousAttempt.phase === 'sending') {
        return reportNodeCreationFailure(
          definition.displayName,
          'Another backend node-create request is still in progress. Wait for it to finish before adding another node.',
        );
      }
      const reconciledId = await reconcilePendingNodeCreation(set, get);
      if (reconciledId) {
        return reportNodeCreationFailure(
          definition.displayName,
          `The previous ${previousAttempt.displayName} request was restored as ${reconciledId}. Review that node before adding another.`,
        );
      }
      return reportNodeCreationFailure(
        definition.displayName,
        'A previous backend node-create request still has an unknown result. Nebula will not send another create until the canvas syncs; reconnect or reload first.',
      );
    }

    const defaults = buildDefaultParams(definition);
    Object.assign(defaults, withNewKreaMode(definition, {},
      useUIStore.getState().settingsCache.kreaConnectionMode));

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    const addLocally = (err: unknown): string => {
      console.warn('[nebula] addNode backend unavailable — adding locally only:', err);
      // Fallback: frontend-only UUID node. Claude won't see it until the
      // backend comes back and /api/graph/import or equivalent is called.
      pushUndo(set, get);
      const nodeType =
        definitionId === 'reroute'
          ? 'reroute-node'
          : definitionId === 'batch'
            ? 'batchNode'
          : definitionId === 'camera-rig'
            ? 'cameraRigNode'
            : definitionId === 'paper-source'
              ? 'paperSourceNode'
            : definitionId === 'reference-set'
              ? 'referenceSetNode'
              : definitionId.startsWith('qc-')
                ? 'videoQcNode'
              : definitionId === 'nebula-moodboard'
                ? 'moodboardNode'
                : 'model-node';
      const { settingsCache } = useUIStore.getState();
      const keyStatus = nodeKeyStatus(definition, defaults, settingsCache);
      const newNode: Node<NodeData> = {
        id: uuidv4(),
        type: nodeType,
        position,
        data: { label: definition.displayName, definitionId, params: defaults, state: 'idle', outputs: {}, keyStatus },
      };
      set((state) => ({ nodes: [...state.nodes, newNode] }));
      return newNode.id;
    };

    // Push into cli_graph on the backend so `nebula graph` shows the node to
    // Claude. graphSync will bring it into the canvas with its cli short id.
    let backendFresh: boolean;
    try {
      backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
    } catch (err) {
      return reportNodeCreationFailure(definition.displayName, failureCopy(err).reason);
    }
    if (!backendFresh) return addLocally(new Error('Backend is unavailable.'));

    const attempt: NodeCreationAttempt = {
      definitionId,
      displayName: definition.displayName,
      position,
      knownCliNodeIds: new Set(get().nodes.filter((node) => CLI_ID_RE.test(node.id)).map((node) => node.id)),
      phase: 'sending',
    };
    pendingNodeCreationAttempt = attempt;

    const reconcileDispatchedCreate = async (reason: string): Promise<string | null> => {
      attempt.phase = 'uncertain';
      if (attempt.observedNodeId) {
        if (pendingNodeCreationAttempt === attempt) pendingNodeCreationAttempt = null;
        return attempt.observedNodeId;
      }
      const reconciledId = await reconcilePendingNodeCreation(set, get);
      if (reconciledId) return reconciledId;
      return reportNodeCreationFailure(definition.displayName, reason);
    };

    let res: Response;
    try {
      res = await graphMutationFetch('/api/graph/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params: defaults, position }),
      });
    } catch {
      return reconcileDispatchedCreate(
        'The backend response was lost after the node-create request was sent. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.',
      );
    }

    if (!res.ok) {
      if (pendingNodeCreationAttempt === attempt) pendingNodeCreationAttempt = null;
      return reportNodeCreationFailure(
        definition.displayName,
        await backendRejectionReason(res, `Couldn't add ${definition.displayName}.`),
      );
    }

    let node: { id?: unknown };
    try {
      node = (await res.json()) as { id?: unknown };
    } catch {
      return reconcileDispatchedCreate(
        'Backend returned an invalid response after node creation. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.',
      );
    }
    if (typeof node.id !== 'string' || !node.id) {
      return reconcileDispatchedCreate(
        'Backend returned no node id after node creation. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.',
      );
    }
    if (pendingNodeCreationAttempt === attempt) pendingNodeCreationAttempt = null;
    return node.id;
  },

  addLocalCinemaMotionNode: (nodeId, shotId) => {
    if (get().isImportingGraph || CLI_ID_RE.test(nodeId)) return null;
    const source = cinemaMotionSource(get().nodes, nodeId, shotId);
    if (!source || source.shot.output?.status !== 'done' || !source.shot.output.imageUrl) return null;
    const existing = cinemaMotionTarget(get().nodes, get().edges, nodeId, shotId);
    if (existing) return existing;
    const definition = NODE_DEFINITIONS['veo-3'];
    if (!definition) return null;
    const params = buildDefaultParams(definition);
    const targetId = uuidv4();
    const target: Node<NodeData> = { id: targetId, type: 'model-node',
      position: { x: source.node.position.x + 360, y: source.node.position.y },
      data: { label: definition.displayName, definitionId: 'veo-3', params, outputs: {}, state: 'idle',
        keyStatus: nodeKeyStatus(definition, params, useUIStore.getState().settingsCache) } };
    const edge: Edge = { id: uuidv4(), type: 'typed-edge', source: nodeId, sourceHandle: shotPortId(shotId),
      target: targetId, targetHandle: 'image', data: { dataType: 'Image' } };
    pushUndo(set, get);
    set((state) => ({ nodes: [...state.nodes, target], edges: [...state.edges, edge] }));
    return targetId;
  },

  addNodeAndConnect: async (definitionId, position, connect) => {
    const definition = NODE_DEFINITIONS[definitionId];
    const fail = (reason: string) => reportNodeCreationFailure(definition?.displayName ?? definitionId, reason);
    if (!definition) return fail('This node is no longer available.');
    const before = get();
    if (before.isExecuting || before.isImportingGraph) return fail('Wait for the current run or graph import to finish.');
    if (pendingConnectedNodeCreationAttempt || pendingNodeCreationAttempt) return fail('Another node-create request is still unresolved. Wait for the exact connected pair to sync, or reload the canvas before trying again.');
    if (connect.newNodeIs !== 'source' && connect.newNodeIs !== 'target') return fail('The connection direction is invalid.');
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return fail('The canvas position is invalid.');

    const originId = connect.newNodeIs === 'target' ? connect.source : connect.target;
    const origin = before.nodes.find((node) => node.id === originId);
    if (!origin || !CLI_ID_RE.test(originId)) return fail('The original node is no longer available on the backend.');
    const originDefinition = NODE_DEFINITIONS[origin.data.definitionId];
    const originData = origin.data as DynamicNodeData;
    const sourcePorts = connect.newNodeIs === 'source' ? definition.outputPorts
      : originData.dynamicOutputPorts ?? originDefinition?.outputPorts;
    const targetPorts = connect.newNodeIs === 'target' ? definition.inputPorts
      : originData.dynamicInputPorts ?? originDefinition?.inputPorts;
    const sourcePort = sourcePorts?.find((port) => port.id === connect.sourceHandle);
    const targetPort = targetPorts?.find((port) => port.id === connect.targetHandle);
    if (!sourcePort || !targetPort || !isPortCompatible(sourcePort.dataType, targetPort.dataType)) {
      return fail('These ports cannot be connected. Choose a compatible node.');
    }

    // Capture before dispatch: the backend broadcasts the committed graph
    // before returning its HTTP acknowledgement, so a later snapshot would
    // contain the very node/edge this undo step must remove.
    const undoSnapshot = createSnapshot(before.nodes, before.edges);
    const knownIds = new Set(before.nodes.map((node) => node.id));
    const replacementRevision = canvasReplacementRevision;
    let originRevoked = false;

    const defaults = buildDefaultParams(definition);
    Object.assign(defaults, withNewKreaMode(definition, {},
      useUIStore.getState().settingsCache.kreaConnectionMode));

    const unsubscribe = useGraphStore.subscribe((state) => {
      if (!state.nodes.some((node) => node.id === originId && node.data.definitionId === origin.data.definitionId)) {
        originRevoked = true;
      }
    });
    const attempt: ConnectedNodeCreationAttempt = {
      definitionId, displayName: definition.displayName, position: { ...position },
      knownCliNodeIds: knownIds, params: structuredClone(defaults), originId,
      originDefinitionId: origin.data.definitionId, connect: { ...connect }, phase: 'sending',
    };
    pendingConnectedNodeCreationAttempt = attempt;
    const synced = watchGraphSyncs();
    let definiteOutcome = false;
    try {
      const res = await graphMutationFetch('/api/graph/node-and-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params: defaults, position, connect }),
      });
      if (!res.ok) {
        definiteOutcome = res.status >= 400 && res.status < 500;
        return fail(await backendRejectionReason(res, `Couldn't add ${definition.displayName}.`));
      }
      const node = (await res.json()) as { id?: unknown; definitionId?: unknown; params?: Record<string, unknown>;
        connected?: boolean; edge?: Edge };
      if (typeof node.id !== 'string' || !CLI_ID_RE.test(node.id) || knownIds.has(node.id)
        || (node.definitionId !== undefined && node.definitionId !== definitionId)) {
        return fail('The backend returned an invalid node acknowledgement. The request may have committed; check canvas sync before trying again.');
      }
      if (originRevoked || replacementRevision !== canvasReplacementRevision) {
        return fail('The canvas changed while this request was pending. Check the current graph before trying again.');
      }

      const nodeId = node.id;
      const expectedSource = connect.newNodeIs === 'source' ? nodeId : connect.source;
      const expectedTarget = connect.newNodeIs === 'target' ? nodeId : connect.target;
      const edge = node.edge;
      if (node.connected !== true || !edge || typeof edge.id !== 'string' || !edge.id
        || edge.source !== expectedSource || edge.sourceHandle !== connect.sourceHandle
        || edge.target !== expectedTarget || edge.targetHandle !== connect.targetHandle) {
        return fail('The backend did not confirm the requested connection. Check canvas sync before trying again.');
      }
      const params = node.params && typeof node.params === 'object' && !Array.isArray(node.params) ? node.params : defaults;
      const nodeTypes: Record<string, string> = {
        batch: 'batchNode', 'paper-source': 'paperSourceNode', reroute: 'reroute-node',
        'video-edit': 'editNode', 'remotion-node': 'remotionNode', 'cinema-scene': 'cinemaSceneNode',
        character: 'characterNode', 'camera-rig': 'cameraRigNode', 'reference-set': 'referenceSetNode',
        'nebula-moodboard': 'moodboardNode',
      };
      const dynamic = isDynamicDefinition(definitionId);
      const data: NodeData = { label: definition.displayName, definitionId, params, state: 'idle', outputs: {},
        keyStatus: nodeKeyStatus(definition, params, useUIStore.getState().settingsCache),
        ...(dynamic ? { isDynamic: true, providerType: dynamicProviderFor(definitionId),
          dynamicInputPorts: definition.inputPorts.map(toDynamicPort), dynamicOutputPorts: definition.outputPorts.map(toDynamicPort),
          dynamicParams: [], providerMeta: {} } : {}),
      };
      const newNode: Node<NodeData> = { id: nodeId,
        type: nodeTypes[definitionId] ?? (dynamic ? 'dynamic-node' : definitionId.startsWith('qc-') ? 'videoQcNode' : 'model-node'),
        position: { ...position }, data };
      // A fast graphSync may already contain either item. Keep its canonical
      // data, outputs and edge ID (or its removal since: an agent's unwire);
      // otherwise expose the acknowledged pair now.
      set((state) => ({
        nodes: synced.seen.has(nodeId) || state.nodes.some((item) => item.id === nodeId) ? state.nodes : [...state.nodes, newNode],
        edges: synced.seen.has(edgeKey(edge)) || state.edges.some((item) => edgeKey(item) === edgeKey(edge))
          ? state.edges : [...state.edges, edge],
        undoStack: [...state.undoStack, undoSnapshot].slice(-UNDO_CAP),
        redoStack: [],
      }));
      definiteOutcome = true;
      return nodeId;
    } catch (err) {
      console.warn('[nebula] addNodeAndConnect backend push failed:', err);
      return fail('The backend response was lost or invalid. This request may have committed; check canvas sync before trying again.');
    } finally {
      if (pendingConnectedNodeCreationAttempt === attempt) {
        if (definiteOutcome || attempt.observedNodeId) pendingConnectedNodeCreationAttempt = null;
        else attempt.phase = 'uncertain';
      }
      synced.stop();
      unsubscribe();
    }
  },

  addDynamicNode: (definitionId, position) => {
    if (get().isImportingGraph) return null;
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

    pushUndo(set, get);

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }

    // Check API key status from settings cache (the same rule as every node).
    const keyStatus = nodeKeyStatus(definition, defaults, useUIStore.getState().settingsCache);

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
    pendingGraphMutationCount += 1;
    ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get)
      .then((backendFresh) => {
        if (!backendFresh) throw new Error('Backend fresh-start guard failed');
        return graphMutationFetch('/api/graph/node', {
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
        const drawn = new Set(get().edges.filter((e) => e.source === tempId || e.target === tempId).map((e) => e.id));
        set((state) => ({
          nodes: state.nodes.map((n) => (n.id === tempId ? { ...n, id: shortId } : n)),
          edges: state.edges.map((e) => ({
            ...e,
            source: e.source === tempId ? shortId : e.source,
            target: e.target === tempId ? shortId : e.target,
          })),
        }));
        // onConnect sent none of them (an end had no backend id yet): those
        // between two backend nodes now go, held like any connect (sendWire).
        for (const edge of get().edges) {
          if (drawn.has(edge.id) && CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) void sendWire(edge, true, set);
        }
      })
      .catch((err) => {
        console.warn('[nebula] addDynamicNode backend push failed — staying frontend-only:', err);
      }).finally(() => { pendingGraphMutationCount -= 1; });

    return tempId;
  },

  // No confirm (GM, 2026-10-23): undo puts back everything a delete removed,
  // so the delete says "Deleted the node." with Undo instead (lib/deleteNotice.ts).
  allowCanvasDelete: (nodeIds) => !refuseHeldNodeDelete(get(), nodeIds, set),

  onNodesChange: (changes) => {
    if (get().isExecuting && changes.some((change) => change.type === 'remove')) return;
    const removedIds = changes.filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove').map((c) => c.id);
    if (refuseHeldNodeDelete(get(), removedIds, set)) return;
    const cliRemovedIds = removedIds.filter((nodeId) => CLI_ID_RE.test(nodeId));
    if (cliRemovedIds.length === 0) {
      if (removedIds.length === 0) {
        applyCanvasNodeChanges(changes, set, get);
        return;
      }
      breakUndoDebounce();
      const step = pushUndo(set, get);
      const present = new Set(get().nodes.map((node) => node.id));
      applyCanvasNodeChanges(changes, set, get, step);
      const gone = removedIds.filter((nodeId) => present.has(nodeId) && !get().nodes.some((node) => node.id === nodeId));
      if (gone.length > 0) set(deletedNotice(gone.length, step));
      return;
    }

    // A backend paid-safety rejection must leave the node visibly present.
    // Wait for each authoritative delete rather than optimistically hiding it.
    // The undo step is the canvas now: each delete's graphSync can remove the
    // node here before its reply arrives.
    breakUndoDebounce();
    const undoStep = pushUndo(set, get);
    const shownBefore = new Set(get().nodes.map((node) => node.id));
    // A project opened (or a graph loaded) before the answers came: the
    // canvas and its steps are another graph's now (second review).
    const replacementRevision = canvasReplacementRevision;
    const deleting = Promise.allSettled(cliRemovedIds.map(deleteCLIOriginNode)).then((results) => {
      const confirmed = new Set<string>();
      const failures: string[] = [];
      const removals: RemovalRecord[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          confirmed.add(cliRemovedIds[index]);
          if (result.value) removals.push(result.value);
        } else failures.push(failureCopy(result.reason).reason);
      });
      // Undoing this step names what each delete removed (GM, 2026-10-23).
      if (removals.length > 0) undoStep.removals = mergeRemovals(undoStep.removals, removals);
      if (replacementRevision !== canvasReplacementRevision) {
        // Nothing here is that graph's any more: no node to take off, no
        // step to renew, no notice. The step keeps its records, for an undo
        // that comes back to that graph (an import undone).
        if (failures.length > 0) reportNodeDeletionFailure(failures, failures.length);
        return;
      }
      if (removals.length > 0) {
        set((state) => {
          renewStackedRemovals(state, removals);
          return {};
        });
      }
      const safeChanges = changes.filter((change) => (
        change.type !== 'remove'
        || !CLI_ID_RE.test(change.id)
        || confirmed.has(change.id)
      ));
      const removing = safeChanges.filter((change) => change.type === 'remove').map((change) => change.id);
      // Nothing was deleted after all: the step taken above would undo nothing.
      if (removing.length === 0) get().cancelUndoStep(undoStep);
      if (safeChanges.length > 0) applyCanvasNodeChanges(safeChanges, set, get, undoStep);
      const deleted = removing.filter((nodeId) => shownBefore.has(nodeId)).length;
      if (deleted > 0 && get().undoStack.includes(undoStep)) set(deletedNotice(deleted, undoStep));
      if (failures.length > 0) reportNodeDeletionFailure(failures, failures.length);
    });
    // An undo pressed while the deletes are on their way waits for their
    // answers, so its restore can name what they removed.
    restoreQueue = restoreQueue.then(() => deleting);
  },

  onEdgesChange: (changes) => {
    if (get().isExecuting && changes.some((change) => change.type === 'remove')) return;
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
        if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) void sendWire(edge, false, set);
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
      // The wires it replaces go first; all are held from now (sendWire).
      let sent: Promise<unknown> | undefined;
      for (const edge of edgesToReplace) {
        if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) sent = sendWire(edge, false, set, sent);
      }
      void sendWire(newEdge, true, set, sent);
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

  applyPaperSource: (nodeId, source) => {
    const state = get();
    const node = state.nodes.find((candidate) => candidate.id === nodeId && candidate.data.definitionId === 'paper-source');
    if (!node) return;
    const previous = node.data.params._paperSource as PaperSourceRecord | undefined;
    if (previous?.id === source.id && source.sequence < previous.sequence) return;
    if (previous?.id === source.id && source.sequence === previous.sequence
      && previous.snapshot?.hash !== source.snapshot?.hash) return;
    // Refresh replaces only the source preview, never downstream outputs/edges.
    const nextSource = JSON.parse(JSON.stringify(source)) as PaperSourceRecord;
    get().updateNodeData(nodeId, {
      params: { ...node.data.params, _paperSource: nextSource },
      outputs: source.snapshot
        ? { image: { type: 'Image', value: source.snapshot.filePath } }
        : node.data.outputs,
      state: source.snapshot ? 'complete' : 'idle',
    });
    // Older results from before provenance was introduced still retain their
    // media and receive a truthful source-change label after first refresh.
    if (previous?.snapshot && source.snapshot
      && (previous.snapshot.hash !== source.snapshot.hash
        || previous.identity.fileId !== source.identity.fileId
        || previous.identity.objectId !== source.identity.objectId)) {
      const descendants = new Set<string>([nodeId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of state.edges) {
          if (descendants.has(edge.source) && !descendants.has(edge.target)) {
            descendants.add(edge.target);
            changed = true;
          }
        }
      }
      set((current) => ({
        nodes: current.nodes.map((candidate) => candidate.id !== nodeId
          && descendants.has(candidate.id) && !candidate.data.outputFreshness
          && Object.keys(candidate.data.outputs).length > 0
          ? { ...candidate, data: { ...candidate.data, outputFreshness: {
              paperInputs: [{ nodeId, sourceId: previous.id, snapshot: previous.snapshot! }],
              outOfDateReasons: ['Paper source updated after this output was produced.'],
            } } }
          : candidate),
      }));
    }
  },

  updateNodeData: (nodeId, data) => {
    // Only push undo for param changes (not for execution state updates like outputs/state/progress)
    const isParamChange = 'params' in data;
    if (isParamChange) {
      maybePushUndo(set, get, nodeId);
    }
    const paramsBefore = isParamChange ? get().nodes.find((node) => node.id === nodeId)?.data.params : undefined;
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, data: {
          ...node.data, ...data,
          ...(isParamChange ? { keyStatus: nodeKeyStatus(
            NODE_DEFINITIONS[data.definitionId ?? node.data.definitionId],
            data.params ?? node.data.params,
            useUIStore.getState().settingsCache,
          ) } : {}),
        } } : node
      ),
    }));

    // Param changes on cli-origin nodes (n1, n2, ...) need to flow back to
    // cli_graph so Claude's `nebula graph` reflects user edits. Debounce so
    // rapid typing in a text-input doesn't hammer the backend — the final
    // value is what matters. Execution state updates (outputs/state/progress)
    // don't need to sync.
    if (isParamChange && CLI_ID_RE.test(nodeId)) {
      const currentNode = get().nodes.find((node) => node.id === nodeId);
      const currentScene = currentNode?.data.params.scene as CinemaSceneSpec | undefined;
      if (currentNode?.data.definitionId === 'cinema-scene' && currentScene?.shots) {
        persistSceneParam(nodeId, currentScene, PARAM_PUSH_DEBOUNCE_MS);
        return;
      }
      noteParamEdit(nodeId, paramsBefore ?? {}, currentNode?.data.params ?? {});
      if (paramPushTimers[nodeId] !== undefined) {
        window.clearTimeout(paramPushTimers[nodeId]);
      }
      scheduleParamPush(nodeId);
    }
  },

  renameNode: (nodeId, label) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const displayName = NODE_DEFINITIONS[node.data.definitionId]?.displayName ?? node.data.label;
    // Same rules as the backend: collapse whitespace, cap at 80 characters.
    const next = label.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_LABEL_LENGTH).trim() || displayName;
    if (next === node.data.label) return;
    const previous = node.data.label;
    get().updateNodeData(nodeId, { label: next });
    // Local-only nodes keep the name in the frontend graph; backend nodes
    // store it so graphSync, project restore and agents all see it.
    if (!CLI_ID_RE.test(nodeId)) return;
    graphMutationFetch(`/api/graph/node/${nodeId}/label`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch((err) => {
      console.warn(`[nebula] Rename of ${nodeId} failed:`, err);
      const current = get().nodes.find((candidate) => candidate.id === nodeId);
      if (current?.data.label === next) get().updateNodeData(nodeId, { label: previous });
    });
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

  reserveGraphImport: () => {
    const state = get();
    if (state.isImportingGraph || state.isExecuting || state.createLaunchingIds.length > 0) return false;
    suspendCinemaScenePersistence();
    useCinemaUploadStore.getState().interrupt();
    useCinemaMotionStore.getState().interruptPending();
    set({ isImportingGraph: true });
    return true;
  },
  releaseGraphImport: (options) => {
    if (options?.discardSuspended) {
      // A successful project activation changed the backend owner already.
      // Old same-ID drafts must never be resumed against the new workspace.
      clearAllParamPushTimers();
      clearCinemaScenePersistence();
    }
    set({ isImportingGraph: false });
    if (!options?.discardSuspended) resumeCinemaScenePersistence();
  },

  resetExecution: () => {
    // A still-open run at this point means the user cancelled mid-flight (at the start
    // of a fresh run the prior run has already closed, so currentRunId is null → no-op).
    for (const runId of [...activeRunOwners.keys()]) closeTrackedRun(set, runId, { status: 'cancelled' });
    createLaunchOwners.clear();
    cancelledCreateLaunches.clear();
    set((state) => ({
      ...ownershipState(),
      uncertainWorldLabsRunId: null,
      activeRuns: [],
      createLaunchingIds: [],
      createCancelledLaunchIds: [],
      nodes: replaceChanged(state.nodes, (node) => {
        // Only reset nodes that are mid-execution — preserve completed/errored results.
        const running = node.data.state === 'queued' || node.data.state === 'executing';
        // A node with nothing to reset stays the same object, so its card
        // doesn't re-render (every run starts here).
        if (!running && node.data.progress === undefined) return node;
        return { ...node, data: { ...node.data, state: running ? 'idle' as const : node.data.state, progress: undefined } };
      }),
    }));
  },

  cancelExecution: async () => {
    for (const id of createLaunchOwners) cancelledCreateLaunches.add(id);
    set({ ...ownershipState(), createCancelledLaunchIds: [...cancelledCreateLaunches] });
    await Promise.all([...activeRunOwners.keys()].map((runId) => requestTrackedCancellation(runId, set, get)));
  },

  cancelRun: async (runId) => { await requestTrackedCancellation(runId, set, get); },

  reserveCreateGeneration: (genId) => {
    const state = get();
    if (state.isImportingGraph) return false;
    const activeCreateCount = state.runHistory.filter((run) => run.status === 'running' && run.createOrigin).length;
    if (state.createLaunchingIds.includes(genId)
      || state.runHistory.some((run) => run.status === 'running' && run.createOrigin?.genId === genId)
      || state.createLaunchingIds.length + activeCreateCount >= 2) return false;
    createLaunchOwners.add(genId);
    set({ ...ownershipState(), createLaunchingIds: [...createLaunchOwners] });
    return true;
  },
  releaseCreateGeneration: (genId) => {
    createLaunchOwners.delete(genId);
    cancelledCreateLaunches.delete(genId);
    set({ ...ownershipState(), createLaunchingIds: [...createLaunchOwners], createCancelledLaunchIds: [...cancelledCreateLaunches] });
  },
  cancelCreateGeneration: (genId) => {
    if (!createLaunchOwners.has(genId)) return;
    cancelledCreateLaunches.add(genId);
    set({ ...ownershipState(), createCancelledLaunchIds: [...cancelledCreateLaunches] });
  },

  executeGraph: async () => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting || get().isImportingGraph) return;
    const uploadIssue = pendingCinemaUploadIssue(nodes);
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    if (!confirmRunCost(nodes, edges, { kind: 'graph' })) return;
    resetExecution();
    const snapshot = captureRunSnapshot(nodes, edges);
    const heldStart = blockedProviderStart(snapshot, get().providerStartAmbiguities);
    if (heldStart) {
      warnBlockedProviderStart(heldStart);
      return;
    }
    const runId = uuidv4();
    currentRunId = runId;
    registerRun(runId, snapshot);
    set((state) => ({
      activeRuns: ownershipState().activeRuns,
      nodes: markExecutionScopeQueued(state.nodes, state.edges),
      isExecuting: true,
      isCancelling: false,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'graph',
        startedAt: Date.now(),
        snapshot,
        startedFreshPaidWorldLabs: runIncludesFreshPaidWorldLabsStart(snapshot),
      })),
    }));
    pendingStartRunIds.add(runId);
    try {
      const result = await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId);
      pendingStartRunIds.delete(runId);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't start the run.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            new Set(nodesInExecutionScope(state.nodes, state.edges).map((node) => node.id)),
            result.errors,
          ),
          ...ownershipState(),
        }));
      }
    } catch (err) {
      settleFailedStart(runId, err);
      console.error('Failed to start execution:', err);
      if (currentRunId !== runId) return;
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get);
        return;
      }
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges).map((node) => node.id)),
          failureMessage(err, "Couldn't start the run."),
        ),
        ...ownershipState(),
      }));
    }
  },

  executeNode: async (nodeId, options) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting || get().isImportingGraph) return;
    const uploadIssue = pendingCinemaUploadIssue(nodesInExecutionScope(nodes, edges, nodeId));
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    if (!confirmRunCost(nodes, edges, { kind: 'node', nodeId })) return;
    resetExecution();
    const snapshot = captureRunSnapshot(nodes, edges);
    const heldStart = blockedProviderStart(
      snapshot,
      get().providerStartAmbiguities,
      nodeId,
    );
    if (heldStart) {
      warnBlockedProviderStart(heldStart);
      return;
    }
    const runId = uuidv4();
    currentRunId = runId;
    registerRun(runId, snapshot, nodeId);
    set((state) => ({
      activeRuns: ownershipState().activeRuns,
      nodes: markExecutionScopeQueued(state.nodes, state.edges, nodeId),
      isExecuting: true,
      isCancelling: false,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'node',
        startedAt: Date.now(),
        snapshot,
        targetNodeId: nodeId,
        startedFreshPaidWorldLabs: runIncludesFreshPaidWorldLabsStart(snapshot, nodeId),
      })),
    }));
    pendingStartRunIds.add(runId);
    try {
      const result = await apiExecuteNode(snapshot.nodes, snapshot.edges, nodeId, runId, undefined, options?.approvalId);
      pendingStartRunIds.delete(runId);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't run the node.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)),
            result.errors,
          ),
          ...ownershipState(),
        }));
      }
    } catch (err) {
      settleFailedStart(runId, err);
      console.error('Failed to start node execution:', err);
      if (currentRunId !== runId) return;
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get);
        return;
      }
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)),
          failureMessage(err, "Couldn't run the node."),
        ),
        ...ownershipState(),
      }));
    }
  },

  isShotAdmissionBlocked: (nodeId, shotId) => {
    if (get().isImportingGraph) return true;
    if (pendingCinemaUploadIssue(nodesInExecutionScope(get().nodes, get().edges, nodeId), { nodeId, shotId })) return true;
    const snapshot = captureRunSnapshot(get().nodes, get().edges);
    const scope = snapshotExecutionScopeIds(snapshot, nodeId);
    const shareableInputs = new Set(snapshot.nodes.filter((node) => STATIC_INPUT_IDS.has(node.definitionId)).map((node) => node.id));
    return scopeOverlaps(scope, { nodeId, shotId, shareableInputs });
  },

  executeShot: async (nodeId, shotId, seed, variations) => {
    const { nodes, edges } = get();
    // Check IDs before looking at the live graph: deleting a node cannot erase
    // its outstanding owner and allow a second paid launch for that same shot.
    if (get().isShotAdmissionBlocked(nodeId, shotId)) return;
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

    const shotSnapshot = captureRunSnapshot(nodes, edges);
    if (runIncludesFreshPaidWorldLabsStart(shotSnapshot, nodeId)) {
      applySceneToNode(set, nodeId, patchShot(scene, {
        ...withoutShotError(shot.output),
        status: 'error',
        error: 'Run the World Labs Environment on Canvas first, then generate this shot from its recovered output.',
      }));
      return;
    }

    // Optimistically mark this shot running (local only — the backend streams the
    // terminal scene back via graphSync).
    applySceneToNode(set, nodeId, patchShot(scene, { ...withoutShotError(shot.output), status: 'running' }));

    const graphNodes = shotSnapshot.nodes;
    const graphEdges = shotSnapshot.edges.map((edge) => ({
      ...edge,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }));

    // Clear the optimistic spinner to an error state when no graphSync will
    // follow (up-front validation failure or a thrown request).
    const failShot = (message: string, reading?: ValidationReading) => {
      const cur = get().nodes.find((n) => n.id === nodeId);
      const curScene = (cur?.data.params as { scene?: CinemaSceneSpec } | undefined)?.scene;
      if (!curScene) return;
      const curShot = curScene.shots.find((s) => s.id === shotId);
      applySceneToNode(set, nodeId, patchShot(curScene, { ...withoutShotError(curShot?.output), status: 'error',
        error: reading?.error ?? message,
        ...(reading?.errorPerson ? { errorPerson: reading.errorPerson } : {}),
        ...(reading?.errorCategory ? { errorCategory: reading.errorCategory } : {}) }));
    };

    const runId = uuidv4();
    registerRun(runId, shotSnapshot, nodeId, shotId);
    pendingStartRunIds.add(runId);
    set((state) => ({ ...ownershipState(), runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
      id: runId, trigger: 'shot', startedAt: Date.now(), snapshot: shotSnapshot,
      targetNodeId: nodeId, startedFreshPaidWorldLabs: false,
      cinemaShot: { nodeId, shotId, seed, variations },
    })) }));
    try {
      const result = await apiGenerateShot(graphNodes, graphEdges, nodeId, shotId, seed, variations, runId);
      pendingStartRunIds.delete(runId);
      if (!ownsRun(runId)) return;
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started') {
        if (result.status === 'validation_error') {
          // The scene's own checks' line, or that another node needs a fix
          // (error copy round 3e); the answer names no node from an older backend.
          const { byNode, global } = validationReadings(result.errors);
          failShot(SHOT_NOT_STARTED_LINE, byNode.get(nodeId) ?? global
            ?? (byNode.size ? writtenReading(OTHER_NODE_LINE) : writtenReading(SHOT_NOT_STARTED_LINE)));
        } else failShot(notStartedMessage("Couldn't start the shot.", result.status));
        settleTrackedExecutionStatus('failed', runId, set, get);
        return;
      }
      updateRunPhase(runId, 'running', set);
      scheduleWorldLabsStatusReconciliation(runId, set, get);
      // status 'started' → the generated image(s) (or per-shot error) arrive via graphSync.
    } catch (err) {
      settleFailedStart(runId, err);
      if (!ownsRun(runId)) return;
      console.error('Failed to generate shot:', err);
      if (err instanceof ExecutionStartRejectedError) {
        failShot(failureMessage(err, "Couldn't start the shot."));
        settleTrackedExecutionStatus('failed', runId, set, get);
      } else await reconcileWorldLabsExecutionStatus(runId, set, get);
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

  executeCluster: async (nodeIds, options) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting || get().isImportingGraph) return;
    const idSet = new Set(nodeIds);
    const clusterNodes = nodes.filter((n) => idSet.has(n.id));
    if (clusterNodes.length === 0) return;
    const uploadIssue = pendingCinemaUploadIssue(clusterNodes);
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    const clusterEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    if (!confirmRunCost(nodes, edges, { kind: 'cluster', nodeIds })) return;
    resetExecution();
    const snapshot = captureRunSnapshot(clusterNodes, clusterEdges);
    const heldStart = blockedProviderStart(snapshot, get().providerStartAmbiguities);
    if (heldStart) {
      warnBlockedProviderStart(heldStart);
      return;
    }
    const runId = uuidv4();
    currentRunId = runId;
    registerRun(runId, snapshot);
    set((state) => ({
      activeRuns: ownershipState().activeRuns,
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
      isCancelling: false,
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId,
        trigger: 'cluster',
        startedAt: Date.now(),
        snapshot,
        startedFreshPaidWorldLabs: runIncludesFreshPaidWorldLabsStart(snapshot),
      })),
    }));
    pendingStartRunIds.add(runId);
    try {
      const result = await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId, undefined, options?.approvalId);
      pendingStartRunIds.delete(runId);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't start the run.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && currentRunId === runId) {
        closeCurrentRun(set, { status: 'failed' });
        set((state) => ({
          nodes: markNodesWithValidationErrors(
            state.nodes,
            idSet,
            result.errors,
          ),
          ...ownershipState(),
        }));
      }
    } catch (err) {
      settleFailedStart(runId, err);
      console.error('Failed to start generation:', err);
      if (currentRunId !== runId) return;
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get);
        return;
      }
      closeCurrentRun(set, { status: 'failed' });
      set((state) => ({
        nodes: markNodesErrored(state.nodes, idSet, failureMessage(err, "Couldn't start the run.")),
        ...ownershipState(),
      }));
    }
  },

  executeClusterConcurrent: async (nodeIds, createOrigin) => {
    if (get().isImportingGraph) return;
    const { nodes, edges } = get();
    if (createOrigin && (!get().createLaunchingIds.includes(createOrigin.genId)
      || get().createCancelledLaunchIds.includes(createOrigin.genId))) return;
    const idSet = new Set(nodeIds);
    if (scopeOverlaps(idSet)) return;
    const clusterNodes = nodes.filter((node) => idSet.has(node.id));
    if (clusterNodes.length === 0) return;
    const uploadIssue = pendingCinemaUploadIssue(clusterNodes);
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    const clusterEdges = edges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target));
    const snapshot = captureRunSnapshot(clusterNodes, clusterEdges);
    if (runIncludesWorldLabs(snapshot)) {
      // Keep paid World Labs starts in the exclusive Canvas admission path.
      await get().executeCluster(nodeIds);
      return;
    }
    const heldStart = blockedProviderStart(snapshot, get().providerStartAmbiguities);
    if (heldStart) { warnBlockedProviderStart(heldStart); return; }
    const runId = uuidv4();
    registerRun(runId, snapshot);
    pendingStartRunIds.add(runId);
    if (createOrigin) createLaunchOwners.delete(createOrigin.genId);
    set((state) => ({
      ...ownershipState(),
      createLaunchingIds: createOrigin ? state.createLaunchingIds.filter((id) => id !== createOrigin.genId) : state.createLaunchingIds,
      nodes: markSnapshotScopeQueued(state.nodes, idSet),
      runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId, trigger: 'cluster', startedAt: Date.now(), snapshot,
        startedFreshPaidWorldLabs: false, createOrigin,
      })),
    }));
    try {
      const result = await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId);
      pendingStartRunIds.delete(runId);
      if (!ownsRun(runId)) return;
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status === 'started') {
        updateRunPhase(runId, 'running', set);
        scheduleWorldLabsStatusReconciliation(runId, set, get);
        return;
      }
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({ nodes: result.status === 'validation_error'
        ? markNodesWithValidationErrors(state.nodes, idSet, result.errors)
        : markNodesErrored(state.nodes, idSet, notStartedMessage("Couldn't start the run.", result.status)) }));
    } catch (error) {
      settleFailedStart(runId, error);
      if (!ownsRun(runId)) return;
      console.error('Failed to start concurrent generation:', error);
      // A lost HTTP acknowledgement can follow an accepted start. Query the
      // client-owned ID before releasing ownership and permitting duplicate work.
      if (!(error instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get);
        return;
      }
      closeTrackedRun(set, runId, { status: cancellationRequestedRunIds.has(runId) ? 'cancelled' : 'failed' });
      set((state) => ({ nodes: markNodesErrored(state.nodes, idSet,
        failureMessage(error, "Couldn't start the run.")) }));
    }
  },

  authorGenerationCluster: async (request) => {
    if (get().isImportingGraph) throw new FailureNotice("Couldn't start the generation.", 'Wait for the graph import to finish.');
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
      // A per-model default (Max Tokens) follows the model asked for unless the
      // request sets it (lib/paramDefaults.ts).
      const params = withParamDefaults(def, {
        ...withNewKreaMode(def, buildDefaultParams(def),
          useUIStore.getState().settingsCache.kreaConnectionMode),
        ...request.params,
      }, request.params);
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
    const synced = watchGraphSyncs();
    try {
      const res = await graphMutationFetch('/api/graph/cluster', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes: specNodes, edges: specEdges }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { idMap: Record<string, string>; nodes: Node<NodeData>[]; edges: Edge[] };
      idMap = data.idMap; rfNodes = data.nodes ?? []; rfEdges = data.edges ?? [];
    } catch (err) {
      console.error('[nebula] authorGenerationCluster persist failed:', err);
      return { modelNodeIds: [], allNodeIds: [] };
    } finally {
      synced.stop();
    }

    const origin: CreateOriginTag = { sessionId: request.sessionId, genId: request.genId, ts: Date.now(), prompt: request.prompt };
    const modelIds = new Set(modelTemps.map((t) => idMap[t]).filter(Boolean));
    const taggedNodes = rfNodes.map((n) =>
      modelIds.has(n.id) ? { ...n, data: { ...n.data, _createOrigin: origin,
        keyStatus: nodeKeyStatus(def, n.data.params, useUIStore.getState().settingsCache),
      } } : n,
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
      const newNodes = taggedNodes.filter((n) => !existingIds.has(n.id) && !synced.seen.has(n.id));
      const existingEdgeIds = new Set(state.edges.map((e) => e.id));
      return {
        nodes: [...mergedNodes, ...newNodes],
        edges: [...state.edges, ...rfEdges.filter((e) => !existingEdgeIds.has(e.id) && !synced.seen.has(edgeKey(e)))],
      };
    });

    const modelNodeIds = modelTemps.map((t) => idMap[t]).filter(Boolean);
    const allNodeIds = [...modelTemps, ...(textTemp ? [textTemp] : []), ...imageTemps].map((t) => idMap[t]).filter(Boolean);
    return { modelNodeIds, allNodeIds };
  },

  adoptAcceptedProposal: ({ nodes: incoming, edges: incomingEdges, updatedNodes }, options) => {
    // The backend already committed these (and broadcast a graphSync); adding
    // them here too means the nodes exist locally before the canvas runs them.
    // Like authorGenerationCluster's merge: one undo step, ids never duplicated.
    // The step is usually the one Accept took before sending (its graphSync
    // can land before this reply); without one, take it now.
    const stack = get().undoStack;
    if (options?.undoStep === undefined || stack[stack.length - 1] !== options.undoStep) pushUndo(set, get);
    set((state) => {
      const updates = new Map(updatedNodes.map((node) => [node.id, node]));
      const merged = state.nodes.map((node) => {
        const update = updates.get(node.id);
        return update
          ? { ...node, data: { ...node.data, params: { ...node.data.params, ...update.data.params } } }
          : node;
      });
      const existingIds = new Set(state.nodes.map((node) => node.id));
      const existingEdgeIds = new Set(state.edges.map((edge) => edge.id));
      // What a sync already carried is the syncs' (an agent may have removed it since).
      const synced = options?.synced ?? new Set<string>();
      return {
        nodes: [...merged, ...incoming.filter((node) => !existingIds.has(node.id) && !synced.has(node.id))],
        edges: [...state.edges, ...incomingEdges.filter((edge) => !existingEdgeIds.has(edge.id) && !synced.has(edgeKey(edge)))],
      };
    });
  },

  deleteGeneration: (modelNodeIds) => {
    const { nodes, edges, isExecuting } = get();
    if (isExecuting) return;
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
    if (refuseHeldNodeDelete(get(), [...toRemove], set)) return;
    get().onNodesChange([...toRemove].map((id) => ({ id, type: 'remove' as const })));
  },

  duplicateNode: (nodeId) => {
    const state = get();
    if (state.isExecuting) return;
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const params = providerSafeCloneParams(state, node);
    if (!params) {
      warnUnsafeProviderClone();
      return;
    }

    pushUndo(set, get);

    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: node.type,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      data: {
        ...node.data,
        params,
        state: 'idle' as const,
        outputs: {},
        batchOutputs: undefined,
        batchVariants: undefined,
        batchRunId: undefined,
        runNotes: undefined,
        error: undefined,
        progress: undefined,
        streamingText: undefined,
        streamingPartials: undefined,
      },
    };
    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  deleteNode: (nodeId) => {
    if (get().isExecuting || refuseHeldNodeDelete(get(), [nodeId], set)) return;
    get().onNodesChange([{ id: nodeId, type: 'remove' }]);
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
    const runtimeDuration = sourceParams._sourceDuration ?? sourceParams.sourceDuration;
    const runtimeFps = sourceParams._sourceFps ?? sourceParams.sourceFps;
    const runtimeIsVfr = sourceParams._sourceIsVfr ?? sourceParams.sourceIsVfr;
    const sourceDuration = typeof runtimeDuration === 'number' ? runtimeDuration : 0;
    const sourceFps = typeof runtimeFps === 'number' && runtimeFps > 0 ? runtimeFps : 30;
    const sourceIsVfr = Boolean(runtimeIsVfr);

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
      if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) void sendWire(edge, false, set);
    }

    applySceneToNode(set, nodeId, nextScene);
    persistSceneParam(nodeId, nextScene);
  },

  updateScene: (nodeId, change) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node || node.data.definitionId !== 'cinema-scene') return;
    const current = sceneFromNode(node);
    const spec = typeof change === 'function' ? change(current) : change;
    if (!spec || spec === current) return;

    maybePushUndo(set, get, nodeId);

    // Prune edges that point at a shot port the new spec no longer has.
    const validPortIds = new Set(spec.shots.map((s) => shotPortId(s.id)));
    for (const edge of get().edges) {
      if (edge.source !== nodeId || !edge.sourceHandle?.startsWith('shot_')) continue;
      if (validPortIds.has(edge.sourceHandle)) continue;
      if (CLI_ID_RE.test(edge.source) && CLI_ID_RE.test(edge.target)) void sendWire(edge, false, set);
    }

    applySceneToNode(set, nodeId, spec);
    persistSceneParam(nodeId, spec);
  },

  // Character node — mirrors addNode's static path. The node keeps only the
  // id (the `character` param, which the Inspector picker and agents set);
  // CharacterNode.tsx shows the Character itself (storedAssetsStore).
  addCharacterNode: async (characterId, position, meta) => {
    if (get().isImportingGraph) return null;
    const definition = NODE_DEFINITIONS['character'];
    if (!definition) return null;

    // Build param defaults from the definition, then layer in runtime refs.
    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    const params: Record<string, unknown> = { ...defaults, character: characterId };
    if (meta) {
      useStoredAssetsStore.getState().prime('character', {
        id: characterId, name: meta.name ?? '', thumbnail: meta.thumbnail ?? '',
      });
    }

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    try {
      const backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
      if (!backendFresh) throw new Error('Backend fresh-start guard failed');

      const res = await graphMutationFetch('/api/graph/node', {
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
  // saved Moodboard asset (the `moodboard` param). Execution resolves it from
  // MoodboardStore; the card from storedAssetsStore.
  addMoodboardNode: async (moodboardId, position, meta) => {
    if (get().isImportingGraph) return null;
    const definition = NODE_DEFINITIONS['nebula-moodboard'];
    if (!definition) return null;

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    const params: Record<string, unknown> = { ...defaults, moodboard: moodboardId };
    if (meta) {
      useStoredAssetsStore.getState().prime('moodboard', {
        id: moodboardId,
        name: meta.name ?? '',
        thumbnail: meta.thumbnail ?? '',
        imageCount: meta.imageCount ?? 0,
        setAsideCount: meta.setAsideCount ?? 0,
        mode: meta.mode === 'world' || meta.mode === 'subject' ? meta.mode : 'look',
      });
    }

    const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

    try {
      const backendFresh = await ensureBackendFreshForLocalCanvas(localCanvasWasEmpty, set, get);
      if (!backendFresh) throw new Error('Backend fresh-start guard failed');

      const res = await graphMutationFetch('/api/graph/node', {
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

  loadGraph: (nodes, edges, options) => {
    if (get().isExecuting && !options?.allowDuringExecution) return;
    canvasReplacementRevision += 1;
    pendingConnectedNodeCreationAttempt = null;
    clearCinemaScenePersistence();
    useCinemaMotionStore.getState().clear();
    if (!options?.preserveCinemaUploads) clearReplacedCanvasFocus();
    if (!options?.preserveCinemaUploads) useCinemaUploadStore.getState().clear();
    // Hydration/import must never release a paid-run owner. Only terminal
    // execution events or status reconciliation may unlock the Run control.
    set({
      nodes: nodesWithProviderRecoveries(nodes, get().providerRecoveries),
      edges,
      undoStack: [],
      redoStack: [],
      backendFreshStartPending: false,
    });
    useCinemaUploadStore.getState().reconcileTargets(get().nodes);
  },

  canSwitchProject: () => {
    const state = get();
    const session = useUIStore.getState().createSessionId;
    const createUploads = session ? useCreateDraftStore.getState().drafts[session]?.uploads ?? [] : [];
    const referencesUploading = createUploads.some((upload) => upload.status === 'uploading')
      || useCinemaUploadStore.getState().uploads.some((upload) => upload.status === 'uploading');
    return !state.isExecuting && !state.isImportingGraph && state.createLaunchingIds.length === 0
      && state.providerStartAmbiguities.length === 0 && state.uncertainWorldLabsRunId === null
      && activeRunOwners.size === 0 && createLaunchOwners.size === 0
      && !pendingNodeCreationAttempt && !pendingConnectedNodeCreationAttempt
      && !referencesUploading && pendingGraphMutationCount === 0 && Object.keys(paramPushTimers).length === 0;
  },

  loadProjectGraph: (nodes, edges, history, options) => {
    // Validate before revoking any current owner or draft. Corrupt project data
    // must never turn a previously protected paid run into an unowned one.
    let restoredHistory: RunRecord[];
    try {
      const payload = JSON.stringify({ version: 1, records: history });
      restoredHistory = loadRunHistory({ getItem: () => payload, setItem: () => {}, removeItem: () => {} });
    } catch { return false; }
    const historyIds = new Set(restoredHistory.filter((record) => record.status === 'running').map((record) => record.id));
    // Reload may already have registered this exact saved project's owners on
    // module initialization. Rebuilding them must not call resetExecution or
    // falsely write terminal cancellation records.
    const bootstrapSameOwners = options?.bootstrap === true && !get().isImportingGraph
      && get().createLaunchingIds.length === 0 && createLaunchOwners.size === 0
      && !pendingNodeCreationAttempt && !pendingConnectedNodeCreationAttempt
      && pendingGraphMutationCount === 0
      && [...activeRunOwners.keys()].every((id) => historyIds.has(id));
    if (!get().canSwitchProject() && !bootstrapSameOwners) return false;

    canvasReplacementRevision += 1;
    pendingNodeCreationAttempt = null;
    pendingConnectedNodeCreationAttempt = null;
    clearAllParamPushTimers();
    clearCinemaScenePersistence();
    useCinemaUploadStore.getState().clear();
    useCinemaMotionStore.getState().clear();
    clearReplacedCanvasFocus();
    for (const timer of statusReconciliationTimers.values()) clearTimeout(timer);
    statusReconciliationTimers.clear();
    activeRunOwners.clear();
    runErrors.clear();
    runShareableInputs.clear();
    createLaunchOwners.clear();
    cancelledCreateLaunches.clear();
    const nextHistoryIds = new Set(restoredHistory.map((record) => record.id));
    for (const record of get().runHistory) {
      if (!nextHistoryIds.has(record.id)) retiredProjectRunIds.add(record.id);
    }
    for (const id of nextHistoryIds) retiredProjectRunIds.delete(id);
    while (retiredProjectRunIds.size > 1000) retiredProjectRunIds.delete(retiredProjectRunIds.values().next().value!);
    settledCinemaRuns.clear();
    pendingStartRunIds.clear();
    cancellationRequestedRunIds.clear();
    currentRunId = null;
    lastUndoPush = 0;
    lastUndoNodeId = '';
    canvasLoad += 1;

    for (const record of restoredHistory) {
      if (record.status !== 'running') continue;
      registerRun(record.id, record.snapshot, record.targetNodeId, record.cinemaShot?.shotId);
      terminalRunIds.delete(record.id);
      cancelledRunIds.delete(record.id);
      activeRunOwners.get(record.id)!.status = 'uncertain';
    }
    currentRunId = restoredHistory.find((record) => record.status === 'running'
      && !record.createOrigin && !record.cinemaShot)?.id ?? null;
    useUIStore.setState({
      selectedNodeId: null, inspectorPinned: false, canvasFocusRequest: null,
      editorTargetNodeId: null, remotionEditorTargetNodeId: null, cinemaEditorNodeId: null,
      characterEditorId: null, moodboardEditorId: null, selectedClipId: null,
      selectedTrackItemId: null, selectedTrackItemIds: [], isKeyframeRecording: false,
      isPlaying: false, renderedPreviewUrl: null, playheadOutputTime: 0, timelineZoom: 1,
      pendingPreset: null, createSessionId: null, onboardingActive: false,
      contextMenu: { visible: false, position: { x: 0, y: 0 }, nodeId: null, flowPosition: null },
      connectionPopup: { visible: false, position: { x: 0, y: 0 }, nodeId: '', handleId: '', handleType: 'source' },
    });
    set({
      nodes, edges, runHistory: persistedRunHistory(restoredHistory),
      ...ownershipState(), createLaunchingIds: [], createCancelledLaunchIds: [],
      // The clipboard stays, so nodes copy across projects; the bumped load
      // makes it paste with its copy-time params (see CanvasClipboard).
      undoStack: [], redoStack: [], backendFreshStartPending: false,
      providerRecoveryWarning: null, providerRecoveries: [], providerStartAmbiguities: [],
      uncertainWorldLabsRunId: null,
    });
    return true;
  },

  loadSampleGraph: () => {
    if (get().isExecuting) return;
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
    // Dependency-aware layered positions, spaced by each node's rendered size.
    // Persisted like a drag: other open canvases take them from the graphSync.
    const pos = computeLayout(nodes.map(layoutNode), edges);
    set((state) => ({
      nodes: state.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)),
    }));
    persistNodePositions(pos);
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

  rerunHistoryWithLatestPaperSource: async (runId) => {
    const state = get();
    const source = state.runHistory.find((record) => record.id === runId);
    if (!source) return;
    const snapshot = snapshotWithLatestPaperSources(source, captureRunSnapshot(state.nodes, state.edges));
    if (!snapshot) {
      get().notify('Refresh or reconnect the Paper sources in this saved recipe before rerunning with the latest snapshot. Their last successful snapshots remain in source history.');
      return;
    }
    await executeHistoricalRun({ ...source, snapshot }, 'latest-paper-source', set, get);
  },

  retryFailedRun: async (runId) => {
    const source = get().runHistory.find((record) => record.id === runId);
    if (!source || source.status !== 'failed') return;
    await executeHistoricalRun(source, 'retry-failed', set, get);
  },

  clearRunHistory: () => {
    const { isExecuting, providerRecoveries, providerStartAmbiguities } = get();
    if (isExecuting || providerRecoveries.length > 0 || providerStartAmbiguities.length > 0) return;
    clearPersistedRunHistory();
    set({ runHistory: [] });
  },

  clearGraph: (options) => {
    const {
      nodes,
      edges,
      undoStack,
      isExecuting,
      providerRecoveries,
      providerStartAmbiguities,
    } = get();
    if (isExecuting || providerRecoveries.length > 0 || providerStartAmbiguities.length > 0) return;
    clearCinemaScenePersistence();
    useCinemaMotionStore.getState().clear();
    clearReplacedCanvasFocus();
    useCinemaUploadStore.getState().clear();
    const stepped = options?.undoStep !== undefined && undoStack[undoStack.length - 1] === options.undoStep;
    const newStack = stepped ? undoStack : [...undoStack, createSnapshot(nodes, edges)];
    if (newStack.length > UNDO_CAP) newStack.shift();
    set({ nodes: [], edges: [], undoStack: newStack, redoStack: [], backendFreshStartPending: false });
  },

  // The model pickers ask the backend for a model's ports and params
  // (services/universal_ports.py, POST /api/graph/node/{id}/model): one set of
  // rules for the canvas, the wire checks and agents' edits. The backend also
  // drops wires on ports the new model doesn't have and syncs the canvas.
  configureOpenRouterModel: async (nodeId, modelId) => {
    const step = get().beginUndoStep();
    try {
      const result = await requestUniversalModel(nodeId, modelId);
      if (!result) {
        get().cancelUndoStep(step);
        return;
      }
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
              params: withEditsSinceRequest(nodeId, data.definitionId, result.params, data.params),
              outputs: outputsOnPorts(data.outputs, result.dynamicOutputPorts),
              dynamicInputPorts: result.dynamicInputPorts,
              dynamicOutputPorts: result.dynamicOutputPorts,
              dynamicParams: data.dynamicParams ?? [],
              providerMeta: data.providerMeta ?? {},
            } as unknown as NodeData,
          };
        }),
        // Remove edges connected to ports that no longer exist
        edges: state.edges.filter((e) => edgeFitsPorts(nodeId, e, result)),
      }));
    } catch (err) {
      get().cancelUndoStep(step);
      console.error('Failed to set the model:', err);
    }
  },

  fetchReplicateSchemaAndConfigure: async (nodeId, owner, name) => {
    const step = get().beginUndoStep();
    try {
      const result = await requestUniversalModel(nodeId, `${owner}/${name}`);
      if (!result) {
        get().cancelUndoStep(step);
        return;
      }
      set((state) => ({
        nodes: state.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const data = n.data as unknown as DynamicNodeData;
          return {
            ...n,
            data: {
              ...data,
              params: withEditsSinceRequest(nodeId, data.definitionId, result.params, data.params),
              outputs: outputsOnPorts(data.outputs, result.dynamicOutputPorts),
              dynamicInputPorts: result.dynamicInputPorts,
              dynamicOutputPorts: result.dynamicOutputPorts,
              dynamicParams: result.dynamicParams,
              providerMeta: { ...data.providerMeta, ...result.providerMeta },
            } as unknown as NodeData,
          };
        }),
        edges: state.edges.filter((e) => edgeFitsPorts(nodeId, e, result)),
      }));
    } catch (err) {
      get().cancelUndoStep(step);
      console.error('Failed to fetch Replicate schema:', err);
    }
  },

  handleExecutionEvent: (event) => {
    const revision = (event as ExecutionEvent & { workspaceRevision?: string }).workspaceRevision;
    if (revision !== undefined && revision !== getProjectContext()?.revision) return;
    if (event.runId && retiredProjectRunIds.has(event.runId)) return;
    // Recovery IDs can arrive while cancellation is settling. They must be
    // applied before graphCancelled so a paid provider job is never stranded.
    if (
      event.runId
      && (cancelledRunIds.has(event.runId) || terminalRunIds.has(event.runId)
        || get().runHistory.some((record) => record.id === event.runId && record.status !== 'running'))
      && event.type !== 'graphCancelled'
      && event.type !== 'providerRecovery'
      && event.type !== 'providerStartAmbiguous'
    ) {
      return;
    }
    if ('nodeId' in event && event.runId && event.type !== 'providerRecovery'
      && event.type !== 'providerStartAmbiguous' && !ownsRun(event.runId)
      && scopeOverlaps([event.nodeId])) return;
    switch (event.type) {
      case 'executionStatus':
        if (event.runId && !ownsRun(event.runId)) {
          settleForeignRun(event.runId, set);
        }
        if (event.runId) get().hydrateExecutionStatuses([{
          runId: event.runId,
          status: event.status,
        }]);
        break;
      case 'providerStartAmbiguous':
        set((state) => ({
          providerStartAmbiguities: normalizedProviderStartAmbiguities([
            ...state.providerStartAmbiguities,
            {
              runId: event.runId ?? '',
              nodeId: event.nodeId,
              kind: event.kind,
              message: event.message,
              durable: event.durable,
            },
          ]),
        }));
        break;
      case 'providerRecovery':
        set((state) => {
          const checkpoint: ProviderRecoveryCheckpoint = {
            runId: event.runId ?? '',
            nodeId: event.nodeId,
            resumeOperationId: event.resumeOperationId,
            existingWorldId: event.existingWorldId,
            durable: event.durable,
            warning: event.warning,
          };
          const nodes = state.nodes.map((node) => {
            if (node.id !== event.nodeId) return node;
            const params = applyProviderRecoveryToLiveParams(
              node.data.definitionId,
              node.data.params,
              checkpoint,
            );
            if (!params) return node;
            return {
              ...node,
              data: {
                ...node.data,
                params,
              },
            };
          });
          const runHistory = event.runId
            ? applyProviderRecoveriesToHistory(state.runHistory, [checkpoint])
            : state.runHistory;
          if (runHistory !== state.runHistory) persistRunHistory(runHistory);
          const providerRecoveryWarning = providerRecoveryWarningText(checkpoint)
            ?? state.providerRecoveryWarning;
          const providerRecoveries = normalizedProviderRecoveries([
            ...state.providerRecoveries,
            checkpoint,
          ]);
          return { nodes, runHistory, providerRecoveryWarning, providerRecoveries };
        });
        break;
      case 'queued':
        if (event.runId && !ownsRun(event.runId)) noteForeignRunNode(event.runId, event.nodeId);
        get().updateNodeData(event.nodeId, {
          state: 'queued',
          ...clearBatchPreview(event.runId ?? currentRunId ?? undefined),
          streamingText: undefined,
          streamingPartials: undefined,
          ...CLEAR_GATE_STATE,
        });
        break;
      case 'executing': {
        if (event.runId && !ownsRun(event.runId)) noteForeignRunNode(event.runId, event.nodeId);
        const runId = event.runId ?? currentRunId ?? undefined;
        const live = get().nodes.find((node) => node.id === event.nodeId);
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0, runStartedAt: Date.now(), streamingText: undefined,
          streamingPartials: undefined, streamingSvg: undefined, runNotes: undefined, ...CLEAR_GATE_STATE,
          ...(live?.data.batchRunId !== runId ? clearBatchPreview(runId) : {}),
        });
        break;
      }
      case 'progress':
        get().updateNodeData(event.nodeId, { progress: event.value });
        break;
      case 'executed': {
        const outputs = normalizedExecutionOutputs(event.outputs);
        const runId = event.runId ?? currentRunId;
        const batchOutputs = Array.isArray(event.batchOutputs)
          ? event.batchOutputs.map(normalizedExecutionOutputs) : undefined;
        const batchVariants = batchOutputs
          ? sanitizeVariantScopes(event.batchVariants, batchOutputs.length) : undefined;
        const record = get().runHistory.find((candidate) => candidate.id === runId);
        if (record && runId && ownsRun(runId) && record.status === 'running'
          && record.snapshot.nodes.some((saved) => saved.id === event.nodeId)) {
          set((state) => {
            let runHistory = recordRunOutput(state.runHistory, runId, event.nodeId, outputs);
            if (batchOutputs) {
              runHistory = recordRunBatchOutputs(runHistory, runId, event.nodeId,
                batchOutputs, batchVariants);
            }
            return { runHistory: persistedRunHistory(runHistory) };
          });
        }
        const live = get().nodes.find((node) => node.id === event.nodeId);
        // A captured A source event may arrive after the live source refreshed
        // to B. Retain A in history without rewinding B's visible preview.
        if (live?.data.definitionId === 'paper-source') {
          get().updateNodeData(event.nodeId, { state: 'complete', progress: undefined });
          break;
        }
        // Whole-scene work retains its original recipe in history, but the
        // live scene may have removed/added shots since generation began.
        // Accept results only for surviving ports and retain newer siblings.
        const liveOutputs = live?.data.definitionId === 'cinema-scene'
          ? Object.fromEntries(Object.entries({ ...live.data.outputs, ...outputs }).filter(([portId]) =>
            !portId.startsWith('shot_') || sceneFromNode(live).shots.some((shot) => shotPortId(shot.id) === portId)))
          : outputs;
        const paperInputs = record ? paperInputsForSnapshot(record.snapshot, event.nodeId) : [];
        const outputFreshness = record && paperInputs.length ? {
          runId: record.id,
          recipeRevision: paperRecipeRevision(record.snapshot, event.nodeId),
          paperInputs,
          outOfDateReasons: paperRunOutOfDateReasons(record, captureRunSnapshot(get().nodes, get().edges), event.nodeId),
        } : undefined;
        const runNotes = Array.isArray(event.notes)
          ? event.notes.filter((note): note is string => typeof note === 'string' && note !== '') : [];
        // A replay of a record from before a behaviour change says once that
        // it can differ (savedParamsUpgrades.ts runReplayNotes).
        const replayed = record?.sourceRunId
          ? get().runHistory.find((candidate) => candidate.id === record.sourceRunId) : undefined;
        if (replayed) {
          for (const note of runReplayNotes(replayed.snapshot, runBehaviourVersion(replayed))[event.nodeId] ?? []) {
            if (!runNotes.includes(note)) runNotes.push(note);
          }
        }
        get().updateNodeData(event.nodeId, { state: 'complete', outputs: liveOutputs as NodeData['outputs'],
          batchOutputs, batchVariants, batchRunId: runId ?? undefined, runNotes: runNotes.length ? runNotes : undefined,
          outputFreshness, progress: undefined, streamingText: undefined, streamingPartials: undefined, streamingSvg: undefined,
          skipReason: undefined, skipGateNodeId: undefined, withheldPorts: withheldPorts(event.withheld) });
        break;
      }
      case 'skipped': {
        // A gate upstream withheld this node's input: it never started and
        // cost nothing. Its previous outputs stay but aren't shown as current.
        const runId = event.runId ?? currentRunId;
        if (runId && ownsRun(runId)) {
          set((state) => {
            const runHistory = recordRunSkip(state.runHistory, runId, event.nodeId, String(event.reason ?? ''));
            return runHistory === state.runHistory ? {} : { runHistory: persistedRunHistory(runHistory) };
          });
        }
        get().updateNodeData(event.nodeId, {
          state: 'skipped',
          skipReason: typeof event.reason === 'string' && event.reason ? event.reason : 'A gate upstream withheld its input',
          skipGateNodeId: typeof event.gateNodeId === 'string' ? event.gateNodeId : undefined,
          withheldPorts: undefined,
          // Notes describe a run; a skipped node didn't run this time.
          runNotes: undefined,
          progress: undefined,
          streamingText: undefined,
          streamingPartials: undefined,
          streamingSvg: undefined,
        });
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
        if (!event.runId && currentRunId) runErrors.set(currentRunId, true);
        get().updateNodeData(event.nodeId, {
          state: 'error',
          error: event.error,
          errorCategory: event.category,
          errorFriendly: event.friendly,
          errorPerson: event.person ?? undefined,
          errorProviderText: event.providerText || undefined,
          errorProvider: event.provider || undefined,
          progress: undefined,
          streamingText: undefined,
          streamingPartials: undefined,
        });
        break;
      case 'validationError': {
        const runId = event.runId ?? currentRunId;
        // CLI runs also annotate their validation errors, but an unrelated
        // external validation cannot overwrite a locally owned node. Each
        // node reads all its checks together (lib/validationCopy.ts), as its
        // run call's answer and a reload do.
        for (const [nodeId, reading] of validationReadings(event.errors).byNode) {
          if ((runId && ownsRun(runId)) || !scopeOverlaps([nodeId])) {
            get().updateNodeData(nodeId, {
              state: 'error', error: reading.error, errorCategory: reading.errorCategory, errorFriendly: undefined,
              errorPerson: reading.errorPerson, errorProviderText: undefined, errorProvider: undefined,
            });
          }
        }
        if (runId && ownsRun(runId)) {
          runErrors.set(runId, true);
          settleTrackedExecutionStatus(cancellationRequestedRunIds.has(runId) ? 'cancelled' : 'failed', runId, set, get);
          notifyJobComplete({ ok: false, durationSec: 0, nodesExecuted: 0 });
        }
        break;
      }
      case 'graphComplete': {
        const runId = event.runId ?? currentRunId;
        if (runId && !ownsRun(runId)) settleForeignRun(runId, set);
        if (!runId || !ownsRun(runId)) break;
        const runFailed = runErrors.get(runId) === true;
        // A completion after Stop remains authoritative: completed work is
        // complete; DELETE/status reconciliation decides actual cancellation.
        settleTrackedExecutionStatus('completed', runId, set, get, {
          durationSec: event.duration, nodesExecuted: event.nodesExecuted });
        notifyJobComplete({ ok: !runFailed, durationSec: event.duration, nodesExecuted: event.nodesExecuted,
          nodesSkipped: event.nodesSkipped });
        break;
      }
      case 'graphCancelled': {
        const runId = event.runId ?? currentRunId;
        if (runId && !ownsRun(runId)) settleForeignRun(runId, set);
        if (runId) {
          rememberCancelledRun(runId);
          settleTrackedExecutionStatus('cancelled', runId, set, get);
        }
        break;
      }
    }
  },

  hydrateProviderRecoveries: (checkpoints) => {
    set((state) => {
      // Snapshots can race live events (initial REST load versus websocket).
      // Merge-only is deliberately fail-closed; confirmed exact DELETE is the
      // sole path that removes a safeguard from this client.
      const providerRecoveries = mergeProviderRecoverySnapshot(
        state.providerRecoveries,
        checkpoints,
      );
      const runHistory = applyProviderRecoveriesToHistory(
        state.runHistory,
        providerRecoveries,
      );
      if (runHistory !== state.runHistory) persistRunHistory(runHistory);
      return {
        runHistory,
        providerRecoveries,
        nodes: nodesWithProviderRecoveries(state.nodes, providerRecoveries),
      };
    });
  },

  deleteProviderRecovery: async (runId, nodeId) => {
    // Round 3b: the person reads these (Run History alerts them), so they are
    // written lines under the button's heading, not developer text.
    if (get().isExecuting) {
      throw new FailureNotice(FORGET_RECOVERY_HEADING, 'Let the run finish, then try again.');
    }
    const expected = get().providerRecoveries.find(
      (checkpoint) => checkpoint.runId === runId && checkpoint.nodeId === nodeId,
    );
    if (!expected || expected.durable === false) {
      throw new FailureNotice(FORGET_RECOVERY_HEADING,
        "That recovery safeguard isn't there anymore. Reload to get the latest run history.");
    }
    await apiDeleteProviderRecovery(runId, nodeId, expected);
    set((state) => {
      const stillCurrent = state.providerRecoveries.some(
        (checkpoint) => sameProviderRecoveryIdentity(checkpoint, expected),
      );
      // The provider checkpoint may have advanced operation -> world while the
      // DELETE response was in flight. Never let an old response clear it.
      if (!stillCurrent) return {};
      const runHistory = historyWithoutProviderRecovery(
        state.runHistory,
        runId,
        nodeId,
        expected,
      );
      if (runHistory !== state.runHistory) persistRunHistory(runHistory);
      const expectedKey = expected.resumeOperationId
        ? 'resume_operation_id'
        : 'existing_world_id';
      const expectedId = expected.resumeOperationId ?? expected.existingWorldId;
      return {
        providerRecoveries: state.providerRecoveries.filter(
          (checkpoint) => !sameProviderRecoveryIdentity(checkpoint, expected),
        ),
        runHistory,
        nodes: state.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          const params = { ...node.data.params };
          if (!expectedId || params[expectedKey] !== expectedId) return node;
          delete params.resume_operation_id;
          delete params.existing_world_id;
          return { ...node, data: { ...node.data, params } };
        }),
      };
    });
  },

  hydrateProviderStartAmbiguities: (ambiguities) => {
    // See recovery hydration above: stale snapshots may add an over-lock, but
    // must never erase a newer live ambiguity and permit a duplicate charge.
    set((state) => ({
      providerStartAmbiguities: mergeProviderStartAmbiguitySnapshot(
        state.providerStartAmbiguities,
        ambiguities,
      ),
    }));
  },

  hydrateExecutionStatuses: (statuses) => {
    for (const status of statuses) {
      if (!ownsRun(status.runId)) continue;
      if (status.status === 'running' || status.status === 'cancelling') {
        clearConfirmedRunAdvisory(status.runId, set);
        updateRunPhase(status.runId, cancellationRequestedRunIds.has(status.runId)
          || status.status === 'cancelling' ? 'cancelling' : 'running', set);
        if (get().uncertainWorldLabsRunId === status.runId) set({ uncertainWorldLabsRunId: null });
        if (get().providerRecoveryWarning === WORLD_LABS_STATUS_UNCERTAIN_WARNING) set({ providerRecoveryWarning: null });
        scheduleWorldLabsStatusReconciliation(status.runId, set, get);
      } else settleTrackedExecutionStatus(status.status, status.runId, set, get);
    }
    if (currentRunId && !statuses.some((status) => status.runId === currentRunId)
      && !pendingStartRunIds.has(currentRunId) && trackedRunHasFreshPaidWorldLabs(currentRunId, get)) {
      updateRunPhase(currentRunId, 'uncertain', set);
      set({ uncertainWorldLabsRunId: currentRunId, providerRecoveryWarning: WORLD_LABS_STATUS_UNCERTAIN_WARNING });
    }
  },

  acknowledgeProviderStartAmbiguity: async (kind, nodeId) => {
    const ambiguity = get().providerStartAmbiguities.find(
      (candidate) => candidate.kind === kind && candidate.nodeId === nodeId,
    );
    if (!ambiguity) return;
    await apiAcknowledgeProviderStartAmbiguity(kind, nodeId, ambiguity.runId);
    set((state) => {
      return {
        providerStartAmbiguities: state.providerStartAmbiguities.filter(
          (candidate) => candidate.kind !== kind
            || candidate.nodeId !== nodeId
            || candidate.runId !== ambiguity.runId,
        ),
      };
    });
    if (currentRunId !== ambiguity.runId || !get().isExecuting) return;
    try {
      const status = await apiGetExecutionStatus(ambiguity.runId);
      if (status.status === 'running' || status.status === 'cancelling') {
        set({
          isExecuting: true,
          isCancelling: status.status === 'cancelling',
          uncertainWorldLabsRunId: null,
        });
        scheduleWorldLabsStatusReconciliation(ambiguity.runId, set, get);
        return;
      }
      settleTrackedExecutionStatus(status.status, ambiguity.runId, set, get);
    } catch {
      // The user explicitly confirmed Marble before acknowledging the hold.
      // If the local registry can no longer identify this run, close the stale
      // frontend owner rather than relocking it forever across reloads.
      settleTrackedExecutionStatus('failed', ambiguity.runId, set, get, {
        statusNote: 'Marble checked; ambiguous provider-start hold was manually cleared.',
      });
    }
  },

  acknowledgeUncertainWorldLabsRun: () => {
    const runId = get().uncertainWorldLabsRunId;
    if (!runId || currentRunId !== runId) return;
    settleTrackedExecutionStatus('failed', runId, set, get, {
      statusNote: 'Marble checked; the unconfirmed local run lock was manually cleared.',
    });
  },

  reconcilePersistedWorldLabsRun: async () => {
    // Legacy method name retained for App's bootstrap call. Reconnect every
    // persisted owner, including ordinary Create and Cinema work.
    const pending = get().runHistory.filter((record) => record.status === 'running');
    for (const record of pending) {
      if (!ownsRun(record.id)) registerRun(record.id, record.snapshot, record.targetNodeId, record.cinemaShot?.shotId);
    }
    currentRunId = pending.find((record) => !record.createOrigin && !record.cinemaShot)?.id ?? null;
    set(ownershipState());
    await Promise.all(pending.map((record) => reconcileWorldLabsExecutionStatus(record.id, set, get)));
  },

  dismissProviderRecoveryWarning: () => set({ providerRecoveryWarning: null }),
}));

// A line from a module that doesn't import this store (lib/canvasNotice.ts,
// round 3f) becomes the canvas notice.
if (typeof window !== 'undefined') {
  window.addEventListener(CANVAS_NOTICE_EVENT, (event) => {
    const detail = (event as CustomEvent<CanvasNoticeDetail>).detail;
    if (detail?.text) useGraphStore.getState().notify(detail.text, detail.tone);
  });
}

// Hold navigation through response parsing and local authoring callbacks too.
const projectMutationMethods = useGraphStore.getState();
useGraphStore.setState({
  addNode: withGraphMutationLifetime(projectMutationMethods.addNode),
  addNodeAndConnect: withGraphMutationLifetime(projectMutationMethods.addNodeAndConnect),
  addCharacterNode: withGraphMutationLifetime(projectMutationMethods.addCharacterNode),
  addMoodboardNode: withGraphMutationLifetime(projectMutationMethods.addMoodboardNode),
  authorGenerationCluster: withGraphMutationLifetime(projectMutationMethods.authorGenerationCluster),
  fetchReplicateSchemaAndConfigure: withGraphMutationLifetime(projectMutationMethods.fetchReplicateSchemaAndConfigure),
  configureOpenRouterModel: withGraphMutationLifetime(projectMutationMethods.configureOpenRouterModel),
  promoteShotVariation: withGraphMutationLifetime(projectMutationMethods.promoteShotVariation),
});

// Removal/wrong-type replacement permanently revokes ownership. Undoing the
// deletion may restore the graph, but cannot restore an old upload request.
useGraphStore.subscribe((state, previous) => {
  if (state.nodes === previous.nodes && state.edges === previous.edges) return;
  useCinemaMotionStore.getState().reconcile(state.nodes, state.edges);
  if (state.nodes === previous.nodes) return;
  // Before authoritative hydration, an empty local graph does not mean a
  // restored interrupted-upload target was deleted from the saved graph.
  useCinemaUploadStore.getState().reconcileTargets(state.nodes,
    new Set(previous.nodes.filter((node) => node.data.definitionId === 'cinema-scene').map((node) => node.id)));
  for (const node of previous.nodes) {
    if (node.data.definitionId === 'cinema-scene'
      && !state.nodes.some((next) => next.id === node.id && next.data.definitionId === 'cinema-scene')) {
      clearCinemaScenePersistence(node.id);
    }
  }
});

// Gallery hydration is read-only: reload/import can match saved scalar outputs
// to the latest owning record without replaying or changing the graph recipe.
let restoringBatchPreviews = false;
useGraphStore.subscribe((state, previous) => {
  if (restoringBatchPreviews || (state.nodes === previous.nodes && state.runHistory === previous.runHistory)
    || !state.runHistory.some((record) => record.batchOutputs)) return;
  const nodes = state.nodes.map((node) => restoreBatchPreview(node, state.runHistory));
  if (nodes.every((node, index) => node === state.nodes[index])) return;
  restoringBatchPreviews = true;
  try { useGraphStore.setState({ nodes }); }
  finally { restoringBatchPreviews = false; }
});

// Source, recipe and edge edits share one freshness path, including graphSync,
// undo and reload. This subscriber changes attribution only; it never executes.
let reconcilingPaperFreshness = false;
useGraphStore.subscribe((state, previous) => {
  if (reconcilingPaperFreshness
    || (state.nodes === previous.nodes && state.edges === previous.edges && state.runHistory === previous.runHistory)) return;
  if (!state.runHistory.some((record) => record.paperInputs?.length)
    && !state.nodes.some((node) => node.data.outputFreshness)) return;
  const current = captureRunSnapshot(state.nodes, state.edges);
  let historyChanged = false;
  const runHistory = state.runHistory.map((record) => {
    if (!record.paperInputs?.length) return record;
    const reasons = paperRunOutOfDateReasons(record, current);
    if (JSON.stringify(reasons) === JSON.stringify(record.outOfDateReasons ?? [])) return record;
    historyChanged = true;
    return { ...record, outOfDateReasons: reasons };
  });
  let nodesChanged = false;
  const nodes = state.nodes.map((node) => {
    let attribution = node.data.outputFreshness;
    if (!attribution && node.data.definitionId !== 'paper-source' && Object.keys(node.data.outputs).length) {
      const saved = runHistory.find((record) => record.paperInputs?.length
        && paperInputsForSnapshot(record.snapshot, node.id).length > 0
        && JSON.stringify(record.resultOutputs?.[node.id]) === JSON.stringify(node.data.outputs));
      if (saved) {
        attribution = {
          runId: saved.id,
          recipeRevision: paperRecipeRevision(saved.snapshot, node.id),
          paperInputs: paperInputsForSnapshot(saved.snapshot, node.id),
          outOfDateReasons: [],
        };
      }
    }
    if (!attribution) return node;
    const record = runHistory.find((candidate) => candidate.id === attribution.runId);
    const reasons = record
      ? paperRunOutOfDateReasons(record, current, node.id)
      : paperInputOutOfDateReasons(attribution.paperInputs, current);
    if (node.data.outputFreshness && JSON.stringify(reasons) === JSON.stringify(attribution.outOfDateReasons)) return node;
    nodesChanged = true;
    return { ...node, data: { ...node.data, outputFreshness: { ...attribution, outOfDateReasons: reasons } } };
  });
  if (!historyChanged && !nodesChanged) return;
  reconcilingPaperFreshness = true;
  try {
    if (historyChanged) persistRunHistory(runHistory);
    useGraphStore.setState({ ...(historyChanged ? { runHistory } : {}), ...(nodesChanged ? { nodes } : {}) });
  } finally {
    reconcilingPaperFreshness = false;
  }
});

// Dev-only window bridge so scripted UI capture (the nebula-nodes-visuals
// skill's capture template) can call clearGraph() between runs.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __nebulaGraphStore?: typeof useGraphStore }).__nebulaGraphStore = useGraphStore;
}
