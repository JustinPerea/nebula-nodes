/**
 * Whether this tab last found Nebula's backend reachable: what the offline
 * banner shows (BackendConnectionStatus, which probes /api/health every few
 * seconds and notes each answer here).
 *
 * Offline means read-only (GM, round 14 of PR #114): "Edits are blocked while
 * offline, not queued", because a restarted backend refuses replayed writes.
 * Every edit path asks `refuseEditWhileOffline()` before it changes anything
 * (graphStore wraps its edit actions with it; a file drop, Clear, chat /clear
 * and Load graph ask it directly). A refused edit says nothing of its own:
 * the banner pulses once, at most once a second.
 */
export type BackendConnection = 'online' | 'offline';

let connection: BackendConnection = 'online';
const listeners = new Set<() => void>();

/** Probes are numbered as they start; an answer older than the newest one
 * applied is ignored (review 13, L4: a slow probe's late failure flipped a
 * connected tab offline). */
let probesStarted = 0;
let newestApplied = 0;

export function noteBackendConnection(next: BackendConnection): void {
  if (connection === next) return;
  connection = next;
  for (const listener of [...listeners]) listener();
}

/** A new health probe's number, for `noteProbeAnswer`. */
export function startHealthProbe(): number {
  probesStarted += 1;
  return probesStarted;
}

/** Applies probe `seq`'s answer unless a newer probe's answer was applied
 * already. Returns whether it was applied. */
export function noteProbeAnswer(seq: number, next: BackendConnection): boolean {
  if (seq < newestApplied) return false;
  newestApplied = seq;
  noteBackendConnection(next);
  return true;
}

export function isBackendOffline(): boolean {
  return connection === 'offline';
}

export function subscribeBackendConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// -- the pulse a blocked edit gives the banner ----------------------------------

export const BLOCKED_EDIT_PULSE_MS = 1_000;
const pulseListeners = new Set<() => void>();
let lastPulseAt = Number.NEGATIVE_INFINITY;

/** The banner's nudge for a blocked edit: at most once a second (GM). */
export function pulseOfflineBanner(now: number = Date.now()): boolean {
  if (now - lastPulseAt < BLOCKED_EDIT_PULSE_MS) return false;
  lastPulseAt = now;
  for (const listener of [...pulseListeners]) listener();
  return true;
}

export function subscribeOfflinePulse(listener: () => void): () => void {
  pulseListeners.add(listener);
  return () => { pulseListeners.delete(listener); };
}

/**
 * The one gate every edit goes through: true (and the banner pulses) when
 * Nebula is offline, so the caller changes nothing and sends nothing. No
 * toast (GM, round 14: "No toast for a blocked edit").
 */
export function refuseEditWhileOffline(): boolean {
  if (!isBackendOffline()) return false;
  for (const listener of [...blockedListeners]) listener();
  pulseOfflineBanner();
  return true;
}

const blockedListeners = new Set<() => void>();

/** Every blocked edit, unthrottled (tests, and anything counting them). */
export function subscribeBlockedEdits(listener: () => void): () => void {
  blockedListeners.add(listener);
  return () => { blockedListeners.delete(listener); };
}

/** Test seam: back to a fresh tab's state. */
export function resetBackendConnectionForTests(): void {
  connection = 'online';
  probesStarted = 0;
  newestApplied = 0;
  lastPulseAt = Number.NEGATIVE_INFINITY;
  for (const listener of [...listeners]) listener();
}
