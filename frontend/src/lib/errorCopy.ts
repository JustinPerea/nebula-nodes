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
import { inDesktopShell, isBeforePromote, personGateHeld, personPromotions, personUnavailableReason, sentUnderPromote } from './personSession';

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
/** The dev setups' ending: the line defers to the general notice for the fix (lib/notConnectedLine). */
export const DEFERS_TO_NOTICE = 'The notice below says why.';
export const PERSON_REQUIRED_DEV_COPY = "This change needs your OK, and this window isn’t connected as you. "
  + DEFERS_TO_NOTICE;

/** PR #204 round 10 (GM r16 Q2): the one word every lock line uses for where this page runs:
 * "window" in the desktop app, "tab" in a browser. */
export function lockPlace(desktop: boolean = inDesktopShell()): 'window' | 'tab' {
  return desktop ? 'window' : 'tab';
}

/** PR #204 round 10 (GM r15): a control whose route is the person's alone, while this tab isn't
 * connected as them: "You can <verb> when this tab is connected as you." Every lock line comes
 * from here (components/PersonLock.tsx and the held cards), so the word is the same everywhere. */
export function personLockLine(verb: string, desktop: boolean = inDesktopShell()): string {
  return `You can ${verb} when this ${lockPlace(desktop)} is connected as you.`;
}

/** GM r14 (5), PR #204 round 9: Settings' Connect (and Create token) while this tab isn't connected
 * as the person. The server refuses it (POST /api/agent/spend/apps: require_person). */
export function connectAgentLockCopy(desktop: boolean = inDesktopShell()): string {
  return personLockLine('connect an agent', desktop);
}

/** Line 3 for where this page runs: `desktop` is personSession's
 * inDesktopShell() (the preload bridge), the flag the rest of the error copy
 * reads (commonsSessionCopy); `reason` is the shell's own, when it gave one. */
export function personRequiredCopy(desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  if (!desktop) return PERSON_REQUIRED_COPY;
  return reason === 'debug-port' || reason === 'dev-renderer' ? PERSON_REQUIRED_DEV_COPY : PERSON_REQUIRED_APP_COPY;
}

/** GM, PR #204 round 3 ruling item 3 (2026-10-30), verbatim for a tab: the line when
 * opening the Updates couldn't mark them read because this tab isn't the person's. No
 * "then try again": the promote retries it (lib/clearsOnPromote retryOnPromote). The
 * desktop app's two forms follow personSession's banners for a window. */
// One sentence pair each, written whole (a reason, not a heading joined to one).
export const MARK_READ_REFUSED_COPY =
  'Nebula couldn’t mark the updates as read because this tab isn’t connected as you. Open the link Nebula printed when it started.';
export const MARK_READ_REFUSED_APP_COPY =
  'Nebula couldn’t mark the updates as read because this window isn’t connected as you. Quit Nebula and open it again.';
export const MARK_READ_REFUSED_DEV_COPY =
  'Nebula couldn’t mark the updates as read because this window isn’t connected as you. The notice below says why.';

/**
 * GM, PR #204 r6 (2026-10-30), the rule for the shared line: "a 'not connected' refusal of
 * anything that retries on promote uses this 'because' form, with no 'then try again' and
 * no 'This change needs your OK'. Keep the r2 generic line only for one-shot actions that
 * can't retry." `what` is what Nebula was doing ("save the style", "load your work"). Every
 * caller registered with retryOnPromote words its line through this (the ratchet checks).
 * The desktop app's two forms follow personSession's banners for a window, as mark-read's.
 */
export function notConnectedBecause(what: string, desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  if (!desktop) return `Nebula couldn’t ${what} because this tab isn’t connected as you. Open the link Nebula printed when it started.`;
  const fix = reason === 'debug-port' || reason === 'dev-renderer' ? DEFERS_TO_NOTICE : 'Quit Nebula and open it again.';
  return `Nebula couldn’t ${what} because this window isn’t connected as you. ${fix}`;
}

/**
 * GM r24 c (PR #204 round 15): a load Nebula answered with no reason (a 5xx, 408 or 429:
 * NO_RESPONSE_COPY's case), as one sentence with Nebula the subject, verbatim for the references:
 * "Nebula couldn’t load the references because the server didn’t respond. Try again." `what` is what
 * Nebula was doing, as notConnectedBecause's.
 */
export function noResponseBecause(what: string): string {
  return `Nebula couldn’t ${what} because ${NO_RESPONSE_CLAUSE}`;
}

/** GM r31 (PR #204 round 18d): the server is the subject of every reason. 408 and a gateway's
 * 502-504: no answer in time. */
const NO_RESPONSE_CLAUSE = 'the server didn’t respond. Try again.';
/** GM r31: a rate limit (429) has its own line. */
const SERVER_BUSY_CLAUSE = 'the server is busy. Try again in a moment.';

/**
 * PR #204 round 18b (GM r29 1) and 18c (GM r30, the wording batch): a load's failure, as the
 * clause after "because". A load that failed destroys nothing, so every reason says it in the
 * because form with Nebula the subject: "Nebula couldn’t load this reference because it isn’t
 * there anymore. Reload to get the latest references." "Try again." only where trying again can
 * help. No backend message ever shows to the person as it is: a reason not listed here says the
 * 4xx line (LOAD_NOT_ACCEPTED), and its raw text goes to the console.
 */
export const LOAD_BECAUSE: ReadonlyMap<string, string> = new Map([
  // The reference detail's 404 (backend refusal_copy.gone, GM error-copy round 3).
  ["That reference isn't there anymore. Reload to get the latest references.",
    'it isn’t there anymore. Reload to get the latest references.'],
  // A labeling image's position that isn't in the set (backend evaluation.REFERENCE_GONE).
  ["That reference isn't in this held-out set. Reload to get the latest references.",
    'it isn’t in this held-out set. Reload to get the latest references.'],
  // The references' search with filters the backend can't read (backend person_copy.BAD_FILTERS).
  ["Those filters didn't work. Clear them and try again.", 'those filters didn’t work. Clear them and try again.'],
  // GM r30: a reference's image or video the blob route can't find (backend routes/commons get_blob).
  ['not found', 'the file isn’t there anymore.'],
  // GM r30: the UI session's 401s (backend commons/actors.py resolve_actor).
  ['invalid UI session token', 'this window’s session ended. Reload to sign in again.'],
  ['no UI session: open Nebula from the desktop app or use the dev link', 'this window’s session ended. Reload to sign in again.'],
  // GM r30: a route only the person's own window may call (backend routes/commons human_dep).
  ['only the human UI session can do this', 'this window isn’t signed in as you. Reload to sign in again.'],
]);
/** 401 or 403 with no reason (GM's line, kept by GM r30). */
const ACCESS_LOST_CLAUSE = 'you don’t have access to this anymore. Reload to sign in again.';
/** GM r30 3: a server error (500) isn't "didn't respond". GM r31: "the server", not "Nebula's server". */
const SERVER_ERROR_CLAUSE = 'the server hit an error. Try again.';
/** GM r30: no answer at all (GM r31's wording). */
const NOT_ANSWERING_CLAUSE = 'the server isn’t answering. Check that Nebula is running, then try again.';
/** GM r30: a 4xx with no readable reason, and any reason not listed above (GM r31's wording). */
export const LOAD_NOT_ACCEPTED = 'the server didn’t accept it. Try again.';
/** The backend's answer when it runs without the Commons (backend commons/activation, routes/commons
 * activation_dep), and GM r30's page line for it. The Commons is on only when the backend starts
 * with NEBULA_COMMONS_ENABLED=1: no setting turns it on, so the line names none. */
export const COMMONS_OFF_DETAIL = 'Commons is disabled';
export const COMMONS_OFF_COPY = 'Commons is turned off for this Nebula.';

/** A load's failure line: `what` is what Nebula was doing ("load the references"). Empty when
 * the failure says nothing (a request refused offline). A refusal because this tab isn't
 * connected as you is the caller's (notConnectedBecause). */
export function loadFailedLine(what: string, error: unknown): string {
  const clause = loadFailedClause(what, error);
  if (clause === null) return '';
  return clause === COMMONS_OFF_COPY ? COMMONS_OFF_COPY : `Nebula couldn’t ${what} because ${clause}`;
}

/** The clause after "because" for a load's failure (loadFailedLine), COMMONS_OFF_COPY for the
 * Commons turned off, or null when the failure says nothing (a request refused offline). */
function loadFailedClause(what: string, error: unknown, because: ReadonlyMap<string, string> = LOAD_BECAUSE): string | null {
  const { reason } = failureCopy(error);
  if (!reason) return null;
  const status = error instanceof RequestFailedError ? error.status : null;
  if (isNoAnswer(error) || status === NO_ANSWER_STATUS) return NOT_ANSWERING_CLAUSE;
  const detail = error instanceof RequestFailedError ? detailText(error.detail) : '';
  if (isCommonsOff(error)) return COMMONS_OFF_COPY;
  if (status !== null && failureKind(status) === 'no-response') {
    // GM r31: 429 is busy; 408 and a gateway's 502-504 didn't respond; the server's own 5xx is an error.
    if (status === 429) return SERVER_BUSY_CLAUSE;
    return status >= 500 && !GATEWAY_STATUSES.has(status) ? SERVER_ERROR_CLAUSE : NO_RESPONSE_CLAUSE;
  }
  const clause = because.get(detail) ?? (reason === ACCESS_LOST_COPY ? ACCESS_LOST_CLAUSE : undefined);
  if (clause) return clause;
  if (detail) console.warn(`[nebula] Couldn’t ${what}: the backend said "${detail}" (not shown).`);
  return LOAD_NOT_ACCEPTED;
}

/**
 * PR #204 round 18j (GM r40), round 18k (GM r41, verbatim): closing the held-out batch failed.
 * Nothing was lost, so the line is neutral, in the because form with Nebula the subject, with
 * curly apostrophes, and never the server's own words (those go to the console). The 409s are
 * the close's own refusals (backend commons/evaluation close), read by their words.
 */
export const CLOSE_BECAUSE: ReadonlyMap<string, string> = new Map([
  // An agent grade was still running.
  ['A grading attempt is still running. Close after it finishes.',
    'a grade is still running. Close the batch again when it finishes.'],
  // Sealed in another window meanwhile.
  ["These labels are sealed as blind ground truth, so there's nothing to close.",
    'its labels were already sealed as blind ground truth. Reload to see them.'],
  // The batch changed somewhere else (a stale revision).
  ['Labels changed in another window. Reload before saving.',
    'it changed somewhere else. Reload, then close the batch again.'],
  // The batch was cleared meanwhile.
  ["There's no held-out set yet. Prepare a folder first.",
    'its held-out set no longer exists. Reload to get the latest references.'],
  // The integrity check (backend evaluation.INTEGRITY).
  ["The held-out set doesn't match what was saved, so Nebula stopped and changed nothing.",
    'the held-out set doesn’t match what was saved. Nothing was changed. Reload to check it again.'],
]);
/** The 409 a grade still running gives (CLOSE_BECAUSE's first): the close waits for it. */
export const CLOSE_GRADE_RUNNING = 'Nebula couldn’t close the batch because a grade is still running. Close the batch again when it finishes.';
/** GM r43 Q1: the close's 30 s ran out and the batch, read again, isn't closed (GM's no-answer line). */
export const CLOSE_NO_RESPONSE = 'Nebula couldn’t close the batch because the server didn’t respond. Try again.';
/** GM r41: the Commons turned off. */
export const CLOSE_COMMONS_OFF = 'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to close this batch.';

/**
 * PR #204 round 18k (GM r41): a failed close's line, in either pane (CommonsCloseBatch). Empty
 * when the failure says nothing (offline: the offline row says it).
 * - 401, and any refusal because this tab isn't the person's (lib/commonsApi sessionLost), split
 *   on the tab's held state, not the status (round 18l, GM r42): a held tab (the person is signed
 *   in, in another tab) "this tab isn’t connected as you. Open the link Nebula printed when it
 *   started."; otherwise "you’re signed out. Open the link Nebula printed when it started."
 * - 403: the close route's only 403s are an origin or a token problem (services/local_guard's
 *   Host or Origin refusal; routes/commons human_dep, a request without the person's token):
 *   "this sign-in isn’t allowed to do that. Open the link Nebula printed when it started."
 */
export function closeBatchFailedLine(error: unknown, held: boolean = personGateHeld()): string {
  const lead = 'Nebula couldn’t close the batch because';
  const { reason } = failureCopy(error);
  if (!reason) return '';
  const status = error instanceof RequestFailedError ? error.status : null;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === PERSON_REQUIRED_CODE || status === 401) {
    return held ? `${lead} this tab isn’t connected as you. Open the link Nebula printed when it started.`
      : `${lead} you’re signed out. Open the link Nebula printed when it started.`;
  }
  if (isNoAnswer(error) || status === NO_ANSWER_STATUS) return `${lead} the server isn’t answering. Try again.`;
  if (isCommonsOff(error)) return CLOSE_COMMONS_OFF;
  if (status === 403) return `${lead} this sign-in isn’t allowed to do that. Open the link Nebula printed when it started.`;
  if (status !== null && failureKind(status) === 'no-response') {
    if (status === 429) return `${lead} ${SERVER_BUSY_CLAUSE}`;
    return `${lead} ${status >= 500 && !GATEWAY_STATUSES.has(status) ? SERVER_ERROR_CLAUSE : NO_RESPONSE_CLAUSE}`;
  }
  const detail = error instanceof RequestFailedError ? detailText(error.detail) : '';
  const clause = status === 409 ? CLOSE_BECAUSE.get(detail) : undefined;
  if (clause) return `${lead} ${clause}`;
  if (detail) console.warn(`[nebula] Couldn’t close the batch: the backend said "${detail}" (not shown).`);
  // Round 18l (review 17 logic NIT-1): an exception from Nebula's own code (not a request's
  // answer) keeps the request line, which still says what to do, and goes to the console as the
  // bug it is; how the app words its own failures is the app-wide failure-copy PR's.
  if (!(error instanceof RequestFailedError)) console.error('[nebula] Closing the batch failed in Nebula itself:', error);
  return `${lead} the server didn’t accept the request. Try again.`;
}

/** PR #204 round 18j (GM r40): a failure said in the because form (a load's or an action's), or
 * the Commons turned off (round 18k): it destroyed nothing, so its line is neutral
 * (CommonsErrorLine). */
export function isBecauseFailure(text: string): boolean {
  return /^(?:Saved\. )?Nebula couldn’t |^Commons is turned off because /.test(text);
}

/** GM r41: the close's line says to try again (the close button beside it is the retry), or
 * names another step (Reload, open the link, wait, restart), and then the close button is
 * aria-disabled with the line as its reason. */
export function closeLineRetries(line: string): boolean {
  return /(?:^|\s)Try again(?: in a moment)?\.$/.test(line);
}

/** Whether a Commons call was refused because the backend runs without the Commons (its 404
 * "Commons is disabled", whatever the call). */
export function isCommonsOff(error: unknown): boolean {
  return error instanceof RequestFailedError && error.status === 404 && detailText(error.detail) === COMMONS_OFF_DETAIL;
}

/**
 * PR #204 round 18d (GM r32 3): a load's cause alone, for a line that says its own next step
 * ("Saved. Nebula couldn’t load the settings back because {cause}. Reload to see them."): the
 * shared clause's first sentence, without its period or its own "Try again". Null when the
 * failure says nothing; COMMONS_OFF_COPY for the Commons turned off.
 */
export function loadFailedCause(what: string, error: unknown): string | null {
  const clause = loadFailedClause(what, error);
  if (clause === null || clause === COMMONS_OFF_COPY) return clause;
  return clause.replace(/\. .*$|\.$/, '');
}

/** PR #204 round 18d (GM r32 3), verbatim: a settings write landed, and reading it back failed for
 * `cause` (loadFailedCause). No "Try again": that would send the write again. */
export function savedReadBackLine(cause: string): string {
  return `Saved. Nebula couldn’t load the settings back because ${cause}. Reload to see them.`;
}

/** PR #204 round 18 (GM r28 1), widened in round 18b (GM r29 1): a load's failure line, whatever
 * its reason. Only a load says "Nebula couldn’t load …" or "Nebula couldn’t check …" (an
 * action's line says "Couldn’t save …"), and a load that failed destroys nothing, so it is drawn
 * neutral, as a because line is (components/commons/CommonsErrorLine, styles/becauseLine.css). */
export function isLoadLine(text: string): boolean {
  // Round 18d (GM r32 3): a read-back after a saved write is a load's line too (savedReadBackLine).
  return /^(?:Saved\. )?Nebula couldn’t (?:load|check) /.test(text) || text === COMMONS_OFF_COPY;
}

/** PR #204 round 18f (GM r35 4): the words before a load line's closing "Try again.", for the
 * "Try again" button that ends it (components/commons/CommonsErrorLine), or null when the line
 * isn't a load's or doesn't end so ("…then try again." asks to check Nebula first; "Try again in
 * a moment." asks to wait). The button keeps the sentence: "… Try again." reads the same. */
export function retryStem(line: string): string | null {
  if (!isLoadLine(line) || !line.endsWith(' Try again.')) return null;
  return line.slice(0, -' Try again.'.length);
}

/**
 * Generate refused only because this tab isn't the person's. Generate is one-shot (it never
 * retries on the promote).
 * - The cluster itself refused: GM r10 (3), verbatim for a tab, the r2 general words after
 *   "Its nodes weren’t added to the canvas."
 * - The cluster added and only the start refused: GM r13 (1), verbatim for a tab, the because
 *   form. The nodes are on the canvas, so it never says try again (a second Generate would add
 *   them again): the person runs them from the canvas. The desktop app's forms follow
 *   notConnectedBecause's (a window's fix; the dev setups defer to the notice).
 */
/** GM r12 (2), PR #204 round 9: every Generate line opens with this (curly apostrophe). */
export const GENERATE_HEADING = 'Nebula couldn’t start the generation.';
export const CLUSTER_NOT_ADDED = 'Its nodes weren’t added to the canvas.';

export function generateRefusedCopy(clusterAdded: boolean, desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  if (!clusterAdded) return `${GENERATE_HEADING} ${CLUSTER_NOT_ADDED} ${personRequiredCopy(desktop, reason)}`;
  const lead = `${ADDED_LEAD} because`;
  if (!desktop) return `${lead} this tab isn’t connected as you. ${thenRunFromCanvas('Open the link Nebula printed when it started.', true)}`;
  if (reason === 'debug-port' || reason === 'dev-renderer') return `${lead} this window isn’t connected as you. ${DEFERS_TO_NOTICE}`;
  return `${lead} this window isn’t connected as you. ${thenRunFromCanvas('Quit Nebula and open it again.', true)}`;
}

const ADDED_LEAD = 'Nebula added the nodes to the canvas but couldn’t start the generation';

/**
 * GM r16 Q3 (PR #204 round 10): Generate's nodes are on the canvas, so pressing Generate again
 * would add them twice. A fix that ends "try again" becomes "then run them from the canvas"; the
 * not-connected case (`always`) ends that way after its own fix too. One rule for both.
 */
export function thenRunFromCanvas(fix: string, always = false): string {
  const text = fix.trim();
  if (/^try again\.$/i.test(text)) return 'Run them from the canvas.';
  const tail = text.match(/^([\s\S]*?)(?:,|;)?\s+(?:and\s+|then\s+)?try again\.$/i);
  if (tail) {
    const before = tail[1].trimEnd();
    // "… respond. Try again." is its own sentence; "Wait a moment, then try again." isn't.
    return /[.!?]$/.test(before) ? `${before} Run them from the canvas.` : `${before}, then run them from the canvas.`;
  }
  if (always && text.endsWith('.')) return `${text.slice(0, -1)}, then run them from the canvas.`;
  return text;
}

/** GM r16 Q3: Generate's start failed for a reason other than this tab: the nodes are there. */
export function generateStartFailedCopy(error: unknown): string {
  const { reason } = failureCopy(error);
  return reason ? `${ADDED_LEAD}. ${thenRunFromCanvas(reason)}` : `${ADDED_LEAD}.`;
}

export function markReadRefusedCopy(desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  return notConnectedBecause('mark the updates as read', desktop, reason);
}

/** The "because" form's reason, whatever it was doing (GM r6; GM r13's "Nebula added … but
 * couldn’t … because"): a line of that shape. */
const NOT_CONNECTED_BECAUSE = /^Nebula (?:couldn’t|added .+ but couldn’t) .+ because this (?:tab|window) isn’t connected as you\. /;

const isPersonRequiredCopy = (line: string) =>
  line === PERSON_REQUIRED_COPY || line === PERSON_REQUIRED_APP_COPY || line === PERSON_REQUIRED_DEV_COPY;

/** Whether a written line carries GM's person-required reason (any of the three
 * forms, alone or after a heading): its only reason was this tab (lib/clearsOnPromote). */
export function saysPersonRequired(line: string): boolean {
  return line.includes(PERSON_REQUIRED_COPY) || line.includes(PERSON_REQUIRED_APP_COPY)
    || line.includes(PERSON_REQUIRED_DEV_COPY) || NOT_CONNECTED_BECAUSE.test(line);
}

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
/**
 * GM r12 (2), PR #204 round 9: the Commons with no person session. The person's session is one
 * per launch and never expires on its own (backend services/person_session.py; commons/actors.py
 * checks the Bearer against it). A request goes without it only because this tab (or window)
 * isn't connected as the person: it never had the link, or the backend restarted with a new
 * one. So it is the because form, a fix line, under the call's own words: "Couldn't load the
 * references." gives "Nebula couldn’t load the references because this tab isn’t connected as
 * you. Open the link Nebula printed when it started." A heading that isn't "Couldn't …"
 * (or none) gives the general words. Refused as a person refusal (code person_required), so
 * it is neutral, clears on the promote, and offers no Try again.
 */
export function commonsNotConnectedCopy(heading: string, desktop: boolean = inDesktopShell(),
  reason: string = personUnavailableReason()): string {
  const what = /^Couldn['’]t (.+)\.$/.exec(heading.trim())?.[1];
  return what ? notConnectedBecause(what, desktop, reason) : personRequiredCopy(desktop, reason);
}

/** The Commons' refusal with no person session to send: its line, the person gate's code, and
 * the promotes so far (so the line is a person refusal and clears on the next one). */
export function commonsNotConnected(heading: string): { message: string; code: string; sentAt: number } {
  return { message: commonsNotConnectedCopy(heading), code: PERSON_REQUIRED_CODE, sentAt: personPromotions() };
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
  /** The promote count its request was sent under (review 4 LOW-1, round 6; null: unknown). */
  readonly sentAt: number | null;
  /** The request was sent before the server's latest promote of this tab (review 3 LOW-1),
   * read against the promotes so far each time it is asked: its refusal is the old state's, so
   * its line clears at once (lib/clearsOnPromote). */
  get sentBeforePromote(): boolean {
    return isBeforePromote(this.sentAt);
  }

  constructor(heading: string, status: number,
    options: { detail?: unknown; reason?: string; cause?: unknown; storageFull?: boolean;
      storageLimit?: StorageLimit | null; code?: string | null; overSaveLimit?: boolean; sizeBytes?: number | null;
      sentAt?: number | null; sentBeforePromote?: boolean } = {}) {
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
    this.sentAt = sentAtOf(options);
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
  /** The refusal's `code` when the line came from one (`person_required`: clearsOnPromote
   * reads it, so a line refused only for this tab goes on the promote; PR #204 round 4). */
  readonly code: string | null;
  /** The promote count its request was sent under, as RequestFailedError's. */
  readonly sentAt: number | null;
  /** The request was sent before the server's latest promote of this tab (review 3 LOW-1),
   * read against the promotes so far each time it is asked: its refusal is the old state's, so
   * its line clears at once (lib/clearsOnPromote). */
  get sentBeforePromote(): boolean {
    return isBeforePromote(this.sentAt);
  }

  constructor(heading: string, reason: string,
    options: { standalone?: boolean; code?: string | null; sentAt?: number | null; sentBeforePromote?: boolean } = {}) {
    super(oneLine({ heading, reason }));
    this.name = 'FailureNotice';
    this.heading = heading;
    this.reason = reason;
    this.standalone = options.standalone === true;
    this.code = options.code ?? null;
    this.sentAt = sentAtOf(options);
  }
}

/** A person-gate refusal that came on a socket, not as a Response (the chat socket's error):
 * stamped with the promote count its message went out under, checked as apiFetch's are. */
export function personRefusalSentAt(sentAt: number | null): FailureNotice {
  return new FailureNotice('', personRequiredCopy(), { code: PERSON_REQUIRED_CODE, sentAt });
}

/** `sentAt` as given, or (an error built by hand) `sentBeforePromote: true` as before any promote. */
function sentAtOf(options: { sentAt?: number | null; sentBeforePromote?: boolean }): number | null {
  if (typeof options.sentAt === 'number') return options.sentAt;
  return options.sentBeforePromote === true ? -1 : null;
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
  // A person refusal says the person line; one written here already (the Commons' because form) keeps its words.
  if (code === PERSON_REQUIRED_CODE && failureKind(status) === 'refused') return reason !== undefined && saysPersonRequired(reason) ? reason : personRequiredCopy();
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
export async function readRefusal(response: Response): Promise<{ detail: unknown; code: string | null; sentAt: number | null; sentBeforePromote: boolean }> {
  const { detail, code } = await readFailureBody(response);
  const sentAt = sentUnderPromote(response);
  return { detail, code, sentAt, sentBeforePromote: isBeforePromote(sentAt) };
}

/** A read refusal as the error its line carries (review 5 LOW-4, round 7): the person gate's,
 * with this answer's own send-time stamp, or undefined for any other refusal. A line built
 * from the refusal's words hands this to notify, so it clears by its own stamp. */
export function refusalError(read: { code: string | null; sentAt: number | null }): FailureNotice | undefined {
  return read.code === PERSON_REQUIRED_CODE ? new FailureNotice('', personRequiredCopy(), { code: PERSON_REQUIRED_CODE, sentAt: read.sentAt }) : undefined;
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

/** What `failure` says, as FailureLines shows it: '' when it says nothing (a write refused while offline: the banner
 *  is its reason, failureCopy). A surface never shows a line or an alert for '' (#210 round 6t, GM r113 1). */
export function failureText(failure: FailureCopy | string | null | undefined, retry = false): string {
  if (!failure) return '';
  if (typeof failure === 'string') return failure.trim();
  const reason = retry ? shortReason(failure.reason) : failure.reason;
  return [failure.heading, reason].map((part) => part.trim()).filter(Boolean).join(' ');
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
    overSaveLimit: body.overSaveLimit, sizeBytes: body.sizeBytes, sentAt: sentUnderPromote(response) });
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
  if (names.length >= 4) return `${names.length} nodes`;
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
  if (agents.length >= 4) return `${agents.length} agents`;
  return joinedList(agents);
}

/** "A", "A and B", "A, B and C": the lists' shared join. */
function joinedList(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The same rule for things that aren't nodes and whose names are their
 * own (shots): up to 3 quoted names, from 4 a count ("4 shots"). */
export function quotedNames(names: readonly string[], counted: string): string {
  if (names.length >= 4) return `${names.length} ${counted}`;
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
