import { RequestFailedError, isBackendUnreachable, isNoAnswer, type FailureCopy } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';

/**
 * A board's save that failed with nothing lost (GM r12 1, r14, r16 7a): the
 * edit stays in the draft, so the line is neutral, the header chip reads
 * "Not saved", and it says why in the because form, ending with the step
 * that works. That covers the Studio's own save of a saved board, a new
 * board's create (New's save, its Retry, the autosave's, the save of an
 * unsaved board an add landed on) and the paste flow's background writes
 * (the queued send of a board New just saved, an add that couldn't reach a
 * board the person had left). It never says "create": after a lost answer
 * the server may have made the board.
 *
 * Each line is chosen from the answer's status and structured fields (its
 * `code`, `storage: "full"`), never from its words: no line carries the
 * server's own detail or reason (GM r16: backend wording never reaches the
 * person; boardSaveLine.test.ts holds the ratchet).
 */
export interface BoardSaveLine {
  failure: FailureCopy;
  /** What the header offers: 'save' is its Retry (the line ends "Try
   *  again", or names a step after which trying again works); 'reload' is
   *  no button, the line's own step is a reload (signed out, or the board
   *  changed somewhere else: sending the same edit again fails the same way). */
  retry: 'save' | 'reload';
}

const NOT_SAVED_OPENING = 'Nebula couldn’t save the board because ';

/** GM r16's lines, each its cause and the step that works. */
const SAVE_LINES = {
  noAnswer: { cause: 'the server isn’t answering', step: 'Try again.', retry: 'save' },
  busy: { cause: 'the server is busy', step: 'Try again.', retry: 'save' },
  noResponse: { cause: 'the server didn’t respond', step: 'Try again.', retry: 'save' },
  serverError: { cause: 'the server hit an error', step: 'Try again.', retry: 'save' },
  diskFull: { cause: 'the disk is full', step: 'Free up some space, then try again.', retry: 'save' },
  tooLarge: { cause: 'it’s too large', step: 'Remove some images, then try again.', retry: 'save' },
  signedOut: { cause: 'you’re signed out', step: 'Reload to sign in again.', retry: 'reload' },
  changed: { cause: 'it changed somewhere else', step: 'Reload to get the latest version.', retry: 'reload' },
  // GM r16 7(b): any other refusal, the create id's included.
  refused: { cause: 'the server didn’t accept this save', step: 'Try again.', retry: 'save' },
} as const satisfies Record<string, { cause: string; step: string; retry: BoardSaveLine['retry'] }>;

type SaveLineKind = keyof typeof SAVE_LINES;

/** Which of GM's lines a failed board save gets, from its status and fields. */
function saveLineKind(error: unknown): SaveLineKind {
  if (isNoAnswer(error)) return 'noAnswer';
  if (error instanceof MoodboardVersionConflict) return 'changed';
  if (!(error instanceof RequestFailedError)) return 'refused';
  if (isBackendUnreachable(error)) return 'noAnswer';
  const { status } = error;
  if (status === 409 && error.code === 'version_conflict') return 'changed';
  if (status === 401 || status === 403) return 'signedOut';
  if (status === 413) return 'tooLarge';
  if (error.storageFull) return 'diskFull';
  if (status === 429) return 'busy';
  if (status === 408 || status === 502 || status === 503 || status === 504) return 'noResponse';
  if (status >= 500) return 'serverError';
  return 'refused';
}

/** The line and the header's offer for a board save that failed. */
export function boardSaveLine(error: unknown): BoardSaveLine {
  const line = SAVE_LINES[saveLineKind(error)];
  return { failure: { heading: '', reason: `${NOT_SAVED_OPENING}${line.cause}. ${line.step}` }, retry: line.retry };
}

/** The line alone (boardSaveLine's failure). */
export function boardSaveFailure(error: unknown): FailureCopy {
  return boardSaveLine(error).failure;
}

/** The clause after "because" for a board's save that failed. */
export function boardSaveCause(error: unknown): string {
  return SAVE_LINES[saveLineKind(error)].cause;
}

/** A create refused for its `requestId`: the backend's 422 naming the field,
 *  or its 409 for an id another project's board was made with (round 6g,
 *  `code: "request_id_scope"`). Sent again, the same id fails the same way,
 *  so the Studio drops the id and its Retry creates without one; the line
 *  is 7(b)'s, like any other refusal. */
export function isCreateIdRefusal(error: unknown): boolean {
  if (!(error instanceof RequestFailedError)) return false;
  if (error.status === 409) return error.code === 'request_id_scope';
  if (error.status !== 422) return false;
  return /\brequestId\b/.test(typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail ?? ''));
}

/**
 * Whether `failure` is a board save line (GM r12 1, r16 7a): nothing is lost
 * (the edit waits in the draft, and an unsaved board in this tab's session
 * storage), so it is neutral, colour included, as PR #204's because lines
 * are, and the header chip reads "Not saved", not "Error".
 */
export function isBoardNotSavedLine(failure: FailureCopy | string | null | undefined): boolean {
  return typeof failure === 'object' && failure !== null && !failure.heading && failure.reason.startsWith(NOT_SAVED_OPENING);
}

/** `parts` joined with "and" and no serial comma (GM r16): "a", "a and b", "a, b and c". */
export function joinWithAnd(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The most items a line names before it counts them instead (GM r16). */
const MOST_NAMED = 3;

/**
 * The red line for an add that is truly lost (GM r16 7a): it reached a
 * saved board whose draft wasn't loaded and its write failed, so nothing
 * holds it and there's no Retry. Names up to three files ("“a.png” and
 * “b.png”"), then a count. The step is "Add it again." for one file and
 * "Add them again." for more (the count form included: "Nebula couldn’t add
 * 4 images … Add them again.").
 */
export function lostAddLine(names: readonly string[]): FailureCopy {
  const what = names.length === 0 ? 'the image'
    : names.length <= MOST_NAMED ? joinWithAnd(names.map((name) => `“${name}”`)) : `${names.length} images`;
  return { heading: '', reason: `${LOST_ADD_OPENING}${what} because the board hadn’t loaded. ${names.length > 1 ? 'Add them again.' : 'Add it again.'}` };
}

const LOST_ADD_OPENING = 'Nebula couldn’t add ';

/** Whether `failure` is lostAddLine's red line: it stays through the board's
 *  load, which is when the person first sees it (round 6h, live). */
export function isLostAddLine(failure: FailureCopy | string | null | undefined): failure is FailureCopy {
  return typeof failure === 'object' && failure !== null && !failure.heading && failure.reason.startsWith(LOST_ADD_OPENING);
}

/** How a kept board field is named in the "Kept …" line, after its one "the" (GM r16). */
const KEPT_FIELD_NAMES: Partial<Record<string, string>> = {
  name: 'name', notes: 'notes', mode: 'mode', strength: 'strength', direction: 'direction', avoid: 'avoid list',
  pinnedColors: 'pinned colors', briefOverride: 'brief', clashMode: 'clash setting', colorChoices: 'color choices',
  sendNotes: 'notes setting', analysis: 'analysis',
};

/**
 * The neutral line when a repeated create's board kept its own later change
 * over a draft edit (round 6g, GM r15 1, r16), or null when nothing was
 * dropped: "Kept the name from the board.", "Kept the name and notes from
 * the board.", "Kept the name, notes and mode from the board.", and from
 * four fields a count: "Kept 4 changes from the board."
 */
export function keptFromBoardLine(fields: readonly string[]): string | null {
  if (!fields.length) return null;
  if (fields.length > MOST_NAMED) return `Kept ${fields.length} changes from the board.`;
  return `Kept the ${joinWithAnd(fields.map((field) => KEPT_FIELD_NAMES[field] ?? field))} from the board.`;
}
