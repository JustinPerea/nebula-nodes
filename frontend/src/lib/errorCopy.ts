/**
 * What the person reads when a request to Nebula fails (error-copy, GM -
 * Design, 2026-10-22): "Never show raw error.message strings in UI." The
 * browser's "Failed to fetch" is a TypeError's message, not copy, and a
 * status code isn't either.
 *
 * The words are made where requests are made, not at each screen, so a new
 * screen can't leak a raw string: apiFetch (lib/backend.ts) turns a request
 * with no answer into a ConnectionLostError, and the Commons and board API
 * helpers (lib/commonsApi.ts, lib/api.ts) turn an answer's status into one
 * of these lines with copyForStatus. The original error (its message, its
 * status, the raw `detail`) stays on the thrown error as `cause` / `detail`
 * for the console and debugging; only the line is meant to be rendered.
 *
 * Round 2 (GM, 2026-10-22): every request names its action. A request's
 * error carries `heading` ("Couldn't save the board."), `reason` (one of
 * these lines, or the backend's written reason) and `kind`; its `message`
 * is the one-line form, "<heading> <reason>", for alerts, toasts and status
 * text. Two-line surfaces render failureCopy() through FailureLines; a
 * surface with its own retry button takes the short reason (shortReason /
 * shortLine, GM's WRAP rule). apiRequest (lib/apiRequest.ts) is the one way
 * to make such a call; answered failures are console.warn'ed once per call
 * site (warnFailure), lost connections aren't.
 */

/** No answer at all: the connection dropped, or the backend isn't there. */
export const CONNECTION_LOST_COPY = "Couldn't reach Nebula. Check your connection and try again.";
/** An answer that says "not now": 408, 429 or any 5xx. */
export const NO_RESPONSE_COPY = "Nebula didn't respond. Try again.";
/** A refusal (any other 4xx) that came with no reason the person can read:
 * no `detail`, or FastAPI's list of field errors (GM, error-copy fallbacks).
 * Also what a failure that isn't a request's says (copyForError). */
export const REFUSED_FALLBACK_COPY = "That didn't work. Try again, or reload if it keeps happening.";
/** 401 or 403 with no reason (GM). */
export const ACCESS_LOST_COPY = "You don't have access to this anymore. Reload to sign in again.";
/** 413 with no reason (GM). */
export const TOO_LARGE_COPY = "That's too large to save.";

/** GM's WRAP rule (round 2): "when the surface already has a retry button,
 * the reason line drops its 'try again'. The button is the retry." Only
 * failureCopy({ short: true }) picks these. */
export const CONNECTION_LOST_SHORT_COPY = "Couldn't reach Nebula. Check your connection.";
export const NO_RESPONSE_SHORT_COPY = "Nebula didn't respond.";
/** A plain browser tab that found no backend on its ports (GM, round 2).
 * The ports it tried stay on the error for the console. */
export const BACKEND_NOT_RUNNING_COPY = "Nebula's backend isn't running. Start it, then reload.";
/** The Commons lost the person's sign-in in a plain browser tab (GM, round
 * 2): "That's a dev setup and the reader is Justin, so naming the terminal
 * is right." The desktop app refetches its token silently; if a 401 still
 * comes back there, it says ACCESS_LOST_COPY, since a reload fetches the
 * shell's token again. */
export const COMMONS_SESSION_EXPIRED_COPY = 'Your session expired. Open a fresh Commons link from the backend terminal.';

/** The line for a Commons call with no person session: `desktop` is
 * personSession's inDesktopShell(). */
export function commonsSessionCopy(desktop: boolean): string {
  return desktop ? ACCESS_LOST_COPY : COMMONS_SESSION_EXPIRED_COPY;
}

/** The status a failure with no answer carries wherever a status is read. */
export const NO_ANSWER_STATUS = 0;

/** `connection`: no answer. `no-response`: 408, 429, 5xx. `refused`: any other 4xx. */
export type FailureKind = 'connection' | 'no-response' | 'refused';

export function failureKind(status: number): FailureKind {
  if (status === NO_ANSWER_STATUS) return 'connection';
  if (status === 408 || status === 429 || status >= 500) return 'no-response';
  return 'refused';
}

/** Whether sending the same request again could work (GM, commons-leave):
 * after no answer, a timeout, a rate limit or a server error; not after a
 * refusal the same request would get again (a conflict, a closed batch). */
export function canTryAgain(status: number): boolean {
  return failureKind(status) !== 'refused';
}

/** What a failure says: the heading names what failed ("Couldn't save the
 * board."), the reason line says why. Either may be '' (a reason alone, when
 * the surface already names the action). */
export interface FailureCopy {
  heading: string;
  reason: string;
}

/** The one-line form, for alerts, toasts, tooltips and status text (GM:
 * "Couldn't {verb} {object}. {reason}" in one string). */
export function oneLine(copy: FailureCopy): string {
  return [copy.heading, copy.reason].filter(Boolean).join(' ');
}

/**
 * A request that got no answer, as apiFetch throws it. Still a TypeError (as
 * fetch's own is), so code that tells "no answer" from a refusal keeps
 * working; its message is the line to show, and `cause` is the browser's
 * own error. `withHeading` names the action once the caller knows it.
 */
export class ConnectionLostError extends TypeError {
  readonly status = NO_ANSWER_STATUS;
  readonly kind = 'connection' as const;
  readonly heading: string;
  readonly reason: string;
  /** What the console should know (a discovery failure's ports); undefined for a dropped request. */
  readonly detail: unknown;

  constructor(cause: unknown, options: { heading?: string; reason?: string; detail?: unknown } = {}) {
    const heading = options.heading ?? '';
    const reason = options.reason ?? CONNECTION_LOST_COPY;
    super(oneLine({ heading, reason }), { cause });
    this.name = 'ConnectionLostError';
    this.heading = heading;
    this.reason = reason;
    this.detail = options.detail;
  }

  withHeading(heading: string): ConnectionLostError {
    return new ConnectionLostError(this.cause, { heading, reason: this.reason, detail: this.detail });
  }
}

/** A request that was answered with a failure. The heading is the caller's
 * (every request names its action); the reason is copy for the status
 * (copyForStatus) unless the caller wrote one; `status`, the raw `detail`
 * and `cause` stay for debugging and the console. */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly heading: string;
  readonly reason: string;

  constructor(heading: string, status: number, options: { detail?: unknown; reason?: string; cause?: unknown } = {}) {
    const reason = options.reason ?? copyForStatus(status, options.detail);
    super(oneLine({ heading, reason }), 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'RequestFailedError';
    this.status = status;
    this.detail = options.detail;
    this.heading = heading;
    this.reason = reason;
  }

  get kind(): FailureKind {
    return failureKind(this.status);
  }
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Whether `error`, thrown by fetch, means there was no answer: a TypeError
 * (Chrome's "Failed to fetch", Safari's "Load failed", Firefox's
 * "NetworkError when attempting to fetch resource."), or an AbortError the
 * caller didn't ask for. The caller's own abort (`signal` aborted) is not:
 * the caller stopped waiting, and it comes back as it was thrown.
 */
export function isConnectionFailure(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false;
  return error instanceof TypeError || isAbort(error);
}

/** The backend's `detail` when it is words (its 4xx reasons are written
 * copy); '' for none, an empty string, or FastAPI's list of field errors. */
export function detailText(detail: unknown): string {
  return typeof detail === 'string' ? detail.trim() : '';
}

/** GM's line for a refusal that gave no reason, by its status. */
function refusedCopy(status: number): string {
  if (status === 401 || status === 403) return ACCESS_LOST_COPY;
  if (status === 413) return TOO_LARGE_COPY;
  return REFUSED_FALLBACK_COPY;
}

/** The line for an answer with `status`: GM's line for no answer, 408, 429
 * and 5xx (whatever the body said); else the backend's reason, or GM's line
 * for the status when it gave none. The action's own heading, where a screen
 * has one ("Couldn't save your labels."), stays above it: the heading names
 * what failed, the line gives the reason. */
export function copyForStatus(status: number, detail: unknown): string {
  const kind = failureKind(status);
  if (kind === 'connection') return CONNECTION_LOST_COPY;
  if (kind === 'no-response') return NO_RESPONSE_COPY;
  return detailText(detail) || refusedCopy(status);
}

/** The line for a thrown error that isn't a request's answer: the
 * connection line when fetch got no answer, else GM's general line, never
 * the error's own message. */
export function copyForError(error: unknown, signal?: AbortSignal | null): string {
  return isConnectionFailure(error, signal) ? CONNECTION_LOST_COPY : REFUSED_FALLBACK_COPY;
}

/** An answer's `detail`, read from a JSON body; undefined when there is none. */
export async function readDetail(response: Response): Promise<unknown> {
  try {
    const body = await response.json() as { detail?: unknown } | null;
    return body?.detail;
  } catch {
    return undefined;
  }
}

/** A failed request names its action: a ConnectionLostError (no answer)
 * gets `heading`; anything else (the caller's own abort, an error that
 * already has its heading) comes back as it was. */
export function withHeading(error: unknown, heading: string): unknown {
  return error instanceof ConnectionLostError && !error.heading ? error.withHeading(heading) : error;
}

function partsOf(error: unknown): FailureCopy | null {
  if (error instanceof ConnectionLostError || error instanceof RequestFailedError) {
    return { heading: error.heading, reason: error.reason };
  }
  return null;
}

/** The short form of a reason, for a surface with its own retry button
 * (GM's WRAP rule). Only GM's two "try again" lines have one; a refusal's
 * reason, GM's 4xx fallback included, stays as it is. */
export function shortReason(reason: string): string {
  if (reason === CONNECTION_LOST_COPY) return CONNECTION_LOST_SHORT_COPY;
  if (reason === NO_RESPONSE_COPY) return NO_RESPONSE_SHORT_COPY;
  return reason;
}

/** shortReason for a one-line string (a store keeps "<heading> <reason>"):
 * the same swap when the line ends with one of GM's two "try again" lines,
 * for a one-line surface whose own retry button sits beside it. */
export function shortLine(line: string): string {
  for (const long of [CONNECTION_LOST_COPY, NO_RESPONSE_COPY]) {
    if (line.endsWith(long)) return line.slice(0, line.length - long.length) + shortReason(long);
  }
  return line;
}

/**
 * Heading and reason for a two-line surface (a popover, a notice, a panel:
 * heading on line 1, reason on line 2), from any error. A request's error
 * carries both; anything else says the connection line or GM's general line
 * (copyForError) under `heading`, never its own message. `short` is for a
 * surface whose retry button is shown with the line. `heading` also stands
 * in when the request's error has none.
 */
export function failureCopy(error: unknown, options: { heading?: string; short?: boolean } = {}): FailureCopy {
  const parts = partsOf(error) ?? { heading: '', reason: copyForError(error) };
  const heading = parts.heading || options.heading || '';
  return { heading, reason: options.short ? shortReason(parts.reason) : parts.reason };
}

/** The one-line form of failureCopy, for a catch that has its own heading. */
export function failureMessage(error: unknown, heading: string): string {
  return oneLine(failureCopy(error, { heading }));
}

// GM: "Never 'failed:', '(HTTP 503)' or status codes in the UI. Keep them in
// the console." An answered failure is logged where it is made, once per
// call site (its heading) until that call succeeds again, so a poll against
// a backend that is down doesn't warn on every tick. A lost connection isn't
// logged: it is expected while offline.
const warned = new Map<string, string>();

export function warnFailure(heading: string, status: number, detail: unknown): void {
  let key: string;
  try { key = `${status} ${JSON.stringify(detail) ?? ''}`; } catch { key = String(status); }
  if (warned.get(heading) === key) return;
  warned.set(heading, key);
  console.warn(`[nebula] ${heading || 'Request failed.'} HTTP ${status}`, detail ?? '');
}

/** A call site's request worked: its next failure is logged again. */
export function requestSucceeded(heading: string): void {
  warned.delete(heading);
}

export function resetFailureWarningsForTests(): void {
  warned.clear();
}

/** The error for an answered failure, made where the request is made: the
 * caller's heading, the reason for its status and `detail` (read from the
 * body unless given), logged once for the console. `reason` overrides the
 * status's line when the caller wrote its own (a board moved to Recently
 * deleted). */
export async function requestError(heading: string, response: Response,
  options: { detail?: unknown; reason?: string } = {}): Promise<RequestFailedError> {
  const detail = 'detail' in options ? options.detail : await readDetail(response);
  warnFailure(heading, response.status, detail);
  return new RequestFailedError(heading, response.status, { detail, reason: options.reason });
}
