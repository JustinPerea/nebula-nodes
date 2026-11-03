import { RequestFailedError, isBackendUnreachable, isNoAnswer, type FailureCopy } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';

/**
 * GM r11 4, verbatim: a board's background send (the queued send of a board
 * New just saved, or an add that couldn't reach a board the person had left)
 * that Nebula refused while offline is sent again once on reconnect; if that
 * fails too, the board says "Nebula couldn’t save the board because {cause}.
 * Try again." and Try again (the toolbar's Retry) sends it again. The cause
 * is the shared clause, with the server as its subject (PR #204, GM r30 and
 * r31: busy for a 429, didn't respond for 408 and a gateway's 502-504, hit an
 * error for its own 5xx, isn't answering for no answer at all, didn't accept
 * it for any other refusal), without its own "Try again", which the line
 * says once at its end.
 */
export function boardNotSavedLine(error: unknown): FailureCopy {
  return { heading: '', reason: `${NOT_SAVED_OPENING}${boardSaveCause(error)}. Try again.` };
}

const NOT_SAVED_OPENING = 'Nebula couldn’t save the board because ';

/**
 * The line for a board write that failed with nothing lost (GM r12 1, r14):
 * a new board's create (New's save, its Retry, the autosave's, the save of an
 * unsaved board an add landed on) and the paste flow's background writes (the
 * queued send of a board New just saved, an add that couldn't reach a board
 * the person had left). The draft keeps all of it and Retry sends it again
 * (a create carries its id, so a Retry after a lost answer makes no second
 * board), so every cause gets boardNotSavedLine: neutral, the header chip
 * "Not saved", the header's Retry. It never says "create": after a lost
 * answer the server may have made the board.
 *
 * Kept out: a create refused for its id (`isCreateIdRefusal`). The draft's
 * id is one Nebula made, so this only happens if the id itself is broken;
 * sending the same id again fails the same way, so "Try again" would be
 * wrong. It says CREATE_ID_REFUSED_LINE in the error look, and the Studio
 * drops the id (its next create goes without one), so its Retry works.
 */
export function boardSaveFailure(error: unknown): FailureCopy {
  return isCreateIdRefusal(error) ? { heading: '', reason: CREATE_ID_REFUSED_LINE } : boardNotSavedLine(error);
}

/**
 * The red line for a create refused for its request id (round 6g, brief 7b):
 * the because form, no "Try again", ending with the step that works. The one
 * place it is written; the wording is a proposal waiting on GM's confirmation
 * (CREATE_ID_REFUSED_PENDING_GM). What the Studio really offers: Retry, since
 * after this refusal the next create goes without the id.
 */
export const CREATE_ID_REFUSED_LINE = 'Nebula couldn’t save the board because the server refused its save id. Retry saves it without one.';
/** True while CREATE_ID_REFUSED_LINE waits on GM. */
export const CREATE_ID_REFUSED_PENDING_GM = true;

/** A create refused for its `requestId`: the backend's 422 naming the field,
 *  or its 409 for an id another project's board was made with (round 6g,
 *  `code: "request_id_scope"`). Sent again, the same id fails the same way. */
export function isCreateIdRefusal(error: unknown): boolean {
  if (!(error instanceof RequestFailedError)) return false;
  if (error.status === 409) return error.code === 'request_id_scope';
  if (error.status !== 422) return false;
  return /\brequestId\b/.test(typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail ?? ''));
}

/**
 * Whether `failure` is boardNotSavedLine's line (GM r12 1): nothing is lost
 * (the send waits in the draft and in this tab's session storage), so it is
 * neutral, colour included, as PR #204's because lines are, and the header
 * chip reads "Not saved", not "Error". Its one retry is the header's Retry.
 */
export function isBoardNotSavedLine(failure: FailureCopy | string | null | undefined): boolean {
  return typeof failure === 'object' && failure !== null && !failure.heading && failure.reason.startsWith(NOT_SAVED_OPENING)
    && failure.reason.endsWith('. Try again.');
}

/** The clause after "because" for a board's send that failed. */
export function boardSaveCause(error: unknown): string {
  if (isNoAnswer(error)) return 'the server isn’t answering';
  if (error instanceof MoodboardVersionConflict) return 'the board changed in another window';
  if (!(error instanceof RequestFailedError)) return 'the server didn’t accept it';
  if (isBackendUnreachable(error)) return 'the server isn’t answering';
  const { status } = error;
  if (status === 429) return 'the server is busy';
  if (status === 408 || status === 502 || status === 503 || status === 504) return 'the server didn’t respond';
  if (status >= 500) return 'the server hit an error';
  if (status === 401 || status === 403) return 'you don’t have access to this anymore';
  return 'the server didn’t accept it';
}

/** How a kept board field is named in the line (round 6g). Only the name's
 *  line is GM's ("Kept the name “Rivers” from the board."); the others are
 *  proposed, waiting on GM (KEPT_FIELD_PENDING_GM). */
const KEPT_FIELD_NAMES: Partial<Record<string, string>> = {
  notes: 'the notes', mode: 'the mode', strength: 'the strength', direction: 'what the board is for',
  avoid: 'what to avoid', pinnedColors: 'the colours', briefOverride: 'the brief', clashMode: 'the clash setting',
  colorChoices: 'the colour choices', sendNotes: 'the notes setting',
};
/** True while the wording for fields other than the name waits on GM. */
export const KEPT_FIELD_PENDING_GM = true;

/**
 * The neutral line when a repeated create's board kept its own later change
 * over a draft edit (round 6g, GM r15 1), or null when nothing was dropped:
 * "Kept the name “Rivers” from the board.", and for other fields "Kept the
 * notes from the board.", joined ("Kept the name “Rivers” and the notes from
 * the board.").
 */
export function keptFromBoardLine(fields: readonly string[], board: { name?: string }): string | null {
  if (!fields.length) return null;
  const parts = fields.map((field) => (field === 'name' ? `the name “${(board.name ?? '').trim()}”` : KEPT_FIELD_NAMES[field] ?? `the ${field}`));
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Kept ${joined} from the board.`;
}
