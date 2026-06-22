/** Session run-history records for the Run History panel. Pure transforms so the
 *  open/close lifecycle is unit-testable; the store holds the array + a current-run id. */

export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled';
export type RunTrigger = 'graph' | 'node' | 'cluster';

export interface RunRecord {
  id: string;
  trigger: RunTrigger;
  startedAt: number; // epoch ms
  status: RunStatus;
  durationSec?: number;
  nodesExecuted?: number;
}

export const MAX_RUN_HISTORY = 50;

/** Prepend a new running record, capping the list. Pure. */
export function openRunRecord(
  history: RunRecord[],
  rec: { id: string; trigger: RunTrigger; startedAt: number },
): RunRecord[] {
  return [{ ...rec, status: 'running' as const }, ...history].slice(0, MAX_RUN_HISTORY);
}

/** Patch a record (by id) with its terminal status/metrics. Pure; no-op if absent. */
export function closeRunRecord(
  history: RunRecord[],
  id: string,
  patch: { status: RunStatus; durationSec?: number; nodesExecuted?: number },
): RunRecord[] {
  return history.map((r) => (r.id === id ? { ...r, ...patch } : r));
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
