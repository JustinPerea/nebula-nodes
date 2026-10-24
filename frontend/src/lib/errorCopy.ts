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

import { inDesktopShell, personUnavailableReason } from './personSession';

/** No answer at all: the connection dropped, or the backend isn't there.
 * Round 3f (GM): ""Check your connection" sends people to their Wi-Fi, but
 * the backend is on this computer." apiFetch only ever calls Nebula's own
 * server, so this is never a provider the backend couldn't reach (those come
 * back as the backend's answer, with the classifier's "network" line). */
export const CONNECTION_LOST_COPY = "Nebula's server isn't answering. Make sure it's running, then try again.";
/** An answer that says "not now": 408, 429 or any 5xx. */
export const NO_RESPONSE_COPY = "Nebula didn't respond. Try again.";
/** A refusal (any other 4xx) that came with no reason the person can read:
 * no `detail`, or FastAPI's list of field errors (GM, error-copy fallbacks).
 * Also what a failure that isn't a request's says (copyForError). Round 3f
 * (GM): "Under any other heading (Projects, graph file, Commons…), drop
 * "That didn't work."". A node card says its own (lib/nodeErrorCopy.ts). */
export const REFUSED_FALLBACK_COPY = "Try again, or reload if it keeps happening.";
/** 401 or 403 with no reason (GM). */
export const ACCESS_LOST_COPY = "You don't have access to this anymore. Reload to sign in again.";
/** 413 with no reason (GM). */
export const TOO_LARGE_COPY = "That's too large to save.";

/** The person gate's code for a refusal only the person may get past: this
 * tab isn't connected as the person (no person token, or one from before
 * Nebula restarted), which reconnecting fixes (backend services/person_gate.py). */
export const PERSON_REQUIRED_CODE = 'person_required';
/** GM - Design, 2026-10-23 (Q116 a), verbatim, for every refusal that says
 * PERSON_REQUIRED_CODE: "Use it for every person-only refusal, not just Krea
 * billing. The agents' text stays behind Details." Classified by the answer's
 * `code`, never its words. Round 2 (GM): "line 3 shouldn't depend on the
 * notice being there, since it can be dismissed", so it says the fix itself.
 * A browser tab's line; the desktop app says PERSON_REQUIRED_APP_COPY. */
export const PERSON_REQUIRED_COPY = "This change needs your OK, and this tab isn't connected as you. "
  + 'Open the link Nebula printed when it started, then try again.';
/** GM - Design, 2026-10-23 (round 2), verbatim: line 3 in the desktop app. A
 * quit and reopen gives the app a fresh backend and a fresh person token. */
export const PERSON_REQUIRED_APP_COPY = "This change needs your OK, and this window isn't connected as you. "
  + 'Quit Nebula and open it again, then try again.';

/** GM - Design, 2026-10-23 (round 3), verbatim: line 3 in the app's two
 * developer setups (a debug port, the dev renderer), where the banner already
 * gives the real fix. */
export const PERSON_REQUIRED_DEV_COPY = "This change needs your OK, and this window isn't connected as you. "
  + 'The notice below says why.';

/** Line 3 for where this page runs: `desktop` is personSession's
 * inDesktopShell() (the preload bridge), the flag the rest of the error copy
 * reads (commonsSessionCopy); `reason` is the shell's own, when it gave one. */
export function personRequiredCopy(desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  if (!desktop) return PERSON_REQUIRED_COPY;
  return reason === 'debug-port' || reason === 'dev-renderer' ? PERSON_REQUIRED_DEV_COPY : PERSON_REQUIRED_APP_COPY;
}

const isPersonRequiredCopy = (line: string) =>
  line === PERSON_REQUIRED_COPY || line === PERSON_REQUIRED_APP_COPY || line === PERSON_REQUIRED_DEV_COPY;

/** GM's WRAP rule (round 2): "when the surface already has a retry button,
 * the reason line drops its 'try again'. The button is the retry." Only
 * failureCopy({ short: true }) picks these. */
export const CONNECTION_LOST_SHORT_COPY = "Nebula's server isn't answering. Make sure it's running.";
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
 * and `cause` stay for debugging and the console. A person-only refusal
 * (`code` PERSON_REQUIRED_CODE) always reads GM's line 3 (personRequiredCopy),
 * whatever reason the caller passed: its `detail` is written for agents, and
 * failureDetails hands it to a Details toggle. */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly heading: string;
  readonly reason: string;
  /** The backend said its storage refusal was a full disk (round 3f): an
   * additive `storage: "full"` beside `detail`, read from the answer, never
   * from its words. The one cause a person can fix (GM). */
  readonly storageFull: boolean;
  /** Which of the project store's limits a 413 hit (the backend's additive
   * `limit` beside `detail`): 'projects' (how many there may be) or
   * 'storage' (how big the catalog may grow); null when it was the request
   * itself that was too large. Read from the answer, never its words (Q116 a). */
  readonly storageLimit: StorageLimit | null;
  /** The answer's structured reason beside `detail`, when it has one (the
   * person gate's `code`: 'person_required' when this tab isn't connected as
   * the person, which reconnecting fixes). Null otherwise. */
  readonly code: string | null;
  /** A 413 for the project's own size (Q118: the backend's `limit: "size"`,
   * with the `sizeBytes` it measured): the canvas pauses saving instead of
   * failing. storageLimit stays null for it, as for any too-large request. */
  readonly overSaveLimit: boolean;
  readonly sizeBytes: number | null;

  constructor(heading: string, status: number,
    options: { detail?: unknown; reason?: string; cause?: unknown; storageFull?: boolean;
      storageLimit?: StorageLimit | null; code?: string | null; overSaveLimit?: boolean; sizeBytes?: number | null } = {}) {
    const reason = copyForAnswer(status, options.detail, options.code ?? null, options.reason);
    super(oneLine({ heading, reason }), 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'RequestFailedError';
    this.status = status;
    this.detail = options.detail;
    this.heading = heading;
    this.reason = reason;
    this.storageFull = options.storageFull === true;
    this.storageLimit = options.storageLimit ?? null;
    this.code = options.code ?? null;
    this.overSaveLimit = options.overSaveLimit === true;
    this.sizeBytes = options.sizeBytes ?? null;
  }

  get kind(): FailureKind {
    return failureKind(this.status);
  }
}

/** The project store's limits a 413 can name (backend main._storage_error_body). */
export type StorageLimit = 'projects' | 'storage';

/** A refusal written in the browser, where no request was made (a check
 * the store makes before sending: a run still going, a record that's gone).
 * Its words are copy, so failureCopy shows them like a request's (round 3b). */
export class FailureNotice extends Error {
  readonly heading: string;
  readonly reason: string;
  /** A whole written line that reads on its own (writtenLine): failureCopy
   * puts no heading over it, whatever heading the catch passes. */
  readonly standalone: boolean;

  constructor(heading: string, reason: string, options: { standalone?: boolean } = {}) {
    super(oneLine({ heading, reason }));
    this.name = 'FailureNotice';
    this.heading = heading;
    this.reason = reason;
    this.standalone = options.standalone === true;
  }
}

/** A step written in the browser that says it all on its own ("The project
 * didn't open. Try again.", "This proposal is no longer waiting for you."):
 * thrown as this, a catch's failureMessage shows it word for word instead of
 * GM's general line, and never puts its own heading over it (round 3e). */
export function writtenLine(line: string): FailureNotice {
  return new FailureNotice('', line, { standalone: true });
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

/** The line for an answer read by hand (a caller with no RequestFailedError):
 * classified by the answer's `code` first, so a person-only refusal says GM's
 * line 3 (personRequiredCopy) whatever its words (Q116 a), and otherwise as
 * copyForStatus says, or the caller's own `reason`. A person-only refusal
 * is a 4xx: a 5xx or no answer keeps GM's line for those. */
export function copyForAnswer(status: number, detail: unknown, code: string | null, reason?: string): string {
  if (code === PERSON_REQUIRED_CODE && failureKind(status) === 'refused') return personRequiredCopy();
  return reason ?? copyForStatus(status, detail);
}

/** The text a surface keeps behind its collapsed Details toggle
 * (components/failure/ErrorDetails) under a line that replaced it: a
 * person-only refusal's own words, written for agents (GM, Q116 a: "The
 * agents' text stays behind Details."). Null for anything else, and for a
 * refusal with no words of its own. */
export function failureDetails(error: unknown): string | null {
  if (!(error instanceof RequestFailedError) || !isPersonRequiredCopy(error.reason)) return null;
  if (error.code !== PERSON_REQUIRED_CODE) return null;
  const text = detailText(error.detail);
  return text && text !== error.reason ? text : null;
}

/** The line for a thrown error that isn't a request's answer: the
 * connection line when fetch got no answer, else GM's general line, never
 * the error's own message. */
export function copyForError(error: unknown, signal?: AbortSignal | null): string {
  return isConnectionFailure(error, signal) ? CONNECTION_LOST_COPY : REFUSED_FALLBACK_COPY;
}

/** An answer's `detail`, read from a JSON body; undefined when there is none. */
export async function readDetail(response: Response): Promise<unknown> {
  return (await readFailureBody(response)).detail;
}

/** An answer's `detail` and `code` (the person gate's, when it has one), from
 * one read of its body, for a caller that words the failure itself
 * (copyForAnswer). */
export async function readRefusal(response: Response): Promise<{ detail: unknown; code: string | null }> {
  const { detail, code } = await readFailureBody(response);
  return { detail, code };
}

/** An answer's `detail`, and whether it says the disk is full (the backend's
 * storage refusal, main._storage_error_body), from one read of its body. */
interface FailureBody {
  detail: unknown; storageFull: boolean; storageLimit: StorageLimit | null; code: string | null;
  overSaveLimit: boolean; sizeBytes: number | null;
}
async function readFailureBody(response: Response): Promise<FailureBody> {
  try {
    const body = await response.json() as {
      detail?: unknown; storage?: unknown; limit?: unknown; code?: unknown; sizeBytes?: unknown;
    } | null;
    const limit = body?.limit === 'projects' || body?.limit === 'storage' ? body.limit : null;
    const code = typeof body?.code === 'string' ? body.code : null;
    const overSaveLimit = response.status === 413 && body?.limit === 'size';
    const sizeBytes = overSaveLimit && typeof body?.sizeBytes === 'number' && Number.isFinite(body.sizeBytes) ? body.sizeBytes : null;
    return { detail: body?.detail, storageFull: body?.storage === 'full', storageLimit: limit, code, overSaveLimit, sizeBytes };
  } catch {
    return { detail: undefined, storageFull: false, storageLimit: null, code: null, overSaveLimit: false, sizeBytes: null };
  }
}

/** A failed request names its action: a ConnectionLostError (no answer)
 * gets `heading`; anything else (the caller's own abort, an error that
 * already has its heading) comes back as it was. */
export function withHeading(error: unknown, heading: string): unknown {
  return error instanceof ConnectionLostError && !error.heading ? error.withHeading(heading) : error;
}

function partsOf(error: unknown): FailureCopy | null {
  if (error instanceof ConnectionLostError || error instanceof RequestFailedError || error instanceof FailureNotice) {
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
  const standalone = error instanceof FailureNotice && error.standalone;
  const heading = standalone ? '' : parts.heading || options.heading || '';
  return { heading, reason: options.short ? shortReason(parts.reason) : parts.reason };
}

/** The one-line form of failureCopy, for a catch that has its own heading. */
export function failureMessage(error: unknown, heading: string): string {
  return oneLine(failureCopy(error, { heading }));
}

/** The one-line form under the caller's own heading, whatever heading the
 * error carried: for an action whose request names a smaller step (Import
 * CLI graph reads the canvas: "Couldn't import the CLI graph." over the
 * reason, not "Couldn't load the canvas."). Round 3e. */
export function failureUnder(error: unknown, heading: string): string {
  return oneLine({ heading, reason: failureCopy(error).reason });
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
  const body: FailureBody = 'detail' in options
    ? { detail: options.detail, storageFull: false, storageLimit: null, code: null, overSaveLimit: false, sizeBytes: null }
    : await readFailureBody(response);
  warnFailure(heading, response.status, body.detail);
  return new RequestFailedError(heading, response.status, { detail: body.detail, reason: options.reason,
    storageFull: body.storageFull, storageLimit: body.storageLimit, code: body.code,
    overSaveLimit: body.overSaveLimit, sizeBytes: body.sizeBytes });
}
