/** Persistent run-history records for the Run History panel. Records contain the
 * exact JSON graph sent to the backend so a later replay never reads mutable
 * canvas state. Storage helpers are exception-safe because history must never
 * prevent the canvas from loading or executing. */

export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled';
export type RunTrigger = 'graph' | 'node' | 'cluster';
export type RunReplayAction = 'rerun' | 'retry-failed';

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
  /** Immutable admission fact. Unlike snapshot params, this stays true after
   * a recovery event patches the accepted operation ID into the snapshot. */
  startedFreshPaidWorldLabs?: boolean;
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

/** Prepend a new running record, capping the list. Pure with respect to history;
 * the incoming snapshot is cloned so later canvas mutations cannot alter it. */
export function openRunRecord(history: RunRecord[], rec: OpenRunRecord): RunRecord[] {
  return [{ ...rec, snapshot: freezeRunSnapshot(rec.snapshot), status: 'running' as const }, ...history]
    .slice(0, MAX_RUN_HISTORY);
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
  return history.map((record) => {
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
  });
}

export const WORLD_LABS_CANCELLATION_NOTE =
  'Local polling stopped. An accepted World Labs operation may continue and remain billable. Check Marble, then select the live World node and Run to use its preserved recovery ID; saved replay is disabled.';

export const WORLD_LABS_FAILURE_NOTE =
  'Check Marble before trying again. If World Labs accepted the operation, use the recovery ID preserved on the live World node and Run it there; saved retry is disabled.';

export const WORLD_LABS_RECOVERY_READY_NOTE =
  'Recovery ID restored. Recover resumes the accepted World Labs work without submitting a new paid operation.';

export const WORLD_LABS_RECONNECTING_NOTE =
  'Reconnecting to this World Labs run. Run remains locked until Nebula confirms its backend status.';

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
const RUN_TRIGGERS: RunTrigger[] = ['graph', 'node', 'cluster'];
const REPLAY_ACTIONS: RunReplayAction[] = ['rerun', 'retry-failed'];

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
    && (value.statusNote === undefined
      || (typeof value.statusNote === 'string' && value.statusNote.length <= 1_000));
}

/** Persist a capped history list. Quota, privacy-mode, and unavailable-storage
 * failures are deliberately non-fatal. */
export function persistRunHistory(
  history: RunRecord[],
  storage: RunHistoryStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const payload: StoredRunHistory = {
    version: RUN_HISTORY_STORAGE_VERSION,
    records: history.slice(0, MAX_RUN_HISTORY),
  };
  try {
    storage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* History persistence is best-effort and must never block execution. */
  }
}

/** Load and normalize persisted history. Invalid individual records are dropped;
 * invalid JSON/envelopes are removed. A browser reload cannot reconnect to a
 * prior process, so orphaned running records recover as cancelled. */
export function loadRunHistory(
  storage: RunHistoryStorage | null = browserStorage(),
): RunRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RUN_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)
      || parsed.version !== RUN_HISTORY_STORAGE_VERSION
      || !Array.isArray(parsed.records)) {
      throw new Error('Invalid run-history envelope');
    }

    const validRecords = parsed.records.filter(isRunRecord).slice(0, MAX_RUN_HISTORY);
    const recovered = validRecords.map((record) => {
      const reconnectingWorldLabs = record.status === 'running'
        && (record.startedFreshPaidWorldLabs === true
          || (record.startedFreshPaidWorldLabs === undefined
            && runIncludesWorldLabs(record.snapshot, record.targetNodeId)));
      const status = record.status === 'running' && !reconnectingWorldLabs
        ? 'cancelled' as const
        : record.status;
      const statusNote = reconnectingWorldLabs
        ? WORLD_LABS_RECONNECTING_NOTE
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
        status,
        statusNote,
      };
    });

    if (validRecords.length !== parsed.records.length
      || parsed.records.length > MAX_RUN_HISTORY
      || validRecords.some((record, index) => (
        record.status !== recovered[index].status
          || record.statusNote !== recovered[index].statusNote
      ))) {
      persistRunHistory(recovered, storage);
    }
    return recovered;
  } catch {
    try {
      storage.removeItem(RUN_HISTORY_STORAGE_KEY);
    } catch {
      /* Ignore unavailable-storage failures during recovery too. */
    }
    return [];
  }
}

export function clearPersistedRunHistory(
  storage: RunHistoryStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(RUN_HISTORY_STORAGE_KEY);
  } catch {
    /* Clearing UI state still succeeds when storage is unavailable. */
  }
}

const TRIGGER_LABELS: Record<RunTrigger, string> = {
  graph: 'Full graph',
  node: 'Single node',
  cluster: 'Selection',
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
