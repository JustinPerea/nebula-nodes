import type { PaperRunInput, PortValue, VariantScope } from '../types';
import type { PaperSourceRecord } from './paperSource';
import { getProjectContext } from './projectContext';

/** Persistent run-history records for the Run History panel. Records contain the
 * exact JSON graph sent to the backend so a later replay never reads mutable
 * canvas state. Storage helpers are exception-safe because history must never
 * prevent the canvas from loading or executing. */

export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled';
export type RunTrigger = 'graph' | 'node' | 'cluster' | 'shot';
export type RunReplayAction = 'rerun' | 'retry-failed' | 'latest-paper-source';

export interface CreateRunOrigin {
  genId: string;
  sessionId: string;
  prompt: string;
  ts: number;
  modelNodeIds: string[];
  allNodeIds: string[];
}

export interface CinemaShotRun {
  nodeId: string;
  shotId: string;
  seed?: number;
  variations?: number;
}

/** Live ownership is separate from persistent terminal history. */
export interface ActiveRun {
  id: string;
  kind: 'graph' | 'cinema-shot';
  nodeIds: string[];
  nodeId?: string;
  shotId?: string;
  status: 'starting' | 'running' | 'cancelling' | 'uncertain';
}

export interface RunSnapshotNode {
  id: string;
  definitionId: string;
  params: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface RunSnapshotEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export interface RunGraphSnapshot {
  nodes: RunSnapshotNode[];
  edges: RunSnapshotEdge[];
}

export interface RunRecord {
  id: string;
  trigger: RunTrigger;
  startedAt: number; // epoch ms
  status: RunStatus;
  snapshot: RunGraphSnapshot;
  targetNodeId?: string;
  sourceRunId?: string;
  replayAction?: RunReplayAction;
  durationSec?: number;
  nodesExecuted?: number;
  statusNote?: string;
  paperInputs?: PaperRunInput[];
  recipeRevision?: string;
  resultOutputs?: Record<string, Record<string, PortValue>>;
  /** Cumulative iterator results; the node's visible output remains scalar. */
  batchOutputs?: Record<string, Array<Record<string, PortValue>>>;
  /** Optional item attribution parallel to each node's immutable batch results. */
  batchVariants?: Record<string, VariantScope[]>;
  outOfDateReasons?: string[];
  /** Immutable admission fact. Unlike snapshot params, this stays true after
   * a recovery event patches the accepted operation ID into the snapshot. */
  startedFreshPaidWorldLabs?: boolean;
  createOrigin?: CreateRunOrigin;
  cinemaShot?: CinemaShotRun;
}

export interface ProviderRecoveryCheckpoint {
  runId: string;
  nodeId: string;
  resumeOperationId: string | null;
  existingWorldId: string | null;
  /** Present on live events. Journal hydration only returns durable records. */
  durable?: boolean;
  warning?: string | null;
}

export type ProviderStartKind =
  | 'worldlabs-environment'
  | 'worldlabs-world-export';

/** A fail-closed hold created when a non-idempotent provider submission may
 * have succeeded but Nebula did not receive a trustworthy recovery ID. */
export interface ProviderStartAmbiguity {
  runId: string;
  nodeId: string;
  kind: ProviderStartKind;
  message: string;
  durable: boolean;
}

export function isProviderStartAmbiguity(
  value: unknown,
): value is ProviderStartAmbiguity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProviderStartAmbiguity>;
  return typeof candidate.runId === 'string'
    && candidate.runId.length > 0
    && typeof candidate.nodeId === 'string'
    && candidate.nodeId.length > 0
    && (candidate.kind === 'worldlabs-environment'
      || candidate.kind === 'worldlabs-world-export')
    && typeof candidate.message === 'string'
    && typeof candidate.durable === 'boolean';
}

const WORLD_LABS_DEFINITION_IDS = new Set([
  'worldlabs-environment',
  'worldlabs-world-export',
]);

function nodesInRunScope(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): RunSnapshotNode[] {
  const scopeIds = new Set<string>();
  if (targetNodeId) {
    scopeIds.add(targetNodeId);
    const incoming = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      const sources = incoming.get(edge.target);
      if (sources) sources.push(edge.source);
      else incoming.set(edge.target, [edge.source]);
    }
    const pending = [targetNodeId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const source of incoming.get(current) ?? []) {
        if (scopeIds.has(source)) continue;
        scopeIds.add(source);
        pending.push(source);
      }
    }
  } else {
    snapshot.nodes.forEach((node) => scopeIds.add(node.id));
  }
  return snapshot.nodes.filter((node) => scopeIds.has(node.id));
}

/** Paper snapshot metadata is exported bytes attribution, not a mutable link. */
export function paperInputsForSnapshot(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): PaperRunInput[] {
  return nodesInRunScope(snapshot, targetNodeId).flatMap((node) => {
    if (node.definitionId !== 'paper-source') return [];
    const source = node.params._paperSource as PaperSourceRecord | undefined;
    if (!source?.snapshot?.id || !source.snapshot.hash || !source.snapshot.identity || !source.id) return [];
    return [{ nodeId: node.id, sourceId: source.id, snapshot: source.snapshot }];
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Canonical saved graph/settings; runtime source metadata is input, not recipe. */
export function paperRecipeContent(snapshot: RunGraphSnapshot, targetNodeId?: string): string {
  // engine._maybe_probe_video_output adds these observed output facts after
  // admission. They configure downstream editing UI, never the saved model run.
  const outputMetadataKeys = new Set(['_sourceDuration', '_sourceFps', '_sourceIsVfr']);
  const nodes = nodesInRunScope(snapshot, targetNodeId);
  const ids = new Set(nodes.map((node) => node.id));
  return canonicalJson({
    nodes: nodes.map((node) => ({
      id: node.id,
      definitionId: node.definitionId,
      params: Object.fromEntries(Object.entries(node.params)
        .filter(([key]) => !outputMetadataKeys.has(key)
          && (node.definitionId !== 'paper-source' || key !== '_paperSource'))),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: snapshot.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map(({ source, sourceHandle, target, targetHandle }) => ({ source, sourceHandle, target, targetHandle }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  });
}

/** Readable local revision identifier. Full canonical equality decides freshness;
 * this fingerprint is never treated as a cryptographic or Paper revision. */
export function paperRecipeRevision(snapshot: RunGraphSnapshot, targetNodeId?: string): string {
  const content = paperRecipeContent(snapshot, targetNodeId);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `recipe-v1-${hash.toString(16).padStart(16, '0')}`;
}

export function paperInputOutOfDateReasons(
  inputs: PaperRunInput[],
  current: RunGraphSnapshot,
): string[] {
  return inputs.flatMap((input) => {
    const node = current.nodes.find((candidate) => candidate.id === input.nodeId);
    const source = node?.definitionId === 'paper-source'
      ? node.params._paperSource as PaperSourceRecord | undefined
      : undefined;
    if (!source?.snapshot?.identity) return [`Paper source ${input.nodeId} is no longer linked.`];
    const before = input.snapshot.identity;
    const after = source.snapshot.identity;
    if (source.id !== input.sourceId || before.fileId !== after.fileId
      || before.pageId !== after.pageId || before.objectId !== after.objectId) {
      return [`Paper source ${input.nodeId} was reconnected to another object.`];
    }
    return source.snapshot.hash !== input.snapshot.hash
      ? [`Paper source ${input.nodeId} updated after this input was captured.`]
      : [];
  });
}

export function paperRunOutOfDateReasons(
  record: RunRecord,
  current: RunGraphSnapshot,
  targetNodeId = record.targetNodeId,
): string[] {
  const inputs = paperInputsForSnapshot(record.snapshot, targetNodeId);
  if (!inputs.length) return [];
  const reasons = paperInputOutOfDateReasons(inputs, current);
  // Cluster replays retain only their saved nodes. Other canvas work is irrelevant.
  const relevantCurrent = record.trigger === 'cluster'
    ? { ...current, nodes: current.nodes.filter((node) => record.snapshot.nodes.some((saved) => saved.id === node.id)) }
    : current;
  if (paperRecipeContent(record.snapshot, targetNodeId) !== paperRecipeContent(relevantCurrent, targetNodeId)) {
    reasons.push('Recipe settings or connections changed after this run was saved.');
  }
  return reasons;
}

/** Retain each executed node's output alongside the exact accepted recipe.
 * This includes upstream inputs and cache hits, so ordinary Create/Canvas
 * results can recover their frozen prompt and references. Terminal records
 * never accept late writes, and a live Canvas deletion does not erase history. */
export function recordRunOutput(
  history: RunRecord[], runId: string, nodeId: string, outputs: Record<string, PortValue>,
): RunRecord[] {
  const index = history.findIndex((record) => record.id === runId && record.status === 'running'
    && record.snapshot.nodes.some((node) => node.id === nodeId));
  if (index < 0) return history;
  return history.map((record, recordIndex) => recordIndex === index
    ? { ...record, resultOutputs: deepFreeze(JSON.parse(JSON.stringify({
      ...record.resultOutputs, [nodeId]: outputs,
    })) as Record<string, Record<string, PortValue>>) } : record);
}

/** Compatibility for callers predating ordinary result provenance. */
export const recordPaperRunOutput = recordRunOutput;

/** Keep every repeated result immutable, including successful items in a run
 * that is later cancelled or fails. Batch events replace only their node's
 * cumulative list and never alter the saved recipe or canonical port output. */
export function recordRunBatchOutputs(
  history: RunRecord[], runId: string, nodeId: string,
  outputs: Array<Record<string, PortValue>>,
  variants?: unknown,
): RunRecord[] {
  const scopes = sanitizeVariantScopes(variants, outputs.length);
  return history.map((record) => {
    if (record.id !== runId) return record;
    const batchVariants = { ...record.batchVariants };
    delete batchVariants[nodeId];
    if (scopes) batchVariants[nodeId] = scopes;
    return {
      ...record,
      batchOutputs: deepFreeze(JSON.parse(JSON.stringify({
        ...record.batchOutputs, [nodeId]: outputs,
      })) as Record<string, Array<Record<string, PortValue>>>),
      batchVariants: Object.keys(batchVariants).length
        ? deepFreeze(JSON.parse(JSON.stringify(batchVariants)) as Record<string, VariantScope[]>)
        : undefined,
    };
  });
}

/** Copy only well-formed display attribution from untrusted storage/WS data. */
export function sanitizeVariantScope(value: unknown): VariantScope | undefined {
  if (!isObject(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0
    || typeof value.label !== 'string' || !Array.isArray(value.lineage)) return undefined;
  const lineage: VariantScope['lineage'] = [];
  for (const item of value.lineage) {
    if (!isObject(item) || typeof item.source_node_id !== 'string' || !item.source_node_id
      || typeof item.source_label !== 'string' || typeof item.index !== 'number' || !Number.isSafeInteger(item.index)
      || item.index < 0 || typeof item.item_label !== 'string') return undefined;
    lineage.push({ source_node_id: item.source_node_id, source_label: item.source_label,
      index: item.index, item_label: item.item_label });
  }
  return { index: value.index, label: value.label, lineage };
}

/** Keep item positions aligned. Invalid or mismatched metadata is omitted whole. */
export function sanitizeVariantScopes(
  value: unknown, expectedLength?: number,
): VariantScope[] | undefined {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) return undefined;
  const scopes: VariantScope[] = [];
  for (const [index, item] of value.entries()) {
    const scope = sanitizeVariantScope(item);
    if (!scope || scope.index !== index) return undefined;
    scopes.push(scope);
  }
  return scopes;
}

function sanitizeRunBatchVariants(record: RunRecord): Record<string, VariantScope[]> | undefined {
  if (!isObject(record.batchVariants)) return undefined;
  const entries: Array<[string, VariantScope[]]> = [];
  for (const [nodeId, value] of Object.entries(record.batchVariants)) {
    const outputs = record.batchOutputs?.[nodeId];
    if (!outputs) continue;
    const scopes = sanitizeVariantScopes(value, outputs.length);
    if (scopes) entries.push([nodeId, scopes]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Replace only pinned Paper inputs. Recipe params and topology remain saved. */
export function snapshotWithLatestPaperSources(
  record: RunRecord,
  current: RunGraphSnapshot,
): RunGraphSnapshot | null {
  const inputs = paperInputsForSnapshot(record.snapshot, record.targetNodeId);
  if (!inputs.length) return null;
  const inputIds = new Set(inputs.map((input) => input.nodeId));
  const replacements = new Map<string, PaperSourceRecord>();
  for (const input of inputs) {
    const node = current.nodes.find((candidate) => candidate.id === input.nodeId && candidate.definitionId === 'paper-source');
    const source = node?.params._paperSource as PaperSourceRecord | undefined;
    if (!source?.snapshot?.identity || source.state !== 'current') return null;
    replacements.set(input.nodeId, { ...source, snapshots: [source.snapshot] });
  }
  return freezeRunSnapshot({
    ...record.snapshot,
    nodes: record.snapshot.nodes.map((node) => inputIds.has(node.id)
      ? { ...node, params: { ...node.params, _paperSource: replacements.get(node.id) }, outputs: {} }
      : node),
  });
}

function scopedWorldLabsNodes(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): RunSnapshotNode[] {
  return nodesInRunScope(snapshot, targetNodeId)
    .filter((node) => WORLD_LABS_DEFINITION_IDS.has(node.definitionId));
}

/** Return true when the run's actual execution scope contains a World Labs
 * operation. A single-node run includes the target and its ancestors; a full
 * graph/selection snapshot includes every node retained in that snapshot. */
export function runIncludesWorldLabs(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): boolean {
  return scopedWorldLabsNodes(snapshot, targetNodeId).length > 0;
}

function isFreshPaidWorldLabsStart(node: RunSnapshotNode): boolean {
  if (node.definitionId === 'worldlabs-environment') {
    return !nonEmptyString(node.params.resume_operation_id)
      && !nonEmptyString(node.params.existing_world_id);
  }
  return node.definitionId === 'worldlabs-world-export'
    && String(node.params.format ?? 'ply').toLowerCase() === 'glb'
    && !nonEmptyString(node.params.resume_operation_id);
}

/** Match the backend's non-idempotent billing boundary exactly. PLY exports
 * and requests pinned to a recovery/world ID are safe to repeat; a fresh world
 * or fresh HQ GLB export is not. */
export function runIncludesFreshPaidWorldLabsStart(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): boolean {
  return nodesInRunScope(snapshot, targetNodeId).some(isFreshPaidWorldLabsStart);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function worldLabsNodeHasRecovery(node: RunSnapshotNode): boolean {
  if (node.definitionId === 'worldlabs-environment') {
    return nonEmptyString(node.params.resume_operation_id)
      || nonEmptyString(node.params.existing_world_id);
  }
  return node.definitionId === 'worldlabs-world-export'
    && nonEmptyString(node.params.resume_operation_id);
}

/** Block only snapshots that cross the non-idempotent paid-start boundary.
 * Free PLY export is intentionally replayable without a checkpoint. */
export function isWorldLabsRecoveryReplayBlocked(record: RunRecord): boolean {
  return runIncludesFreshPaidWorldLabsStart(record.snapshot, record.targetNodeId);
}

export function isWorldLabsRecoveryReplayReady(record: RunRecord): boolean {
  const nodes = scopedWorldLabsNodes(record.snapshot, record.targetNodeId);
  return nodes.length > 0
    && !runIncludesFreshPaidWorldLabsStart(record.snapshot, record.targetNodeId)
    && nodes.some(worldLabsNodeHasRecovery);
}

function validRecoveryPayload(value: ProviderRecoveryCheckpoint): boolean {
  return nonEmptyString(value.nodeId)
    && (nonEmptyString(value.resumeOperationId) !== nonEmptyString(value.existingWorldId));
}

function validRecoveryCheckpoint(value: ProviderRecoveryCheckpoint): boolean {
  return nonEmptyString(value.runId) && validRecoveryPayload(value);
}

function paramsWithProviderRecovery(
  node: Pick<RunSnapshotNode, 'definitionId' | 'params'>,
  checkpoint: ProviderRecoveryCheckpoint,
): Record<string, unknown> | null {
  if (!WORLD_LABS_DEFINITION_IDS.has(node.definitionId) || !validRecoveryPayload(checkpoint)) {
    return null;
  }
  if (node.definitionId === 'worldlabs-world-export' && !checkpoint.resumeOperationId) {
    return null;
  }
  const params = { ...node.params };
  delete params.resume_operation_id;
  delete params.existing_world_id;
  if (checkpoint.resumeOperationId) params.resume_operation_id = checkpoint.resumeOperationId;
  if (checkpoint.existingWorldId) params.existing_world_id = checkpoint.existingWorldId;
  return params;
}

function shallowParamsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && Object.is(left[key], right[key]));
}

export const WORLD_LABS_RECOVERY_VOLATILE_NOTE =
  'Recovery ID captured, but the backend could not save it durably. Keep this tab open and copy the ID before reloading.';

export function providerRecoveryWarningText(
  checkpoint: Pick<ProviderRecoveryCheckpoint, 'durable' | 'warning'>,
): string | null {
  if (checkpoint.durable !== false) return null;
  const warning = typeof checkpoint.warning === 'string' ? checkpoint.warning.trim() : '';
  return warning ? warning.slice(0, 1_000) : WORLD_LABS_RECOVERY_VOLATILE_NOTE;
}

/** Patch durable backend recovery checkpoints into their exact frozen run
 * snapshots. This is what makes recovery discoverable after a browser reload
 * even when the originating node existed only under a frontend UUID. */
export function applyProviderRecoveriesToHistory(
  history: RunRecord[],
  checkpoints: ProviderRecoveryCheckpoint[],
): RunRecord[] {
  const byRun = new Map<string, Map<string, ProviderRecoveryCheckpoint>>();
  for (const checkpoint of checkpoints) {
    if (!validRecoveryCheckpoint(checkpoint)) continue;
    const byNode = byRun.get(checkpoint.runId) ?? new Map<string, ProviderRecoveryCheckpoint>();
    byNode.set(checkpoint.nodeId, checkpoint);
    byRun.set(checkpoint.runId, byNode);
  }

  let historyChanged = false;
  const nextHistory = history.map((record) => {
    const byNode = byRun.get(record.id);
    if (!byNode) return record;
    let paramsChanged = false;
    const applied: ProviderRecoveryCheckpoint[] = [];
    const nodes = record.snapshot.nodes.map((node) => {
      const checkpoint = byNode.get(node.id);
      if (!checkpoint) return node;
      const params = paramsWithProviderRecovery(node, checkpoint);
      if (!params) return node;
      applied.push(checkpoint);
      if (shallowParamsEqual(node.params, params)) return node;
      paramsChanged = true;
      return { ...node, params };
    });
    if (applied.length === 0) return record;
    const next: RunRecord = paramsChanged
      ? { ...record, snapshot: freezeRunSnapshot({ ...record.snapshot, nodes }) }
      : record;
    const volatileWarning = applied
      .map(providerRecoveryWarningText)
      .find((warning): warning is string => Boolean(warning));
    let desiredStatusNote = record.statusNote;
    if (volatileWarning) {
      // Keep the warning on a running record so closeRunRecord can preserve it
      // when cancellation wins the race after the ID event.
      desiredStatusNote = volatileWarning;
    } else if ((record.status === 'failed' || record.status === 'cancelled')
      && isWorldLabsRecoveryReplayReady(next)) {
      desiredStatusNote = WORLD_LABS_RECOVERY_READY_NOTE;
    } else if (record.status === 'running') {
      desiredStatusNote = undefined;
    }
    if (!paramsChanged && desiredStatusNote === record.statusNote) return record;
    historyChanged = true;
    return desiredStatusNote === next.statusNote
      ? next
      : { ...next, statusNote: desiredStatusNote };
  });
  return historyChanged ? nextHistory : history;
}

/** Apply one checkpoint to a matching live node without accepting recovery
 * fields on unrelated definitions. */
export function applyProviderRecoveryToLiveParams(
  definitionId: string,
  params: Record<string, unknown>,
  checkpoint: ProviderRecoveryCheckpoint,
): Record<string, unknown> | null {
  return paramsWithProviderRecovery({ definitionId, params }, checkpoint);
}

export type OpenRunRecord = Omit<RunRecord, 'status' | 'durationSec' | 'nodesExecuted'>;

export interface RunHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MAX_RUN_HISTORY = 100;
export const RUN_HISTORY_STORAGE_KEY = 'nebula:run-history:v1';
const RUN_HISTORY_STORAGE_VERSION = 1;

/** Explicit storage injection keeps legacy test/export semantics. Browser history
 * belongs to the open project; no context means pre-project migration history. */
function historyStorageKey(storageInjected: boolean): string {
  const project = storageInjected ? null : getProjectContext();
  return project ? `${RUN_HISTORY_STORAGE_KEY}:project:${encodeURIComponent(project.id)}` : RUN_HISTORY_STORAGE_KEY;
}

interface StoredRunHistory {
  version: typeof RUN_HISTORY_STORAGE_VERSION;
  records: RunRecord[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** JSON-clone + deep-freeze a backend request graph. JSON cloning intentionally
 * matches the payload semantics of fetch(JSON.stringify(...)): undefined values
 * are omitted and the retained data cannot drift when canvas params mutate. */
export function freezeRunSnapshot(snapshot: RunGraphSnapshot): RunGraphSnapshot {
  return deepFreeze(JSON.parse(JSON.stringify(snapshot)) as RunGraphSnapshot);
}

function cappedRunHistory(history: RunRecord[]): RunRecord[] {
  // Parallel owners must retain cancellation and recovery identity even when
  // their count exceeds the terminal history budget.
  let terminalBudget = Math.max(0, MAX_RUN_HISTORY - history.filter((record) => record.status === 'running').length);
  return history.filter((record) => record.status === 'running' || terminalBudget-- > 0);
}

/** Prepend a new running record, capping the list. Pure with respect to history;
 * the incoming snapshot is cloned so later canvas mutations cannot alter it. */
export function openRunRecord(history: RunRecord[], rec: OpenRunRecord): RunRecord[] {
  const snapshot = freezeRunSnapshot(rec.snapshot);
  const paperInputs = paperInputsForSnapshot(snapshot, rec.targetNodeId);
  const contract = paperInputs.length ? {
    paperInputs: deepFreeze(JSON.parse(JSON.stringify(paperInputs)) as PaperRunInput[]),
    recipeRevision: paperRecipeRevision(snapshot, rec.targetNodeId),
    resultOutputs: {},
    outOfDateReasons: [],
  } : {};
  return cappedRunHistory([{ ...rec, ...contract, snapshot,
    createOrigin: rec.createOrigin ? deepFreeze(JSON.parse(JSON.stringify(rec.createOrigin)) as CreateRunOrigin) : undefined,
    cinemaShot: rec.cinemaShot ? deepFreeze({ ...rec.cinemaShot }) : undefined,
    status: 'running' as const }, ...history]);
}

/** Patch a record (by id) with its terminal status/metrics. Pure; no-op if absent. */
export function closeRunRecord(
  history: RunRecord[],
  id: string,
  patch: {
    status: RunStatus;
    durationSec?: number;
    nodesExecuted?: number;
    statusNote?: string;
  },
): RunRecord[] {
  return cappedRunHistory(history.map((record) => {
    if (record.id !== id) return record;
    const next = { ...record, ...patch };
    if (patch.statusNote !== undefined) {
      next.statusNote = patch.statusNote;
    } else if (patch.status === 'cancelled' || patch.status === 'failed') {
      if (isWorldLabsRecoveryReplayReady(record)) {
        const existingWarning = record.statusNote
          && record.statusNote !== WORLD_LABS_CANCELLATION_NOTE
          && record.statusNote !== WORLD_LABS_FAILURE_NOTE
          && record.statusNote !== WORLD_LABS_RECOVERY_READY_NOTE
          ? record.statusNote
          : undefined;
        next.statusNote = existingWarning ?? WORLD_LABS_RECOVERY_READY_NOTE;
      } else if (patch.status === 'cancelled') {
        next.statusNote = worldLabsCancellationNote(record.snapshot, record.targetNodeId);
      } else {
        next.statusNote = worldLabsFailureNote(record.snapshot, record.targetNodeId);
      }
    } else {
      delete next.statusNote;
    }
    return next;
  }));
}

export const WORLD_LABS_CANCELLATION_NOTE =
  'Local polling stopped. An accepted World Labs operation may continue and remain billable. Check Marble, then select the live World node and Run to use its preserved recovery ID; saved replay is disabled.';

export const WORLD_LABS_FAILURE_NOTE =
  'Check Marble before trying again. If World Labs accepted the operation, use the recovery ID preserved on the live World node and Run it there; saved retry is disabled.';

export const WORLD_LABS_RECOVERY_READY_NOTE =
  'Recovery ID restored. Recover resumes the accepted World Labs work without submitting a new paid operation.';

export const WORLD_LABS_RECONNECTING_NOTE =
  'Reconnecting to this World Labs run. Run remains locked until Nebula confirms its backend status.';

export const EXECUTION_RECONNECTING_NOTE =
  'Reconnecting to this run. It remains active until Nebula confirms its backend status.';

/** Confirmation removes only temporary connection advice. Provider diagnostics
 * and terminal notes remain intact. */
export function clearRunReconnectingNote(history: RunRecord[], runId: string): RunRecord[] {
  const record = history.find((candidate) => candidate.id === runId);
  if (!record || record.status !== 'running'
    || (record.statusNote !== EXECUTION_RECONNECTING_NOTE && record.statusNote !== WORLD_LABS_RECONNECTING_NOTE)) return history;
  return history.map((candidate) => {
    if (candidate.id !== runId) return candidate;
    const confirmed = { ...candidate };
    delete confirmed.statusNote;
    return confirmed;
  });
}

export function worldLabsCancellationNote(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): string | undefined {
  return runIncludesFreshPaidWorldLabsStart(snapshot, targetNodeId)
    ? WORLD_LABS_CANCELLATION_NOTE
    : undefined;
}

export function worldLabsFailureNote(
  snapshot: RunGraphSnapshot,
  targetNodeId?: string,
): string | undefined {
  return runIncludesFreshPaidWorldLabsStart(snapshot, targetNodeId)
    ? WORLD_LABS_FAILURE_NOTE
    : undefined;
}

function browserStorage(): RunHistoryStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isSnapshotNode(value: unknown): value is RunSnapshotNode {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.definitionId === 'string'
    && isObject(value.params)
    && isObject(value.outputs);
}

function isOptionalHandle(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isSnapshotEdge(value: unknown): value is RunSnapshotEdge {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.source === 'string'
    && typeof value.target === 'string'
    && isOptionalHandle(value.sourceHandle)
    && isOptionalHandle(value.targetHandle);
}

function isRunSnapshot(value: unknown): value is RunGraphSnapshot {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  return value.nodes.every(isSnapshotNode) && value.edges.every(isSnapshotEdge);
}

const RUN_STATUSES: RunStatus[] = ['running', 'complete', 'failed', 'cancelled'];
const RUN_TRIGGERS: RunTrigger[] = ['graph', 'node', 'cluster', 'shot'];
const REPLAY_ACTIONS: RunReplayAction[] = ['rerun', 'retry-failed', 'latest-paper-source'];

function isRunRecord(value: unknown): value is RunRecord {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && RUN_TRIGGERS.includes(value.trigger as RunTrigger)
    && typeof value.startedAt === 'number'
    && Number.isFinite(value.startedAt)
    && value.startedAt >= 0
    && RUN_STATUSES.includes(value.status as RunStatus)
    && isRunSnapshot(value.snapshot)
    && (value.targetNodeId === undefined || typeof value.targetNodeId === 'string')
    && (value.sourceRunId === undefined || typeof value.sourceRunId === 'string')
    && (value.replayAction === undefined || REPLAY_ACTIONS.includes(value.replayAction as RunReplayAction))
    && isOptionalFiniteNumber(value.durationSec)
    && isOptionalFiniteNumber(value.nodesExecuted)
    && (value.startedFreshPaidWorldLabs === undefined
      || typeof value.startedFreshPaidWorldLabs === 'boolean')
    && (value.createOrigin === undefined || isCreateRunOrigin(value.createOrigin))
    && (value.cinemaShot === undefined || isCinemaShotRun(value.cinemaShot))
    && (value.trigger !== 'shot' || isCinemaShotRun(value.cinemaShot))
    && (value.statusNote === undefined
      || (typeof value.statusNote === 'string' && value.statusNote.length <= 1_000))
    && (value.recipeRevision === undefined || typeof value.recipeRevision === 'string')
    && (value.paperInputs === undefined || (Array.isArray(value.paperInputs)
      && value.paperInputs.every((input) => isObject(input)
        && typeof input.nodeId === 'string' && typeof input.sourceId === 'string'
        && isObject(input.snapshot) && typeof input.snapshot.hash === 'string'
        && typeof input.snapshot.id === 'string' && isObject(input.snapshot.identity))))
    && (value.resultOutputs === undefined || (isObject(value.resultOutputs)
      && Object.values(value.resultOutputs).every((outputs) => isObject(outputs)
        && Object.values(outputs).every((output) => isObject(output)
          && typeof output.type === 'string' && 'value' in output))))
    && (value.batchOutputs === undefined || (isObject(value.batchOutputs)
      && Object.values(value.batchOutputs).every((batch) => Array.isArray(batch)
        && batch.every((outputs) => isObject(outputs)
          && Object.values(outputs).every((output) => isObject(output)
            && typeof output.type === 'string' && 'value' in output)))))
    && (value.outOfDateReasons === undefined || (Array.isArray(value.outOfDateReasons)
      && value.outOfDateReasons.every((reason) => typeof reason === 'string')));
}

function isCreateRunOrigin(value: unknown): value is CreateRunOrigin {
  return isObject(value) && typeof value.genId === 'string'
    && typeof value.sessionId === 'string' && typeof value.prompt === 'string'
    && typeof value.ts === 'number' && Number.isFinite(value.ts) && value.ts >= 0
    && Array.isArray(value.modelNodeIds) && value.modelNodeIds.every((id) => typeof id === 'string')
    && Array.isArray(value.allNodeIds) && value.allNodeIds.every((id) => typeof id === 'string');
}

function isCinemaShotRun(value: unknown): value is CinemaShotRun {
  return isObject(value) && typeof value.nodeId === 'string' && typeof value.shotId === 'string'
    && isOptionalFiniteNumber(value.seed) && isOptionalFiniteNumber(value.variations);
}

/** Persist a capped history list. Quota, privacy-mode, and unavailable-storage
 * failures are deliberately non-fatal. */
export function persistRunHistory(
  history: RunRecord[],
  storage?: RunHistoryStorage | null,
): void {
  const key = historyStorageKey(storage !== undefined);
  storage = storage === undefined ? browserStorage() : storage;
  if (!storage) return;
  const payload: StoredRunHistory = {
    version: RUN_HISTORY_STORAGE_VERSION,
    records: cappedRunHistory(history),
  };
  try {
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    /* History persistence is best-effort and must never block execution. */
  }
}

/** Load immutable history. Running records retain their client-owned IDs so
 * browser reload can reconcile the backend task instead of inventing a stop. */
export function loadRunHistory(
  storage?: RunHistoryStorage | null,
): RunRecord[] {
  const key = historyStorageKey(storage !== undefined);
  storage = storage === undefined ? browserStorage() : storage;
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)
      || parsed.version !== RUN_HISTORY_STORAGE_VERSION
      || !Array.isArray(parsed.records)) {
      throw new Error('Invalid run-history envelope');
    }

    const validRecords = cappedRunHistory(parsed.records.filter(isRunRecord));
    let metadataChanged = false;
    const recovered = validRecords.map((record) => {
      const batchVariants = sanitizeRunBatchVariants(record);
      if (JSON.stringify(record.batchVariants) !== JSON.stringify(batchVariants)) metadataChanged = true;
      const reconnectingWorldLabs = record.status === 'running'
        && (record.startedFreshPaidWorldLabs === true
          || (record.startedFreshPaidWorldLabs === undefined
            && runIncludesWorldLabs(record.snapshot, record.targetNodeId)));
      const status = record.status;
      const statusNote = reconnectingWorldLabs
        ? WORLD_LABS_RECONNECTING_NOTE
        : status === 'running' ? EXECUTION_RECONNECTING_NOTE
        : status === 'cancelled'
        ? (record.statusNote ?? (record.startedFreshPaidWorldLabs === false
          ? undefined
          : worldLabsCancellationNote(record.snapshot, record.targetNodeId)))
        : status === 'failed'
          ? (record.statusNote ?? worldLabsFailureNote(record.snapshot, record.targetNodeId))
          : undefined;
      return {
        ...record,
        snapshot: freezeRunSnapshot(record.snapshot),
        createOrigin: record.createOrigin ? deepFreeze(record.createOrigin) : undefined,
        cinemaShot: record.cinemaShot ? deepFreeze(record.cinemaShot) : undefined,
        ...(record.paperInputs ? { paperInputs: deepFreeze(record.paperInputs) } : {}),
        ...(record.resultOutputs ? { resultOutputs: deepFreeze(record.resultOutputs) } : {}),
        ...(record.batchOutputs ? { batchOutputs: deepFreeze(record.batchOutputs) } : {}),
        batchVariants: batchVariants ? deepFreeze(batchVariants) : undefined,
        status,
        statusNote,
      };
    });

    if (metadataChanged || validRecords.length !== parsed.records.length
      || parsed.records.length > MAX_RUN_HISTORY
      || validRecords.some((record, index) => (
        record.status !== recovered[index].status
          || record.statusNote !== recovered[index].statusNote
      ))) {
      // Keep the selected project key even though normalization uses a local
      // storage object internally.
      try { storage.setItem(key, JSON.stringify({ version: RUN_HISTORY_STORAGE_VERSION, records: recovered })); }
      catch { /* Normalization must not discard history when storage is full. */ }
    }
    return cappedRunHistory(recovered);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* Ignore unavailable-storage failures during recovery too. */
    }
    return [];
  }
}

export function clearPersistedRunHistory(
  storage?: RunHistoryStorage | null,
): void {
  const key = historyStorageKey(storage !== undefined);
  storage = storage === undefined ? browserStorage() : storage;
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* Clearing UI state still succeeds when storage is unavailable. */
  }
}

const TRIGGER_LABELS: Record<RunTrigger, string> = {
  graph: 'Full graph',
  node: 'Single node',
  cluster: 'Selection',
  shot: 'Cinema shot',
};

/** Human label for a run's trigger. Pure. */
export function runTriggerLabel(trigger: RunTrigger): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

/** Compact duration string (e.g. "0.8s", "12s", "1m 05s"). Pure. */
export function formatRunDuration(durationSec: number | undefined): string {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec < 0) return '—';
  if (durationSec < 10) return `${durationSec.toFixed(1)}s`;
  if (durationSec < 60) return `${Math.round(durationSec)}s`;
  const m = Math.floor(durationSec / 60);
  const s = Math.round(durationSec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Relative age of a run from `now` (e.g. "just now", "3m ago"). Pure. */
export function formatRunAge(now: number, startedAt: number): string {
  const deltaSec = Math.max(0, Math.round((now - startedAt) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}
