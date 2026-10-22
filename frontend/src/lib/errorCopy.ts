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

/**
 * A request that got no answer, as apiFetch throws it. Still a TypeError (as
 * fetch's own is), so code that tells "no answer" from a refusal keeps
 * working; its message is the line to show, and `cause` is the browser's
 * own error.
 */
export class ConnectionLostError extends TypeError {
  readonly status = NO_ANSWER_STATUS;
  readonly kind = 'connection' as const;

  constructor(cause: unknown) {
    super(CONNECTION_LOST_COPY, { cause });
    this.name = 'ConnectionLostError';
  }
}

/** A request that was answered with a failure, its message already copy;
 * `status` and the raw `detail` stay for debugging. */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'RequestFailedError';
    this.status = status;
    this.detail = detail;
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
