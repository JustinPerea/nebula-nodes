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

/**
 * A write apiFetch refused to send because Nebula is offline (round 15 of
 * PR #114: one gate at the network layer). Every method but GET and HEAD is a
 * write; nothing is sent, the banner pulses (refuseEditWhileOffline) and the
 * caller treats it as blocked: no toast, no line (errorCopy gives it no
 * copy). It catches every path a per-action gate can miss: autosave,
 * proposals, Forget ID, Create, chat, project writes, the unlock and runs.
 */
export class OfflineRefusal extends Error {
  readonly kind = 'offline' as const;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string) {
    super(`Nebula is offline: ${method} ${path} was not sent.`);
    this.name = 'OfflineRefusal';
    this.method = method;
    this.path = path;
  }
}

export function isOfflineRefusal(error: unknown): error is OfflineRefusal {
  return error instanceof OfflineRefusal;
}

/** Whether a request with `method` changes anything (all but GET and HEAD). */
export function isWriteMethod(method: string | undefined): boolean {
  const upper = String(method ?? 'GET').toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

interface GateRule {
  method: string;
  /** Matched against the whole path apiFetch was given (query included). */
  pattern: RegExp;
  what: string;
}

/** A run, render or worker id as Nebula makes them (uuid, `cinema-shot-…`,
 * a job id): no dots or slashes, so no path segment can walk elsewhere. */
const ID = '[A-Za-z0-9_-]{1,128}';

/**
 * The writes sent while offline (round 16 of PR #114, M1): each one only
 * reduces work or spend, so a false offline never traps a run the person
 * wants stopped. Nothing that starts work, spends or lowers a safeguard is
 * here: the unlock, Forget ID, proposal Accept and Reject stay refused.
 * tests/lib/offlineCancelAllowlist.test.ts pins it, request by request.
 */
export const OFFLINE_CANCEL_ALLOWLIST: readonly GateRule[] = [
  // The bottom Stop, Run History's Cancel, Create's "Stop N" and Cinema's
  // Stop scene / Stop shot (graphStore cancelExecution / cancelRun).
  { method: 'DELETE', pattern: new RegExp(`^\\/api\\/executions\\/${ID}$`), what: 'Stop a run' },
  // The video editor's render Cancel (hooks/useRenderJob.ts).
  { method: 'DELETE', pattern: new RegExp(`^\\/api\\/render-jobs\\/${ID}$`), what: 'Cancel a render' },
  // The Commons status line's Stop.
  { method: 'POST', pattern: /^\/api\/commons\/worker\/stop$/, what: "Stop the Commons worker" },
];

/**
 * Background reports that aren't edits (L1): the selection and view agents
 * read, a price's input-size ask and the zoom manifest. Offline they are held
 * back without the banner's pulse (only an edit pulses); the selection and
 * view are sent again on reconnect (Canvas, CanvasViewReporter).
 */
export const OFFLINE_QUIET_WRITES: readonly GateRule[] = [
  { method: 'POST', pattern: /^\/api\/canvas\/selection$/, what: 'the selection agents read' },
  { method: 'POST', pattern: /^\/api\/canvas\/view$/, what: 'the view agents read' },
  { method: 'POST', pattern: /^\/api\/pricing\/input-sizes$/, what: "a price's input sizes" },
  { method: 'POST', pattern: /^\/api\/zoom-manifest\/(?:init|entry)$/, what: 'the zoom manifest' },
];

function matches(rules: readonly GateRule[], method: string | undefined, path: string): boolean {
  const upper = String(method ?? 'GET').toUpperCase();
  return rules.some((rule) => rule.method === upper && rule.pattern.test(path));
}

/** Whether a write is on the cancel allowlist (sent while offline). */
export function isOfflineCancel(method: string | undefined, path: string): boolean {
  return matches(OFFLINE_CANCEL_ALLOWLIST, method, path);
}

/** The network gate: throws an OfflineRefusal (after the banner's pulse) for
 * a write while offline. The health probe is a GET, so it always goes, and
 * so does a cancel on the allowlist. A view-state report is refused without
 * the pulse. */
export function refuseWriteWhileOffline(method: string | undefined, path: string): void {
  if (!isWriteMethod(method) || !isBackendOffline()) return;
  if (isOfflineCancel(method, path)) return;
  if (!matches(OFFLINE_QUIET_WRITES, method, path)) refuseEditWhileOffline();
  throw new OfflineRefusal(String(method).toUpperCase(), path);
}

/** Every blocked edit, unthrottled (tests, and anything counting them). */
export function subscribeBlockedEdits(listener: () => void): () => void {
  blockedListeners.add(listener);
  return () => { blockedListeners.delete(listener); };
}

/** Resolves once Nebula is online (at once when it already is). */
export function waitUntilOnline(): Promise<void> {
  if (!isBackendOffline()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = subscribeBackendConnection(() => {
      if (isBackendOffline()) return;
      stop();
      resolve();
    });
  });
}

// -- which backend process this tab talks to -----------------------------------

/**
 * The backend process's id (main.py BACKEND_BOOT_ID), noted from every
 * socket hello and health answer whether or not a project is open (round 16
 * of PR #114, review 15 M4: the first hello arrives before the tab has a
 * project, and a graph-level note dropped it). A different id later means
 * the backend restarted: anything it held in memory is gone.
 */
let knownBootId: string | null = null;
const restartListeners = new Set<() => void>();
/** Review 10, N-4: the processes this tab has seen replaced. Each process
 * has its own id and never comes back, so a late message from one is not a
 * restart, and its syncs are dropped (isRetiredBackendBoot). */
const retiredBootIds = new Set<string>();
/** Review 11, L-4: when each process started (main.py BACKEND_BOOT_STARTED_AT,
 * microseconds), as its hello or health answer said. */
const bootStarts = new Map<string, number>();

/** `startedAt`: when that process started, if it said. Review 11, L-4: of
 * two processes the later start is the newer, whatever order their messages
 * arrive in, so a late health answer from a short-lived middle process (two
 * quick restarts) is retired on arrival and never retires the live one. With
 * no start known for the current process (a backend before round 12), the
 * newest id seen wins, as before. */
export function noteBackendBootId(bootId: unknown, startedAt?: unknown): void {
  if (typeof bootId !== 'string' || !bootId) return;
  if (typeof startedAt === 'number' && Number.isFinite(startedAt) && !bootStarts.has(bootId)) {
    bootStarts.set(bootId, startedAt);
    if (bootStarts.size > 64) bootStarts.delete(bootStarts.keys().next().value!);
  }
  if (retiredBootIds.has(bootId)) return;
  const previous = knownBootId;
  if (previous === bootId) return;
  const start = bootStarts.get(bootId);
  const previousStart = previous !== null ? bootStarts.get(previous) : undefined;
  // One that doesn't say when it started is a backend from before the start
  // was sent: older than one that says.
  if (previousStart !== undefined && (start === undefined || start < previousStart)) {
    retiredBootIds.add(bootId);
    return;
  }
  knownBootId = bootId;
  if (previous !== null) {
    retiredBootIds.add(previous);
    for (const listener of [...restartListeners]) listener();
  }
}

/** Whether `bootId` names a backend process already replaced by another. */
export function isRetiredBackendBoot(bootId: unknown): boolean {
  return typeof bootId === 'string' && retiredBootIds.has(bootId);
}

export function backendBootId(): string | null {
  return knownBootId;
}

/** Called when a new boot id shows the backend restarted. */
export function subscribeBackendRestart(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => { restartListeners.delete(listener); };
}

// -- asking for a health probe now --------------------------------------------

const probeRequestListeners = new Set<() => void>();

/** A reopened socket's first message proves the backend answers (review 15,
 * M3): the banner probes at once instead of up to 3 s later, so writes aren't
 * refused while the socket is visibly connected. */
export function requestHealthProbe(): void {
  for (const listener of [...probeRequestListeners]) listener();
}

export function subscribeHealthProbeRequests(listener: () => void): () => void {
  probeRequestListeners.add(listener);
  return () => { probeRequestListeners.delete(listener); };
}

/** Test seam: back to a fresh tab's state. */
export function resetBackendConnectionForTests(): void {
  connection = 'online';
  probesStarted = 0;
  newestApplied = 0;
  lastPulseAt = Number.NEGATIVE_INFINITY;
  knownBootId = null;
  retiredBootIds.clear();
  bootStarts.clear();
  for (const listener of [...listeners]) listener();
}
