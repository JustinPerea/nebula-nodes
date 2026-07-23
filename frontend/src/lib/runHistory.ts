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
  patch: { status: RunStatus; durationSec?: number; nodesExecuted?: number },
): RunRecord[] {
  return history.map((r) => (r.id === id ? { ...r, ...patch } : r));
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
    && isOptionalFiniteNumber(value.nodesExecuted);
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
    const recovered = validRecords.map((record) => ({
      ...record,
      snapshot: freezeRunSnapshot(record.snapshot),
      status: record.status === 'running' ? 'cancelled' as const : record.status,
    }));

    if (validRecords.length !== parsed.records.length
      || parsed.records.length > MAX_RUN_HISTORY
      || validRecords.some((record) => record.status === 'running')) {
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
