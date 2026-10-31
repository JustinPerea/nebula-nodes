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

import { isOfflineRefusal } from './backendConnection';
import { OFFLINE_VERBS, reconnectsLine } from './useBackendOffline';
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
export const PERSON_REQUIRED_COPY = "This change needs your OK, and this tab isn’t connected as you. "
  + 'Open the link Nebula printed when it started, then try again.';
/** GM - Design, 2026-10-23 (round 2), verbatim: line 3 in the desktop app. A
 * quit and reopen gives the app a fresh backend and a fresh person token. */
export const PERSON_REQUIRED_APP_COPY = "This change needs your OK, and this window isn’t connected as you. "
  + 'Quit Nebula and open it again, then try again.';

/** GM - Design, 2026-10-23 (round 3), verbatim: line 3 in the app's two
 * developer setups (a debug port, the dev renderer), where the banner already
 * gives the real fix. */
export const PERSON_REQUIRED_DEV_COPY = "This change needs your OK, and this window isn’t connected as you. "
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
/** GM - Design, round 16 of PR #114: the one line for "no answer" wherever
 * #114 owns it (Settings never loaded, Create's cluster), whole even beside
 * Try again. */
export const NEBULA_NOT_ANSWERING_COPY = "Nebula isn't answering. Make sure it's running, then try again.";
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

/** How a line of its own opens: every form the backend's and the browser's
 * person lines use (review 5, N5): "Couldn't …", "Can't …", "Cannot …",
 * "Nebula couldn't …", "Nebula can't …". Group 1 is the verb. */
const FAILURE_LEAD = /^(?:Nebula (?:couldn['’]t|can['’]t|cannot)|Couldn['’]t|Can['’]t|Cannot) (\w+)/;

/** A reason that is a line of its own: it says what failed itself
 * ("Couldn't delete “Agent scene”. “Shot 2” is still running. …", "Nebula
 * can't read that file type. …", "Cannot clear the canvas while a run is
 * active. …"). A tail that only says why or what to do ("Stop the run
 * first.", "Wait for it to finish.", "Nebula didn't respond.") is not. */
export function isNamedLine(text: string): boolean {
  return FAILURE_LEAD.test(text.trim());
}

const failedVerb = (text: string) => FAILURE_LEAD.exec(text.trim())?.[1].toLowerCase() ?? null;

/** A line's opening sentence in one spelling, for comparing: "Cannot clear
 * the canvas while …" and "Nebula can't clear …" read as "Couldn't clear …". */
const sameFailureForm = (text: string) => text.trim()
  .replace(/^(?:Nebula (?:couldn['’]t|can['’]t|cannot)|Couldn['’]t|Can['’]t|Cannot) /, "Couldn't ");

/** What a generic heading may say after its verb: a stand-in for what failed
 * that names nothing ("the node", "3 nodes", "the change"), or nothing at
 * all ("Couldn't undo."). From the call sites: deletionHeading, runLockedLine,
 * the scene and edit saves, Undo and Redo (graphStore, lib/cinemaScene). */
const STAND_IN = /^(?:|the node|the nodes|\d+ nodes|them|it|that|the scene|the shot|the change|the changes|your changes|your edits)$/;
/** paramSaveFailedLine's headings (graphStore): the save of a node's
 * settings, which names the setting but not the part of it a refusal names
 * ("Couldn't save “Scene” for “Opening”.", "Couldn't save 3 settings for
 * “Opening”.", "Couldn't save a setting on “Opening”."). */
const SETTING_SAVE = /^Couldn['’]t save (?:“[^”]*”(?: and “[^”]*”)?|\d+ settings) for “[^”]*”\.$|^Couldn['’]t save a setting on “[^”]*”\.$/;

/** A heading that only restates the action and names nothing a reason could
 * add to: "Couldn't delete the node.", "Couldn't delete 3 nodes.",
 * "Couldn't save the scene.", "Couldn't undo.", a setting's save line. A
 * heading that names what failed ("Couldn't run the graph.", "Couldn't save
 * the project.", "Couldn't delete “Brief”.") is not generic. */
export function isGenericHeading(heading: string): boolean {
  const text = heading.trim();
  if (SETTING_SAVE.test(text)) return true;
  const match = /^Couldn['’]t (\w+)(?: (.*?))?\.$/.exec(text);
  return match !== null && STAND_IN.test(match[2] ?? '');
}

/**
 * GM, PR #198 r5 item 3 and r7 ("A specific line replaces the generic one,
 * never both"); review 5, L4. `heading` then `reason`, except that the
 * reason shows alone when it is a line of its own (isNamedLine) that says
 * the heading's failure itself:
 * 1. The reason repeats the heading ("Couldn't stop the reply." over
 *    "Couldn't stop the reply. The agent isn't answering."; "Couldn't clear
 *    the canvas." over "Cannot clear the canvas while a run is active. …").
 * 2. The heading is generic (isGenericHeading: decided by its role, from an
 *    explicit list of the stand-ins the call sites use, never by curly
 *    quotes) and the reason is the same failure, named: the same verb
 *    ("Couldn't delete 3 nodes." over "Couldn't delete “Agent scene”. …"),
 *    or, under a generic save, a line that names the part it refused (a
 *    “…” name in its first sentence: "Couldn't save “Scene” for “Opening”."
 *    over "Couldn’t remove “Shot 2”. It’s still running. …"; the save
 *    carried the removal).
 * Otherwise both. A heading that names a thing keeps its place over a
 * reason that names another, whatever the verbs: "Couldn't run the graph.
 * Couldn't reach the provider. …", "Couldn't save the project. Couldn't
 * upload hero.png.", and the same verb for another object, "Couldn't
 * delete “Brief”. Couldn't delete “Agent scene”. …" (two failures).
 *
 * Why a predicate, not an option the caller passes: the rule has to hold
 * where no caller is in reach (a RequestFailedError's own `message`, every
 * oneLine and failureMessage), and the generic headings are few and come
 * from a handful of builders, so one list covers them all.
 */
export function headedLine(heading: string, reason: string): string {
  if (!reason) return heading;
  if (!heading) return reason;
  if (isNamedLine(reason) && (repeatsHeading(heading, reason) || specifiesGeneric(heading, reason))) return reason;
  return `${heading} ${reason}`;
}

/** Rule 1: the reason's first sentence opens with the heading's sentence. */
function repeatsHeading(heading: string, reason: string): boolean {
  const stem = sameFailureForm(heading).replace(/\.$/, '');
  const said = sameFailureForm(reason);
  return said.startsWith(stem) && /^[\s.,:]|^$/.test(said.slice(stem.length));
}

/** Rule 2: a generic heading over the same failure, named. */
function specifiesGeneric(heading: string, reason: string): boolean {
  if (!isGenericHeading(heading)) return false;
  const verb = failedVerb(heading);
  if (verb !== null && verb === failedVerb(reason)) return true;
  const firstSentence = /^(?:[^.“]|“[^”]*”)*\./.exec(reason.trim())?.[0] ?? reason;
  return verb === 'save' && /“[^”]+”/.test(firstSentence);
}

/** The one-line form, for alerts, toasts, tooltips and status text (GM:
 * "Couldn't {verb} {object}. {reason}" in one string; headedLine). */
export function oneLine(copy: FailureCopy): string {
  return headedLine(copy.heading, copy.reason);
}

/**
 * A request that got no answer, as apiFetch and fetchUrl throw it. Still a
 * TypeError (as fetch's own is); but a TypeError is not one of these, and
 * only this class means no answer downstream (isNoAnswer). Its message is
 * the line to show, and `cause` is the browser's own error. `withHeading`
 * names the action once the caller knows it.
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
 *
 * Only for fetch's own rejection, at the call: any other code can throw a
 * TypeError too (JSON.stringify of a BigInt, a property of undefined, a bad
 * argument to a DOM API). fetchUrl (lib/backend.ts, and so apiFetch) applies
 * it and throws a ConnectionLostError; the Response it hands out classifies
 * its own body reads the same way (typeerror2). Everything downstream asks
 * isNoAnswer (typeerror, 2026-10-24).
 */
export function isConnectionFailure(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false;
  return error instanceof TypeError || isAbort(error);
}

/**
 * Whether an error caught anywhere downstream of a request means there was
 * no answer: a ConnectionLostError (fetch's no-answer, classified where
 * fetch was called), or an AbortError the caller didn't ask for. Never a
 * TypeError as such: a bug or a data problem in the browser is a TypeError
 * too, and "Nebula's server isn't answering" would send the person to the
 * wrong fix. The caller's own abort (`signal` aborted) is not either.
 */
export function isNoAnswer(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false;
  return error instanceof ConnectionLostError || isAbort(error);
}

/** A gateway's "couldn't reach the server behind me": the Vite dev proxy
 * answers 502 for a backend that isn't there; 503 and 504 are the same from
 * any other proxy in front of it. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Whether Nebula's backend itself is unreachable, from the error's kind and
 * status, never its words (typeerror2, 2026-10-24): no answer at all
 * (isNoAnswer), or a gateway status with no reason of the backend's (the
 * backend's own 503 always carries a written `detail`). A refusal whose
 * reason says "network" is the backend answering.
 */
export function isBackendUnreachable(error: unknown, signal?: AbortSignal | null): boolean {
  if (isNoAnswer(error, signal)) return true;
  return error instanceof RequestFailedError && GATEWAY_STATUSES.has(error.status) && !detailText(error.detail);
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
 * connection line when a request got no answer (isNoAnswer: a
 * ConnectionLostError, never any TypeError), else GM's general line, never
 * the error's own message. */
export function copyForError(error: unknown, signal?: AbortSignal | null): string {
  if (isOfflineRefusal(error)) return '';
  return isNoAnswer(error, signal) ? CONNECTION_LOST_COPY : REFUSED_FALLBACK_COPY;
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
  // A write refused while offline (round 15 of PR #114) says nothing: the
  // banner already pulsed. Every one-line form below is empty for it too.
  if (isOfflineRefusal(error)) return { heading: '', reason: '' };
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
  if (isOfflineRefusal(error)) return '';
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

/** The shared rule's line: up to 3 things are named, from 4 they are
 * counted. Every list of names in a line reads it (nodeNameList,
 * agentNameList, quotedNames), and so do the proposal bar's not-ready lines
 * (canvasProposals.notReadyShown), so 4 is never "3 and 1 more". */
export const NAMED_AT_MOST = 3;
export function countsInstead(count: number): boolean {
  return count > NAMED_AT_MOST;
}

/**
 * A list of node names in a line (GM - Design, 2026-10-27, r6 of PR #198 and
 * the follow-up to PR #195), shared by every line that names several nodes:
 * the failed-save lines (lib/savingCutOff), the multi-delete toasts
 * (lib/deleteCopy) and the "+ unpriced" tooltip.
 * - Up to 3 nodes by name: "“A”", "“A” and “B”", "“A”, “B” and “C”".
 * - Nodes with the same title are grouped with a count, never repeated:
 *   "2 “Text” nodes"; a mix, "“Brief” and 2 “Text” nodes".
 * - The rule counts nodes, not groups: from 4 nodes in total, "4 nodes".
 * - No node ids: the Agent log keeps those.
 * Groups keep the order their first node came in; callers give names in
 * canvas order (GM, PR #200 answer 3: "2 “Text” nodes and “Brief”" is fine).
 * The one helper for this rule (PR #198 merged with #195 and #200): the
 * run-lock and multi-delete lines (lib/cinemaScene), the deleted notice, the
 * "+ unpriced" tooltip (lib/runScope), the no-answer and server-error delete
 * lines (lib/deleteCopy), and the placeholder dialog's moved-rows and replay
 * lines (lib/placeholderRunConfirm).
 */
export function nodeNameList(names: string[]): string {
  if (countsInstead(names.length)) return `${names.length} nodes`;
  const groups = new Map<string, number>();
  for (const name of names) groups.set(name, (groups.get(name) ?? 0) + 1);
  return joinedList([...groups].map(([name, count]) => (count === 1 ? `“${name}”` : `${count} “${name}” nodes`)));
}

/**
 * Agents by name in a line, by nodeNameList's rule (GM, PR #202 r2: "names
 * via the shared name-list helper, 4+ agents → a count"): up to 3 by name,
 * "Codex", "Codex and Claude Code", "Codex, Claude Code and Cursor"; from 4,
 * "4 agents". Each agent once. Unquoted: an agent's name is never quoted
 * where Nebula names who did something (the Agent log, the Updates corner).
 */
export function agentNameList(names: string[]): string {
  const agents = [...new Set(names)];
  if (countsInstead(agents.length)) return `${agents.length} agents`;
  return joinedList(agents);
}

/** "A", "A and B", "A, B and C": the lists' shared join. */
function joinedList(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The same rule for things that aren't nodes and whose names are their
 * own (shots): up to 3 quoted names, from 4 a count ("4 shots"). */
export function quotedNames(names: readonly string[], counted: string): string {
  if (countsInstead(names.length)) return `${names.length} ${counted}`;
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** Whether a nodeNameList names more than one node ("have" / "has"). */
export function namesSeveral(names: string[]): boolean {
  return names.length > 1;
}

/**
 * GM - Design, PR #200 answer 1 (2026-10-27), verbatim: the tooltip of a
 * control that is disabled because Nebula is offline. "You can <verb> when
 * Nebula reconnects." (e.g. "You can generate when Nebula reconnects."); no
 * verb, "This works again when Nebula reconnects.". The same line as PR
 * #198's offlineReason (lib/useBackendOffline): both now build it in one
 * place (reconnectsLine), so the two can't drift.
 */
export function offlineDisabledReason(verb?: string): string {
  return reconnectsLine(verb);
}

/** Run history's replay verbs offline (fix round 3 of PR #200, review 3
 * LOW-1). Rerun is GM's (r4 answer 2: "You can rerun it when Nebula
 * reconnects."); Retry and Recover follow it ("You can retry it …", "You can
 * recover it …", approved in GM's round 3 answers). The same strings as
 * OFFLINE_VERBS (lib/useBackendOffline). */
export const OFFLINE_RERUN = OFFLINE_VERBS.rerun;
export const OFFLINE_RETRY = OFFLINE_VERBS.retry;
export const OFFLINE_RECOVER = OFFLINE_VERBS.recover;
