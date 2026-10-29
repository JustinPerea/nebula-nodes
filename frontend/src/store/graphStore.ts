import { create, type StateCreator } from 'zustand';
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
  sameRecipeParams,
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
  getSettings as apiGetSettings,
  ExecutionStartRejectedError,
  RUN_SAFEGUARDS_REASON,
  type ExecutionValidationError,
  type ExecutionStatusResult,
  type ExecutionCancellationResult,
  type OpenRouterModel,
} from '../lib/api';
import {
  apiFetch,
  getCachedBackendBaseUrl,
  rewriteBackendAssetUrls,
  rewriteExecutionAssetUrls,
} from '../lib/backend';
import {
  isBackendOffline, isOfflineRefusal, noteBackendBootId, OfflineRefusal, refuseEditWhileOffline, requestHealthProbe,
  subscribeBackendConnection, subscribeBackendRestart,
} from '../lib/backendConnection';
import { AGENT_CURSOR_SPRING, isAtRest, stepSpring, type SpringState } from '../lib/agentCursorMotion';
import { noteNodeLabels } from '../lib/lastNodeLabels';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';
import { WORLD_LABS_STATUS_UNCERTAIN_WARNING, cardTitle, deleteRefusalText, heldDeleteText } from '../lib/worldLabsWaiting';
import {
  CONNECTION_LOST_COPY, NEBULA_NOT_ANSWERING_COPY, ConnectionLostError, FailureNotice, REFUSED_FALLBACK_COPY,
  RequestFailedError, copyForAnswer, detailText, failureKind, failureCopy, isBackendUnreachable, failureDetails,
  failureMessage, readRefusal, requestError,
  warnFailure,
} from '../lib/errorCopy';
import { CANVAS_NOTICE_EVENT, showNotice, type CanvasNoticeDetail } from '../lib/canvasNotice';
import { cleanPending, pendingSkipLine, type PendingAgent, type PendingSkipSummary } from '../lib/pendingNodes';
import { MISSING_KEY_FAILURE, MODEL_SETTINGS_FAILURE, MODEL_SETTINGS_FAILURE_HEADER, modelKeyMissingText, modelSettingsFailedText, modelSetupFailedText } from '../lib/failureLines';
import { cleanRemovals, deletedNoticeText, DROPPED_REDO_TEXT, DROPPED_UNDO_TEXT, skippedPressText, lateRestoreText, mergeRemovals, notRestoredText, pinsOnAnotherModel, restoredNoticeText, supersededBy, type RemovalRecord } from '../lib/deleteNotice';
import { NOTHING_RAN_LINE, OTHER_NODE_LINE, SHOT_NOT_STARTED_LINE, validationReadings, writtenReading, type ValidationReading } from '../lib/validationCopy';
import {
  RUNTIME_FIELDS, applySlice, captureOwnAdd, diffCanvas, edgeKey, stableJson, editArrivedText, foldArrange, forgetClearedPlaceholders,
  foreignSource, isForeignEdit, isOwnAdd, isOwnEcho, isSliceStep, ownAddStep, paramChange, renameOwnedNode, restoreRequest,
  undoNoticeText, acceptUndoLine, ownAddIsEmpty, rebaseAcceptedOnRunOutput, sameValue, type ChangeSource,
  type KeptAfterAccept, type EditOrigin, type ForeignEdit, type GraphSlice, type OwnAdd, type OwnParamChange, type RestoreBody,
} from '../lib/canvasUndo';
import { TAB_ID } from '../lib/tabId';
import { notifyJobComplete } from '../lib/jobNotifications';
import { useUIStore } from './uiStore';
import { usePricingStore } from './pricingStore';
import { useInputSizeStore } from './inputSizeStore';
import { useStoredAssetsStore } from './storedAssetsStore';
import { nodesThatRun, repeatRun, runCostConfirmMessage, shouldConfirmRunCost, summarizeRunScope, type RunScope, type RunScopeSummary } from '../lib/runScope';
import { PRICE_DEPENDS_ON_INPUT, PRICE_NOT_LISTED, mayBeRefused, mergeRunEstimates, movedRowIds, modelNotChosenText, planDecidesRefusal, placeholderRefusalOf, placeholderRunConfirm, runPlaceholders, withRefusalFlags, withRunEstimate, type PlaceholderRunConfirm, type PlaceholderRunOptions, type RunEstimate } from '../lib/placeholderRunConfirm';
import { placeholderRunDialogModule } from '../lib/placeholderRunDialogModule';
import { useCreateDraftStore } from './createDraftStore';
import { getCinemaUploadIssue, useCinemaUploadStore } from './cinemaUploadStore';
import { cinemaMotionSource, cinemaMotionTarget, useCinemaMotionStore } from './cinemaMotionStore';
import { getKreaConnection, nodeKeyStatus, normalizeKreaMode, withNewKreaMode } from '../lib/kreaConnection';
import { allParamDefinitions, canvasTitle, envKeyNames, nodeTitle } from '../lib/directRoute';
import { clipSpeed, type EditClip } from '../lib/editor/virtualPlayback';
import type { KeyframeData, VideoGraphManifest, TrackItem } from '../types/video';
import { createEmptyManifest, DEFAULT_FPS } from '../types/video';
import { validateManifest } from '../lib/video/manifestValidator';
import { componentTypeToCanvasDefId, pruneTrackItemsForDeletedNode } from '../lib/video/mirroring';
import { isPortCompatible } from '../lib/portCompatibility';
import { STALE_CANVAS_DETAIL, adoptCanvasRevision, getProjectContext, type ProjectContext } from '../lib/projectContext';
import { agentClearedLine, changesNotSavedLine, changesSavedAsCopyLine, distinctSaves, handoffFailedLine, savingCutOffLine,
  settingsOnOneNode, type CutOffEnding, type CutOffSave } from '../lib/savingCutOff';
import { deleteNoAnswerLine, deleteServerErrorLine } from '../lib/deleteCopy';
import { followingReason, followingSwitch, refuseEditWhileFollowing, runWhileFollowingLine } from '../lib/canvasFollow';
import { isCanvasKept, keptCanvasTakesTyping, pulseKeptCanvas, setCanvasKept } from '../lib/keptCanvas';
import { noteCanvasReplaced } from '../lib/canvasReplaced';
import { boundingRect, findOpenGroupOffset, UNMEASURED_NODE_SIZE, type NodeRect } from '../lib/nodePlacement';
import { withParamDefaults } from '../lib/paramDefaults';
import { replaceChanged, shareUnchanged } from '../lib/structuralShare';
import { notePersonInput } from '../lib/personInput';

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

/** `failure`, when given, is the refused start's error: a person-only
 * refusal (GM, Q116 a) shows GM's line as the card's person line, with the
 * backend's own words, written for agents, behind the card's Details toggle
 * (NodeError: `person` over `raw`, `providerText`). */
function markNodesErrored(
  nodes: Node<NodeData>[],
  nodeIds: Set<string>,
  message: string,
  failure?: unknown,
): Node<NodeData>[] {
  const hidden = failure === undefined ? null : failureDetails(failure);
  return nodes.map((node) => {
    if (!nodeIds.has(node.id)) return node;
    return {
      ...node,
      data: {
        ...node.data,
        state: 'error' as const,
        error: hidden ?? message,
        // A line Nebula wrote (a refused start): no older run's reading beside it.
        errorCategory: undefined,
        errorFriendly: undefined,
        errorPerson: hidden ? failureCopy(failure).reason : undefined,
        errorProviderText: hidden ? true : undefined,
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

type UndoEntry = UndoSnapshot | ForeignEdit | OwnAdd;

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
  /** GM, round 20: "Open copy" beside the failed handoff's line. */
  copy?: NoticeCopy;
  /** A part of `text` shown in mono (a model id, GM round 15 of PR #114). */
  mono?: string;
}

/** The project a line's "Open copy" opens (the copy a failed handoff saved). */
export interface NoticeCopy { projectId: string }

let undoNoticeSeq = 0;

/**
 * A restore's count that arrived after the person moved on (GM - Design,
 * 2026-10-23, round 3: "show it as a plain notice with no button, using the
 * standard timeout"). Its own line in its own slot right above the canvas
 * notice (lib/noticeSlots.ts 'late'; round 4: "put the late line above the
 * newer one, so the notice with a button stays nearest the bar"), never the canvas
 * notice itself, so it never replaces the newer notice, and it has no Undo or
 * Redo: the store's rule for offers (withLiveNotice) never reads it. Two late
 * counts while one shows add up on the one line.
 */
export interface LateNotice {
  id: number;
  text: string;
  notReopened: number;
  notReattached: number;
}

let lateNoticeSeq = 0;

/**
 * Review 7, L3: a written line (graphStore.notify: a failure, "Nothing ran.
 * Another run started first. …") that arrives while the canvas notice offers
 * an Undo or Redo ("Codex changed the canvas · Undo") never replaces it: the
 * Undo is the person's way back from an agent's edit. It shows on its own
 * line in its own slot above the canvas notice (lib/noticeSlots.ts
 * 'message'), as GM - Design ruled for the late count (round 4: "put the late
 * line above the newer one, so the notice with a button stays nearest the
 * bar"), with the same hold, Dismiss and tone. Not an offer: the stacks never
 * clear it.
 */
export interface MessageNotice {
  id: number;
  text: string;
  tone: 'error' | 'info';
  copy?: NoticeCopy;
  /** As UndoNotice's: a part of `text` shown in mono. */
  mono?: string;
}

/** Whether a notice's Undo or Redo still applies: its step is next in line on its stack. */
function offerApplies(notice: UndoNotice, stacks: { undoStack: UndoEntry[]; redoStack: UndoEntry[] }): boolean {
  if (!notice.offer || !notice.entry) return true;
  const stack = notice.offer === 'undo' ? stacks.undoStack : stacks.redoStack;
  return stack[stack.length - 1] === notice.entry;
}

/**
 * GM - Design, 2026-10-23: "a notice whose button no longer applies clears
 * when a new undo step lands." A notice with an offer shows only while its
 * step is the top of its stack (undoStack for Undo, redoStack for Redo). Every
 * write to the store goes through here (the store's own `set` and
 * `useGraphStore.setState` alike), so every writer of either stack keeps it:
 * pushUndo and its callers, an agent's edit, a step taken or put back, a
 * graph cleared, replaced or opened. When an update leaves the notice's step
 * off the top, the notice clears in that same update. A notice without an
 * offer (an error, a refusal, an import's notes) is never touched.
 */
function withLiveNotice(state: GraphState, patch: GraphState | Partial<GraphState>): GraphState | Partial<GraphState> {
  if (!('undoStack' in patch) && !('redoStack' in patch) && !('undoNotice' in patch)) return patch;
  const notice = 'undoNotice' in patch ? patch.undoNotice : state.undoNotice;
  if (!notice) return patch;
  const stacks = {
    undoStack: patch.undoStack ?? state.undoStack,
    redoStack: patch.redoStack ?? state.redoStack,
  };
  return offerApplies(notice, stacks) ? patch : { ...patch, undoNotice: null };
}

/** The store's middleware for that rule (withLiveNotice). */
function noticeFollowsStacks(config: StateCreator<GraphState>): StateCreator<GraphState> {
  return (set, get, api) => {
    const guarded = ((partial: GraphState | Partial<GraphState> | ((state: GraphState) => GraphState | Partial<GraphState>),
      replace?: boolean) => {
      set((state) => withLiveNotice(state, typeof partial === 'function' ? partial(state) : partial) as GraphState,
        replace as false);
    }) as typeof set;
    api.setState = guarded;
    return config(guarded, get, api);
  };
}

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
  // Only the person's own actions take a step here (an agent's edit arriving
  // is stacked by editArrived): their first own edit (GM r13 on PR #199, 1).
  notePersonInput();
  return snapshot;
}

/** One of the person's own adds: a step that owns exactly `nodeIds` (round
 * 14 of PR #114; lib/canvasUndo.ts OwnAdd). Pushed when the add's ids are
 * known; a later step depends on nothing it holds, so it may land above
 * steps taken while the add was out. */
function pushOwnAdd(set: GraphSet, get: GraphGet, nodeIds: Iterable<string>,
  params: OwnParamChange[] = [], accepted?: Node<NodeData>[]): OwnAdd | null {
  const step = ownAddStep(nodeIds, params, accepted);
  if (step.nodeIds.length === 0 && !step.params) return null;
  breakUndoDebounce();
  const undoStack = [...get().undoStack, step];
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  set({ undoStack, redoStack: [] });
  notePersonInput();
  return step;
}

/** An add that failed: its step leaves the stack wherever it sits (it owns
 * only what that add made, so nothing above depends on it). */
function dropOwnAdd(set: GraphSet, step: OwnAdd | null): void {
  if (!step) return;
  set((state) => (state.undoStack.includes(step) ? { undoStack: state.undoStack.filter((entry) => entry !== step) } : {}));
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
/** The line under Run when it skipped agents' placeholders (Q125 item 3, GM's copy). */
function announcePendingSkips(result: object): void {
  const line = pendingSkipLine((result as { pendingSkipped?: PendingSkipSummary | null }).pendingSkipped);
  if (line) showNotice(line, 'info');
}

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
  if (err.status === 507 && err.reason === RUN_SAFEGUARDS_REASON) noteRunSafeguardsRefusal(runId);
}

/** GM's locked 507 line (round 16 of PR #114): "Couldn't run “<node>”.
 * Nebula couldn't save its run safeguards, so nothing was started. Restart
 * Nebula, then try again." It lasts until a restart, so it is said where the
 * person looks, besides each card's own line. A run with no single node
 * (the bottom Run) keeps its own heading. */
function noteRunSafeguardsRefusal(runId: string): void {
  const state = useGraphStore.getState();
  const target = state.runHistory.find((record) => record.id === runId)?.targetNodeId;
  const label = target ? cardTitle(state.nodes, target) : null;
  state.notify(`${label ? `Couldn't run \u201c${label}\u201d.` : "Couldn't start the run."} ${RUN_SAFEGUARDS_REASON}`);
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

/** The canvas a run started on (round 11 of PR #114): the open project, its
 * load, and the replacement count every graph replacement bumps (a switch,
 * an import, Load graph). A start that fails after the graph was replaced
 * marks nothing: the new graph's nodes only share its node ids. */
interface RunCanvas { projectId: string | null; load: number; replacement: number }
const runCanvases = new Map<string, RunCanvas>();

function canvasNow(): RunCanvas {
  return { projectId: getProjectContext()?.id ?? null, load: canvasLoad, replacement: canvasReplacementRevision };
}

/** Whether the graph is still the one run `runId` started on. */
function runOnItsCanvas(runId: string): boolean {
  const started = runCanvases.get(runId);
  if (!started) return false;
  const now = canvasNow();
  return started.projectId === now.projectId && started.load === now.load && started.replacement === now.replacement;
}

/** The graph was replaced: no run is this canvas's current run any more, and
 * other runs' node marks named the old graph's nodes. A run still starting
 * keeps its owner, so its answer still ends it (runOnItsCanvas). */
function forgetRunsOfReplacedGraph(): void {
  currentRunId = null;
  foreignRunNodes.clear();
}

function registerRun(runId: string, snapshot: RunGraphSnapshot, targetNodeId?: string, shotId?: string): void {
  if (targetNodeId && shotId) settledCinemaRuns.delete(`${targetNodeId}\u0000${shotId}`);
  runCanvases.set(runId, canvasNow());
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

/** Whether a running or starting run holds nodes the shot `shotId` of the
 * scene `nodeId` would run (its own shot, or nodes they share). */
function shotOverlapsActiveRun(nodes: Node<NodeData>[], edges: Edge[], nodeId: string, shotId: string): boolean {
  const snapshot = captureRunSnapshot(nodes, edges);
  const scope = snapshotExecutionScopeIds(snapshot, nodeId);
  const shareableInputs = new Set(snapshot.nodes.filter((node) => STATIC_INPUT_IDS.has(node.definitionId)).map((node) => node.id));
  return scopeOverlaps(scope, { nodeId, shotId, shareableInputs });
}

function closeTrackedRun(set: GraphSet, runId: string, patch: Parameters<typeof closeRunRecord>[2]): void {
  const owner = activeRunOwners.get(runId);
  if (!owner) return;
  if (owner.nodeId && owner.shotId && patch.status !== 'running') {
    settledCinemaRuns.set(`${owner.nodeId}\u0000${owner.shotId}`, patch.status);
    if (settledCinemaRuns.size > 1000) settledCinemaRuns.delete(settledCinemaRuns.keys().next().value!);
  }
  activeRunOwners.delete(runId);
  runCanvases.delete(runId);
  terminalRunIds.add(runId);
  if (terminalRunIds.size > 1000) terminalRunIds.delete(terminalRunIds.values().next().value!);
  if (currentRunId === runId) currentRunId = null;
  pendingStartRunIds.delete(runId);
  cancellationRequestedRunIds.delete(runId);
  stopFailureNoted.delete(runId);
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
  /** A run is waiting (at most RUN_INPUTS_WAIT_MS) for what its refusal
   * reads before it asks or starts (review 15, M-B): it counts as starting,
   * so the Run controls show their disabled state and a second Run does
   * nothing, as during a run. */
  runStarting: boolean;
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
   * (an upload that adds a node, accepting a proposal, a clear): the canvas
   * before it. Pass the step to cancelUndoStep if the request fails, and to
   * endUndoStep once it answered and its change is on the canvas: until
   * then an undo waits for it (review 10, L-2). */
  beginUndoStep: (options?: { clear?: boolean }) => object;
  cancelUndoStep: (step: object) => void;
  /** The request of a beginUndoStep step answered: an undo pressed meanwhile
   * now undoes it, if nothing newer landed on top (review 11, M-1).
   * `arrives`: the nodes the change adds that come with its echo (an
   * upload's): the step settles once they are on the canvas (L-2). */
  endUndoStep: (step: object, options?: { arrives?: string[] }) => void;
  /** An add made outside the store (a file drop) landed: one undo step that
   * owns exactly these node ids (round 14 of PR #114). */
  noteOwnAdd: (nodeIds: string[]) => void;
  /** The notice for someone else's edit: it landed, or was undone or redone. */
  undoNotice: UndoNotice | null;
  dismissUndoNotice: () => void;
  /** A restore's late count, shown above the canvas notice (LateNotice). */
  lateNotice: LateNotice | null;
  dismissLateNotice: () => void;
  /** A written line that arrived while the canvas notice offers Undo or Redo
   * (MessageNotice): shown above it, so the offer stays. */
  messageNotice: MessageNotice | null;
  dismissMessageNotice: () => void;
  /** Show a written line as the canvas notice, non-blocking and dismissable,
   * where a native alert used to stop the canvas (round 3f). 'error' by
   * default; 'info' for a note such as an import's warnings. While the canvas
   * notice offers an Undo or Redo (an agent's edit), the line shows above it
   * instead of replacing it (review 7, L3). `mono`: a part of the line shown
   * in mono (a model id, GM round 15 of PR #114). An empty line says nothing
   * (a write refused while offline). */
  notify: (text: string, tone?: 'error' | 'info', options?: { mono?: string }) => void;

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
  /** The canvas's Delete and Backspace: the selected nodes and wires, one
   * undo step that puts back the nodes and every wire together (review 9, L-4). */
  deleteCanvasElements: (nodeIds: string[], edgeIds: string[]) => void;
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
  /** `verb: 'Generate'`: Cinema's Generate all, so the placeholder dialog's
   * button says Generate (GM - Design, round 6, item 3). */
  executeNode: (nodeId: string, options?: { approvalId?: string; verb?: 'Run' | 'Generate' }) => Promise<void>;
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
  /** A project replacement never cancels a paid run or drops unresolved authoring.
   *  `exceptSaves`: graph writes on their way don't count (a switch drains them first, round 19). */
  canSwitchProject: (options?: { exceptSaves?: boolean }) => boolean;
  /** Round 19 (GM): a switch or an import starts. Graph writes made from now
   *  wait (finishCanvasReplacement lets them go); those made before are
   *  sent and waited for, 15 s at most. The saves that failed or didn't
   *  answer in time, for GM's line. */
  drainGraphWrites: (kind: 'switch' | 'import') => Promise<CutOffSave[]>;
  /** Round 19: an agent switched projects (Nebula already has). Graph
   *  writes wait from now; an undo still on its way is dropped and its
   *  change taken back off the canvas (the person never saw it land). The
   *  saves still on their way, for the handoff's line; `force`: the
   *  handoff must be sent even when the canvas matches what was last saved
   *  (a write or an undo Nebula may not have, so its switch saved without it). */
  beginAgentSwitch: () => { cutOff: CutOffSave[]; force: boolean; pending: HandoffPending };
  /** The switch or import is done (`report`: the canvas now shown is the new
   *  one, with GM's line when `show`), or didn't happen (null). The writes
   *  that waited go now, under their own admission. `copy`: the copy a
   *  failed handoff saved the person's edits to (GM, round 20). */
  finishCanvasReplacement: (report: { kind: 'switch' | 'import' | 'agent'; agent?: string | null; project: string;
    cutOff: CutOffSave[]; show: boolean; copy?: { id: string; name: string } | null; byAgent?: boolean } | null) => void;
  /** Round 20: a node's title field holds a name the person hasn't saved
   *  (NodeLabel), or no longer does (null). */
  noteRenameDraft: (nodeId: string, draft: string | null) => void;
  /** The open project's name, for GM's line after an agent's import. */
  setCanvasProjectName: (read: () => string | null) => void;
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
  /** The chat's /clear answered: the backend's nodes and their wires leave the
   * canvas (nodes only this tab has stay, as its graphSync has it), under
   * the step beginUndoStep made before the request (review 10, L-2). */
  clearBackendNodes: (options: { undoStep: object }) => void;
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

/** A model picker's failed request (review 12, L-4): `settings` when reading
 * the provider's settings for the model is what failed (the backend marks
 * that answer: MODEL_SETTINGS_FAILURE_HEADER). */
class UniversalModelError extends Error {
  /** The backend's failure kind (MODEL_SETTINGS_FAILURE_HEADER), or null. */
  readonly kind: string | null;
  constructor(message: string, kind: string | null) {
    super(message);
    this.kind = kind;
  }
}

async function universalModelError(response: Response): Promise<UniversalModelError> {
  return new UniversalModelError(await backendDetail(response), response.headers.get(MODEL_SETTINGS_FAILURE_HEADER));
}

/** GM - Design's line for a model picker that failed (round 13), naming the
 * node as its card does: a failed read of the provider's settings, or a
 * missing key named (review 13, L-5), else "Couldn't set up “X”.". */
function modelPickerFailure(err: unknown, name: string, definitionId: string): string {
  const kind = err instanceof UniversalModelError ? err.kind : null;
  if (kind === MODEL_SETTINGS_FAILURE) return modelSettingsFailedText(name);
  if (kind === MISSING_KEY_FAILURE) {
    const definition = NODE_DEFINITIONS[definitionId];
    return modelKeyMissingText(name, definition ? envKeyNames(definition) : []);
  }
  return modelSetupFailedText(name);
}

/** A model picker's failure: the provider's settings couldn't be read, or
 * its key is missing (#195's GM lines, item 3 rounds 13 and 15); anything
 * else is the failed model change (#114's GM line, channel round 14). */
function reportModelPickerFailure(err: unknown, nodeId: string, name: string, still: string, definitionId: string): void {
  const kind = err instanceof UniversalModelError ? err.kind : null;
  if (kind === MODEL_SETTINGS_FAILURE || kind === MISSING_KEY_FAILURE) {
    useGraphStore.getState().notify(modelPickerFailure(err, name, definitionId));
    return;
  }
  reportModelChangeFailed(nodeId, still);
}

/** The node's name as its card shows it. */
function cardName(node: Node<NodeData> | undefined, fallback: string): string {
  const definition = NODE_DEFINITIONS[node?.data.definitionId ?? ''];
  return (definition ? nodeTitle(definition, node?.data.label) : node?.data.label) || fallback;
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
      if (!response.ok) throw await universalModelError(response);
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
  if (!response.ok) throw await universalModelError(response);
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

/** The model the backend has configured a universal node for, read before
 * a model change is sent (review 14, L3): the model its ports are stamped
 * with (`_model_ports.model`, backend services/universal_ports.py). Without
 * a stamp, OpenRouter's and Nous's model param (their picker changes it only
 * once the backend answers); a Replicate node's Model ID field holds what
 * the person typed, so without a stamp there is no model to name. */
function configuredModel(node: Node<NodeData> | undefined): string {
  if (!node) return '';
  const stamp = (node.data.params._model_ports as { model?: unknown } | undefined)?.model;
  if (typeof stamp === 'string' && stamp.trim()) return stamp.trim();
  if (node.data.definitionId === 'replicate-universal') return '';
  const param = node.data.params[UNIVERSAL_MODEL_PARAM[node.data.definitionId] ?? 'model'];
  return typeof param === 'string' ? param.trim() : '';
}

/** Create's heading and its cluster line (GM, round 3f and round 15 of PR
 * #114): "Couldn't start the generation. Its nodes weren't added to the
 * canvas." then the backend's reason where it gave a person line (a World
 * Labs state, a run, an access refusal), the connection line when Nebula
 * didn't answer, and "Try again." for a bare HTTP failure. */
export const GENERATE_HEADING = "Couldn't start the generation.";
export const CLUSTER_NOT_ADDED = "Its nodes weren't added to the canvas.";
export function clusterFailureReason(error: unknown): string {
  // GM, round 16: the unified line wherever #114 owns it.
  if (error instanceof ConnectionLostError) return NEBULA_NOT_ANSWERING_COPY;
  if (error instanceof RequestFailedError && failureKind(error.status) === 'refused'
    && (detailText(error.detail) || error.code)) return error.reason;
  return 'Try again.';
}

/** A model change that didn't happen: GM's line (round 14 of PR #114) with
 * the model the node is still on, read before the request (`still`). GM,
 * round 15: the line shows what the model picker shows. The picker's own
 * label for it isn't kept outside the Inspector, and the card's badge shows
 * the id, so it is the id, in mono. The reason stays in the console. */
function reportModelChangeFailed(nodeId: string, still: string): void {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  useGraphStore.getState().notify(modelChangeFailedLine(node.data.label, still), 'error',
    still ? { mono: still } : undefined);
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
 *
 * Review 16, L-3 (round 17): a write Nebula took (its PUT answered OK) is
 * kept too until a sync shows it (`sent`: the values that write carried).
 * Nebula sends the write's own echo before it answers, but a sync it sent
 * earlier (a run's outputs, a reconnect's graph) can still reach the tab
 * after the answer. Taking that sync's older value showed the typing undone
 * and left its undo step with nothing to change, so it was dropped; the
 * echo then brought the value back with no step to undo it. Nothing was
 * lost in Nebula. If no sync shows the write within PARAM_ECHO_WAIT_MS, the
 * syncs win again. A write that failed is let go at once, as before.
 */
interface UnsavedParamEdit {
  keys: Set<string>;
  inFlight: number;
  /** What the last write carried for each key (stableJson), until a sync shows it. */
  sent?: Map<string, string>;
  /** A sync showed `sent`. */
  echoed?: boolean;
  /** Each key's value from before the person's first unsaved edit of it
   * (stableJson): what a sync sent before the write still shows. */
  before?: Map<string, string>;
  /** The last write's answer is in (review 17, L-1). */
  answered?: boolean;
  /** Lets the edit go if no sync shows it in time. */
  linger?: ReturnType<typeof setTimeout>;
}
const unsavedParamEdits = new Map<string, UnsavedParamEdit>();
const PARAM_ECHO_WAIT_MS = 5_000;

/** For each unsaved key, the value the backend last took (or ABSENT_PARAM):
 * where a failed save puts the field back (round 14 of PR #114, GM: "It's
 * back to its last saved value."). Kept while the key is unsaved. */
const savedParamValues = new Map<string, Map<string, unknown>>();
const ABSENT_PARAM = Symbol('absent');

/**
 * Each param save owns the keys edited since the node's previous save was
 * sent (review 14, L2: a failure named the first unsaved key, which an older
 * save had already sent, and put nothing back while an older save was out).
 * Edits are numbered per node (`editGen`); each key remembers the edit that
 * last touched it; each save, the edit number it was sent at, its keys and
 * what it sent. A failed save names its own keys and puts back only those no
 * later edit touched: to the value an older save still on its way sent (that
 * save owns the key from then on), else to the last saved value.
 */
interface ParamPush { gen: number; keys: string[]; sent: Record<string, unknown> }
const paramEditGen = new Map<string, number>();
const paramKeyGen = new Map<string, Map<string, number>>();
const paramPushesOut = new Map<string, ParamPush[]>();
const lastPushGen = new Map<string, number>();

function forgetParamPushes(nodeId: string): void {
  paramEditGen.delete(nodeId);
  paramKeyGen.delete(nodeId);
  paramPushesOut.delete(nodeId);
  lastPushGen.delete(nodeId);
}

function noteParamEdit(nodeId: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key]);
  if (keys.length === 0) return;
  const gen = (paramEditGen.get(nodeId) ?? 0) + 1;
  paramEditGen.set(nodeId, gen);
  const keyGen = paramKeyGen.get(nodeId) ?? new Map<string, number>();
  for (const key of keys) keyGen.set(key, gen);
  paramKeyGen.set(nodeId, keyGen);
  const entry = unsavedParamEdits.get(nodeId) ?? { keys: new Set<string>(), inFlight: 0 };
  entry.before ??= new Map();
  for (const key of keys) {
    if (!entry.keys.has(key)) entry.before.set(key, stableJson(before[key]));
    entry.keys.add(key);
  }
  unsavedParamEdits.set(nodeId, entry);
  const saved = savedParamValues.get(nodeId) ?? new Map<string, unknown>();
  for (const key of keys) if (!saved.has(key)) saved.set(key, key in before ? before[key] : ABSENT_PARAM);
  savedParamValues.set(nodeId, saved);
}

function forgetParamEdit(nodeId: string, entry: UnsavedParamEdit): void {
  if (entry.linger !== undefined) clearTimeout(entry.linger);
  if (unsavedParamEdits.get(nodeId) !== entry) return;
  unsavedParamEdits.delete(nodeId);
  // Its last saved values and its saves' keys go with it (PR #114, round 14).
  savedParamValues.delete(nodeId);
  forgetParamPushes(nodeId);
}

function settleParamEdit(nodeId: string, entry: UnsavedParamEdit, ok: boolean): void {
  if (unsavedParamEdits.get(nodeId) !== entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (entry.inFlight > 0 || paramPushTimers[nodeId] !== undefined) return;
  if (!ok || entry.echoed || !entry.sent) {
    forgetParamEdit(nodeId, entry);
    return;
  }
  // Nebula has it; a sync from before it may still be on its way (L-3).
  entry.answered = true;
  if (entry.linger !== undefined) clearTimeout(entry.linger);
  entry.linger = setTimeout(() => {
    if (entry.inFlight === 0 && paramPushTimers[nodeId] === undefined) forgetParamEdit(nodeId, entry);
  }, PARAM_ECHO_WAIT_MS);
}

/** A sync carries a node's params: if they show what the person's last write
 * sent, Nebula's later syncs are newer than it, and the edit goes once
 * nothing else is waiting. */
function noteParamEcho(nodeId: string, incoming: Record<string, unknown>): void {
  const entry = unsavedParamEdits.get(nodeId);
  if (!entry?.sent || entry.echoed) return;
  const settled = entry.inFlight === 0 && paramPushTimers[nodeId] === undefined;
  if ([...entry.sent].every(([key, value]) => stableJson(incoming[key]) === value)) {
    entry.echoed = true;
    if (settled) forgetParamEdit(nodeId, entry);
    return;
  }
  // Review 17, L-1: Nebula saves its own form of some values (main
  // _coerce_params), so its echo can differ from what was sent and never
  // match. Once the write's answer is in, the first sync that arrives ends
  // the wait, whatever form its value takes, and the canvas shows it: an
  // agent's edit right after isn't masked (L3x). Except a sync still showing
  // the value from before the write (sent before the write reached Nebula,
  // round 17's A11): it changes nothing here.
  if (!settled || !entry.answered) return;
  const stale = [...entry.keys].every((key) => entry.before?.has(key) && stableJson(incoming[key]) === entry.before.get(key));
  if (!stale) forgetParamEdit(nodeId, entry);
}

/** An undo or redo set this node's params (sent with its restore): while an
 * earlier write's echo is still on its way, that echo must not show the
 * value the undo just took back (L-3, A11b). */
function noteRestoredParams(nodeId: string, params: Record<string, unknown>): void {
  const entry = unsavedParamEdits.get(nodeId);
  if (!entry?.sent) return;
  entry.sent = new Map([...entry.keys].map((key) => [key, stableJson(params[key])]));
  entry.echoed = false;
  // Its restore's echo is awaited now, by value (the restore's answer isn't this write's).
  entry.answered = false;
  if (entry.inFlight === 0 && paramPushTimers[nodeId] === undefined) {
    if (entry.linger !== undefined) clearTimeout(entry.linger);
    entry.linger = setTimeout(() => {
      if (entry.inFlight === 0 && paramPushTimers[nodeId] === undefined) forgetParamEdit(nodeId, entry);
    }, PARAM_ECHO_WAIT_MS);
  }
}

/** A param's label as the node's settings show it, else its key. */
function paramLabel(node: Node<NodeData>, key: string): string {
  const dynamic = (node.data as Partial<DynamicNodeData>).dynamicParams?.find((param) => param.key === key)?.label;
  const defined = NODE_DEFINITIONS[node.data.definitionId]?.params.find((param) => param.key === key)?.label;
  return dynamic || defined || key;
}

/** GM round 22 (4a): the Agent log's line for a delete Nebula answered
 * with a server error (the canvas says GM's locked line). */
export function deleteServerErrorLogLine(node: string, nodeId: string, status: number | string): string {
  return `Couldn't delete \u201c${node}\u201d, node ${nodeId}. Nebula returned HTTP ${status}.`;
}
/** GM - Design, rounds 14 and 15 of PR #114: one setting, or several. The
 * second sentence only when every one went back. Round 23 of PR #195 (GM,
 * 2026-10-27): several are counted as every failed-save line counts them
 * (lib/savingCutOff settingsOnOneNode): “a” and “b”; “a”, “b” and “c”; then
 * "4 settings". */
export function paramSaveFailedLine(params: string | string[], node: string, reverted: boolean): string {
  const names = typeof params === 'string' ? [params] : params;
  if (names.length <= 1) {
    return `Couldn't save \u201c${names[0] ?? ''}\u201d for \u201c${node}\u201d.${reverted ? " It's back to its last saved value." : ''}`;
  }
  return `Couldn't save ${settingsOnOneNode(names)} for \u201c${node}\u201d.${reverted ? " They're back to their last saved values." : ''}`;
}
export function modelChangeFailedLine(node: string, currentModel: string): string {
  return `Couldn't change the model for \u201c${node}\u201d.${currentModel ? ` It's still on ${currentModel}.` : ''}`;
}

/** A param save the backend didn't take (no answer, or a refusal): its own
 * keys go back (ParamPush) and the person reads GM's line naming them. A key
 * a later edit touched keeps that edit's value (it decides), and then the
 * second sentence goes (GM). */
function paramSaveFailed(nodeId: string, push: ParamPush): void {
  const pushes = paramPushesOut.get(nodeId);
  if (pushes) paramPushesOut.set(nodeId, pushes.filter((entry) => entry !== push));
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  const saved = savedParamValues.get(nodeId);
  if (!node || !saved || push.keys.length === 0) return;
  const keyGen = paramKeyGen.get(nodeId);
  const params = { ...node.data.params };
  let reverted = 0;
  for (const key of push.keys) {
    if ((keyGen?.get(key) ?? 0) > push.gen) continue;
    // An older save still on its way sent this key: its value, and the key
    // is its. Saves carry only the keys they change (round 21: #195's M-C),
    // so only an older save that carried the key owns it.
    const older = (paramPushesOut.get(nodeId) ?? []).filter((entry) => entry.gen < push.gen && key in entry.sent)
      .sort((a, b) => b.gen - a.gen)[0];
    const previous = older ? older.sent[key]
      : saved.has(key) ? saved.get(key) : (key in push.sent ? push.sent[key] : ABSENT_PARAM);
    if (older) keyGen?.set(key, older.gen);
    if (previous === ABSENT_PARAM) delete params[key];
    else params[key] = previous;
    reverted += 1;
  }
  if (reverted > 0) {
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((candidate) => candidate.id !== nodeId ? candidate : { ...candidate, data: {
        ...candidate.data, params,
        keyStatus: nodeKeyStatus(NODE_DEFINITIONS[candidate.data.definitionId], params, useUIStore.getState().settingsCache),
      } }),
    }));
  }
  useGraphStore.getState().notify(paramSaveFailedLine(push.keys.map((key) => paramLabel(node, key)), node.data.label,
    reverted === push.keys.length));
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
/** Of those, an undo's or redo's restore and the writes waiting behind one
 * (graphMutationFetch). They never hold a project switch (review 17, L-2): a
 * restore that never answers would otherwise refuse every switch under a
 * run's reason. A switch that goes ahead drops the writes still waiting
 * (their admission no longer holds), and Nebula refuses a restore sent with
 * the old revision. */
let restoreBoundMutationCount = 0;

async function trackGraphMutation<T>(operation: () => Promise<T>, options: { restoreBound?: boolean } = {}): Promise<T> {
  pendingGraphMutationCount += 1;
  if (options.restoreBound) restoreBoundMutationCount += 1;
  try { return await operation(); }
  finally {
    pendingGraphMutationCount -= 1;
    if (options.restoreBound) restoreBoundMutationCount -= 1;
  }
}

function withGraphMutationLifetime<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  return (...args: Args): Promise<Result> => trackGraphMutation(() => operation(...args));
}

/**
 * Review 17, H-1: a graph write is admitted when the person acts. What it
 * was made for is read then: the open project (and its workspace revision)
 * and the graph on the canvas (canvasReplacementRevision). A write that
 * waits behind an undo's restore and finds either changed when its turn
 * comes (an agent switched project, so the context went; an import replaced
 * the graph) is never sent: with no revision header Nebula would have let
 * it through into whatever is open now. It is answered as Nebula answers
 * any write to a replaced canvas (STALE_CANVAS_DETAIL, a 409), so every
 * caller treats it as it always treated that refusal. A write that is sent
 * carries the revision read at admission (apiFetch's `project`).
 */
interface WriteAdmission { project: ProjectContext | null; graph: number; seq: number }
/** Admissions in the order made: a switch's gate holds the ones made after it began. */
let admissionSeq = 0;

function admitWrite(): WriteAdmission {
  const project = getProjectContext();
  return { project: project ? { ...project } : null, graph: canvasReplacementRevision, seq: ++admissionSeq };
}

/** Round 21 (review 20, L-5): canvas revisions the tab adopted as the same
 * canvas (a reconnect's sync after Nebula lost its revisions, which says
 * `canvasRevisionRestored: false`), old to new. A write held from before
 * goes out under the adopted one, so Nebula doesn't refuse it while the
 * canvas keeps showing its value. */
const adoptedSameCanvas = new Map<string, string>();

function readmitted(project: ProjectContext | null): ProjectContext | null {
  const canvas = project?.canvas;
  const adopted = canvas !== undefined ? adoptedSameCanvas.get(canvas) : undefined;
  return project && adopted !== undefined ? { ...project, canvas: adopted } : project;
}

function noteSameCanvas(from: string | undefined, to: string): void {
  if (from === undefined || from === to) return;
  for (const [old, now] of adoptedSameCanvas) if (now === from) adoptedSameCanvas.set(old, to);
  adoptedSameCanvas.set(from, to);
}

function stillAdmitted(admission: WriteAdmission): boolean {
  const now = getProjectContext();
  return admission.graph === canvasReplacementRevision
    && (admission.project?.id ?? null) === (now?.id ?? null)
    && (admission.project?.revision ?? null) === (now?.revision ?? null);
}

function staleCanvasAnswer(): Response {
  return new Response(JSON.stringify({ detail: STALE_CANVAS_DETAIL }),
    { status: 409, headers: { 'Content-Type': 'application/json' } });
}

/** The node a write to one node's params or name is for (GM r18, item 2,
 * option (c): "queued writes to it (person's or agent's) are dropped when
 * the delete lands"). Such a write that waited, and whose node is no longer
 * on the canvas when its turn comes (its delete landed, an agent deleted it,
 * a refused undo took it back off), is dropped: Nebula would answer 404. */
function nodeWriteTarget(path: string, init?: RequestInit): string | null {
  if (String(init?.method ?? 'GET').toUpperCase() !== 'PUT') return null;
  const match = /^\/api\/graph\/node\/(n\d+)(?:\/label)?$/.exec(path);
  return match ? match[1] : null;
}

function droppedWriteAnswer(): Response {
  return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
}

/** A restore that hasn't answered within the hold limit (review 17, L-2). */
class RestoreTimeout extends Error {}

// ---------------------------------------------------------------------------
// Round 19 (GM - Design, review 18 G-1, H-B): a project switch or an import
// waits for the saves on their way. "When the switch or import starts, new
// graph writes are blocked right away. Writes already admitted or queued
// drain first, up to the same 15 s limit undo uses. [...] If a save fails or
// times out, the switch still happens, and the new canvas shows one of
// these (replacing the "out of date" line)". Drained writes keep their own
// admission: they never land in the new project.
// ---------------------------------------------------------------------------

/** A write from its admission to its answer. `save`: what it saves, as the
 * line names it (read at admission, while its node is on the canvas). */
interface TrackedWrite { graph: number; seq: number; restore: boolean; saves: CutOffSave[]; counted: boolean }
const liveWrites = new Set<TrackedWrite>();

/** New writes wait here while a switch or an import drains (writeGate). */
interface WriteGate { fromSeq: number; opened: Promise<void>; open: () => void }
let writeGate: WriteGate | null = null;

/** A drain under way: the writes it waits for, and those that didn't make
 * it. Review 19, L4: each drain keeps its own (Open pressed while Load graph
 * drains, or the reverse), so a save that landed is never named as cut off
 * by the first because the second took the slot. */
interface Drain { watching: Set<TrackedWrite>; cutOff: TrackedWrite[]; changed: () => void }
const drains = new Set<Drain>();

/** The line about saves a replacement cut off: for the canvas now shown. */
interface ReplacementReport { graph: number; project: string | null; ending: CutOffEnding | null; saves: CutOffSave[]; noticeId: number | null }
let replacementReport: ReplacementReport | null = null;
/** The open project's name, for that line (projectStore registers it). */
let canvasProjectName: () => string | null = () => null;

/** What a write saves, as GM's lines name it: one entry per setting it
 * carries (round 20: the agent-clear and handoff lines count settings), or
 * one unnamed entry for a write that saves nothing in particular ("your last
 * change"). A key with no label is never shown raw (GM, round 16): unnamed. */
function describeSaves(path: string, init?: RequestInit): CutOffSave[] {
  const match = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
  if (!match || String(init?.method ?? 'GET').toUpperCase() !== 'PUT') return [{ node: null, setting: null }];
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === match[1]);
  if (!node) return [{ nodeId: match[1], node: null, setting: null }];
  const definition = NODE_DEFINITIONS[node.data.definitionId];
  const title = nodeTitle(definition, node.data.label) || null;
  let keys: string[] = [];
  try { keys = Object.keys((JSON.parse(String(init?.body ?? '{}')) as { params?: object }).params ?? {}); } catch { keys = []; }
  if (keys.length === 0) return [{ nodeId: node.id, node: title, setting: null }];
  return keys.map((key) => {
    const param = (definition ? allParamDefinitions(definition) : []).find((candidate) => candidate.key === key)
      ?? (node.data.dynamicParams as Array<{ key: string; label?: string }> | undefined)?.find((candidate) => candidate.key === key);
    return { nodeId: node.id, node: title, setting: param?.label || null };
  });
}

/** A rename: "Name" (GM, round 20), for the node as its card showed it before. */
function renameSave(node: Node<NodeData>, previous: string | undefined): CutOffSave[] {
  const title = nodeTitle(NODE_DEFINITIONS[node.data.definitionId], previous ?? node.data.label) || null;
  return [{ nodeId: node.id, node: title, setting: 'Name' }];
}

function settleTracked(write: TrackedWrite, ok: boolean): void {
  liveWrites.delete(write);
  if (write.graph !== canvasReplacementRevision) lastCutOffAt = Date.now();
  for (const drain of drains) {
    if (!drain.watching.has(write)) continue;
    drain.watching.delete(write);
    if (!ok) { drain.cutOff.push(write); write.counted = true; }
    drain.changed();
  }
}

/** A write made for a canvas that was replaced since (a switch, an import,
 * a clear) didn't land: GM's line names it, once, instead of the canvas's
 * out-of-date line. A restore says its own (sendRestore). */
function noteCutOff(write: TrackedWrite): void {
  if (write.counted || write.restore) return;
  write.counted = true;
  const report = replacementReport;
  if (!report || report.graph !== canvasReplacementRevision) return;
  report.saves.push(...write.saves);
  showReplacementReport();
}

function showReplacementReport(): void {
  const report = replacementReport;
  if (!report?.ending || report.saves.length === 0 || clearReportWaiting) return;
  const ending = report.ending;
  const saves = distinctSaves(report.saves);
  let text: string | null;
  let copy: NoticeCopy | undefined;
  if (ending.kind === 'agentClear') {
    text = agentClearedLine(saves, ending.agent);
  } else if (ending.kind === 'reconnect') {
    // GM round 23: with the copy its edits were saved to, no agent named.
    text = ending.copy ? changesSavedAsCopyLine(saves, ending.copy.name) : changesNotSavedLine(saves);
    if (ending.copy) copy = { projectId: ending.copy.id };
  } else if (ending.kind === 'agent' && ending.copy && ending.byAgent === false) {
    // A switch with no agent behind it (GM round 23): no "when … switched".
    text = changesSavedAsCopyLine(saves, ending.copy.name);
    copy = { projectId: ending.copy.id };
  } else if (!report.project) {
    text = null;
  } else if (ending.kind === 'agent' && ending.copy) {
    // GM (round 20, follow-up 2): one line naming the copy, with Open copy.
    text = handoffFailedLine(saves, report.project, ending.agent, ending.copy.name);
    copy = { projectId: ending.copy.id };
  } else {
    text = savingCutOffLine(saves, report.project, ending);
  }
  if (!text) return;
  const line = text;
  useGraphStore.setState((state) => {
    // The line already shown for this replacement is updated in place.
    if (report.noticeId !== null && state.undoNotice?.id === report.noticeId) {
      return { undoNotice: { ...state.undoNotice, text: line, ...(copy ? { copy } : {}) } };
    }
    if (report.noticeId !== null && state.messageNotice?.id === report.noticeId) {
      return { messageNotice: { ...state.messageNotice, text: line, ...(copy ? { copy } : {}) } };
    }
    // GM round 21: an agent's clear is one toast. Its line takes the place
    // of the sync's "<agent> changed the canvas" and keeps that toast's Undo
    // (which puts the cleared canvas back as last saved).
    if (ending.kind === 'agentClear' && report.noticeId === null && state.undoNotice?.offer === 'undo'
      && state.undoNotice.entry && isForeignEdit(state.undoNotice.entry)) {
      report.noticeId = state.undoNotice.id;
      return { undoNotice: { ...state.undoNotice, text: line } };
    }
    const shown = plainLine(state, line, 'error', copy);
    report.noticeId = (shown.undoNotice ?? shown.messageNotice)?.id ?? null;
    return shown;
  });
}

/** The canvas was replaced (canvasReplacementRevision moved): the line for
 * saves it cut off belongs to this canvas now. `ending` null: say nothing
 * (the person's own clear: the nodes are gone with their changes; an agent's
 * switch whose handoff save carried them; a reconnect's sync). */
function startReplacementReport(ending: CutOffEnding | null, project: string | null, saves: CutOffSave[] = [],
  options: { later?: boolean } = {}): void {
  replacementReport = { graph: canvasReplacementRevision, project, ending, saves: [...saves], noticeId: null };
  // An agent's clear says it once its sync is on the canvas, in the place
  // of the sync's own "<agent> changed the canvas", keeping its Undo (GM
  // round 21: one toast): the sync handler shows it (showClearReport).
  clearReportWaiting = Boolean(options.later);
  if (!clearReportWaiting) showReplacementReport();
}
let clearReportWaiting = false;

/** The sync that carried an agent's clear is on the canvas: its line now. */
function showClearReport(): void {
  if (!clearReportWaiting) return;
  clearReportWaiting = false;
  showReplacementReport();
}

/** Typing still in its debounce (or out) on `nodeId`, as GM's lines name it: one entry per setting. */
function typingSaves(nodeId: string, edits: UnsavedParamEdit): CutOffSave[] {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  const params = node?.data.params as Record<string, unknown> | undefined;
  const keys = [...edits.keys].filter((key) => params && key in params);
  return describeSaves(`/api/graph/node/${nodeId}`, { method: 'PUT',
    body: JSON.stringify({ params: Object.fromEntries(keys.map((key) => [key, null])) }) });
}

/** Typing a replacement found still in its debounce: never sent (the
 * canvas it was for is gone), so GM's line names it. */
const typingLost: CutOffSave[] = [];
function noteTypingLost(): void {
  for (const nodeId of Object.keys(paramPushTimers)) {
    const edits = unsavedParamEdits.get(nodeId);
    if (edits) typingLost.push(...typingSaves(nodeId, edits));
  }
}

/**
 * Round 20 (GM: "A rename draft counts as "Name""): a node's title field
 * open with a name the person typed and hasn't saved (NodeLabel reports it).
 * An agent's clear names it; an agent's switch saves it into the project
 * left (the handoff), as clicking away would have.
 */
const renameDrafts = new Map<string, string>();

/** What the person is editing on the canvas now that nothing has sent yet:
 * typing in its debounce, and rename drafts. Writes on their way, or held
 * behind an undo, are named when Nebula refuses them or the tab drops them
 * (noteCutOff). */
function editingNow(): CutOffSave[] {
  const saves: CutOffSave[] = [];
  for (const nodeId of Object.keys(paramPushTimers)) {
    const edits = unsavedParamEdits.get(nodeId);
    if (edits) saves.push(...typingSaves(nodeId, edits));
  }
  const nodes = useGraphStore.getState().nodes;
  for (const [nodeId, draft] of renameDrafts) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node && draft.trim() !== String(node.data.label ?? '').trim()) saves.push(...renameSave(node, undefined));
  }
  return saves;
}

/** Undos and redos on their way, by admission: how each is dropped (beginAgentSwitch). */
const restoreAbandons = new Map<number, () => void>();

/** A clear emptied the canvas (the person's, an agent's, chat /clear): the
 * held and debounced writes made for its nodes go with them. The person's
 * own clear says nothing. Round 20 (review 19, L2; GM 3 and follow-up 4): an
 * agent's clear (`agentClear`) names what the person was editing, read here
 * while its nodes are still on the canvas, and every write of theirs Nebula
 * then refuses for the old canvas. M3: the old canvas's deletes still on
 * their way, and the typing deferred behind them, are another canvas's: a
 * node that takes one of their ids is never touched by them. Returns the
 * presses held for the old canvas's steps that an agent's clear dropped
 * (the caller announces them once the new canvas is on screen). */
function replaceCanvasByClear(agentClear?: { agent: string | null }, options: { reconnect?: boolean } = {}): DroppedPresses | null {
  // Round 22 (review 21, L-a): saves Nebula refused as out of date before
  // this sync came are this canvas's lost typing too: an agent's clear
  // names them in its line, and a sync with no edit that found another
  // canvas (a restart) names them and the typing still in its debounce in
  // GM's failed-save line. The person's own clear in another window says nothing.
  const parked = takeParkedParamSaves();
  const editing = agentClear || options.reconnect ? [...editingNow(), ...parked] : [];
  // GM round 23: with no agent, what it cuts off is kept as a copy, from the
  // canvas as it is now (before this sync replaces it).
  const keeping = options.reconnect && !agentClear && editing.length > 0 ? keepReplacedCanvas?.() ?? null : null;
  // GM (review 21, G-a): Undo on an agent's clear line puts the canvas back
  // as Nebula last saved it, never with the typing the line says wasn't saved.
  clearedAsSaved = agentClear ? lastSavedView() : null;
  canvasReplacementRevision += 1;
  // Round 23 (review 22, M-1): what still holds an id of this canvas (the
  // note dialog) lets it go.
  noteCanvasReplaced();
  // A run started before it is no longer this canvas's, and its refused
  // start marks nothing on the new n1 (round 12 of PR #114).
  forgetRunsOfReplacedGraph();
  newWriteQueue();
  // Its nodes are gone: nothing an undo or a write holds on the canvas stays.
  nodeWrites.clear();
  wireWrites.clear();
  clearAllParamPushTimers();
  deferredParamPushes.clear();
  deletesInFlight.clear();
  heldCopies.clear();
  renameDrafts.clear();
  labelsInFlight.clear();
  labelsSavedBefore.clear();
  // An agent's clear: undo and redo of the old canvas's steps stop, as an
  // import's do (forgetStepsInFlight). The person's own clear keeps its step.
  const dropped = agentClear ? forgetStepsInFlight() : null;
  startReplacementReport(agentClear ? { kind: 'agentClear', agent: agentClear.agent }
    : options.reconnect ? { kind: 'reconnect' } : null, null, editing,
  { later: Boolean(agentClear) || Boolean(options.reconnect) });
  if (keeping) {
    // The line says where the edits went once the copy is made (in place).
    const report = replacementReport;
    void keeping.then((copy) => {
      if (!copy || replacementReport !== report || report?.ending?.kind !== 'reconnect') return;
      report.ending = { kind: 'reconnect', copy };
      showReplacementReport();
    }, () => {});
  }
  return dropped;
}

/**
 * Round 23 (GM - Design, 2026-10-27): a replacement found with no agent
 * behind it (the reconnect after a gap, a restart that brought another
 * canvas) that cut off the person's edits keeps them: the canvas as the tab
 * held it, typing included, is saved as a recovered copy (a whole project in
 * Projects, as a failed handoff's is), and GM's line names it with Open
 * copy. projectStore registers how (it owns snapshots and copies); null
 * when there is no project to copy from. Read before the canvas changes.
 */
let keepReplacedCanvas: (() => Promise<{ id: string; name: string } | null> | null) | null = null;
export function setReplacedCanvasKeeper(keeper: typeof keepReplacedCanvas): void {
  keepReplacedCanvas = keeper;
}

/** Round 22 (GM, review 21 G-a): each node's params and name as Nebula last
 * saved them, for the nodes whose typing or rename it may not have (unsaved
 * keys put back to their last saved values, a rename on its way to the name
 * before it). Read before a clear forgets them. */
let clearedAsSaved: LastSavedView | null = null;

/**
 * Round 23 (review 22, L-1): a write of the person's on its way (a param
 * save, a rename). The tab learns that Nebula took it only from its answer,
 * which can come after the broadcast of an agent's clear Nebula applied
 * after it. `apply` puts what it carried on a node; `settled` is true once
 * Nebula answered 200, false once it refused it or no answer came.
 */
interface PendingLanding {
  nodeId: string;
  /** Send order: a later write of the same node wins. */
  order: number;
  apply: (node: Node<NodeData>) => Node<NodeData>;
  settled: Promise<boolean>;
}
const landingsOut = new Set<PendingLanding>();
let landingSeq = 0;

/** A write going out: its landing, and the call that settles it (once). */
function watchLanding(nodeId: string, apply: PendingLanding['apply']): (landed: boolean) => void {
  let settle: (landed: boolean) => void = () => {};
  const landing: PendingLanding = { nodeId, order: ++landingSeq, apply,
    settled: new Promise<boolean>((resolve) => { settle = resolve; }) };
  landingsOut.add(landing);
  let done = false;
  return (landed) => {
    if (done) return;
    done = true;
    landingsOut.delete(landing);
    settle(landed);
  };
}

interface LastSavedView {
  nodes: Map<string, { params: Record<string, unknown>; label: string | undefined }>;
  /** The writes still on their way for the nodes it covers (L-1). */
  pending: PendingLanding[];
}

function lastSavedView(): LastSavedView {
  const view = new Map<string, { params: Record<string, unknown>; label: string | undefined }>();
  const onCanvas = new Set<string>();
  for (const node of useGraphStore.getState().nodes) {
    onCanvas.add(node.id);
    const edits = unsavedParamEdits.get(node.id);
    const saved = savedParamValues.get(node.id);
    const renamedFrom = labelsInFlight.has(node.id) ? labelsSavedBefore.get(node.id) : undefined;
    if (!(edits && saved) && renamedFrom === undefined) continue;
    const params = { ...(node.data.params as Record<string, unknown>) };
    if (edits && saved) {
      for (const key of edits.keys) {
        if (!saved.has(key)) continue;
        const value = saved.get(key);
        if (value === ABSENT_PARAM) delete params[key];
        else params[key] = value;
      }
    }
    view.set(node.id, { params, label: renamedFrom ?? (node.data.label as string | undefined) });
  }
  return { nodes: view, pending: [...landingsOut].filter((landing) => onCanvas.has(landing.nodeId)) };
}

/** The writes on their way when the canvas of the next foreign step was
 * read as last saved (asLastSaved); that step waits for them (L-1). */
let landingsForNextStep: PendingLanding[] | null = null;

/** The canvas a step of an agent's clear is taken from: as last saved (G-a), once. */
function asLastSaved(state: GraphState): GraphState {
  const saved = clearedAsSaved;
  clearedAsSaved = null;
  landingsForNextStep = saved && saved.pending.length > 0 ? saved.pending : null;
  const view = saved?.nodes;
  if (!view || view.size === 0) return state;
  return { ...state, nodes: state.nodes.map((node) => {
    const kept = view.get(node.id);
    return kept ? { ...node, data: { ...node.data, params: kept.params, label: kept.label ?? node.data.label } } : node;
  }) };
}

/**
 * Round 23 (review 22, L-1): an agent's clear read while writes of the
 * person's were on their way. "As last saved" includes those Nebula then
 * answers 200 for: it applied them before the clear (a write made for the
 * canvas the clear replaced is refused after it). So the step is held, as a
 * step of the person's on its way is (stepsInFlight): an Undo pressed
 * meanwhile waits (holdsHistory), never restoring over typing Nebula has.
 * Each write that landed puts what it carried on the step's `before`, in
 * send order; one refused or unanswered leaves the value saved before it.
 * Writes that never answer release the step after HOLD_LIMIT_MS with what it
 * knows, and a press waiting on it is dropped with its line (waitFor).
 */
function holdForLandings(entry: ForeignEdit, landings: PendingLanding[]): void {
  holdStep(entry);
  const landed: PendingLanding[] = [];
  let left = landings.length;
  let released = false;
  const set = useGraphStore.setState as GraphSet;
  const get = useGraphStore.getState;
  const timer = setTimeout(() => {
    released = true;
    stepsInFlight.delete(entry);
    if (heldFor === entry) announceDrop(set, dropHeldPresses());
  }, HOLD_LIMIT_MS);
  for (const landing of landings) {
    void landing.settled.then((ok) => {
      if (released) return;
      if (ok) landed.push(landing);
      left -= 1;
      if (left > 0) return;
      clearTimeout(timer);
      for (const write of landed.sort((a, b) => a.order - b.order)) {
        const node = entry.before.nodes[write.nodeId];
        if (node) entry.before.nodes[write.nodeId] = write.apply(node);
      }
      if (stepsInFlight.has(entry)) settleStep(entry, set, get);
    });
  }
}

/** A name as Nebula stores it (the backend's rules): whitespace collapsed,
 * 80 characters at most; blank goes back to the canvas title (GM - Design,
 * round 18). */
function cleanNodeLabel(node: Node<NodeData>, label: string): string {
  const known = NODE_DEFINITIONS[node.data.definitionId];
  const displayName = known ? canvasTitle(known) : node.data.label;
  return label.replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_LABEL_LENGTH).trim() || displayName;
}

/** Renames sent and not yet answered, by node (round 20, H1). */
const labelsInFlight = new Map<string, string>();
/** The name each of those had before (round 22, G-a: as last saved). */
const labelsSavedBefore = new Map<string, string>();

/**
 * Round 20 (review 19, H1): what an agent's switch hands over beside the
 * snapshot, so Nebula keeps it in the project left: per backend node, the
 * settings the person changed that Nebula may not have (typing in its
 * debounce, on its way, held behind an undo, or landed but not yet seen in
 * a sync), and renames not yet answered. Nebula merges exactly these keys
 * onto its own copy of the node (PUT /api/projects/{id}, `pendingParams`
 * and `pendingLabels`); everything else keeps its copy, so an undo the
 * switch dropped is never folded in. Values are the canvas's.
 */
export interface HandoffPending {
  params: Record<string, Record<string, unknown>>;
  labels: Record<string, string>;
}

function handoffPending(nodes: Node<NodeData>[]): HandoffPending {
  const params: HandoffPending['params'] = {};
  const labels: HandoffPending['labels'] = {};
  for (const [nodeId, edits] of unsavedParamEdits) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node || !CLI_ID_RE.test(nodeId)) continue;
    const values = node.data.params as Record<string, unknown>;
    const keys = [...edits.keys].filter((key) => key in values);
    if (keys.length > 0) params[nodeId] = Object.fromEntries(keys.map((key) => [key, values[key]]));
  }
  for (const nodeId of labelsInFlight.keys()) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node && typeof node.data.label === 'string') labels[nodeId] = node.data.label;
  }
  return { params, labels };
}

/** Whether a sync's backend nodes are the ones on the canvas now: the same
 * ids, each with the same definition (a delete still on its way counts as
 * on the canvas). M2: a reconnect after a restart that lost the canvas
 * revision; any difference reads as another canvas. */
function sameBackendCanvas(incoming: Node<NodeData>[]): boolean {
  const shown = new Map(useGraphStore.getState().nodes.filter((node) => CLI_ID_RE.test(node.id))
    .map((node) => [node.id, node.data.definitionId]));
  const synced = new Map(incoming.filter((node) => CLI_ID_RE.test(node.id)).map((node) => [node.id, node.data?.definitionId]));
  for (const id of deletesInFlight.keys()) if (synced.has(id) && !shown.has(id)) shown.set(id, synced.get(id)!);
  if (shown.size === 0 || shown.size !== synced.size) return false;
  return [...shown].every(([id, definition]) => synced.get(id) === definition);
}

/** Writes that waited at the gate go now: under their own admission, so
 * after a switch or an import they are dropped and named. */
function openWriteGate(): void {
  const gate = writeGate;
  writeGate = null;
  gate?.open();
}

function closeWriteGate(): void {
  if (writeGate) return;
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  writeGate = { fromSeq: admissionSeq + 1, opened, open };
}

/** Even fire-and-forget layout/edge/param writes hold project navigation until
 * their backend request settles. Admission happens before invoking fetch.
 * While an undo or redo waits to reach Nebula, the person's other graph
 * writes go after it, so Nebula applies them in the order the person made
 * them (round 17's property test, seeds 147 and 1624): a write sent ahead
 * would be undone by the restore behind it, and its echo would take the
 * undo back off the canvas. `admission`: read when the person acted (the
 * default: now). `timeoutMs`: a restore's bound (it rejects with
 * RestoreTimeout); `onLate` then gets its answer if one comes. */
function graphMutationFetch(path: string, init?: RequestInit,
  options: { admission?: WriteAdmission; timeoutMs?: number; onLate?: (response: Response) => void; saves?: CutOffSave[] } = {}): Promise<Response> {
  const admission = options.admission ?? admitWrite();
  const saves = options.saves ?? describeSaves(path, init);
  // Round 19: made after a switch or an import began: it waits until that
  // is done, then goes under its own admission (dropped and named if the
  // canvas was replaced, sent as usual if not).
  const gate = writeGate;
  if (gate && admission.seq >= gate.fromSeq) {
    return trackGraphMutation(async () => {
      await gate.opened;
      return graphMutationFetch(path, init, { ...options, admission, saves });
    }, { restoreBound: true });
  }
  const tracked: TrackedWrite = { graph: admission.graph, seq: admission.seq, restore: path === '/api/graph/restore',
    saves, counted: false };
  liveWrites.add(tracked);
  // Every drain under way waits for it (review 19, L4: two at once).
  if (writeGate && admission.seq < writeGate.fromSeq) for (const drain of drains) drain.watching.add(tracked);
  // A write sent in the turn it was admitted reads the same project as
  // apiFetch does; one that waited names the one read at admission.
  const fetchNow = (request?: RequestInit) => (options.admission || writesWaitingNow() > 0 || restoresPendingNow() > 0
    ? apiFetch(path, request, { project: readmitted(admission.project) }) : apiFetch(path, request));
  const send = () => {
    if (!stillAdmitted(admission)) return Promise.resolve(staleCanvasAnswer());
    if (options.timeoutMs === undefined) return fetchNow(init);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new RestoreTimeout()); }, options.timeoutMs);
    });
    const fetching = fetchNow({ ...init, signal: controller.signal });
    // Review 18, L-B: a request Nebula already has can't be called back, so
    // its answer is still read after the limit: Nebula may apply it late.
    fetching.then((response) => { if (timedOut) options.onLate?.(response); }, () => {});
    return Promise.race([fetching, late]).finally(() => clearTimeout(timer));
  };
  const sent = (() => {
    if (tracked.restore) return trackGraphMutation(send, { restoreBound: true });
    if (restoresPendingNow() > 0 || writesWaitingNow() > 0) {
      // In the order admitted: behind the restores queued now, and behind
      // every write already waiting (round 18's property test, seed 286: a
      // write admitted after the restore answered went out ahead of one still
      // waiting behind it, and Nebula kept the older value).
      const after = restoreQueue;
      const previous = waitingTail;
      let dispatched = () => {};
      const mine = new Promise<void>((resolve) => { dispatched = resolve; });
      waitingTail = mine;
      const waiting = { graph: admission.graph };
      writesWaitingSet.add(waiting);
      const target = nodeWriteTarget(path, init);
      return trackGraphMutation(async () => {
        try {
          await after;
          await previous;
          // Review 18, M-A: a node off the canvas because its own delete is
          // still on its way is in Nebula until that delete lands, which
          // goes after this write: it is sent, so a delete that fails brings
          // the node back as its card shows it. Off for any other reason
          // (its delete landed, an agent deleted it), it is dropped.
          if (stillAdmitted(admission) && target && !deletesInFlight.has(target)
            && !useGraphStore.getState().nodes.some((node) => node.id === target)) {
            return droppedWriteAnswer();
          }
          const sending = send();
          dispatched();
          return await sending;
        } finally {
          dispatched();
          writesWaitingSet.delete(waiting);
        }
      }, { restoreBound: true });
    }
    return trackGraphMutation(send);
  })();
  return sent.then((response) => {
    settleTracked(tracked, response.ok);
    // Round 19: an answer for a canvas replaced since never reads as about
    // this one. Nebula's refusal (or the tab's own) is the out-of-date line,
    // which a canvas replaced since doesn't show (plainLine): GM's line names
    // the save instead.
    if (!response.ok && tracked.graph !== canvasReplacementRevision) {
      noteCutOff(tracked);
      return tracked.restore ? response : staleCanvasAnswer();
    }
    return response;
  }, (error: unknown) => {
    settleTracked(tracked, false);
    if (tracked.graph !== canvasReplacementRevision && !tracked.restore) {
      noteCutOff(tracked);
      return staleCanvasAnswer();
    }
    throw error;
  });
}
/** Writes waiting their turn (graphMutationFetch), and the last one's dispatch. */
const writesWaitingSet = new Set<{ graph: number }>();
let waitingTail: Promise<void> = Promise.resolve();
/** Those made for the canvas shown now: a write for a newer canvas never
 * waits behind one for a canvas replaced since (it will be dropped). */
function writesWaitingNow(): number {
  return [...writesWaitingSet].filter((write) => write.graph === canvasReplacementRevision).length;
}
function restoresPendingNow(): number {
  return [...restoreSeqs.values()].filter((graph) => graph === canvasReplacementRevision).length;
}
/** The canvas was replaced: its writes' queue goes with it (round 19, C3:
 * the person's add after a clear waited behind a restore for the cleared
 * canvas, which can only be dropped). */
function newWriteQueue(): void {
  restoreQueue = Promise.resolve();
  waitingTail = Promise.resolve();
}

/** Round 19 (GM): wait, at most HOLD_LIMIT_MS, for every graph write made
 * before now: the person's typing still in its debounce is sent first, and
 * new writes wait at the gate (openWriteGate). Returns the saves that failed
 * or hadn't answered when the time ran out. */
async function drainWrites(): Promise<CutOffSave[]> {
  for (const nodeId of Object.keys(paramPushTimers)) {
    window.clearTimeout(paramPushTimers[nodeId]);
    delete paramPushTimers[nodeId];
    void pushNodeParams(nodeId);
  }
  closeWriteGate();
  const gateFrom = writeGate!.fromSeq;
  let wake = () => {};
  const watching = new Set([...liveWrites].filter((write) => write.seq < gateFrom));
  const current: Drain = { watching, cutOff: [], changed: () => wake() };
  drains.add(current);
  const deadline = Date.now() + HOLD_LIMIT_MS;
  try {
    for (;;) {
      // Restores pressed before the gate, still queued, are writes too.
      const queued = [...restoreSeqs.keys()].some((seq) => seq < gateFrom);
      if (current.watching.size === 0 && !queued) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, queued ? 50 : left));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    drains.delete(current);
  }
  for (const write of current.watching) {
    write.counted = true;
    current.cutOff.push(write);
  }
  return current.cutOff.flatMap((write) => write.saves);
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

/** Nodes whose typing was still waiting to be sent when their delete went
 * out (GM r18, option (c)): dropped when the delete lands, sent if it
 * fails and the node comes back (changeCanvasNodes). */
const deferredParamPushes = new Set<string>();

/**
 * Round 22 (review 21, L-a): a param save Nebula refused as out of date
 * while this tab saw no replacement of its canvas. After a restart that
 * lost Nebula's canvas revisions, typing sent before the socket's first sync
 * goes out under the old canvas header and is refused, though the canvas is
 * the same. It is kept (its edit stays unsaved, so the field keeps the
 * typing) and decided by what comes next:
 * - a sync of the same canvas (adopted across the restart, or one that
 *   simply shows it): sent again, once, under the revision the tab holds now;
 *   refused again, GM's failed-save line names it and puts it back;
 * - a sync that is another canvas (a replacement): named in that
 *   replacement's line, never lost with no line;
 * - no sync within PARKED_SAVE_MAX_MS: sent again once all the same;
 * - the canvas goes (a switch, which hands it off or saves the snapshot): let go.
 */
interface ParkedParamSave { saves: CutOffSave[]; timer: ReturnType<typeof setTimeout> }
const parkedParamSaves = new Map<string, ParkedParamSave>();
const PARKED_SAVE_MAX_MS = 15_000;

function parkParamSave(nodeId: string, saves: CutOffSave[]): void {
  const earlier = parkedParamSaves.get(nodeId);
  if (earlier) clearTimeout(earlier.timer);
  const timer = setTimeout(() => {
    if (parkedParamSaves.get(nodeId)?.timer === timer) resendParkedParamSave(nodeId);
  }, PARKED_SAVE_MAX_MS);
  parkedParamSaves.set(nodeId, { saves: [...(earlier?.saves ?? []), ...saves], timer });
}

function resendParkedParamSave(nodeId: string): void {
  const parked = parkedParamSaves.get(nodeId);
  if (!parked || isCanvasKept()) return;
  clearTimeout(parked.timer);
  parkedParamSaves.delete(nodeId);
  // Typing since then is on its own timer and goes with it.
  if (paramPushTimers[nodeId] !== undefined) return;
  void pushNodeParams(nodeId, { resent: true });
}

/** A sync of the canvas the tab holds: the parked saves go out again, once
 * the sync is merged (the field still shows the typing). */
function resendParkedParamSaves(): void {
  if (parkedParamSaves.size === 0) return;
  const ids = [...parkedParamSaves.keys()];
  setTimeout(() => { for (const nodeId of ids) resendParkedParamSave(nodeId); }, 0);
}

/** The canvas was replaced: what the parked saves would have saved, for the
 * replacement's line; they go. */
function takeParkedParamSaves(): CutOffSave[] {
  const saves: CutOffSave[] = [];
  for (const parked of parkedParamSaves.values()) {
    clearTimeout(parked.timer);
    saves.push(...parked.saves);
  }
  parkedParamSaves.clear();
  return saves;
}

/** The canvas went with a switch (its handoff or its snapshot kept the values): let them go. */
function forgetParkedParamSaves(): void {
  takeParkedParamSaves();
}

/** GM r15 on PR #199, Q11 (review 11, HIGH-1): the canvas is kept in this
 * tab. Parked saves stop waiting for a resend (one would be refused and put
 * back); typing stays on the canvas only (updateNodeData, pushNodeParams). */
export function keepCanvasLocally(): void {
  setCanvasKept(true);
  forgetParkedParamSaves();
  // The backend refuses agents' writes and switches meanwhile (GM r16 on
  // PR #199: 409 canvas_kept_in_tab). Optional: tests mock the socket.
  wsClient.setKeptEdits?.(true);
}

/** The kept canvas was saved as its own project (or let go): what this
 * tab tracked as unsaved for the old project goes, since the project it
 * opens next brings its own. */
export function releaseKeptCanvas(): void {
  if (!isCanvasKept()) return;
  setCanvasKept(false);
  wsClient.setKeptEdits?.(false);
  forgetParkedParamSaves();
  clearAllParamPushTimers();
}

function pushNodeParams(nodeId: string, options: { resent?: boolean } = {}): Promise<void> {
  // Kept in this tab (GM r15, Q11): nothing is sent; the typing waits for
  // [Save as a project] with the rest of the canvas.
  if (isCanvasKept()) return Promise.resolve();
  const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
  if (!node) {
    if (deletesInFlight.has(nodeId) && unsavedParamEdits.has(nodeId)) deferredParamPushes.add(nodeId);
    else {
      unsavedParamEdits.delete(nodeId);
      savedParamValues.delete(nodeId);
      forgetParamPushes(nodeId);
    }
    return Promise.resolve();
  }
  const edits = unsavedParamEdits.get(nodeId);
  // Review 18, M-C and L-C: only the keys the person changed, merged by
  // Nebula into what it has (PUT /api/graph/node/{id} merges the keys it is
  // sent). A whole-params copy, read before an agent's edit reached the
  // canvas (or carrying a value a refused undo left on it), overwrote the
  // agent's edit, or let the undo take effect after all.
  if (!edits || edits.keys.size === 0) return Promise.resolve();
  const params = node.data.params as Record<string, unknown>;
  const changed = Object.fromEntries([...edits.keys].filter((key) => key in params).map((key) => [key, params[key]]));
  if (Object.keys(changed).length === 0) return Promise.resolve();
  edits.inFlight += 1;
  // What this write carries, until a sync shows it (review 16, L-3).
  edits.sent = new Map([...edits.keys].map((key) => [key, stableJson(params[key])]));
  edits.echoed = false;
  edits.answered = false;
  if (edits.linger !== undefined) clearTimeout(edits.linger);
  edits.linger = undefined;
  // This save's own keys: those edited since the previous save was sent
  // (PR #114, round 14, review 14 L2): a failure names and puts back these.
  const gen = paramEditGen.get(nodeId) ?? 0;
  const since = lastPushGen.get(nodeId) ?? 0;
  lastPushGen.set(nodeId, gen);
  const keys = [...(paramKeyGen.get(nodeId) ?? new Map<string, number>())]
    .filter(([, keyGen]) => keyGen > since).map(([key]) => key);
  const push: ParamPush = { gen, keys, sent: changed };
  paramPushesOut.set(nodeId, [...(paramPushesOut.get(nodeId) ?? []), push]);
  // The canvas it was typed on: a failure after a clear, an import or a
  // switch puts nothing back by node id (n1 may be another node now), and
  // the cut-off lines name it instead (round 21, the #114 merge).
  const graphAtPush = canvasReplacementRevision;
  const canvasAtPush = getProjectContext()?.canvas;
  const request = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: changed }) };
  const saves = describeSaves(`/api/graph/node/${nodeId}`, request);
  let ok = false;
  let parked = false;
  // Round 23 (review 22, L-1): an agent's clear read before this answer
  // takes what it carried as saved once it lands (holdForLandings).
  const landed = watchLanding(nodeId, (was) => ({ ...was, data: { ...was.data,
    params: { ...(was.data.params as Record<string, unknown>), ...changed } } }));
  return graphMutationFetch(`/api/graph/node/${nodeId}`, request, { saves }).then(async (response) => {
    ok = response.ok;
    // Until round 14 of PR #114 a refusal counted as saved here (only the network error was caught).
    if (!response.ok) {
      const text = await response.clone().text().catch(() => '');
      throw new ParamSaveRefused(response.status, text.includes(STALE_CANVAS_DETAIL));
    }
    // The backend took these: they are the last saved values now.
    landed(true);
    const saved = savedParamValues.get(nodeId);
    if (saved) for (const key of Object.keys(changed)) if (saved.has(key)) saved.set(key, changed[key]);
    const pushes = paramPushesOut.get(nodeId);
    if (pushes) paramPushesOut.set(nodeId, pushes.filter((entry) => entry !== push));
  }).catch((err) => {
    console.warn(`[nebula] Param sync for ${nodeId} failed:`, err);
    // Refused while offline: typed just before the connection dropped (its
    // field is disabled offline), so it is an edit in flight. GM's failed-save
    // line and the revert, never lost without a word (round 16 of PR #114,
    // review 15 L2; round 15 said nothing here). Not for a write made for a
    // canvas replaced since: its own lines say what was cut off.
    const outOfDate = err instanceof ParamSaveRefused && err.outOfDate;
    const sameGraph = graphAtPush === canvasReplacementRevision;
    if (isCanvasKept() && sameGraph) {
      // Review 11 of PR #199, HIGH-1: refused because Nebula restored its
      // project list (or an agent's write closed the project) while it was on
      // its way. The canvas is kept in this tab now, so the typing stays:
      // never put back, never sent again; [Save as a project] files it.
      parked = true;
      const pushes = paramPushesOut.get(nodeId);
      if (pushes) paramPushesOut.set(nodeId, pushes.filter((entry) => entry !== push));
    } else if (outOfDate && sameGraph && !options.resent && unsavedParamEdits.get(nodeId) === edits) {
      // Round 22 (review 21, L-a): kept for what the next sync says
      // (parkParamSave). Its keys are this save's again for the resend.
      parked = true;
      const pushes = paramPushesOut.get(nodeId);
      if (pushes) paramPushesOut.set(nodeId, pushes.filter((entry) => entry !== push));
      if (lastPushGen.get(nodeId) === gen) lastPushGen.set(nodeId, since);
      parkParamSave(nodeId, saves);
      // Its answer came after the sync that adopted the canvas (the tab
      // holds a newer revision of the same canvas now): at once.
      if (getProjectContext()?.canvas !== canvasAtPush) resendParkedParamSaves();
    } else if (sameGraph) paramSaveFailed(nodeId, push);
    else {
      const pushes = paramPushesOut.get(nodeId);
      if (pushes) paramPushesOut.set(nodeId, pushes.filter((entry) => entry !== push));
    }
  }).finally(() => {
    landed(false);
    if (!parked) {
      settleParamEdit(nodeId, edits, ok);
      return;
    }
    // Kept unsaved: the field keeps the typing until the resend's answer.
    edits.inFlight = Math.max(0, edits.inFlight - 1);
    edits.sent = undefined;
  });
}

/** A param save Nebula answered with a refusal. `outOfDate`: for a canvas
 * cleared, replaced or switched away from since (CANVAS_OUT_OF_DATE). */
class ParamSaveRefused extends Error {
  readonly status: number;
  readonly outOfDate: boolean;
  constructor(status: number, outOfDate: boolean) {
    super(`HTTP ${status}`);
    this.status = status;
    this.outOfDate = outOfDate;
  }
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
  clearUnsavedParamEdits();
}

function clearUnsavedParamEdits(): void {
  for (const entry of unsavedParamEdits.values()) if (entry.linger !== undefined) clearTimeout(entry.linger);
  unsavedParamEdits.clear();
  savedParamValues.clear();
  paramEditGen.clear();
  paramKeyGen.clear();
  paramPushesOut.clear();
  lastPushGen.clear();
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
// The same for backend nodes an undo or redo puts back (`want`) or takes off,
// by node id, while its restore is on its way (round 17's property test, seed
// 266): an echo Nebula sent before the restore reached it still shows the
// node as it was, and must not undo the undo on the canvas.
const nodeWrites = new Map<string, WireWrite>();

/**
 * A written line on the canvas (review 7, L3): the canvas notice, except
 * while it offers an agent's (or the person's) Undo or Redo; then the line
 * goes beside it (`messageNotice`), so the button stays. Every writer of a
 * plain line goes through here: notify, a refused wire, a held delete
 * (review 8, L-d). `tone` as notify gives it; none keeps the notice's default.
 */
function noticeLine(state: Pick<GraphState, 'undoNotice'>, text: string, tone?: 'error' | 'info',
  mono?: string): Partial<GraphState> {
  // Round 19 (GM): a write made for a canvas replaced since says nothing of
  // its own; GM's line names what it would have saved (noteCutOff).
  if (text.includes(STALE_CANVAS_DETAIL) && cutOffAnswersArriving()) return {};
  return plainLine(state, text, tone, undefined, mono);
}

/** Answers for a canvas replaced since are still arriving, or just did
 * (their callers word them a moment after the answer). */
function cutOffAnswersArriving(): boolean {
  if ([...liveWrites].some((write) => write.graph !== canvasReplacementRevision)) return true;
  return Date.now() - lastCutOffAt < CUT_OFF_GRACE_MS;
}
let lastCutOffAt = Number.NEGATIVE_INFINITY;
const CUT_OFF_GRACE_MS = 2_000;

function plainLine(state: Pick<GraphState, 'undoNotice'>, text: string, tone?: 'error' | 'info',
  copy?: NoticeCopy, mono?: string): Partial<GraphState> {
  const toned = tone ? { tone } : {};
  // A part shown in mono (a model id, GM round 15 of PR #114).
  const opens = { ...(copy ? { copy } : {}), ...(mono ? { mono } : {}) };
  return state.undoNotice?.offer
    // No tone reads as a status in either place (CanvasUndoNotice's role).
    ? { messageNotice: { id: ++undoNoticeSeq, text, tone: tone ?? 'info', ...opens } }
    : { undoNotice: { id: ++undoNoticeSeq, text, offer: null, ...toned, ...opens } };
}

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
    const heading = `Couldn't ${want ? 'make' : 'remove'} that connection.`;
    const text = `${heading} ${await backendRejectionReason(response, heading)}`;
    set((state) => ({
      edges: want ? state.edges.filter((e) => e.id !== edge.id)
        : state.edges.some((e) => edgeKey(e) === edgeKey(edge)) ? state.edges : [...state.edges, edge],
      // Beside an agent's Undo, never over it (review 8, L-d: through notify's rule).
      ...noticeLine(state, text),
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
  return heldWrites(wireWrites, new Set(cliEdges.map(edgeKey)));
}

/** Hold a node an undo or redo puts back (`want`) or takes off, until its
 * restore answers. Nebula sends the restore's own echo before that answer,
 * and the stale echoes before it, so unlike a wire the hold ends there. */
function holdNode(id: string, want: boolean): (took: boolean) => boolean {
  const write = nodeWrites.get(id) ?? { want, sending: 0 };
  Object.assign(write, { want, sending: write.sending + 1 });
  nodeWrites.set(id, write);
  let done = false;
  // True when this ended the hold (no other write holds the node).
  return () => {
    if (done) return false;
    done = true;
    write.sending -= 1;
    if (nodeWrites.get(id) !== write || write.sending) return false;
    nodeWrites.delete(id);
    return true;
  };
}

/**
 * Review 17, M-2: a held node isn't frozen for good. Each sync that arrives
 * while a node is held (an undo's restore on its way, a delete on its way)
 * leaves the canvas copy alone, but the newest copy Nebula sent is kept
 * here: the node as that sync had it (null: the sync didn't have it), its
 * wires, and the latest edit someone else made to it. When the hold ends
 * (applyHeldCopies) the canvas takes that copy, so an agent's edit or a
 * run's outputs that arrived meanwhile are never lost, and the person's
 * next PUT carries them instead of writing over them (W3). The agent's
 * change gets its own undo step then.
 */
interface HeldCopy { node: Node<NodeData> | null; edges: Edge[]; foreign?: EditOrigin; moved: boolean }
const heldCopies = new Map<string, HeldCopy>();

function noteHeldCopies(held: Map<string, boolean>, incoming: Node<NodeData>[], edges: Edge[],
  origin: EditOrigin | undefined, moved: readonly string[]): void {
  if (held.size === 0) return;
  const byId = new Map(incoming.map((node) => [node.id, node]));
  const someoneElse = origin && !isOwnEcho(origin, TAB_ID) ? origin : undefined;
  for (const id of held.keys()) {
    const node = byId.get(id) ?? null;
    const before = heldCopies.get(id);
    heldCopies.set(id, {
      node,
      edges: node ? edges.filter((edge) => edge.source === id || edge.target === id) : [],
      foreign: someoneElse ?? before?.foreign,
      moved: moved.includes(id) || Boolean(before?.moved),
    });
  }
}

/** The canvas takes the newest copy synced for each node whose hold ended
 * (`ids`), unless another write still holds it. */
function applyHeldCopies(ids: Iterable<string>, options: { wires?: boolean } = {}): void {
  const set = useGraphStore.setState as GraphSet;
  const get = useGraphStore.getState;
  for (const id of ids) {
    if (nodeWrites.has(id)) continue;
    const copy = heldCopies.get(id);
    heldCopies.delete(id);
    if (!copy) continue;
    const state = get();
    const existing = state.nodes.find((node) => node.id === id);
    let nodes: Node<NodeData>[];
    let edges: Edge[];
    if (!copy.node) {
      if (!existing) continue;
      nodes = state.nodes.filter((node) => node.id !== id);
      edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id);
    } else {
      const merged = mergeSyncedNode(copy.node, existing, copy.moved ? [id] : [], useUIStore.getState().settingsCache);
      nodes = existing ? state.nodes.map((node) => (node.id === id ? merged : node)) : [...state.nodes, merged];
      const present = new Set(nodes.map((node) => node.id));
      if (existing && options.wires) {
        // Review 18, M-B: a node a failed delete put back takes the wires
        // Nebula has for it (the newest sync while it was off), not the
        // ones it had when Delete was pressed. A wire this tab is still
        // writing keeps its way (heldWires).
        const synced = new Set(copy.edges.map(edgeKey));
        const kept = state.edges.filter((edge) => !(edge.source === id || edge.target === id)
          || !CLI_ID_RE.test(edge.source) || !CLI_ID_RE.test(edge.target)
          || synced.has(edgeKey(edge)) || wireWrites.get(edgeKey(edge))?.want === true);
        const wired = new Set(kept.map(edgeKey));
        edges = [...kept, ...copy.edges.filter((edge) => present.has(edge.source) && present.has(edge.target)
          && !wired.has(edgeKey(edge)) && wireWrites.get(edgeKey(edge))?.want !== false)];
      } else {
        const wired = new Set(state.edges.map(edgeKey));
        edges = existing ? state.edges : [...state.edges, ...copy.edges.filter((edge) => present.has(edge.source)
          && present.has(edge.target) && !wired.has(edgeKey(edge)))];
      }
    }
    // An agent's change to it is its own step (outputs and run state alone are none).
    set({ nodes, edges, ...(copy.foreign ? foreignEditStep(state, nodes, edges, copy.foreign, false, copy.moved ? [id] : []) : {}) });
    noteSyncArrivals(state.nodes, nodes, set, get);
  }
}

/** What this sync must leave as this tab has it: node id -> want. Until
 * the restore answers, whatever the sync says: one that shows the node
 * there may still carry its params from before the undo (seed 914). */
function heldNodes(): Map<string, boolean> {
  return new Map([...nodeWrites].map(([id, write]) => [id, write.want]));
}

function heldWrites(writes: Map<string, WireWrite>, present: Set<string>): Map<string, boolean> {
  const held = new Map<string, boolean>();
  for (const [key, write] of writes) {
    // Once a sync agreed the backend has taken it: a later one that differs is newer.
    write.agreed ||= present.has(key) === write.want;
    if (!write.sending && (write.agreed || write.grace)) writes.delete(key);
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

/**
 * The canvas's node changes (React Flow's onNodesChange, and every delete
 * path: the toolbar, the context menu, the Inspector, deleteCanvasElements).
 * A delete takes one undo step, or joins `shared` (deleteCanvasElements:
 * the same step as the wires deleted with the nodes, review 9 L-4); `keep`
 * says that step holds more than these nodes, so it stays even if no node
 * goes after all.
 */
function changeCanvasNodes(
  pressed: NodeChange[],
  set: GraphSet,
  get: GraphGet,
  shared?: { step: UndoSnapshot; keep: boolean },
): void {
  if (get().isExecuting && pressed.some((change) => change.type === 'remove')) return;
  // A node whose delete is on its way is off the canvas already (GM r18,
  // option (c)); a remove for it (a stale selection) leaves it to that
  // delete: a second step would claim the same delete, and once one of them
  // is undone the other's Cmd+Z would do nothing (round 17, seed 320).
  const changes = pressed.filter((change) => change.type !== 'remove' || !deletesInFlight.has(change.id));
  if (changes.length === 0) return;
  const removedIds = changes.filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove').map((c) => c.id);
  if (refuseHeldNodeDelete(get(), removedIds, set)) return;
  const cliRemovedIds = removedIds.filter((nodeId) => CLI_ID_RE.test(nodeId));
  if (cliRemovedIds.length === 0) {
    if (removedIds.length === 0) {
      applyCanvasNodeChanges(changes, set, get);
      return;
    }
    breakUndoDebounce();
    const step = shared?.step ?? pushUndo(set, get);
    markDeleteStep(step);
    const present = new Set(get().nodes.map((node) => node.id));
    applyCanvasNodeChanges(changes, set, get, step);
    const gone = removedIds.filter((nodeId) => present.has(nodeId) && !get().nodes.some((node) => node.id === nodeId));
    if (gone.length > 0) set(deletedNotice(gone.length, step));
    return;
  }

  // GM - Design, round 18, item 2, option (c): "The node and its edges
  // leave the canvas the moment Delete is pressed, and queued writes to it
  // (person's or agent's) are dropped when the delete lands. Cmd+Z while the
  // delete is in flight shows the existing "Nothing was undone. Your last
  // change was still saving." Once the delete lands, undo restores the node
  // as one step. If the delete fails, the node returns where it was, with
  // its edges and the existing failure line. Don't select it. Agent deletes
  // go through the same path." (Before: the node stayed until Nebula
  // answered, so it could be typed into while its delete was on its way,
  // and those writes reached Nebula after it: round 17's open class.)
  breakUndoDebounce();
  const undoStep = shared?.step ?? pushUndo(set, get);
  const shownBefore = new Set(get().nodes.map((node) => node.id));
  // A project opened (or a graph loaded) before the answers came: the
  // canvas and its steps are another graph's now (second review).
  const replacementRevision = canvasReplacementRevision;
  // A Cmd+Z pressed before the answers is dropped with GM's line (stepHistory).
  holdStep(undoStep);
  removedBy.set(undoStep, new Set([...(removedBy.get(undoStep) ?? []), ...cliRemovedIds]));
  markDeleteStep(undoStep);
  for (const nodeId of cliRemovedIds) deletesInFlight.set(nodeId, undoStep);
  // The node leaves the canvas now: the UI's selection doesn't keep naming it
  // (review 19, L1), so a failed delete never brings it back selected.
  const selectedInUi = useUIStore.getState().selectedNodeId;
  if (selectedInUi && removedIds.includes(selectedInUi)) useUIStore.getState().selectNode(null);
  // Syncs leave them off until their delete answers (heldNodes); the newest
  // copy one carries is what comes back if the delete fails (M-2).
  const holds = new Map(cliRemovedIds.map((nodeId) => [nodeId, holdNode(nodeId, false)]));
  // As they are now, and where in the canvas's order: a failed delete puts them back so.
  const onCanvas = get().nodes;
  applyCanvasNodeChanges(changes, set, get, undoStep);
  const deleting = Promise.allSettled(cliRemovedIds.map(deleteCLIOriginNode)).then((results) => {
    try {
      applyDeleteAnswers(results);
    } finally {
      for (const nodeId of cliRemovedIds) if (deletesInFlight.get(nodeId) === undoStep) deletesInFlight.delete(nodeId);
      settleStep(undoStep, set, get);
    }
  });
  function applyDeleteAnswers(results: PromiseSettledResult<RemovalRecord | null>[]): void {
    const confirmed = new Set<string>();
    const failures: string[] = [];
    // The ids that failed with no answer from Nebula (GM, round 20, item 1).
    const unanswered: string[] = [];
    // The ids Nebula answered with a server error, and the status (GM round 21).
    const serverErrors = new Map<string, number>();
    const removals: RemovalRecord[] = [];
    // Review 14, L-E: the echo is the truth. A node a sync of Nebula's graph
    // already took off is deleted there, whatever its answer said (a 500
    // after the delete was done): the delete counts, its undo step stays.
    const goneBySync = syncRemoved.get(undoStep);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        confirmed.add(cliRemovedIds[index]);
        if (result.value) removals.push(result.value);
      } else if (goneBySync?.has(cliRemovedIds[index])) {
        confirmed.add(cliRemovedIds[index]);
      } else {
        failures.push(failureCopy(result.reason).reason);
        if (isBackendUnreachable(result.reason)) unanswered.push(cliRemovedIds[index]);
        else if (result.reason instanceof RequestFailedError && result.reason.status >= 500) {
          serverErrors.set(cliRemovedIds[index], result.reason.status);
        }
      }
    });
    const failed = cliRemovedIds.filter((nodeId) => !confirmed.has(nodeId));
    // Undoing this step names what each delete removed (GM, 2026-10-23).
    if (removals.length > 0) undoStep.removals = mergeRemovals(undoStep.removals, removals);
    if (replacementRevision !== canvasReplacementRevision) {
      // Nothing here is that graph's any more: no node to put back, no
      // step to renew, no notice, and no state to touch. Review 19, M3: the
      // ids are the new canvas's now (a clear or an import reuses n1…), so
      // this answer never drops the typing, held copy or deferred push of
      // the node that took one (seeds 84 and 1123 of the clear variant).
      // The step keeps its records, for an undo that comes back to that
      // graph (an import undone).
      for (const done of holds.values()) done(false);
      if (failures.length > 0) reportNodeDeletionFailure(failures, failures.length);
      return;
    }
    // The writes still waiting for a deleted node are dropped (option (c)).
    for (const nodeId of confirmed) {
      deferredParamPushes.delete(nodeId);
      unsavedParamEdits.delete(nodeId);
      heldCopies.delete(nodeId);
    }
    if (removals.length > 0) {
      set((state) => {
        renewStackedRemovals(state, removals);
        return {};
      });
    }
    if (failed.length > 0) putBackFailedDeletes(failed);
    for (const done of holds.values()) done(false);
    // What Nebula synced of a node that came back while it was held (M-2),
    // with its wires as Nebula has them (review 18, M-B).
    applyHeldCopies(failed, { wires: true });
    // Typing not yet sent when Delete was pressed goes out for a node that
    // came back, so Nebula has what its card shows.
    for (const nodeId of failed) {
      if (deferredParamPushes.delete(nodeId)) void pushNodeParams(nodeId);
    }
    const deleted = cliRemovedIds.filter((nodeId) => confirmed.has(nodeId) && shownBefore.has(nodeId)).length
      + removedIds.filter((nodeId) => !CLI_ID_RE.test(nodeId) && shownBefore.has(nodeId)).length;
    // Its Undo applies only while this step is next in line: after a newer
    // step, the line would offer a button that does nothing (withLiveNotice).
    const top = get().undoStack.at(-1);
    if (deleted > 0 && confirmed.size > 0 && top && top === undoStep) set(deletedNotice(deleted, top));
    // GM, round 20 (item 1): no answer at all names the nodes; any other
    // cause keeps its reason.
    const cardTitle = (nodeId: string) => {
      const node = onCanvas.find((candidate) => candidate.id === nodeId);
      return (node && nodeTitle(NODE_DEFINITIONS[node.data.definitionId], node.data.label)) || '';
    };
    const titleOf = (nodeId: string) => cardTitle(nodeId) || nodeId;
    // GM round 21 (LOCKED): a server error says "back on the canvas" only
    // when every node it names really is back.
    const shownNow = new Set(get().nodes.map((node) => node.id));
    if (failures.length > 0 && unanswered.length === failures.length) {
      const message = deleteNoAnswerLine(unanswered.map(titleOf));
      console.warn(`[nebula] ${message}`);
      get().notify(message);
    } else if (failures.length > 0 && serverErrors.size === failures.length
      // Named as its card names it (never by a raw id): one it can't name keeps the line below.
      && [...serverErrors.keys()].every((nodeId) => shownNow.has(nodeId) && cardTitle(nodeId))) {
      const ids = [...serverErrors.keys()];
      const message = deleteServerErrorLine(ids.map(titleOf));
      console.warn(`[nebula] ${message}`);
      get().notify(message);
      // The status goes in the Agent log, not in the line (GM). Nebula's
      // answers carry no error id yet. GM round 22 (4a), verbatim: one entry
      // per node, "Couldn't delete “<node>”, node <id>. Nebula returned HTTP <status>."
      for (const nodeId of ids) {
        window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', { detail: { source: 'system',
          message: deleteServerErrorLogLine(titleOf(nodeId), nodeId, serverErrors.get(nodeId)!) } }));
      }
    } else if (failures.length > 0) {
      // GM, round 15 of PR #114: one kept node is named ("Couldn't delete “<node>”.").
      reportNodeDeletionFailure(failures, failures.length, failed.length === 1 ? namedOnCanvas(onCanvas, failed[0]) : undefined);
    }
  }
  /** The nodes whose delete failed come back where they were, with their
   * wires, unselected; the steps taken since hold them again. Nothing was
   * deleted at all: the step goes, wherever it is (a delete that didn't
   * happen is no step), unless it also took wires (deleteCanvasElements). */
  function putBackFailedDeletes(failed: string[]): void {
    const back = new Set(failed);
    // GM (round 20, B): the node comes back unselected, in the UI's
    // selection too (the ring and the settings pill read selectedNodeId).
    const selectedInUi = useUIStore.getState().selectedNodeId;
    if (selectedInUi && back.has(selectedInUi)) useUIStore.getState().selectNode(null);
    set((state) => {
      const present = new Set(state.nodes.map((node) => node.id));
      // Where it was, as it was; never selected (GM: "Don't select it").
      const returning = onCanvas.filter((node) => back.has(node.id) && !present.has(node.id))
        .map((node) => (node.selected ? { ...node, selected: false } : node));
      const nodes = [...state.nodes];
      for (const node of returning) {
        const after = onCanvas.slice(onCanvas.findIndex((candidate) => candidate.id === node.id) + 1)
          .map((candidate) => nodes.findIndex((here) => here.id === candidate.id)).find((at) => at >= 0);
        if (after === undefined) nodes.push(node);
        else nodes.splice(after, 0, node);
      }
      const ids = new Set(nodes.map((node) => node.id));
      const wired = new Set(state.edges.map(edgeKey));
      const edges = [...state.edges, ...undoStep.edges.filter((edge) => (back.has(edge.source) || back.has(edge.target))
        && ids.has(edge.source) && ids.has(edge.target) && !wired.has(edgeKey(edge))).map((edge) => ({ ...edge, selected: false }))];
      const at = state.undoStack.indexOf(undoStep);
      // The steps taken since, from a canvas without these nodes, hold them again.
      for (const step of at < 0 ? [] : state.undoStack.slice(at + 1)) {
        if (isSliceStep(step)) continue;
        const held = new Set(step.nodes.map((node) => node.id));
        const add = returning.filter((node) => !held.has(node.id));
        step.nodes = [...step.nodes, ...createSnapshot(add, []).nodes];
        for (const node of add) held.add(node.id);
        const stepWires = new Set(step.edges.map(edgeKey));
        step.edges = [...step.edges, ...edges.filter((edge) => (back.has(edge.source) || back.has(edge.target))
          && held.has(edge.source) && held.has(edge.target) && !stepWires.has(edgeKey(edge))).map((edge) => ({ ...edge }))];
      }
      const removedNone = cliRemovedIds.every((nodeId) => back.has(nodeId))
        && removedIds.every((nodeId) => CLI_ID_RE.test(nodeId) || !shownBefore.has(nodeId));
      const drop = removedNone && !shared?.keep;
      return { nodes, edges, ...(drop ? { undoStack: state.undoStack.filter((step) => step !== undoStep) } : {}) };
    });
  }
  // A restore already queued (an earlier undo or redo) reaches the backend
  // after these deletes, so its restore can name what they removed.
  restoreQueue = restoreQueue.then(() => deleting);
}

/** The canvas's wire changes, after the caller took the undo step for a
 * removal: cli wires mirrored to Nebula's backend, Remotion sources pruned. */
function applyCanvasEdgeChanges(changes: EdgeChange[], set: GraphSet, get: GraphGet): void {
  const hasRemove = changes.some((c) => c.type === 'remove');
  if (hasRemove) {
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
}

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

  // A backend deletion took its step before sending (its graphSync can land
  // first). Where that step goes now that the nodes come off: placeDeleteStep
  // (review 12, M-1 and L-5). Nodes its echo took off first were placed then
  // (placeEchoedDeletes, review 13 M-2); the step is the one it became.
  const present = new Set(get().nodes.map((node) => node.id));
  const leaving = removedIds.filter((id) => present.has(id));
  if (leaving.length > 0) placeDeleteStep(undoStep ? successorOf(undoStep) : undefined, leaving, set, get);
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

/** The backend's World Labs lines read as GM's trimmed ones (rounds 4 and
 * 4b, lib/worldLabsWaiting.ts deleteRefusalText: with a held node the line
 * starts with GM's own, "Couldn't delete them. …" for several); every other
 * reason as given, after `deletionHeading` when no node is held. */
function reportNodeDeletionFailure(reasons: string[], count: number, name?: string): void {
  const message = deleteRefusalText(deletionHeading(count), count, reasons, name);
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
    // Stop is sent while offline (round 16 of PR #114, M1: it only reduces
    // spend). If it doesn't get through then, GM's line says the run may
    // still be going, once per run; the store keeps the intent and sends it
    // again (the status check retries, and reconnect sends it).
    if (isBackendOffline() && !stopFailureNoted.has(runId)) {
      stopFailureNoted.add(runId);
      get().notify(STOP_FAILED_OFFLINE_LINE);
    }
    scheduleWorldLabsStatusReconciliation(runId, set, get);
  }
}

/** GM - Design, round 16 of PR #114: a Stop that failed while offline. */
export const STOP_FAILED_OFFLINE_LINE = "Couldn't stop the run. Nebula isn't answering, so it may still be going.";
const stopFailureNoted = new Set<string>();

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
  startError?: unknown,
): Promise<'active' | 'terminal' | 'unknown' | 'stale'> {
  // A start refused while offline was never sent (round 15 of PR #114):
  // nothing started, so the run ends here with its "Queued" marks.
  if (isOfflineRefusal(startError)) {
    if (!ownsRun(runId)) return 'stale';
    settleTrackedExecutionStatus('failed', runId, set, get);
    return 'terminal';
  }
  let result;
  try {
    result = await apiGetExecutionStatus(runId);
  } catch (error) {
    if (!ownsRun(runId)) return 'stale';
    const paidStart = trackedRunHasFreshPaidWorldLabs(runId, get);
    // The backend has no such run (404): the start whose answer was lost
    // never reached it, a restart lost it, or it is still being admitted
    // (review 15, M2: the backend registers a run only after its input
    // measurement). Without a paid World Labs start there is nothing to
    // check in Marble, so the run ends and its "Queued" marks go (review 14,
    // M1) — but only after its Stop is answered: the backend tombstones the
    // id and refuses a start still on its way, so it can never run untracked
    // or be run twice. A Stop that isn't answered keeps the run uncertain
    // and is sent again on the next check. A paid start keeps the uncertain
    // state and its unlock, as before.
    if (!paidStart && error instanceof RequestFailedError && error.status === 404) {
      return fenceUnknownRun(runId, set, get);
    }
    // A paid World Labs start gets the same Stop (round 17, review 16 L4), so
    // a start still on its way can't register later and send events to a run
    // the person was told is uncertain. It keeps the uncertain state and its
    // unlock: only Marble can say whether the provider call went out.
    if (paidStart && error instanceof RequestFailedError && error.status === 404) {
      fencePaidUnknownRun(runId, set, get);
    }
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
  // Tombstoned before it started (the 404 rule's Stop, sent earlier): it
  // failed to start, unless the person pressed Stop.
  const neverStarted = result.status === 'cancelled' && result.pendingAdmission && !cancellationRequestedRunIds.has(runId);
  settleTrackedExecutionStatus(neverStarted ? 'failed' : result.status, runId, set, get);
  return 'terminal';
}

/** How long the 404 rule's Stop waits for an answer (round 17 of PR #114,
 * review 16 L2), as long as other answers the tab waits on (chatClear). */
export const STOP_ANSWER_MS = 15_000;

/** DELETE the run id, giving up after STOP_ANSWER_MS: a backend that took
 * the connection but stalls (a journal lock another process holds) never
 * keeps the tab on the run. Rejects with `timedOut` set when it gave up. */
async function cancelWithinTimeLimit(runId: string): Promise<ExecutionCancellationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOP_ANSWER_MS);
  try {
    return await apiCancelExecution(runId, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error('The Stop got no answer in time.'), { timedOut: true, cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The 404 rule's Stop (round 16 of PR #114, M2): DELETE the run id first,
 * then settle by its answer. An unanswered Stop keeps the run uncertain
 * ("may still be going") and is sent again on the next check; one that got
 * no answer in time says GM's Stop line once (round 17, review 16 L2). */
async function fenceUnknownRun(runId: string, set: GraphSet, get: GraphGet): Promise<'terminal' | 'active' | 'unknown' | 'stale'> {
  let result: ExecutionCancellationResult;
  try {
    result = await cancelWithinTimeLimit(runId);
  } catch (error) {
    console.warn('[nebula] Stop for a run the backend has no record of failed:', error);
    if (!ownsRun(runId)) return 'stale';
    updateRunPhase(runId, cancellationRequestedRunIds.has(runId) ? 'cancelling' : 'uncertain', set);
    if (((error as { timedOut?: boolean }).timedOut || isBackendOffline()) && !stopFailureNoted.has(runId)) {
      stopFailureNoted.add(runId);
      get().notify(STOP_FAILED_OFFLINE_LINE);
    }
    scheduleWorldLabsStatusReconciliation(runId, set, get);
    return 'unknown';
  }
  if (!ownsRun(runId)) return 'stale';
  if (result.pendingAdmission) {
    // Never started, and now it never will: it failed to start (the person
    // didn't press Stop, unless they did).
    settleTrackedExecutionStatus(cancellationRequestedRunIds.has(runId) ? 'cancelled' : 'failed', runId, set, get);
    return 'terminal';
  }
  if (result.status === 'cancelling') {
    // It registered meanwhile: the Stop reached it. Track it to its end.
    updateRunPhase(runId, 'cancelling', set);
    scheduleWorldLabsStatusReconciliation(runId, set, get);
    return 'active';
  }
  settleTrackedExecutionStatus(result.status, runId, set, get);
  return 'terminal';
}

/** Paid World Labs starts whose 404 Stop was sent, once each. */
const paidFenceSent = new Set<string>();

/** The 404 rule's Stop for a paid World Labs start (review 16 L4): sent once,
 * never settling the run (its uncertain state and unlock stay). If the start
 * registered meanwhile, the Stop reached it and the run is tracked to its end. */
function fencePaidUnknownRun(runId: string, set: GraphSet, get: GraphGet): void {
  if (paidFenceSent.has(runId)) return;
  paidFenceSent.add(runId);
  if (paidFenceSent.size > 1000) paidFenceSent.delete(paidFenceSent.values().next().value!);
  void cancelWithinTimeLimit(runId).then((result) => {
    if (!ownsRun(runId) || result.pendingAdmission) return;
    if (result.status === 'cancelling') {
      updateRunPhase(runId, 'cancelling', set);
      scheduleWorldLabsStatusReconciliation(runId, set, get);
    }
  }, (error: unknown) => {
    // Stop stays on the run; the person's own Stop sends it again.
    console.warn('[nebula] Stop for an uncertain World Labs run failed:', error);
  });
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

/** A node's card title in quotes while it is on the canvas (GM's held-delete
 * line), else nothing: the line then says "the node". */
function namedOnCanvas(nodes: readonly Node<NodeData>[], nodeId: string): string | undefined {
  const label = nodes.find((node) => node.id === nodeId)?.data?.label;
  return typeof label === 'string' && label.trim() ? `\u201c${label}\u201d` : undefined;
}

function nodeHasProviderSafety(state: GraphState, nodeId: string): boolean {
  return state.providerRecoveries.some((checkpoint) => checkpoint.nodeId === nodeId)
    || state.providerStartAmbiguities.some((ambiguity) => ambiguity.nodeId === nodeId);
}

/**
 * The person asked to delete `ids` and the canvas keeps them, because one
 * holds World Labs state (error copy round 3b: a refusal that says nothing
 * is the worst kind). True when it refused: it says why once, in the
 * canvas's short notice (GM, round 15: "Couldn't delete “<node>”. <reason
 * line>" for one node; round 4b's forms for several: lib/worldLabsWaiting
 * heldDeleteText), and sends nothing. An agent's delete
 * goes through the backend, which refuses it with its own text.
 */
function refuseHeldNodeDelete(state: GraphState, ids: string[], set: GraphSet): boolean {
  const held = ids.filter((nodeId) => nodeHasProviderSafety(state, nodeId));
  if (held.length === 0) return false;
  // The backend's order: an unconfirmed start before a recovery record.
  const unlock = held.some((nodeId) => state.providerStartAmbiguities.some((ambiguity) => ambiguity.nodeId === nodeId));
  const name = ids.length === 1 ? namedOnCanvas(state.nodes, ids[0]) : undefined;
  set(noticeLine(state, heldDeleteText(ids.length, unlock, held.length, name)));
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

/** GM - Design, round 4 (one line at 560 px). Only the person reads it: the
 * canvas refuses the copy itself, and agents add nodes, never duplicate. */
const WORLD_LABS_UNSAFE_CLONE_MESSAGE =
  "Couldn't duplicate a paid World Labs node. Add a new one from the Nodes rail instead.";

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
  if (isExecuting || get().runStarting || get().isImportingGraph || source.status === 'running') return;
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

  // A replay of a node's run or a shot is the person's direct run again
  // (Q133; review 3, finding 7): the placeholders still feeding it run, so a
  // paid one asks first in GM's dialog over what the replay sends, and the
  // replay carries the confirmation (the backend refuses it without). A
  // whole-canvas replay skips them. Replays never asked the costly-run
  // question, and still don't.
  const directTarget = source.cinemaShot?.nodeId ?? targetNodeId;
  // A shot's replay names the scene's row after the shot (GM - Design, round 6).
  const replayShot = source.cinemaShot;
  const wording: DirectRunWording = replayShot ? { names: { [replayShot.nodeId]: shotName(
    snapshot.nodes.find((node) => node.id === replayShot.nodeId)?.params?.scene as CinemaSceneSpec | undefined,
    replayShot.shotId) } } : {};
  let agreed: DirectRunConfirmed | null = null;
  if (directTarget) {
    let first = true;
    const shot = source.cinemaShot;
    const names = new Map<string, string>();
    const answer = confirmDirectRun(() => {
      if (!first && (get().isExecuting || get().isImportingGraph)) return null;
      first = false;
      const graph = snapshotCanvas(snapshot, get().nodes, names);
      return shot ? { ...graph, nodes: oneShotCanvas(graph.nodes, shot.nodeId, shot.shotId) } : graph;
    }, directTarget, { passes: shot?.variations ?? 1, costly: false, busy: () => get().isExecuting, ...wording });
    agreed = answer instanceof Promise ? await answer : answer;
    if (!agreed) return;
  } else {
    // A whole-canvas replay sends the saved graph (round 12 addendum b).
    let saved = snapshotCanvas(snapshot, get().nodes);
    // What the refusal reads is known first (review 14, M-B).
    if (runInputsUnknown(saved.nodes, saved.edges, { kind: 'graph' })) {
      await waitForRunInputs(saved.nodes, saved.edges, { kind: 'graph' }, CANVAS_RUN);
      if (get().isExecuting || get().isImportingGraph) return;
      saved = snapshotCanvas(snapshot, get().nodes);
    }
    if (refuseUnchosenModel(saved.nodes, saved.edges, { kind: 'graph' })) return;
  }

  resetExecution();
  const runId = uuidv4();
  const scopeIds = snapshotExecutionScopeIds(snapshot, targetNodeId);
  let before = new Map<string, NodeRunLook>();
  let trimmed: RunRecord[] = [];
  // Registers the replay; again after Nebula's refusal and a yes, unless
  // another run started meanwhile (review 5, L2).
  const begin = (again = false) => {
    if (again && (get().isExecuting || get().isImportingGraph)) return false;
    before = runLookOf(get().nodes, scopeIds);
    const historyBefore = get().runHistory;
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
    trimmed = trimmedBy(historyBefore, get().runHistory);
    pendingStartRunIds.add(runId);
    return true;
  };
  begin();

  try {
    const stillOurs = () => ownsRun(runId) && !cancellationRequestedRunIds.has(runId);
    const shot = source.cinemaShot;
    const result = agreed && directTarget
      ? await sendDirectRun(agreed, directTarget, shot?.variations ?? 1, stillOurs, (placeholders, cost) => (shot
        ? apiGenerateShot(snapshot.nodes, snapshot.edges.map((edge) => ({ ...edge,
          sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })), shot.nodeId,
          shot.shotId, shot.seed, shot.variations, runId, placeholders, cost)
        : apiExecuteNode(snapshot.nodes, snapshot.edges, targetNodeId!, runId, true, undefined, placeholders, cost)),
      { begin: () => begin(true), withdraw: () => withdrawRunStart(runId, set, before, trimmed),
        busy: () => get().isExecuting }, wording)
      : await apiExecuteGraph(snapshot.nodes, snapshot.edges, runId, true);
    if (result === DECLINED) return;
    pendingStartRunIds.delete(runId);
    announcePendingSkips(result);
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
    if (result.status === 'validation_error' && (currentRunId === runId || ownsRun(runId))) {
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({
        nodes: !onItsCanvas ? state.nodes : markNodesWithValidationErrors(
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
    // Not ours any more (it ended), or the graph was replaced since: then it
    // still closes, but marks nothing on the new graph (round 11).
    if (currentRunId !== runId && !ownsRun(runId)) return;
    if (!(err instanceof ExecutionStartRejectedError)) {
      await reconcileWorldLabsExecutionStatus(runId, set, get, err);
      return;
    }
    const onItsCanvas = runOnItsCanvas(runId);
    closeTrackedRun(set, runId, { status: 'failed' });
    set((state) => ({
      nodes: !onItsCanvas ? state.nodes : markNodesErrored(
        state.nodes,
        scopeIds,
        failureMessage(err, "Couldn't start the run."),
        err,
      ),
      ...ownershipState(),
    }));
  }
}

/** The first add on an empty tab couldn't read the backend's graph into it
 * (bringBackendGraphIntoEmptyTab). `raw` is the reason as it came (a network
 * error, the backend's detail or status, a parse error), for the console and
 * the Agent log; the person reads only "Couldn't add “<label>”." (GM). */
class TabSyncFailure extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(raw);
    this.name = 'TabSyncFailure';
    this.raw = raw;
  }
}

/** GM - Design, round 13 of PR #114, verbatim: an add that never reached the
 * backend because the tab never found one. Round 14 (GM) dropped the offline
 * add line ("Couldn't add “Text Input” while Nebula is offline."): offline is
 * read-only, so an add while the banner shows is blocked with no toast
 * (refuseEditWhileOffline), and one whose sync finds the backend gone reads
 * the add heading, as any failed sync does. */
export function addNotConnectedLine(label: string): string {
  return `Couldn't add \u201c${label}\u201d. Nebula isn't connected yet. Try again once it is.`;
}
/** Every add path's heading (GM's quoted form; round 13 made the refused
 * create's unquoted "Couldn't add <label>." match it). */
function addHeading(label: string): string {
  return `Couldn't add \u201c${label}\u201d.`;
}

/** How many graphSyncs this tab has applied (applyGraphSync), so an add's
 * own read of the backend's graph can tell a newer socket sync landed while
 * it was out (review 12, R12-A/B). */
let appliedGraphSyncs = 0;

/**
 * Before the first add on an empty tab: if the backend's canvas has nodes this
 * tab doesn't show (an agent's, or ones a dropped socket missed), bring them in
 * through the normal sync (applyGraphSync), so the add lands beside them. GM
 * approved (round 12 of PR #114): the add syncs and never clears. Until round
 * 12 it sent DELETE /api/graph?force=true here, which wiped an agent's work on
 * the person's first drop and was refused while a run or a World Labs record
 * held the canvas. No toast. Throws TabSyncFailure when the backend's graph
 * can't be read into this tab; the caller then adds nothing, not even locally.
 * The notes for round 12 list how a truly stale stored graph could still arise.
 */
async function bringBackendGraphIntoEmptyTab(
  localCanvasWasEmpty: boolean,
  set: GraphSet,
  get: GraphGet,
): Promise<boolean> {
  if (!localCanvasWasEmpty && !get().backendFreshStartPending) return true;

  const backendWasDiscovered = getCachedBackendBaseUrl() !== null;
  // A socket sync applied after this point is newer than the export below.
  const syncsBefore = appliedGraphSyncs;
  let exportRes: Response;
  try {
    exportRes = await apiFetch('/api/graph/export');
  } catch (err) {
    // Asked again on the next add, until a sync brings the graph in.
    set({ backendFreshStartPending: true });
    // No backend found at all, before or now (false): the caller refuses
    // the add (GM, round 13 of PR #114: local-only adds are refused).
    if (!backendWasDiscovered && getCachedBackendBaseUrl() === null) return false;
    // The backend this tab had found doesn't answer (it went away after the
    // banner's last probe): the add heading, the reason in the Agent log.
    throw new TabSyncFailure(err instanceof Error ? err.message : String(err));
  }
  if (!exportRes.ok) {
    set({ backendFreshStartPending: true });
    const { detail } = await readRefusal(exportRes);
    throw new TabSyncFailure(`HTTP ${exportRes.status}`
      + (detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''));
  }
  let exported: ExecutionEvent & { empty?: boolean; workspaceRevision?: unknown; paramsVersion?: unknown };
  try {
    exported = { ...(await exportRes.json()) as object, type: 'graphSync' } as typeof exported;
  } catch (err) {
    set({ backendFreshStartPending: true });
    throw new TabSyncFailure(err instanceof Error ? err.message : String(err));
  }
  if (exported.empty === false) {
    // Nodes from another project or params version never come into this tab
    // (the socket drops such a sync too); the create itself would be refused
    // as out of date. An empty canvas brings nothing in: the create's own
    // checks apply.
    const notForThisTab = graphNotForThisTab(exported);
    if (notForThisTab) {
      set({ backendFreshStartPending: true });
      throw new TabSyncFailure(notForThisTab);
    }
    // A socket sync landed while the export was out (an agent's Clear or
    // delete): it is the newer state of the same canvas, so the export is
    // never applied over it (review 12, R12-A/B). The tab has the backend's
    // graph already, by that sync.
    if (appliedGraphSyncs === syncsBefore) applyGraphSync(exported, { fromExport: true });
  } else if (appliedGraphSyncs === syncsBefore && !graphNotForThisTab(exported)) {
    // An empty canvas brings nothing in, but its revision is the one the add
    // must name (round 21, C6): adopted, with no clear and no line.
    adoptCanvasRevision(exported.workspaceRevision, (exported as { canvasRevision?: unknown }).canvasRevision);
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
 * itself goes to the console under `heading`, once per call site. A
 * person-only refusal says GM's line for it, by its code (Q116 a); its own
 * words, written for agents, go to the console only. */
async function backendRejectionReason(response: Response, heading: string): Promise<string> {
  const { detail, code } = await readRefusal(response);
  warnFailure(heading, response.status, detail);
  return copyForAnswer(response.status, detail, code);
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
/** An add-and-connect's answer is in: its attempt ends, unless the answer
 * left open whether Nebula made the node (it stays, uncertain). */
function settleConnectedAttempt(attempt: ConnectedNodeCreationAttempt, definiteOutcome: boolean): void {
  if (pendingConnectedNodeCreationAttempt !== attempt) return;
  if (definiteOutcome || attempt.observedNodeId) pendingConnectedNodeCreationAttempt = null;
  else attempt.phase = 'uncertain';
}
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

/** An add that failed before its create was sent. A failed sync of the
 * backend's graph into the tab (TabSyncFailure) reads GM's line, "Couldn't
 * add “<label>”.", with the raw reason in the Agent log and the console (GM,
 * round 12 of PR #114); anything else reads under "Couldn't add {node}.". */
function reportNodeCreationError(displayName: string, err: unknown): null {
  if (err instanceof TabSyncFailure) {
    const heading = addHeading(displayName);
    console.warn(`[nebula] ${heading} ${err.raw}`);
    // The Agent log takes any component's line as this event (agentLogStore,
    // loaded with the app).
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', {
        detail: { source: 'system', message: `${heading} ${err.raw}` } }));
    }
    useGraphStore.getState().notify(heading);
    return null;
  }
  return reportNodeCreationFailure(displayName, failureCopy(err).reason);
}

function reportNodeCreationFailure(displayName: string, reason: string): null {
  const message = `${addHeading(displayName)} ${reason}`;
  console.warn(`[nebula] ${message}`);
  useGraphStore.getState().notify(message);
  return null;
}

/** An add Nebula can't make right now, said before or instead of sending
 * anything: GM's line (round 13 of PR #114), once, as a notice. */
function refuseAdd(line: string): null {
  console.warn(`[nebula] ${line}`);
  useGraphStore.getState().notify(line);
  return null;
}

/**
 * Create one node on the backend where the person put it; graphSync brings
 * it into the canvas with its backend id. Used by every static add (addNode,
 * addCharacterNode, addMoodboardNode: round 12 of PR #114 gave the last two
 * this same path, where they had added the node locally on any failure).
 * A failure says why and adds nothing, not even in this tab. Round 13 of
 * PR #114 (GM): a tab that never found a backend refuses the add too ("Nebula
 * isn't connected yet"; until round 12 it kept the node to itself), and a
 * tab whose banner says Nebula is offline refuses before sending anything.
 */
async function createNodeOnBackend(
  set: GraphSet,
  get: GraphGet,
  definitionId: string,
  params: Record<string, unknown>,
  position: { x: number; y: number },
): Promise<string | null> {
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

  const localCanvasWasEmpty = get().nodes.length === 0 && get().edges.length === 0;

  // Push into cli_graph on the backend so `nebula graph` shows the node to
  // Claude. graphSync will bring it into the canvas with its cli short id.
  // On an empty tab, the backend's own nodes come in first (never a
  // clear); if they can't, nothing is added, not even in this tab.
  let backendFound: boolean;
  try {
    backendFound = await bringBackendGraphIntoEmptyTab(localCanvasWasEmpty, set, get);
  } catch (err) {
    return reportNodeCreationError(definition.displayName, err);
  }
  if (!backendFound) return refuseAdd(addNotConnectedLine(definition.displayName));

  const attempt: NodeCreationAttempt = {
    definitionId,
    displayName: definition.displayName,
    position,
    knownCliNodeIds: new Set(get().nodes.filter((node) => CLI_ID_RE.test(node.id)).map((node) => node.id)),
    phase: 'sending',
  };
  pendingNodeCreationAttempt = attempt;

  // The add's undo step owns the node it made, and nothing else (round 14
  // of PR #114), whatever syncs came meanwhile. It is taken before the
  // request (review 16 of PR #195, M1: its echo can land before the
  // answer, and a Cmd+Z meanwhile waits for it), and owns exactly the node
  // the answer names (endUndoStep's `arrives`; round 21, the #114 merge).
  const step = get().beginUndoStep();
  let made: string | null = null;
  const added = (nodeId: string): string => {
    made = nodeId;
    return nodeId;
  };
  try {
    return await send();
  } finally {
    if (made) get().endUndoStep(step, { arrives: [made] });
    else get().cancelUndoStep(step);
  }

  async function send(): Promise<string | null> {
    const reconcileDispatchedCreate = async (reason: string): Promise<string | null> => {
      attempt.phase = 'uncertain';
      if (attempt.observedNodeId) {
        if (pendingNodeCreationAttempt === attempt) pendingNodeCreationAttempt = null;
        return added(attempt.observedNodeId);
      }
      const reconciledId = await reconcilePendingNodeCreation(set, get);
      if (reconciledId) return added(reconciledId);
      return reportNodeCreationFailure(definition.displayName, reason);
    };

    let res: Response;
    try {
      res = await graphMutationFetch('/api/graph/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params, position }),
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
        await backendRejectionReason(res, addHeading(definition.displayName)),
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
    return added(node.id);
  }
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
 * A sync that turned placeholders normal (Q125 item 3) and isn't this tab's
 * own edit's echo: the steps here forget their flag, so the person's undo of
 * an unrelated step doesn't make them placeholders again (canvasUndo.ts
 * forgetClearedPlaceholders).
 */
function forgetPlaceholdersMadeNormal(state: GraphState, merged: Node<NodeData>[]): void {
  const now = new Map(merged.map((node) => [node.id, node]));
  const cleared = new Set(state.nodes
    .filter((node) => cleanPending(node.data.pending) && now.has(node.id) && !cleanPending(now.get(node.id)!.data.pending))
    .map((node) => node.id));
  forgetClearedPlaceholders([...state.undoStack, ...state.redoStack].filter((entry): entry is ForeignEdit | UndoSnapshot => !isOwnAdd(entry)), cleared);
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
/** Who last changed each setting of each node from outside this tab, by
 * node then key ("label" for its name), for the lines an accepted proposal's
 * partial undo and a dropped rename say (rounds 16 and 17 of PR #114, M5 and
 * review 16 L3). An agent's edit names it; another window of the person's is
 * "you"; a change with no source on it (an outside app, the sync a reconnect
 * starts with) is unknown, so it is never put on an agent. */
const foreignTouches = new Map<string, Map<string, ChangeSource>>();

/** The settings (param keys, and "label" for the name) that differ. */
function touchedKeys(was: Node<NodeData>, now: Node<NodeData>): string[] {
  const before = was.data.params ?? {};
  const after = now.data.params ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !sameValue(before[key], after[key]));
  if (was.data.label !== now.data.label) keys.push('label');
  return keys;
}

/** Note who changed what on each node a sync changed (nodes it kept as they
 * were are the same objects, so they are skipped cheaply). */
function noteForeignTouches(previous: Node<NodeData>[], next: Node<NodeData>[], source: ChangeSource): void {
  const before = new Map(previous.map((node) => [node.id, node]));
  for (const node of next) {
    const was = before.get(node.id);
    if (!was || was === node) continue;
    const keys = touchedKeys(was, node);
    if (keys.length === 0) continue;
    const touches = foreignTouches.get(node.id) ?? new Map<string, ChangeSource>();
    foreignTouches.delete(node.id);
    for (const key of keys) touches.set(key, source);
    foreignTouches.set(node.id, touches);
  }
  while (foreignTouches.size > 2000) foreignTouches.delete(foreignTouches.keys().next().value!);
}

/** Who last changed `key` ("label" for the name) of `nodeId` from outside
 * this tab; unknown when nobody this tab can name did. */
export function lastForeignToucher(nodeId: string, key = 'label'): ChangeSource {
  return foreignTouches.get(nodeId)?.get(key) ?? { kind: 'unknown' };
}

function sourceOf(origin: EditOrigin): ChangeSource {
  const source = foreignSource(origin);
  if (source === 'agent') return { kind: 'agent', name: origin.actor?.name ?? null };
  if (source === 'window') return { kind: 'you' };
  return { kind: 'unknown' };
}

/** One source for every change an undo kept, or unknown when they differ
 * (two agents, an agent and another window) or any one has no source. */
function keptSource(kept: KeptAfterAccept[]): ChangeSource {
  let found: ChangeSource | null = null;
  for (const item of kept) {
    const keys = item.keys.length > 0 ? item.keys : ['*'];
    for (const key of keys) {
      const source = foreignTouches.get(item.nodeId)?.get(key) ?? { kind: 'unknown' as const };
      if (source.kind === 'unknown') return source;
      if (!found) { found = source; continue; }
      const same = found.kind === source.kind && (found.kind !== 'agent'
        || (source.kind === 'agent' && found.name === source.name));
      if (!same) return { kind: 'unknown' };
    }
  }
  return found ?? { kind: 'unknown' };
}

/** GM's partial-undo line for an accepted proposal, from what the undo kept,
 * also written to the Agent log. */
function acceptUndoNoticeText(kept: KeptAfterAccept[], nodes: Node<NodeData>[], nothingUndone: boolean): string {
  const line = acceptUndoLine(kept.map((item) => {
    const node = nodes.find((candidate) => candidate.id === item.nodeId);
    return {
      node: node?.data.label ?? item.nodeId,
      settings: item.keys.length === 0 ? ['settings'] : item.keys.map((key) => key === 'label' ? 'Name'
        : node ? paramLabel(node, key) : key),
      wholeNode: item.wholeNode,
    };
  }), keptSource(kept), nothingUndone);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', { detail: { source: 'system', message: line } }));
  }
  return line;
}

/** A run's own param write-back (round 17 of PR #114, review 16 L3): the
 * accepted proposals' steps take its values as their own, so Undo still
 * reverts them as run output and still removes a node Accept added. */
function rebaseAcceptedSteps(state: GraphState, nextNodes: Node<NodeData>[]): void {
  const steps = state.undoStack.filter((entry): entry is OwnAdd => isOwnAdd(entry) && Boolean(entry.accepted || entry.params));
  if (steps.length === 0) return;
  const before = new Map(state.nodes.map((node) => [node.id, node]));
  for (const node of nextNodes) {
    const was = before.get(node.id);
    if (!was || was === node) continue;
    for (const step of steps) rebaseAcceptedOnRunOutput(step, was, node);
  }
}

function foreignEditStep(
  state: GraphState,
  nextNodes: Node<NodeData>[],
  nextEdges: Edge[],
  origin: EditOrigin | undefined,
  graphReplaced: boolean,
  moved: string[],
  runParams = false,
): Partial<GraphState> {
  const landings = landingsForNextStep;
  landingsForNextStep = null;
  if (origin && isOwnEcho(origin, TAB_ID)) return {};
  if (!origin) {
    if (graphReplaced) return { undoStack: [], redoStack: [] };
    // A run's param write-back is its output; any other change with no
    // source (the sync a reconnect starts with) is nobody's this tab can name.
    if (runParams) rebaseAcceptedSteps(state, nextNodes);
    else noteForeignTouches(state.nodes, nextNodes, { kind: 'unknown' });
    return {};
  }
  noteForeignTouches(state.nodes, nextNodes, sourceOf(origin));
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
  // Taken as last saved while saves were on their way (L-1): it waits for them.
  if (landings && Object.keys(entry.before.nodes).some((id) => landings.some((landing) => landing.nodeId === id))) {
    holdForLandings(entry, landings.filter((landing) => landing.nodeId in entry.before.nodes));
  }
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
 * Review 10, L-2: steps whose backend request is still on its way. A
 * backend delete takes its step before it sends (changeCanvasNodes), as does
 * every beginUndoStep edit (a clear, an upload, an accepted proposal), and
 * the change reaches the canvas only with the answer. An undo of such a step
 * pressed before the answer used to take the step off while it undid nothing
 * yet; the answer then made the change anyway, with a new step and a redo
 * that did nothing. Now that undo waits (heldHistory), and so does every
 * undo or redo pressed after it, in order. When the step's request answers
 * (settleStep) they run: the change is on the canvas by then, so the undo
 * puts it back and tells the backend (sendRestore). A step whose request
 * failed was taken off (cancelUndoStep): the undo aimed at it has nothing to
 * undo, and is dropped. A request that never answers releases them after
 * HOLD_LIMIT_MS, so Cmd+Z is never stuck.
 */
const stepsInFlight = new Set<UndoEntry>();
const HOLD_LIMIT_MS = 15_000;

/*
 * Review 11, M-1 (round 12), and review 12 (round 13): a held press is bound
 * to the step it was pressed for. The old queue replayed its presses against
 * whatever was on top when the step settled, so an agent's edit (or the
 * person's) that landed in between was undone instead (H2, H8, H9, S1).
 *
 * Each held press names its target. The first: the in-flight step on top.
 * A later one: the step below the one the press before it was bound to, as
 * the person sees the stack once that press applies (round 13, L-1); a step
 * that landed above a held press's target is never the target of a later
 * press, and an inverse an earlier press makes is (Cmd+Z then Cmd+Shift+Z).
 *
 * The presses run in order (runHeldPresses). A press whose target is still on
 * its way waits for it (round 13, M-1), even when something else settled on
 * top meanwhile: the person's own older delete answering first is no newer
 * edit (its step stays below, or is re-pushed below the steps still in
 * flight: placeDeleteStep). Once the target has settled, the press applies if
 * the target (or the delete's re-pushed successor of it) is on top of its
 * stack, or under steps of the person's still on their way only: it applies
 * beneath them, and they take its change in (applyHistory). A newer step on top (another actor's, or a later step of the
 * person's that settled above it) drops that press and every one after it,
 * and the notice says so (announceDrop): GM's "Nothing was undone. Your last
 * change was still saving." when none went through, else the restore's own
 * line followed by "1 undo was skipped while a change was saving." So do the
 * 15 s limit (a press is never applied late, L-3) and a project switch (L-4).
 * A target that was taken off (its request failed: cancelUndoStep, a refused
 * delete) drops that press quietly: its failure has its own line (a refused
 * delete's, the model pickers' and chat /clear's, review 12 L-4).
 */
type PressTarget = { entry: UndoEntry } | { inverseOf: number };
/** `order`: when it was pressed, against when each clear was issued (clearSteps). */
interface HeldPress { id: number; action: 'undo' | 'redo'; target: PressTarget | null; order: number }
/** The order presses and clears were issued in (review 13, L-2). */
let historyOrder = 0;
/** The clears' steps (the toolbar's, chat /clear's), by when each was issued.
 * A held press beneath a clear the person issued after it is dropped: the
 * clear supersedes it (review 13, L-2). */
const clearSteps = new WeakMap<UndoEntry, number>();
let heldPresses: HeldPress[] = [];
let heldPressSeq = 0;
/** The inverse each applied held press made, by press id (a later redo's target). */
const heldInverses = new Map<number, UndoEntry>();
/** What the presses held together have done so far: the last one applied
 * (its notice and the step it put on the other stack). */
interface AppliedPress { action: 'undo' | 'redo'; noticeId: number; inverse: UndoEntry }
let batchLastApplied: AppliedPress | null = null;
/** Presses of the batch a clear issued after them superseded while later
 * ones still wait (review 14, L-B): counted into the line the batch ends with. */
let batchSkipped = { undos: 0, redos: 0 };
/** A restore's own line still waiting for its answer (sendRestore), by notice
 * id; and the skipped sentence it is to end with when it shows. */
const ownLinesWaiting = new Set<number>();
const skippedAfter = new Map<number, string>();
/** The skipped sentence a line already showing took, by notice id (a later count goes before it). */
const skippedShown = new Map<number, string>();
/** The step the front press waits for, and its limit. */
let heldFor: UndoEntry | null = null;
let heldTimer: ReturnType<typeof setTimeout> | null = null;
/** A delete whose answer landed under newer settled steps re-pushes its step
 * above them, in its place (placeDeleteStep): a press bound to the old step
 * applies to that one. */
const stepSuccessors = new WeakMap<UndoEntry, UndoEntry>();
/** Nodes a graphSync brought onto the canvas while a step was in flight: a
 * clear's answer never removes them, even under a reused id (L-6, S1). */
const arrivedSince = new WeakMap<UndoEntry, Set<string>>();
/** The nodes each delete step removes (changeCanvasNodes; a re-pushed
 * successor keeps them). An undo applied beneath such a step never brings
 * them back (review 13, M-2: R4). */
const removedBy = new WeakMap<UndoEntry, Set<string>>();
/** A node whose backend delete is on its way, and that delete's step. */
const deletesInFlight = new Map<string, UndoEntry>();
/** The nodes of a delete still on its way that a sync of Nebula's graph took
 * off (its echo, a reconnect), by the delete's step: the delete is done there,
 * whatever its answer says (review 14, L-E). */
const syncRemoved = new WeakMap<UndoEntry, Set<string>>();
/**
 * Review 14, L-D, and review 15 (M-A follow-up, L-1; the coordinator's
 * decision): an undo takes off only the nodes its own step added, whatever
 * the snapshot lacks. A node on the canvas that the step's snapshot doesn't
 * hold stays when the step is undone or redone unless that step put it there.
 *
 * - `stepAdds`: what a step added, when that is known exactly. A delete step
 *   (every delete path: changeCanvasNodes) and a clear add nothing. The step
 *   an undo or redo puts on the other stack (its inverse) added what that
 *   undo or redo brought back (`back` in applyHistory): a redo of a delete's
 *   undo takes off only the nodes the undo restored.
 * - Any other step (the person's typing, a paste, a duplicate, a connect,
 *   an upload) added what the canvas has and its snapshot lacks, except the
 *   nodes that came onto the canvas after it was taken from anywhere else
 *   (`arrivedAfter`): a sync's (an agent's edit, a reconnect: X3, X4), an
 *   undo's or redo's (a delete's undo applied above it: P1, P2, P6, P7).
 *   While a step's own request is on its way, what arrives may be its own
 *   (an upload's node, an accepted proposal's): `arrivedSince` keeps those,
 *   and once it settles every one that isn't its own (`ownArrivals`, the
 *   answer's ids) counts as someone else's.
 */
const stepAdds = new WeakMap<UndoEntry, Set<string>>();
const arrivedAfter = new WeakMap<UndoEntry, Set<string>>();
const ownArrivals = new WeakMap<UndoEntry, Set<string>>();

function markDeleteStep(step: UndoEntry): void {
  if (!stepAdds.has(step)) stepAdds.set(step, new Set());
}

/*
 * Review 16, H1 (round 17; the coordinator's decision): "arrived from
 * elsewhere" is relative to time. A step owns what its own change added, and
 * keeps owning it whatever happens to those nodes later: a delete and its
 * undo, a stale echo taking a node off and the next one bringing it back.
 * Round 16 counted every node an undo put back as someone else's for every
 * step, so undoing a paste, a duplicate, a connect or an upload after
 * deleting its node and undoing that delete took nothing off, and the step
 * was dropped as dead (A2, A3, A4, U1, A10).
 *
 * - A step's additions are fixed once its change is complete (`fixAdds`):
 *   for the person's own snapshot step, when a newer step lands above it
 *   (read off the canvas just before that step, less what arrived from
 *   elsewhere meanwhile); for a step whose request was on its way, when it
 *   settles: exactly the nodes its answer named (`ownArrivals`), or none.
 * - Until then (the newest step, while it is on top), what reaches the
 *   canvas from elsewhere is noted against it (`arrivedAfter`): a sync's
 *   nodes (X3, X4), and the nodes an undo or redo puts back only for the
 *   steps taken after the change it undoes (above it, or jumped over by its
 *   re-pushed delete: P1, P7). An older step is never told.
 */
function fixAdds(entry: UndoEntry, nodes: Node<NodeData>[]): void {
  if (isSliceStep(entry) || stepAdds.has(entry) || stepsInFlight.has(entry)) return;
  const held = new Set(entry.nodes.map((node) => node.id));
  const elsewhere = arrivedAfter.get(entry);
  stepAdds.set(entry, new Set(nodes.map((node) => node.id).filter((id) => !held.has(id) && !elsewhere?.has(id))));
}

/** Store listener: a newer step landed above a step (pushed, or a delete's
 * step re-pushed above it): that step's change is complete, on the canvas as
 * it was just before. */
function fixAddsBelowNewSteps(state: GraphState, previous: GraphState): void {
  if (state.undoStack === previous.undoStack) return;
  const before = new Set(previous.undoStack);
  let newerAbove = false;
  for (let index = state.undoStack.length - 1; index >= 0; index -= 1) {
    const entry = state.undoStack[index];
    if (!before.has(entry)) newerAbove = true;
    else if (newerAbove) fixAdds(entry, previous.nodes);
  }
}

/** Nodes that came onto the canvas from anywhere but a step's own change, for
 * `steps` (default: every step whose additions aren't fixed yet). */
function noteArrivedElsewhere(ids: Iterable<string>, get: GraphGet, steps?: Iterable<UndoEntry>): void {
  const arrived = [...ids];
  if (arrived.length === 0) return;
  const { undoStack, redoStack } = get();
  for (const entry of steps ?? [...undoStack, ...redoStack]) {
    if (isForeignEdit(entry) || stepAdds.has(entry) || stepsInFlight.has(entry)) continue;
    const seen = arrivedAfter.get(entry) ?? new Set<string>();
    for (const id of arrived) seen.add(id);
    arrivedAfter.set(entry, seen);
  }
}

/** A step whose request was on its way has settled: it added exactly what its
 * answer named as its own (an upload's node, an accepted proposal's, an added
 * node). */
function settleArrivals(step: UndoEntry): void {
  if (stepAdds.has(step) || isForeignEdit(step)) return;
  const own = ownArrivals.get(step);
  // An answer that named none: what it added is read off the canvas, as for
  // any step, until a newer step lands above it.
  if (own) stepAdds.set(step, new Set(own));
}

/** `step` added `ids` (its answer names them): never someone else's for it. */
function claimAdds(step: UndoEntry, ids: string[], replaces?: string): void {
  const known = stepAdds.get(step);
  if (known) {
    if (replaces) known.delete(replaces);
    for (const id of ids) known.add(id);
  }
  const elsewhere = arrivedAfter.get(step);
  if (elsewhere) for (const id of ids) elsewhere.delete(id);
}

/**
 * Round 17's property test: a held press passes over a step that changes
 * nothing now because a step above it took its nodes off (an upload, then a
 * delete of its node before the answers). The step leaves the stack, and the
 * step just above it, whose snapshot holds those nodes, takes them as its
 * own: undoing the delete brings them back, and undoing that step takes them
 * off again, so no node is left that no undo takes off.
 */
function handAddsUp(dead: UndoEntry, above: UndoEntry, nodes: Node<NodeData>[]): void {
  if (isSliceStep(dead) || isSliceStep(above)) return;
  const adds = stepAdds.get(dead) ?? ownArrivals.get(dead) ?? takenOffBy(dead, nodes);
  const moved = new Set([...adds].filter((id) => above.nodes.some((node) => node.id === id)));
  if (moved.size === 0) return;
  above.nodes = above.nodes.filter((node) => !moved.has(node.id));
  above.edges = above.edges.filter((edge) => !moved.has(edge.source) && !moved.has(edge.target));
  const known = stepAdds.get(above);
  if (known) for (const id of moved) known.add(id);
  else if (stepsInFlight.has(above)) ownArrivals.set(above, new Set([...(ownArrivals.get(above) ?? []), ...moved]));
  else claimAdds(above, [...moved]);
}

/** The nodes undoing (or redoing) `entry` may take off the canvas: only those its step added. */
function takenOffBy(entry: UndoSnapshot, nodes: Node<NodeData>[]): Set<string> {
  const held = new Set(entry.nodes.map((node) => node.id));
  const known = stepAdds.get(entry);
  if (known) return new Set([...known].filter((id) => !held.has(id)));
  const elsewhere = arrivedAfter.get(entry);
  return new Set(nodes.map((node) => node.id).filter((id) => !held.has(id) && !elsewhere?.has(id)));
}
/** The settled steps a re-pushed delete step went above (placeDeleteStep).
 * The delete was sent before them, so it is no newer edit than they are: a
 * press bound to one of them still applies beneath it (review 13, L-1). */
const jumpedOver = new WeakMap<UndoEntry, Set<UndoEntry>>();

/**
 * Review 13, M-2 and L-3: this tab's own graphSync can take a delete's nodes
 * off before its answer comes, and that is when the delete's change lands.
 * Its step is placed then (placeDeleteStep), exactly as the answer would have
 * placed it: the person's steps taken after the delete was sent lose the
 * nodes now, so no undo of one of them, held or not, brings a deleted node
 * back to the canvas and to Nebula; a step that settled before the echo (an
 * agent's edit, the person's typing) is older than the delete, so the
 * delete's step goes above it, still on its way until the answer.
 */
function placeEchoedDeletes(state: GraphState, kept: ReadonlySet<string>, set: GraphSet, get: GraphGet): void {
  if (stepsInFlight.size === 0) return;
  const byStep = new Map<UndoEntry, string[]>();
  for (const node of state.nodes) {
    if (kept.has(node.id)) continue;
    const step = deletesInFlight.get(node.id);
    if (!step || !stepsInFlight.has(step)) continue;
    byStep.set(step, [...(byStep.get(step) ?? []), node.id]);
  }
  for (const [step, removed] of byStep) placeDeleteStep(successorOf(step), removed, set, get, { echo: true });
}

/** A sync of Nebula's graph (any: its own echo, an agent's, a reconnect's)
 * that takes off a node whose delete is on its way: that delete is done in
 * Nebula's graph (review 14, L-E). */
function noteSyncRemovals(state: GraphState, kept: ReadonlySet<string>): void {
  if (deletesInFlight.size === 0) return;
  for (const node of state.nodes) {
    if (kept.has(node.id)) continue;
    const step = deletesInFlight.get(node.id);
    if (!step) continue;
    const gone = syncRemoved.get(step) ?? new Set<string>();
    gone.add(node.id);
    syncRemoved.set(step, gone);
  }
}

/** A sync without a node whose delete is on its way: that delete is done in
 * Nebula's graph (the node left the canvas when Delete was pressed, so
 * noteSyncRemovals no longer sees it go). */
function noteDeletesGoneBySync(incoming: Array<{ id: string }>): void {
  if (deletesInFlight.size === 0) return;
  const present = new Set(incoming.map((node) => node.id));
  for (const [id, step] of deletesInFlight) {
    if (present.has(id)) continue;
    const gone = syncRemoved.get(step) ?? new Set<string>();
    gone.add(id);
    syncRemoved.set(step, gone);
  }
}

/** The graph a step was taken in (canvasReplacementRevision). */
const stepRevisions = new WeakMap<UndoEntry, number>();
/** Steps whose answer is in but whose change arrives with their echo (an
 * upload's node: L-2): they settle when those nodes are on the canvas. */
const awaitingArrival = new Map<UndoEntry, { ids: string[]; timer: ReturnType<typeof setTimeout> }>();

function holdStep(step: UndoEntry): void {
  stepsInFlight.add(step);
  arrivedSince.set(step, new Set());
  stepRevisions.set(step, canvasReplacementRevision);
}

/** Whether `step` was taken in the graph on the canvas now (no project switch or load since). */
function sameGraphAs(step: UndoEntry): boolean {
  return (stepRevisions.get(step) ?? canvasReplacementRevision) === canvasReplacementRevision;
}

/** Whether a clear taken as `step` removes the node `id`: one it sent (on
 * the canvas when the step began) that no sync has brought back since. */
function clearedBy(step: UndoEntry, id: string): boolean {
  if (isSliceStep(step)) return false;
  return step.nodes.some((node) => node.id === id) && !arrivedSince.get(step)?.has(id);
}

/**
 * Review 14, L-C: the steps taken while a clear was on its way (above its
 * step, and every redo step, all made since it was sent) were taken of a
 * canvas that still had the nodes it removes: they lose them when it
 * lands, as a delete's echo strips the steps above it (placeDeleteStep), so
 * undoing one never brings a cleared node back. `clears`: which of the
 * clear's nodes it removes (chat /clear takes only Nebula's).
 */
function stripClearedFromLaterSteps(step: UndoEntry, get: GraphGet, clears: (id: string) => boolean): void {
  if (isSliceStep(step)) return;
  const gone = new Set(step.nodes.filter((node) => clears(node.id) && clearedBy(step, node.id)).map((node) => node.id));
  if (gone.size === 0) return;
  const { undoStack, redoStack } = get();
  const at = undoStack.indexOf(step);
  const strip = (entry: UndoEntry) => {
    if (entry === step || isSliceStep(entry)) return;
    entry.nodes = entry.nodes.filter((node) => !gone.has(node.id));
    entry.edges = entry.edges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target));
  };
  if (at >= 0) for (const entry of undoStack.slice(at + 1)) strip(entry);
  for (const entry of redoStack) strip(entry);
}

/** The step a press bound to `entry` applies to: a delete's re-pushed successor of it. */
function successorOf(entry: UndoEntry): UndoEntry {
  let current = entry;
  for (let next = stepSuccessors.get(current); next && next !== current; next = stepSuccessors.get(current)) current = next;
  return current;
}

/**
 * Review 12 (round 13), M-1 and L-5: where a backend delete's step goes when
 * its answer takes nodes off the canvas. The step was taken when the delete
 * was sent, with the nodes still there; every step of the person's taken
 * after it, while it was on its way, holds them too.
 * - Only steps still on their way above it (or none): it stays where it is.
 *   Those steps' change lands after this delete now, so they no longer hold
 *   the deleted nodes; and what landed while it was on its way (an upload's
 *   node) is part of the canvas it puts back.
 * - Settled steps above it (an agent's edit, the person's typing): the
 *   delete's change lands after them, so its step goes above them, taken of
 *   the canvas now, in its own place (it replaces the old step: no dead
 *   Cmd+Z later), below the steps still on their way, which no longer hold
 *   the deleted nodes. It keeps what the delete removed (its removals).
 */
function placeDeleteStep(undoStep: UndoEntry | undefined, removed: string[], set: GraphSet, get: GraphGet,
  options: { echo?: boolean } = {}): void {
  const { undoStack, nodes, edges } = get();
  const at = undoStep ? undoStack.indexOf(undoStep) : -1;
  // Its echo took the nodes off with its step no longer on the stack: nothing to place.
  if (options.echo && at < 0) return;
  if (!undoStep || at < 0) {
    // No step of its own on the stack (none taken, or it left it): one now.
    const successor = pushUndo(set, get);
    // A delete's step: it adds nothing (review 15, M-A follow-up).
    markDeleteStep(successor);
    if (undoStep) {
      if (undoStep.removals) successor.removals = undoStep.removals;
      keepRemovedNodes(successor, undoStep, nodes);
      succeed(undoStep, successor, new Set());
    }
    return;
  }
  // The change lands now (its answer, or its echo before that), on the canvas as it is.
  let settledAbove = undoStack.length - 1;
  while (settledAbove > at && stepsInFlight.has(undoStack[settledAbove])) settledAbove -= 1;
  let placed = at;
  if (settledAbove === at) {
    // What arrived before its change.
    renewWithArrivals(undoStep, nodes, edges);
  } else {
    const successor = createSnapshot(nodes, edges);
    if (undoStep.removals) successor.removals = undoStep.removals;
    // An earlier echo of the same gesture took some of its nodes off already
    // (review 14, M-A): the step re-pushed now still brings them back.
    keepRemovedNodes(successor, undoStep, nodes);
    const stack = [...undoStack.slice(0, at), ...undoStack.slice(at + 1, settledAbove + 1), successor,
      ...undoStack.slice(settledAbove + 1)];
    succeed(undoStep, successor, new Set(undoStack.slice(at + 1, settledAbove + 1)));
    placed = settledAbove;
    set({ undoStack: stack, redoStack: [] });
  }
  const gone = new Set(removed);
  const strip = (entry: UndoEntry) => {
    if (isSliceStep(entry)) return;
    entry.nodes = entry.nodes.filter((node) => !gone.has(node.id));
    entry.edges = entry.edges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target));
  };
  for (const entry of get().undoStack.slice(placed + 1)) if (stepsInFlight.has(entry)) strip(entry);
  // Every redo step was made while this delete was on its way (a step taken
  // clears them), from a canvas that still had its nodes: a redo never brings
  // them back (review 12 probe H4: an undo applied beneath this delete).
  for (const entry of get().redoStack) strip(entry);
}

/**
 * Review 14, M-A: a multi-node delete sends one request per node, so each
 * node's echo can come on its own, with an agent's edit or the person's
 * typing between them. Each echo that re-pushes the step takes a snapshot
 * of the canvas at that moment, which no longer has the nodes the earlier
 * echoes took off. The step re-pushed (`successor`) keeps every node the
 * gesture removed that is off the canvas now, as `step` held it, with its
 * wires among the nodes it holds: one delete gesture is one undo step that
 * brings back every node it removed.
 */
function keepRemovedNodes(successor: UndoEntry, step: UndoEntry, here: Node<NodeData>[]): void {
  const removed = removedBy.get(step);
  if (!removed || removed.size === 0 || isSliceStep(step) || isSliceStep(successor)) return;
  const present = new Set(here.map((node) => node.id));
  const held = new Set(successor.nodes.map((node) => node.id));
  const back = step.nodes.filter((node) => removed.has(node.id) && !present.has(node.id) && !held.has(node.id));
  if (back.length === 0) return;
  const copy = createSnapshot(back, []);
  successor.nodes = [...successor.nodes, ...copy.nodes];
  for (const node of back) held.add(node.id);
  const added = new Set(back.map((node) => node.id));
  const wired = new Set(successor.edges.map((edge) => edge.id));
  successor.edges = [...successor.edges, ...step.edges.filter((edge) => !wired.has(edge.id)
    && (added.has(edge.source) || added.has(edge.target)) && held.has(edge.source) && held.has(edge.target))
    .map((edge) => ({ ...edge }))];
}

/** `successor` takes `step`'s place: what it removes, the steps it went
 * above, and (its delete still on its way, after an echo) being in flight. */
function succeed(step: UndoEntry, successor: UndoEntry, over: Set<UndoEntry>): void {
  stepSuccessors.set(step, successor);
  const removes = removedBy.get(step);
  if (removes) removedBy.set(successor, new Set(removes));
  const adds = stepAdds.get(step);
  if (adds) stepAdds.set(successor, new Set(adds));
  jumpedOver.set(successor, new Set([...(jumpedOver.get(step) ?? []), ...over]));
  if (stepsInFlight.has(step)) {
    stepsInFlight.add(successor);
    arrivedSince.set(successor, new Set(arrivedSince.get(step) ?? []));
    stepRevisions.set(successor, stepRevisions.get(step) ?? canvasReplacementRevision);
  }
}

/** A step taken before its change landed takes in the nodes (and their
 * wires) that arrived while it was on its way: they were on the canvas
 * before its change, so undoing it keeps them (P4b: an upload's node). */
function renewWithArrivals(step: UndoEntry, nodes: Node<NodeData>[], edges: Edge[]): void {
  if (isSliceStep(step)) return;
  const arrived = arrivedSince.get(step);
  if (!arrived || arrived.size === 0) return;
  const held = new Set(step.nodes.map((node) => node.id));
  const fresh = nodes.filter((node) => arrived.has(node.id) && !held.has(node.id));
  if (fresh.length === 0) return;
  for (const node of fresh) held.add(node.id);
  const copy = createSnapshot(fresh, []);
  step.nodes = [...step.nodes, ...copy.nodes];
  const wired = new Set(step.edges.map((edge) => edge.id));
  const added = new Set(fresh.map((node) => node.id));
  step.edges = [...step.edges, ...edges.filter((edge) => !wired.has(edge.id)
    && (added.has(edge.source) || added.has(edge.target)) && held.has(edge.source) && held.has(edge.target))
    .map((edge) => ({ ...edge }))];
}

function settleStep(step: UndoEntry, set: GraphSet, get: GraphGet): void {
  // And the step it became, if its echo re-pushed it (placeEchoedDeletes).
  for (let current: UndoEntry | undefined = step; current; current = stepSuccessors.get(current)) {
    if (stepsInFlight.has(current)) {
      settleArrivals(current);
      stripOwnArrivalsBelow(current, get);
    }
    stepsInFlight.delete(current);
    if (stepSuccessors.get(current) === current) break;
  }
  const waiting = awaitingArrival.get(step);
  if (waiting) {
    clearTimeout(waiting.timer);
    awaitingArrival.delete(step);
  }
  runHeldPresses(set, get);
}

/**
 * Round 17's property test: a step below `step` on the stack is a canvas
 * from before `step`'s change, so it never holds a node `step` added. One
 * can, when it was taken while `step` was on its way and its node had come
 * with its echo (a delete's step re-pushed beneath it: placeDeleteStep);
 * undoing it after undoing `step` would bring that node back.
 */
function stripOwnArrivalsBelow(step: UndoEntry, get: GraphGet): void {
  const own = ownArrivals.get(step);
  if (!own || own.size === 0) return;
  const { undoStack } = get();
  const at = undoStack.indexOf(step);
  for (const entry of undoStack.slice(0, Math.max(0, at))) {
    if (isSliceStep(entry) || ![...own].some((id) => entry.nodes.some((node) => node.id === id))) continue;
    entry.nodes = entry.nodes.filter((node) => !own.has(node.id));
    entry.edges = entry.edges.filter((edge) => !own.has(edge.source) && !own.has(edge.target));
  }
}

/** The step's answer is in, and the nodes it adds (`ids`) come with its echo. */
function awaitArrival(step: UndoEntry, ids: string[], set: GraphSet): void {
  // A change that never arrives releases the step after the limit; a press
  // bound to it is dropped, never applied to a step that changed nothing.
  const timer = setTimeout(() => {
    awaitingArrival.delete(step);
    if (stepsInFlight.has(step)) settleArrivals(step);
    stepsInFlight.delete(step);
    if (heldFor === step) announceDrop(set, dropHeldPresses());
  }, HOLD_LIMIT_MS);
  awaitingArrival.set(step, { ids, timer });
}

/** After a graphSync: what it brought counts as arrived for each step in
 * flight, and a step waiting for its echo settles once its nodes are here. */
function noteSyncArrivals(before: Node<NodeData>[], after: Node<NodeData>[], set: GraphSet, get: GraphGet): void {
  const had = new Set(before.map((node) => node.id));
  const added = after.filter((node) => !had.has(node.id)).map((node) => node.id);
  if (added.length > 0) {
    for (const step of stepsInFlight) {
      const arrived = arrivedSince.get(step);
      if (arrived) for (const id of added) arrived.add(id);
    }
    // No settled step added them (review 15, L-1: X3, X4).
    noteArrivedElsewhere(added, get);
  }
  if (awaitingArrival.size === 0) return;
  const present = new Set(after.map((node) => node.id));
  for (const [step, { ids }] of [...awaitingArrival]) {
    if (ids.every((id) => present.has(id))) settleStep(step, set, get);
  }
}

/** What dropping the held presses left to say: how many were dropped, and
 * the last one of their batch that went through, if any. */
interface DroppedPresses { undos: number; redos: number; applied: AppliedPress | null }

/** Drops every held press (the batch ends); announceDrop says so. */
function dropHeldPresses(): DroppedPresses {
  const undos = heldPresses.filter((press) => press.action === 'undo').length;
  const dropped = { undos: undos + batchSkipped.undos, redos: heldPresses.length - undos + batchSkipped.redos,
    applied: batchLastApplied };
  heldPresses = [];
  endHeldBatch();
  return dropped;
}

function endHeldBatch(): void {
  heldInverses.clear();
  batchLastApplied = null;
  batchSkipped = { undos: 0, redos: 0 };
  heldFor = null;
  if (heldTimer !== null) clearTimeout(heldTimer);
  heldTimer = null;
}

/**
 * The notice for dropped presses (GM - Design, round 12 addendum a, and
 * round 13). None of the batch went through: "Nothing was undone. Your last
 * change was still saving." Some did: the restore's own line, then "1 undo
 * was skipped while a change was saving." (Redo stays, since something was
 * restored). The line still waiting for the restore's answer takes it when it
 * shows (sendRestore); one already showing takes it now; with no line of its
 * own (a param edit undone), the sentence shows alone, with Redo.
 */
function announceDrop(set: GraphSet, { undos, redos, applied }: DroppedPresses): void {
  if (undos + redos === 0) return;
  if (!applied) {
    // GM, round 14, item 3: redos only, "Nothing was redone. …"; else the undo line.
    set((state) => besideFailure(state, undos === 0 ? DROPPED_REDO_TEXT : DROPPED_UNDO_TEXT));
    return;
  }
  const sentence = skippedPressText(undos, redos);
  if (ownLinesWaiting.has(applied.noticeId)) {
    skippedAfter.set(applied.noticeId, sentence);
    return;
  }
  set((state) => {
    const shown = state.undoNotice;
    if (shown && shown.id === applied.noticeId) {
      skippedShown.set(applied.noticeId, sentence);
      return { undoNotice: { ...shown, text: `${shown.text} ${sentence}` } };
    }
    const offer = applied.action === 'undo' ? 'redo' as const : 'undo' as const;
    const stack = offer === 'redo' ? state.redoStack : state.undoStack;
    if (stack[stack.length - 1] === applied.inverse && !shown?.offer && shown?.tone !== 'error') {
      return { undoNotice: { id: ++undoNoticeSeq, text: sentence, offer, entry: applied.inverse } };
    }
    return besideFailure(state, sentence);
  });
}

/** A skipped or dropped press's line (review 15, L-2): beside a failure the
 * canvas notice shows (a refused delete's "Couldn't delete the node. …"),
 * never over it, since that line says why the press had nothing to undo. */
function besideFailure(state: Pick<GraphState, 'undoNotice'>, text: string): Partial<GraphState> {
  if (state.undoNotice?.tone === 'error') return { messageNotice: { id: ++undoNoticeSeq, text, tone: 'info' } };
  return noticeLine(state, text, 'info');
}

/** Another graph is on the canvas (a project opened, a graph loaded): the
 * presses held for the old one's steps are dropped, and its steps no longer
 * hold anything here, so a press in the new graph never waits (L-4). The
 * caller announces the drop once the new graph is on the canvas, so the
 * line isn't cleared or covered by that graph's own notice (review 12, L-2). */
function forgetStepsInFlight(): DroppedPresses {
  const dropped = dropHeldPresses();
  stepsInFlight.clear();
  deletesInFlight.clear();
  deferredParamPushes.clear();
  heldCopies.clear();
  for (const { timer } of awaitingArrival.values()) clearTimeout(timer);
  awaitingArrival.clear();
  return dropped;
}

/** The entry a press is bound to, once the presses before it ran; undefined
 * when that was an earlier press that did nothing. */
function pressTarget(press: HeldPress): UndoEntry | undefined {
  if (!press.target) return undefined;
  return 'entry' in press.target ? press.target.entry : heldInverses.get(press.target.inverseOf);
}

/** Whether a step above a press's target lets the press apply beneath it:
 * one of the person's steps still on its way (its change lands after this
 * one), or the person's own delete re-pushed above the target because its
 * answer came late (it was sent first, so it is no newer edit: L-1). */
function staysAbove(step: UndoEntry, target: UndoEntry): boolean {
  return stepsInFlight.has(step) || Boolean(jumpedOver.get(step)?.has(target));
}

function sameTarget(a: PressTarget, b: PressTarget): boolean {
  if ('entry' in a && 'entry' in b) return a.entry === b.entry || a.entry === successorOf(b.entry);
  return 'inverseOf' in a && 'inverseOf' in b && a.inverseOf === b.inverseOf;
}

/** What a new press is bound to (round 13, L-1): each held press takes its
 * target off its stack, with everything that landed above it, and puts its
 * inverse on the other stack; the new press takes what is then on top. */
function nextPressTarget(action: 'undo' | 'redo', state: GraphState): PressTarget | null {
  let undo: PressTarget[] = state.undoStack.map((entry) => ({ entry }));
  let redo: PressTarget[] = state.redoStack.map((entry) => ({ entry }));
  for (const press of heldPresses) {
    const from = press.action === 'undo' ? undo : redo;
    const at = press.target ? from.findIndex((target) => sameTarget(target, press.target!)) : -1;
    if (at < 0) continue; // it goes to nothing, so it makes no inverse
    const inverse: PressTarget = { inverseOf: press.id };
    // The person's steps still on their way above it stay (it applies beneath
    // them); anything else above it drops the press.
    const bound = from[at];
    const left = [...from.slice(0, at), ...from.slice(at + 1)
      .filter((target) => 'entry' in target && 'entry' in bound && staysAbove(target.entry, bound.entry))];
    if (press.action === 'undo') {
      undo = left;
      redo = [...redo, inverse];
    } else {
      redo = left;
      undo = [...undo, inverse];
    }
  }
  return (action === 'undo' ? undo : redo).at(-1) ?? null;
}

function waitFor(step: UndoEntry, set: GraphSet): void {
  if (heldFor === step) return;
  heldFor = step;
  if (heldTimer !== null) clearTimeout(heldTimer);
  // The limit drops the presses (L-3): a late answer is then an ordinary step.
  heldTimer = setTimeout(() => {
    heldTimer = null;
    if (heldFor === step) announceDrop(set, dropHeldPresses());
  }, HOLD_LIMIT_MS);
}

/** Runs the held presses whose step has settled, in order (see above). */
function runHeldPresses(set: GraphSet, get: GraphGet): void {
  while (heldPresses.length > 0) {
    const press = heldPresses[0];
    const wanted = pressTarget(press);
    if (wanted === undefined) {
      // An earlier press it would have reversed did nothing: neither does
      // this one, and the line says so (review 15, L-2). A press with nothing
      // to bind to when it was pressed (an empty stack) stays quiet, as
      // Cmd+Z on an empty stack always is.
      heldPresses.shift();
      if (press.target) skipPress(press);
      continue;
    }
    if (stepsInFlight.has(wanted)) {
      // Its own step is still on its way: whatever settled meanwhile, wait.
      waitFor(wanted, set);
      return;
    }
    const entry = successorOf(wanted);
    const state = get();
    const stack = press.action === 'undo' ? state.undoStack : state.redoStack;
    const at = stack.indexOf(entry);
    // A clear the person issued after this press supersedes it (review 13,
    // L-2): the canvas ends as the clear leaves it. Only the presses issued
    // before that clear (review 14, L-B): one pressed after it targets the
    // clear (or what is above it) and runs once the clear settles.
    const clearedAt = at < 0 ? -1 : Math.max(-1, ...stack.slice(at + 1).map((above) => clearSteps.get(above) ?? -1));
    if (clearedAt > press.order) {
      const superseded = heldPresses.filter((held) => held.order < clearedAt);
      heldPresses = heldPresses.filter((held) => held.order > clearedAt);
      const undos = superseded.filter((held) => held.action === 'undo').length;
      batchSkipped = { undos: batchSkipped.undos + undos, redos: batchSkipped.redos + superseded.length - undos };
      if (heldPresses.length === 0) {
        announceDrop(set, dropHeldPresses());
        return;
      }
      continue;
    }
    // On top, or under steps of the person's still on their way only (their
    // change lands after this one: review 12 probe H4, delete, Cmd+Z, delete
    // again before the first answer), or under the person's own older delete
    // re-pushed by its late answer (L-1): it applies beneath them (applyHistory).
    if (at >= 0 && stack.slice(at + 1).every((above) => staysAbove(above, entry))) {
      if (changesNothing(entry, state.nodes, state.edges)) {
        // Nothing it changed is left to change (review 15, L-2): the step
        // goes, and the press goes to the step below it, unless a later
        // press is already bound to that one; then it counts as skipped.
        // Never silent. Its nodes a step above holds go to that step (handAddsUp).
        if (press.action === 'undo' && at + 1 < stack.length) handAddsUp(entry, stack[at + 1], state.nodes);
        set(press.action === 'undo' ? { undoStack: stack.filter((step) => step !== entry) }
          : { redoStack: stack.filter((step) => step !== entry) });
        const below = at > 0 ? stack[at - 1] : undefined;
        const taken = heldPresses.slice(1).some((held) => held.target && below
          && sameTarget(held.target, { entry: below }));
        if (below && !taken) {
          press.target = { entry: below };
          continue;
        }
        heldPresses.shift();
        skipPress(press);
        continue;
      }
      heldPresses.shift();
      const done = applyHistory(press.action, set, get, entry);
      if (done) {
        heldInverses.set(press.id, done.inverse);
        batchLastApplied = { action: press.action, noticeId: done.noticeId, inverse: done.inverse };
      }
      continue;
    }
    if (state.undoStack.includes(entry) || state.redoStack.includes(entry)) {
      // A newer step landed on top of it: never undo that one instead.
      announceDrop(set, dropHeldPresses());
      return;
    }
    // Its step was taken off (the request failed, and said so): this press
    // goes to nothing, the presses after it still count. It counts in the
    // skipped line, beside the failure's own (review 15, L-2: C7).
    heldPresses.shift();
    skipPress(press);
  }
  // Presses a clear superseded while later ones waited: the line says so (L-B).
  if (batchSkipped.undos + batchSkipped.redos > 0) announceDrop(set, { ...batchSkipped, applied: batchLastApplied });
  endHeldBatch();
}

/** A held press that did nothing: counted into the line its batch ends with. */
function skipPress(press: HeldPress): void {
  batchSkipped = press.action === 'undo'
    ? { ...batchSkipped, undos: batchSkipped.undos + 1 } : { ...batchSkipped, redos: batchSkipped.redos + 1 };
}

/** Whether an undo pressed now would go to a delete still on its way (the
 * step on top, or the one the held presses leave on top). */
function pressHitsDeleteInFlight(state: GraphState): boolean {
  const target = heldPresses.length > 0 ? nextPressTarget('undo', state) : (() => {
    const top = state.undoStack[state.undoStack.length - 1];
    return top ? { entry: top } : null;
  })();
  if (!target || !('entry' in target)) return false;
  const entry = target.entry;
  return stepsInFlight.has(entry) && Boolean(removedBy.get(entry)?.size) && !clearSteps.has(entry);
}

/** Whether this press waits for a step's answer (and is queued, bound to its target). */
function holdsHistory(action: 'undo' | 'redo', state: GraphState, set: GraphSet): boolean {
  if (heldPresses.length > 0) {
    heldPresses.push({ id: ++heldPressSeq, action, target: nextPressTarget(action, state), order: ++historyOrder });
    return true;
  }
  const top = state.undoStack[state.undoStack.length - 1];
  if (action !== 'undo' || !top || !stepsInFlight.has(top)) return false;
  endHeldBatch();
  heldPresses = [{ id: ++heldPressSeq, action, target: { entry: top }, order: ++historyOrder }];
  waitFor(top, set);
  return true;
}

/**
 * One undo or redo. An undo of a step whose request is on its way waits for
 * it (holdsHistory); otherwise it applies now (applyHistory).
 */
function stepHistory(action: 'undo' | 'redo', set: GraphSet, get: GraphGet): void {
  const state = get();
  if (state.isExecuting || state.providerRecoveries.length > 0 || state.providerStartAmbiguities.length > 0) return;
  // Review 15, L-2: a step with nothing left to change never takes a press.
  dropDeadSteps(action, set, get);
  // GM r18, item 2 (option (c)): "Cmd+Z while the delete is in flight shows
  // the existing "Nothing was undone. Your last change was still saving.""
  // The press isn't held for the delete's answer, and is never applied late.
  if (action === 'undo' && pressHitsDeleteInFlight(get())) {
    set((now) => besideFailure(now, DROPPED_UNDO_TEXT));
    return;
  }
  if (holdsHistory(action, get(), set)) return;
  applyHistory(action, set, get);
  // And none is left on top of it for the next one (the Undo control greys out).
  dropDeadSteps(action, set, get);
}

/**
 * The step leaves its stack and its inverse goes on the other one: a
 * snapshot's inverse is a snapshot of the canvas now; a foreign edit is its
 * own inverse (undo puts back its `before`, redo its `after`). Then the
 * backend is told (sendRestore), and an agent's edit says so. Returns the
 * inverse and the id of the notice it shows (or will show, once the restore
 * answers), or null when nothing was there to undo or redo.
 */
function applyHistory(action: 'undo' | 'redo', set: GraphSet, get: GraphGet, target?: UndoEntry): { inverse: UndoEntry; noticeId: number } | null {
  const state = get();
  if (state.isExecuting || state.providerRecoveries.length > 0 || state.providerStartAmbiguities.length > 0) return null;
  const from = action === 'undo' ? state.undoStack : state.redoStack;
  const at = target ? from.indexOf(target) : from.length - 1;
  const entry = from[at];
  if (!entry) return null;
  // A held press applied beneath steps still on their way (runHeldPresses).
  const above = from.slice(at + 1);
  const { nodes, edges } = state;
  let next: { nodes: Node<NodeData>[]; edges: Edge[] };
  let inverse: UndoEntry;
  let keptLine: string | null = null;
  if (isSliceStep(entry)) {
    // An own add is read from the canvas as it is undone, so Redo brings its
    // nodes back as they are now (lib/canvasUndo.ts captureOwnAdd; PR #114).
    if (action === 'undo' && isOwnAdd(entry)) {
      const kept = captureOwnAdd(entry, nodes, edges);
      if (kept.length > 0) {
        // An accepted proposal an agent changed since (round 16 of PR #114,
        // M5): what it changed stays, and GM's line says so. Nothing left to
        // undo: the step goes (Redo would have nothing to do) with the line.
        const nothing = ownAddIsEmpty(entry);
        keptLine = acceptUndoNoticeText(kept, nodes, nothing);
        if (nothing) {
          breakUndoDebounce();
          set({ undoStack: [...from.slice(0, at), ...above],
            undoNotice: { id: ++undoNoticeSeq, text: keptLine, offer: null } });
          return null;
        }
      }
    }
    next = action === 'undo'
      ? applySlice(nodes, edges, entry.before, entry.after)
      : applySlice(nodes, edges, entry.after, entry.before);
    inverse = entry;
  } else {
    // Review 14, L-D, and review 15: it takes off only what its step added.
    next = snapshotNext(entry, nodes, edges);
    inverse = createSnapshot(nodes, edges);
  }
  if (above.length > 0) next = withoutRemovedAbove(next, nodes, above);
  const nextNodes = withFreshKeyStatus(next.nodes, nodes);
  // A param this puts back while an earlier write's echo is on its way (L-3).
  for (const id of unsavedParamEdits.keys()) {
    const now = nextNodes.find((node) => node.id === id);
    const was = nodes.find((node) => node.id === id);
    if (now && was && stableJson(now.data.params) !== stableJson(was.data.params)) {
      noteRestoredParams(id, now.data.params as Record<string, unknown>);
    }
  }
  breakUndoDebounce();
  // The person's own step that brings nodes back says "Restored the node.",
  // one that deletes them again "Deleted the node." (GM, 2026-10-23). The
  // restored line waits for the backend's answer when it has backend nodes,
  // since it counts the proposals that couldn't be reopened.
  const before = new Set(nodes.map((node) => node.id));
  const after = new Set(nextNodes.map((node) => node.id));
  const back = nextNodes.filter((node) => !before.has(node.id));
  // What this undo or redo added is what its inverse takes off again; for
  // every other step those nodes came from elsewhere (review 15).
  if (!isForeignEdit(entry)) stepAdds.set(inverse, new Set(back.map((node) => node.id)));
  const gone = nodes.filter((node) => !after.has(node.id)).length;
  const ownLine: OwnStepLine | null = isForeignEdit(entry) ? null
    : back.length > 0 ? { kind: 'restored', count: back.length }
      : gone > 0 ? { kind: 'deleted', count: gone } : null;
  const waitsForBackend = back.some((node) => CLI_ID_RE.test(node.id));
  const noticeId = ++undoNoticeSeq;
  if (ownLine?.kind === 'restored' && waitsForBackend) ownLinesWaiting.add(noticeId);
  if (above.length > 0) {
    // The steps above were taken from a canvas without this change undone:
    // each takes it in, so undoing one later keeps it. The nodes it brings
    // back reach the backend after their requests were sent, so a clear's
    // answer leaves them (clearedBy).
    const change = diffCanvas(nodes, edges, nextNodes, next.edges);
    for (const step of above) {
      for (const node of back) arrivedSince.get(step)?.add(node.id);
      if (!change || isSliceStep(step)) continue;
      const moved = applySlice(step.nodes, step.edges, change.after, change.before);
      step.nodes = moved.nodes;
      step.edges = moved.edges;
    }
    // Round 17's property test (P-5): the nodes its step added that a step
    // above already took off (an upload's node, deleted before the answers)
    // aren't in the change, and the steps above still hold them. Undone, the
    // step never added them: no undo of a step above brings them back.
    const adds = action === 'undo' && !isForeignEdit(entry) ? stepAdds.get(entry) : undefined;
    const gone = new Set([...(adds ?? [])].filter((id) => !before.has(id)));
    if (gone.size > 0) {
      for (const step of above) {
        if (isSliceStep(step)) continue;
        step.nodes = step.nodes.filter((node) => !gone.has(node.id));
        step.edges = step.edges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target));
      }
    }
  }
  const rest = [...from.slice(0, at), ...above];
  set({
    nodes: nextNodes,
    edges: next.edges,
    ...(action === 'undo'
      ? { undoStack: rest, redoStack: [...state.redoStack, inverse] }
      : { redoStack: rest, undoStack: [...state.undoStack, inverse] }),
    ...(isForeignEdit(entry) ? { undoNotice: {
      id: noticeId, text: undoNoticeText(action, entry), agentColor: entry.agentColor,
      offer: action === 'undo' ? 'redo' as const : 'undo' as const, entry,
    } } : keptLine ? { undoNotice: { id: noticeId, text: keptLine, offer: 'redo' as const, entry: inverse } }
      : ownLine && !(ownLine.kind === 'restored' && waitsForBackend)
      ? { undoNotice: ownStepNotice(noticeId, ownLine, NOTHING_MISSED, action, inverse) } : {}),
  });
  // Someone else's only for the steps taken after the change it undoes (or
  // redoes): those above it, and those its re-pushed delete went above. An
  // older step keeps owning what it added (review 16, H1).
  noteArrivedElsewhere(back.map((node) => node.id), get, [...above, ...(jumpedOver.get(entry) ?? [])]);
  void sendRestore(action, nodes, edges, nextNodes, next.edges, entry, inverse, set,
    { noticeId, ownLine: ownLine?.kind === 'restored' && waitsForBackend ? ownLine : null });
  return { inverse, noticeId };
}

/** The canvas a person's own step puts back: its snapshot (live results
 * kept), with every node it didn't add left as it is (takenOffBy). */
function snapshotNext(entry: UndoSnapshot, nodes: Node<NodeData>[], edges: Edge[]): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const next = { nodes: restoreWithOutputs(entry, nodes), edges: entry.edges.map((edge) => ({ ...edge })) };
  return keepingOthers(next, nodes, edges, takenOffBy(entry, nodes));
}

/** What a node is on the canvas, for "does this change anything": all of it
 * but React Flow's own view state and a run's live fields. */
const VIEW_FIELDS = new Set(['selected', 'dragging', 'measured', 'resizing']);
const LIVE_DATA_FIELDS = new Set<string>(RUNTIME_FIELDS);
function nodeShape(node: Node<NodeData>): string {
  const own = Object.fromEntries(Object.entries(node).filter(([key]) => !VIEW_FIELDS.has(key) && key !== 'data'));
  const data = Object.fromEntries(Object.entries(node.data ?? {}).filter(([key]) => !LIVE_DATA_FIELDS.has(key)));
  return stableJson({ ...own, data });
}

/**
 * Review 15, L-2: a person's own step that would change nothing on the
 * canvas now (its nodes already back, its typing already gone: a delete
 * whose node a clear's undo restored, Q1; a delete made while a clear was on
 * its way, Q3). Undoing it would be a Cmd+Z that silently does nothing.
 */
function changesNothing(entry: UndoEntry, nodes: Node<NodeData>[], edges: Edge[]): boolean {
  if (isSliceStep(entry)) return false;
  const next = snapshotNext(entry, nodes, edges);
  if (next.nodes.length !== nodes.length || next.edges.length !== edges.length) return false;
  const now = new Map(nodes.map((node) => [node.id, nodeShape(node)]));
  if (!next.nodes.every((node) => now.get(node.id) === nodeShape(node))) return false;
  const wires = new Set(edges.map(edgeKey));
  return next.edges.every((edge) => wires.has(edgeKey(edge)));
}

/** Drops the steps on top of the stack a press acts on that would change
 * nothing (changesNothing), so the press goes to the next real step. Never
 * one still on its way, and never while presses are held (their targets). */
function dropDeadSteps(action: 'undo' | 'redo', set: GraphSet, get: GraphGet): void {
  if (heldPresses.length > 0) return;
  const state = get();
  const stack = action === 'undo' ? state.undoStack : state.redoStack;
  let top = stack.length;
  while (top > 0 && !stepsInFlight.has(stack[top - 1]) && changesNothing(stack[top - 1], state.nodes, state.edges)) top -= 1;
  if (top === stack.length) return;
  set(action === 'undo' ? { undoStack: stack.slice(0, top) } : { redoStack: stack.slice(0, top) });
}

/** The canvas `next` sets, with every node on the canvas now that it lacks
 * and that isn't in `takesOff` kept as it is (with its wires): an undo that
 * only touches what its step touched (review 14, L-D). */
function keepingOthers(next: { nodes: Node<NodeData>[]; edges: Edge[] }, nodes: Node<NodeData>[], edges: Edge[],
  takesOff: ReadonlySet<string>): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const there = new Set(next.nodes.map((node) => node.id));
  const kept = nodes.filter((node) => !there.has(node.id) && !takesOff.has(node.id));
  if (kept.length === 0) return next;
  const keptIds = new Set(kept.map((node) => node.id));
  const all = new Set([...there, ...keptIds]);
  const wired = new Set(next.edges.map((edge) => edge.id));
  return {
    nodes: [...next.nodes, ...kept],
    edges: [...next.edges, ...edges.filter((edge) => !wired.has(edge.id)
      && (keptIds.has(edge.source) || keptIds.has(edge.target)) && all.has(edge.source) && all.has(edge.target))],
  };
}

/**
 * Review 13, M-2 (R4) and L-1: an undo applied beneath deletes of the
 * person's (still on their way, or re-pushed by a late answer) never brings
 * back the nodes they removed: those deletes come after it, so the canvas,
 * and the restore Nebula is sent, keep them gone. A node still on the canvas
 * (its delete hasn't landed yet) stays as it is; its delete takes it off.
 */
function withoutRemovedAbove(next: { nodes: Node<NodeData>[]; edges: Edge[] }, nodes: Node<NodeData>[],
  above: UndoEntry[]): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const here = new Set(nodes.map((node) => node.id));
  const gone = new Set([...above.flatMap((step) => [...(removedBy.get(step) ?? [])])].filter((id) => !here.has(id)));
  if (gone.size === 0) return next;
  return {
    nodes: next.nodes.filter((node) => !gone.has(node.id)),
    edges: next.edges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target)),
  };
}

/** A restore's count that arrived too late for its own line: the plain line
 * above the canvas notice, added to one already showing (LateNotice). */
function lateCount(state: GraphState, missed: Missed): Partial<GraphState> {
  const shown = state.lateNotice;
  const notReopened = missed.notReopened + (shown?.notReopened ?? 0);
  const notReattached = missed.notReattached + (shown?.notReattached ?? 0);
  if (missed.notReopened + missed.notReattached === 0) return {};
  return { lateNotice: { id: ++lateNoticeSeq, text: lateRestoreText(notReopened, notReattached), notReopened, notReattached } };
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
/** Restores queued and not yet answered, by admission, with the canvas each
 * was for: the person's other writes for that canvas wait behind them
 * (graphMutationFetch), and a switch's drain waits for the ones pressed
 * before it. */
const restoreSeqs = new Map<number, number>();

/** GM - Design, round 19, verbatim for an undo; a redo's says "redone". */
function restoreTimeoutLine(action: 'undo' | 'redo'): string {
  return `Nothing was ${action === 'undo' ? 'undone' : 'redone'}. Nebula isn't answering. Make sure it's running, then try again.`;
}

/** The nodes and wires a refused restore changed, put back as Nebula still
 * has them (W5): a node it brought back goes, one it took off comes back,
 * and a node it changed goes back unless the person has changed it since
 * (their write, sent after, carries the whole node). */
function revertRestoreOnCanvas(nodes: Node<NodeData>[], edges: Edge[],
  change: { before: GraphSlice; after: GraphSlice }): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const target: GraphSlice = { nodes: {}, edges: { ...change.before.edges } };
  const other: GraphSlice = { nodes: {}, edges: { ...change.after.edges } };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const [id, was] of Object.entries(change.before.nodes)) {
    const now = change.after.nodes[id];
    const here = byId.get(id);
    const untouched = !was || !now || (here !== undefined && diffCanvas([here], [], [now], []) === null);
    if (!untouched) {
      // Review 18, L-C: the person changed the node since. The keys the
      // restore changed go back to what Nebula still has; the person's own
      // keys stay as they are (their write carries only those keys now).
      if (!was || !now || !here || here.data.definitionId !== was.data.definitionId) continue;
      const wasParams = was.data.params as Record<string, unknown>;
      const nowParams = now.data.params as Record<string, unknown>;
      const restored = [...new Set([...Object.keys(wasParams), ...Object.keys(nowParams)])]
        .filter((key) => stableJson(wasParams[key]) !== stableJson(nowParams[key]));
      if (restored.length === 0) continue;
      const params = { ...(here.data.params as Record<string, unknown>) };
      for (const key of restored) {
        if (key in wasParams) params[key] = wasParams[key];
        else delete params[key];
      }
      target.nodes[id] = { ...here, data: { ...here.data, params } };
      other.nodes[id] = here;
      continue;
    }
    target.nodes[id] = was;
    other.nodes[id] = now;
  }
  return applySlice(nodes, edges, target, other);
}

/** A step taken after a refused restore was taken of a canvas with that
 * restore's nodes: it no longer holds a node the restore brought back, and
 * holds again one it took off (with its wires), as Nebula has them. */
function revertRestorePresence(step: UndoSnapshot, change: { before: GraphSlice; after: GraphSlice }): void {
  const gone = new Set(Object.entries(change.before.nodes).filter(([, was]) => was === null).map(([id]) => id));
  const back = Object.entries(change.before.nodes)
    .filter(([id, was]) => was !== null && change.after.nodes[id] === null && !step.nodes.some((node) => node.id === id))
    .map(([, was]) => was as Node<NodeData>);
  step.nodes = [...step.nodes.filter((node) => !gone.has(node.id)), ...createSnapshot(back, []).nodes];
  const held = new Set(step.nodes.map((node) => node.id));
  const wired = new Set(step.edges.map(edgeKey));
  step.edges = [...step.edges.filter((edge) => held.has(edge.source) && held.has(edge.target)),
    ...Object.values(change.before.edges).filter((edge): edge is Edge => edge !== null && held.has(edge.source)
      && held.has(edge.target) && !wired.has(edgeKey(edge)))];
}

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
  if (!body) {
    ownLinesWaiting.delete(notice.noticeId);
    return restoreQueue;
  }
  if (isForeignEdit(entry) && entry.editId) body.edit = entry.editId;
  // The wires and nodes it puts back or takes off stay so until it lands
  // (heldWires, heldNodes).
  const wireHolds = [...body.wire.map((w) => holdWire(w, true)), ...body.unwire.map((w) => holdWire(w, false))];
  const nodeHolds = [...body.nodes.filter((item) => CLI_ID_RE.test(item.id)).map((item) => [item.id, holdNode(item.id, true)] as const),
    ...body.remove.map((id) => [id, holdNode(id, false)] as const)];
  // Review 17, H-1: admitted now, when the person pressed it. A restore
  // queued behind another is never sent once another project or graph is
  // open, and is sent with this revision.
  const admission = admitWrite();
  // The steps there were right after this undo or redo: any other is newer (W5).
  const { undoStack: undosNow, redoStack: redosNow } = useGraphStore.getState();
  const known = new Set<UndoEntry>([...undosNow, ...redosNow]);
  // Shown once the backend answers, unless another notice came since, or a
  // new step has landed since: its Redo (or Undo) would no longer apply, so
  // the line stays away (withLiveNotice; GM - Design, 2026-10-23). What it
  // couldn't put back is never lost with it: that count shows on its own
  // plain line above the newer notice (lateCount; GM, rounds 3 and 4).
  const answerNotice = (missed: Missed) => set((state) => {
    // Presses held with this one that were skipped (round 13, L-1): GM's
    // sentence ends the restore's line (announceDrop).
    ownLinesWaiting.delete(notice.noticeId);
    const skipped = skippedAfter.get(notice.noticeId);
    skippedAfter.delete(notice.noticeId);
    if (notice.ownLine) {
      const shown = ownStepNotice(notice.noticeId, notice.ownLine, missed, action, inverse);
      if (undoNoticeSeq === notice.noticeId && offerApplies(shown, state)) {
        return { undoNotice: skipped ? { ...shown, text: `${shown.text} ${skipped}` } : shown };
      }
      // Its line can't show any more: the count and the skipped sentence still do.
      return { ...lateCount(state, missed), ...(skipped ? noticeLine(state, skipped, 'info') : {}) };
    }
    const shown = state.undoNotice;
    const text = notRestoredText(missed.notReattached, missed.notReopened);
    if (!text) return {};
    if (shown && shown.id === notice.noticeId) {
      // Before the skipped sentence a drop may have added (announceDrop).
      const tail = skippedShown.get(notice.noticeId);
      skippedShown.delete(notice.noticeId);
      const base = tail && shown.text.endsWith(` ${tail}`) ? shown.text.slice(0, -(tail.length + 1)) : shown.text;
      return { undoNotice: { ...shown, text: `${base}. ${text}${tail ? ` ${tail}` : ''}` } };
    }
    return lateCount(state, missed);
  });
  restoreSeqs.set(admission.seq, admission.graph);
  /** Review 17, W5 and L-2: Nebula refused it, or it never answered within
   * the hold limit. The person reads the undo failure line, always. On
   * the graph it was made in, the canvas goes back to where Nebula is. */
  const refused = (reason: string, how: { text?: string; quiet?: boolean } = {}) => {
    ownLinesWaiting.delete(notice.noticeId);
    skippedAfter.delete(notice.noticeId);
    // Another graph is open now: nothing here is that graph's (as before).
    if (admission.graph !== canvasReplacementRevision) return;
    set((state) => {
      const line = how.quiet ? {} : { undoNotice: { id: ++undoNoticeSeq, text: how.text ?? `Couldn't ${action} that. ${reason}`, offer: null,
        ...(isForeignEdit(entry) ? { agentColor: entry.agentColor, entry } : {}) } };
      if (how.text) timeoutNoticeId = undoNoticeSeq;
      const stack = action === 'undo' ? state.redoStack : state.undoStack;
      if (stack[stack.length - 1] === inverse) {
        // Put the canvas and both stacks back as they were before this step
        // (an own add is a slice too: PR #114's review 16 fix).
        const undone = isSliceStep(entry)
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
          ...line,
        };
      }
      // A newer step landed first (W5): only what this restore changed goes
      // back, as Nebula still has it, and the steps taken since take that
      // in. The step goes back beneath them, so it can be undone again.
      const change = diffCanvas(prevNodes, prevEdges, nextNodes, nextEdges);
      if (!change) return line;
      const canvas = revertRestoreOnCanvas(state.nodes, state.edges, change);
      const newer = (step: UndoEntry) => !known.has(step);
      for (const step of [...state.undoStack, ...state.redoStack]) {
        if (newer(step) && !isSliceStep(step)) revertRestorePresence(step, change);
      }
      const undoStack = state.undoStack.filter((step) => step !== inverse);
      const redoStack = state.redoStack.filter((step) => step !== inverse);
      let stacks: Partial<GraphState> = { undoStack, redoStack };
      if (action === 'undo') {
        const at = undoStack.findIndex(newer);
        stacks = { undoStack: at < 0 ? [...undoStack, entry] : [...undoStack.slice(0, at), entry, ...undoStack.slice(at)], redoStack };
      }
      return { nodes: withFreshKeyStatus(canvas.nodes, state.nodes), edges: canvas.edges, ...stacks, ...line };
    });
  };
  // Behind the person's writes already waiting their turn too, in the order
  // made (round 18's property test, seed 55: typing flushed by this Cmd+Z
  // waited behind an earlier restore, this restore went out first, and
  // Nebula kept the typing the canvas had undone).
  const writesBefore = waitingTail;
  // Round 19: an agent's switch drops it (beginAgentSwitch): its change
  // comes back off the canvas, quietly, and its answer changes nothing.
  let abandoned = false;
  restoreAbandons.set(admission.seq, () => {
    if (abandoned) return;
    abandoned = true;
    refused('', { quiet: true });
  });
  /** Which line the timeout showed, so a late landing can take it back. */
  let timeoutNoticeId: number | null = null;
  /** Review 18, L-B: Nebula applied it after the limit. The step follows
   * Nebula: it counts as done, so the next Cmd+Z is never a silent no-op;
   * GM's "Nothing was undone" line, no longer true, goes. */
  const landedLate = (response: Response) => {
    if (!response.ok || abandoned || admission.graph !== canvasReplacementRevision) return;
    set((state) => {
      const from = action === 'undo' ? state.undoStack : state.redoStack;
      const to = action === 'undo' ? state.redoStack : state.undoStack;
      const top = from[from.length - 1] === entry;
      const left = from.filter((step) => step !== entry);
      const moved = top ? [...to, inverse] : to;
      return {
        ...(action === 'undo' ? { undoStack: left, redoStack: moved } : { redoStack: left, undoStack: moved }),
        ...(timeoutNoticeId !== null && state.undoNotice?.id === timeoutNoticeId ? { undoNotice: null } : {}),
      };
    });
  };
  const task = Promise.all([restoreQueue, writesBefore]).then(async () => {
    // Read now, not when the step was taken: the answer to the delete (or to
    // the redo before this undo) may have landed since.
    const removals = removalsFor(entry, body);
    if (removals.length > 0) body.removals = removals;
    let response: Response | null = null;
    let timedOut = false;
    try {
      response = await graphMutationFetch('/api/graph/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { admission, timeoutMs: HOLD_LIMIT_MS, onLate: landedLate });
    } catch (err) {
      if (err instanceof RestoreTimeout) timedOut = true;
      // No answer: it may have landed. The next graphSync shows which.
      else console.warn(`[nebula] ${action} didn't reach the backend:`, err);
    }
    for (const done of wireHolds) done(Boolean(response?.ok));
    const ended = nodeHolds.filter(([, done]) => done(Boolean(response?.ok))).map(([id]) => id);
    try {
      if (abandoned) return;
      if (timedOut) {
        // Review 17, L-2: the same bound as a held Cmd+Z (HOLD_LIMIT_MS).
        // The writes waiting behind it go out now, in order, each under
        // its own admission check. GM, round 19: "Nothing was undone.
        // Nebula isn't answering. Make sure it's running, then try again."
        console.warn(`[nebula] ${action} had no answer in ${HOLD_LIMIT_MS / 1000} s`);
        refused(CONNECTION_LOST_COPY, { text: restoreTimeoutLine(action) });
        return;
      }
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
          if (admission.graph === canvasReplacementRevision) {
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
      refused(reason);
    } finally {
      // The newest copy Nebula synced of each node it held (M-2).
      if (admission.graph === canvasReplacementRevision) applyHeldCopies(ended);
    }
  });
  restoreQueue = task.catch(() => {}).finally(() => {
    restoreSeqs.delete(admission.seq);
    restoreAbandons.delete(admission.seq);
  });
  return task;
}

/** A backend node as a sync carries it, merged into this canvas's copy
 * (`existing`; none for a node new here): the graphSync merge, and a held
 * node's newest copy when its hold ends (applyHeldCopies, review 17 M-2). */
function mergeSyncedNode(incoming: Node<NodeData>, existing: Node<NodeData> | undefined, moved: readonly string[],
  settingsCache: ReturnType<typeof useUIStore.getState>['settingsCache']): Node<NodeData> {
  // Nodes the backend put somewhere new (an agent's move, or another tab's
  // drag). The rest keep the position this canvas has, as do nodes being
  // dragged here and nodes this tab's own layout write hasn't settled.
  const takesBackendPosition = (node: Node<NodeData>, here: Node<NodeData>) =>
    moved.includes(node.id) && !here.dragging && !layoutWritesInFlight.has(node.id) && Boolean(node.position);
  // Compute keyStatus for a node given its definition. Used for both new and
  // existing cli nodes so the "missing API key" badge shows up consistently.
  const keyStatusFor = (definitionId: string, params: Record<string, unknown>): 'missing' | undefined =>
    nodeKeyStatus(NODE_DEFINITIONS[definitionId], params, settingsCache);
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
        // An agent's placeholder is the backend's alone (Q125 item 3): a
        // sync without the flag means it turned normal there.
        pending: cleanPending(cliNode.data.pending) ?? undefined,
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
}

/** Why a graph from the backend isn't for this tab, or null when it is: the
 * same two checks every socket event and graphSync pass (another project's
 * revision; another params version, which projectStore reloads the tab for,
 * paramsOutdated.ts; a sync without a version is from a backend older than
 * the gate, 0). The reason is the backend's own refusal for the same case
 * (main.py CANVAS_OUT_OF_DATE, PARAMS_OUTDATED_DETAIL), for the Agent log. */
function graphNotForThisTab(event: { workspaceRevision?: unknown; paramsVersion?: unknown }): string | null {
  const revision = event.workspaceRevision;
  if (revision !== undefined && revision !== getProjectContext()?.revision) {
    return 'This canvas is out of date. Open the current project before editing or running it.';
  }
  if (backendParamsVersion(event.paramsVersion) !== GRAPH_PARAMS_VERSION) {
    return "Nebula was updated while this tab was open, so this tab can't save or run until it reloads. "
      + "Reload the tab; your saved work is kept. If this keeps happening after a reload, this window's "
      + "frontend build doesn't match the backend: rebuild the frontend, or restart the backend.";
  }
  return null;
}

wsClient.connect();
/** Set when the socket reconnects; the backend's first message on the new
 * socket is its whole graph (main.py's websocket hello), applied in
 * applyGraphSync. */
let firstSyncAfterReconnect = false;

/** Set when a new boot id showed the backend restarted (backendConnection,
 * from any hello or health answer, with or without a project open: review
 * 15, M4). The next graphSync applied here releases the creates whose
 * answer was lost, after it has looked for them (observePending…). */
let backendRestartSeen = false;
subscribeBackendRestart(() => { backendRestartSeen = true; });

/** Round 22 (review 21, L-b): which backend process (its bootId) the
 * socket's syncs come from (each socket's first sync names it; a broadcast
 * after it is the same process), and which one the canvas last took a sync
 * from. A sync whose process differs is the canvas seen across a restart. */
let socketBoot: string | null = null;
let canvasSyncBoot: string | null = null;

/**
 * Round 23 (review 22, L-2): the canvas was loaded or replaced over HTTP (a
 * project load, an import, the person's own clear). Nothing the tab holds
 * says which backend process served it (the socket's last hello may be from
 * the process before a restart), so it never inherits the boot of the canvas
 * it replaced: until a sync of its own names one, a restart that lost the
 * revisions reads as a named replacement, never as the same canvas.
 */
function canvasLoadedOverHttp(): void {
  canvasSyncBoot = null;
}

/**
 * A create whose answer was lost stays "uncertain" (it may have landed), and
 * holds the next create until a sync shows it (review 13, M2: add-and-connect
 * stayed refused, "Another node-create request is still unresolved", until a
 * reload). Released here only when the backend restarted: the reconnected
 * socket's first sync carries a new `bootId`, and a create the new process's
 * graph doesn't show never landed. A reconnect to the same process doesn't
 * release it (review 14, nit 3): that create may still commit, and a later
 * sync that shows it resolves it. A create still being sent keeps its hold
 * until its answer.
 */
function releaseUnresolvedCreates(): void {
  if (pendingConnectedNodeCreationAttempt?.phase === 'uncertain' && !pendingConnectedNodeCreationAttempt.observedNodeId) {
    pendingConnectedNodeCreationAttempt = null;
  }
  if (pendingNodeCreationAttempt?.phase === 'uncertain' && !pendingNodeCreationAttempt.observedNodeId) {
    pendingNodeCreationAttempt = null;
  }
}

wsClient.subscribe((event) => {
  if (event.type === 'socketReconnected') firstSyncAfterReconnect = true;
  if (event.type === 'graphSync') {
    // Before any check of whose graph it is: the hello arrives before this
    // tab has a project (review 15, M4).
    noteBackendBootId((event as { bootId?: unknown }).bootId);
    const boot = (event as { bootId?: unknown }).bootId;
    if (typeof boot === 'string' && boot) socketBoot = boot;
    if (firstSyncAfterReconnect) {
      // A reopened socket's first message proves the backend answers
      // (review 15, M3): probe now rather than up to 3 s later.
      firstSyncAfterReconnect = false;
      requestHealthProbe();
    }
  }
  const revision = (event as ExecutionEvent & { workspaceRevision?: string }).workspaceRevision;
  const context = getProjectContext();
  if (revision !== undefined && revision !== context?.revision) return;
  if (event.type === 'graphSync') {
    applyGraphSync(event);
    return;
  }
  useGraphStore.getState().handleExecutionEvent(event);
});

/** Merge a graphSync into the canvas: the socket's, and an add's own read
 * of the backend's graph on an empty tab (bringBackendGraphIntoEmptyTab,
 * `fromExport`). Returns false when it isn't for this tab (graphNotForThisTab).
 *
 * Round 21 (the #114 merge, review 17's C6): the export carries the canvas
 * revision and no edit, so read as a sync it could look like a missed
 * clear. It only adopts the revision: the tab is empty, nothing is held for
 * its canvas, and no line is said. */
function applyGraphSync(event: ExecutionEvent, options: { fromExport?: boolean } = {}): boolean {
  if (graphNotForThisTab(event as ExecutionEvent & { workspaceRevision?: unknown; paramsVersion?: unknown })) {
    return false;
  }
  appliedGraphSyncs += 1;
  clearedAsSaved = null;
  useCinemaMotionStore.getState().observeGraphSync();
  // Real-time sync: MERGE cli_graph into the canvas. Key invariant: frontend-only
  // nodes (library drags, undo'd results, etc.) must survive graphSync — only
  // cli-origin nodes are authoritative from the server. Same for edges.
  const {
    nodes: rawCliNodes,
    edges: cliEdges,
    empty,
    graphReplaced = false,
    cleared = false,
    moved = [],
    arrange = [],
    arranged,
    providerRecoveries = [],
    providerStartAmbiguities = [],
    executionStatuses,
    edit: origin,
    runParams,
  } = event as {
    type: 'graphSync';
    nodes: Node<NodeData>[];
    edges: Edge[];
    empty: boolean;
    graphReplaced?: boolean;
    /** A Clear (DELETE /api/graph): ids start again at n1 in the same project. */
    cleared?: boolean;
    moved?: string[];
    arrange?: unknown;
    /** Set when this sync finishes an agent's arrange: {id, nodeIds}. Not an edit. */
    arranged?: unknown;
    /** Set when a graph edit caused this sync: who made it, and which tab sent it. */
    edit?: EditOrigin;
    /** A run's own param write-back (its run id; round 17 of PR #114). Not an edit. */
    runParams?: string;
    providerRecoveries?: ProviderRecoveryCheckpoint[];
    providerStartAmbiguities?: ProviderStartAmbiguity[];
    executionStatuses?: ExecutionStatusResult[];
  };
  const revision = (event as { workspaceRevision?: unknown }).workspaceRevision;
  // The presses held for the old graph's steps go (review 11, L-4); the
  // line saying so shows once the new graph is on the canvas, beside an
  // agent's "changed the canvas" rather than under it (review 12, L-2).
  // Round 19 (review 18, H-A): which canvas Nebula holds. When it moved
  // (a clear, an import) the writes held from before are another canvas's:
  // node ids start again at n1, so they must never reach the new nodes.
  // A sync from a backend that doesn't say it (older, or a test's) reads
  // an agent's clear by its empty graph, or by its `cleared` mark.
  const canvasRevision = (event as { canvasRevision?: unknown }).canvasRevision;
  const knownCanvas = getProjectContext()?.canvas;
  const ownEcho = Boolean(origin && isOwnEcho(origin, TAB_ID));
  const canvasMoved = !options.fromExport && (typeof canvasRevision === 'string'
    ? knownCanvas !== undefined && canvasRevision !== knownCanvas
    : (cleared || empty) && Boolean(origin) && !ownEcho);
  // Round 20 (review 19, M2): Nebula keeps the canvas revision across a
  // restart, so a reconnect's sync names the same canvas. One with no edit
  // whose revision moved anyway while it carries the canvas on screen
  // (every backend node, each with its definition) is that canvas seen
  // across a restart that lost its revision: the tab takes the revision
  // and keeps everything, and never reads it as a clear.
  // Round 21 (review 20, L-4): only when Nebula says it lost its revisions
  // (`canvasRevisionRestored: false`); with them restored, a moved revision
  // is a real replacement (a missed agent clear that re-added the same ids).
  // Round 22 (review 21, L-b): and only across an actual restart: the sync
  // comes from another backend process (bootId) than the canvas last synced
  // with. Within one boot every sync says restored:false, so a missed agent
  // clear that re-added the same ids reads as what it is, a replacement.
  const revisionsLost = (event as { canvasRevisionRestored?: unknown }).canvasRevisionRestored === false;
  const eventBoot = (event as { bootId?: unknown }).bootId;
  const syncBoot = options.fromExport ? null : typeof eventBoot === 'string' && eventBoot ? eventBoot : socketBoot;
  const restarted = syncBoot !== null && canvasSyncBoot !== null && syncBoot !== canvasSyncBoot;
  if (syncBoot !== null) canvasSyncBoot = syncBoot;
  // Round 23 (review 22, L-2): a replacement the export brought (no process
  // named) is a canvas no sync has named a process for yet.
  else if (graphReplaced || (canvasMoved && !ownEcho)) canvasSyncBoot = null;
  const sameCanvas = canvasMoved && revisionsLost && restarted && !origin && !graphReplaced && sameBackendCanvas(rawCliNodes);
  if (sameCanvas && typeof canvasRevision === 'string') noteSameCanvas(knownCanvas, canvasRevision);
  adoptCanvasRevision(revision, canvasRevision);
  let replacedPresses: DroppedPresses | null = null;
  // The tab's own clear moved it already (clearGraph, clearBackendNodes),
  // before its echo: the echo moves nothing again, so its undo step stays
  // with the canvas it was taken on (review 17's merge note: PR #114 moved
  // the graph on every `cleared` sync, the tab's own echo too).
  if (canvasMoved && !graphReplaced && !ownEcho && !sameCanvas) {
    // An agent's clear (or a script's: "An agent"), whose line names what
    // the person was editing (L2, GM). Another window of the person's is
    // their own clear: no line.
    // No edit (a reconnect's sync that found another canvas): silent, so
    // a restart never reads as an agent's clear (GM follow-up 4).
    const by = origin ? foreignSource(origin) : null;
    replacedPresses = replaceCanvasByClear(by === 'agent' || by === 'outside'
      ? { agent: by === 'agent' ? origin?.actor?.name ?? null : null } : undefined, { reconnect: !origin });
  } else if (!graphReplaced && !options.fromExport) {
    // The canvas the tab holds (the same one, or adopted across a restart):
    // saves refused as out of date before it came go out again (L-a).
    resendParkedParamSaves();
  }
  if (graphReplaced) {
    canvasReplacementRevision += 1;
    noteCanvasReplaced();
    forgetRunsOfReplacedGraph();
    newWriteQueue();
    // An agent's import into this project (a switch comes through
    // projectStore): GM's line names a save it cut off.
    startReplacementReport({ kind: 'import' }, canvasProjectName(), takeParkedParamSaves());
    replacedPresses = forgetStepsInFlight();
    renameDrafts.clear();
    labelsInFlight.clear();
    labelsSavedBefore.clear();
    pendingConnectedNodeCreationAttempt = null;
    wireWrites.clear();
    nodeWrites.clear();
    heldCopies.clear();
    clearUnsavedParamEdits();
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
  if (backendRestartSeen) {
    backendRestartSeen = false;
    releaseUnresolvedCreates();
  }

  const state = useGraphStore.getState();
  const held = heldWires(cliEdges ?? []);
  const heldNodeIds = heldNodes();
  // Backend nodes this tab's undo or redo put back, still on their way
  // there: the sync leaves them on the canvas (heldNodes).
  const keptBack = graphReplaced ? [] : state.nodes.filter((node) => heldNodeIds.get(node.id) === true
    && !(cliNodes as Array<{ id: string }>).some((incoming) => incoming.id === node.id));
  for (const seen of syncWatchers) {
    for (const node of cliNodes) seen.add(node.id);
    for (const edge of cliEdges ?? []) seen.add(edgeKey(edge));
  }
  if (!graphReplaced) {
    // Review 17, M-2: what this sync says of each held node is kept, the
    // newest, for when its hold ends (applyHeldCopies).
    noteHeldCopies(heldNodeIds, cliNodes as Node<NodeData>[], (cliEdges ?? []) as Edge[], origin, moved);
    // A delete on its way whose node this sync no longer has is done in
    // Nebula, whatever its answer says (review 14, L-E; the node is off
    // the canvas already: GM r18, option (c)).
    noteDeletesGoneBySync(cliNodes as Array<{ id: string }>);
  }

  if (empty) {
    // cli_graph was cleared — drop only cli-origin nodes/edges; keep frontend work.
    const remainingNodes = graphReplaced ? [] : state.nodes.filter((n) => !CLI_ID_RE.test(n.id) || keptBack.includes(n));
    const remainingIds = new Set(remainingNodes.map((n) => n.id));
    const remainingEdges = state.edges.filter(
      (e) => remainingIds.has(e.source) && remainingIds.has(e.target),
    );
    if (!graphReplaced) noteSyncRemovals(state, remainingIds);
    // An echo that empties the graph places a delete's step like any other
    // echo (review 14, L-A).
    if (!graphReplaced && (!origin || isOwnEcho(origin, TAB_ID))) {
      placeEchoedDeletes(state, remainingIds, useGraphStore.setState as GraphSet, useGraphStore.getState);
    }
    useGraphStore.setState({
      nodes: remainingNodes,
      edges: remainingEdges,
      backendFreshStartPending: false,
      ...foreignEditStep(asLastSaved(state), remainingNodes, remainingEdges, origin, graphReplaced, moved, Boolean(runParams)),
    });
    noteSyncArrivals(state.nodes, remainingNodes, useGraphStore.setState as GraphSet, useGraphStore.getState);
    if (replacedPresses) announceDrop(useGraphStore.setState as GraphSet, replacedPresses);
    showClearReport();
    useCinemaUploadStore.getState().reconcileTargets(remainingNodes);
    useArrangeStore.getState().setPending([]);
    return true;
  }

  const existingById = new Map((graphReplaced ? [] : state.nodes).map((n) => [n.id, n]));
  const frontendOnlyNodes = graphReplaced ? [] : state.nodes.filter((n) => !CLI_ID_RE.test(n.id));
  const { settingsCache } = useUIStore.getState();

  // A node this tab's undo or redo took off stays off until that lands.
  const cliMerged = (cliNodes as Node<NodeData>[]).filter((incoming) => heldNodeIds.get(incoming.id) !== false).map((incoming) => {
    const existing = existingById.get(incoming.id);
    // A node this tab's undo or redo puts back or sets stays as that
    // restore will write it until it lands: an older echo's params don't
    // take the undo back (round 17's property test, seed 914). The newest
    // copy is applied when the hold ends (M-2).
    if (existing && heldNodeIds.get(incoming.id) === true) return existing;
    // A sync that shows the person's last write lets it go (review 16, L-3).
    if (existing) noteParamEcho(incoming.id, (incoming.data?.params ?? {}) as Record<string, unknown>);
    return mergeSyncedNode(incoming, existing, moved, settingsCache);
  });

  // A node the sync didn't change stays the same object (and the array
  // the same array when nothing changed), so React Flow re-renders only
  // the cards that changed (tests/canvasRenderScope.test.tsx).
  const merged = shareUnchanged(graphReplaced ? [] : state.nodes, nodesWithProviderRecoveries(
    [...frontendOnlyNodes, ...cliMerged, ...keptBack],
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
    ...(cliEdges as Edge[]).filter((edge) => held.get(edgeKey(edge)) !== false
      // Not on a node held off the canvas (heldNodes).
      && heldNodeIds.get(edge.source) !== false && heldNodeIds.get(edge.target) !== false).map((edge) => {
      const selected = existingEdges.get(edgeIdentity(edge))?.selected;
      return typeof selected === 'boolean' ? { ...edge, selected } : edge;
    }),
  ], edgeIdentity);

  if (!origin && !graphReplaced) foldFinishedArrange(state, arranged, cliNodes as Node<NodeData>[]);
  if (!graphReplaced && !(origin && isOwnEcho(origin, TAB_ID))) forgetPlaceholdersMadeNormal(state, merged);
  if (!graphReplaced) noteSyncRemovals(state, mergedIds);
  // This tab's own echo can take a delete's nodes off before its answer.
  if (!graphReplaced && (!origin || isOwnEcho(origin, TAB_ID))) {
    placeEchoedDeletes(state, mergedIds, useGraphStore.setState as GraphSet, useGraphStore.getState);
  }
  useGraphStore.setState({
    nodes: merged,
    edges: mergedEdges,
    backendFreshStartPending: false,
    ...foreignEditStep(asLastSaved(state), merged, mergedEdges, origin, graphReplaced, moved, Boolean(runParams)),
  });
  // What it brought arrived after any step in flight; an upload waiting for its node settles (review 11, L-2, L-6).
  noteSyncArrivals(graphReplaced ? [] : state.nodes, merged, useGraphStore.setState as GraphSet, useGraphStore.getState);
  if (replacedPresses) announceDrop(useGraphStore.setState as GraphSet, replacedPresses);
  showClearReport();
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
  return true;
}

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

/**
 * GM - Design, round 12 addendum (b): a run with a Krea node whose required
 * model setting has nothing chosen (Topaz Standard's Model) would be refused
 * by the gateway, so it is refused here before any dialog or confirm ("Don't
 * ask someone to approve a run that can't go out"), with GM's line naming
 * the node and the field. Every run path asks it, over the nodes that run
 * would send (placeholders it skips aren't among them). True: refused.
 */
function refuseUnchosenModel(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope,
  names?: Readonly<Record<string, string>>): boolean {
  // On the route each node's run takes (review 13, M-1): the keys set, its
  // wires, the Krea plan's sign-in. Before the settings load, the backend
  // refuses on the route it knows instead.
  const { settingsCache } = useUIStore.getState();
  const context = settingsCache.loaded ? { apiKeys: settingsCache.apiKeys, edges,
    planReady: settingsCache.kreaConnection?.status === 'connected' } : undefined;
  const text = modelNotChosenText(nodesThatRun(nodes, edges, scope), names, context);
  if (!text) return false;
  useGraphStore.getState().notify(text);
  return true;
}

/**
 * Review 14, M-B: what the refusal reads has to be known before Nebula asks
 * the person anything (GM - Design: never ask someone to approve a run that
 * can't go out). Unknown: the settings (the keys) haven't loaded, or a node
 * the refusal could name runs on the Krea plan and its sign-in hasn't been
 * read. Only a run with a node that could be refused (a required field with
 * nothing in it) waits; every other run starts in the same turn as before.
 */
function runInputsUnknown(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope): boolean {
  const refusable = nodesThatRun(nodes, edges, scope).filter(mayBeRefused);
  if (refusable.length === 0) return false;
  const { settingsCache } = useUIStore.getState();
  if (!settingsCache.loaded) return true;
  return kreaSignInUnknown(settingsCache.kreaConnection?.status)
    && planDecidesRefusal(refusable, edges, settingsCache.apiKeys);
}

/** The Krea plan's sign-in isn't known: not read, a failed read, or still
 * connecting (review 15, L-3: it settles within moments, so it is waited
 * for like an unread one). */
function kreaSignInUnknown(status: string | undefined): boolean {
  return status === undefined || status === 'error' || status === 'connecting';
}

/** How often a run waiting on a Krea sign-in still connecting reads it again. */
const KREA_CONNECTING_POLL_MS = 500;

/**
 * Review 15, M-B: the runs waiting for what their refusal reads, each with
 * what it would hold once started: 'canvas' (a run that holds the whole
 * canvas: a node's Run, the canvas Run, Run selected, a replay, an accepted
 * proposal's run), `shot:<node>:<shot>` (a Cinema shot) or `node:<id>` (each
 * node of Creator's concurrent cluster). A waiting run counts as starting:
 * the same Run while it waits does nothing, as during the run.
 */
const waitingRuns = new Map<object, readonly string[]>();

/** Whether a run waiting for its inputs holds any of `keys`. */
function runWaiting(keys: readonly string[]): boolean {
  return [...waitingRuns.values()].some((held) => held.some((key) => keys.includes(key)));
}

const CANVAS_RUN = ['canvas'] as const;
const shotRunKey = (nodeId: string, shotId: string) => `shot:${nodeId}:${shotId}`;

/** knowRunInputs, held as starting (`holds`) while it waits. */
async function waitForRunInputs(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope, holds: readonly string[]): Promise<void> {
  const token = {};
  waitingRuns.set(token, holds);
  useGraphStore.setState({ runStarting: true });
  try {
    await knowRunInputs(nodes, edges, scope);
  } finally {
    waitingRuns.delete(token);
    useGraphStore.setState({ runStarting: waitingRuns.size > 0 });
  }
}

/** How long a run waits for those to load before it leaves the refusal to the backend. */
const RUN_INPUTS_WAIT_MS = 4000;

/** Loads what runInputsUnknown found missing (the settings, then the Krea
 * plan's sign-in when it decides), for at most RUN_INPUTS_WAIT_MS. What still
 * can't be read is left to Nebula's own refusal, as before (no worse). */
async function knowRunInputs(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, RUN_INPUTS_WAIT_MS); });
  const deadline = Date.now() + RUN_INPUTS_WAIT_MS;
  try {
    await Promise.race([readRunInputs(nodes, edges, scope, deadline), limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Review 17 (m2stale): before a 409 re-ask, the keys are read again, bounded
 * by the first ask's wait (RUN_INPUTS_WAIT_MS), so each row's name and price
 * come from the one route resolution Nebula's estimate was made on. True when
 * the tab now holds Nebula's keys (its own read, or App's that landed meanwhile).
 */
async function rereadRunKeys(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Review 18, L-D: a read that lands after the limit is ignored. The dialog
  // already shows rows without a route; keys changing under it would read as
  // a route that moved and ask again for nothing.
  let late = false;
  const limit = new Promise<boolean>((resolve) => { timer = setTimeout(() => { late = true; resolve(false); }, RUN_INPUTS_WAIT_MS); });
  const read = (async () => {
    const before = useUIStore.getState().settingsCache;
    try {
      const settings = await apiGetSettings();
      if (late) return false;
      const now = useUIStore.getState().settingsCache;
      // App's own read may have landed meanwhile: it wins.
      if (now.apiKeys === before.apiKeys && now.kreaConnectionMode === before.kreaConnectionMode) {
        useUIStore.getState().setSettingsCache((settings.apiKeys ?? {}) as Record<string, string>,
          normalizeKreaMode(settings.kreaConnectionMode));
      }
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([read, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readRunInputs(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope, deadline: number): Promise<void> {
  if (!useUIStore.getState().settingsCache.loaded) {
    try {
      const settings = await apiGetSettings();
      // App's own read may have landed meanwhile: it wins.
      if (!useUIStore.getState().settingsCache.loaded) {
        useUIStore.getState().setSettingsCache((settings.apiKeys ?? {}) as Record<string, string>,
          normalizeKreaMode(settings.kreaConnectionMode));
      }
    } catch {
      return;
    }
  }
  // The sign-in, read again while it is still connecting (review 15, L-3),
  // until the wait's deadline.
  while (runInputsUnknown(nodes, edges, scope)) {
    let connection: Awaited<ReturnType<typeof getKreaConnection>>;
    try {
      connection = await getKreaConnection();
    } catch {
      return; // Still unknown: the backend refuses on the route it knows.
    }
    // App's own read may have landed meanwhile: a settled one wins.
    if (kreaSignInUnknown(useUIStore.getState().settingsCache.kreaConnection?.status)) {
      useUIStore.getState().setKreaConnection(connection);
    }
    if (connection.status !== 'connecting' || Date.now() + KREA_CONNECTING_POLL_MS >= deadline) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, KREA_CONNECTING_POLL_MS); });
  }
}

/** Asks before a run whose list-price estimate reaches the user's threshold
 * (Settings > Interface). Every run path goes through the execute actions,
 * so the check lives here rather than on each button. Unpriced runs pass.
 * `passes`: the run done that many times (a Cinema shot's variations). */
function confirmRunCost(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope, passes = 1): boolean {
  const pricing = usePricingStore.getState().table;
  if (!pricing || typeof window === 'undefined') return true;
  const { runCostConfirmUsd, settingsCache } = useUIStore.getState();
  const summary = repeatRun(summarizeRunScope(nodes, edges, scope,
    { pricing, apiKeys: settingsCache.apiKeys, sizes: useInputSizeStore.getState().sizes }), passes);
  if (!shouldConfirmRunCost(summary, runCostConfirmUsd)) return true;
  return window.confirm(runCostConfirmMessage(summary));
}

/**
 * The person's direct run of a node (Q133, Justin 2026-10-25): when a
 * placeholder it would make normal calls a paid model, Nebula always asks
 * first, whatever the costly-run setting, in one dialog that replaces the
 * costly-run confirm (components/PlaceholderRunDialog.tsx). The dialog's
 * words, or null when no paid placeholder is in the run and no dialog has
 * shown for it (`options.shown`; then the costly-run confirm applies as
 * before). A price read from an input file asks the backend for its size
 * (review 4, H1); the open dialog updates when it arrives. `estimate`:
 * Nebula's own, from its refusal (review 4, M1).
 */
function directRunConfirm(
  nodes: Node<NodeData>[], edges: Edge[], nodeId: string, passes = 1, estimate?: RunEstimate | null,
  options: PlaceholderRunOptions = {},
): PlaceholderRunConfirm | null {
  if (typeof window === 'undefined') return null;
  let summary = canvasRunSummary(nodes, edges, nodeId, passes);
  if (estimate) summary = withRunEstimate(summary, estimate, nodes);
  return placeholderRunConfirm(nodes, edges, nodeId, summary, options);
}

/** The direct run of `nodeId` as the canvas prices it: each node on the
 * route it takes with the keys this tab read, `passes` times. */
function canvasRunSummary(nodes: Node<NodeData>[], edges: Edge[], nodeId: string, passes: number): RunScopeSummary {
  const pricing = usePricingStore.getState().table;
  const { settingsCache } = useUIStore.getState();
  // The keys go in even before the price table loads: each row names the
  // route its run takes (GM - Design, round 15, item 3).
  const summary = repeatRun(summarizeRunScope(nodes, edges, { kind: 'node', nodeId },
    { pricing: pricing ?? null, apiKeys: settingsCache.apiKeys, sizes: useInputSizeStore.getState().sizes }), passes);
  const sizeRefs = summary.cost?.sizeRefs;
  if (sizeRefs?.length) useInputSizeStore.getState().request(sizeRefs);
  return summary;
}

function sameConfirm(a: PlaceholderRunConfirm, b: PlaceholderRunConfirm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Calls `onChange` whenever something the dialog's words read changes: the
 * graph, the price table, a measured input, the keys. Returns its stop. */
function watchRunInputs(onChange: () => void): () => void {
  const stops = [
    useGraphStore.subscribe((state, before) => {
      if (state.nodes !== before.nodes || state.edges !== before.edges) onChange();
    }),
    usePricingStore.subscribe((state, before) => { if (state.table !== before.table) onChange(); }),
    useInputSizeStore.subscribe((state, before) => { if (state.sizes !== before.sizes) onChange(); }),
    useUIStore.subscribe((state, before) => { if (state.settingsCache !== before.settingsCache) onChange(); }),
  ];
  return () => { for (const stop of stops) stop(); };
}

/** Asks App to read the settings again (App.tsx, 'nebula:settings-refresh'),
 * so the dialog prices with the keys the backend has, not ones this tab read
 * at load (review 4, M1). The open dialog updates when they arrive. */
function refreshSettingsCache(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nebula:settings-refresh'));
}

/**
 * Shows that dialog and resolves with the words the person said yes to, as
 * the dialog had them on screen at the click (review 5, L6), or null.
 * `changed`: asked again because the run changed (GM, round 5: its line, and
 * Run held for 500 ms). `recompute`, when given, is the dialog's words now:
 * the open dialog shows them as they change (a measured price, the keys read
 * again, an agent finishing its placeholders). A dialog that can't load runs
 * nothing.
 */
async function askDirectRun(
  model: PlaceholderRunConfirm, changed: boolean, recompute?: () => PlaceholderRunConfirm | null,
  moved?: readonly string[],
): Promise<PlaceholderRunConfirm | null> {
  let pushed = model;
  try {
    const dialog = await placeholderRunDialogModule.load();
    const watch = recompute && ((show: (next: PlaceholderRunConfirm) => void) => watchRunInputs(() => {
      const next = recompute();
      if (next && !sameConfirm(next, pushed)) {
        pushed = next;
        show(next);
      }
    }));
    return await dialog.askPlaceholderRun(model, { changed, watch, ...(moved?.length ? { moved } : {}) });
  } catch (error) {
    console.error("Couldn't open the run confirmation:", error);
    return null;
  }
}

/** The graph a direct run would send, as the canvas reads it for its cost and
 * dialog; for a replay, the saved nodes that are no longer their agent's
 * (snapshotCanvas `gone`, review 7 L1) and those whose live settings differ
 * from the saved ones it sends (`changed`, GM - Design on review 8 L-b). */
interface DirectRunGraph { nodes: Node<NodeData>[]; edges: Edge[]; gone?: ReadonlySet<string>; changed?: ReadonlySet<string> }

/** How the dialog words this run: "Generate" from Cinema, a shot's name. */
type DirectRunWording = Pick<PlaceholderRunOptions, 'verb' | 'names'>;

/** What the person agreed to: the graph to run as it stood after the last
 * question, and, when the dialog asked, the placeholders and total confirmed
 * and every placeholder it showed (`shown`): once it has shown, it stays the
 * authority for this run, also when Nebula refuses it (review 5, H1). */
interface DirectRunConfirmed extends DirectRunGraph {
  confirmedPlaceholders?: string[];
  confirmedCost?: number;
  shown?: ReadonlyMap<string, PendingAgent>;
}

/**
 * Every way the canvas starts the person's direct run of a node (its Run,
 * the Inspector, a Cinema shot, a replay from Run history) asks here
 * (Q133; review 3 findings 1, 2 and 7). `read` is the graph that run would
 * send now, re-read after each question (an agent may have changed it while
 * the dialog was open), or null when the run can no longer start. A paid
 * placeholder asks in GM's dialog (askUntilSettled). With none, the
 * costly-run confirm decides (`costly`; replays never asked it). Null: the
 * person said no, or the run can't start.
 */
function confirmDirectRun(
  read: () => DirectRunGraph | null,
  nodeId: string,
  { passes = 1, costly = true, verb, names, busy, holds = CANVAS_RUN }: { passes?: number; costly?: boolean;
    busy?: () => boolean; holds?: readonly string[] } & DirectRunWording = {},
): DirectRunConfirmed | null | Promise<DirectRunConfirmed | null> {
  const graph = read();
  if (!graph) return null;
  const decide = (known: DirectRunGraph) => {
    if (refuseUnchosenModel(known.nodes, known.edges, { kind: 'node', nodeId }, names)) return null;
    const asked = directRunConfirm(known.nodes, known.edges, nodeId, passes, null,
      { verb, names, gone: known.gone, changed: known.changed });
    // No dialog: answered at once, so the caller starts its run in the same
    // turn (a second click can't slip in), as before.
    if (!asked) {
      return !costly || confirmRunCost(known.nodes, known.edges, { kind: 'node', nodeId }, passes) ? known : null;
    }
    return askUntilSettled(read, nodeId, asked, passes, { verb, names }, known, busy);
  };
  // What the refusal reads isn't known yet: read it first (review 14, M-B).
  if (!runInputsUnknown(graph.nodes, graph.edges, { kind: 'node', nodeId })) return decide(graph);
  return (async () => {
    await waitForRunInputs(graph.nodes, graph.edges, { kind: 'node', nodeId }, holds);
    const now = read();
    if (!now) {
      announceDroppedYes(verb, busy);
      return null;
    }
    return decide(now);
  })();
}

/** GM - Design's notice (round 7, review 6 L-c, verbatim) when the person's
 * yes in the dialog can't start the run because another run started first:
 * the yes is dropped, never run over the other one. */
export const ANOTHER_RUN_FIRST = 'Nothing ran. Another run started first. Click “Run” again when it finishes.';
export const ANOTHER_RUN_FIRST_CINEMA = 'Nothing ran. Another run started first. Generate again when it finishes.';

/** GM - Design's notice (round 8, item 4, verbatim) when the yes can't start
 * the run because a graph import is running. */
export const STILL_IMPORTING = 'Nothing ran. Nebula is still importing. Click “Run” again when it finishes.';
export const STILL_IMPORTING_CINEMA = 'Nothing ran. Nebula is still importing. Generate again when it finishes.';

/** A yes the run can't act on says why when something holds the canvas: a
 * graph import (it comes first: no run starts while one runs), or another
 * run (`busy`). Anything else (the node deleted, the shot gone) says nothing. */
function announceDroppedYes(verb: DirectRunWording['verb'], busy?: () => boolean): void {
  const cinema = verb === 'Generate';
  if (useGraphStore.getState().isImportingGraph) useGraphStore.getState().notify(cinema ? STILL_IMPORTING_CINEMA : STILL_IMPORTING);
  else if (busy?.()) useGraphStore.getState().notify(cinema ? ANOTHER_RUN_FIRST_CINEMA : ANOTHER_RUN_FIRST);
}

/**
 * Once the dialog has shown for a run it stays the authority until the run
 * is sent or cancelled (review 5, H1; GM round 5: never the browser's
 * costly-run confirm after it). The open dialog follows the run as it
 * changes (`recompute`): a new price, another node, or its agent finishing
 * its placeholders ("Run with Codex's changes?", GM round 6). After the click
 * the run is read again: the same words run at what was shown; a run with no
 * placeholder left that the shown total still covers runs held to that total
 * (Nebula refuses it above); anything else asks again, with GM's changed line.
 */
async function askUntilSettled(
  read: () => DirectRunGraph | null,
  nodeId: string,
  first: PlaceholderRunConfirm,
  passes: number,
  wording: DirectRunWording,
  firstGraph: DirectRunGraph,
  busy?: () => boolean,
): Promise<DirectRunConfirmed | null> {
  refreshSettingsCache();
  // Every placeholder of this run a dialog has shown, with its agent: only
  // this run's, never another agent's elsewhere on the canvas (review 6, L-b).
  const shown = new Map<string, PendingAgent>();
  const remember = (graph: DirectRunGraph) => {
    for (const [id, agent] of runPlaceholders(graph.nodes, graph.edges, nodeId)) shown.set(id, agent);
  };
  const build = (graph: DirectRunGraph) => {
    remember(graph);
    return directRunConfirm(graph.nodes, graph.edges, nodeId, passes, null,
      { ...wording, shown, gone: graph.gone, changed: graph.changed });
  };
  remember(firstGraph);
  const recompute = () => {
    const graph = read();
    return graph && build(graph);
  };
  let asked = first;
  let changed = false;
  let moved: string[] = [];
  for (;;) {
    const answer = await askDirectRun(asked, changed, recompute, moved);
    if (!answer) return null;
    const graph = read();
    if (!graph) {
      // A yes that can't start: say so when another run started first (L-c)
      // or a graph import is running (GM round 8, item 4).
      announceDroppedYes(wording.verb, busy);
      return null;
    }
    // Review 14, M-B: the run as it is at the yes may no longer go out (a key
    // removed, a wire that moves it to Krea): the refusal, never the send.
    // A route that changed (its row's name or price) asks again below.
    if (refuseUnchosenModel(graph.nodes, graph.edges, { kind: 'node', nodeId }, wording.names)) return null;
    const now = build(graph);
    if (!now) return null;
    if (sameConfirm(now, answer)) {
      return { ...graph, confirmedPlaceholders: now.confirmIds, confirmedCost: now.confirmCost ?? undefined, shown };
    }
    if (now.confirmIds.length === 0 && coveredBy(answer, now)) {
      return { ...graph, confirmedPlaceholders: [], confirmedCost: answer.confirmCost ?? undefined, shown };
    }
    asked = now;
    changed = true;
    // GM - Design, round 16 (a): which nodes' route or price moved, if any.
    moved = movedRowIds(answer, now);
  }
}

/** The rows no dollar amount covers ("price not listed", "price depends on its input"), by node and model. */
function unpricedRows(model: PlaceholderRunConfirm): string[] {
  return model.rows.filter((row) => row.price === PRICE_NOT_LISTED || row.price === PRICE_DEPENDS_ON_INPUT)
    .map((row) => `${row.nodeId}\u0000${row.modelKey}\u0000${row.setting ?? ''}`);
}

/** A row as the person read it: its node, the model it runs (its raw name,
 * even when the row hides it as the node's own name: review 9, L-3), a Krea
 * node's sub-model setting (GM - Design, round 10, item 2) and its price
 * (review 7, L2: a node now on another model, or at another price, was not seen). */
function rowSeen(row: PlaceholderRunConfirm['rows'][number]): string {
  return `${row.nodeId}\u0000${row.modelKey}\u0000${row.setting ?? ''}\u0000${row.price}`;
}

/** Whether what the person confirmed (`shown`, as the dialog drew it) covers
 * the run now (review 6, L-a): a total no higher than the one shown, every
 * row on screen as it is now (its node, model and price: review 7, L2), no
 * row without a price the dialog didn't show as such, and no gate or "Not
 * included" note it didn't show. Anything new or changed asks again. */
function coveredBy(shown: PlaceholderRunConfirm, now: PlaceholderRunConfirm): boolean {
  if (shown.confirmCost === null || now.confirmCost === null) return false;
  if (now.confirmCost > shown.confirmCost) return false;
  const rows = new Set(shown.rows.map(rowSeen));
  if (!now.rows.every((row) => rows.has(rowSeen(row)))) return false;
  const unpriced = new Set(unpricedRows(shown));
  if (!unpricedRows(now).every((row) => unpriced.has(row))) return false;
  const notes = new Set(shown.costNotes);
  return now.costNotes.every((note) => notes.has(note));
}

/** The person said no when Nebula's refusal asked again, or the run can no
 * longer start when they said yes: nothing ran, and the canvas is as it was. */
const DECLINED = Symbol('declined');

/** How a direct run's start is taken back and made again around Nebula's
 * refusal (review 5, L2; GM round 6, item 4): `withdraw` leaves the canvas
 * exactly as it was before the run (no Run history record, nothing Queued,
 * no Stop, nothing streaming) while the dialog asks again; `begin` starts it
 * again after a yes, or says it can't (another run started meanwhile). */
interface DirectRunStart {
  begin: () => boolean;
  withdraw: () => void;
  /** Whether another run holds what this one needs: then a yes that can't
   * start says so (review 6, L-c). */
  busy?: () => boolean;
}

/**
 * Sends the person's direct run (`send`, with the confirmation to carry). When
 * Nebula refuses it over agents' paid placeholders, or over a total higher
 * than the person confirmed (409 `placeholder_confirm_required`: at the
 * backend's keys and measured inputs), the canvas takes the start back and
 * asks again itself in GM's dialog, priced at Nebula's numbers, with "This run
 * changed since you last reviewed it." when the person had already confirmed,
 * and starts the same run again with what they confirm. The refusal's own
 * words ("Click “Run” again…") are only for a tab too old to do this (GM,
 * round 5; review 4, M1). DECLINED: they said no, or it can't start now.
 */
async function sendDirectRun<T>(
  agreed: DirectRunConfirmed,
  nodeId: string,
  passes: number,
  stillOurs: () => boolean,
  send: (placeholders?: string[], cost?: number) => Promise<T>,
  { begin, withdraw, busy }: DirectRunStart,
  wording: DirectRunWording = {},
): Promise<T | typeof DECLINED> {
  let placeholders = agreed.confirmedPlaceholders;
  let cost = agreed.confirmedCost;
  for (;;) {
    try {
      return await send(placeholders, cost);
    } catch (error) {
      const refusal = placeholderRefusalOf(error);
      if (!refusal || !stillOurs()) throw error;
      // Review 17 (m2stale): the row's name (the route the tab resolves) and
      // its price (Nebula's estimate, on Nebula's keys) come from one route
      // resolution: the keys are read again first, within the first ask's
      // bounded wait. When they can't be read in that time, the re-ask keeps
      // Nebula's numbers, as before (review 4, M1: the yes it sends passes;
      // the canvas's own numbers would be refused again, and again).
      // Review 18, L-D: keys that couldn't be read leave the route out of
      // each row (it may be an old one); the model and Nebula's price stay.
      // Until a read lands meanwhile (App's own: the cache changes), which
      // names the route again.
      const keysRead = await rereadRunKeys();
      const cacheRead = useUIStore.getState().settingsCache;
      const routeUnknown = () => !keysRead && useUIStore.getState().settingsCache === cacheRead;
      if (!stillOurs()) throw error;
      const estimate = refusal.estimate;
      const nodes = withRefusalFlags(agreed.nodes, refusal);
      const model = directRunConfirm(nodes, agreed.edges, nodeId, passes, estimate,
        { ...wording, shown: agreed.shown, gone: agreed.gone, changed: agreed.changed, routeUnknown: routeUnknown() });
      if (!model) throw error;
      withdraw();
      const confirmIds = [...refusal.placeholders].sort();
      let asked: PlaceholderRunConfirm = { ...model, confirmIds };
      let again = placeholders !== undefined;
      let moved: string[] = [];
      let shown: PlaceholderRunConfirm | null;
      // The route each row had when Nebula refused: its estimate is for those.
      const refusedRoutes = new Map(model.rows.map((row) => [row.nodeId, routeKey(row)]));
      for (;;) {
        shown = await askDirectRun(asked, again, undefined, moved);
        if (!shown) return DECLINED;
        // Review 14, M-B: checked again on yes; a route that moved while the
        // dialog was open asks again with its new rows (their names and prices).
        if (refuseUnchosenModel(nodes, agreed.edges, { kind: 'node', nodeId }, wording.names)) return DECLINED;
        // Review 15, L-4: priced at this refusal's own estimate, the numbers
        // Nebula holds the run to, so the yes it sends passes (never a third
        // 409). Review 16, M2: only for the rows still on the route it was
        // for; a row whose route moved takes the canvas's numbers for its new
        // route, as Nebula's estimate for it reads.
        const options = { ...wording, shown: agreed.shown, gone: agreed.gone, changed: agreed.changed, routeUnknown: routeUnknown() };
        const onRoutes = directRunConfirm(nodes, agreed.edges, nodeId, passes, estimate, options);
        const movedRoutes = new Set((onRoutes?.rows ?? []).filter((row) => refusedRoutes.has(row.nodeId)
          && refusedRoutes.get(row.nodeId) !== routeKey(row)).map((row) => row.nodeId));
        const now = movedRoutes.size > 0 && estimate
          ? directRunConfirm(nodes, agreed.edges, nodeId, passes,
            mergeRunEstimates(estimate, canvasRunSummary(nodes, agreed.edges, nodeId, passes).cost, movedRoutes), options)
          : onRoutes;
        if (!now || sameRoutes(shown, now)) break;
        asked = { ...now, confirmIds };
        again = true;
        // GM - Design, round 16 (a): which nodes' route or price moved.
        moved = movedRowIds(shown, asked);
      }
      if (!begin()) {
        // The person said yes but another run started first (or an import
        // runs): it is left alone, and the yes is dropped out loud (review 6,
        // L-c; GM round 8, item 4).
        announceDroppedYes(wording.verb, busy);
        return DECLINED;
      }
      placeholders = shown.confirmIds;
      cost = shown.confirmCost ?? undefined;
    }
  }
}

/** Whether each row names the same model on the same route in both (rowSeen
 * without the price: Nebula's estimate and the canvas's can price a row apart). */
function sameRoutes(shown: PlaceholderRunConfirm, now: PlaceholderRunConfirm): boolean {
  const key = (row: PlaceholderRunConfirm['rows'][number]) => `${row.nodeId}\u0000${routeKey(row)}`;
  const seen = new Set(shown.rows.map(key));
  return now.rows.length === shown.rows.length && now.rows.every((row) => seen.has(key(row)));
}

/** A row's model on its route, and its setting: what its price is for. */
function routeKey(row: PlaceholderRunConfirm['rows'][number]): string {
  return `${row.modelKey}\u0000${row.setting ?? ''}`;
}

/** The records in `before` that `after` no longer has: what a new record pushed past the cap. */
function trimmedBy(before: RunRecord[], after: RunRecord[]): RunRecord[] {
  return before.filter((record) => !after.some((candidate) => candidate.id === record.id));
}

/** What a run start changes on its nodes (markExecutionScopeQueued), to put back. */
type NodeRunLook = Pick<NodeData, 'state' | 'error' | 'progress' | 'streamingText' | 'streamingPartials' | 'streamingSvg'>;

function runLookOf(nodes: Node<NodeData>[], ids: Set<string>): Map<string, NodeRunLook> {
  return new Map(nodes.filter((node) => ids.has(node.id)).map((node) => [node.id, {
    state: node.data.state, error: node.data.error, progress: node.data.progress,
    streamingText: node.data.streamingText, streamingPartials: node.data.streamingPartials,
    streamingSvg: node.data.streamingSvg }]));
}

/**
 * Takes back a run start Nebula refused before anything ran (review 5, L2;
 * GM round 6, item 4: "If Nebula refused, nothing is running"): its owner,
 * its Run history record (and the older ones its record pushed past the cap,
 * `trimmed`), and its nodes' Queued, back to how they were (`before`) where
 * nothing else has changed them since.
 */
function withdrawRunStart(runId: string, set: GraphSet, before: ReadonlyMap<string, NodeRunLook>,
  trimmed: RunRecord[]): void {
  activeRunOwners.delete(runId);
  if (currentRunId === runId) currentRunId = null;
  pendingStartRunIds.delete(runId);
  cancellationRequestedRunIds.delete(runId);
  const timer = statusReconciliationTimers.get(runId);
  if (timer !== undefined) clearTimeout(timer);
  statusReconciliationTimers.delete(runId);
  runErrors.delete(runId);
  runShareableInputs.delete(runId);
  set((state) => {
    const kept = state.runHistory.filter((record) => record.id !== runId);
    const back = trimmed.filter((record) => !kept.some((candidate) => candidate.id === record.id));
    return {
      ...ownershipState(),
      runHistory: persistedRunHistory([...kept, ...back]),
      nodes: state.nodes.map((node) => {
        const look = before.get(node.id);
        if (!look || node.data.state !== 'queued') return node;
        return { ...node, data: { ...node.data, ...look } };
      }),
    };
  });
}

/** A shot's name as the Cinema panel shows it: "Shot 2" for the second. */
function shotName(scene: CinemaSceneSpec | undefined, shotId: string): string {
  const index = scene?.shots?.findIndex((shot) => shot.id === shotId) ?? -1;
  return `Shot ${index >= 0 ? index + 1 : 1}`;
}

/** The scene with only `shotId` in it: what a Cinema shot runs and is priced
 * as (backend main.generate_cinema_shot runs a single-shot copy). */
function oneShotCanvas(nodes: Node<NodeData>[], cinemaId: string, shotId: string): Node<NodeData>[] {
  return nodes.map((node) => {
    if (node.id !== cinemaId) return node;
    const params = (node.data.params ?? {}) as Record<string, unknown>;
    const scene = params.scene as CinemaSceneSpec | undefined;
    if (!scene || !Array.isArray(scene.shots)) return node;
    return { ...node, data: { ...node.data,
      params: { ...params, scene: { ...scene, shots: scene.shots.filter((shot) => shot.id === shotId) } } } };
  });
}

/**
 * A saved run's snapshot as canvas nodes for its cost and dialog: what the
 * replay sends (its params, its connections), with the live canvas's names
 * and placeholder flags, since the backend reads which nodes are still
 * placeholders from the canvas as it is now, by id (main._skip_placeholders):
 * a placeholder the agent turned into another type is still asked about.
 *
 * Review 7, L1: the replay sends its saved copy of every node, so what runs
 * decides the words. A saved node whose live one was deleted, or is now
 * another type and no placeholder, is `gone`: its copy runs as a paid node
 * of the run, and an agent's placeholder there counts as one that left the
 * run, never as "finished". `names` keeps each node's name as the dialog
 * last showed it, for a node deleted since.
 *
 * GM - Design on review 8 L-b: a saved node whose live one is the same type
 * with other settings is `changed`: the replay sends the saved settings, so
 * an agent's placeholder there is worded as its saved version ("Replay the
 * saved version?"), never as the agent's changes.
 */
function snapshotCanvas(snapshot: RunGraphSnapshot, live: Node<NodeData>[], names = new Map<string, string>()): DirectRunGraph {
  const byId = new Map(live.map((node) => [node.id, node]));
  const gone = new Set<string>();
  const changed = new Set<string>();
  const nodes = snapshot.nodes.map((saved) => {
    const now = byId.get(saved.id);
    const flag = now ? cleanPending(now.data.pending) : null;
    if (!flag && (!now || now.data.definitionId !== saved.definitionId)) gone.add(saved.id);
    else if (now && now.data.definitionId === saved.definitionId
      && !sameRecipeParams(saved.definitionId, saved.params, (now.data.params ?? {}) as Record<string, unknown>)) changed.add(saved.id);
    if (now) names.set(saved.id, now.data.label ?? '');
    return {
      id: saved.id, type: now?.type ?? 'model-node', position: now?.position ?? { x: 0, y: 0 },
      data: { definitionId: saved.definitionId, label: now?.data.label ?? names.get(saved.id) ?? '', params: saved.params,
        state: 'idle', outputs: {}, ...(flag ? { pending: flag } : {}) },
    } as Node<NodeData>;
  });
  const edges = snapshot.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target,
    sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null })) as Edge[];
  return { nodes, edges, gone, changed };
}

export const useGraphStore = create<GraphState>()(noticeFollowsStacks((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: activeRunOwners.size > 0,
  runStarting: false,
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

  // The person's Undo and Redo are their own edits (GM r13 on PR #199, 1).
  undo: () => { if (get().undoStack.length > 0) notePersonInput(); stepHistory('undo', set, get); },

  redo: () => { if (get().redoStack.length > 0) notePersonInput(); stepHistory('redo', set, get); },

  beginUndoStep: (options) => {
    breakUndoDebounce();
    const step = pushUndo(set, get);
    holdStep(step);
    if (options?.clear) {
      clearSteps.set(step, ++historyOrder);
      // A clear adds nothing: its undo takes no node off (review 15, M-A follow-up).
      stepAdds.set(step, new Set());
    }
    return step;
  },

  cancelUndoStep: (step) => {
    // Only while nothing was stacked on top of it: a later step depends on it.
    set((state) => state.undoStack[state.undoStack.length - 1] === step
      ? { undoStack: state.undoStack.slice(0, -1) } : {});
    // Review 17, M-1: one that stays (a newer step above it) added nothing,
    // so it is dead (dropDeadSteps) instead of reading its additions off the
    // canvas: its Cmd+Z took off a node someone else added (Z1, seed 104).
    if (!isForeignEdit(step as UndoEntry)) stepAdds.set(step as UndoEntry, new Set());
    settleStep(step as UndoEntry, set, get);
  },

  endUndoStep: (step, options) => {
    const entry = step as UndoEntry;
    // An upload's node comes with its echo, which can land after the answer
    // (review 11, L-2): the step settles once that node is on the canvas.
    const ids = (options?.arrives ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    // With any a dead step below handed it (handAddsUp).
    if (options?.arrives) ownArrivals.set(entry, new Set([...(ownArrivals.get(entry) ?? []), ...ids]));
    const present = new Set(get().nodes.map((node) => node.id));
    // A node that came and was taken off again (a delete while the answer
    // was on its way) has arrived: nothing to wait for (round 17's property test).
    const arrived = arrivedSince.get(entry);
    if (ids.length > 0 && stepsInFlight.has(entry) && !awaitingArrival.has(entry)
      && get().undoStack.includes(entry) && ids.some((id) => !present.has(id) && !arrived?.has(id))) {
      awaitArrival(entry, ids, set);
      return;
    }
    if (awaitingArrival.has(entry)) return;
    settleStep(entry, set, get);
  },

  noteOwnAdd: (nodeIds) => { pushOwnAdd(set, get, nodeIds); },

  undoNotice: null,
  dismissUndoNotice: () => set({ undoNotice: null }),
  lateNotice: null,
  dismissLateNotice: () => set({ lateNotice: null }),
  messageNotice: null,
  dismissMessageNotice: () => set({ messageNotice: null }),
  // Empty: a write refused while offline says nothing (round 15 of PR #114).
  notify: (text, tone = 'error', options) => {
    if (!text) return;
    set((state) => noticeLine(state, text, tone, options?.mono));
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
    // The step owns the copies it made (round 14 of PR #114).
    pushOwnAdd(set, get, newNodes.map((node) => node.id));
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
    pushOwnAdd(set, get, newNodes.map((node) => node.id));
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

    const defaults = buildDefaultParams(definition);
    Object.assign(defaults, withNewKreaMode(definition, {},
      useUIStore.getState().settingsCache.kreaConnectionMode));
    return createNodeOnBackend(set, get, definitionId, defaults, position);
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
    set((state) => ({ nodes: [...state.nodes, target], edges: [...state.edges, edge] }));
    pushOwnAdd(set, get, [targetId]);
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
    // The add is its own undo step, taken before the request (the backend
    // broadcasts the committed graph before it answers, and a Cmd+Z meanwhile
    // waits for it), owning exactly the node the answer names. A node Nebula
    // made stays this step's to take off even when the canvas changed while
    // the answer was on its way (round 17's property test: the person deleted
    // the origin, the node stayed, and no step owned it).
    const step = get().beginUndoStep();
    let committed: string | null = null;
    try {
      const res = await graphMutationFetch('/api/graph/node-and-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definitionId, params: defaults, position, connect }),
      });
      if (!res.ok) {
        definiteOutcome = res.status >= 400 && res.status < 500;
        return fail(await backendRejectionReason(res, addHeading(definition.displayName)));
      }
      const node = (await res.json()) as { id?: unknown; definitionId?: unknown; params?: Record<string, unknown>;
        connected?: boolean; edge?: Edge };
      if (typeof node.id !== 'string' || !CLI_ID_RE.test(node.id) || knownIds.has(node.id)
        || (node.definitionId !== undefined && node.definitionId !== definitionId)) {
        return fail('The backend returned an invalid node acknowledgement. The request may have committed; check canvas sync before trying again.');
      }
      committed = node.id;
      if (originRevoked || replacementRevision !== canvasReplacementRevision) {
        // Nebula said what it made: nothing is left unresolved (a later
        // add-and-connect isn't refused for it: round 17's P-2).
        definiteOutcome = true;
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
      const data: NodeData = { label: canvasTitle(definition), definitionId, params, state: 'idle', outputs: {},
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
      }));
      // Its step (taken before the request) owns the new node, its wire
      // with it (round 14 of PR #114's intent; #195's in-flight step).
      definiteOutcome = true;
      return nodeId;
    } catch (err) {
      console.warn('[nebula] addNodeAndConnect backend push failed:', err);
      return fail('The backend response was lost or invalid. This request may have committed; check canvas sync before trying again.');
    } finally {
      settleConnectedAttempt(attempt, definiteOutcome);
      synced.stop();
      unsubscribe();
      if (committed) get().endUndoStep(step, { arrives: [committed] });
      else get().cancelUndoStep(step);
    }
  },

  addDynamicNode: (definitionId, position) => {
    if (get().isImportingGraph) return null;
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return null;

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
        label: canvasTitle(definition),
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

    // Its step owns this card, and later the backend id it gets (round 14 of
    // PR #114): the sync below, or another add racing this one, never widens it.
    const undoStep = pushOwnAdd(set, get, [tempId]);

    // Round 12 of PR #114: the same path as every add. On an empty tab the
    // backend's own nodes come in first (never a clear), and a failure takes
    // the node off this tab again (it had stayed there, frontend-only, with
    // only a console line) and says why, as addNode does.
    const takeBack = (): null => {
      set((state) => ({
        nodes: state.nodes.filter((n) => n.id !== tempId),
        edges: state.edges.filter((e) => e.source !== tempId && e.target !== tempId),
      }));
      dropOwnAdd(set, undoStep);
      return null;
    };

    // Push to cli_graph. When it returns, swap the UUID for the short id so
    // subsequent edits flow through the usual cli path.
    pendingGraphMutationCount += 1;
    void (async () => {
      try {
        // No backend found at all: refused, the card comes off (GM, round 13).
        if (!await bringBackendGraphIntoEmptyTab(localCanvasWasEmpty, set, get)) {
          takeBack();
          return refuseAdd(addNotConnectedLine(definition.displayName));
        }
      } catch (err) {
        takeBack();
        return reportNodeCreationError(definition.displayName, err);
      }
      let res: Response;
      try {
        res = await graphMutationFetch('/api/graph/node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definitionId, params: defaults, position }),
        });
      } catch {
        // The backend may have it: its graphSync brings it in, so no copy stays here.
        takeBack();
        return reportNodeCreationFailure(definition.displayName,
          'The backend response was lost after the node-create request was sent. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.');
      }
      if (!res.ok) {
        const reason = await backendRejectionReason(res, addHeading(definition.displayName));
        takeBack();
        return reportNodeCreationFailure(definition.displayName, reason);
      }
      let body: { id?: unknown };
      try {
        body = (await res.json()) as { id?: unknown };
      } catch {
        takeBack();
        return reportNodeCreationFailure(definition.displayName,
          'Backend returned an invalid response after node creation. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.');
      }
      const shortId = body.id;
      if (typeof shortId !== 'string' || !shortId) {
        takeBack();
        return reportNodeCreationFailure(definition.displayName,
          'Backend returned no node id after node creation. Nebula did not add a local copy because the backend may already have committed it. Wait for canvas sync or reload before trying again.');
      }
      // Remap edges too so any connections drawn during the race window
      // keep pointing at the renamed node.
      const drawn = new Set(get().edges.filter((e) => e.source === tempId || e.target === tempId).map((e) => e.id));
      if (undoStep) renameOwnedNode(undoStep, tempId, shortId);
      set((state) => ({
        // The create's own graphSync lands before its answer (the backend
        // broadcasts first) and may have brought the node in already: the
        // card then goes, rather than becoming a second node with that id.
        nodes: state.nodes.some((n) => n.id === shortId)
          ? state.nodes.filter((n) => n.id !== tempId)
          : state.nodes.map((n) => (n.id === tempId ? { ...n, id: shortId } : n)),
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
      return null;
    })().finally(() => { pendingGraphMutationCount -= 1; });

    return tempId;
  },

  // No confirm (GM, 2026-10-23): undo puts back everything a delete removed,
  // so the delete says "Deleted the node." with Undo instead (lib/deleteNotice.ts).
  allowCanvasDelete: (nodeIds) => !refuseHeldNodeDelete(get(), nodeIds, set),

  onNodesChange: (changes) => changeCanvasNodes(changes, set, get),

  onEdgesChange: (changes) => {
    if (get().isExecuting && changes.some((change) => change.type === 'remove')) return;
    if (changes.some((change) => change.type === 'remove')) pushUndo(set, get);
    applyCanvasEdgeChanges(changes, set, get);
  },

  deleteCanvasElements: (nodeIds, edgeIds) => {
    const state = get();
    if (state.isExecuting) return;
    const nodes = nodeIds.filter((id) => state.nodes.some((node) => node.id === id));
    // A node holding World Labs state stays, and then nothing goes (as React
    // Flow's onBeforeDelete had it).
    if (nodes.length > 0 && refuseHeldNodeDelete(state, nodes, set)) return;
    const doomed = new Set(nodes);
    // The wires of deleted nodes go with them; these are the other selected ones.
    const wires = edgeIds.filter((id) => {
      const edge = state.edges.find((candidate) => candidate.id === id);
      return edge !== undefined && !doomed.has(edge.source) && !doomed.has(edge.target);
    });
    const wireChanges = wires.map((id) => ({ id, type: 'remove' as const }));
    if (nodes.length === 0) {
      if (wireChanges.length > 0) get().onEdgesChange(wireChanges);
      return;
    }
    // Review 9, L-4: one step for all of it. React Flow's deleteElements
    // removed the wires (one step) and then the nodes (another), so the first
    // Cmd+Z put a node back without its wire.
    breakUndoDebounce();
    const step = pushUndo(set, get);
    if (wireChanges.length > 0) applyCanvasEdgeChanges(wireChanges, set, get);
    changeCanvasNodes(nodes.map((id) => ({ id, type: 'remove' as const })), set, get, { step, keep: wireChanges.length > 0 });
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
    // Kept in this tab after a restore (GM r15 on PR #199, Q11): the typing
    // stays on the canvas only, for [Save as a project]; nothing is sent.
    if (isParamChange && CLI_ID_RE.test(nodeId) && !isCanvasKept()) {
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
    renameDrafts.delete(nodeId);
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const next = cleanNodeLabel(node, label);
    if (next === node.data.label) return;
    const previous = node.data.label;
    get().updateNodeData(nodeId, { label: next });
    // Local-only nodes keep the name in the frontend graph; backend nodes
    // store it so graphSync, project restore and agents all see it.
    if (!CLI_ID_RE.test(nodeId)) return;
    // Until Nebula answers, an agent's switch carries it in the handoff (round 20, H1).
    if (!labelsInFlight.has(nodeId) && typeof previous === 'string') labelsSavedBefore.set(nodeId, previous);
    labelsInFlight.set(nodeId, next);
    // Round 23 (L-1): as a param save, for an agent's clear read before the answer.
    const landed = watchLanding(nodeId, (was) => ({ ...was, data: { ...was.data, label: next } }));
    graphMutationFetch(`/api/graph/node/${nodeId}/label`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: next }),
    }, { saves: renameSave(node, previous) }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).then(() => {
      // Nebula has it: it's the saved name now.
      landed(true);
      if (labelsInFlight.get(nodeId) !== next) labelsSavedBefore.set(nodeId, next);
    }).finally(() => {
      landed(false);
      if (labelsInFlight.get(nodeId) === next) {
        labelsInFlight.delete(nodeId);
        labelsSavedBefore.delete(nodeId);
      }
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
    // A run waiting for its inputs counts as starting (review 15, M-B).
    if (get().isExecuting || get().runStarting || get().isImportingGraph) return;
    // What the refusal reads is known first (review 14, M-B).
    if (runInputsUnknown(get().nodes, get().edges, { kind: 'graph' })) {
      await waitForRunInputs(get().nodes, get().edges, { kind: 'graph' }, CANVAS_RUN);
    }
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting || get().isImportingGraph) return;
    const uploadIssue = pendingCinemaUploadIssue(nodes);
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    if (refuseUnchosenModel(nodes, edges, { kind: 'graph' })) return;
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
      announcePendingSkips(result);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't start the run.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && (currentRunId === runId || ownsRun(runId))) {
        const onItsCanvas = runOnItsCanvas(runId);
        closeTrackedRun(set, runId, { status: 'failed' });
        set((state) => ({
          nodes: !onItsCanvas ? state.nodes : markNodesWithValidationErrors(
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
      if (currentRunId !== runId && !ownsRun(runId)) return;  // see the replay's catch
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get, err);
        return;
      }
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({
        nodes: !onItsCanvas ? state.nodes : markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges).map((node) => node.id)),
          failureMessage(err, "Couldn't start the run."),
          err,
        ),
        ...ownershipState(),
      }));
    }
  },

  executeNode: async (nodeId, options) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    // A run waiting for its inputs counts as starting (review 15, M-B).
    if (isExecuting || get().runStarting || get().isImportingGraph) return;
    const uploadIssue = pendingCinemaUploadIssue(nodesInExecutionScope(nodes, edges, nodeId));
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    // An accepted proposal's run (approvalId) isn't the person's direct run:
    // it skips agents' placeholders, so its cost leaves them out (Q125 item 3).
    // The person's direct run over agents' paid placeholders always asks
    // first, in one dialog in place of the costly-run confirm (Q133); the
    // run sends the ones confirmed, and the backend refuses it without them.
    let agreed: DirectRunConfirmed | null;
    if (options?.approvalId) {
      const scope = { kind: 'node', nodeId, direct: false } as const;
      let graph = { nodes, edges };
      // What the refusal reads is known first (review 14, M-B).
      if (runInputsUnknown(nodes, edges, scope)) {
        await waitForRunInputs(nodes, edges, scope, CANVAS_RUN);
        if (get().isExecuting || get().isImportingGraph) return;
        graph = { nodes: get().nodes, edges: get().edges };
      }
      if (refuseUnchosenModel(graph.nodes, graph.edges, scope)) return;
      agreed = confirmRunCost(graph.nodes, graph.edges, scope) ? graph : null;
    } else {
      // The dialog waits for the person: another run may start meanwhile.
      let first = true;
      const answer = confirmDirectRun(() => {
        if (!first && (get().isExecuting || get().isImportingGraph)) return null;
        first = false;
        return { nodes: get().nodes, edges: get().edges };
      }, nodeId, { verb: options?.verb, busy: () => get().isExecuting });
      agreed = answer instanceof Promise ? await answer : answer;
    }
    if (!agreed) return;
    const { nodes: runNodes, edges: runEdges } = agreed;
    resetExecution();
    const snapshot = captureRunSnapshot(runNodes, runEdges);
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
    let before = new Map<string, NodeRunLook>();
    let trimmed: RunRecord[] = [];
    // Registers the run: its Run history record, its nodes Queued, Stop. Again
    // after Nebula's refusal and a yes, unless another run started meanwhile.
    const begin = (again = false) => {
      if (again && (get().isExecuting || get().isImportingGraph)) return false;
      const state = get();
      before = runLookOf(state.nodes, new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)));
      const historyBefore = state.runHistory;
      currentRunId = runId;
      registerRun(runId, snapshot, nodeId);
      set((current) => ({
        activeRuns: ownershipState().activeRuns,
        nodes: markExecutionScopeQueued(current.nodes, current.edges, nodeId),
        isExecuting: true,
        isCancelling: false,
        runHistory: persistedRunHistory(openRunRecord(current.runHistory, {
          id: runId,
          trigger: 'node',
          startedAt: Date.now(),
          snapshot,
          targetNodeId: nodeId,
          startedFreshPaidWorldLabs: runIncludesFreshPaidWorldLabsStart(snapshot, nodeId),
        })),
      }));
      trimmed = trimmedBy(historyBefore, get().runHistory);
      pendingStartRunIds.add(runId);
      return true;
    };
    begin();
    try {
      const result = await sendDirectRun(agreed, nodeId, 1,
        () => ownsRun(runId) && !cancellationRequestedRunIds.has(runId),
        (placeholders, cost) => apiExecuteNode(snapshot.nodes, snapshot.edges, nodeId, runId, undefined,
          options?.approvalId, placeholders, cost),
        { begin: () => begin(true), withdraw: () => withdrawRunStart(runId, set, before, trimmed),
          busy: () => get().isExecuting },
        { verb: options?.verb });
      // The person said no when Nebula asked again: nothing ran, and the
      // start was already taken back.
      if (result === DECLINED) return;
      pendingStartRunIds.delete(runId);
      announcePendingSkips(result);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't run the node.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && (currentRunId === runId || ownsRun(runId))) {
        const onItsCanvas = runOnItsCanvas(runId);
        closeTrackedRun(set, runId, { status: 'failed' });
        set((state) => ({
          nodes: !onItsCanvas ? state.nodes : markNodesWithValidationErrors(
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
      if (currentRunId !== runId && !ownsRun(runId)) return;  // see the replay's catch
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get, err);
        return;
      }
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({
        nodes: !onItsCanvas ? state.nodes : markNodesErrored(
          state.nodes,
          new Set(nodesInExecutionScope(state.nodes, state.edges, nodeId).map((node) => node.id)),
          failureMessage(err, "Couldn't run the node."),
          err,
        ),
        ...ownershipState(),
      }));
    }
  },

  isShotAdmissionBlocked: (nodeId, shotId) => {
    if (get().isImportingGraph) return true;
    if (pendingCinemaUploadIssue(nodesInExecutionScope(get().nodes, get().edges, nodeId), { nodeId, shotId })) return true;
    return shotOverlapsActiveRun(get().nodes, get().edges, nodeId, shotId);
  },

  executeShot: async (nodeId, shotId, seed, variations) => {
    // The shot as the live graph holds it, or null when it can't start: check
    // IDs before looking at the live graph, so deleting a node cannot erase
    // its outstanding owner and allow a second paid launch for that same shot.
    // The shot's own 'running' status doubles as the in-flight guard — no
    // global isExecuting lock, so other shots (and the rest of the canvas)
    // stay usable.
    const admissible = () => {
      if (get().isShotAdmissionBlocked(nodeId, shotId)) return null;
      const { nodes: liveNodes, edges: liveEdges } = get();
      const liveNode = liveNodes.find((n) => n.id === nodeId);
      if (!liveNode || liveNode.data.definitionId !== 'cinema-scene') return null;
      const liveScene = (liveNode.data.params as { scene?: CinemaSceneSpec }).scene;
      if (!liveScene || !Array.isArray(liveScene.shots)) return null;
      const liveShot = liveScene.shots.find((s) => s.id === shotId);
      if (!liveShot || liveShot.output?.status === 'running') return null;
      return { nodes: liveNodes, edges: liveEdges, scene: liveScene, shot: liveShot };
    };
    // The same shot waiting for its inputs counts as running (review 15, M-B).
    if (runWaiting([shotRunKey(nodeId, shotId)])) return;
    let live = admissible();
    if (!live) return;
    // A shot is the person's direct run of the scene (Q133; review 3, finding
    // 1): a paid placeholder feeding it asks first in GM's dialog, else the
    // costly-run setting decides, priced as the one shot it generates times
    // its variations (each a full pass), as the backend checks it.
    // From Cinema the dialog says Generate, and the scene's row is the shot's
    // (GM - Design, round 6, item 3: “Shot 1” · Nano Banana · $0.07).
    const wording: DirectRunWording = { verb: 'Generate', names: { [nodeId]: shotName(live.scene, shotId) } };
    // Another run holds this shot: it started meanwhile, or a run over the
    // same nodes did (review 6, L-c: a yes then says so).
    const shotBusy = () => {
      if (get().isImportingGraph) return false;
      const current = (get().nodes.find((n) => n.id === nodeId)?.data.params as { scene?: CinemaSceneSpec } | undefined)?.scene;
      if (current?.shots?.find((s) => s.id === shotId)?.output?.status === 'running') return true;
      return shotOverlapsActiveRun(get().nodes, get().edges, nodeId, shotId);
    };
    const answer = confirmDirectRun(() => {
      live = admissible();
      return live && { nodes: oneShotCanvas(live.nodes, nodeId, shotId), edges: live.edges };
    }, nodeId, { passes: variations ?? 1, busy: shotBusy, holds: [shotRunKey(nodeId, shotId)], ...wording });
    const agreed = answer instanceof Promise ? await answer : answer;
    if (!agreed || !live) return;
    const { nodes, edges, scene, shot } = live;

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

    const graphNodes = shotSnapshot.nodes;
    const graphEdges = shotSnapshot.edges.map((edge) => ({
      ...edge,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }));

    // Clear the optimistic spinner to an error state when no graphSync will
    // follow (up-front validation failure or a thrown request).
    const failShot = (message: string, reading?: ValidationReading) => {
      if (!runOnItsCanvas(runId)) return;  // a replaced graph's node only shares the id (round 11)
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
    let trimmed: RunRecord[] = [];
    let shotBefore: CinemaShot['output'];
    // Registers the shot's run: the shot marked running (local only — the
    // backend streams the terminal scene back via graphSync), its Run history
    // record, Stop. Again after Nebula's refusal and a yes, unless the shot
    // can't start now.
    const begin = (again = false) => {
      if (again && get().isShotAdmissionBlocked(nodeId, shotId)) return false;
      const current = (get().nodes.find((n) => n.id === nodeId)?.data.params as { scene?: CinemaSceneSpec } | undefined)?.scene;
      const currentShot = current?.shots.find((s) => s.id === shotId);
      if (again && (!current || !currentShot || currentShot.output?.status === 'running')) return false;
      shotBefore = (currentShot ?? shot).output;
      const historyBefore = get().runHistory;
      applySceneToNode(set, nodeId, patchShot(current ?? scene, { ...withoutShotError(shotBefore), status: 'running' }));
      registerRun(runId, shotSnapshot, nodeId, shotId);
      pendingStartRunIds.add(runId);
      set((state) => ({ ...ownershipState(), runHistory: persistedRunHistory(openRunRecord(state.runHistory, {
        id: runId, trigger: 'shot', startedAt: Date.now(), snapshot: shotSnapshot,
        targetNodeId: nodeId, startedFreshPaidWorldLabs: false,
        cinemaShot: { nodeId, shotId, seed, variations },
      })) }));
      trimmed = trimmedBy(historyBefore, get().runHistory);
      return true;
    };
    // Nebula refused it before anything ran: the shot as it was, no record (review 5, L2).
    const withdraw = () => {
      withdrawRunStart(runId, set, new Map(), trimmed);
      const current = (get().nodes.find((n) => n.id === nodeId)?.data.params as { scene?: CinemaSceneSpec } | undefined)?.scene;
      if (!current || current.shots.find((s) => s.id === shotId)?.output?.status !== 'running') return;
      applySceneToNode(set, nodeId, { ...current, shots: current.shots.map((s) => {
        if (s.id !== shotId) return s;
        const back: CinemaShot = { ...s, output: shotBefore };
        if (!shotBefore) delete back.output;
        return back;
      }) });
    };
    begin();
    try {
      const result = await sendDirectRun(agreed, nodeId, variations ?? 1,
        () => ownsRun(runId) && !cancellationRequestedRunIds.has(runId),
        (placeholders, cost) => apiGenerateShot(graphNodes, graphEdges, nodeId, shotId, seed, variations, runId,
          placeholders, cost),
        { begin: () => begin(true), withdraw, busy: shotBusy }, wording);
      if (result === DECLINED) return;
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
      } else await reconcileWorldLabsExecutionStatus(runId, set, get, err);
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
    // A run waiting for its inputs counts as starting (review 15, M-B).
    if (get().isExecuting || get().runStarting || get().isImportingGraph) return;
    // What the refusal reads is known first (review 14, M-B).
    if (runInputsUnknown(get().nodes, get().edges, { kind: 'cluster', nodeIds })) {
      await waitForRunInputs(get().nodes, get().edges, { kind: 'cluster', nodeIds }, CANVAS_RUN);
    }
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting || get().isImportingGraph) return;
    const idSet = new Set(nodeIds);
    const clusterNodes = nodes.filter((n) => idSet.has(n.id));
    if (clusterNodes.length === 0) return;
    const uploadIssue = pendingCinemaUploadIssue(clusterNodes);
    if (uploadIssue) { warnPendingCinemaUpload(uploadIssue); return; }
    const clusterEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    if (refuseUnchosenModel(nodes, edges, { kind: 'cluster', nodeIds })) return;
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
      announcePendingSkips(result);
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status !== 'started' && result.status !== 'validation_error') {
        throw new ExecutionStartRejectedError(
          notStartedMessage("Couldn't start the run.", result.status),
          400,
        );
      }
      if (result.status === 'validation_error' && (currentRunId === runId || ownsRun(runId))) {
        const onItsCanvas = runOnItsCanvas(runId);
        closeTrackedRun(set, runId, { status: 'failed' });
        set((state) => ({
          nodes: !onItsCanvas ? state.nodes : markNodesWithValidationErrors(
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
      if (currentRunId !== runId && !ownsRun(runId)) return;  // see the replay's catch
      if (!(err instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get, err);
        return;
      }
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({
        nodes: !onItsCanvas ? state.nodes
          : markNodesErrored(state.nodes, idSet, failureMessage(err, "Couldn't start the run."), err),
        ...ownershipState(),
      }));
    }
  },

  executeClusterConcurrent: async (nodeIds, createOrigin) => {
    // Its nodes waiting in another start count as running (review 15, M-B).
    const holds = nodeIds.map((id) => `node:${id}`);
    if (get().isImportingGraph || runWaiting(holds)) return;
    // What the refusal reads is known first (review 14, M-B).
    if (runInputsUnknown(get().nodes, get().edges, { kind: 'cluster', nodeIds })) {
      await waitForRunInputs(get().nodes, get().edges, { kind: 'cluster', nodeIds }, holds);
      if (get().isImportingGraph) return;
    }
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
    if (refuseUnchosenModel(nodes, edges, { kind: 'cluster', nodeIds })) return;
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
      announcePendingSkips(result);
      if (!ownsRun(runId)) return;
      if (await honorCancellationAfterStart(runId, result.status, set, get)) return;
      if (result.status === 'started') {
        updateRunPhase(runId, 'running', set);
        scheduleWorldLabsStatusReconciliation(runId, set, get);
        return;
      }
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: 'failed' });
      set((state) => ({ nodes: !onItsCanvas ? state.nodes : result.status === 'validation_error'
        ? markNodesWithValidationErrors(state.nodes, idSet, result.errors)
        : markNodesErrored(state.nodes, idSet, notStartedMessage("Couldn't start the run.", result.status)) }));
    } catch (error) {
      settleFailedStart(runId, error);
      if (!ownsRun(runId)) return;
      console.error('Failed to start concurrent generation:', error);
      // A lost HTTP acknowledgement can follow an accepted start. Query the
      // client-owned ID before releasing ownership and permitting duplicate work.
      if (!(error instanceof ExecutionStartRejectedError)) {
        await reconcileWorldLabsExecutionStatus(runId, set, get, error);
        return;
      }
      const onItsCanvas = runOnItsCanvas(runId);
      closeTrackedRun(set, runId, { status: cancellationRequestedRunIds.has(runId) ? 'cancelled' : 'failed' });
      set((state) => ({ nodes: !onItsCanvas ? state.nodes : markNodesErrored(state.nodes, idSet,
        failureMessage(error, "Couldn't start the run."), error) }));
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
    // Review 16, M1: one undo step for the cluster, taken before the request
    // (its echo can bring the nodes before the answer), owning what it added.
    const step = get().beginUndoStep();
    let arrived: string[] | null = null;
    try {
      const synced = watchGraphSyncs();
      try {
        const res = await graphMutationFetch('/api/graph/cluster', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: specNodes, edges: specEdges }),
        });
        if (!res.ok) throw await requestError(GENERATE_HEADING, res);
        const data = (await res.json()) as { idMap: Record<string, string>; nodes: Node<NodeData>[]; edges: Edge[] };
        idMap = data.idMap; rfNodes = data.nodes ?? []; rfEdges = data.edges ?? [];
      } catch (err) {
        console.error('[nebula] authorGenerationCluster persist failed:', err);
        // Refused while offline: nothing was sent, and Create says nothing.
        if (isOfflineRefusal(err)) throw err;
        throw new FailureNotice(GENERATE_HEADING, `${CLUSTER_NOT_ADDED} ${clusterFailureReason(err)}`);
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
      // The step owns every node the cluster made (round 14 of PR #114's
      // intent), whichever came first, its answer or its echo.
      arrived = rfNodes.map((n) => n.id);
      return { modelNodeIds, allNodeIds };
    } finally {
      if (arrived) get().endUndoStep(step, { arrives: arrived });
      else get().cancelUndoStep(step);
    }
  },

  adoptAcceptedProposal: ({ nodes: incoming, edges: incomingEdges, updatedNodes: replyUpdates }, options) => {
    // The backend already committed these (and broadcast a graphSync); adding
    // them here too means the nodes exist locally before the canvas runs them.
    // Round 15 of PR #114 (review 14, M5): Accept's undo step owns only what
    // it changed, the ids it added and the param keys it set, as an add's
    // does (OwnAdd), never a whole-canvas snapshot. The step Accept took
    // before sending (its graphSync can land before this reply, so the
    // canvas now may hold them already) is only read for the values before
    // and leaves the stack; a press held for it applies to the OwnAdd that
    // replaces it (#195's in-flight steps). The step owns nothing anyone
    // else made, so it goes on top even when an agent's edit landed
    // meanwhile: the person's next Undo undoes the Accept, and never removes
    // an agent's node.
    const step = options?.undoStep as UndoEntry | undefined;
    // Taken of a canvas that has since been replaced: nothing of it is here.
    if (step && !sameGraphAs(step)) return;
    const snapshot = step && !isSliceStep(step) ? step : undefined;
    const beforeById = new Map((snapshot?.nodes ?? get().nodes).map((node) => [node.id, node]));
    // The reply's values as a sync writes them (absolute asset links), so a
    // value Accept set compares equal to the same value on the canvas
    // (round 17 of PR #114, review 16 M2).
    const updatedNodes = rewriteBackendAssetUrls(replyUpdates);
    const changes: OwnParamChange[] = [];
    for (const update of updatedNodes) {
      const was = beforeById.get(update.id);
      const change = was ? paramChange(was, update) : null;
      if (change) changes.push(change);
    }
    // The nodes as Accept added them, written as a sync writes them (asset
    // URLs), so Undo can tell whether someone edited one since.
    // A press held for Accept's step applies to the OwnAdd only while
    // nothing landed above that step meanwhile (#195's review 11, H9: an
    // agent's edit landed first, so the press can't know what it undoes,
    // and is dropped).
    const stack = get().undoStack;
    const onTop = step !== undefined && stack.indexOf(step) === stack.length - 1;
    const own = pushOwnAdd(set, get, incoming.map((node) => node.id), changes, rewriteBackendAssetUrls(incoming));
    if (step) {
      if (own && onTop) stepSuccessors.set(step, own);
      set((state) => (state.undoStack.includes(step)
        ? { undoStack: state.undoStack.filter((entry) => entry !== step) } : {}));
    }
    set((state) => {
      const updates = new Map(updatedNodes.map((node) => [node.id, node]));
      const merged = state.nodes.map((node) => {
        const update = updates.get(node.id);
        if (!update) return node;
        // A key a sync changed since Accept began (an agent's edit landing
        // during Accept, or the proposal's own echo) keeps the sync's value:
        // the reply is older (round 16 of PR #114, review 15 M5).
        const was = beforeById.get(node.id)?.data.params ?? {};
        const params = { ...node.data.params };
        for (const [key, value] of Object.entries(update.data.params ?? {})) {
          if (sameValue(params[key], was[key])) params[key] = value;
        }
        return { ...node, data: { ...node.data, params } };
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
    pushOwnAdd(set, get, [newNode.id]);
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

    // The add path's own handling (round 12 of PR #114): the backend's
    // nodes come into an empty tab first, and a failure adds nothing.
    return createNodeOnBackend(set, get, 'character', params, position);
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

    // The add path's own handling (round 12 of PR #114): the backend's
    // nodes come into an empty tab first, and a failure adds nothing.
    return createNodeOnBackend(set, get, 'nebula-moodboard', params, position);
  },

  loadGraph: (nodes, edges, options) => {
    if (get().isExecuting && !options?.allowDuringExecution) return;
    canvasReplacementRevision += 1;
    canvasLoadedOverHttp();
    noteCanvasReplaced();
    forgetRunsOfReplacedGraph();
    newWriteQueue();
    // Typing still in its debounce was for the graph this replaces: its
    // node ids may name imported nodes now (round 19).
    noteTypingLost();
    clearAllParamPushTimers();
    deferredParamPushes.clear();
    const droppedPresses = forgetStepsInFlight();
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
    announceDrop(set, droppedPresses);
    useCinemaUploadStore.getState().reconcileTargets(get().nodes);
  },

  drainGraphWrites: () => drainWrites(),

  beginAgentSwitch: () => {
    closeWriteGate();
    // An undo or redo still on its way is dropped, not folded into the
    // handoff (coordinator, round 19): its change comes back off the canvas.
    const dropped = restoreAbandons.size;
    for (const abandon of [...restoreAbandons.values()]) abandon();
    const saves: CutOffSave[] = [...liveWrites].filter((write) => !write.restore).flatMap((write) => write.saves);
    // Typing still in its debounce is never sent: the handoff carries it.
    // (Typing already out is one of the writes above.)
    for (const [nodeId, edits] of unsavedParamEdits) {
      if (paramPushTimers[nodeId] === undefined) continue;
      window.clearTimeout(paramPushTimers[nodeId]);
      delete paramPushTimers[nodeId];
      saves.push(...typingSaves(nodeId, edits));
    }
    // A rename draft open in a title is saved as clicking away would have
    // (round 20): into the canvas the handoff is captured from.
    const folded: string[] = [];
    for (const [nodeId, draft] of renameDrafts) {
      const node = get().nodes.find((candidate) => candidate.id === nodeId);
      const next = node ? cleanNodeLabel(node, draft) : null;
      if (!node || next === null || next === node.data.label) continue;
      saves.push(...renameSave(node, undefined));
      labelsInFlight.set(nodeId, next);
      folded.push(nodeId);
      set((state) => ({ nodes: state.nodes.map((candidate) => (candidate.id === nodeId
        ? { ...candidate, data: { ...candidate.data, label: next } } : candidate)) }));
    }
    renameDrafts.clear();
    const pending = handoffPending(get().nodes);
    // Round 22 (review 21, L-c): a draft is handed off in this handoff and
    // no request of this tab carries it, so nothing would ever let it go: it
    // goes now, and a later switch names nothing it didn't change.
    for (const nodeId of folded) labelsInFlight.delete(nodeId);
    const named = Object.keys(pending.params).length + Object.keys(pending.labels).length;
    return { cutOff: saves, force: saves.length > 0 || dropped > 0 || named > 0, pending };
  },

  finishCanvasReplacement: (report) => {
    if (report) {
      const ending: CutOffEnding = report.kind === 'agent'
        ? { kind: 'agent', agent: report.agent ?? null, copy: report.copy ?? null, byAgent: report.byAgent !== false }
        : { kind: report.kind };
      startReplacementReport(report.show ? ending : null, report.project, [...report.cutOff, ...typingLost.splice(0)]);
    }
    typingLost.length = 0;
    openWriteGate();
  },

  noteRenameDraft: (nodeId, draft) => {
    if (draft === null) renameDrafts.delete(nodeId);
    else renameDrafts.set(nodeId, draft);
  },

  setCanvasProjectName: (read) => { canvasProjectName = read; },

  canSwitchProject: (options) => {
    const state = get();
    const session = useUIStore.getState().createSessionId;
    const createUploads = session ? useCreateDraftStore.getState().drafts[session]?.uploads ?? [] : [];
    const referencesUploading = createUploads.some((upload) => upload.status === 'uploading')
      || useCinemaUploadStore.getState().uploads.some((upload) => upload.status === 'uploading');
    return !state.isExecuting && !state.isImportingGraph && state.createLaunchingIds.length === 0
      && state.providerStartAmbiguities.length === 0 && state.uncertainWorldLabsRunId === null
      && activeRunOwners.size === 0 && createLaunchOwners.size === 0
      && !pendingNodeCreationAttempt && !pendingConnectedNodeCreationAttempt
      // An undo's restore, and the writes waiting behind it, never hold a
      // switch (review 17, L-2): the switch goes ahead and drops them (H-1).
      && !referencesUploading
      // Round 19: a switch drains them first (drainGraphWrites, beginAgentSwitch).
      && (options?.exceptSaves || writeGate !== null
        || (pendingGraphMutationCount - restoreBoundMutationCount === 0 && Object.keys(paramPushTimers).length === 0));
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
    // Round 23 (review 22, L-2 and M-1): another canvas, loaded over HTTP.
    canvasLoadedOverHttp();
    noteCanvasReplaced();
    newWriteQueue();
    const droppedPresses = forgetStepsInFlight();
    pendingNodeCreationAttempt = null;
    pendingConnectedNodeCreationAttempt = null;
    noteTypingLost();
    clearAllParamPushTimers();
    deferredParamPushes.clear();
    // Round 22 (review 21, L-c): names typed or on their way for the canvas
    // that goes are that canvas's (an agent's switch handed them off; the
    // person's switch drained them): never the next canvas's same ids.
    renameDrafts.clear();
    labelsInFlight.clear();
    labelsSavedBefore.clear();
    forgetParkedParamSaves();
    clearCinemaScenePersistence();
    useCinemaUploadStore.getState().clear();
    useCinemaMotionStore.getState().clear();
    clearReplacedCanvasFocus();
    for (const timer of statusReconciliationTimers.values()) clearTimeout(timer);
    statusReconciliationTimers.clear();
    activeRunOwners.clear();
    runCanvases.clear();
    forgetRunsOfReplacedGraph();
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
    // Review 15, L7: a saved project's nodes carry no missing-key warning, and
    // App only recomputes it when the credential cache changes. Compute it
    // here, so a freshly opened project shows its ⚠ at once.
    const { settingsCache } = useUIStore.getState();
    const withKeyStatus = nodes.map((node) => {
      const keyStatus = nodeKeyStatus(NODE_DEFINITIONS[node.data.definitionId], node.data.params, settingsCache);
      return node.data.keyStatus === keyStatus ? node : { ...node, data: { ...node.data, keyStatus } };
    });
    set({
      nodes: withKeyStatus, edges, runHistory: persistedRunHistory(restoredHistory),
      ...ownershipState(), createLaunchingIds: [], createCancelledLaunchIds: [],
      // The clipboard stays, so nodes copy across projects; the bumped load
      // makes it paste with its copy-time params (see CanvasClipboard).
      undoStack: [], redoStack: [], backendFreshStartPending: false,
      // The old project's notice (its edit's Undo, its error) is about that
      // canvas; a notice for the new one is set after this load. Its late
      // restore count too.
      undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveryWarning: null, providerRecoveries: [], providerStartAmbiguities: [],
      uncertainWorldLabsRunId: null,
    });
    // After the old project's notices are cleared: GM's line is about the
    // person's Cmd+Z, which they pressed just before (review 12, L-2).
    announceDrop(set, droppedPresses);
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
      // GM - Design, round 4 (one line at 560 px).
      get().notify("Refresh this recipe's Paper sources, then run it again. Their last snapshots are kept.");
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
    const step = options?.undoStep as UndoEntry | undefined;
    // The clear's answer after another graph opened: its nodes are gone, and
    // these are another graph's.
    if (step && !sameGraphAs(step)) return;
    // Round 19 (review 18, H-A): a clear is a replacement. Writes held from
    // before it never reach the nodes that take their ids after it.
    replaceCanvasByClear();
    // Round 23 (review 22, L-2): a new canvas, which no sync has named a
    // process for yet (canvasLoadedOverHttp).
    canvasLoadedOverHttp();
    if (step) stepRevisions.set(step, canvasReplacementRevision);
    clearCinemaScenePersistence();
    useCinemaMotionStore.getState().clear();
    clearReplacedCanvasFocus();
    useCinemaUploadStore.getState().clear();
    if (!step) {
      const newStack = [...undoStack, createSnapshot(nodes, edges)];
      if (newStack.length > UNDO_CAP) newStack.shift();
      set({ nodes: [], edges: [], undoStack: newStack, redoStack: [], backendFreshStartPending: false });
      return;
    }
    // Review 11, M-1 and L-6: a clear takes off the nodes it sent, never one
    // that arrived after it (an agent's next node, even under a reused id),
    // and its change belongs to its own step even when newer steps landed on
    // top: undoing those, then it, brings the canvas back.
    const remaining = nodes.filter((node) => !clearedBy(step, node.id));
    const kept = new Set(remaining.map((node) => node.id));
    if (!undoStack.includes(step) && remaining.length !== nodes.length) pushUndo(set, get);
    stripClearedFromLaterSteps(step, get, () => true);
    set({ nodes: remaining, edges: edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
      backendFreshStartPending: false });
  },

  clearBackendNodes: ({ undoStep }) => {
    const { nodes, edges, undoStack } = get();
    const step = undoStep as UndoEntry;
    if (!sameGraphAs(step)) return;
    // Round 19 (review 18, H-A): the chat's clear replaces the canvas as the
    // Toolbar's does (clearGraph): its own echo doesn't move it again.
    replaceCanvasByClear();
    canvasLoadedOverHttp();
    stepRevisions.set(step, canvasReplacementRevision);
    // As the clear's graphSync has it (its `empty` branch): only nodes this
    // tab alone has stay; and only the ones the clear sent go (as above).
    const remaining = nodes.filter((node) => !CLI_ID_RE.test(node.id) || !clearedBy(step, node.id));
    stripClearedFromLaterSteps(step, get, (id) => CLI_ID_RE.test(id));
    if (remaining.length === nodes.length) return;
    const kept = new Set(remaining.map((node) => node.id));
    if (!undoStack.includes(step)) pushUndo(set, get);
    set({ nodes: remaining, edges: edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)) });
  },

  // The model pickers ask the backend for a model's ports and params
  // (services/universal_ports.py, POST /api/graph/node/{id}/model): one set of
  // rules for the canvas, the wire checks and agents' edits. The backend also
  // drops wires on ports the new model doesn't have and syncs the canvas.
  configureOpenRouterModel: async (nodeId, modelId) => {
    const name = cardName(get().nodes.find((n) => n.id === nodeId), nodeId);
    const still = configuredModel(get().nodes.find((node) => node.id === nodeId));
    const step = get().beginUndoStep();
    try {
      const result = await requestUniversalModel(nodeId, modelId);
      if (!result) {
        // The node was gone before anything was asked: no card to set up, no line.
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
      // Its held Cmd+Z goes to nothing, so this line says why (review 12, L-4).
      if (!isOfflineRefusal(err)) {
        reportModelPickerFailure(err, nodeId, name, still,
          get().nodes.find((n) => n.id === nodeId)?.data.definitionId ?? 'openrouter-universal');
      }
    } finally {
      // An undo pressed while the request was on its way now acts (review 10, L-2).
      get().endUndoStep(step);
    }
  },

  fetchReplicateSchemaAndConfigure: async (nodeId, owner, name) => {
    const nodeName = cardName(get().nodes.find((n) => n.id === nodeId), nodeId);
    const still = configuredModel(get().nodes.find((node) => node.id === nodeId));
    const step = get().beginUndoStep();
    try {
      const result = await requestUniversalModel(nodeId, `${owner}/${name}`);
      if (!result) {
        // The node was gone before anything was asked: no card to set up, no line.
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
      // Its held Cmd+Z goes to nothing, so this line says why (review 12, L-4).
      if (!isOfflineRefusal(err)) reportModelPickerFailure(err, nodeId, nodeName, still, 'replicate-universal');
    } finally {
      // An undo pressed while the request was on its way now acts (review 10, L-2).
      get().endUndoStep(step);
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
})));

// Review 16, H1: a step's additions are fixed once a newer step lands above it.
useGraphStore.subscribe(fixAddsBelowNewSteps);

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

/**
 * Round 20 (review 19, M1): the canvas is read-only while it follows an
 * agent's project switch, from the moment the tab sees it until the new
 * canvas is loaded (lib/canvasFollow.ts), as offline is in PR #114 (whose
 * EDIT_GATES, the one table both gates read since the round 21 merge).
 * Every edit action asks refuseEditWhileFollowing() before it touches the
 * canvas or sends anything; a refused one changes nothing and says nothing
 * (the project bar pulses). A run press that gets through anyway (a
 * keyboard shortcut, a race) says GM's line. Reads, selection and run-state
 * updates are not edits and pass.
 */
type FollowGate = { refused: (...args: never[]) => unknown; blocks?: (...args: never[]) => boolean };
const FOLLOW_VOID: FollowGate = { refused: () => undefined };

/** GM's line for a run pressed while following; `nodeIds` names it. */
function refuseRunWhileFollowing(nodeIds: string[]): Promise<void> {
  const following = followingSwitch();
  if (!following) return Promise.resolve();
  const nodes = useGraphStore.getState().nodes;
  const ids = [...new Set(nodeIds)];
  const only = ids.length === 1 ? nodes.find((node) => node.id === ids[0]) : undefined;
  const name = only ? (nodeTitle(NODE_DEFINITIONS[only.data.definitionId], only.data.label) || null) : null;
  // No ids: a run of the whole canvas; several: counted (GM round 21).
  useGraphStore.getState().notify(runWhileFollowingLine(name, following.agent, following.projectName,
    ids.length >= 2 ? ids.length : undefined));
  return Promise.resolve();
}
const FOLLOW_RUN = (ids: (...args: never[]) => string[]): FollowGate => ({
  refused: ((...args: never[]) => refuseRunWhileFollowing(ids(...args))) as FollowGate['refused'],
});

/** React Flow's changes minus the edits while following: selection and
 * measured sizes pass; a move, removal or add is refused (one pulse). */
function followingChanges<C extends { type: string }>(changes: C[]): C[] {
  if (!followingSwitch()) return keptCanvasChanges(changes);
  const kept = changes.filter((change) => change.type === 'select' || change.type === 'dimensions');
  if (kept.length < changes.length) refuseEditWhileFollowing();
  return kept;
}

/** The same while the canvas is kept in this tab after a restore (GM r15,
 * Q11): a move, removal or add would need Nebula, so it is refused and the
 * kept line pulses; selection and measured sizes pass. */
function keptCanvasChanges<C extends { type: string }>(changes: C[]): C[] {
  if (!isCanvasKept()) return changes;
  const passing = changes.filter((change) => change.type === 'select' || change.type === 'dimensions');
  if (passing.length < changes.length) pulseKeptCanvas();
  return passing;
}

/**
 * Offline is read-only (GM - Design, round 14 of PR #114: "Blocking it is.
 * Edits are blocked while offline, not queued", because a restarted backend
 * refuses replayed writes). The one gate: every edit action of this store
 * asks refuseEditWhileOffline() before it touches the canvas or sends
 * anything, and a refused one changes nothing and says nothing (the banner
 * pulses; GM: "No toast for a blocked edit"). Outside the store, a file
 * drop, Clear, chat /clear, a chat image upload and Load graph ask the same
 * gate. Review 13 found add-and-connect and a file drop still sending, and
 * round 13's offline edits were reverted by the reconnect's sync with no
 * word. Reads, selection and run-state updates are not edits and pass.
 */
/** An action's refusal offline, and (`follow`) while following an agent's
 * switch where it differs: a run says GM's line, a name edit is an edit. */
type EditGate = { refused: () => unknown; blocks?: (...args: never[]) => boolean; follow?: FollowGate };
const REFUSED_VOID: EditGate = { refused: () => undefined };
const REFUSED_NULL: EditGate = { refused: () => null };
const REFUSED_NULL_ASYNC: EditGate = { refused: () => Promise.resolve(null) };
const REFUSED_ASYNC: EditGate = { refused: () => Promise.resolve() };
const EDIT_GATES: Partial<Record<keyof GraphState, EditGate>> = {
  addNode: REFUSED_NULL_ASYNC, addCharacterNode: REFUSED_NULL_ASYNC, addMoodboardNode: REFUSED_NULL_ASYNC,
  addNodeAndConnect: REFUSED_NULL_ASYNC, addDynamicNode: REFUSED_NULL, addLocalCinemaMotionNode: REFUSED_NULL,
  addShot: REFUSED_NULL, pasteClipboard: { refused: () => [] },
  // Round 21 (review 20, L-1): the Delete key (Canvas's handler), the chat's
  // clear landing on the canvas, and an accepted proposal's merge.
  deleteCanvasElements: REFUSED_VOID, clearBackendNodes: REFUSED_VOID, adoptAcceptedProposal: REFUSED_VOID,
  duplicateSelected: REFUSED_VOID, duplicateNode: REFUSED_VOID, deleteSelected: REFUSED_VOID, deleteNode: REFUSED_VOID,
  deleteGeneration: REFUSED_VOID, onConnect: REFUSED_VOID, renameNode: REFUSED_VOID, applyPaperSource: REFUSED_VOID,
  updateRemotionManifest: REFUSED_VOID, addTrackItemWithCanvasMirror: REFUSED_VOID, deleteTrackItem: REFUSED_VOID,
  duplicateTrackItemAtPlayhead: REFUSED_VOID, updateTrackItemProps: REFUSED_VOID, updateTrackItemTime: REFUSED_VOID,
  updateTrackItemSpatial: REFUSED_VOID, reorderTrackItem: REFUSED_VOID, addOrUpdateKeyframe: REFUSED_VOID,
  updateKeyframe: REFUSED_VOID, deleteKeyframe: REFUSED_VOID, autoLayoutSelected: REFUSED_VOID, autoLayout: REFUSED_VOID,
  loadSampleGraph: REFUSED_VOID, clearGraph: REFUSED_VOID, undo: REFUSED_VOID, redo: REFUSED_VOID,
  removeEmptyEditNode: REFUSED_VOID, updateEditNodeClip: REFUSED_VOID, cutEditNodeAtSource: REFUSED_VOID,
  removeEditNodeClip: REFUSED_VOID, removeShot: REFUSED_VOID, updateScene: REFUSED_VOID,
  configureOpenRouterModel: REFUSED_ASYNC, fetchReplicateSchemaAndConfigure: REFUSED_ASYNC,
  promoteShotVariation: REFUSED_ASYNC,
  // Round 15 (review 14, M1/M2): runs are the paid path, so every run entry
  // is refused before anything is marked: no "Queued", no Stop, no request.
  // While following (round 20, M1), a run press that gets through says GM's line.
  executeGraph: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(() => []) },
  executeNode: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(((nodeId: string) => [nodeId]) as never) },
  executeShot: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(((nodeId: string) => [nodeId]) as never) },
  executeCluster: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(((nodeIds: string[]) => nodeIds) as never) },
  executeClusterConcurrent: { ...REFUSED_ASYNC,
    follow: FOLLOW_RUN(((nodeIds: string[]) => (Array.isArray(nodeIds) ? nodeIds : [])) as never) },
  rerunHistoryRecord: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(() => []) },
  rerunHistoryWithLatestPaperSource: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(() => []) },
  retryFailedRun: { ...REFUSED_ASYNC, follow: FOLLOW_RUN(() => []) },
  // And the other writes the store makes: Create's cluster (refused as an
  // OfflineRefusal, which Create says nothing for), the video edit node (a
  // local add: '' means none was made), Forget ID, the two unlocks and an
  // accepted proposal's merge.
  authorGenerationCluster: { refused: () => Promise.reject(new OfflineRefusal('POST', '/api/graph/cluster')),
    // While following, Create says it in its own error style (GM round 21, G1).
    follow: { refused: () => Promise.reject(new FailureNotice(GENERATE_HEADING, followingReason(followingSwitch()))) } },
  getOrCreateEditNodeDownstream: { refused: () => '' },
  deleteProviderRecovery: REFUSED_ASYNC, acknowledgeProviderStartAmbiguity: REFUSED_ASYNC,
  acknowledgeUncertainWorldLabsRun: REFUSED_VOID,
  // A param edit is an edit; a run's state or outputs are not.
  updateNodeData: { ...REFUSED_VOID, blocks: ((_nodeId: string, data: Partial<NodeData>) => 'params' in data) as EditGate['blocks'],
    // While following, a name edit is refused too (round 20).
    follow: { ...FOLLOW_VOID,
      blocks: ((_nodeId: string, data: Partial<NodeData>) => 'params' in data || 'label' in data) as FollowGate['blocks'] } },
};

/** The actions the gates wrap (round 21, review 20 L-1: a store test walks
 * every action and checks each is here or in NOT_GRAPH_EDITS). */
export function gatedGraphActions(): string[] {
  return [...Object.keys(EDIT_GATES), 'onNodesChange', 'onEdgesChange'];
}

/** The store's actions that change neither the person's nodes nor wires and
 * send no graph write: reads, selection, notices, run state Nebula reports,
 * the undo bookkeeping and the replacement/sync plumbing (which apply what
 * Nebula already has). Each new action goes in EDIT_GATES or here. */
export const NOT_GRAPH_EDITS: ReadonlySet<string> = new Set<string>([
  // Undo bookkeeping (the edits they bracket are gated themselves).
  'beginUndoStep', 'cancelUndoStep', 'endUndoStep', 'noteOwnAdd', 'noteRenameDraft',
  // Notices.
  'dismissUndoNotice', 'dismissLateNotice', 'dismissMessageNotice', 'notify', 'dismissProviderRecoveryWarning',
  // Reads and selection.
  'copySelected', 'selectAll', 'allowCanvasDelete', 'canSwitchProject', 'isShotAdmissionBlocked',
  // Stopping a run or a launch (never refused: it stops spend) and the locks around them.
  'resetExecution', 'cancelExecution', 'cancelRun', 'reserveGraphImport', 'releaseGraphImport',
  'reserveCreateGeneration', 'releaseCreateGeneration', 'cancelCreateGeneration',
  // A project's canvas loading and the switch/replacement plumbing (they put
  // on the canvas what Nebula already has; following uses them itself).
  'loadGraph', 'loadProjectGraph', 'drainGraphWrites', 'beginAgentSwitch', 'finishCanvasReplacement',
  'setCanvasProjectName',
  // The tab's own run history, and what Nebula reports about runs.
  'clearRunHistory', 'handleExecutionEvent', 'hydrateProviderRecoveries', 'hydrateProviderStartAmbiguities',
  'hydrateExecutionStatuses', 'reconcilePersistedWorldLabsRun',
]);

/** React Flow's changes minus the edits (moves, removals, adds); a refused
 * one pulses the banner once. Selection and measured sizes pass. A move of a
 * drag that was already put back (springDragsBack) is refused silently. */
function readOnlyChanges<C extends { type: string }>(changes: C[]): C[] {
  if (!isBackendOffline()) return revertedDrags.size > 0 ? withoutRevertedMoves(changes) : changes;
  const kept = changes.filter((change) => change.type === 'select' || change.type === 'dimensions');
  const refused = changes.filter((change) => change.type !== 'select' && change.type !== 'dimensions');
  for (const change of refused) {
    const move = change as unknown as { type: string; id?: string; dragging?: boolean };
    if (move.type === 'position' && move.id && revertedDrags.has(move.id) && move.dragging === false) {
      revertedDrags.delete(move.id);
    }
  }
  const quiet = refused.every((change) => {
    const move = change as unknown as { type: string; id?: string };
    return move.type === 'position' && move.id !== undefined && revertedDrags.has(move.id);
  });
  // A drag that was under way when the connection dropped goes back now.
  if (dragOrigins.size > 0) springDragsBack();
  else if (refused.length > 0 && !quiet) refuseEditWhileOffline();
  return kept;
}

/** Round 16 (review 15 nit): a drag that was put back stays ended until the
 * pointer is released, even if Nebula answers again while the mouse is still
 * down. Its moves, its drop included, are dropped silently (online too), so
 * the node doesn't jump back under the cursor and the drop doesn't save. */
function withoutRevertedMoves<C extends { type: string }>(changes: C[]): C[] {
  return changes.filter((change) => {
    const move = change as unknown as { type: string; id?: string; dragging?: boolean };
    if (move.type !== 'position' || !move.id || !revertedDrags.has(move.id)) return true;
    if (move.dragging === false) revertedDrags.delete(move.id);
    return false;
  });
}

/**
 * Review 14, L1 (GM, round 15: "no line. The node springs back to its last
 * saved spot on the canvas's tuned spring, not a jump, and the banner pulses
 * once"; reduced motion: an instant move and the banner's colour flash).
 * Where each node a drag is moving started (the spot it last saved), while
 * online; the drop's save clears it. When the connection drops mid-drag,
 * the nodes go back there and the rest of that drag's moves are refused
 * without another pulse, until its drop.
 */
const dragOrigins = new Map<string, { x: number; y: number }>();
const revertedDrags = new Set<string>();

function noteDragOrigins(changes: NodeChange[]): void {
  const nodes = useGraphStore.getState().nodes;
  for (const change of changes) {
    if (change.type !== 'position') continue;
    if (change.dragging === false) { dragOrigins.delete(change.id); continue; }
    if (change.dragging && !dragOrigins.has(change.id)) {
      const node = nodes.find((candidate) => candidate.id === change.id);
      if (node) dragOrigins.set(change.id, { ...node.position });
    }
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Put every node a drag is moving back where the drag started, on the
 * canvas's tuned spring (AGENT_CURSOR_SPRING, as agent cursors and the
 * camera move), and pulse the banner once. Local only: nothing is saved. */
function springDragsBack(): void {
  if (dragOrigins.size === 0) return;
  const targets = new Map(dragOrigins);
  dragOrigins.clear();
  for (const id of targets.keys()) revertedDrags.add(id);
  forgetRevertedDragsOnRelease();
  refuseEditWhileOffline();
  const place = (positions: Map<string, { x: number; y: number }>) => useGraphStore.setState((state) => ({
    nodes: state.nodes.map((node) => {
      const at = positions.get(node.id);
      return at ? { ...node, position: { x: at.x, y: at.y }, dragging: false } : node;
    }),
  }));
  if (prefersReducedMotion() || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    place(targets);
    return;
  }
  const springs = new Map<string, SpringState>();
  for (const node of useGraphStore.getState().nodes) {
    if (targets.has(node.id)) springs.set(node.id, { x: node.position.x, y: node.position.y, vx: 0, vy: 0 });
  }
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.064, Math.max(0, (now - last) / 1000));
    last = now;
    let moving = false;
    for (const [id, state] of springs) {
      const target = targets.get(id)!;
      const next = stepSpring(state, target, dt, AGENT_CURSOR_SPRING);
      if (isAtRest(next, target)) springs.set(id, { ...target, vx: 0, vy: 0 });
      else { springs.set(id, next); moving = true; }
    }
    place(new Map([...springs].map(([id, state]) => [id, { x: state.x, y: state.y }])));
    if (moving) window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

/** The pointer's release ends every put-back drag, after the drop's own
 * change (if React Flow sends one) has been dropped. Not reconnecting: that
 * can happen with the mouse still down (review 15 nit). */
let releaseListening = false;
function forgetRevertedDragsOnRelease(): void {
  if (releaseListening || typeof window === 'undefined') return;
  releaseListening = true;
  const release = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    releaseListening = false;
    window.setTimeout(() => revertedDrags.clear(), 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
}

// The connection dropping during a drag puts its nodes back at once (the
// drag may send no further move).
subscribeBackendConnection(() => {
  if (isBackendOffline()) springDragsBack();
});

{
  const ungated = useGraphStore.getState();
  const gated: Partial<GraphState> = {};
  for (const [name, gate] of Object.entries(EDIT_GATES) as [keyof GraphState, EditGate][]) {
    const action = ungated[name] as unknown as (...args: unknown[]) => unknown;
    if (typeof action !== 'function') continue;
    const follow: FollowGate = gate.follow ?? gate;
    const isRun = String(name).startsWith('execute') || String(name).startsWith('rerun') || name === 'retryFailedRun';
    (gated as Record<string, unknown>)[name] = (...args: unknown[]) => {
      // Following an agent's switch first (the canvas is about to go), then offline.
      if (followingSwitch() && (!follow.blocks || (follow.blocks as (...a: unknown[]) => boolean)(...args))) {
        // A run says GM's line; an edit pulses the bar.
        if (!isRun) refuseEditWhileFollowing();
        return (follow.refused as (...a: unknown[]) => unknown)(...args);
      }
      const blocks = !gate.blocks || (gate.blocks as (...a: unknown[]) => boolean)(...args);
      // Kept in this tab after a restore (GM r15, Q11): typing joins the kept
      // edits; any other edit or run is refused, and the kept line pulses.
      if (blocks && isCanvasKept()) {
        const typing = name === 'updateNodeData' && keptCanvasTakesTyping();
        if (!typing) {
          pulseKeptCanvas();
          return gate.refused();
        }
      }
      if (blocks && refuseEditWhileOffline()) {
        return gate.refused();
      }
      return action(...args);
    };
  }
  gated.onNodesChange = (changes) => {
    const followed = followingChanges(changes);
    if (followed.length === 0) return;
    if (!isBackendOffline()) noteDragOrigins(followed);
    const kept = readOnlyChanges(followed);
    if (kept.length > 0) ungated.onNodesChange(kept);
  };
  gated.onEdgesChange = (changes) => {
    const kept = readOnlyChanges(followingChanges(changes));
    if (kept.length > 0) ungated.onEdgesChange(kept);
  };
  useGraphStore.setState(gated);
}

// Every card title this tab shows is remembered past its node's removal, so
// a World Labs record whose node left the canvas is still named by it (GM,
// round 14 of PR #114; lib/lastNodeLabels.ts).
useGraphStore.subscribe((state, previous) => {
  if (state.nodes !== previous.nodes) noteNodeLabels(state.nodes);
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
